// 服务端战斗复算（2026-10-31）：与 game.js 的 simulateBattle / bossEnemyOf 逐行同源移植。
// 上游以 game.js 为唯一数值口径——客户端战斗公式若改动，本文件必须同步，否则
// PvP 胜负与妖王伤害的「客户端表现」和「服务端结算」会出现口径漂移。
// 用途：/api/pvp/fight 的胜负、/api/boss/hit 与 /api/guild/boss/hit 的伤害一律由
// 服务端用双方快照复算，客户端上报的 win / damage 不再采信。
// 随机数用服务端 Math.random：客户端无法预测单场结果，也无法复现对账（设计取舍）。
//
// 2026-11-01 全量服务端校验迁移 P0/P1 扩展：征战四模式的完整战斗核心同源移植——
// MODES 难度表 / contentReq 分段曲线 / enemyFor 怪物生成 / playerCombatStats 玩家面板
// 全量聚合 / elementBonus 五行克制 / 结算公式（stoneGain/expGain/trophy）。
// 同源断言：scripts/parity-check.mjs 用同一份存档分别跑客户端与服务端函数比对。

import { SETS, SLOTS } from './items.js';

// 竞技场快照结构：{atk, hp, def, crit, critMult, lifesteal, dr, pierce}
// 2026-11-01 P1 起征战四模式也走本函数：补 events 逐回合记录 + playerHp/enemyHp
// 初始血量 + timeout（与 game.js simulateBattle 同字段），客户端战斗弹窗动画/战报
// 直接消费服务端战报；PvP/妖王路径多出的字段忽略即可。
export function simulateBattle(player, enemy) {
  let php = player.hp;
  let ehp = enemy.hp;
  let rounds = 0;
  let dealt = 0;
  let taken = 0;
  let crits = 0;
  const events = [];

  while (php > 0 && ehp > 0 && rounds < 120) {
    rounds++;

    const crit = Math.random() < player.crit;
    let dmg = Math.max(1, player.atk - enemy.def * (1 - player.pierce));
    dmg *= 0.9 + Math.random() * 0.2;
    if (crit) dmg *= player.critMult;
    dmg = Math.max(1, Math.floor(dmg));

    ehp -= dmg;
    dealt += dmg;
    if (crit) crits++;
    let heal = 0;
    if (player.lifesteal > 0) {
      heal = Math.floor(dmg * player.lifesteal);
      php = Math.min(player.hp, php + heal);
    }
    events.push({
      side: 'player', round: rounds, damage: dmg, crit, heal,
      playerHp: Math.max(0, php), enemyHp: Math.max(0, ehp),
    });
    if (ehp <= 0) break;

    const edmg = Math.max(1, Math.floor(Math.max(1, enemy.atk - player.def) * (1 - player.dr)));
    php -= edmg;
    taken += edmg;
    events.push({
      side: 'enemy', round: rounds, damage: edmg,
      playerHp: Math.max(0, php), enemyHp: Math.max(0, ehp),
    });
  }

  return {
    win: ehp <= 0 && php > 0,
    timeout: rounds >= 120 && ehp > 0 && php > 0,
    rounds,
    dealt,
    taken,
    crits,
    hpLeft: Math.max(0, Math.floor(php)),
    enemyLeft: Math.max(0, Math.floor(ehp)),
    events,
    playerHp: Math.floor(player.hp),
    enemyHp: Math.floor(enemy.hp),
  };
}

// 世界/盟主妖王战力随血池伸缩（game.js bossEnemyOf / guildBossEnemyOf，两处同款）
export function bossEnemyOf(maxHp) {
  const s = Math.sqrt(maxHp || 1);
  return { hp: 1e15, atk: s * 0.5, def: s * 0.04, crit: 0.05, critMult: 2, lifesteal: 0, dr: 0, pierce: 0 };
}

/* ============================================================
 * 征战战斗核心（P0/P1 移植，game.js 同源常量与公式）
 * ============================================================ */

export const TOWER_MAX = 200;
export const STAGE_MAX = 200;
export const WILD_MAX = 200;
export const ENDLESS_GATE = 60;      // 通塔 60 层开启无尽（老口径）
export const COMBAT_CRIT_MULT = 1.75;
export const GROWTH_SCALE = 0.25;    // 百分比加成保留比例
export const CRIT_CAP = 0.4;
export const ENEMY_DIFF = 3.0;       // 敌人强度总乘区
export const ENEMY_HARD_STEP = 1.008;
export const CURVE_LEGACY = { stage: 30, tower: 60, wild: 12 };
export const CURVE_TAIL = { stage: 1.055, tower: 1.06, wild: 1.055 };
export const MODE_EXP_MULT = 1 / 50; // 四秘境修为 nerf（2026-11-01 用户指定）
export const TREASURE_DROP = 0.05;   // 每场秘境征战胜利的残片掉率
export const WILD_SET_PITY = 50;     // 野外本区击杀保底
export const WILD_SET_RATE = 0.008;  // 野外每场随机掉率
export const MODE_SET_RATE = 0.008;  // 无尽 / 复战扫荡掉率
export const SWEEP_DAILY_FREE = 10;
export const SWEEP_BUY_MAX = 30;
export const SWEEP_BUY_COST = 200000;
export const WILD_REPEAT_DAILY = 50;
export const MILESTONE_SLOTS = ['weapon', 'armor', 'helm', 'boots', 'artifact', 'talisman',
  'bracelet', 'ring', 'wrist', 'legs', 'band', 'wings'];
export const MILESTONES = { tower: {}, stage: {}, wild: {} };
for (let lv = 10; lv <= TOWER_MAX; lv += 10) MILESTONES.tower[lv] = MILESTONE_SLOTS[(lv / 10 - 1) % MILESTONE_SLOTS.length];
for (let lv = 5; lv <= STAGE_MAX; lv += 5) MILESTONES.stage[lv] = MILESTONE_SLOTS[(lv / 5 - 1) % MILESTONE_SLOTS.length];
for (let lv = 1; lv <= WILD_MAX; lv += 2) MILESTONES.wild[lv] = MILESTONE_SLOTS[((lv - 1) / 2) % MILESTONE_SLOTS.length];

export const MODES = {
  tower: {
    key: 'tower', name: '爬塔', max: TOWER_MAX,
    reqBase: 60, reqGrowth: 1.16,
    hp: 7.5, atk: 0.75, def: 0.22,
    bossHp: 1.7, bossAtk: 1.35,
    stone: 6, exp: 0.7, trophyStep: 10,
  },
  stage: {
    key: 'stage', name: '闯关', max: STAGE_MAX,
    reqBase: 15, reqGrowth: 1.38,
    hp: 7.2, atk: 0.72, def: 0.2,
    bossHp: 1.65, bossAtk: 1.32,
    stone: 5, exp: 0.8, trophyStep: 5,
  },
  wild: {
    key: 'wild', name: '野外', max: WILD_MAX,
    reqBase: 30, reqGrowth: 1.9,
    hp: 6.8, atk: 0.68, def: 0.18,
    bossHp: 1.5, bossAtk: 1.25,
    stone: 3.5, exp: 0.45, trophyStep: 3,
  },
  endless: {
    key: 'endless', name: '无尽', max: Infinity,
    reqBase: 60, reqGrowth: 1.16,
    hp: 7.5, atk: 0.75, def: 0.22,
    bossHp: 1.7, bossAtk: 1.35,
    stone: 7, exp: 0.8, trophyStep: 5,
  },
};

// 无尽词缀：按 (层数-1) % 3 轮换
const ENCHANTS = [
  { name: '坚壁', desc: '敌方防御 ×1.6', def: 1.6 },
  { name: '狂暴', desc: '敌方攻击 ×1.35', atk: 1.35 },
  { name: '厚血', desc: '敌方生命 ×1.5', hp: 1.5 },
];

// 战功（trophy）落点字段：tower/endless 产塔印、stage 产战功、wild 产兽骨
export const TROPHY_FIELDS = {
  tower: 'towerMarks', stage: 'warMerits', wild: 'beastBones', endless: 'towerMarks',
};

// —— 怪物名表（纯展示，与 game.js 同源） ——

const TOWER_MONSTERS = [
  { name: '守塔石傀', icon: '石' }, { name: '青铜甲士', icon: '铜' },
  { name: '噬灵藤妖', icon: '藤' }, { name: '幽影剑客', icon: '影' },
  { name: '赤瞳妖僧', icon: '僧' }, { name: '铁脊狼王', icon: '狼' },
  { name: '玄冰傀儡', icon: '冰' }, { name: '焚天火灵', icon: '火' },
  { name: '无面刑者', icon: '刑' }, { name: '天关卫将', icon: '将' },
];
const TOWER_BOSSES = [
  { name: '玄铁镇塔将', icon: '镇' }, { name: '赤焰塔主', icon: '焰' },
  { name: '九幽塔主', icon: '幽' }, { name: '太虚塔主', icon: '虚' },
  { name: '天罡塔主', icon: '罡' }, { name: '镇塔仙君', icon: '仙' },
  { name: '玄天塔主', icon: '玄' }, { name: '紫霄塔主', icon: '紫' },
  { name: '万魔塔主', icon: '魔' }, { name: '灭世塔主', icon: '灭' },
  { name: '鸿蒙塔主', icon: '鸿' }, { name: '混沌塔主', icon: '混' },
  { name: '太初塔主', icon: '初' }, { name: '永夜塔主', icon: '夜' },
  { name: '星陨塔主', icon: '陨' }, { name: '黄泉塔主', icon: '泉' },
  { name: '九阳塔主', icon: '阳' }, { name: '北冥塔主', icon: '冥' },
  { name: '无极塔主', icon: '极' }, { name: '归墟塔主', icon: '墟' },
];
const STAGE_CHAPTERS = [
  { name: '青石古道', icon: '山', monsters: ['山贼', '青蛇', '灰狼'], boss: '占山虎王' },
  { name: '幽篁林', icon: '竹', monsters: ['竹妖', '毒蛛', '林魈'], boss: '千年竹母' },
  { name: '赤炎峡', icon: '炎', monsters: ['火鼠', '炎蜥', '熔岩鬼'], boss: '赤炎魔君' },
  { name: '寒霜原', icon: '霜', monsters: ['雪狼', '冰魄', '霜巨人'], boss: '寒霜王' },
  { name: '九霄阶', icon: '雷', monsters: ['雷鹏', '云将', '天兵'], boss: '九霄雷帝' },
  { name: '天外墟', icon: '墟', monsters: ['星兽', '虚空影', '古神卫'], boss: '天外墟主' },
];
const CHAPTER_TIERS = ['幽冥', '煞血', '古神', '仙殛', '神墟', '混沌', '鸿蒙', '太初'];
const CHAPTER_PLACES = ['渊', '狱', '冢', '海', '壑', '疆', '界', '墟'];
const CHAPTER_MOBS = ['魔卒', '邪灵', '骨将', '修罗', '噬心鬼', '灭魂使', '坠仙', '渊兽', '夜叉', '石像鬼', '血瞳', '傀儡师'];
const CHAPTER_BOSSES = ['冥渊魔君', '血海妖皇', '古神遗裔', '殛仙使者', '神墟之主', '混沌巨兽', '鸿蒙道影', '太初凶神'];
const CHAPTER_ZH = ['', '二', '三', '四', '五', '六'];
for (let i = 0; i < 34; i++) {
  const tier = CHAPTER_TIERS[i % 8];
  const cyc = Math.floor(i / 8);
  STAGE_CHAPTERS.push({
    name: tier + CHAPTER_PLACES[(i + (cyc > 0 ? 3 : 0)) % 8] + (cyc ? ' · ' + CHAPTER_ZH[cyc + 1] : ''),
    icon: tier[0],
    monsters: [0, 1, 2].map((j) => tier + CHAPTER_MOBS[(i * 3 + j) % CHAPTER_MOBS.length]),
    boss: CHAPTER_BOSSES[i % 8] + (cyc ? '·' + CHAPTER_ZH[cyc + 1] : ''),
  });
}

const WILD_BASE_ZONES = [
  { name: '雾隐林', monster: '青狼', icon: '狼' },
  { name: '枯骨坡', monster: '尸鹫', icon: '鹫' },
  { name: '黑水泽', monster: '毒鳄', icon: '鳄' },
  { name: '赤沙丘', monster: '沙蝎', icon: '蝎' },
  { name: '断魂谷', monster: '幽魂', icon: '魂' },
  { name: '寒松岭', monster: '雪熊', icon: '熊' },
  { name: '雷鸣泽', monster: '雷蟒', icon: '蟒' },
  { name: '焚风原', monster: '火狮', icon: '狮' },
  { name: '星陨坑', monster: '星兽', icon: '星' },
  { name: '九幽渊', monster: '冥龙', icon: '龙' },
  { name: '天裂谷', monster: '虚空兽', icon: '虚' },
  { name: '太初荒', monster: '太古兽王', icon: '荒' },
];
// 一级一区域：12 大区域为基底、20 级一档叠加时代前缀，扩到 200（game.js 同款规则）
export const WILD_ZONES = WILD_BASE_ZONES.slice();
{
  const WILD_TIERS = ['幽', '煞', '狂', '古', '仙', '神', '虚空', '混沌', '鸿蒙', '太初'];
  for (let lv = WILD_BASE_ZONES.length + 1; lv <= WILD_MAX; lv++) {
    const base = WILD_BASE_ZONES[(lv - 1) % 12];
    const tier = WILD_TIERS[Math.floor((lv - 13) / 20)];
    WILD_ZONES.push({ name: tier + base.name, monster: tier + base.monster, icon: base.icon });
  }
}

// —— 难度曲线 / 敌人生成 ——

const REQ_TABLE = {};
for (const curveKey of ['stage', 'tower', 'wild']) {
  const cfg = MODES[curveKey];
  const legacy = CURVE_LEGACY[curveKey];
  const arr = new Array(STAGE_MAX + 1);
  arr[1] = cfg.reqBase;
  for (let lv = 2; lv <= STAGE_MAX; lv++) {
    arr[lv] = lv <= legacy
      ? cfg.reqBase * Math.pow(cfg.reqGrowth, lv - 1)
      : arr[lv - 1] * CURVE_TAIL[curveKey];
  }
  REQ_TABLE[curveKey] = arr;
}

const immortalMultOf = (data) => Math.pow(1.05, (data && data.immortal) || 0);

export function contentReq(mode, level, data) {
  const cfg = MODES[mode];
  const table = REQ_TABLE[mode];
  if (!table) return cfg.reqBase * Math.pow(cfg.reqGrowth, Math.max(0, level - 1)) * immortalMultOf(data);
  const lv = Math.max(1, Math.min(STAGE_MAX, level | 0));
  return table[lv] * immortalMultOf(data);
}

export const isBoss = (mode, level) => {
  if (mode === 'tower' || mode === 'endless') return level % 10 === 0;
  if (mode === 'stage') return level % 5 === 0;
  return level % 4 === 0 || level === WILD_MAX;
};

const diffBoost = (mode, level) => Math.pow(ENEMY_HARD_STEP, Math.min(level | 0, 300));

export const recommendedPower = (mode, level, data) =>
  Math.ceil(contentReq(mode, level, data) * (isBoss(mode, level) ? 1.35 : 1) * ENEMY_DIFF * diffBoost(mode, level));

const ELEMENT_BEATS = { jin: 'mu', mu: 'tu', tu: 'shui', shui: 'huo', huo: 'jin' };
const randEl = () => ['jin', 'mu', 'shui', 'huo', 'tu'][Math.floor(Math.random() * 5)];

// 怪物生成（game.js enemyFor 同源）。el 为服务端随机——客户端不预知。
export function enemyFor(mode, level, data) {
  const cfg = MODES[mode];
  const boss = isBoss(mode, level);
  const req = contentReq(mode, level, data);
  let name = '';
  let icon = '妖';
  let kicker = '';
  let affDef = null;

  if (mode === 'tower') {
    const source = boss
      ? TOWER_BOSSES[Math.min(TOWER_BOSSES.length - 1, Math.floor((level - 1) / 10))]
      : TOWER_MONSTERS[(level - 1) % TOWER_MONSTERS.length];
    name = source.name;
    icon = source.icon;
    kicker = '镇塔 · 第 ' + level + ' 层';
  } else if (mode === 'stage') {
    const chapter = STAGE_CHAPTERS[Math.min(STAGE_CHAPTERS.length - 1, Math.floor((level - 1) / 5))];
    name = boss ? chapter.boss : chapter.monsters[(level - 1) % chapter.monsters.length];
    icon = chapter.icon;
    kicker = chapter.name + ' · 第 ' + level + ' 关';
  } else if (mode === 'endless') {
    const source = boss
      ? TOWER_BOSSES[Math.floor((level - 1) / 10) % TOWER_BOSSES.length]
      : TOWER_MONSTERS[(level - 1) % TOWER_MONSTERS.length];
    affDef = ENCHANTS[(level - 1) % ENCHANTS.length];
    name = affDef.name + '·' + source.name;
    icon = source.icon;
    kicker = '无尽 · 第 ' + level + ' 层 · ' + affDef.name;
  } else {
    const zone = WILD_ZONES[Math.min(WILD_ZONES.length - 1, level - 1)];
    name = zone.monster;
    icon = zone.icon;
    kicker = zone.name + ' · 危险度 ' + level;
  }

  const aff = affDef;
  return {
    name, base: name, icon, kicker, boss, req,
    el: randEl(),
    affix: aff ? aff.name + '：' + aff.desc : '',
    hp: Math.max(1, Math.round(req * cfg.hp * ENEMY_DIFF * diffBoost(mode, level) * (boss ? cfg.bossHp : 1) * (aff && aff.hp ? aff.hp : 1))),
    atk: Math.max(1, Math.round(req * cfg.atk * ENEMY_DIFF * diffBoost(mode, level) * (boss ? cfg.bossAtk : 1) * (aff && aff.atk ? aff.atk : 1))),
    def: Math.max(0, Math.round(req * cfg.def * ENEMY_DIFF * diffBoost(mode, level) * (boss ? 1.12 : 1) * (aff && aff.def ? aff.def : 1))),
  };
}

// —— 玩家面板全量聚合（game.js playerCombatStats 同源；data = 存档镜像 JSON） ——

const GEM_VALUES = {
  atk: [0.02, 0.04, 0.07],
  hp: [0.03, 0.06, 0.10],
  def: [0.03, 0.05, 0.08],
  crit: [0.008, 0.015, 0.025],
  ls: [0.008, 0.015, 0.025],
  pierce: [0.01, 0.02, 0.035],
};
const gemValue = (g) => (GEM_VALUES[g.k] ? GEM_VALUES[g.k][g.t - 1] || 0 : 0);

const RESONANCE = [
  { need: 3, pct: 0.05, flat: 0.02 },
  { need: 5, pct: 0.12, flat: 0.05 },
];
const RUNEWORDS = [
  { seq: ['atk', 'hp'], apply: { atk: 0.03, hp: 0.03 } },
  { seq: ['crit', 'pierce'], apply: { pierce: 0.04 } },
  { seq: ['ls', 'def'], apply: { dr: 0.03 } },
  { seq: ['atk', 'atk', 'atk'], apply: { atk: 0.08 } },
  { seq: ['hp', 'hp', 'hp'], apply: { hp: 0.08 } },
  { seq: ['crit', 'ls', 'pierce'], apply: { atk: 0.05, hp: 0.05 } },
];
const PETS = [
  { id: 'fox', stat: 'atk', per: 0.02 },
  { id: 'turtle', stat: 'hp', per: 0.025 },
  { id: 'rat', stat: 'crit', per: 0.004 },
  { id: 'pixiu', stat: 'gain', per: 0.03 },
];
const CORE_TRAITS = {
  fox: [
    { lv: 3, stat: 'atk', v: 0.03 }, { lv: 6, stat: 'crit', v: 0.01 }, { lv: 10, stat: 'atk', v: 0.05 },
  ],
  turtle: [
    { lv: 3, stat: 'hp', v: 0.04 }, { lv: 6, stat: 'dr', v: 0.01 }, { lv: 10, stat: 'hp', v: 0.06 },
  ],
  rat: [
    { lv: 3, stat: 'crit', v: 0.01 }, { lv: 6, stat: 'pierce', v: 0.02 }, { lv: 10, stat: 'crit', v: 0.02 },
  ],
  pixiu: [
    { lv: 3, stat: 'stone', v: 0.04 }, { lv: 6, stat: 'dust', v: 0.04 }, { lv: 10, stat: 'stone', v: 0.06 },
  ],
};
const SHICHEN = [
  { dust: 1.3 }, {},
  { atk: 0.05 }, { gain: 0.10 }, { crit: 0.02 },
  { gain: 0.10 }, { stone: 1.10 }, {},
  { pierce: 0.03 }, { pet: 2 }, { def: 0.05 }, {},
];
const SKIES = [
  { name: '晴空万里' },
  { name: '雷雨交加', atk: 1.08 },
  { name: '皓月当空', dust: 1.2 },
  { name: '紫气东来', gain: 0.10 },
  { name: '天高云淡', stone: 1.10 },
  { name: '繁星满天', crit: 0.02 },
  { name: '妖云压城', pierce: 0.03, pet: 2 },
];
const DAO_BONUS = { qing: { gain: 0.08 }, bai: { atk: 0.05 }, shi: { hp: 0.06 } };
const WEEK_BUFF_IDS = ['dust', 'stone', 'pet', 'forge'];

const dayStrOf = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const shichenNow = () => SHICHEN[Math.floor(((new Date().getHours() + 1) % 24) / 2)];
const skyNow = () => {
  const s = dayStrOf(new Date());
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return SKIES[h % SKIES.length];
};
const weekStoneOn = () => {
  const d = new Date();
  const w = Math.floor((d - new Date(d.getFullYear(), 0, 1)) / (7 * 86400000));
  return WEEK_BUFF_IDS[w % WEEK_BUFF_IDS.length] === 'stone';
};

function runewordOf(gems) {
  const list = (gems || []).filter(Boolean);
  if (list.length < 2) return null;
  for (const w of RUNEWORDS) {
    if (w.seq.length === list.length && w.seq.every((k, i) => list[i].k === k)) return w;
  }
  return null;
}

export function totalPowerOf(data) {
  let p = 0;
  for (const s of SLOTS) {
    const it = data.equipped && data.equipped[s.key];
    if (it) p += Math.round(it.power * (1 + 0.1 * (it.star || 0))) * (1 + 0.18 * ((data.enh && data.enh[s.key]) || 0));
  }
  return Math.round(p);
}

// env: { now, guildLevel }（now 用于时辰/丹药到期；guildLevel = 仙盟等级加成，缺省 0）
export function playerCombatStats(data, env) {
  const now = (env && env.now) || Date.now();
  const guildLevel = (env && env.guildLevel) || 0;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const realm = num(data.realm);
  const ascensions = num(data.ascensions);
  const power = totalPowerOf(data);

  let atk = 16 + power * 0.9;
  let hp = 120 + power * 5.5;
  let def = 3 + power * 0.28;
  let crit = 0.1;
  const critMult = COMBAT_CRIT_MULT;
  let lifesteal = 0;
  let dr = 0;
  let pierce = 0.015 * num(data.trainPierce);

  atk *= 1 + 0.12 * realm;
  hp *= 1 + 0.15 * realm;
  def *= 1 + 0.10 * realm;

  const ascMult = 1 + 0.08 * ascensions;
  atk *= ascMult;
  hp *= ascMult;

  const agg = { atk: 0, hp: 0, def: 0, crit: 0, ls: 0, pierce: 0 };
  for (const s of SLOTS) {
    const it = data.equipped && data.equipped[s.key];
    if (it) {
      for (const a of it.affixes || []) {
        if (agg[a.k] !== undefined) agg[a.k] += a.v || 0;
      }
    }
    const gems = (data.slotGems && data.slotGems[s.key]) || [];
    for (const g of gems) {
      if (g && agg[g.k] !== undefined) agg[g.k] += gemValue(g);
    }
  }
  atk *= 1 + agg.atk * GROWTH_SCALE;
  hp *= 1 + agg.hp * GROWTH_SCALE;
  def *= 1 + agg.def * GROWTH_SCALE;
  crit += agg.crit * GROWTH_SCALE;
  lifesteal += agg.ls * GROWTH_SCALE;
  pierce += agg.pierce * GROWTH_SCALE;

  // 灵宠出战 / 图鉴收集 / 功法 / 内丹 / 丹药 / 怪物图鉴
  let colCombat = 0;
  for (const key of Object.keys(SETS)) {
    const coll = (data.setCollection && data.setCollection[key]) || [];
    if (coll.length >= 4) colCombat += 0.08;
  }
  let petAtk = 0;
  let petHp = 0;
  let petCrit = 0;
  for (const id of data.activePets || []) {
    const def = PETS.find((p) => p.id === id);
    if (!def || !data.pets || data.pets[id] === undefined) continue;
    const bonus = def.per * num(data.pets[id]) + 0.005 * num(data.petTokens && data.petTokens[id]);
    if (def.stat === 'atk') petAtk += bonus;
    else if (def.stat === 'hp') petHp += bonus;
    else if (def.stat === 'crit') petCrit += bonus;
  }
  let coreAtk = 0;
  let coreHp = 0;
  let coreCrit = 0;
  let coreDr = 0;
  let corePierce = 0;
  for (const id of data.activePets || []) {
    const coreLv = num(data.petCores && data.petCores[id]);
    if (!coreLv) continue;
    for (const t of CORE_TRAITS[id] || []) {
      if (coreLv >= t.lv) {
        if (t.stat === 'atk') coreAtk += t.v;
        else if (t.stat === 'hp') coreHp += t.v;
        else if (t.stat === 'crit') coreCrit += t.v;
        else if (t.stat === 'dr') coreDr += t.v;
        else if (t.stat === 'pierce') corePierce += t.v;
      }
    }
  }
  const gongfa = data.gongfa || {};
  atk *= 1 + (petAtk + 0.02 * num(gongfa.atk)) * GROWTH_SCALE + colCombat;
  hp *= 1 + (petHp + 0.02 * num(gongfa.hp)) * GROWTH_SCALE + colCombat;
  crit += petCrit * GROWTH_SCALE;
  atk *= 1 + coreAtk * GROWTH_SCALE;
  hp *= 1 + coreHp * GROWTH_SCALE;
  crit += coreCrit * GROWTH_SCALE;
  dr += coreDr * GROWTH_SCALE;
  pierce += corePierce * GROWTH_SCALE;
  const elixir = data.elixir || {};
  const elixirOn = (id) => elixir.id === id && now < num(elixir.until);
  def *= elixirOn('def') ? 1.2 : 1;
  atk *= elixirOn('atk') ? 1.15 : 1;
  const species = Object.keys(data.bestiary || {}).length;
  if (species >= 5) {
    const beastMult = 1 + 0.005 * Math.floor(species / 5);
    atk *= beastMult;
    hp *= beastMult;
  }

  // 词条共鸣：同词条 3/5 条触发（pct 走乘区、flat 直加）
  const affCounts = {};
  for (const s of SLOTS) {
    const it = data.equipped && data.equipped[s.key];
    if (!it) continue;
    for (const a of it.affixes || []) affCounts[a.k] = (affCounts[a.k] || 0) + 1;
  }
  for (const k of Object.keys(affCounts)) {
    let pct = 0;
    let flat = 0;
    for (const r of RESONANCE) {
      if (affCounts[k] >= r.need) { pct = r.pct; flat = r.flat; }
    }
    if (!(pct > 0)) continue;
    if (k === 'atk') atk *= 1 + pct;
    else if (k === 'hp') hp *= 1 + pct;
    else if (k === 'def') def *= 1 + pct;
    else if (k === 'crit') crit += flat;
    else if (k === 'ls') lifesteal += flat;
    else if (k === 'pierce') pierce += flat;
  }

  // 挑战修行永久乘区
  let ordealAtk = 0;
  let ordealHp = 0;
  const ordealDone = data.ordealDone || [];
  if (ordealDone.includes('wuJiang')) { ordealAtk += 0.06; ordealHp += 0.06; }
  if (ordealDone.includes('kuXing')) ordealAtk += 0.06;
  atk *= 1 + ordealAtk;
  hp *= 1 + ordealHp;

  // 符文组词 + 时辰 + 天象 + 道侣
  const rune = { atk: 0, hp: 0, def: 0, dr: 0, crit: 0, ls: 0, pierce: 0 };
  for (const s of SLOTS) {
    const w = runewordOf((data.slotGems && data.slotGems[s.key]) || []);
    if (w) for (const k of Object.keys(w.apply)) rune[k] += w.apply[k];
  }
  atk *= 1 + rune.atk;
  hp *= 1 + rune.hp;
  def *= 1 + rune.def;
  dr += rune.dr;
  crit += rune.crit;
  lifesteal += rune.ls;
  pierce += rune.pierce;
  const sc = shichenNow();
  if (sc.atk) atk *= 1.05;
  if (sc.def) def *= 1.05;
  if (sc.pierce) pierce += sc.pierce;
  const sky = skyNow();
  if (sky.atk) atk *= sky.atk;
  if (sky.pierce) pierce += sky.pierce;
  const daoMarried = data.daoLv && data.daoLv.married;
  const dao = daoMarried && DAO_BONUS[daoMarried] ? DAO_BONUS[daoMarried] : {};
  atk *= 1 + (dao.atk || 0);
  hp *= 1 + (dao.hp || 0);

  // 套装战斗加成（穿戴件计数）
  const setCounts = { tower: 0, stage: 0, wild: 0 };
  for (const s of SLOTS) {
    const it = data.equipped && data.equipped[s.key];
    if (it && it.setKey && setCounts[it.setKey] !== undefined) setCounts[it.setKey]++;
  }
  const b = { atk, hp, def, crit, dr, lifesteal };
  for (const key of Object.keys(SETS)) {
    for (const bonus of SETS[key].bonuses) {
      if (setCounts[key] >= bonus.need) bonus.apply(b);
    }
  }

  // 修行（2026-11-01 口径：战意/体魄消费端 ×GROWTH_SCALE）
  atk = b.atk * (1 + 0.03 * GROWTH_SCALE * num(data.trainAtk));
  hp = b.hp * (1 + 0.03 * GROWTH_SCALE * num(data.trainHp));
  def = b.def;
  crit = Math.min(CRIT_CAP, b.crit);
  dr = Math.min(0.6, b.dr);
  lifesteal = Math.min(0.5, b.lifesteal);
  pierce = Math.min(0.6, pierce);

  return {
    power, atk, hp, def, crit, critMult, lifesteal,
    dr, pierce: Math.min(1, pierce), counts: setCounts,
  };
}

// 五行克制（game.js elementBonus 同源）
export function elementBonusOf(data, enemyEl) {
  let fav = 0;
  let adv = 0;
  if (enemyEl && ELEMENT_BEATS[enemyEl]) {
    for (const s of SLOTS) {
      const it = data.equipped && data.equipped[s.key];
      if (!it || !it.el) continue;
      if (ELEMENT_BEATS[it.el] === enemyEl) fav++;
      else if (ELEMENT_BEATS[enemyEl] === it.el) adv++;
    }
  }
  return { fav, adv, mult: Math.max(0.9, 1 + 0.03 * fav - 0.02 * adv) };
}

// —— 离线结算（game.js expected()/baseGain 同源；data = 存档镜像） ——

const RARITY_WEIGHTS = [1000, 350, 100, 25, 2, 0.4];
const RARITY_EXP = [0, 1, 3, 8, 20, 50];
const EQUIP_CHANCE = 0.01;

function weightsOf(data) {
  const m = 1 + 0.02 * (data.luckLv || 0);
  return RARITY_WEIGHTS.map((w, i) => w * Math.pow(m, i));
}

export function baseGainOf(data, env) {
  const now = (env && env.now) || Date.now();
  const guildLevel = (env && env.guildLevel) || 0;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const power = totalPowerOf(data);
  let colGain = 0;
  for (const key of Object.keys(SETS)) {
    const coll = (data.setCollection && data.setCollection[key]) || [];
    if (coll.length >= 2) colGain += 0.10;
    if (coll.length >= 6) colGain += 0.25;
  }
  let petGain = 0;
  for (const id of data.activePets || []) {
    const def = PETS.find((p) => p.id === id);
    if (!def || def.stat !== 'gain' || !data.pets || data.pets[id] === undefined) continue;
    petGain += def.per * num(data.pets[id]) + 0.005 * num(data.petTokens && data.petTokens[id]);
  }
  let museum = 0;
  for (const s of SLOTS) {
    const it = data.museum && data.museum[s.key];
    if (!it) continue;
    museum += (it.special || it.r >= 5) ? 0.02 : 0.01;
  }
  const realmMult = Math.pow(1.7, num(data.realm));
  const prestigeMult = 1 + 0.05 * num(data.ascensions);
  const powerMult = 1 + Math.sqrt(Math.max(0, power)) / 20;
  const caveGain = 0.08 * num(data.cave && data.cave.array);
  const sc = shichenNow();
  const sky = skyNow();
  const dao = data.daoLv && data.daoLv.married && DAO_BONUS[data.daoLv.married];
  const elixir = data.elixir || {};
  const elixirGain = elixir.id === 'gain' && now < num(elixir.until) ? 1.3 : 1;
  const ordealFanYi = (data.ordealDone || []).includes('fanYi') ? 0.10 : 0;
  return (3 + 0.9 * num(data.gainLv)) * realmMult * prestigeMult * powerMult
    * (1 + colGain + petGain + caveGain)
    * (1 + 0.1 * num(data.immortal))
    * (data.title ? 1.02 : 1)
    * (1 + museum + ordealFanYi)
    * (1 + (sc.gain || 0) + (sky.gain || 0) + ((dao && dao.gain) || 0))
    * (1 + 0.005 * guildLevel)
    * elixirGain;
}

export function expectedOf(data, env) {
  const w = weightsOf(data);
  let total = 0;
  let exp = 0;
  for (let i = 0; i < w.length; i++) {
    total += w[i];
    exp += w[i] * (1 + RARITY_EXP[i]);
  }
  return {
    stone: baseGainOf(data, env),
    exp: (1 - EQUIP_CHANCE) + EQUIP_CHANCE * exp / total,
  };
}

// addStones 增益链（game.js addStones 同源：周/时辰/天象/内丹）——战斗结算与
// 离线结算共用此一份实现；2026-11-01 起服务端算毕全额，客户端平加入账不二次放大
export function applyStoneBuffsOf(data, n0) {
  let n = n0;
  const parts = stoneBuffParts(data);
  if (parts.weekStone) n = Math.max(1, Math.floor(n * 1.2));
  if (parts.scStone) n = Math.max(1, Math.floor(n * parts.scStone));
  if (parts.skyStone) n = Math.max(1, Math.floor(n * parts.skyStone));
  if (parts.coreStone) n = Math.max(1, Math.floor(n * (1 + parts.coreStone)));
  return n;
}

function stoneBuffParts(data) {
  const d = new Date();
  const w = Math.floor((d - new Date(d.getFullYear(), 0, 1)) / (7 * 86400000));
  const weekStone = WEEK_BUFF_IDS[w % WEEK_BUFF_IDS.length] === 'stone';
  const sc = shichenNow();
  const sky = skyNow();
  let coreStone = 0;
  for (const id of (data && data.activePets) || []) {
    const coreLv = (data.petCores && data.petCores[id]) || 0;
    for (const t of CORE_TRAITS[id] || []) {
      if (coreLv >= t.lv && t.stat === 'stone') coreStone += t.v;
    }
  }
  return { weekStone, scStone: sc.stone || 0, skyStone: sky.stone || 0, coreStone };
}

// 结算公式（game.js doBattle stoneGain/expGain + addStones 增益同源）。
// 2026-11-01 起灵石全额在服务端算毕（含周/时辰/天象/内丹加成），客户端平加入账。
export function settleGain({ mode, level, first, rewardScale, boss, data, sweep }, env) {
  const cfg = MODES[mode];
  const bossScale = boss ? 1.8 : 1;
  const firstScale = first ? 1.5 : 1;
  const req = contentReq(mode, level, data);
  const weekend = env.weekend ? 2 : 1;
  const prod = env.prodMult || 1;
  const rawStone = Math.floor(
    req * cfg.stone * bossScale * firstScale * rewardScale * weekend * prod
  );
  const stoneGain = applyStoneBuffsOf(data, rawStone);

  const expMult = (1 + 0.10 * ((data.cave && data.cave.library) || 0)) *
    (1 + 0.05 * ((data.gongfa && data.gongfa.hui) || 0));
  // 征战修为统一 ×60（2026-11-01 用户指定三连改：扫荡×100 → 扫荡/首通×100 → 全路径×60）——
  // 扫荡/首通/复战同倍率；灵石不受此倍率影响。修为仅在服务端结算，客户端平加响应值
  const boostExpMult = 60;
  const expGain = Math.floor(
    req * cfg.exp * MODE_EXP_MULT * bossScale * firstScale * rewardScale * boostExpMult * expMult
  );

  let trophy = 1 + Math.floor(level / cfg.trophyStep);
  if (boss) trophy += 2;
  if (first) trophy += 2;
  return { stoneGain, expGain, trophy };
}

// 今日产出倍率（灵潮窗口 ×2 · 上上签 +5%，game.js dayProdMult 同源；服务端本地时）。
// FORTUNE_SIGNS[0]=上上签（prod 0.05，唯一带产出的签），idx 指向当日所抽签下标。
const TIDE_WINDOWS = [{ s: 12, e: 14 }, { s: 20, e: 22 }];
const TIDE_MULT = 2;
const FORTUNE_PROD = [0.05, 0, 0, 0];
export function dayProdMultOf(data) {
  const h = new Date().getHours();
  const tide = TIDE_WINDOWS.some((w) => h >= w.s && h < w.e) ? TIDE_MULT : 1;
  let fortune = 1;
  const f = data.fortune;
  if (f && f.date === dayStrOf(new Date()) && Array.isArray(f.claimed) && Number.isInteger(f.idx) && f.idx >= 0) {
    fortune = 1 + (FORTUNE_PROD[f.idx] || 0);
  }
  return tide * fortune;
}
