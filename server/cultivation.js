// 修炼玩法服务（2026-11-04 修炼扩容）：闭关打坐 / 道童历练。
// 两类「墙钟定时 + 到点结算」玩法全服务端复算：起止状态真值落 save_ledger JSON 列
// （seclusion_json / dispatch_json，db.js LEDGER_COLUMNS），客户端 state 只持展示镜像；
// 结算发放走账本主列 + action_log 授权流水（sanctionedSince 计入增速包络），未吸收窗口
// 由 saves.js store 的 srv 差额豁免兜住（/api/combat/offline 同口径，防「服务端已入账、
// 客户端未应用」的推送被误拒）。
//
// 客户端镜像的提前出关/重复领取打不穿这里：finish 校验 elapsed ≥ dur、状态列一次性
// 读清；start 校验「无进行中会话」+ 境界水位 + 灵石原子扣款（香火）。
import { sendJSON, SlidingWindow } from './http-util.js';
import { ledgerOf } from './economy.js';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function loadMirror(text) {
  try {
    const d = JSON.parse(text || '{}');
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch (e) {
    return {};
  }
}

function jsonOf(text) {
  try {
    const d = JSON.parse(text || '');
    return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
  } catch (e) {
    return null;
  }
}

const dayStr = (now = Date.now()) => {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* ---------------- 闭关打坐（客户端 SECL_DURS / SECL_INCENSE 同源，改一处必改两处） ---------------- */

// 时长档与解锁境界水位（gateRealm 口径：max(realm, realmPeak)）
const SECL_DUR_MS = [30 * 60000, 2 * 3600000, 8 * 3600000];
const SECL_DUR_REALM = [0, 2, 4];
// 香火档：投入灵石抬修为（+40%/档），开炉时原子扣款
const SECL_INCENSE_COST = [0, 20000, 200000, 2000000];
const SECL_INCENSE_MULT = [1, 1.4, 1.8, 2.2];
// 结算效率 50%（离线 OFFLINE_EFF 同口径）：修炼页背景玩法不压主动开箱的主循环
const SECL_EFF = 0.5;
// 顿悟 / 走火入魔（满程完成时服务端掷，二者互斥；走火入魔客户端见响应后现形心魔）
const SECL_INSIGHT_CHANCE = 0.15;
const SECL_DEMON_CHANCE = 0.10;
const SECL_INSIGHT_DAOYUN = 25; // 顿悟额外凝道韵（客户端 daoyun 白名单口径内）

/* ---------------- 道童历练（客户端 DISPATCH_DESTS / DISPATCH_HOURS 同源，改一处必改两处） ---------------- */

// 目的地：渡劫解锁；沧溟需仙人水位；星河渡口需道童资质三阶（资质存客户端档，钳 0..3）
const DISPATCH_DESTS = {
  heishi: { realm: 8, mult: 1.0, lore: 2 },
  fuling: { realm: 8, mult: 1.1, lore: 3 },
  cangming: { realm: 9, mult: 1.3, lore: 4 },
  xinghe: { realm: 9, apt: 3, mult: 1.6, lore: 5 },
};
// 时长档（小时），8 小时需资质 ≥2
const DISPATCH_HOURS = [1, 4, 8];
const DISPATCH_APT_HOUR = 2;
// 资质每阶奖励 +15%（客户端道童资质效果同源）
const DISPATCH_APT_MULT = 0.15;
// 赏格（bounty 同形：随账本装备分走，设绝对上界）：每小时 = 8000 + power/160，×目的地×资质
const DISPATCH_STONES_CAP = 2.5e6;
const DISPATCH_DUST_CAP = 400;

export function createCultivationService(db) {
  const writeWindow = new SlidingWindow(60 * 1000, 30); // 起止动作 30 次/分，客户端 5 秒巡检余量充足

  const stmts = {
    getSave: db.prepare('SELECT data FROM game_saves WHERE user_id = ?'),
    getLedger: db.prepare('SELECT * FROM save_ledger WHERE user_id = ?'),
    // 无账本行首动作：按 saves.js 首推同口径从镜像种基线（combat.js ensureLedger 同款）
    seedLedger: db.prepare(
      `INSERT INTO save_ledger (user_id, stones, total_stones, dust_total, opens, exp, pet_tickets,
         ascensions, immortal, power, tower_cleared, stage_cleared, endless_best, wild_max, grants,
         clicks, click_ban_until, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?)`),
    addStonesDust: db.prepare(
      'UPDATE save_ledger SET stones = stones + ?, total_stones = total_stones + ?, dust_total = dust_total + ? WHERE user_id = ?'),
    addExp: db.prepare('UPDATE save_ledger SET exp = exp + ? WHERE user_id = ?'),
    spendStones: db.prepare(
      'UPDATE save_ledger SET stones = stones - ?, srv_spent_stones = srv_spent_stones + ? WHERE user_id = ? AND stones >= ?'),
    logAction: db.prepare(
      'INSERT INTO action_log (user_id, day, kind, stones, dust, tickets, exp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    setSeclusion: db.prepare('UPDATE save_ledger SET seclusion_json = ? WHERE user_id = ?'),
    setDispatch: db.prepare('UPDATE save_ledger SET dispatch_json = ? WHERE user_id = ?'),
  };

  // 须在事务内调用（combat.js ensureLedger 同款）
  function ensureLedger(userId, mirror, now) {
    let led = stmts.getLedger.get(userId);
    if (!led) {
      const seed = ledgerOf(mirror, now);
      stmts.seedLedger.run(userId, seed.stones, seed.totalStones, seed.dustTotal,
        seed.opens, seed.exp, seed.petTickets, seed.ascensions, seed.immortal, seed.power,
        seed.towerCleared, seed.stageCleared, seed.endlessBest, seed.wildMax, now);
      led = stmts.getLedger.get(userId);
    }
    return led;
  }

  // 境界水位（客户端 gateRealm 同口径：当前境界与历史水位取高，飞升不回锁）
  const gateRealmOf = (mirror) =>
    Math.max(Math.floor(num(mirror.realm)), Math.floor(num(mirror.realmPeak)));

  const aptOf = (mirror) => {
    const st = mirror.steward;
    return st && !Array.isArray(st) ? Math.max(0, Math.min(3, Math.floor(num(st.apt)))) : 0;
  };

  /* ---------------- 闭关打坐 ---------------- */

  function seclStart(req, res, ctx) {
    if (!writeWindow.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '操作太频繁' });
    }
    const body = ctx.body || {};
    const dur = Math.floor(num(body.dur));
    const incense = Math.floor(num(body.incense));
    if (!(dur >= 0 && dur < SECL_DUR_MS.length)) return sendJSON(res, 400, { error: '未知闭关时长' });
    if (!(incense >= 0 && incense < SECL_INCENSE_COST.length)) return sendJSON(res, 400, { error: '未知香火档' });
    const now = Date.now();
    const saveRow = stmts.getSave.get(ctx.user.id);
    if (!saveRow) return sendJSON(res, 400, { error: '尚未创建云端存档' });
    const mirror = loadMirror(saveRow.data);
    const gate = gateRealmOf(mirror);
    if (gate < 1) return sendJSON(res, 400, { error: '闭关需境界「筑基」' });
    if (gate < SECL_DUR_REALM[dur]) return sendJSON(res, 400, { error: '该闭关时长尚未解锁' });
    const cost = SECL_INCENSE_COST[incense];
    db.exec('BEGIN');
    try {
      const led = ensureLedger(ctx.user.id, mirror, now);
      if (jsonOf(led.seclusion_json)) {
        db.exec('ROLLBACK');
        return sendJSON(res, 429, { error: '已在闭关中，出关后再来' });
      }
      if (cost > 0) {
        const spent = stmts.spendStones.run(cost, cost, ctx.user.id, cost);
        if (spent.changes === 0) {
          db.exec('ROLLBACK');
          return sendJSON(res, 400, { error: '灵石不足，上不起这炷香' });
        }
      }
      stmts.setSeclusion.run(JSON.stringify({ start: now, dur, incense }), ctx.user.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return sendJSON(res, 200, { ok: true, until: now + SECL_DUR_MS[dur], cost });
  }

  function seclCancel(req, res, ctx) {
    if (!writeWindow.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '操作太频繁' });
    }
    const now = Date.now();
    const saveRow = stmts.getSave.get(ctx.user.id);
    if (!saveRow) return sendJSON(res, 200, { ok: true }); // 无档无可清，幂等成功
    db.exec('BEGIN');
    try {
      const led = ensureLedger(ctx.user.id, loadMirror(saveRow.data), now);
      stmts.setSeclusion.run('', ctx.user.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return sendJSON(res, 200, { ok: true });
  }

  function seclFinish(req, res, ctx) {
    if (!writeWindow.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '操作太频繁' });
    }
    const now = Date.now();
    const saveRow = stmts.getSave.get(ctx.user.id);
    if (!saveRow) return sendJSON(res, 400, { error: '尚未创建云端存档' });
    const mirror = loadMirror(saveRow.data);
    let secl = null;
    let led = null;
    db.exec('BEGIN');
    try {
      led = ensureLedger(ctx.user.id, mirror, now);
      secl = jsonOf(led.seclusion_json);
      if (!secl) {
        db.exec('ROLLBACK');
        return sendJSON(res, 400, { error: '当前没有进行中的闭关' });
      }
      const total = SECL_DUR_MS[Math.max(0, Math.min(SECL_DUR_MS.length - 1, Math.floor(num(secl.dur))))];
      if (now < Math.floor(num(secl.start)) + total) {
        db.exec('ROLLBACK');
        // 回带服务端 until 真值：客户端钟差/脏 start 时按此重排本地闹钟（防 400 空转循环）
        return sendJSON(res, 400, { error: '闭关尚未结束',
          until: Math.floor(num(secl.start)) + total });
      }
      // 修为复算：秒数 × 效率 × 境界/轮回/藏经阁/功法·hui/香火（客户端 expMult 同源链）
      const expMult = (1 + 0.10 * num(mirror.cave && mirror.cave.library)) *
        (1 + 0.05 * num(mirror.gongfa && mirror.gongfa.hui));
      const incense = Math.max(0, Math.min(SECL_INCENSE_MULT.length - 1, Math.floor(num(secl.incense))));
      let exp = Math.floor(SECL_EFF * (total / 1000) *
        (1 + 0.8 * num(mirror.realm)) * (1 + 0.5 * num(mirror.ascensions)) *
        expMult * SECL_INCENSE_MULT[incense]);
      exp = Math.max(1, exp);
      // 顿悟 / 走火入魔：单掷互斥（<0.15 顿悟，<0.25 走火入魔）
      const roll = Math.random();
      const insight = roll < SECL_INSIGHT_CHANCE;
      const demon = !insight && roll < SECL_INSIGHT_CHANCE + SECL_DEMON_CHANCE;
      if (insight) {
        exp *= 2;
        // 道韵不混入 exp 主列（2026-11-09 复审）：+25 道韵此前一并加进 exp，账本比授权
        // 流水多 25/次（对账误判面）；道韵只经响应 daoyun 字段下发客户端入自己的档
        stmts.addExp.run(exp, ctx.user.id);
        stmts.logAction.run(ctx.user.id, dayStr(now), 'seclusion', 0, 0, 0, exp, now);
      } else {
        stmts.addExp.run(exp, ctx.user.id);
        stmts.logAction.run(ctx.user.id, dayStr(now), 'seclusion', 0, 0, 0, exp, now);
      }
      stmts.setSeclusion.run('', ctx.user.id);
      db.exec('COMMIT');
      return sendJSON(res, 200, {
        ok: true, exp,
        insight, demon,
        daoyun: insight ? SECL_INSIGHT_DAOYUN : 0,
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /* ---------------- 道童历练 ---------------- */

  function dispatchStart(req, res, ctx) {
    if (!writeWindow.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '操作太频繁' });
    }
    const body = ctx.body || {};
    const destId = typeof body.dest === 'string' ? body.dest : '';
    const hIdx = Math.floor(num(body.h));
    const dest = DISPATCH_DESTS[destId];
    if (!dest) return sendJSON(res, 400, { error: '未知历练目的地' });
    if (!(hIdx >= 0 && hIdx < DISPATCH_HOURS.length)) return sendJSON(res, 400, { error: '未知历练时长' });
    const now = Date.now();
    const saveRow = stmts.getSave.get(ctx.user.id);
    if (!saveRow) return sendJSON(res, 400, { error: '尚未创建云端存档' });
    const mirror = loadMirror(saveRow.data);
    const gate = gateRealmOf(mirror);
    const apt = aptOf(mirror);
    if (gate < dest.realm) return sendJSON(res, 400, { error: '该目的地尚未解锁' });
    if (dest.apt && apt < dest.apt) return sendJSON(res, 400, { error: '道童资质不足' });
    if (hIdx === DISPATCH_HOURS.length - 1 && apt < DISPATCH_APT_HOUR) {
      return sendJSON(res, 400, { error: '八小时历练需资质二阶' });
    }
    db.exec('BEGIN');
    try {
      const led = ensureLedger(ctx.user.id, mirror, now);
      if (jsonOf(led.dispatch_json)) {
        db.exec('ROLLBACK');
        return sendJSON(res, 429, { error: '道童正在历练中' });
      }
      stmts.setDispatch.run(JSON.stringify({ dest: destId, start: now, h: DISPATCH_HOURS[hIdx] }), ctx.user.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return sendJSON(res, 200, { ok: true, until: now + DISPATCH_HOURS[hIdx] * 3600000 });
  }

  // 素材掷骰：种子/洗炼石/鱼饵随响应下发客户端入库（farmSeeds/rerollStones/fishing.bait
  // 均在 validateDeep 白名单内），不入账本、不碰增速包络（combat.js rollMatDrops 同口径）
  function rollDispatchDrops(destId, hours) {
    const out = { seeds: {}, rstones: {}, bait: 0 };
    const seedKeys = ['cao', 'hua', 'guo', 'sui', 'lian', 'tong', 'xing'];
    const rKeys = ['atk', 'hp', 'def', 'crit', 'ls', 'pierce'];
    if (Math.random() < 0.55 * hours) {
      out.seeds[seedKeys[Math.floor(Math.random() * seedKeys.length)]] = 1 + (Math.random() < 0.4 ? 1 : 0);
    }
    if (Math.random() < 0.45 * hours) {
      out.rstones[rKeys[Math.floor(Math.random() * rKeys.length)]] = 1;
    }
    if ((destId === 'cangming' || destId === 'xinghe') && Math.random() < 0.35 * hours) {
      out.bait = 1 + (Math.random() < 0.4 ? 1 : 0);
    }
    return out;
  }

  function dispatchFinish(req, res, ctx) {
    if (!writeWindow.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '操作太频繁' });
    }
    const now = Date.now();
    const saveRow = stmts.getSave.get(ctx.user.id);
    if (!saveRow) return sendJSON(res, 400, { error: '尚未创建云端存档' });
    const mirror = loadMirror(saveRow.data);
    db.exec('BEGIN');
    try {
      const led = ensureLedger(ctx.user.id, mirror, now);
      const dsp = jsonOf(led.dispatch_json);
      if (!dsp) {
        db.exec('ROLLBACK');
        return sendJSON(res, 400, { error: '道童没有进行中的历练' });
      }
      const dest = DISPATCH_DESTS[dsp.dest];
      if (!dest) {
        // 未知目的地（版本错配）：清态自愈，不发奖
        stmts.setDispatch.run('', ctx.user.id);
        db.exec('COMMIT');
        return sendJSON(res, 400, { error: '历练记录异常，已重置' });
      }
      const hours = Math.max(1, Math.min(DISPATCH_HOURS[DISPATCH_HOURS.length - 1], Math.floor(num(dsp.h))));
      if (now < Math.floor(num(dsp.start)) + hours * 3600000) {
        db.exec('ROLLBACK');
        // 回带服务端 until 真值（同闭关出关口径）
        return sendJSON(res, 400, { error: '历练尚未结束',
          until: Math.floor(num(dsp.start)) + hours * 3600000 });
      }
      const apt = aptOf(mirror);
      const aptMult = 1 + DISPATCH_APT_MULT * apt;
      const power = Math.max(0, Math.floor(num(led.power)));
      const stones = Math.min(DISPATCH_STONES_CAP,
        Math.floor((8000 + power / 160) * dest.mult * aptMult * hours));
      const dust = Math.min(DISPATCH_DUST_CAP,
        Math.floor((4 + power / 3e6) * dest.mult * aptMult * hours));
      const lore = dest.lore + hours; // 见闻：目的地基础 + 时长加成
      const drops = rollDispatchDrops(dsp.dest, hours);
      stmts.addStonesDust.run(stones, stones, dust, ctx.user.id);
      stmts.logAction.run(ctx.user.id, dayStr(now), 'dispatch', stones, dust, 0, 0, now);
      stmts.setDispatch.run('', ctx.user.id);
      db.exec('COMMIT');
      return sendJSON(res, 200, { ok: true, stones, dust, lore, drops });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /* ---------------- 分发 ---------------- */

  const ROUTES = {
    'secl/start': { m: 'POST', fn: seclStart },
    'secl/cancel': { m: 'POST', fn: seclCancel },
    'secl/finish': { m: 'POST', fn: seclFinish },
    'dispatch/start': { m: 'POST', fn: dispatchStart },
    'dispatch/finish': { m: 'POST', fn: dispatchFinish },
  };

  function handle(req, res, { method, pathname, user, body }) {
    const sub = pathname.replace(/^\/api\/cult\//, '');
    const route = ROUTES[sub];
    if (!route || route.m !== method) return false;
    route.fn(req, res, { user, body });
    return true;
  }

  return { handle };
}
