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
import { ledgerOf, rollSetPity } from './economy.js';
import { guildLevel as guildLevelOf } from './social.js';
import {
  simulateBattle, MODES, contentReq, enemyFor, recommendedPower,
  playerCombatStats, elementBonusOf, settleGain, expectedOf, dayProdMultOf,
  applyStoneBuffsOf,
  WILD_MAX, ENDLESS_GATE, TROPHY_FIELDS, MODE_EXP_MULT,
  WILD_SET_PITY, WILD_SET_PITY_DAILY, WILD_SET_RATE, MODE_SET_RATE, TREASURE_DROP,
  // （OFFLINE_HUNT_PITY 已废止：离线巡猎并入四模式统一 50 胜保底 + 每日 2 件口径）
  SWEEP_DAILY_FREE, SWEEP_BUY_MAX, SWEEP_BUY_COST, WILD_REPEAT_DAILY,
  TRIALS, TRIAL_REWARD,
  // 本命法宝（2026-11-04）：器灵经验曲线/上限/胜场经验在 battle.js（game.js 同源）
  bondNeed, bondCap, bondExpOf,
} from './battle.js';
import { SLOTS, SETS, makeSpecialItem } from './items.js';

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

// —— 胜场素材掉落（2026-11-03 用户指定）：征战/野外胜场概率掉牧场种子与洗炼石，
// 给牧场/坊市线补一条非农场来源。数量走响应由客户端入库存（farmSeeds/rerollStones
// 均在存档白名单内，0..1e6 校验兜底），不入账本灵石、不碰增速包络。
// 种子 id 与权重同源 game.js FARM_SEEDS（server/shop.js FARM_SEED_MS 同表），低档常见；
// 洗炼石六型 key 同源 game.js RSTONE_KEYS（saves.js AFFIX_KEYS 白名单），六型均权。
// 扫荡/复战按 rewardScale（0.5）折算概率，首通 +15%/+10%、首领 +10%。
const MAT_SEED_WEIGHTS = { cao: 38, hua: 22, guo: 15, sui: 10, lian: 7, tong: 5, xing: 3 };
const MAT_RSTONE_KEYS = ['atk', 'hp', 'def', 'crit', 'ls', 'pierce'];

function rollMatDrops(rewardScale, boss, first) {
  const scale = Math.min(1, Math.max(0, rewardScale || 0));
  const seedKeys = Object.keys(MAT_SEED_WEIGHTS);
  const wSum = seedKeys.reduce((s, k) => s + MAT_SEED_WEIGHTS[k], 0);
  const out = { seeds: {}, rstones: {} };
  const seedChance = 0.25 + (boss ? 0.1 : 0) + (first ? 0.15 : 0);
  const stoneChance = 0.2 + (boss ? 0.1 : 0) + (first ? 0.1 : 0);
  if (Math.random() < seedChance * scale) {
    let roll = Math.random() * wSum;
    let pick = seedKeys[0];
    for (const k of seedKeys) { roll -= MAT_SEED_WEIGHTS[k]; if (roll < 0) { pick = k; break; } }
    out.seeds[pick] = 1 + (Math.random() < 0.5 ? 1 : 0);
  }
  if (Math.random() < stoneChance * scale) {
    out.rstones[MAT_RSTONE_KEYS[Math.floor(Math.random() * MAT_RSTONE_KEYS.length)]] = 1;
  }
  return out;
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
    setSetPity: db.prepare('UPDATE save_ledger SET set_pity = ? WHERE user_id = ?'),
    setCounters: db.prepare(
      `UPDATE save_ledger SET wild_repeat_day = ?, wild_repeat_used = ?,
         sweep_day = ?, sweep_used = ?, sweep_bought = ? WHERE user_id = ?`),
    setOfflineAt: db.prepare('UPDATE save_ledger SET offline_at = ? WHERE user_id = ?'),
    // 本命法宝器灵（2026-11-04）：等级/经验真值落账本，推送档对账见 saves.js store
    setBond: db.prepare('UPDATE save_ledger SET bond_lv = ?, bond_exp = ? WHERE user_id = ?'),
    setTrial: db.prepare('UPDATE save_ledger SET trial_day = ?, trial_done = ? WHERE user_id = ?'),
    spendStones: db.prepare(
      'UPDATE save_ledger SET stones = stones - ?, srv_spent_stones = srv_spent_stones + ? WHERE user_id = ? AND stones >= ?'),
    logAction: db.prepare(
      'INSERT INTO action_log (user_id, day, kind, stones, dust, tickets, exp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    // 仙盟等级由基金现算（social.js guildLevel 同一口径）：guilds.level 列自建表起
    // 从未被更新（恒为默认 1），读它会让高等级仙盟的收益加成恒按 Lv.1 结算（少发方向）
    guildFund: db.prepare(
      'SELECT g.fund AS fund FROM guild_members gm JOIN guilds g ON g.id = gm.guild_id WHERE gm.user_id = ?'),
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
    const g = stmts.guildFund.get(userId);
    return { now, guildLevel: g ? guildLevelOf(g.fund) : 0 };
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

  // —— 本命法宝（2026-11-04）——
  // 真值注入：战斗面板的器灵等级以账本为权威（防改档直拉等级喂大 playerCombatStats），
  // 镜像只供认主部位（slot 无战力含义）。须在 ensureLedger 之后、playerCombatStats 之前调用
  function applyBondTruth(mirror, led) {
    const slot = mirror.bond && mirror.bond.slot;
    if (!slot) { mirror.bond = null; return; }
    mirror.bond = { slot, lv: Math.floor(num(led.bond_lv)) };
  }

  // 胜场器灵经验入账 + 升级循环（在线 fight / 离线巡猎共用一份口径）。
  // 未认主或已到上限（cap 随轮回 3/5/7/9 解锁）不发；到顶经验清零。返回响应回传的新 bond 态
  function bondAccrue(userId, led, mirror, gain) {
    if (!(gain > 0) || !(mirror.bond && mirror.bond.slot)) return null;
    const cap = bondCap(Math.floor(num(led.ascensions)));
    let lv = Math.floor(num(led.bond_lv));
    let exp = Math.floor(num(led.bond_exp)) + Math.floor(gain);
    while (lv < cap && exp >= bondNeed(lv)) { exp -= bondNeed(lv); lv++; }
    if (lv >= cap) exp = 0;
    stmts.setBond.run(lv, exp, userId);
    return { slot: mirror.bond.slot, lv, exp };
  }

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

  // 套装件掉落 roll（仅胜场调用；game.js doBattle 掉落段同源）。id=0 由客户端收货时重编。
  // 保底状态机在 economy.js rollSetPity（四模式每胜 50 场、每日 2 件，纯函数可单测）；
  // 随机 0.8%（含首通、复战、扫荡）不受保底配额限制，可与保底同场各掉一件。
  // random 与 pity 分开返回：客户端对 pitySpecial 单独播「保底达成」，混排进一个
  // 数组再按下标取会把「仅保底掉落」错装进 special 字段、丢保底播报。
  function rollSpecialDrop({ mode, level, win, pityMap, today }) {
    const itemSeq = () => 0;
    const randSlot = () => SLOTS[Math.floor(Math.random() * SLOTS.length)].key;
    const dropOne = (m) => makeSpecialItem(m === 'endless' ? 'tower' : m, level, randSlot(), itemSeq, contentReq);
    const out = rollSetPity(pityMap, mode, win, today, dropOne);
    return {
      random: win && Math.random() < MODE_SET_RATE ? dropOne(mode) : null,
      pityItems: out.pityItems,
      pityMap: out.pityMap,
    };
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
      applyBondTruth(mirror, led); // 本命法宝等级以账本为权威（喂战斗面板前注入）
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
      // 跨日归一（2026-11-03，下方 sweep 的 sameDayJson 同口径）：旧值直接回传会让客户端
      // 把 daily.wildRepeat 污染成昨日值——本地预检拦截复战，当日 50 次额度全废
      let wildRepeatUsed = wildRepeatDay === today ? Math.floor(num(led.wild_repeat_used)) : 0;
      let sweepUsedPost = sameDayJson(led.sweep_day, today, led.sweep_used) === '{}' ? 0
        : Math.floor(num(modeMapOf(led.sweep_used)[mode]));
      let sweepBoughtPost = sameDayJson(led.sweep_day, today, led.sweep_bought) === '{}' ? 0
        : Math.floor(num(modeMapOf(led.sweep_bought)[mode]));
      // 扫荡败局不扣口径（2026-11-05 用户指定）：留一份消耗前的计数快照，败局回滚后回传
      const sweepUsedPre = sweepUsedPost;
      const sweepBoughtPre = sweepBoughtPost;

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
          const out = stmts.spendStones.run(SWEEP_BUY_COST, SWEEP_BUY_COST, ctx.user.id, SWEEP_BUY_COST);
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

      // 扫荡战败全额不扣（2026-11-05 用户指定，对齐「战败不损失进度」口径）：
      // 体力 / 扫荡次数 / 加购费全部随事务 ROLLBACK，响应回传未消耗的体力与计数镜像
      // （sweepFreeLoss 标记供客户端提示）；胜局照旧消耗。败局不发任何奖励。
      if (sweepLevel !== null && !result.win) {
        db.exec('ROLLBACK');
        const st = staminaState(ctx.user.id, now);
        return sendJSON(res, 200, {
          ok: true, mode, level, win: false, first: false, replay: false,
          sweep: true, sweepFreeLoss: true,
          result,
          enemy: {
            name: enemy.name, base: enemy.base, icon: enemy.icon, kicker: enemy.kicker,
            el: enemy.el, affix: enemy.affix, boss: enemy.boss, req: enemy.req,
            hp: enemy.hp, atk: enemy.atk, def: enemy.def,
          },
          element: elb,
          stoneGain: 0, expGain: 0, trophy: 0, trophyField: TROPHY_FIELDS[mode],
          frag: 0, special: null, pitySpecial: null, matDrops: null, bond: null,
          progress: null,
          stamina: st ? staminaView(st.cur) : null,
          counters: {
            sweepUsed: sweepUsedPre, sweepBought: sweepBoughtPre, wildRepeatUsed,
          },
        });
      }

      // —— 奖励 / 进度 / 掉落（仅胜场）——
      let stoneGain = 0;
      let expGain = 0;
      let trophy = 0;
      let frag = 0;
      let matDrops = null;
      let special = null;
      let pitySpecial = null;
      let progress = null;
      let bond = null;

      if (result.win) {
        const rewardScale = sweepLevel !== null ? (mode === 'wild' ? 1 : 0.5) : (replay ? 0.5 : 1);
        const gains = settleGain({ mode, level, first, rewardScale, boss: enemy.boss, data: mirror,
          sweep: sweepLevel !== null }, {
          ...env, weekend: isWeekend(), prodMult: dayProdMultOf(mirror),
        });
        stoneGain = gains.stoneGain;
        expGain = gains.expGain;
        trophy = gains.trophy;
        stmts.addStonesExp.run(stoneGain, stoneGain, expGain, ctx.user.id);
        stmts.logAction.run(ctx.user.id, today, 'fight', stoneGain, 0, 0, expGain, now);
        // 器灵经验（2026-11-04）：胜场发放，扫荡/复战随 rewardScale 折算；账本级记账
        bond = bondAccrue(ctx.user.id, led, mirror,
          bondExpOf({ level, boss: enemy.boss, first, rewardScale }));

        if (mode === 'wild') {
          wildKills[level] = Math.floor(num(wildKills[level])) + 1;
          if (first) wildCleared.push(level);
          stmts.setWildJson.run(JSON.stringify(wildCleared), JSON.stringify(wildKills), ctx.user.id);
        }

        // 保底计数器（账本 set_pity：{mode:[胜场,日,当日已保底数]}，跨会话累计）
        const setPityMap = modeMapOf(led.set_pity);
        const rolled = rollSpecialDrop({
          mode, level, win: true,
          pityMap: setPityMap,
          today,
        });
        special = rolled.random;
        pitySpecial = rolled.pityItems[0] || null;
        stmts.setSetPity.run(JSON.stringify(rolled.pityMap), ctx.user.id);

        // 藏宝图残片（陈列室门槛 = 境界 4，FEATURE_GATES 同源）
        if (featureRealmOf(mirror) >= 4 && Math.random() < TREASURE_DROP) frag = 1;

        // 素材掉落（2026-11-03 用户指定）：种子/洗炼石随胜场掉落（扫荡/复战概率折算）
        matDrops = rollMatDrops(rewardScale, enemy.boss, first);

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
        stoneGain, expGain, trophy, trophyField: TROPHY_FIELDS[mode], frag, special, pitySpecial,
        matDrops,
        bond,
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
      applyBondTruth(mirror, led); // 本命法宝等级以账本为权威（喂战斗面板前注入）
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
      let bond = null;

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
            // 离线巡猎与在线结算同源（2026-11-03，settleGain 单一入口）：原手抄式只乘
            // library/hui，漏了 ×60 修为 boost 与周/时辰/天象/内丹灵石增益——同关卡离线
            // 每胜修为仅为在线复战的 1/30。rewardScale 取 1（野外扫荡档，审计口径）；
            // boss/first 恒 false（离线只有复战语义）
            const gains = settleGain({ mode: 'wild', level, first: false, rewardScale: 1,
              boss: false, data: mirror, sweep: false }, {
              ...env, weekend: isWeekend(), prodMult: dayProdMultOf(mirror),
            });
            const stoneEach = gains.stoneGain;
            const expEach = gains.expGain;
            const trophyEach = gains.trophy;
            const huntStones = winsPaid * stoneEach;
            const huntExp = winsPaid * expEach;
            // 灵石/修为不在此处入账：与开箱部分合并在离线末尾一次性 add+log（防双记）
            let wildKills = modeMapOf(led.wild_kills);
            const oldKills = Math.floor(num(wildKills[level]));
            wildKills[level] = oldKills + winsPaid;
            stmts.setWildJson.run(JSON.stringify(wildCleared), JSON.stringify(wildKills), ctx.user.id);
            // 离线巡猎与在线野外共用同一保底计数（2026-11-01 二改：每胜 50 场、每日 2 件，
            // 原离线 100 胜独立保底口径废止）；随机期望 floor(胜场×0.8%) 不受限
            const setPityMap = modeMapOf(led.set_pity);
            const pst = Array.isArray(setPityMap.wild) ? setPityMap.wild : [0, '', 0];
            let pityWins = (pst[0] | 0) + winsPaid;
            let pityDay = String(pst[1] || '');
            let pityN = pst[2] | 0;
            if (pityDay !== today) { pityDay = today; pityN = 0; }
            const randomDrops = Math.floor(winsPaid * WILD_SET_RATE);
            const drops = [];
            for (let i = 0; i < randomDrops && drops.length < 12; i++) {
              drops.push(makeSpecialItem('wild', level, SLOTS[Math.floor(Math.random() * SLOTS.length)].key, () => 0, contentReq));
            }
            while (pityWins >= WILD_SET_PITY && pityN < WILD_SET_PITY_DAILY && drops.length < 12) {
              drops.push(makeSpecialItem('wild', level, SLOTS[Math.floor(Math.random() * SLOTS.length)].key, () => 0, contentReq));
              pityWins -= WILD_SET_PITY;
              pityN++;
            }
            setPityMap.wild = [pityWins, pityDay, pityN];
            stmts.setSetPity.run(JSON.stringify(setPityMap), ctx.user.id);
            // 离线巡猎胜场器灵经验（2026-11-04）：与在线胜场同一 bondExpOf 口径批量结算
            bond = bondAccrue(ctx.user.id, led, mirror,
              bondExpOf({ level, boss: false, first: false, rewardScale: 1 }) * winsPaid);
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
        hunt, bond, stamina: st ? staminaView(st.cur) : null,
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // addStones 增益链直接复用 battle.js 的实现（周/时辰/天象/内丹一份口径）
  const applyStoneBuffs = (mirror, n) => applyStoneBuffsOf(mirror, n);

  // 条件试炼（2026-11-01 用户指定上收服务端）：失败免费重试；通关标记与奖励以服务端
  // 当日 done 表为准——改档 / 回滚 / 多开都无法重复领奖。奖励数值由响应下发、客户端
  // addStones/addDust 入账（2400 万灵石/日量级远低于增速包络），防重关键在 trial_done 标记
  function trial(req, res, ctx) {
    const id = typeof ctx.body?.id === 'string' ? ctx.body.id : '';
    const def = TRIALS.find((t) => t.id === id);
    if (!def) return sendJSON(res, 400, { error: '未知试炼' });
    const now = Date.now();
    const today = dayStr(now);
    const saveRow = stmts.getSave.get(ctx.user.id);
    if (!saveRow) return sendJSON(res, 400, { error: '尚未创建云端存档' });
    const mirror = loadMirror(saveRow.data);
    db.exec('BEGIN');
    try {
      const led = ensureLedger(ctx.user.id, mirror, now);
      applyBondTruth(mirror, led); // 本命法宝等级以账本为权威（喂战斗面板前注入）
      // 境界门槛：化神（FEATURE_GATES.trials 同口径）——按水位 max(realm, realmPeak) 判定，
      // 与客户端 featureOpen 一致；飞升轮回后境界归零但已解锁玩法不回锁（2026-11-01 口径），
      // 原只查 mirror.realm 会把飞升老玩家在服务端拒之门外（客户端放行、服务端 400）
      if (featureRealmOf(mirror) < 4) {
        db.exec('ROLLBACK');
        return sendJSON(res, 400, { error: '条件试炼需境界「化神」' });
      }
      let done = [];
      if (led.trial_day === today) {
        try { done = JSON.parse(led.trial_done || '[]'); } catch (e) { done = []; }
        if (!Array.isArray(done)) done = [];
      }
      if (done.includes(id)) {
        db.exec('ROLLBACK');
        return sendJSON(res, 200, { pass: true, already: true, done, reward: null });
      }
      // 关卡口径与客户端 currentLevel 同源：账本进度 +1 封顶 200，野外取当前选中区
      const level = def.enemy === 'wild'
        ? Math.max(1, Math.min(WILD_MAX, Math.floor(num(mirror.wildZone)) || 1))
        : Math.min(MODES[def.enemy].max,
            Math.floor(num(def.enemy === 'tower' ? led.tower_cleared : led.stage_cleared)) + 1);
      const env = envFor(ctx.user.id, now);
      const player = playerCombatStats(mirror, env);
      if (def.noLs) player.lifesteal = 0;
      const enemy = enemyFor(def.enemy, level, mirror);
      const elb = elementBonusOf(mirror, enemy.el);
      player.atk *= elb.mult;
      const result = simulateBattle(player, enemy);
      const pass = result.win &&
        (!def.maxRounds || result.rounds <= def.maxRounds) &&
        (!def.takenRatio || result.taken <= player.hp * def.takenRatio);
      if (!pass) {
        const reason = !result.win ? '战斗失败'
          : def.maxRounds ? '耗时 ' + result.rounds + ' 回合（需 ≤' + def.maxRounds + '）' : '承伤超限';
        db.exec('ROLLBACK');
        return sendJSON(res, 200, { pass: false, reason, result, playerHp: player.hp, done });
      }
      done.push(id);
      const allClear = done.length >= TRIALS.length;
      stmts.setTrial.run(today, JSON.stringify(done), ctx.user.id);
      stmts.logAction.run(ctx.user.id, today, 'trial',
        TRIAL_REWARD.stones, TRIAL_REWARD.dust + (allClear ? 60 : 0), 0, 0, now);
      db.exec('COMMIT');
      return sendJSON(res, 200, {
        pass: true, done, result, playerHp: player.hp,
        enemy, // 实战同一实例（2026-11-03：原响应里重掷 enemyFor 会换五行/词缀，弹窗展示与实战不一致）
        reward: { stones: TRIAL_REWARD.stones, dust: TRIAL_REWARD.dust, allClear },
      });
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* 无事务可回滚 */ }
      throw e;
    }
  }

  return { fight, offline, trial };
}
