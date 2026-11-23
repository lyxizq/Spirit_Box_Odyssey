#!/usr/bin/env node
// 本地单机版 E2E（真实栈口径，对齐 server-validation.md 的验收链路）：
//   node scripts/test-local.mjs            # A 部分：虚拟服务端全端点扫（sql.js 同引擎）
//   node scripts/test-local.mjs --parity   # B 部分：+ 真实服务端（node server/index.js 临时库）形态对照
// A 用与浏览器完全相同的构建产物（local/.build/server.mjs + vendor sql.js），
// 覆盖：存档推拉/账本拒收/体力/征战/试炼/离线/灵宠/坊市/修炼/天下（排行天梯PVP妖王仙盟悬赏回忆访客）/
// 领奖授权/显示名/兑换码/重置/整库导入导出。防作弊面（增速包络、单调回滚、伤害钳制）一并验证。
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DO_PARITY = process.argv.includes('--parity');

// ---------- 基础设施 ----------

let passed = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else {
    failures.push(name + (extra ? ' :: ' + JSON.stringify(extra).slice(0, 300) : ''));
    console.log('  ✗ ' + name + (extra ? ' :: ' + JSON.stringify(extra).slice(0, 300) : ''));
  }
}
const section = (t) => console.log('\n—— ' + t + ' ——');

// game.js 以 parity-check 同款沙盒加载（readyState=loading 不启动），LX.state() 即
// 全新账号的真实初始档（与真实客户端首推内容一致，保证 validateDeep 口径无偏差）
function loadFreshClientState() {
  const code = readFileSync(join(root, 'game.js'), 'utf8');
  const els = new Map();
  const mkEl = () => ({
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    textContent: '', innerHTML: '', value: '', hidden: false,
    style: { setProperty() {} }, dataset: {},
    appendChild() {}, remove() {}, setAttribute() {}, getAttribute() { return null; },
    querySelectorAll() { return []; }, querySelector() { return null; },
    offsetWidth: 0, focus() {},
  });
  const sandbox = {
    console, Math, Date, JSON, Promise, Error, TypeError, RangeError,
    Number, String, Array, Object, Set, Map, Boolean, Symbol, RegExp, parseInt, parseFloat, isNaN, isFinite,
    performance: { now: () => Date.now() },
    location: { hostname: '127.0.0.1', search: '', replace() {}, reload() {} },
    navigator: { userAgent: 'local-e2e', vibrate() {}, sendBeacon: () => true },
    document: {
      readyState: 'loading',
      addEventListener() {},
      getElementById(id) { if (!els.has(id)) els.set(id, mkEl()); return els.get(id); },
      querySelector() { return mkEl(); },
      querySelectorAll() { return []; },
      createElement() { return mkEl(); },
      body: { classList: { add() {}, remove() {}, contains() { return false; } }, style: {}, appendChild() {} },
      hidden: false,
    },
    window: {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: () => Promise.resolve({ ok: false, status: 0, json: async () => ({}) }),
    AudioContext: function () {
      this.createOscillator = () => ({ connect() {}, start() {}, stop() {}, frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, type: '' });
      this.createGain = () => ({ connect() {}, gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} } });
      this.destination = {}; this.currentTime = 0; this.state = 'running'; this.resume = () => {};
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: () => 0,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'game.js' });
  const LX = sandbox.window.LX;
  if (!LX) throw new Error('game.js 加载失败（LX 钩子未暴露）');
  return LX.state();
}

// 中盘合成档（口径对齐 scripts/parity-check.mjs 的深度校验面）：在新档上覆盖
// 装备/灵宠/境界/经济，用于打通立盟/坊市/天梯等有门槛的玩法端点
function buildMidGameState(fresh) {
  const d = JSON.parse(JSON.stringify(fresh));
  const ITEM = (slot, r, power, el, affixes, extra) => Object.assign({
    id: d.itemSeq++, r, slot, name: '测试·' + slot, power, el, affixes,
  }, extra || {});
  Object.assign(d, {
    realm: 5, realmPeak: 6, ascensions: 2, immortal: 3,
    stones: 5e9, totalStones: 6e9, dust: 5e4, dustTotal: 8e4, opens: 2e5, exp: 9e7,
    petTickets: 10,
    // 自报战力 + PvP 快照（syncPowerScore 的同步钥匙：没有它们战力榜/境界列/快照不入库）
    power: 5e6,
    pvpSnap: { atk: 1e6, hp: 2e7, def: 3e5, crit: 0.15, critMult: 2, lifesteal: 0.05, dr: 0.05, pierce: 0.1 },
    // 征战进度（账本权威列的镜像源）：野外门槛 stageCleared≥3、爬塔 ≥5
    stageCleared: 12, towerCleared: 15, endlessBest: 3, wildMax: 5,
    gainLv: 40, speedLv: 30, luckLv: 10,
    trainAtk: 50, trainHp: 60, trainPierce: 70,
    gongfa: { atk: 80, hp: 90, hui: 40 },
    cave: { array: 30, garden: 20, library: 25, fang: 200 },
    enh: { weapon: 10, armor: 8, helm: 6, boots: 4, artifact: 2, talisman: 1, bracelet: 3, ring: 5, wrist: 7, legs: 9, band: 11, wings: 12 },
    pets: { fox: 20, turtle: 15, rat: 8, pixiu: 30 },
    petTokens: { fox: 3, pixiu: 5 },
    petCores: { fox: 6, turtle: 10, rat: 3, pixiu: 10 },
    // 个体灵宠（petInsts/activePets）不预置：uid 由服务端发号、水位校验会把凭空个体
    // 拒收（真实新号不可能先有 uid 宠）——A5 由 hunt/capture 真实链路产出
    petDex: { fox: { met: 9, got: 2, bestR: 3 } },
    bestiary: { a: 1, b: 1 },
    setCollection: { tower: ['weapon', 'armor', 'helm'], stage: ['weapon', 'ring'], wild: ['legs'] },
    equipped: {
      // validateDeep 口径：套装件（special）必为仙品 r5；普通件战力 ≤ 品质基准×1.2（Lv.1）
      weapon: ITEM('weapon', 5, 500, 'jin', [{ k: 'atk', v: 0.06 }, { k: 'crit', v: 0.02 }], { star: 2, special: true, setKey: 'tower', sigil: { k: 'thorns' } }),
      armor: ITEM('armor', 5, 800, 'mu', [{ k: 'hp', v: 0.10 }, { k: 'def', v: 0.05 }, { k: 'ls', v: 0.02 }], { star: 1, special: true, setKey: 'stage', sigil: { k: 'critdmg' } }),
      helm: ITEM('helm', 5, 200, 'shui', [{ k: 'pierce', v: 0.025 }], { special: true, setKey: 'tower' }),
      boots: ITEM('boots', 5, 60, 'huo', [], { special: true, setKey: 'stage' }),
      artifact: ITEM('artifact', 5, 900, 'tu', [{ k: 'atk', v: 0.075 }, { k: 'hp', v: 0.08 }]),
      talisman: ITEM('talisman', 5, 800, 'jin', []),
      bracelet: ITEM('bracelet', 5, 700, 'mu', [{ k: 'hp', v: 0.09 }, { k: 'atk', v: 0.05 }, { k: 'crit', v: 0.015 }], { special: true, setKey: 'tower' }),
      ring: ITEM('ring', 5, 650, 'shui', [{ k: 'ls', v: 0.03 }, { k: 'pierce', v: 0.02 }, { k: 'atk', v: 0.04 }], { special: true, setKey: 'tower' }),
      wrist: ITEM('wrist', 5, 210, 'jin', [{ k: 'atk', v: 0.05 }], { special: true, setKey: 'wild' }),
      legs: ITEM('legs', 5, 180, 'huo', [{ k: 'def', v: 0.06 }], { special: true, setKey: 'wild' }),
      band: null,
      wings: ITEM('wings', 5, 700, 'tu', []),
    },
    // bond（本命法宝器灵）不预置：等级/经验是服务端账本真值（战斗记账），
    // 推送档高于账本会被拒——保持新档默认值
  });
  d.itemSeq += 100; // 给后续掉落留水位
  return d;
}

// ---------- 引擎装载（与浏览器同一 sql.js + 同一构建产物） ----------

// sql-wasm.js 是 UMD：仓库 "type":"module" 会让 require() 把它按 ESM 装成空命名空间，
// 这里手动按 CJS 编译拿 initSqlJs（与浏览器 <script> 全局同一份代码）
function loadSqlJsDist() {
  const Mod = require('node:module');
  const path = join(root, 'local', 'vendor', 'sql-wasm.js');
  const m = new Mod('x');
  m._compile(readFileSync(path, 'utf8'), path);
  return m.exports;
}

async function makeVirtualServer(initialBytes) {
  const initSqlJs = loadSqlJsDist();
  const wasm = readFileSync(join(root, 'local', 'vendor', 'sql-wasm.wasm'));
  const SQL = await initSqlJs({ wasmBinary: new Uint8Array(wasm) });
  globalThis.__LX_SQL = SQL;
  const mod = await import(join(root, 'local', '.build', 'server.mjs'));
  return mod.createLocalServer({ version: 'e2e', initialBytes: initialBytes || null });
}

function caller(server) {
  return async (method, pathname, body) => {
    const raw = body === undefined || typeof body === 'string' ? (body ?? null) : JSON.stringify(body);
    const out = await server.handle(method, pathname, raw);
    let json = null;
    try { json = JSON.parse(JSON.stringify(out.json)); } catch (e) { /* noop */ }
    return { status: out.status, json, retryAfter: out.retryAfter };
  };
}

// ---------- 主流程 ----------

// 屏蔽词库同源断言用的测试词：从 server/lexicon/Vocabulary 取一个纯中文 2–6 字、且不在
// moderation.js 手写补充表（HAND_WORDS）与豁免表（WHITELIST）里的词——只有完整词库被加载
// 才会拒收（2026-11-23 修复前本地版只加载手写 53 词，这类词全部放行）
function pickLexiconOnlyWord() {
  const src = readFileSync(join(root, 'server', 'moderation.js'), 'utf8');
  const quoted = (re) => {
    const m = re.exec(src);
    return m ? Array.from(m[1].matchAll(/'([^']+)'/g), (x) => x[1]) : [];
  };
  const hand = new Set(quoted(/const HAND_WORDS = \[([\s\S]*?)\n\];/));
  const white = new Set(quoted(/const WHITELIST = new Set\(\[([\s\S]*?)\]\);/));
  if (!hand.size || !white.size) throw new Error('moderation.js 手写表/豁免表解析失败（源码结构变了？）');
  const dir = join(root, 'server', 'lexicon', 'Vocabulary');
  for (const name of readdirSync(dir).sort()) {
    for (const line of readFileSync(join(dir, name), 'utf8').split(/\r?\n/)) {
      const w = line.trim().toLowerCase();
      if (!w || w.startsWith('#') || !/^[\u4e00-\u9fa5]{2,6}$/.test(w) || hand.has(w) || white.has(w)) continue;
      return w;
    }
  }
  throw new Error('词库里找不到可用的测试词');
}
const lexOnlyWord = pickLexiconOnlyWord();

const fresh = loadFreshClientState();
const mid = buildMidGameState(fresh);
const pushText = (obj) => JSON.stringify(obj);

section('A1 启动 / 账号面');
const server = await makeVirtualServer();
const call = caller(server);
{
  const me = await call('GET', '/api/auth/me');
  ok(me.status === 200 && me.json && me.json.displayName, 'auth/me 200 + displayName', me.json);
  ok(me.json.displayName === '无名道友', '默认显示名 无名道友', me.json.displayName);
  const ver = await call('GET', '/api/version');
  ok(ver.status === 200 && typeof ver.json.time === 'number' && typeof ver.json.tzOffset === 'number' && typeof ver.json.version === 'string',
    'version 200 + time/tzOffset/version', ver.json);
  const s0 = await call('GET', '/api/save');
  ok(s0.status === 200 && s0.json.found === false, '空库首拉 found=false', s0.json);
  const nope = await call('GET', '/api/nowhere');
  ok(nope.status === 404, '未知路由 404');
}

section('A2 新档首推 / 账本拒收 / 云端停留（独立实例：基线即新档）');
{
  const s1 = await makeVirtualServer();
  const c1 = caller(s1);
  const r1 = await c1('POST', '/api/save', pushText(fresh));
  ok(r1.status === 200, '新档首推 200（无账本行种基线）', r1.json);
  const g1 = await c1('GET', '/api/save');
  ok(g1.status === 200 && g1.json.found === true && g1.json.text === pushText(fresh),
    '回拉文本与首推逐字一致', { len: g1.json && g1.json.text && g1.json.text.length });
  const again = await c1('POST', '/api/save', pushText(fresh));
  ok(again.status === 200, '同档重推不误伤（镜像一致）', again.json);
  const cheat = JSON.parse(pushText(fresh));
  cheat.stones += 1e15;
  cheat.totalStones += 1e15;
  const bad = await c1('POST', '/api/save', pushText(cheat));
  ok(bad.status === 400, '收益暴增整档拒收 400', { status: bad.status, error: bad.json && bad.json.error });
  const g2 = await c1('GET', '/api/save');
  ok(g2.json.text === pushText(fresh), '拒收后云端停在最后合法档');
}

section('A3 中盘档种基线 / 单调回滚拒收');
let latestText = null; // 记录最后一次成功推送（A12 导入对照基准）
{
  const midPush = await call('POST', '/api/save', pushText(mid));
  latestText = pushText(mid);
  ok(midPush.status === 200, '中盘档首推 200（基线随档种入）', midPush.json);
  const roll = JSON.parse(pushText(mid));
  roll.stones = 0;
  roll.totalStones = 0;
  roll.opens = 0;
  const rollBack = await call('POST', '/api/save', pushText(roll));
  ok(rollBack.status === 400, '计数回退旧档拒收 400', { status: rollBack.status });
  const g3 = await call('GET', '/api/save');
  ok(g3.json.text === pushText(mid), '拒收回滚后云端仍为中盘档');
}

section('A4 体力 / 征战 / 试炼 / 离线');
{
  const st = await call('GET', '/api/stamina');
  ok(st.status === 200 && st.json.stamina != null && st.json.cap != null, 'stamina GET 200', st.json);
  const f1 = await call('POST', '/api/combat/fight', { mode: 'stage' });
  ok(f1.status === 200 && typeof f1.json.win === 'boolean', '闯关一场 200（服务端裁定胜负）', { status: f1.status, keys: f1.json && Object.keys(f1.json) });
  const f2 = await call('POST', '/api/combat/fight', { mode: 'wild', level: 1 });
  ok(f2.status === 200, '野外一场 200', f2.json);
  const tr = await call('POST', '/api/trial/run', { id: 'swift' });
  ok(tr.status === 200, '条件试炼 200（服务端当日 done 表）', tr.json);
  const tr2 = await call('POST', '/api/trial/run', { id: 'swift' });
  ok(tr2.status !== 200 || tr2.json.stones == null, '同日同试炼防重（429/400/重复不发奖）', { status: tr2.status });
  const off = await call('POST', '/api/combat/offline', {});
  ok(off.status === 200 && off.json.settled === false, '离线结算 200（刚推档无间隔 → 不结算）', off.json);
  const sp = await call('GET', '/api/stamina');
  ok(sp.json.stamina < st.json.stamina, '战斗扣体力（每场 1 点）', { before: st.json.stamina, after: sp.json.stamina });
}

section('A5 灵宠（hunt 掷遭遇 → capture 两阶段）');
{
  let hunt = null;
  let met = false;
  for (let i = 0; i < 8 && !met; i++) {
    hunt = await call('POST', '/api/pet/hunt', { zone: 'huang' });
    met = hunt.status === 200 && hunt.json.enc != null;
  }
  ok(hunt && hunt.status === 200, '缚灵谷探索 200（扣券+体力）', hunt && hunt.json);
  ok(met, '遭遇出现（pity 保底）', hunt && { meet: hunt.json.meet, pity: hunt.json.pity });
  const pend = await call('GET', '/api/pet/pending');
  ok(pend.status === 200 && pend.json.enc && pend.json.enc.sp, 'pending 遭遇在库', pend.json);
  let uid = null;
  for (let i = 0; i < 8 && !uid; i++) {
    const cap = await call('POST', '/api/pet/capture', { policy: 'bare' });
    if (cap.status === 200 && cap.json.captured && cap.json.pet && cap.json.pet.uid) uid = cap.json.pet.uid;
    else if (cap.status === 200) {
      // 跑了再探（pity 保底兜住）
      let again = null;
      for (let j = 0; j < 8 && !(again && again.json.enc != null); j++) {
        again = await call('POST', '/api/pet/hunt', { zone: 'huang' });
      }
    } else { ok(false, '收服请求异常', cap); break; }
  }
  ok(!!uid, '收服成功（空手概率制 + pity 保底，服务端发 uid）', { uid });
  const pend2 = await call('GET', '/api/pet/pending');
  ok(!pend2.json.enc, '收服后 pending 清空');
  // 与真实客户端一致：把新宠写进镜像回推（reroll/合成以服务端镜像为存在依据）
  if (uid) {
    const withPet = JSON.parse(pushText(mid));
    withPet.petInsts = [{ uid, sp: 'rat', r: 1, lv: 1, affixes: [], rerolls: 0 }];
    withPet.activePets = [];
    const repush = await call('POST', '/api/save', pushText(withPet));
    ok(repush.status === 200, '含新宠镜像回推 200', repush);
    if (repush.status === 200) latestText = pushText(withPet);
  }
  const reroll = await call('POST', '/api/pet/reroll', { uid, locks: 0 });
  ok(reroll.status === 200 || (reroll.status === 400 && /洗髓|灵石|不足|券|没有词条/.test(reroll.json.error || '')), '洗髓端点活着（200 或余额/品质类 400）', reroll.json);
}

section('A6 云来坊市（服务端权威经营链）');
{
  const v0 = await call('GET', '/api/shop');
  ok(v0.status === 200 && v0.json.locked === false, '坊市总览 200（中盘境界已解锁）', { locked: v0.json && v0.json.locked });
  const b1 = await call('POST', '/api/shop/build', { b: 'dan' });
  ok(b1.status === 200, '丹房解锁 200（账本原子扣款）', b1.json);
  const wf = await call('POST', '/api/shop/windfall', { mats: { cao: 9 } });
  ok(wf.status === 200, '原料入账 windfall 200', wf.json);
  const c1 = await call('POST', '/api/shop/craft', { b: 'dan', id: 'huiqi' });
  ok(c1.status === 200, '开一炉回气丹 200', c1.json);
  const sell = await call('POST', '/api/shop/sell', { id: 'huiqi', n: 1 });
  ok(sell.status === 400 || sell.status === 200, '直售端点活着（无库存 400 / 有库存 200）', sell.json);
  const or = await call('POST', '/api/shop/orderrefresh', {});
  ok(or.status === 200 || or.status === 429, '订单刷新端点活着', or.json);
}

section('A7 修炼（闭关打坐 / 道童历练门槛）');
{
  const s1 = await call('POST', '/api/cult/secl/start', { dur: 0, incense: 0 });
  ok(s1.status === 200 && s1.json.until != null, '闭关 30 分钟开局 200', s1.json);
  const sc = await call('POST', '/api/cult/secl/cancel', {});
  ok(sc.status === 200, '取消闭关 200', sc.json);
  const dp = await call('POST', '/api/cult/dispatch/start', { dest: 'heishi', h: 0 });
  ok(dp.status === 200 || dp.status === 400, '道童历练端点活着（渡劫门槛 400 / 通过 200）', dp.json);
}

section('A8 天下 · 排行 / 天梯 / PVP（假人池）');
{
  const rank = await call('GET', '/api/rank');
  ok(rank.status === 200 && Array.isArray(rank.json.top) && rank.json.me, '战力榜 200（本地用户上榜）',
    { top: rank.json.top && rank.json.top.length, me: rank.json.me });
  const ladder = await call('GET', '/api/ladder');
  ok(ladder.status === 200 && Array.isArray(ladder.json.top) && ladder.json.top.length >= 20, '天梯榜 200（24 剑影常驻）',
    { top: ladder.json.top && ladder.json.top.length });
  const pvp = await call('GET', '/api/pvp');
  ok(pvp.status === 200 && Array.isArray(pvp.json.opponents) && pvp.json.opponents.length >= 5, '竞技场候选（假人就近补位）',
    { opponents: pvp.json.opponents && pvp.json.opponents.length });
  const target = pvp.json.opponents[0];
  const fight = await call('POST', '/api/pvp/fight', { targetId: target.id, win: true });
  ok(fight.status === 200 && fight.json.rating != null, 'PVP 一场（服务端复算胜负，上报 win 不采信）',
    { rating: fight.json && fight.json.rating });
  const buy = await call('POST', '/api/pvp/buy', {});
  ok(buy.status === 200 || buy.status === 400, '竞技场加购端点活着（余额不足 400）', buy.json);
  const pay = await call('POST', '/api/ladder/pay', {});
  ok(pay.status === 200 && pay.json.stones != null, '天梯日俸直发 200', pay.json);
  const ins = await call('POST', '/api/rank/inspect', { id: target.id });
  ok(ins.status === 404, '假人装备查验（无存档 → 404 按未上榜口径）', { status: ins.status });
}

section('A9 天下 · 世界妖王 / 悬赏 / 回忆之战 / 洞府访客');
{
  const b0 = await call('GET', '/api/boss');
  ok(b0.status === 200 && b0.json.hp != null && b0.json.maxHp != null, '世界妖王 200（血量按全服最高战力缩放）',
    { hp: b0.json && b0.json.hp, max: b0.json && b0.json.maxHp });
  const hit = await call('POST', '/api/boss/hit', { damage: Number.MAX_SAFE_INTEGER });
  ok(hit.status === 200 && hit.json.hp <= b0.json.hp, '妖王乱报伤害被复算钳制（血量只降不涨）',
    { before: b0.json.hp, after: hit.json && hit.json.hp });
  const bo = await call('GET', '/api/bounty');
  ok(bo.status === 200 && bo.json.day && Array.isArray(bo.json.elites) && bo.json.elites.length === 3, '悬赏妖踪 200（每日三只）',
    { elites: bo.json.elites && bo.json.elites.length });
  const bf = await call('POST', '/api/bounty/fight', { slot: 0 });
  ok(bf.status === 200 && bf.json.win != null, '悬赏一战 200（服务端复算）', bf.json);
  const bf2 = await call('POST', '/api/bounty/fight', { slot: 0 });
  ok(bf2.status === 429 || bf2.status === 400, '同 slot 一日一场防重', { status: bf2.status });
  const mm = await call('GET', '/api/memory');
  ok(mm.status === 200 && mm.json.boss && mm.json.boss.name, '回忆之战 200（周键轮换首领）', mm.json && mm.json.boss);
  const mf = await call('POST', '/api/memory/fight', {});
  ok(mf.status === 200 && mf.json.win != null, '回忆之战一场 200', mf.json);
  const vi = await call('GET', '/api/visitor');
  ok(vi.status === 200 && vi.json.visitor && vi.json.visitor.name, '洞府访客 200（按日种子推导）', vi.json && vi.json.visitor);
  const va = await call('POST', '/api/visitor/act', { choice: 'ask' });
  ok(va.status === 200 && va.json.stones != null, '访客求教 200（直发灵石）', va.json);
}

section('A10 天下 · 仙盟（独行侠盟全链）');
{
  const g0 = await call('GET', '/api/guild');
  ok(g0.status === 200 && g0.json.guild == null, '未立盟查询 200', g0.json);
  const gl = await call('GET', '/api/guild/list');
  ok(gl.status === 200 && Array.isArray(gl.json.list), '仙盟名录 200', gl.json);
  const gc = await call('POST', '/api/guild/create', { name: '青云盟' });
  ok(gc.status === 200 && gc.json.guild && gc.json.guild.name === '青云盟', '立盟 200（双币扣款 + 境界门槛）', gc.json);
  const don = await call('POST', '/api/guild/donate', { amount: 100000 });
  ok(don.status === 200 && don.json.accepted === 100000, '捐献 10 万 200（账本足额校验）', don.json);
  const donBad = await call('POST', '/api/guild/donate', { amount: 1e12 });
  ok(donBad.status === 400 || donBad.status === 429, '超日限额拒 400/429', { status: donBad.status });
  const task = await call('POST', '/api/guild/task/claim', { taskId: 'donate' });
  ok(task.status === 200 && task.json.stones != null, '盟任务「盟库充盈」领取 200（服务端聚合进度）', task.json);
  const gb = await call('GET', '/api/guild');
  ok(gb.status === 200 && gb.json.guild && gb.json.guild.boss && gb.json.guild.boss.maxHp != null, '盟妖王按盟内最高战力生成',
    { status: gb.status, boss: gb.json && gb.json.guild && gb.json.guild.boss });
  const ghit = await call('POST', '/api/guild/boss/hit', { damage: Number.MAX_SAFE_INTEGER });
  ok(ghit.status === 200, '盟妖王乱报伤害被钳制 200', ghit.json);
  const shopBuy = await call('POST', '/api/guild/shop/buy', { itemId: 'stones' });
  ok(shopBuy.status === 200 && shopBuy.json.reward, '贡献商店购买 200（捐献得贡献）', shopBuy.json);
  const aid = await call('POST', '/api/guild/aid', { type: 'skill', targetId: -1 });
  ok(aid.status === 400 || aid.status === 404 || aid.status === 200, '同门互助端点活着（无受赠人 4xx）', aid.json);
}

section('A11 领奖授权 / 显示名 / 兑换码');
{
  const c1 = await call('POST', '/api/claim', { kind: 'task_opens', amount: 5e6 });
  ok(c1.status === 200 && c1.json.stones === 5e6, '大额领奖授权 200（日锁 + 上限）', c1.json);
  const c2 = await call('POST', '/api/claim', { kind: 'task_opens', amount: 5e6 });
  ok(c2.status === 429, '同日同 kind 二次领取拒 429', { status: c2.status });
  const n1 = await call('POST', '/api/profile/name', { name: '青云散人' });
  ok(n1.status === 200 && n1.json.displayName === '青云散人', '改显示名 200', n1.json);
  const n2 = await call('POST', '/api/profile/name', { name: '再改一个' });
  ok(n2.status === 429, '24 小时限改一次 429', { status: n2.status });
  const bannedName = await call('POST', '/api/profile/name', { name: lexOnlyWord });
  ok(bannedName.status === 400 && /屏蔽词/.test((bannedName.json && bannedName.json.error) || ''),
    '屏蔽词库已随 bundle 加载：词库专有词的显示名被拒（手写 53 词之外）', { status: bannedName.status, error: bannedName.json && bannedName.json.error });
  const rd = await call('POST', '/api/redeem', { code: 'NOPE1234' });
  ok(rd.status === 400 || rd.status === 404 || rd.status === 410, '无效兑换码拒 4xx', { status: rd.status });
}

section('A12 整库导出 → 新实例导入（换设备迁移语义）');
{
  const bytes = server.db.exportBytes();
  ok(bytes && bytes.length > 1000, '整库导出字节（' + (bytes.length / 1024).toFixed(0) + ' KB）');
  const s2 = await makeVirtualServer(new Uint8Array(bytes));
  const call2 = caller(s2);
  const me = await call2('GET', '/api/auth/me');
  ok(me.json.displayName === '青云散人', '导入后显示名保留', me.json);
  const sv = await call2('GET', '/api/save');
  ok(sv.json.found === true && sv.json.text === latestText, '导入后云端档逐字一致（对照最后一次成功推送）');
  const gu = await call2('GET', '/api/guild');
  ok(gu.json.guild && gu.json.guild.name === '青云盟', '导入后仙盟保留');
  const lad = await call2('GET', '/api/ladder');
  ok(lad.status === 200 && lad.json.top.length >= 20, '导入后假人池随库迁移');
  let rejected = false;
  try {
    await makeVirtualServer(new TextEncoder().encode('not a sqlite db'));
  } catch (e) {
    rejected = true;
  }
  ok(rejected, '非法备份字节被拒（导入前校验）');
}

section('A13 重置（等价全新账号开局）');
{
  const r = await call('POST', '/api/reset', {});
  ok(r.status === 200, '重置 200', r.json);
  const sv = await call('GET', '/api/save');
  ok(sv.json.found === false, '重置后云端档清空');
  const gu = await call('GET', '/api/guild');
  ok(gu.json.guild && gu.json.guild.name === '青云盟', '仙盟不在重置范围（与服务器口径一致）');
}

// ---------- B：真实服务端形态对照 ----------

async function parity() {
  section('B 真实服务端形态对照（node server/index.js 临时库）');
  // 对照口径：两端走完全相同的「合法新号序列」（fresh 档首推种基线 → 同一批端点）。
  // 不推中盘大档——真实服务端的新号种子校验会拒 0 天账龄的大额档（本地版同样拒，
  // 那本身也是一次一致性证明），对照必须在两端都接受的序列上做。
  const vPar = caller(await makeVirtualServer());
  const PORT = 18099 + Math.floor(Math.random() * 500);
  const DB = join(root, 'data', 'tmp-local-parity.db');
  try { require('node:fs').unlinkSync(DB); } catch (e) { /* 无残留 */ }
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: Object.assign({}, process.env, { PORT: String(PORT), DB_PATH: DB, DB_JOURNAL: 'delete' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  const base = 'http://127.0.0.1:' + PORT;
  let cookie = '';
  const real = async (method, pathname, body, isText) => {
    const res = await fetch(base + pathname, {
      method,
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        cookie ? { Cookie: cookie } : {}),
      body: body === undefined ? undefined : (isText ? body : JSON.stringify(body)),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch (e) { /* 非 JSON */ }
    return { status: res.status, json };
  };

  try {
    // 等服务起来
    for (let i = 0; i < 50; i++) {
      try { await fetch(base + '/api/version'); break; } catch (e) { await new Promise((r) => setTimeout(r, 200)); }
    }
    let reg = await real('POST', '/api/auth/register', { username: 'parityuser', password: 'parity-pass-123' });
    if (reg.status === 409) {
      reg = await real('POST', '/api/auth/login', { username: 'parityuser', password: 'parity-pass-123' });
    }
    ok(reg.status === 200, '真实服务端注册/登录', reg.json);

    // 同一客户端 fresh 档推到两端，逐字对照回拉
    const pReal = await real('POST', '/api/save', pushText(fresh), true);
    const pVirt = await vPar('POST', '/api/save', pushText(fresh));
    ok(pReal.status === pVirt.status && pReal.status === 200, 'fresh 档推送状态一致且 200', { real: pReal.status, virt: pVirt.status });
    const gReal = await real('GET', '/api/save');
    const gVirt = await vPar('GET', '/api/save');
    ok(gReal.json.text === gVirt.json.text && gReal.json.text === pushText(fresh), '两端回拉存档逐字一致');

    // 形态对照：数值/字符串/布尔归一为类型标签后深比对（RNG 结果不比数值，只比形状）
    const shape = (v) => {
      if (v == null) return 'null';
      if (Array.isArray(v)) return v.length <= 8 ? v.map(shape) : ['arr×' + v.length];
      if (typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v).sort()) o[k] = shape(v[k]);
        return o;
      }
      if (typeof v === 'number') return 'N';
      if (typeof v === 'boolean') return 'B';
      return 'S';
    };
    const steps = [
      ['GET', '/api/stamina', undefined],
      ['POST', '/api/combat/fight', { mode: 'stage' }],
      ['POST', '/api/combat/offline', {}],
      ['GET', '/api/shop', undefined],
      ['GET', '/api/rank', undefined],
      ['GET', '/api/ladder', undefined],
      ['GET', '/api/pvp', undefined],
      ['GET', '/api/boss', undefined],
      ['GET', '/api/bounty', undefined],
      ['GET', '/api/memory', undefined],
      ['GET', '/api/visitor', undefined],
      ['GET', '/api/guild', undefined],
      ['POST', '/api/redeem', { code: 'NOPE1234' }],
    ];
    for (const [m, p, b] of steps) {
      const a = await real(m, p, b);
      const v = await vPar(m, p, b);
      const sa = JSON.stringify(shape(a.json));
      const sv2 = JSON.stringify(shape(v.json));
      ok(sa === sv2 && a.status === v.status, '形态一致 ' + m + ' ' + p, a.status === v.status ? null : { real: a.status, virt: v.status });
      if ((sa !== sv2 || a.status !== v.status) && process.env.PARITY_VERBOSE) {
        console.log('    real(' + a.status + '): ' + sa.slice(0, 500));
        console.log('    virt(' + v.status + '): ' + sv2.slice(0, 500));
      }
    }
    // 屏蔽词判定逐字对照：同一份词库 → 两端拒收且报出同一个词
    const aBan = await real('POST', '/api/profile/name', { name: lexOnlyWord });
    const vBan = await vPar('POST', '/api/profile/name', { name: lexOnlyWord });
    ok(aBan.status === 400 && vBan.status === 400 && aBan.json.error === vBan.json.error,
      '屏蔽词判定两端一致（词库专有词，报出同一个词）', { real: aBan.json, virt: vBan.json });
  } finally {
    child.kill('SIGTERM');
    try { require('node:fs').unlinkSync(DB); } catch (e) { /* 临时库清理尽力而为 */ }
  }
}

if (DO_PARITY) await parity();

console.log('\n================================');
console.log('通过 ' + passed + ' 项' + (failures.length ? '，失败 ' + failures.length + ' 项' : '，全部绿'));
for (const f of failures) console.log('  ✗ ' + f);
process.exit(failures.length ? 1 : 0);
