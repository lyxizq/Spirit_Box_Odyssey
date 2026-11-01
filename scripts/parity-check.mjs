// 两端同源断言（2026-11-01 全量服务端校验迁移）：用同一份合成存档分别跑
// 客户端 game.js（Node VM 加载，DOM stub）与服务端 battle.js 的面板/敌人/难度公式，
// 数值零容差（浮点相对误差 1e-9）比对。客户端战斗公式改动必须同步 server/battle.js，
// 本脚本是防口径漂移的回归门——CI/发布前必跑。
// 运行：node scripts/parity-check.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import {
  playerCombatStats, enemyFor, contentReq, recommendedPower,
} from '../server/battle.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const code = readFileSync(join(root, 'game.js'), 'utf8');

// —— 浏览器环境 stub（start() 不执行：readyState 停在 loading）——
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
  navigator: { userAgent: 'parity', vibrate() {} },
  document: {
    readyState: 'loading',
    addEventListener() {},
    getElementById(id) { if (!els.has(id)) els.set(id, mkEl()); return els.get(id); },
    querySelector() { return mkEl(); },
    querySelectorAll() { return []; },
    createElement() { return mkEl(); },
    body: { classList: { add() {}, remove() {}, contains() { return false; } }, style: {} },
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
  sendBeacon: () => true,
};
sandbox.window = sandbox; // window.LX 挂同一命名空间，脚本可直接取
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'game.js' });
const LX = sandbox.window.LX;
if (!LX || !LX.stats) {
  console.error('parity: game.js 加载失败或 LX 钩子未暴露（hostname 需 127.0.0.1）');
  process.exit(1);
}

// —— 合成存档（中盘配置：覆盖全部乘区来源）——
const ITEM = (slot, r, power, el, affixes, extra) => Object.assign({
  id: 1, r, slot, name: '测试·' + slot, power, el, affixes,
}, extra || {});
const data = {
  realm: 5, realmPeak: 6, ascensions: 2, immortal: 3,
  gainLv: 40, speedLv: 30, luckLv: 10,
  trainAtk: 50, trainHp: 60, trainPierce: 70,
  gongfa: { atk: 80, hp: 90, hui: 40 },
  cave: { array: 30, garden: 20, library: 25 },
  enh: { weapon: 10, armor: 8, helm: 6, boots: 4, artifact: 2, talisman: 1, bracelet: 3, ring: 5, wrist: 7, legs: 9, band: 11, wings: 12 },
  slotGems: {
    weapon: [{ k: 'atk', t: 3 }, { k: 'hp', t: 2 }, { k: 'crit', t: 1 }],
    armor: [{ k: 'def', t: 2 }, null, { k: 'hp', t: 1 }],
    helm: [{ k: 'ls', t: 3 }, { k: 'pierce', t: 2 }],
    boots: [null, null],
    artifact: [{ k: 'atk', t: 1 }],
    talisman: [],
    bracelet: [{ k: 'hp', t: 3 }],
    ring: [{ k: 'crit', t: 2 }, { k: 'atk', t: 2 }],
    wrist: [{ k: 'def', t: 1 }],
    legs: [{ k: 'ls', t: 2 }],
    band: [{ k: 'pierce', t: 3 }],
    wings: [null, { k: 'atk', t: 3 }],
  },
  pets: { fox: 20, turtle: 15, rat: 8, pixiu: 30 },
  petTokens: { fox: 3, pixiu: 5 },
  petCores: { fox: 6, turtle: 10, rat: 3, pixiu: 1 },
  activePets: ['fox', 'pixiu'],
  bestiary: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 },
  ordealDone: ['wuJiang', 'kuXing', 'fanYi'],
  setCollection: { tower: ['weapon', 'armor', 'helm', 'boots', 'artifact', 'talisman'], stage: ['weapon', 'ring'], wild: ['legs'] },
  equipped: {
    weapon: ITEM('weapon', 4, 500, 'jin', [{ k: 'atk', v: 0.06 }, { k: 'crit', v: 0.02 }], { star: 2 }),
    armor: ITEM('armor', 5, 800, 'mu', [{ k: 'hp', v: 0.10 }, { k: 'def', v: 0.05 }, { k: 'ls', v: 0.02 }], { star: 1 }),
    helm: ITEM('helm', 3, 200, 'shui', [{ k: 'pierce', v: 0.025 }]),
    boots: ITEM('boots', 2, 60, 'huo', []),
    artifact: ITEM('artifact', 4, 450, 'tu', [{ k: 'atk', v: 0.075 }, { k: 'hp', v: 0.08 }]),
    talisman: ITEM('talisman', 1, 15, 'jin', []),
    bracelet: ITEM('bracelet', 5, 700, 'mu', [{ k: 'hp', v: 0.09 }, { k: 'atk', v: 0.05 }, { k: 'crit', v: 0.015 }], { special: true, setKey: 'tower' }),
    ring: ITEM('ring', 5, 650, 'shui', [{ k: 'ls', v: 0.03 }, { k: 'pierce', v: 0.02 }, { k: 'atk', v: 0.04 }], { special: true, setKey: 'tower' }),
    wrist: null,
    legs: ITEM('legs', 3, 180, 'huo', [{ k: 'def', v: 0.06 }]),
    band: null,
    wings: ITEM('wings', 0, 5, 'tu', []),
  },
  elixir: { id: 'atk', until: Date.now() + 60 * 60000 },
  daoLv: { married: 'bai' },
  title: '剑侠',
  museum: { weapon: { r: 5, special: true } },
  bestiaryNote: 0,
};

// 把同一份存档写进客户端内部 state（LX.state() 返回可变引用）
const st = LX.state();
for (const k of Object.keys(data)) st[k] = data[k] === undefined ? st[k] : JSON.parse(JSON.stringify(data[k]));

const env = { now: Date.now(), guildLevel: 4 };
let fails = 0;
function close(a, b, tag) {
  const rel = Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
  if (!(rel <= 1e-9)) {
    fails++;
    console.error(`  ✗ ${tag}: client=${a} server=${b} rel=${rel}`);
  }
}

// —— 1) 玩家面板 ——
const cs = LX.stats();
const ps = playerCombatStats(data, env);
for (const k of ['power', 'atk', 'hp', 'def', 'crit', 'critMult', 'lifesteal', 'dr', 'pierce']) {
  close(cs[k], ps[k], 'stats.' + k);
}
console.log('playerCombatStats  ✓ power=' + ps.power.toExponential(2) +
  ' atk=' + ps.atk.toExponential(2) + ' hp=' + ps.hp.toExponential(2));

// —— 2) 难度曲线 + 怪物属性（确定性字段）——
for (const mode of ['stage', 'tower', 'wild', 'endless']) {
  for (const lv of [1, 5, 12, 13, 30, 31, 60, 61, 100, 150, 200]) {
    if (mode === 'endless' && lv > 200) continue;
    close(LX.req(mode, lv), contentReq(mode, lv, data), `contentReq(${mode},${lv})`);
    const ce = LX.enemy(mode, lv);
    const se = enemyFor(mode, lv, data);
    close(ce.hp, se.hp, `enemy(${mode},${lv}).hp`);
    close(ce.atk, se.atk, `enemy(${mode},${lv}).atk`);
    close(ce.def, se.def, `enemy(${mode},${lv}).def`);
    close(ce.req, se.req, `enemy(${mode},${lv}).req`);
    if (ce.boss !== se.boss) { fails++; console.error(`  ✗ enemy(${mode},${lv}).boss`); }
  }
}
console.log('contentReq/enemyFor 四模式 × 11 关卡  ✓');

// 建议战力抽样（客户端口径内联复算：req × boss1.35 × ENEMY_DIFF 3.0 × 1.008^min(lv,300)）
const isBossC = (m, l) => (m === 'tower' || m === 'endless') ? l % 10 === 0
  : m === 'stage' ? l % 5 === 0 : (l % 4 === 0 || l === 200);
for (const [m, l] of [['tower', 77], ['stage', 43], ['wild', 96], ['endless', 120]]) {
  const expect = Math.ceil(LX.req(m, l) * (isBossC(m, l) ? 1.35 : 1) * 3.0 * Math.pow(1.008, Math.min(l, 300)));
  close(expect, recommendedPower(m, l, data), `recommended(${m},${l})`);
}
console.log('recommendedPower 抽样  ✓');

console.log(fails === 0
  ? '\nPARITY OK — 两端面板/敌人/难度公式零漂移'
  : `\nPARITY FAILED — ${fails} 处口径漂移，禁止发布`);
process.exit(fails === 0 ? 0 : 1);
