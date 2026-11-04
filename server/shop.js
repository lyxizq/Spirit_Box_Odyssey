// 云来坊市（2026-11-02 模拟经营 P1，全量服务端权威）：商业建筑（丹房/器坊/符箓铺）
// + 订单/直售。建筑等级、原料仓库、成品库存、订单全存在 shop_state 表（JSON 快照），
// 客户端只做渲染；灵石收支一律走 save_ledger：支出原子扣款（spendLedger 口径），
// 收入加主列 + action_log 授权流水（saves.js sanctionedSince 自动计入增速包络）。
//
// 原料入账的防伪根基是服务端墙钟：牧场/灵圃的每笔入账要求时间戳 ≤ now 且严格大于
// 该格/该节点的上次入账值——伪造时间戳最多把收益抬到「真实挂机」的速率上限
//（每格每种子周期一笔）。灵圃节点等级从存档镜像读（2026-11-03，防请求体恒报满级
// ×7 放大原料流）；种子收获量按种子档位查表。库存→成品→灵石
// 的每一环都受上一环的物理速率钳制，经济自限（建筑升级烧账本灵石封住收益天花板）。
import { sendJSON, SlidingWindow } from './http-util.js';

// —— 商业建筑：cost=解锁（1 级）花费，growth=升级指数，max=等级上限，repNeed=商誉门槛 ——
const BUILDINGS = {
  dan: { name: '丹房', icon: '丹', cost: 2e4, growth: 1.55, max: 50, repNeed: 0 },
  qi:  { name: '器坊', icon: '器', cost: 8e4, growth: 1.55, max: 50, repNeed: 500 },
  fu:  { name: '符箓铺', icon: '符', cost: 3e5, growth: 1.55, max: 50, repNeed: 3000 },
};
// 制作位：1/13/25/37/49 级 → 1~5 席；售价/商誉随建筑等级成长（50 级 ×3.45）
const SLOTS_AT_LV = (lv) => 1 + Math.floor(Math.max(0, lv - 1) / 12);
const lvMult = (lv) => 1 + 0.05 * (Math.max(1, lv) - 1);
const upCostOf = (key, lv) => Math.floor(BUILDINGS[key].cost * Math.pow(BUILDINGS[key].growth, lv));

// —— 配方：req=建筑等级门槛，fee=制作手续费（灵石），sell=直售基准价，rep=交单商誉 ——
// 订单价 = sell × qty × 1.8（溢价），制作时长对齐灵田节奏（30 分钟 ~ 16 小时）
// desc：成品说明（2026-11-02 用户要求补提示）——成品是坊市商品，用途为直售/交订单变现
const RECIPES = {
  dan: [
    { id: 'huiqi',    name: '回气丹', req: 1,  ms: 30 * 60000,    fee: 500,  sell: 3e3,   rep: 3,  mats: { cao: 3 } },
    { id: 'ningshen', name: '凝神丹', req: 12, ms: 2 * 3600000,   fee: 3000, sell: 1.8e4, rep: 8,  mats: { hua: 2, guo: 1 } },
    { id: 'pojing',   name: '破境丹', req: 30, ms: 8 * 3600000,   fee: 2e4,  sell: 1.2e5, rep: 25, mats: { sui: 1, hua: 2 } },
  ],
  qi: [
    { id: 'tiejian',  name: '精铁剑', req: 1,  ms: 45 * 60000,    fee: 800,  sell: 6e3,   rep: 4,  mats: { ore: 4 } },
    { id: 'huxin',    name: '护心镜', req: 12, ms: 3 * 3600000,   fee: 6000, sell: 4e4,   rep: 10, mats: { ore: 8, herb: 2 } },
    { id: 'juling',   name: '聚灵盘', req: 30, ms: 12 * 3600000,  fee: 4e4,  sell: 2.6e5, rep: 30, mats: { ore: 20, herb: 4 } },
  ],
  fu: [
    { id: 'lingfu',   name: '灵符',   req: 1,  ms: 1 * 3600000,   fee: 1000, sell: 8e3,   rep: 5,  mats: { hua: 3 } },
    { id: 'hushen',   name: '护身符', req: 12, ms: 4 * 3600000,   fee: 8000, sell: 6e4,   rep: 12, mats: { guo: 2, herb: 2 } },
    { id: 'dukong',   name: '遁空符', req: 30, ms: 16 * 3600000,  fee: 5e4,  sell: 4e5,   rep: 35, mats: { lian: 1, sui: 3 } },
  ],
};
// 成品风味说明（随 catalog 下发，配方/库存/订单行悬停展示）
const RECIPE_DESC = {
  huiqi:   '行气养血的入门丹药，价廉走量，坊客常备，是丹房的开张货。',
  ningshen:'凝神静气、辅助入定的中阶丹药，宗门采购单上的大宗货。',
  pojing:  '冲击境界时护住心脉的珍丹，一丹难求，售价不菲。',
  tiejian: '制式精铁长剑，锋锐耐用，散修入门首选，走货稳定。',
  huxin:   '錾刻灵纹的护心宝镜，护住心口要害，保命的硬货。',
  juling:  '汇聚天地灵气的阵盘，摆进洞府便是排面，豪门抢着要。',
  lingfu:  '一笔成符的基础灵符，符箓铺的立身之本，量大管饱。',
  hushen:  '贴身佩戴的护身符箓，可挡一次灾煞，信众众多。',
  dukong:  '危急时遁出千里的保命符，贵有贵的道理。',
};
// 配方id → 建筑索引（直售定位用；id 全局唯一）
const RECIPE_OF = {};
for (const b of Object.keys(RECIPES)) for (const r of RECIPES[b]) RECIPE_OF[r.id] = { b, r };

// —— 原料：牧场七种种子 + 灵圃矿石/灵药（与 game.js FARM_SEEDS/GATHER_NODES 同名同源）——
const MATS = {
  cao: '灵草', hua: '灵花', guo: '灵果', sui: '髓芝', lian: '灵莲', tong: '梧桐木', xing: '星髓',
  ore: '矿石', herb: '灵药',
};
// 牧场收获入账原料件数（按种子档位，game.js FARM_SEEDS 的 id 即这里的键）
const FARM_YIELD = { cao: 1, hua: 1, guo: 2, sui: 2, lian: 3, tong: 3, xing: 4 };
const FARM_CELLS = 144;
// 各种子/节点生长时长（game.js FARM_SEEDS/GATHER_NODES 的 ms 同源；种子上限 8 小时，2026-11-02 用户指定）：
// deposit 的最小入账间隔 = 本次入账种子的生长时长（复审加固：只有「递增」校验时，
// 同格可用递增历史时间戳以限速上限连刷入账，不满足每格每周期一笔的不变量）
const FARM_SEED_MS = {
  cao: 30 * 60000, hua: 1 * 3600000, guo: 2 * 3600000, sui: 3 * 3600000,
  lian: 5 * 3600000, tong: 6 * 3600000, xing: 8 * 3600000,
};
// 灵圃采集入账 = base × (1+0.1×lv)（game.js gatherYield 同口径，lv 钳 0..60）
const GATHER_BASE = { ore: 6, herb: 4 };
const GATHER_MS = { ore: 30 * 60000, herb: 45 * 60000 };
const GATHER_MAX_LV = 60;

// —— 订单：每 30 分钟一槽，槽内 3 单，按（用户×槽）确定性生成（无随机结算面）——
const ORDER_SLOT_MS = 30 * 60000;
const ORDER_COUNT = 3;
const ORDER_PREMIUM = 1.8;

// 解锁门槛：境界第二境「金丹」（故事卷三·坊市风云，game.js FEATURE_GATES 口径）
const REALM_GATE = 2;

const dayStr = (now = Date.now()) => {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function loadState(text) {
  let s = {};
  try { s = JSON.parse(text || '{}'); } catch (e) { s = {}; }
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
  return {
    lv: (s.lv && typeof s.lv === 'object' && !Array.isArray(s.lv)) ? s.lv : {},
    inv: (s.inv && typeof s.inv === 'object' && !Array.isArray(s.inv)) ? s.inv : {},
    mats: (s.mats && typeof s.mats === 'object' && !Array.isArray(s.mats)) ? s.mats : {},
    crafts: Array.isArray(s.crafts) ? s.crafts : [],
    rep: Math.max(0, Math.floor(num(s.rep))),
    lastFarm: (s.lastFarm && typeof s.lastFarm === 'object' && !Array.isArray(s.lastFarm)) ? s.lastFarm : {},
    lastGather: (s.lastGather && typeof s.lastGather === 'object' && !Array.isArray(s.lastGather)) ? s.lastGather : {},
    oSlot: Math.floor(num(s.oSlot)),
    oDone: Array.isArray(s.oDone) ? s.oDone.map((n) => Math.floor(num(n))).slice(0, ORDER_COUNT) : [],
  };
}

function clampInt(v, lo, hi) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

// mulberry32：订单确定性随机器（同 用户×槽 恒同序列）
function rngOf(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 渲染目录（随 view 下发；客户端不复制数值表，防两端口径漂移）
const CATALOG = {
  buildings: Object.fromEntries(Object.entries(BUILDINGS).map(([k, v]) => [k, {
    name: v.name, icon: v.icon, cost: v.cost, growth: v.growth, max: v.max, repNeed: v.repNeed,
  }])),
  recipes: Object.fromEntries(Object.entries(RECIPES).flatMap(([b, list]) => list.map((r) => [r.id, {
    id: r.id, b, name: r.name, req: r.req, ms: r.ms, fee: r.fee, sell: r.sell, rep: r.rep, mats: r.mats,
    desc: RECIPE_DESC[r.id] || '',
  }]))),
  mats: MATS,
};

export function createShopService(db) {
  const window = new SlidingWindow(60 * 1000, 300); // 收获入账可批量（144 格连点），放宽
  const mutWindow = new SlidingWindow(60 * 1000, 120); // 建筑制作/收支类写操作限速（防刷库）
  const windWindow = new SlidingWindow(3600 * 1000, 4); // 奇遇原料入账：4 次/小时（云游 ~10 次/小时节奏的钳制）
  const stmts = {
    getShop: db.prepare('SELECT state FROM shop_state WHERE user_id = ?'),
    putShop: db.prepare(
      `INSERT INTO shop_state (user_id, state, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`),
    getSave: db.prepare('SELECT data FROM game_saves WHERE user_id = ?'),
    getLedger: db.prepare('SELECT user_id FROM save_ledger WHERE user_id = ?'),
    // 支出：严格足额原子扣（social.js spendLedger 口径，堵推送滞后窗口重复消费）
    spendStones: db.prepare('UPDATE save_ledger SET stones = stones - ? WHERE user_id = ? AND stones >= ?'),
    // 收入：主列 + 累计同步加（客户端吸收响应后推档，cli_sync 对齐——combat.js 同款）
    addStones: db.prepare('UPDATE save_ledger SET stones = stones + ?, total_stones = total_stones + ? WHERE user_id = ?'),
    logAction: db.prepare(
      'INSERT INTO action_log (user_id, day, kind, stones, dust, tickets, exp, created_at) VALUES (?, ?, ?, ?, 0, 0, 0, ?)'),
  };

  function realmOf(userId) {
    const row = stmts.getSave.get(userId);
    if (!row) return -1;
    try {
      const d = JSON.parse(row.data);
      return Math.max(Math.floor(num(d && d.realm)), Math.floor(num(d && d.realmPeak)));
    } catch (e) { return -1; }
  }

  function gates(st) {
    const g = {};
    for (const key of Object.keys(BUILDINGS)) {
      g[key] = clampInt(st.lv[key], 0, BUILDINGS[key].max);
    }
    return g;
  }

  function slotsOf(lv) { return SLOTS_AT_LV(lv); }

  // 当前槽的 3 张订单（按 用户×槽×当时建筑等级 确定性生成；跨槽自动清已交付）
  function ordersOf(userId, st, now) {
    const slot = Math.floor(now / ORDER_SLOT_MS);
    if (st.oSlot !== slot) { st.oSlot = slot; st.oDone = []; }
    const lv = gates(st);
    const pool = [];
    for (const b of Object.keys(RECIPES)) {
      if (!lv[b]) continue;
      for (const r of RECIPES[b]) if (lv[b] >= r.req) pool.push({ b, r });
    }
    if (!pool.length) return { slot, orders: [] };
    const rand = rngOf((Math.floor(num(userId)) * 2654435761) ^ slot);
    const orders = [];
    for (let i = 0; i < ORDER_COUNT; i++) {
      const pick = pool[Math.floor(rand() * pool.length)] || pool[0];
      const qty = 1 + Math.floor(rand() * 3);
      const mult = lvMult(lv[pick.b]);
      orders.push({
        b: pick.b, id: pick.r.id, qty,
        stones: Math.floor(pick.r.sell * qty * ORDER_PREMIUM * mult),
        rep: Math.max(1, Math.round(pick.r.rep * mult)),
      });
    }
    return { slot, orders };
  }

  function viewOf(userId, st, now) {
    const { slot, orders } = ordersOf(userId, st, now);
    const crafts = st.crafts
      .map((c) => ({ b: String(c.b || ''), id: String(c.id || ''), doneAt: Math.floor(num(c.doneAt)) }))
      .filter((c) => RECIPE_OF[c.id] && RECIPE_OF[c.id].b === c.b)
      .sort((x, y) => x.doneAt - y.doneAt);
    const inv = {};
    for (const id of Object.keys(RECIPE_OF)) inv[id] = clampInt(st.inv[id], 0, 999);
    const mats = {};
    for (const k of Object.keys(MATS)) mats[k] = clampInt(st.mats[k], 0, 1e6);
    return {
      lv: gates(st), inv, mats, crafts, rep: st.rep,
      orders, orderSlot: slot, nextSlotAt: (slot + 1) * ORDER_SLOT_MS,
      nextSlotIn: Math.max(0, (slot + 1) * ORDER_SLOT_MS - now),
      done: st.oDone.slice(),
      catalog: CATALOG,
    };
  }

  // GET /api/shop：坊市总览（未解锁也返回，客户端按 locked 渲染引导）
  function get(req, res, ctx) {
    const realm = realmOf(ctx.user.id);
    if (realm < REALM_GATE) {
      return sendJSON(res, 200, { ok: true, locked: true, realmGate: REALM_GATE });
    }
    const row = stmts.getShop.get(ctx.user.id);
    const st = loadState(row ? row.state : '');
    return sendJSON(res, 200, { ok: true, locked: false, realmGate: REALM_GATE, view: viewOf(ctx.user.id, st, Date.now()) });
  }

  // POST /api/shop/build {b}：解锁（lv0→1）或升级（lv→lv+1）。灵石走账本原子扣。
  function build(req, res, ctx) {
    if (!mutWindow.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '操作过于频繁，请稍后再试' }, { 'Retry-After': '5' });
    }
    const key = String((ctx.body && ctx.body.b) || '');
    const def = BUILDINGS[key];
    if (!def) return sendJSON(res, 400, { error: '未知建筑' });
    if (realmOf(ctx.user.id) < REALM_GATE) return sendJSON(res, 403, { error: '坊市随卷三「坊市风云」解锁（境界金丹）' });
    const now = Date.now();
    db.exec('BEGIN');
    try {
      const row = stmts.getShop.get(ctx.user.id);
      const st = loadState(row ? row.state : '');
      const lv = clampInt(st.lv[key], 0, def.max);
      if (lv >= def.max) { db.exec('ROLLBACK'); return sendJSON(res, 400, { error: def.name + '已满级' }); }
      if (st.rep < def.repNeed) { db.exec('ROLLBACK'); return sendJSON(res, 403, { error: '商誉不足（需 ' + def.repNeed + '）' }); }
      const cost = upCostOf(key, lv);
      if (!stmts.spendStones.run(cost, ctx.user.id, cost).changes) {
        db.exec('ROLLBACK');
        return sendJSON(res, 400, { error: '灵石不足（需 ' + cost + '）' });
      }
      st.lv[key] = lv + 1;
      stmts.putShop.run(ctx.user.id, JSON.stringify(st), now);
      db.exec('COMMIT');
      return sendJSON(res, 200, { ok: true, cost, lv: st.lv[key], view: viewOf(ctx.user.id, st, now) });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // POST /api/shop/craft {b, id}：开一炉（占用一个制作位；扣原料 + 手续费）
  function craft(req, res, ctx) {
    if (!mutWindow.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '操作过于频繁，请稍后再试' }, { 'Retry-After': '5' });
    }
    const key = String((ctx.body && ctx.body.b) || '');
    const id = String((ctx.body && ctx.body.id) || '');
    const rec = RECIPE_OF[id];
    if (!rec || rec.b !== key || !BUILDINGS[key]) return sendJSON(res, 400, { error: '未知配方' });
    if (realmOf(ctx.user.id) < REALM_GATE) return sendJSON(res, 403, { error: '坊市尚未解锁' });
    const now = Date.now();
    db.exec('BEGIN');
    try {
      const row = stmts.getShop.get(ctx.user.id);
      const st = loadState(row ? row.state : '');
      const lv = clampInt(st.lv[key], 0, BUILDINGS[key].max);
      if (lv < rec.r.req) { db.exec('ROLLBACK'); return sendJSON(res, 403, { error: rec.r.name + '需' + BUILDINGS[key].name + ' Lv.' + rec.r.req }); }
      const busy = st.crafts.filter((c) => c.b === key).length;
      if (busy >= slotsOf(lv)) { db.exec('ROLLBACK'); return sendJSON(res, 429, { error: '制作位已满（升建筑解锁更多席位）' }); }
      for (const m of Object.keys(rec.r.mats)) {
        if (clampInt(st.mats[m], 0, 1e6) < rec.r.mats[m]) {
          db.exec('ROLLBACK');
          return sendJSON(res, 400, { error: '原料不足：' + MATS[m] + ' ×' + rec.r.mats[m] });
        }
      }
      if (!stmts.spendStones.run(rec.r.fee, ctx.user.id, rec.r.fee).changes) {
        db.exec('ROLLBACK');
        return sendJSON(res, 400, { error: '灵石不足（手续费 ' + rec.r.fee + '）' });
      }
      for (const m of Object.keys(rec.r.mats)) st.mats[m] -= rec.r.mats[m];
      st.crafts.push({ b: key, id, doneAt: now + rec.r.ms });
      stmts.putShop.run(ctx.user.id, JSON.stringify(st), now);
      db.exec('COMMIT');
      return sendJSON(res, 200, { ok: true, fee: rec.r.fee, view: viewOf(ctx.user.id, st, now) });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // POST /api/shop/collect {b}：收取该建筑已完成的炉次 → 成品入库存（离线炉照常完成）
  function collect(req, res, ctx) {
    if (!mutWindow.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '操作过于频繁，请稍后再试' }, { 'Retry-After': '5' });
    }
    const key = String((ctx.body && ctx.body.b) || '');
    if (!BUILDINGS[key]) return sendJSON(res, 400, { error: '未知建筑' });
    if (realmOf(ctx.user.id) < REALM_GATE) return sendJSON(res, 403, { error: '坊市尚未解锁' });
    const now = Date.now();
    db.exec('BEGIN');
    try {
      const row = stmts.getShop.get(ctx.user.id);
      const st = loadState(row ? row.state : '');
      const done = st.crafts.filter((c) => c.b === key && num(c.doneAt) <= now);
      if (!done.length) { db.exec('ROLLBACK'); return sendJSON(res, 400, { error: '还没有出炉的成品' }); }
      const got = {};
      st.crafts = st.crafts.filter((c) => !(c.b === key && num(c.doneAt) <= now));
      for (const c of done) {
        const rec = RECIPE_OF[String(c.id)];
        if (!rec || rec.b !== key) continue;
        const n = clampInt(st.inv[c.id], 0, 999);
        if (n >= 999) continue; // 库存满：炉次丢弃（上限处已防积压，此处只兜底）
        st.inv[c.id] = n + 1;
        got[c.id] = (got[c.id] || 0) + 1;
      }
      stmts.putShop.run(ctx.user.id, JSON.stringify(st), now);
      db.exec('COMMIT');
      return sendJSON(res, 200, { ok: true, got, view: viewOf(ctx.user.id, st, now) });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // POST /api/shop/sell {id, n}：直售成品（基准价，无商誉）。收入走授权流水。
  function sell(req, res, ctx) {
    if (!mutWindow.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '操作过于频繁，请稍后再试' }, { 'Retry-After': '5' });
    }
    const id = String((ctx.body && ctx.body.id) || '');
    const rec = RECIPE_OF[id];
    if (!rec) return sendJSON(res, 400, { error: '未知成品' });
    const n = clampInt(ctx.body && ctx.body.n, 1, 999);
    if (realmOf(ctx.user.id) < REALM_GATE) return sendJSON(res, 403, { error: '坊市尚未解锁' });
    const now = Date.now();
    const today = dayStr(now);
    db.exec('BEGIN');
    try {
      if (!stmts.getLedger.get(ctx.user.id)) {
        db.exec('ROLLBACK');
        return sendJSON(res, 409, { error: '云端存档尚未同步，稍后再试' });
      }
      const row = stmts.getShop.get(ctx.user.id);
      const st = loadState(row ? row.state : '');
      const have = clampInt(st.inv[id], 0, 999);
      const take = Math.min(n, have);
      if (take <= 0) { db.exec('ROLLBACK'); return sendJSON(res, 400, { error: '库存不足' }); }
      const lv = clampInt(st.lv[rec.b], 0, BUILDINGS[rec.b].max);
      const gain = Math.floor(rec.r.sell * lvMult(lv)) * take;
      st.inv[id] = have - take;
      stmts.addStones.run(gain, gain, ctx.user.id);
      stmts.logAction.run(ctx.user.id, today, 'shop_sell', gain, now);
      stmts.putShop.run(ctx.user.id, JSON.stringify(st), now);
      db.exec('COMMIT');
      return sendJSON(res, 200, { ok: true, stones: gain, view: viewOf(ctx.user.id, st, now) });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // POST /api/shop/order {idx, slot}：交单（0..2，当槽一次性）。扣库存，发灵石 + 商誉。
  // slot 比对（2026-11-03）：订单按 30 分钟槽确定性生成，客户端旧列表在槽翻转后点交付
  // 会按新槽订单取 idx——静默交错货或误报库存不足；slot 不符 409 带新 view 让客户端刷新
  function order(req, res, ctx) {
    if (!mutWindow.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '操作过于频繁，请稍后再试' }, { 'Retry-After': '5' });
    }
    if (realmOf(ctx.user.id) < REALM_GATE) return sendJSON(res, 403, { error: '坊市尚未解锁' });
    const now = Date.now();
    const today = dayStr(now);
    db.exec('BEGIN');
    try {
      if (!stmts.getLedger.get(ctx.user.id)) {
        db.exec('ROLLBACK');
        return sendJSON(res, 409, { error: '云端存档尚未同步，稍后再试' });
      }
      const row = stmts.getShop.get(ctx.user.id);
      const st = loadState(row ? row.state : '');
      const { slot, orders } = ordersOf(ctx.user.id, st, now);
      const idx = clampInt(ctx.body && ctx.body.idx, 0, ORDER_COUNT - 1);
      const wantSlot = Math.floor(num(ctx.body && ctx.body.slot));
      if (wantSlot && wantSlot !== slot) {
        db.exec('ROLLBACK');
        return sendJSON(res, 409, { error: '订单已刷新，请重新查看', view: viewOf(ctx.user.id, st, now) });
      }
      if (st.oDone.includes(idx)) { db.exec('ROLLBACK'); return sendJSON(res, 429, { error: '该订单已交付' }); }
      const o = orders[idx];
      if (!o) { db.exec('ROLLBACK'); return sendJSON(res, 400, { error: '暂无订单（先开一座建筑）' }); }
      const have = clampInt(st.inv[o.id], 0, 999);
      if (have < o.qty) { db.exec('ROLLBACK'); return sendJSON(res, 400, { error: '库存不足：成品 ×' + o.qty }); }
      st.inv[o.id] = have - o.qty;
      st.rep += o.rep;
      st.oDone.push(idx);
      stmts.addStones.run(o.stones, o.stones, ctx.user.id);
      stmts.logAction.run(ctx.user.id, today, 'shop_order', o.stones, now);
      stmts.putShop.run(ctx.user.id, JSON.stringify(st), now);
      db.exec('COMMIT');
      return sendJSON(res, 200, { ok: true, stones: o.stones, rep: st.rep, view: viewOf(ctx.user.id, st, now) });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // POST /api/shop/deposit：牧场/灵圃收获的原料入账。
  // farm:  {kind:'farm', cell, seed, ts=doneAt}   —— ts ≤ now 且距上次入账 ≥ 该种子生长时长
  // gather:{kind:'gather', key, ts=until, lv}     —— 同上（间隔 ≥ 节点周期），产出按 gatherYield
  // 墙钟校验（≤now + 最小间隔）保证稳态入账速率 = 每格每周期一笔；从历史时间戳向上爬的
  // 伪造面只剩「一次性的离线补账式回填」，且受 300/分钟限速与原料→成品→灵石的席位链钳制。
  function deposit(req, res, ctx) {
    if (!window.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '操作过于频繁，请稍后再试' }, { 'Retry-After': '5' });
    }
    const kind = String((ctx.body && ctx.body.kind) || '');
    const ts = Math.floor(num(ctx.body && ctx.body.ts));
    const now = Date.now();
    if (!ts || ts > now) return sendJSON(res, 400, { error: '入账时间戳非法' });
    db.exec('BEGIN');
    try {
      const row = stmts.getShop.get(ctx.user.id);
      const st = loadState(row ? row.state : '');
      let got = {};
      if (kind === 'farm') {
        const cell = clampInt(ctx.body && ctx.body.cell, 0, FARM_CELLS - 1);
        const seed = String((ctx.body && ctx.body.seed) || '');
        const yld = FARM_YIELD[seed];
        if (!yld) { db.exec('ROLLBACK'); return sendJSON(res, 400, { error: '未知种子' }); }
        // 最小间隔按「本次入账的种子」生长时长计：合法流里两茬之间必然隔满一茬生长
        //（可能上茬是别的种子、耗时不同，取本次种子时长的下界永不误拒）
        if (ts - Math.floor(num(st.lastFarm[cell])) < FARM_SEED_MS[seed]) {
          db.exec('ROLLBACK');
          return sendJSON(res, 200, { ok: true, got: {} }); // 重放/间隔不足：静默幂等
        }
        st.lastFarm[cell] = ts;
        got[seed] = yld;
      } else if (kind === 'gather') {
        const key = String((ctx.body && ctx.body.key) || '');
        const base = GATHER_BASE[key];
        if (!base) { db.exec('ROLLBACK'); return sendJSON(res, 400, { error: '未知节点' }); }
        if (ts - Math.floor(num(st.lastGather[key])) < GATHER_MS[key]) {
          db.exec('ROLLBACK');
          return sendJSON(res, 200, { ok: true, got: {} });
        }
        st.lastGather[key] = ts;
        // lv 从存档镜像读（2026-11-03 伪面收窄）：原采信请求体 lv，恒报 60 可把原料流
        // 放大 ×7（镜像 gather.nodes[key].lv 已被 validateDeep 钳 0..60）
        let lv = 0;
        try {
          const sv = JSON.parse(stmts.getSave.get(ctx.user.id).data);
          lv = clampInt(sv && sv.gather && sv.gather.nodes && sv.gather.nodes[key] &&
            sv.gather.nodes[key].lv, 0, GATHER_MAX_LV);
        } catch (e) { lv = 0; }
        got[key] = Math.round(base * (1 + 0.1 * lv));
      } else {
        db.exec('ROLLBACK');
        return sendJSON(res, 400, { error: '未知入账类型' });
      }
      for (const k of Object.keys(got)) st.mats[k] = clampInt(st.mats[k], 0, 1e6) + got[k];
      stmts.putShop.run(ctx.user.id, JSON.stringify(st), now);
      db.exec('COMMIT');
      return sendJSON(res, 200, { ok: true, got });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // POST /api/shop/windfall {mats:{id:n}}：云游奇遇的原料入账（2026-11-04）。
  // 与 deposit 不同源：奇遇无墙钟语义，改用「钳量 + 严限速」——单键 ≤10、单次总 ≤20、
  // 4 次/小时（理论上限 80/小时，相对牧场 144 格的真实产量是小额）；键白名单 = MATS
  function windfall(req, res, ctx) {
    if (realmOf(ctx.user.id) < REALM_GATE) return sendJSON(res, 403, { error: '坊市尚未解锁' });
    const inMats = ctx.body && ctx.body.mats && typeof ctx.body.mats === 'object' && !Array.isArray(ctx.body.mats)
      ? ctx.body.mats : null;
    if (!inMats) return sendJSON(res, 400, { error: '参数无效' });
    const got = {};
    let total = 0;
    for (const k of Object.keys(inMats)) {
      if (!MATS[k]) return sendJSON(res, 400, { error: '未知原料：' + k });
      const n = Math.floor(Number(inMats[k]));
      if (!Number.isInteger(n) || n < 0 || n > 10) return sendJSON(res, 400, { error: '原料数额越界' });
      total += n;
      if (n > 0) got[k] = n;
    }
    if (total > 20) return sendJSON(res, 400, { error: '单次入账总额越界（≤20）' });
    // 限速窗在校验之后：失败请求不烧配额（客户端奇遇节奏 ~10 次/小时，4 次入账余量足够）
    if (!windWindow.hit(ctx.user.id)) return sendJSON(res, 429, { error: '奇遇入账过于频繁，请稍后再试' });
    const now = Date.now();
    const row = stmts.getShop.get(ctx.user.id);
    const st = loadState(row ? row.state : '');
    for (const k of Object.keys(got)) st.mats[k] = clampInt((st.mats[k] || 0) + got[k], 0, 1e6);
    stmts.putShop.run(ctx.user.id, JSON.stringify(st), now);
    return sendJSON(res, 200, { ok: true, got, view: viewOf(ctx.user.id, st, now) });
  }

  function handle(req, res, ctx) {
    const p = ctx.pathname;
    if (p === '/api/shop' && ctx.method === 'GET') { get(req, res, ctx); return true; }
    if (p === '/api/shop/build' && ctx.method === 'POST') { build(req, res, ctx); return true; }
    if (p === '/api/shop/craft' && ctx.method === 'POST') { craft(req, res, ctx); return true; }
    if (p === '/api/shop/collect' && ctx.method === 'POST') { collect(req, res, ctx); return true; }
    if (p === '/api/shop/sell' && ctx.method === 'POST') { sell(req, res, ctx); return true; }
    if (p === '/api/shop/order' && ctx.method === 'POST') { order(req, res, ctx); return true; }
    if (p === '/api/shop/deposit' && ctx.method === 'POST') { deposit(req, res, ctx); return true; }
    if (p === '/api/shop/windfall' && ctx.method === 'POST') { windfall(req, res, ctx); return true; }
    return false;
  }

  return { handle };
}
