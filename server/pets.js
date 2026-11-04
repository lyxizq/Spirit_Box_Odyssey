// 灵宠玩法服务（2026-11-02 灵宠个体化重构）：缚灵谷捕捉 / 灵宠合成 / 词条洗髓。
// 概率玩法全部服务端掷结果（P3 语义，照 combat.js/items.js 先例）：
//   遇敌与捕捉两阶段分离——hunt 把 pending 遭遇存 save_ledger.pet_hunt JSON 列，
//   capture 消费它，客户端无法重掷或跳过消耗直接拿宠。
// 口径红线（items.js 文件头同款）：
//   ① rollPetInst 生成的实例与 saves.js validateDeep 的 petInsts 校验互为镜像
//     （物种白名单、品质在物种带内、等级 1..100、词条数=品质条数、值 0..0.6、不重复）；
//   ② 常量表与消费端公式改动必须同步 game.js / battle.js（parity-check.mjs 兜底）。
// 灵石类消耗走账本原子扣款（social.js spendLedger 同款）；招募券同为账本列；
// 兽骨/碎屑/洗练券不在账本，服务端按存档镜像复核、客户端吸收响应后自行扣减入档。
import { sendJSON, SlidingWindow } from './http-util.js';
import { ledgerOf } from './economy.js';
import { AFFIXES, AFFIX_COUNT, AFFIX_QMULT } from './items.js';
import { computeStamina, staminaView, STAMINA_CAP } from './stamina.js';

// —— 物种表（game.js PET_SPECIES 同源；band = 品质带 [min, max]）——
export const PET_SPECIES = [
  { id: 'ying',   name: '幽萤蝶',   icon: '蝶', stat: 'hp',     per: 0.02,  band: [0, 1] },
  { id: 'xi',     name: '青岩蜥',   icon: '蜥', stat: 'def',    per: 0.018, band: [0, 1] },
  { id: 'rat',    name: '灵瞳鼠',   icon: '鼠', stat: 'crit',   per: 0.004, band: [1, 2] },
  { id: 'turtle', name: '铁甲龟',   icon: '龟', stat: 'hp',     per: 0.025, band: [1, 2] },
  { id: 'fox',    name: '雷灵狐',   icon: '狐', stat: 'atk',    per: 0.02,  band: [1, 3] },
  { id: 'sun',    name: '风隼',     icon: '隼', stat: 'pierce', per: 0.005, band: [1, 3] },
  { id: 'chan',   name: '玄冰蟾',   icon: '蟾', stat: 'def',    per: 0.022, band: [2, 3] },
  { id: 'zhu',    name: '千机蛛',   icon: '蛛', stat: 'crit',   per: 0.005, band: [2, 4] },
  { id: 'pixiu',  name: '招财貔貅', icon: '貔', stat: 'gain',   per: 0.03,  band: [2, 4] },
  { id: 'baize',  name: '白泽',     icon: '泽', stat: 'ls',     per: 0.005, band: [3, 4] },
  { id: 'qilin',  name: '烛麒麟',   icon: '麟', stat: 'hp',     per: 0.03,  band: [3, 5] },
  // 鲲鹏雏品质带下探到地（2026-11-03 用户指定）：秘境可产地品鲲作合成素材（地×3→天×3→仙），
  // 服务端 validateDeep 与本表同源，扩带后 r3 合法
  { id: 'kun',    name: '鲲鹏雏',   icon: '鲲', stat: 'atk',    per: 0.028, band: [3, 5] },
];
export const PET_SP_MAP = {};
for (const s of PET_SPECIES) PET_SP_MAP[s.id] = s;

// —— 缚灵谷五地（realm = 解锁境界下标，与客户端 FEATURE_GATES.pets=4 化神起）——
export const PET_ZONES = [
  { id: 'huang',  name: '荒山', realm: 4, pool: ['ying', 'xi', 'rat'],              w: [60, 30, 10] },
  { id: 'gu',     name: '灵谷', realm: 5, pool: ['rat', 'turtle', 'fox', 'sun'],    w: [30, 30, 28, 12] },
  // 秘境全物种（2026-11-03 用户指定）：到秘境即可捕捉全部 12 物种，产出最高只到地品
  //（cap=3 钳制带内掷点；鲲鹏雏品质带 天~仙 无法产出地品，保持带内原样为唯一例外）
  { id: 'mijing', name: '秘境', realm: 6, cap: 3,
    pool: ['ying', 'xi', 'rat', 'turtle', 'fox', 'sun', 'chan', 'zhu', 'pixiu', 'baize', 'qilin', 'kun'],
    w: [12, 12, 12, 12, 11, 10, 10, 9, 9, 6, 1, 1] },
  { id: 'guyuan', name: '古渊', realm: 7, pool: ['zhu', 'pixiu', 'baize', 'qilin'], w: [25, 25, 32, 18] },
  { id: 'xianfu', name: '仙府', realm: 8, pool: ['qilin', 'kun'],                   w: [45, 55] },
];

// —— 捕捉数值（game.js 同源）——
export const PET_HUNT_STAMINA = 3;   // 每次探索体力
export const PET_HUNT_TICKET = 1;    // 每次探索招募券
export const PET_HUNT_DAILY = 50;    // 每日探索次数上限（基础，可用灵石加购）
export const PET_HUNT_BUY_COST = 2e5;   // 加购单价：20 万灵石 +1 次（2026-11-03 用户指定）
export const PET_HUNT_BUY_DAILY = 50;   // 每日加购次数上限
export const PET_MEET_RATE = 0.65;   // 单次遇宠率
export const PET_MEET_PITY = 3;      // 连续 3 次未遇必遇
export const PET_LV_MAX = 100;       // 个体等级上限
export const PET_INST_MAX = 100;     // 个体持有硬上限
// 灵宠背包容量（2026-11-02 用户指定，game.js 同源）：基础 50 格，扩容 +10/次至多 5 次到 100
export const PET_BAG_BASE = 50;
export const PET_BAG_STEP = 10;
export const PET_BAG_MAX_LV = 5;
export const petBagCapOf = (mirror) =>
  PET_BAG_BASE + PET_BAG_STEP * Math.max(0, Math.min(PET_BAG_MAX_LV, Math.floor(Number(mirror && mirror.petBagLv) || 0)));
// 品质带内 roll 的相对权重（offset 0..5）：越往上越稀
const BAND_WEIGHTS = [100, 38, 12, 3.5, 1, 0.3];
// 收服基础成功率（按品质）；镇抚策略加成后封顶 95%。
// 天/仙品大幅压低（2026-11-03 用户指定，game.js 同源）：高品灵宠主要走三合一合成获取
export const PET_CAPTURE_BASE = [0.9, 0.75, 0.6, 0.45, 0.08, 0.03];
export const PET_CAPTURE_CAP = 0.95;
// 镇抚策略：feed 灵石按品质 ×8（凡 2 万 → 仙 6553.6 万），awe 兽骨按品质平方
export const PET_POLICY = {
  bare: { name: '空手收服', add: 0 },
  feed: { name: '投喂灵果', add: 0.2, stones: (r) => Math.round(2e4 * Math.pow(8, r)) },
  awe:  { name: '灵威镇压', add: 0.12, bones: (r) => 20 * (r + 1) * (r + 1) },
};
// 合成费用（灵石，按当前品质 ×6）：凡 5 万 → 天 6480 万；锁灵另耗 1 洗练券
export const PET_FUSE_COST = (r) => Math.round(5e4 * Math.pow(6, r));
// 洗髓费用：灵石按品质与洗练次数复利、锁条 ×2（口径对齐工坊 rerollCost）；碎屑按品质
export const PET_REROLL_STONES = (r, times, lockN) =>
  Math.floor((1e4 * Math.pow(4, r)) * Math.pow(1.3, times || 0) * Math.pow(2, lockN || 0));
export const PET_REROLL_DUST = (r, lockN) => 10 * (r + 1) * Math.pow(2, lockN || 0);
// 个体词条贡献的等级成长（消费端：v × (1 + 0.01×(lv-1))，lv100 ≈ ×2）
export const PET_AFF_LV_STEP = 0.01;
export const PET_RARITY_NAMES = ['凡品', '灵品', '玄品', '地品', '天品', '仙品'];

const dayStr = (now = Date.now()) => {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function loadMirror(text) {
  try {
    const d = JSON.parse(text || '{}');
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch (e) {
    return {};
  }
}

// —— 生成器（与 validateDeep petInsts 校验互为镜像）——

function rollAffixValue(def, r) {
  const v = (def.min + Math.random() * (def.max - def.min)) * (AFFIX_QMULT[r] || 1);
  return Math.max(0, Math.round(Math.min(0.6, v) * 1000) / 1000);
}

// 从池里掷 n 条不重复词条；exclude 键集合用于锁灵/洗髓保底。
// r 传品质（2026-11-03 修口径漂移）：词条值 ×AFFIX_QMULT[r] 随品质放大——原写死 0
// 让服务端掷出的仙品词条恒为客户端公式一半强度（legal 玩家吃亏），带品质的
// rerollPetAffixes 反而是死代码，已删
function rollAffixesInto(n, exclude, r) {
  const used = new Set(exclude || []);
  const out = [];
  let guard = 64;
  while (out.length < n && guard-- > 0) {
    const def = AFFIXES[Math.floor(Math.random() * AFFIXES.length)];
    if (used.has(def.k)) continue;
    used.add(def.k);
    out.push({ k: def.k, v: rollAffixValue(def, r || 0) });
  }
  return out;
}

// 物种品质带内掷品质；spDef.band = [min, max]
// 带内掷品质；cap = 地点品质上限（2026-11-03 用户指定：秘境产出最高只到地品）——
// 掷点区间钳到 [lo, min(hi, cap)]；物种带下限高于 cap 时（鲲鹏雏带 天~仙）保持带内原样，
// 品质带是硬约束（validateDeep 拒带外品质），不得产出带外地品
export function rollBandRarity(spDef, cap) {
  const [lo, hi] = spDef.band;
  const top = cap == null ? hi : Math.max(lo, Math.min(hi, cap));
  let total = 0;
  const w = [];
  for (let r = lo; r <= top; r++) { w.push(BAND_WEIGHTS[r] || 0.3); total += BAND_WEIGHTS[r] || 0.3; }
  let roll = Math.random() * total;
  for (let i = 0; i < w.length; i++) {
    roll -= w[i];
    if (roll <= 0) return lo + i;
  }
  return lo;
}

// 生成一只灵宠个体。uid=0 占位（capture/fuse 事务内以 nextPetUid 换发真实 uid）
export function rollPetInst(spId, r, lv) {
  const spDef = PET_SP_MAP[spId];
  if (!spDef) return null;
  const ri = Math.max(spDef.band[0], Math.min(spDef.band[1], Math.floor(num(r))));
  const n = AFFIX_COUNT[ri] || 0;
  return {
    uid: 0,
    sp: spId,
    r: ri,
    lv: Math.max(1, Math.min(PET_LV_MAX, Math.floor(num(lv)) || 1)),
    affixes: n ? rollAffixesInto(n, [], ri) : [],
  };
}

export function createPetsService(db, staminaSvc) {
  const window = new SlidingWindow(60 * 1000, 60); // 灵宠动作 60 次/分钟
  const stmts = {
    getSave: db.prepare('SELECT data FROM game_saves WHERE user_id = ?'),
    getLedger: db.prepare('SELECT * FROM save_ledger WHERE user_id = ?'),
    // 无账本行首玩：按 saves.js 首推同口径从镜像种基线
    seedLedger: db.prepare(
      `INSERT INTO save_ledger (user_id, stones, total_stones, dust_total, opens, exp, pet_tickets,
         ascensions, immortal, power, tower_cleared, stage_cleared, endless_best, wild_max, grants,
         clicks, click_ban_until, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?)`),
    spendLedger: db.prepare('UPDATE save_ledger SET stones = stones - ? WHERE user_id = ? AND stones >= ?'),
    spendTickets: db.prepare('UPDATE save_ledger SET pet_tickets = pet_tickets - ? WHERE user_id = ? AND pet_tickets >= ?'),
    setPetHunt: db.prepare('UPDATE save_ledger SET pet_hunt = ? WHERE user_id = ?'),
    // uid 发号（2026-11-03 伪面收窄）：pet_seq 水位列见 db.js 注
    initPetSeq: db.prepare('UPDATE save_ledger SET pet_seq = ? WHERE user_id = ?'),
    bumpPetSeq: db.prepare('UPDATE save_ledger SET pet_seq = COALESCE(pet_seq, 0) + 1 WHERE user_id = ?'),
    setPetUsed: db.prepare('UPDATE save_ledger SET pet_used = ? WHERE user_id = ?'),
    setPetRerolls: db.prepare('UPDATE save_ledger SET pet_rerolls = ? WHERE user_id = ?'),
    logAction: db.prepare(
      'INSERT INTO action_log (user_id, day, kind, stones, dust, tickets, exp, created_at) VALUES (?, ?, ?, 0, 0, 0, 0, ?)'),
  };

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

  function petHuntOf(led, today) {
    let h = {};
    try { h = JSON.parse(led.pet_hunt || '{}'); } catch (e) { h = {}; }
    if (!h || typeof h !== 'object' || Array.isArray(h)) h = {};
    // 跨日归零：探索计数、保底与加购计数清零；未收服的遭遇保留（品种/词条已掷定，无重掷面）
    if (h.day !== today) { h.day = today; h.hunts = 0; h.pity = 0; h.buys = 0; }
    h.hunts = Math.max(0, Math.floor(num(h.hunts)));
    h.pity = Math.max(0, Math.floor(num(h.pity)));
    h.buys = Math.max(0, Math.floor(num(h.buys)));
    return h;
  }

  // —— uid 发号 / 销账（2026-11-03 伪面收窄，全部须在事务内调用）——
  // JSON 列读容错：脏数据按空表处理（写入时即被整表覆盖，无残留面）
  function jsonMapOf(text) {
    let m = {};
    try { m = JSON.parse(text || '{}'); } catch (e) { m = {}; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) m = {};
    return m;
  }
  // 防胀：条目只增不减（放生不销账），超 512 条时只保留 uid 最大的 256 条（uid 单调递增
  // = 最新的个体；旧条目对应的个体早已不存在，计费语义无损）
  function pruneMap(m, keep = 256) {
    const keys = Object.keys(m);
    if (keys.length <= 512) return m;
    const out = {};
    keys.map(Number).sort((a, b) => a - b).slice(-keep)
      .forEach((k) => { out[k] = m[k]; });
    return out;
  }
  // 发下一个个体 uid。pet_seq NULL（客户端发号时代的旧行）先从镜像最大 uid 种入——
  // 否则新发的 uid=1 会与存量个体撞号，validateDeep 的 uid 唯一校验会把该号拒收砖死
  function nextPetUid(userId, mirror) {
    let led = stmts.getLedger.get(userId);
    if (led.pet_seq === null || led.pet_seq === undefined) {
      let mx = 0;
      const insts = Array.isArray(mirror.petInsts) ? mirror.petInsts : [];
      for (const p of insts) {
        const u = Math.floor(num(p && p.uid));
        if (u > mx) mx = u;
      }
      stmts.initPetSeq.run(mx, userId);
    }
    stmts.bumpPetSeq.run(userId);
    return stmts.getLedger.get(userId).pet_seq;
  }

  // 体力扣点（combat.js deductN 同款口径，事务内复用 staminaSvc core）
  function deductStamina(userId, n, now) {
    const row = staminaSvc.core.rowById(userId);
    if (!row) return { ok: false };
    const cur = computeStamina(row, now);
    if (cur.changed) staminaSvc.core.persist(userId, cur);
    if (cur.v < n) return { ok: false, cur };
    const tsAfter = cur.v >= STAMINA_CAP ? now : cur.ts;
    staminaSvc.core.spendStmt.run(n, tsAfter, cur.day, userId, n);
    const after = cur.v - n;
    return {
      ok: true,
      view: { stamina: after, cap: STAMINA_CAP, nextAt: after >= STAMINA_CAP ? 0 : tsAfter + staminaSvc.core.regenMs },
    };
  }

  // 遭遇的客户端可见面：物种 + 品质 + 首条词条剪影（其余收服成功后才揭示）
  function encPreview(enc) {
    return { sp: enc.sp, r: enc.r, first: (enc.affixes && enc.affixes[0]) || null };
  }

  const featureRealmOf = (mirror) => Math.max(Math.floor(num(mirror.realm)), Math.floor(num(mirror.realmPeak)));

  // POST /api/pet/hunt {zone}：缚灵谷探索。券+体力扣账，遇宠掷遭遇存 pending
  function hunt(req, res, ctx) {
    if (!window.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '操作过于频繁，请稍后再试' }, { 'Retry-After': '5' });
    }
    const zone = PET_ZONES.find((z) => z.id === (ctx.body && ctx.body.zone));
    if (!zone) return sendJSON(res, 400, { error: '未知的捕捉地点' });
    const now = Date.now();
    const today = dayStr(now);
    const saveRow = stmts.getSave.get(ctx.user.id);
    if (!saveRow) return sendJSON(res, 400, { error: '尚未创建云端存档' });
    const mirror = loadMirror(saveRow.data);
    if (featureRealmOf(mirror) < zone.realm) {
      return sendJSON(res, 403, { error: '该捕捉地点尚未解锁' });
    }

    db.exec('BEGIN');
    try {
      const led = ensureLedger(ctx.user.id, mirror, now);
      const h = petHuntOf(led, today);
      // 已有未收服遭遇：原样返回不重掷也不扣费（遭遇已掷定，重看无作弊面；
      // 扣了费反而逼玩家丢遭遇，两阶段防重的关键只在「掷结果不重复」）
      if (h.enc) {
        db.exec('COMMIT');
        return sendJSON(res, 200, {
          ok: true, meet: true, held: true, enc: encPreview(h.enc),
          hunts: h.hunts, pity: h.pity, buys: h.buys, dailyMax: PET_HUNT_DAILY,
          dailyBuyMax: PET_HUNT_BUY_DAILY, stamina: null,
        });
      }
      const spent = deductStamina(ctx.user.id, PET_HUNT_STAMINA, now);
      if (!spent.ok) {
        db.exec('ROLLBACK');
        const row = staminaSvc.core.rowById(ctx.user.id);
        const cur = row ? computeStamina(row, Date.now()) : null;
        return sendJSON(res, 429, {
          error: '体力不足（缚灵谷探索需 ' + PET_HUNT_STAMINA + ' 点，每 5 分钟恢复 1 点）',
          ...(cur ? staminaView(cur) : {}),
        });
      }
      const tOut = stmts.spendTickets.run(PET_HUNT_TICKET, ctx.user.id, PET_HUNT_TICKET);
      if (!tOut.changes) {
        db.exec('ROLLBACK');
        return sendJSON(res, 402, { error: '招募券不足（开箱掉落、签到与任务可得）' });
      }
      if (h.hunts >= PET_HUNT_DAILY + h.buys) {
        db.exec('ROLLBACK');
        // 体力/券在 ROLLBACK 后原样保留；直接拒绝
        return sendJSON(res, 429, { error: '今日缚灵谷探索次数已用完（基础 ' + PET_HUNT_DAILY +
          ' 次 + 已购 ' + h.buys + ' 次），可灵石加购' });
      }
      h.hunts++;
      const forced = h.pity >= PET_MEET_PITY;
      const meet = forced || Math.random() < PET_MEET_RATE;
      let bones = 0;
      if (meet) {
        // 物种按地点池权重；品质在物种带内掷
        let total = 0;
        for (const w of zone.w) total += w;
        let roll = Math.random() * total;
        let spId = zone.pool[zone.pool.length - 1];
        for (let i = 0; i < zone.pool.length; i++) {
          roll -= zone.w[i];
          if (roll <= 0) { spId = zone.pool[i]; break; }
        }
        const spDef = PET_SP_MAP[spId];
        const r = rollBandRarity(spDef, zone.cap);
        const enc = rollPetInst(spId, r, 1);
        enc.at = now;
        h.enc = enc;
        h.pity = 0;
      } else {
        h.pity++;
        bones = 5 + Math.floor(Math.random() * 11); // 5~15 兽骨（不进账本包络，action_log 记 kind 备查）
      }
      stmts.setPetHunt.run(JSON.stringify(h), ctx.user.id);
      stmts.logAction.run(ctx.user.id, today, meet ? 'pet_hunt:meet' : 'pet_hunt:miss', now);
      db.exec('COMMIT');
      return sendJSON(res, 200, {
        ok: true, meet, bones,
        enc: h.enc ? encPreview(h.enc) : null,
        hunts: h.hunts, pity: h.pity, buys: h.buys, dailyMax: PET_HUNT_DAILY,
        dailyBuyMax: PET_HUNT_BUY_DAILY,
        stamina: spent.view,
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // POST /api/pet/capture {policy}：收服 pending 遭遇。镇抚消耗失败不退
  function capture(req, res, ctx) {
    if (!window.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '操作过于频繁，请稍后再试' }, { 'Retry-After': '5' });
    }
    const policyKey = String((ctx.body && ctx.body.policy) || 'bare');
    const policy = PET_POLICY[policyKey];
    if (!policy) return sendJSON(res, 400, { error: '未知的镇抚策略' });
    const now = Date.now();
    const today = dayStr(now);
    const saveRow = stmts.getSave.get(ctx.user.id);
    if (!saveRow) return sendJSON(res, 400, { error: '尚未创建云端存档' });
    const mirror = loadMirror(saveRow.data);

    db.exec('BEGIN');
    try {
      const led = ensureLedger(ctx.user.id, mirror, now);
      const h = petHuntOf(led, today);
      if (!h.enc) {
        db.exec('ROLLBACK');
        return sendJSON(res, 400, { error: '没有待收服的灵宠，先去探索吧' });
      }
      const enc = h.enc;
      // 镇抚消耗：灵石走账本原子扣款；兽骨按存档镜像复核（客户端吸收后扣档）
      let feedStones = 0;
      if (policyKey === 'feed') {
        feedStones = policy.stones(enc.r);
        const out = stmts.spendLedger.run(feedStones, ctx.user.id, feedStones);
        if (!out.changes) {
          db.exec('ROLLBACK');
          return sendJSON(res, 402, { error: '灵石不足（投喂需 ' + feedStones + '）' });
        }
      } else if (policyKey === 'awe') {
        const need = policy.bones(enc.r);
        if (num(mirror.beastBones) < need) {
          db.exec('ROLLBACK');
          return sendJSON(res, 402, { error: '兽骨不足（镇压需 ' + need + '，野外征战可得）' });
        }
      }
      // 持有上限复核（2026-11-02 背包容量化：基础 50，按镜像 petBagLv 扩容至上限 100）
      const insts = Array.isArray(mirror.petInsts) ? mirror.petInsts : [];
      const bagCap = petBagCapOf(mirror);
      if (insts.length >= bagCap) {
        db.exec('ROLLBACK');
        return sendJSON(res, 400, { error: '灵宠背包已满（' + bagCap + ' 只），先放生或合成，扩容后可继续捕捉' });
      }
      const rate = Math.min(PET_CAPTURE_CAP, (PET_CAPTURE_BASE[enc.r] || 0.9) + policy.add);
      const ok = Math.random() < rate;
      // 收服成功即在事务内发真实 uid（2026-11-03 起服务端发号，客户端不再本地重编）
      const pet = ok ? rollPetKeep(enc) : null;
      if (pet) pet.uid = nextPetUid(ctx.user.id, mirror);
      h.enc = null;
      stmts.setPetHunt.run(JSON.stringify(h), ctx.user.id);
      stmts.logAction.run(ctx.user.id, today, 'pet_capture:' + policyKey + (ok ? ':ok' : ':fail'), now);
      db.exec('COMMIT');
      return sendJSON(res, 200, {
        ok: true, captured: ok,
        pet,
        policy: policyKey,
        hunts: h.hunts, pity: h.pity, buys: h.buys, dailyMax: PET_HUNT_DAILY,
        dailyBuyMax: PET_HUNT_BUY_DAILY,
        spent: { stones: feedStones, bones: policyKey === 'awe' ? policy.bones(enc.r) : 0 },
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // 收服成功下发：uid=0 占位、词条在 pending 里已掷定，此处只是拷出
  function rollPetKeep(enc) {
    return {
      uid: 0, sp: enc.sp, r: enc.r, lv: enc.lv || 1,
      affixes: (enc.affixes || []).map((a) => ({ k: a.k, v: a.v })),
    };
  }

  // POST /api/pet/fuse {a,b,c,lockK?}：同物种同品质三合一
  function fuse(req, res, ctx) {
    if (!window.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '操作过于频繁，请稍后再试' }, { 'Retry-After': '5' });
    }
    const uids = ['a', 'b', 'c'].map((k) => Math.floor(num(ctx.body && ctx.body[k])));
    if (uids.some((u) => u < 1) || new Set(uids).size !== 3) {
      return sendJSON(res, 400, { error: '合成材料非法' });
    }
    const lockK = ctx.body && ctx.body.lockK ? String(ctx.body.lockK) : '';
    const now = Date.now();
    const saveRow = stmts.getSave.get(ctx.user.id);
    if (!saveRow) return sendJSON(res, 400, { error: '尚未创建云端存档' });
    const mirror = loadMirror(saveRow.data);
    const insts = Array.isArray(mirror.petInsts) ? mirror.petInsts : [];
    const mats = uids.map((u) => insts.find((p) => p && p.uid === u));
    if (mats.some((m) => !m)) return sendJSON(res, 400, { error: '材料灵宠不存在（请刷新后重试）' });
    const spDef = PET_SP_MAP[mats[0].sp];
    if (!spDef || mats.some((m) => m.sp !== mats[0].sp)) {
      return sendJSON(res, 400, { error: '三只灵宠必须同物种' });
    }
    if (mats.some((m) => m.r !== mats[0].r)) {
      return sendJSON(res, 400, { error: '三只灵宠必须同品质' });
    }
    const r = mats[0].r;
    if (r >= 5 || r + 1 > spDef.band[1]) {
      return sendJSON(res, 400, { error: '该物种已达品质上限，无法再合成' });
    }
    const cost = PET_FUSE_COST(r);
    // 锁灵材料校验：键必须存在于材料词条
    let lockSrc = null;
    if (lockK) {
      for (const m of mats) {
        for (const a of m.affixes || []) {
          if (a.k === lockK && (!lockSrc || a.v > lockSrc.v)) lockSrc = a;
        }
      }
      if (!lockSrc) return sendJSON(res, 400, { error: '材料中没有可继承的「' + lockK + '」词条' });
      if (num(mirror.rerollCoupon) < 1) {
        return sendJSON(res, 402, { error: '洗练券不足（锁灵需 1 张）' });
      }
    }

    db.exec('BEGIN');
    try {
      const led = ensureLedger(ctx.user.id, mirror, now);
      // 材料销账防重放（2026-11-03）：fuse 只扣灵石不删材料（镜像要等客户端推档），
      // 同组材料在不推档窗口内连发可白嫖多只高阶宠——pet_used 记已消耗 uid，重放 400。
      // 只约束服务端动作本身、不入推送校验（未吸收窗口推旧镜像不误伤，见 db.js 注）
      const used = jsonMapOf(led.pet_used);
      if (uids.some((u) => used[u])) {
        db.exec('ROLLBACK');
        return sendJSON(res, 400, { error: '材料灵宠已被消耗（请刷新后重试）' });
      }
      const out = stmts.spendLedger.run(cost, ctx.user.id, cost);
      if (!out.changes) {
        db.exec('ROLLBACK');
        return sendJSON(res, 402, { error: '灵石不足（合成需 ' + cost + '）' });
      }
      for (const u of uids) used[u] = 1;
      // 顺手清材料个体的洗髓计数（防 JSON 只增不减；高计数条目被复用伪造只会更贵）
      const rmap = jsonMapOf(led.pet_rerolls);
      for (const u of uids) delete rmap[u];
      stmts.setPetRerolls.run(JSON.stringify(pruneMap(rmap)), ctx.user.id);
      stmts.setPetUsed.run(JSON.stringify(pruneMap(used)), ctx.user.id);
      stmts.logAction.run(ctx.user.id, dayStr(now), 'pet_fuse', now);
      // 新个体事务内发真实 uid（客户端不再本地重编）
      const pet = rollPetInst(spDef.id, r + 1, Math.max(mats[0].lv, mats[1].lv, mats[2].lv));
      pet.uid = nextPetUid(ctx.user.id, mirror);
      if (lockSrc) {
        pet.affixes = [{ k: lockSrc.k, v: Math.min(0.6, lockSrc.v) }].concat(
          rollAffixesInto((AFFIX_COUNT[pet.r] || 0) - 1, [lockSrc.k], pet.r));
      }
      db.exec('COMMIT');
      return sendJSON(res, 200, {
        ok: true, pet, cost,
        spent: { stones: cost, coupon: lockK ? 1 : 0 },
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // POST /api/pet/reroll {uid, locks:[k...]}：洗髓。锁定词条保留，其余重随机
  function reroll(req, res, ctx) {
    if (!window.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '操作过于频繁，请稍后再试' }, { 'Retry-After': '5' });
    }
    const uid = Math.floor(num(ctx.body && ctx.body.uid));
    const lockReq = Array.isArray(ctx.body && ctx.body.locks)
      ? ctx.body.locks.map((k) => String(k)).slice(0, 6) : [];
    const now = Date.now();
    const saveRow = stmts.getSave.get(ctx.user.id);
    if (!saveRow) return sendJSON(res, 400, { error: '尚未创建云端存档' });
    const mirror = loadMirror(saveRow.data);
    const insts = Array.isArray(mirror.petInsts) ? mirror.petInsts : [];
    const inst = insts.find((p) => p && p.uid === uid);
    if (!inst) return sendJSON(res, 400, { error: '灵宠不存在（请刷新后重试）' });
    const count = AFFIX_COUNT[inst.r] || 0;
    if (!count) return sendJSON(res, 400, { error: '凡 / 灵 / 玄品灵宠没有词条可洗' });
    const lockSet = new Set(lockReq);
    const curAff = inst.affixes || [];
    if (lockReq.some((k) => !curAff.some((a) => a.k === k))) {
      return sendJSON(res, 400, { error: '锁定词条与该灵宠不符' });
    }
    if (curAff.length - lockSet.size < 1) {
      return sendJSON(res, 400, { error: '至少保留 1 条可洗词条' });
    }

    db.exec('BEGIN');
    try {
      const led = ensureLedger(ctx.user.id, mirror, now);
      // 洗髓次数以服务端 pet_rerolls 计数为准（2026-11-03）：原取镜像 inst.rerolls，
      // 改档恒推 0 可让 ×1.3 复利永不生效；费用封顶 1e15（times 合法上界 1e6 时
      // 1.3^times=Infinity 会让原子扣款抛错的十六进制兜底）
      const rmap = jsonMapOf(led.pet_rerolls);
      const times = Math.max(0, Math.floor(num(rmap[uid])));
      const cost = Math.min(1e15, PET_REROLL_STONES(inst.r, times, lockSet.size));
      const dust = Math.round(PET_REROLL_DUST(inst.r, lockSet.size));
      const out = stmts.spendLedger.run(cost, ctx.user.id, cost);
      if (!out.changes) {
        db.exec('ROLLBACK');
        return sendJSON(res, 402, { error: '灵石不足（洗髓需 ' + cost + '）' });
      }
      if (num(mirror.dust) < dust) {
        db.exec('ROLLBACK');
        return sendJSON(res, 402, { error: '碎屑不足（洗髓需 ' + dust + '）' });
      }
      rmap[uid] = times + 1;
      stmts.setPetRerolls.run(JSON.stringify(pruneMap(rmap)), ctx.user.id);
      stmts.logAction.run(ctx.user.id, dayStr(now), 'pet_reroll', now);
      // 洗髓结果以响应下发，客户端把 rerolls/affixes 写回存档（镜像rerolls自此只是展示镜像，
      // 计费真相在账本 pet_rerolls；伪造面被 validateDeep 结构钳制 + 灵石原子扣款兜住）
      const next = {
        uid: inst.uid, sp: inst.sp, r: inst.r, lv: inst.lv,
        affixes: curAff.filter((a) => lockSet.has(a.k)).map((a) => ({ k: a.k, v: a.v, lock: true })),
        rerolls: times + 1,
      };
      next.affixes = next.affixes.concat(
        rollAffixesInto(count - next.affixes.length, next.affixes.map((a) => a.k), inst.r));
      db.exec('COMMIT');
      return sendJSON(res, 200, { ok: true, pet: next, spent: { stones: cost, dust } });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // GET /api/pet/pending：只读 pending 遭遇与今日计数（打开界面时对账，不扣费不重掷）
  function pending(req, res, ctx) {
    const led = stmts.getLedger.get(ctx.user.id);
    if (!led) {
      return sendJSON(res, 200, { ok: true, enc: null, hunts: 0, pity: 0, buys: 0,
        dailyMax: PET_HUNT_DAILY, dailyBuyMax: PET_HUNT_BUY_DAILY });
    }
    const h = petHuntOf(led, dayStr(Date.now()));
    return sendJSON(res, 200, {
      ok: true, enc: h.enc ? encPreview(h.enc) : null,
      hunts: h.hunts, pity: h.pity, buys: h.buys, dailyMax: PET_HUNT_DAILY,
      dailyBuyMax: PET_HUNT_BUY_DAILY,
    });
  }

  // POST /api/pet/huntbuy：灵石加购探索次数（2026-11-03 用户指定）。
  // 20 万灵石 +1 次，每日最多 50 次；账本原子扣款（spendLedger 余额护栏口径），
  // buys 计入 pet_hunt 当日对象（跨日随 petHuntOf 归零），重放无面
  function huntbuy(req, res, ctx) {
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
      const led = ensureLedger(ctx.user.id, mirror, now);
      const h = petHuntOf(led, today);
      if (h.buys >= PET_HUNT_BUY_DAILY) {
        db.exec('ROLLBACK');
        return sendJSON(res, 429, { error: '今日加购次数已用完（' + PET_HUNT_BUY_DAILY + ' 次/日）' });
      }
      const out = stmts.spendLedger.run(PET_HUNT_BUY_COST, ctx.user.id, PET_HUNT_BUY_COST);
      if (!out.changes) {
        db.exec('ROLLBACK');
        return sendJSON(res, 402, { error: '灵石不足（加购 1 次需 ' + PET_HUNT_BUY_COST + '）' });
      }
      h.buys++;
      stmts.setPetHunt.run(JSON.stringify(h), ctx.user.id);
      stmts.logAction.run(ctx.user.id, today, 'pet_hunt_buy', now);
      db.exec('COMMIT');
      return sendJSON(res, 200, {
        ok: true, stones: PET_HUNT_BUY_COST,
        hunts: h.hunts, pity: h.pity, buys: h.buys,
        dailyMax: PET_HUNT_DAILY, dailyBuyMax: PET_HUNT_BUY_DAILY,
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // 模式 B 前缀分发（social.handle 同款）：index.js 已完成鉴权与 body 解析。
  // 命中即回 true（sendJSON 返回 falsy，index.js 以返回值判断是否已响应，防双重 send）
  function handle(req, res, ctx) {
    const p = ctx.pathname.replace(/^\/api\/pet\//, '');
    if (ctx.method === 'POST' && p === 'hunt') { hunt(req, res, ctx); return true; }
    if (ctx.method === 'POST' && p === 'capture') { capture(req, res, ctx); return true; }
    if (ctx.method === 'POST' && p === 'fuse') { fuse(req, res, ctx); return true; }
    if (ctx.method === 'POST' && p === 'reroll') { reroll(req, res, ctx); return true; }
    if (ctx.method === 'POST' && p === 'huntbuy') { huntbuy(req, res, ctx); return true; }
    if (ctx.method === 'GET' && p === 'pending') { pending(req, res, ctx); return true; }
    return false;
  }

  return { handle, hunt, capture, fuse, reroll, pending, huntbuy };
}
