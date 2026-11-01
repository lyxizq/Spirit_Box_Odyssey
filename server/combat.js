// 征战战斗服务（2026-11-01 全量服务端校验迁移 P1）：闯关/爬塔/野外/无尽的
// 战斗结算整体上收服务端——客户端只上报「想打哪场」，胜负、奖励、进度推进、
// 掉落全部由服务端裁定并落账本，客户端拿到战报只做渲染。
//
// 事务边界：单次 fight = 体力折算扣点 + 扫荡/野外语额校验扣费 + 战斗复算 +
// 奖励入账（save_ledger + action_log 授权日志）+ 进度推进，一个 BEGIN…COMMIT。
// 玩家面板从「存档镜像」（game_saves.data）计算——镜像由客户端持续推送，
// 作弊面被 validateDeep + 增速包络兜住；战斗结果本身客户端完全无法伪造。
import { sendJSON, SlidingWindow } from './http-util.js';
import { computeStamina, staminaView, STAMINA_CAP } from './stamina.js';
import { ledgerOf } from './economy.js';
import {
  simulateBattle, MODES, contentReq, enemyFor, recommendedPower,
  playerCombatStats, elementBonusOf, settleGain, expectedOf, dayProdMultOf,
  applyStoneBuffsOf,
  MILESTONES, WILD_MAX, ENDLESS_GATE, TROPHY_FIELDS, MODE_EXP_MULT,
  WILD_SET_PITY, WILD_SET_RATE, MODE_SET_RATE, TREASURE_DROP,
  SWEEP_DAILY_FREE, SWEEP_BUY_MAX, SWEEP_BUY_COST, WILD_REPEAT_DAILY,
} from './battle.js';
import { SLOTS, makeSpecialItem } from './items.js';

const FIGHT_PER_MIN = 90; // 自动战斗 1 场/分钟 + 手动连点，90/分钟留足余量
const OFFLINE_CAP_S = 4 * 3600;
const OFFLINE_EFF = 0.5;
const HUNT_INTERVAL_S = 60;      // 与客户端 HUNT_INTERVAL_S 同源（每场间隔 1 分钟）
const OFFLINE_HUNT_PITY = 100;   // 离线巡猎保底（弱于在线 50，game.js OFFLINE_HUNT_PITY 同源）

const dayStr = (now = Date.now()) => {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const isWeekend = () => [0, 6].includes(new Date().getDay());
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function loadMirror(text) {
  try {
    const d = JSON.parse(text || '{}');
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch (e) {
    return {};
  }
}

// 每模式计数 JSON 列（sweep_used / sweep_bought）：{"stage":n,"tower":n,"wild":n}
function modeMapOf(json) {
  let obj = {};
  try { obj = JSON.parse(json || '{}'); } catch (e) { obj = {}; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
  return obj;
}

export function createCombatService(db, staminaSvc) {
  const window = new SlidingWindow(60 * 1000, FIGHT_PER_MIN);
  const stmts = {
    getSave: db.prepare('SELECT data FROM game_saves WHERE user_id = ?'),
    getLedger: db.prepare('SELECT * FROM save_ledger WHERE user_id = ?'),
    // 无账本行首战：按 saves.js 首推同口径从镜像种基线（grants=1，校验链无缝衔接）
    seedLedger: db.prepare(
      `INSERT INTO save_ledger (user_id, stones, total_stones, dust_total, opens, exp, pet_tickets,
         ascensions, immortal, power, tower_cleared, stage_cleared, endless_best, wild_max, grants,
         clicks, click_ban_until, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?)`),
    addStonesExp: db.prepare(
      'UPDATE save_ledger SET stones = stones + ?, total_stones = total_stones + ?, exp = exp + ? WHERE user_id = ?'),
    addOpens: db.prepare('UPDATE save_ledger SET opens = opens + ? WHERE user_id = ?'),
    setProgress: db.prepare(
      'UPDATE save_ledger SET tower_cleared = ?, stage_cleared = ?, endless_best = ?, wild_max = ? WHERE user_id = ?'),
    setWildJson: db.prepare(
      'UPDATE save_ledger SET wild_cleared = ?, wild_kills = ? WHERE user_id = ?'),
    setCounters: db.prepare(
      `UPDATE save_ledger SET wild_repeat_day = ?, wild_repeat_used = ?,
         sweep_day = ?, sweep_used = ?, sweep_bought = ? WHERE user_id = ?`),
    setOfflineAt: db.prepare('UPDATE save_ledger SET offline_at = ? WHERE user_id = ?'),
    spendStones: db.prepare('UPDATE save_ledger SET stones = stones - ? WHERE user_id = ? AND stones >= ?'),
    logAction: db.prepare(
      'INSERT INTO action_log (user_id, day, kind, stones, dust, tickets, exp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    guildLevel: db.prepare(
      'SELECT g.level FROM guild_members gm JOIN guilds g ON g.id = gm.guild_id WHERE gm.user_id = ?'),
  };

  // —— 体力（事务内复用 staminaSvc 的语句与折算，口径不分叉）——

  function staminaState(userId, now) {
    const row = staminaSvc.core.rowById(userId);
    return row ? { row, cur: computeStamina(row, now) } : null;
  }

  // 扣 1 点（含满池计时重置规则，与 stamina.js spend 同口径）；须在事务内调用
  function deductOne(userId, now) {
    const st = staminaState(userId, now);
    if (!st) return { ok: false };
    const { cur } = st;
    if (cur.changed) staminaSvc.core.persist(userId, cur);
    if (cur.v < 1) return { ok: false, cur };
    const tsAfter = cur.v >= STAMINA_CAP ? now : cur.ts;
    staminaSvc.core.spendStmt.run(1, tsAfter, cur.day, userId, 1);
    const after = cur.v - 1;
    return {
      ok: true,
      view: { stamina: after, cap: STAMINA_CAP, nextAt: after >= STAMINA_CAP ? 0 : tsAfter + staminaSvc.core.regenMs },
    };
  }

  // 扣 n 点（离线巡猎批量）
  function deductN(userId, n, now) {
    const st = staminaState(userId, now);
    if (!st) return { ok: false };
    const { cur } = st;
    if (cur.changed) staminaSvc.core.persist(userId, cur);
    const take = Math.max(0, Math.min(n, cur.v));
    if (take <= 0) return { ok: true, spent: 0, view: staminaView(cur) };
    const tsAfter = cur.v >= STAMINA_CAP ? now : cur.ts;
    staminaSvc.core.spendStmt.run(take, tsAfter, cur.day, userId, take);
    const after = cur.v - take;
    return {
      ok: true, spent: take,
      view: { stamina: after, cap: STAMINA_CAP, nextAt: after >= STAMINA_CAP ? 0 : tsAfter + staminaSvc.core.regenMs },
    };
  }

  function envFor(userId, now) {
    const g = stmts.guildLevel.get(userId);
    return { now, guildLevel: g ? g.level : 0 };
  }

  function wildMaxOf(cleared) {
    let m = 0;
    for (const z of cleared) {
      const n = Math.floor(num(z));
      if (n > m) m = Math.min(n, WILD_MAX);
    }
    return m;
  }
  function wildMaxUnlocked(cleared) {
    let max = 1;
    for (const z of cleared) {
      const zi = Math.floor(num(z));
      if (zi + 1 > max) max = zi + 1;
    }
    return Math.min(WILD_MAX, max);
  }
  const featureRealmOf = (mirror) => Math.max(Math.floor(num(mirror.realm)), Math.floor(num(mirror.realmPeak)));

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

  // 野外进度自举（2026-11-01 P1 迁移缺口修复）：账本 wild_cleared/wild_kills 新列
  // 对存量账号是空默认，首次触碰时从已校验的存档镜像导入（validateDeep 已钳 0..200），
  // 否则老玩家首战野外会被「该区域尚未解锁」卡死。须在事务内调用。
  function bootstrapWild(led, mirror) {
    let cleared = [];
    try { cleared = JSON.parse(led.wild_cleared || '[]'); } catch (e) { cleared = []; }
    if (Array.isArray(cleared) && cleared.length) return null;
    const src = Array.isArray(mirror.wildCleared) ? mirror.wildCleared : [];
    const list = [...new Set(src.map((z) => Math.floor(num(z))).filter((z) => z >= 1 && z <= WILD_MAX))];
    if (!list.length) return null;
    const kills = modeMapOf(led.wild_kills);
    const mk = (mirror.wildKills && typeof mirror.wildKills === 'object' && !Array.isArray(mirror.wildKills))
      ? mirror.wildKills : {};
    for (const k of Object.keys(mk)) {
      const zi = Math.floor(num(k));
      if (zi >= 1 && zi <= WILD_MAX) kills[String(zi)] = Math.floor(num(mk[k]));
    }
    stmts.setWildJson.run(JSON.stringify(list), JSON.stringify(kills), led.user_id);
    stmts.setProgress.run(
      Math.floor(num(led.tower_cleared)), Math.floor(num(led.stage_cleared)),
      Math.floor(num(led.endless_best)), wildMaxOf(list), led.user_id);
    return { cleared: list, kills };
  }

  // 套装件掉落 roll（game.js doBattle 掉落段同源）。id=0 由客户端收货时重编
  function rollSpecialDrop({ mode, level, first, sweep, replay, killsNow }) {
    const itemSeq = () => 0;
    let slotKey = null;
    const milestoneSlot = MILESTONES[mode] ? MILESTONES[mode][level] : null;
    if (first && milestoneSlot) slotKey = milestoneSlot;
    else if (mode === 'wild') {
      if (first && level === WILD_MAX) slotKey = SLOTS[Math.floor(Math.random() * SLOTS.length)].key;
      else if (killsNow % WILD_SET_PITY === 0 || Math.random() < WILD_SET_RATE) {
        slotKey = SLOTS[Math.floor(Math.random() * SLOTS.length)].key;
      }
    } else if (mode === 'endless') {
      // 无尽掉「镇塔」套装件（客户端口径：grantSpecial('tower', level, ...)）
      if (Math.random() < MODE_SET_RATE) {
        return makeSpecialItem('tower', level, SLOTS[Math.floor(Math.random() * SLOTS.length)].key, itemSeq, contentReq);
      }
      return null;
    } else if (first && level === MODES[mode].max) {
      slotKey = SLOTS[Math.floor(Math.random() * SLOTS.length)].key;
    } else if ((replay || sweep) && Math.random() < MODE_SET_RATE) {
      slotKey = SLOTS[Math.floor(Math.random() * SLOTS.length)].key;
    }
    if (!slotKey) return null;
    return makeSpecialItem(mode, level, slotKey, itemSeq, contentReq);
  }

  // POST /api/combat/fight {mode, level?, sweepLevel?, buy?}
  function fight(req, res, ctx) {
    if (!window.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '操作过于频繁，请稍后再试' }, { 'Retry-After': '5' });
    }
    const mode = String((ctx.body && ctx.body.mode) || '');
    if (!MODES[mode]) return sendJSON(res, 400, { error: '玩法不存在' });
    const sweepLevel = ctx.body && ctx.body.sweepLevel != null
      ? Math.floor(Number(ctx.body.sweepLevel)) : null;
    if (sweepLevel !== null && (!Number.isFinite(sweepLevel) || sweepLevel < 1)) {
      return sendJSON(res, 400, { error: '扫荡目标非法' });
    }
    if (sweepLevel !== null && mode === 'endless') {
      return sendJSON(res, 400, { error: '无尽没有扫荡' });
    }
    const wantBuy = !!(ctx.body && ctx.body.buy);
    const now = Date.now();
    const today = dayStr(now);

    const saveRow = stmts.getSave.get(ctx.user.id);
    if (!saveRow) return sendJSON(res, 400, { error: '尚未创建云端存档' });
    const mirror = loadMirror(saveRow.data);

    db.exec('BEGIN');
    try {
      const led = ensureLedger(ctx.user.id, mirror, now);

      // —— 体力闸门（内嵌，替代客户端先调 /api/stamina/spend）——
      const spent = deductOne(ctx.user.id, now);
      if (!spent.ok) {
        const st = staminaState(ctx.user.id, now);
        db.exec('ROLLBACK');
        return sendJSON(res, 429, {
          error: '体力不足，每 5 分钟恢复 1 点（每日 300 点）',
          ...(st ? staminaView(st.cur) : {}),
        });
      }

      // —— 进度权威：以账本为准（野外新列首次触碰时从镜像自举）——
      const towerCleared = Math.floor(num(led.tower_cleared));
      const stageCleared = Math.floor(num(led.stage_cleared));
      const endlessBest = Math.floor(num(led.endless_best));
      const boot = bootstrapWild(led, mirror);
      let wildCleared = boot ? boot.cleared.slice() : [];
      if (!boot) {
        try { wildCleared = JSON.parse(led.wild_cleared || '[]'); } catch (e) { wildCleared = []; }
        if (!Array.isArray(wildCleared)) wildCleared = [];
      }
      wildCleared = wildCleared.map((z) => Math.floor(num(z))).filter((z) => z >= 1 && z <= WILD_MAX);
      let wildKills = boot ? Object.assign({}, boot.kills) : modeMapOf(led.wild_kills);

      // —— 解锁门槛（服务端复核；与客户端 unlockedMode 同口径）——
      const gates = {
        stage: true,
        tower: stageCleared >= 5,
        wild: stageCleared >= 3,
        endless: towerCleared >= ENDLESS_GATE,
      };
      if (!gates[mode]) {
        db.exec('ROLLBACK');
        return sendJSON(res, 403, { error: '该玩法尚未解锁' });
      }

      // —— 关卡语义（服务端裁定 level/first/replay）——
      const cfg = MODES[mode];
      let level;
      let replay = false;
      let first = false;
      let sweepMap = null;
      let sweepBoughtMap = null;
      let countersTouched = false;
      let wildRepeatDay = led.wild_repeat_day || '';
      let wildRepeatUsed = Math.floor(num(led.wild_repeat_used));
      let sweepUsedPost = sameDayJson(led.sweep_day, today, led.sweep_used) === '{}' ? 0
        : Math.floor(num(modeMapOf(led.sweep_used)[mode]));
      let sweepBoughtPost = sameDayJson(led.sweep_day, today, led.sweep_bought) === '{}' ? 0
        : Math.floor(num(modeMapOf(led.sweep_bought)[mode]));

      if (sweepLevel !== null) {
        level = sweepLevel;
        const clearedNow = mode === 'tower' ? towerCleared : stageCleared;
        const ok = mode === 'wild'
          ? wildCleared.includes(level)
          : level >= 1 && level <= clearedNow;
        if (!ok) { db.exec('ROLLBACK'); return sendJSON(res, 400, { error: '该关卡尚未通关，无法扫荡' }); }
        // 扫荡每日计数（跨日归零）：免费 10 次；超出需 buy，服务端原子扣 20 万/次
        const sameDay = led.sweep_day === today;
        const usedMap = sameDay ? modeMapOf(led.sweep_used) : {};
        const boughtMap = sameDay ? modeMapOf(led.sweep_bought) : {};
        const used = Math.max(0, Math.floor(num(usedMap[mode])));
        const bought = Math.max(0, Math.floor(num(boughtMap[mode])));
        if (used < SWEEP_DAILY_FREE) {
          usedMap[mode] = used + 1;
        } else {
          if (!wantBuy) {
            db.exec('ROLLBACK');
            return sendJSON(res, 402, { error: '今日免费扫荡已用完', needBuy: true, bought });
          }
          if (bought >= SWEEP_BUY_MAX) {
            db.exec('ROLLBACK');
            return sendJSON(res, 429, { error: '今日扫荡加购次数已用完' });
          }
          const out = stmts.spendStones.run(SWEEP_BUY_COST, ctx.user.id, SWEEP_BUY_COST);
          if (!out.changes) {
            db.exec('ROLLBACK');
            return sendJSON(res, 400, { error: '灵石不足（加购需 20万）' });
          }
          boughtMap[mode] = bought + 1;
          usedMap[mode] = used + 1;
        }
        sweepMap = usedMap;
        sweepBoughtMap = boughtMap;
        sweepUsedPost = Math.floor(num(usedMap[mode]));
        sweepBoughtPost = Math.floor(num(boughtMap[mode]));
        countersTouched = true;
      } else if (mode === 'wild') {
        const maxUnlocked = wildMaxUnlocked(wildCleared);
        level = Math.floor(num(ctx.body && ctx.body.level)) || maxUnlocked;
        if (wildCleared.includes(level)) {
          // 复战占全局 50 次/日额度（战败也占），跨日归零
          if (wildRepeatDay !== today) { wildRepeatDay = today; wildRepeatUsed = 0; }
          if (wildRepeatUsed >= WILD_REPEAT_DAILY) {
            db.exec('ROLLBACK');
            return sendJSON(res, 429, { error: '已战胜怪物每日挑战已达上限（' + WILD_REPEAT_DAILY + '/' + WILD_REPEAT_DAILY + '）' });
          }
          wildRepeatUsed += 1;
          countersTouched = true;
        } else if (level === maxUnlocked) {
          first = true;
        } else {
          db.exec('ROLLBACK');
          return sendJSON(res, 400, { error: '该区域尚未解锁' });
        }
      } else if (mode === 'endless') {
        level = endlessBest + 1;
        first = true;
      } else {
        replay = (mode === 'tower' ? towerCleared : stageCleared) >= cfg.max;
        level = replay ? cfg.max : (mode === 'tower' ? towerCleared : stageCleared) + 1;
        first = !replay;
      }

      // —— 战斗复算（五行克制乘区客户端在上报前不预乘——服务端统一算）——
      const env = envFor(ctx.user.id, now);
      const player = playerCombatStats(mirror, env);
      const enemy = enemyFor(mode, level, mirror);
      const elb = elementBonusOf(mirror, enemy.el);
      player.atk *= elb.mult;
      const result = simulateBattle(player, enemy);

      // —— 奖励 / 进度 / 掉落（仅胜场）——
      let stoneGain = 0;
      let expGain = 0;
      let trophy = 0;
      let frag = 0;
      let special = null;
      let progress = null;

      if (result.win) {
        const rewardScale = sweepLevel !== null ? (mode === 'wild' ? 1 : 0.5) : (replay ? 0.5 : 1);
        const gains = settleGain({ mode, level, first, rewardScale, boss: enemy.boss, data: mirror }, {
          ...env, weekend: isWeekend(), prodMult: dayProdMultOf(mirror),
        });
        stoneGain = gains.stoneGain;
        expGain = gains.expGain;
        trophy = gains.trophy;
        stmts.addStonesExp.run(stoneGain, stoneGain, expGain, ctx.user.id);
        stmts.logAction.run(ctx.user.id, today, 'fight', stoneGain, 0, 0, expGain, now);

        if (mode === 'wild') {
          wildKills[level] = Math.floor(num(wildKills[level])) + 1;
          if (first) wildCleared.push(level);
          stmts.setWildJson.run(JSON.stringify(wildCleared), JSON.stringify(wildKills), ctx.user.id);
        }

        special = rollSpecialDrop({
          mode, level, first, sweep: sweepLevel !== null, replay,
          killsNow: mode === 'wild' ? Math.floor(num(wildKills[level])) : 0,
        });

        // 藏宝图残片（陈列室门槛 = 境界 4，FEATURE_GATES 同源）
        if (featureRealmOf(mirror) >= 4 && Math.random() < TREASURE_DROP) frag = 1;

        // 进度推进（只进不退；扫荡/复战不推进）
        const advance = sweepLevel === null && !replay;
        const newTower = mode === 'tower' && advance ? level : towerCleared;
        const newStage = mode === 'stage' && advance ? level : stageCleared;
        const newEndless = mode === 'endless' ? Math.max(endlessBest, level) : endlessBest;
        stmts.setProgress.run(newTower, newStage, newEndless, wildMaxOf(wildCleared), ctx.user.id);
        progress = {
          towerCleared: newTower, stageCleared: newStage, endlessBest: newEndless,
          wildCleared, wildMax: wildMaxOf(wildCleared), wildKills,
        };
      }

      if (countersTouched) {
        stmts.setCounters.run(
          wildRepeatDay, wildRepeatUsed,
          sweepMap ? today : (led.sweep_day || ''), 
          JSON.stringify(sweepMap || modeMapOf(sameDayJson(led.sweep_day, today, led.sweep_used))),
          JSON.stringify(sweepBoughtMap || modeMapOf(sameDayJson(led.sweep_day, today, led.sweep_bought))),
          ctx.user.id);
      }

      db.exec('COMMIT');
      return sendJSON(res, 200, {
        ok: true, mode, level, win: !!result.win, first, replay,
        sweep: sweepLevel !== null,
        result: result, // 完整战报（events/playerHp/enemyHp 供战斗弹窗动画）
        enemy: {
          name: enemy.name, base: enemy.base, icon: enemy.icon, kicker: enemy.kicker,
          el: enemy.el, affix: enemy.affix, boss: enemy.boss, req: enemy.req,
          hp: enemy.hp, atk: enemy.atk, def: enemy.def,
        },
        element: elb,
        stoneGain, expGain, trophy, trophyField: TROPHY_FIELDS[mode], frag, special,
        progress,
        stamina: spent.view,
        // 权威计数回传（事务后的值）：客户端镜像精确对齐，本地只做展示预判
        counters: {
          sweepUsed: sweepUsedPost, sweepBought: sweepBoughtPost, wildRepeatUsed,
        },
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // 跨日保真：sweep_day === today 时用原 JSON，否则空表
  function sameDayJson(dayCol, today, json) {
    return dayCol === today ? json : '{}';
  }

  // POST /api/combat/offline：离线收益服务端复算（开箱期望 + 离线巡猎）。
  // 时间起点 = 上次结算（ledger.offline_at），客户端调钟彻底失效。
  function offline(req, res, ctx) {
    if (!window.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '操作过于频繁，请稍后再试' }, { 'Retry-After': '5' });
    }
    const now = Date.now();
    const today = dayStr(now);
    const saveRow = stmts.getSave.get(ctx.user.id);
    if (!saveRow) return sendJSON(res, 400, { error: '尚未创建云端存档' });
    const mirror = loadMirror(saveRow.data);

    db.exec('BEGIN');
    try {
      let led = ensureLedger(ctx.user.id, mirror, now);
      const prev = Math.floor(num(led.offline_at)) || now; // 首次不追溯（防存量玩家凭空白得）
      const elapsedS = Math.min(OFFLINE_CAP_S, Math.max(0, (now - prev) / 1000));
      if (elapsedS < 60) {
        stmts.setOfflineAt.run(now, ctx.user.id);
        db.exec('COMMIT');
        const st = staminaState(ctx.user.id, Date.now());
        return sendJSON(res, 200, {
          ok: true, settled: false, elapsed: Math.floor(elapsedS), opens: 0, stones: 0, exp: 0, hunt: null,
          stamina: st ? staminaView(st.cur) : null,
        });
      }

      const env = envFor(ctx.user.id, now);
      const e = expectedOf(mirror, env);
      const interval = Math.max(0.2, 2.5 * Math.pow(0.95, num(mirror.speedLv)));
      const n = Math.floor((elapsedS / interval) * OFFLINE_EFF);
      let stones = 0;
      let exp = 0;
      let opens = 0;
      let hunt = null;

      if (n > 0) {
        opens = n;
        stones = applyStoneBuffs(mirror, Math.floor(n * e.stone));
        exp = n * e.exp * (1 + 0.8 * num(mirror.realm)) * (1 + 0.5 * num(mirror.ascensions)) *
          (1 + 0.10 * num(mirror.cave && mirror.cave.library)) * (1 + 0.05 * num(mirror.gongfa && mirror.gongfa.hui));
      }

      // —— 离线巡猎（自动巡猎开且野外解锁；胜场按实扣体力折算）——
      const stageCleared = Math.floor(num(led.stage_cleared));
      if (mirror.autoHunt && stageCleared >= 3 && elapsedS >= HUNT_INTERVAL_S) {
        const boot = bootstrapWild(led, mirror);
        if (boot) led = stmts.getLedger.get(ctx.user.id); // 自举写库后重读，击杀数取新值
        let wildCleared = boot ? boot.cleared.slice() : [];
        if (!boot) {
          try { wildCleared = JSON.parse(led.wild_cleared || '[]'); } catch (e) { wildCleared = []; }
          if (!Array.isArray(wildCleared)) wildCleared = [];
        }
        const level = Math.max(1, Math.min(wildMaxUnlocked(wildCleared), Math.floor(num(mirror.wildZone)) || 1));
        const hunts = Math.floor((elapsedS / HUNT_INTERVAL_S) * OFFLINE_EFF);
        const player = playerCombatStats(mirror, env);
        const ratio = player.power / Math.max(1, recommendedPower('wild', level, mirror));
        const winRate = ratio >= 1.3 ? 0.95 : ratio >= 1 ? 0.8 : ratio >= 0.75 ? 0.5 : 0.2;
        const wins = Math.floor(hunts * winRate);
        if (wins > 0) {
          const paid = deductN(ctx.user.id, wins, now);
          const winsPaid = paid.ok ? paid.spent : 0;
          if (winsPaid > 0) {
            const cfg = MODES.wild;
            const stoneEach = Math.floor(contentReq('wild', level, mirror) * cfg.stone);
            const expEach = Math.floor(contentReq('wild', level, mirror) * cfg.exp * MODE_EXP_MULT *
              (1 + 0.10 * num(mirror.cave && mirror.cave.library)) * (1 + 0.05 * num(mirror.gongfa && mirror.gongfa.hui)));
            const trophyEach = 1 + Math.floor(level / cfg.trophyStep);
            const huntStones = winsPaid * stoneEach;
            const huntExp = winsPaid * expEach;
            // 灵石/修为不在此处入账：与开箱部分合并在离线末尾一次性 add+log（防双记）
            let wildKills = modeMapOf(led.wild_kills);
            const oldKills = Math.floor(num(wildKills[level]));
            wildKills[level] = oldKills + winsPaid;
            stmts.setWildJson.run(JSON.stringify(wildCleared), JSON.stringify(wildKills), ctx.user.id);
            const pity = Math.floor((oldKills + winsPaid) / OFFLINE_HUNT_PITY) - Math.floor(oldKills / OFFLINE_HUNT_PITY);
            const randomDrops = Math.floor(winsPaid * WILD_SET_RATE);
            const drops = [];
            for (let i = 0; i < pity + randomDrops && drops.length < 12; i++) {
              drops.push(makeSpecialItem('wild', level, SLOTS[Math.floor(Math.random() * SLOTS.length)].key, () => 0, contentReq));
            }
            hunt = {
              wins: winsPaid, hunts, stones: huntStones, exp: huntExp,
              trophy: winsPaid * trophyEach, drops, clamped: winsPaid < wins,
              level, wildKills, // 权威击杀计数回传（客户端镜像对齐）
            };
            stones += huntStones;
            exp += huntExp;
          } else {
            hunt = { wins: 0, hunts, clamped: true };
          }
        }
      }

      if (opens > 0 || (hunt && hunt.wins > 0)) {
        stmts.logAction.run(ctx.user.id, today, 'offline', stones, 0, 0, Math.floor(exp), now);
        stmts.addStonesExp.run(stones, stones, Math.floor(exp), ctx.user.id);
        if (opens > 0) stmts.addOpens.run(opens, ctx.user.id);
      }
      stmts.setOfflineAt.run(now, ctx.user.id);
      const st = staminaState(ctx.user.id, now);
      db.exec('COMMIT');
      return sendJSON(res, 200, {
        ok: true, settled: opens > 0 || !!(hunt && hunt.wins > 0),
        elapsed: Math.floor(elapsedS), opens, stones, exp: Math.floor(exp),
        hunt, stamina: st ? staminaView(st.cur) : null,
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // addStones 增益链直接复用 battle.js 的实现（周/时辰/天象/内丹一份口径）
  const applyStoneBuffs = (mirror, n) => applyStoneBuffsOf(mirror, n);

  return { fight, offline };
}
