// 物品生成器（2026-11-01 全量服务端校验迁移 P0）：从 game.js 同源移植的
// 装备/套装件生成与品质/词条随机。口径红线：
// ① 数值钳制与 saves.js validateItem 同界（power ≤ 品质基准×1.3 / 套装 ≤1e9、
//    词条值 0..0.6、词条数 ≤ 品质条数、同名词条去重）；
// ② 客户端公式改动必须同步本文件（parity-check.mjs 断言兜底）。
// 本文件只做「生成」，不做「入库校验」（入库仍走 validateItem）。

export const RARITIES = [
  { name: '凡品', color: '#9aa4b2', weight: 1000, stone: 1, exp: 0 },
  { name: '灵品', color: '#4ade80', weight: 350, stone: 3, exp: 1 },
  { name: '玄品', color: '#60a5fa', weight: 100, stone: 10, exp: 3 },
  { name: '地品', color: '#2dd4bf', weight: 25, stone: 35, exp: 8 },
  { name: '天品', color: '#fbbf24', weight: 2, stone: 150, exp: 20 },
  { name: '仙品', color: '#f87171', weight: 0.4, stone: 800, exp: 50 },
];

export const SLOTS = [
  { key: 'weapon', name: '武器', icon: '剑' },
  { key: 'armor', name: '衣袍', icon: '衣' },
  { key: 'helm', name: '冠冕', icon: '冠' },
  { key: 'boots', name: '云靴', icon: '靴' },
  { key: 'artifact', name: '法宝', icon: '宝' },
  { key: 'talisman', name: '灵符', icon: '符' },
  { key: 'bracelet', name: '手镯', icon: '镯' },
  { key: 'ring', name: '戒指', icon: '戒' },
  { key: 'wrist', name: '护腕', icon: '腕' },
  { key: 'legs', name: '护腿', icon: '腿' },
  { key: 'band', name: '发箍', icon: '箍' },
  { key: 'wings', name: '翅膀', icon: '翼' },
];
export const SLOT_MAP = {};
for (const s of SLOTS) SLOT_MAP[s.key] = s;

export const ITEM_NAMES = {
  weapon: [
    ['铁剑', '柴刀'], ['青锋剑', '流云枪'], ['玄铁重剑', '紫霞扇'],
    ['地煞刀', '赤霄剑'], ['天罡剑', '凤凰羽扇'], ['鸿蒙剑', '盘古斧'],
  ],
  armor: [
    ['粗布道袍', '旧皮甲'], ['流云袍', '青竹衣'], ['紫霞衣', '玄龟甲'],
    ['九幽法衣', '赤霄战甲'], ['太虚仙袍', '凤凰羽衣'], ['造化天衣', '混沌道袍'],
  ],
  helm: [
    ['木簪', '破斗笠'], ['玉冠', '青玉簪'], ['紫金冠', '太乙冠'],
    ['九幽面具', '龙骨冠'], ['天罡冠', '太虚冠'], ['鸿蒙冠', '造化玉冠'],
  ],
  boots: [
    ['草鞋', '旧布靴'], ['流云靴', '青竹履'], ['踏云靴', '玄铁靴'],
    ['地行靴', '赤霄战靴'], ['天罡战靴', '凤凰羽靴'], ['鸿蒙履', '混沌云靴'],
  ],
  artifact: [
    ['陶珠', '铜镜'], ['聚灵珠', '玉简'], ['太乙镜', '玄龟印'],
    ['地灵珠', '九幽幡'], ['太虚镜', '混元伞'], ['造化玉碟', '混沌钟'],
  ],
  talisman: [
    ['黄纸符', '木铃'], ['竹叶符', '灵玉佩'], ['太乙符', '七星铃'],
    ['九幽符', '龙骨尺'], ['九天雷符', '诛仙阵图'], ['太极图', '盘古幡'],
  ],
  bracelet: [
    ['藤木镯', '铜环'], ['灵玉镯', '青竹镯'], ['紫金镯', '太乙镯'],
    ['九幽镯', '龙骨镯'], ['天罡镯', '凤凰玉镯'], ['鸿蒙镯', '造化玉镯'],
  ],
  ring: [
    ['铁戒指', '木戒'], ['灵玉戒', '青玉戒'], ['紫金戒', '太乙戒'],
    ['九幽戒', '龙骨戒'], ['天罡戒', '凤凰羽戒'], ['鸿蒙戒', '造化玉戒'],
  ],
  wrist: [
    ['布护腕', '皮护腕'], ['流云护腕', '青竹护腕'], ['紫金护腕', '玄铁护腕'],
    ['九幽护腕', '赤霄护腕'], ['天罡护腕', '太虚护腕'], ['鸿蒙护腕', '混沌护腕'],
  ],
  legs: [
    ['麻布绑腿', '旧护腿'], ['流云护腿', '青竹护腿'], ['紫金护腿', '玄铁护腿'],
    ['地行护腿', '九幽护腿'], ['天罡护腿', '太虚护腿'], ['鸿蒙护腿', '混沌道腿'],
  ],
  band: [
    ['布发带', '木箍'], ['灵玉发带', '青丝带'], ['紫金发箍', '太乙发箍'],
    ['九幽发箍', '龙骨发箍'], ['天罡发箍', '凤羽发箍'], ['鸿蒙发箍', '造化玉箍'],
  ],
  wings: [
    ['破布翼', '纸鸢翼'], ['清风翼', '灵羽翼'], ['紫霞翼', '太乙羽翼'],
    ['九幽魔翼', '赤霄战翼'], ['天罡圣翼', '凤凰羽翼'], ['鸿蒙天翼', '混沌神翼'],
  ],
};

export const BASE_POWER = [3, 10, 30, 90, 280, 900];
export const AFFIXES = [
  { k: 'atk', name: '攻击', min: 0.03, max: 0.08 },
  { k: 'hp', name: '生命', min: 0.04, max: 0.12 },
  { k: 'def', name: '防御', min: 0.04, max: 0.10 },
  { k: 'crit', name: '暴击', min: 0.01, max: 0.03 },
  { k: 'ls', name: '吸血', min: 0.01, max: 0.03 },
  { k: 'pierce', name: '破甲', min: 0.01, max: 0.03 },
];
export const AFFIX_COUNT = [0, 0, 0, 1, 2, 3];
export const AFFIX_QMULT = [0.5, 0.6, 0.75, 0.9, 1.1, 1.35];

export const ELEMENTS = [
  { key: 'jin', name: '金' }, { key: 'mu', name: '木' }, { key: 'shui', name: '水' },
  { key: 'huo', name: '火' }, { key: 'tu', name: '土' },
];
export const ELEMENT_BEATS = { jin: 'mu', mu: 'tu', tu: 'shui', shui: 'huo', huo: 'jin' };

// 套装：pieces 命名 + bonuses 战斗加成（client SETS 同源；战斗侧 playerCombatStats 消费 bonuses）
export const SETS = {
  tower: {
    name: '镇塔', cls: 'set-tower',
    pieces: {
      weapon: '镇塔·斩妖剑', armor: '镇塔·玄鳞甲', helm: '镇塔·观星冠',
      boots: '镇塔·踏云履', artifact: '镇塔·镇魂印', talisman: '镇塔·封魔符',
      bracelet: '镇塔·缚灵镯', ring: '镇塔·定星戒', wrist: '镇塔·玄铁腕',
      legs: '镇塔·盘龙腿', band: '镇塔·绾云簪', wings: '镇塔·凌霄翼',
    },
    bonuses: [
      { need: 2, text: '防御 +15%', apply: (b) => { b.def *= 1.15; } },
      { need: 4, text: '生命 +15%', apply: (b) => { b.hp *= 1.15; } },
      { need: 6, text: '受到伤害 -7.5%', apply: (b) => { b.dr += 0.075; } },
    ],
  },
  stage: {
    name: '征伐', cls: 'set-stage',
    pieces: {
      weapon: '征伐·破阵刀', armor: '征伐·百战袍', helm: '征伐·将军盔',
      boots: '征伐·疾风靴', artifact: '征伐·虎符', talisman: '征伐·帅旗',
      bracelet: '征伐·擒龙镯', ring: '征伐·点将戒', wrist: '征伐·伏虎腕',
      legs: '征伐·追电腿', band: '征伐·束发箍', wings: '征伐·掠风翼',
    },
    bonuses: [
      { need: 2, text: '攻击 +10%', apply: (b) => { b.atk *= 1.1; } },
      { need: 4, text: '暴击率 +4%', apply: (b) => { b.crit += 0.04; } },
      { need: 6, text: '攻击 +17.5%', apply: (b) => { b.atk *= 1.175; } },
    ],
  },
  wild: {
    name: '荒狩', cls: 'set-wild',
    pieces: {
      weapon: '荒狩·噬骨矛', armor: '荒狩·兽皮甲', helm: '荒狩·狼首冠',
      boots: '荒狩·追风靴', artifact: '荒狩·兽王骨', talisman: '荒狩·猎魂幡',
      bracelet: '荒狩·兽牙镯', ring: '荒狩·狼瞳戒', wrist: '荒狩·熊筋腕',
      legs: '荒狩·猎风腿', band: '荒狩·兽骨箍', wings: '荒狩·鹰翎翼',
    },
    bonuses: [
      { need: 2, text: '生命 +10%', apply: (b) => { b.hp *= 1.1; } },
      { need: 4, text: '攻击 +7.5%', apply: (b) => { b.atk *= 1.075; } },
      { need: 6, text: '攻击吸血 6%', apply: (b) => { b.lifesteal += 0.06; } },
    ],
  },
};

const randEl = () => ELEMENTS[Math.floor(Math.random() * ELEMENTS.length)].key;

function rollAffixValue(def, r) {
  const v = (def.min + Math.random() * (def.max - def.min)) * (AFFIX_QMULT[r] || 1);
  return Math.round(v * 1000) / 1000;
}

function rollAffixes(r) {
  const n = AFFIX_COUNT[r] || 0;
  const pool = AFFIXES.slice();
  const out = [];
  while (out.length < n && pool.length) {
    const def = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    out.push({ k: def.k, v: rollAffixValue(def, r) });
  }
  return out;
}

// 普通装备生成。itemSeq 由调用方注入（客户端 state.itemSeq / 服务端发号器），
// 钳制口径：power ≤ BASE_POWER[r]×1.3（与 validateItem 上界同界，随机只向下取）
export function makeItem(ri, slotKey, itemSeq) {
  const slotDef = slotKey ? SLOT_MAP[slotKey] : SLOTS[Math.floor(Math.random() * SLOTS.length)];
  const pool = ITEM_NAMES[slotDef.key][ri];
  const name = pool[Math.floor(Math.random() * pool.length)];
  const cap = Math.round(BASE_POWER[ri] * 1.3);
  const power = Math.min(cap, Math.max(1, Math.round(BASE_POWER[ri] * (0.8 + Math.random() * 0.4))));
  return {
    id: itemSeq(),
    r: ri,
    slot: slotDef.key,
    name,
    power,
    el: randEl(),
    affixes: rollAffixes(ri),
  };
}

// 开箱品质 roll（气运权重）。luckWeights = weights() 的服务端口径（game.js weights 同源：
// RARITIES.weight × (1+0.02·luckLv)^i），由调用方传 luckLv。
export function rollRarity(luckLv) {
  const m = 1 + 0.02 * (luckLv || 0);
  const w = RARITIES.map((r, i) => r.weight * Math.pow(m, i));
  let total = 0;
  for (const x of w) total += x;
  let roll = Math.random() * total;
  for (let i = 0; i < w.length; i++) {
    roll -= w[i];
    if (roll <= 0) return i;
  }
  return 0;
}

// 套装件战力：mult = tower 0.12 / stage 0.13 / wild 0.14（game.js specialPower 同源）
export function specialPower(mode, level, contentReqFn) {
  const mult = mode === 'tower' ? 0.12 : mode === 'stage' ? 0.13 : 0.14;
  const base = 20 + contentReqFn(mode, level) * mult;
  return Math.max(1, Math.round(base * (0.9 + Math.random() * 0.2)));
}

// 套装件生成（战斗/里程碑掉落）。兜底命名与客户端一致（validateItem 拒非字符串名）
export function makeSpecialItem(mode, level, slotKey, itemSeq, contentReqFn) {
  const slotDef = SLOT_MAP[slotKey] || SLOTS[Math.floor(Math.random() * SLOTS.length)];
  const set = SETS[mode];
  const pieceName = set.pieces[slotDef.key] || (set.name + '·' + slotDef.name);
  return {
    id: itemSeq(),
    r: 5,
    slot: slotDef.key,
    name: pieceName,
    power: specialPower(mode, level, contentReqFn),
    el: randEl(),
    affixes: rollAffixes(5),
    special: true,
    setKey: mode,
    source: mode,
    sourceLevel: level,
  };
}
