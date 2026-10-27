(() => {
  'use strict';

  /* ============================================================
   * 灵匣纪元 · Spirit Box Odyssey
   * 纯前端放置开箱游戏：背包、装备、战力、强化、离线收益，
   * 以及闯关 / 爬塔 / 野外三套秘境征战与专属套装。
   * 数值集中在下面几组常量里，方便自己改。
   * 「后续计划」见 HANDOFF.md，玩法说明见 README.md。
   * ============================================================ */

  const SAVE_KEY = 'lingxia_idle_v1';
  const OFFLINE_CAP = 4 * 3600;      // 离线收益最多结算 4 小时
  const OFFLINE_EFF = 0.5;           // 离线效率 50%
  const CRIT_CHANCE = 0.05;          // 暴击率
  const CRIT_MULT = 10;              // 暴击倍率
  const BUFF_CHANCE = 0.008;         // 每次开箱掉丹药的概率（未生效时）
  const BUFF_MS = 30000;             // 丹药持续时间
  const BAG_CAP = 60;                // 背包格数
  const MAX_ENHANCE = 20;            // 单件装备强化上限

  /* ---------------- 秘境征战 ---------------- */

  const TOWER_MAX = 60;
  const STAGE_MAX = 30;
  const WILD_MAX = 12;
  const MAX_TRAIN = 10;

  const MODES = {
    tower: {
      key: 'tower', name: '爬塔', max: TOWER_MAX,
      reqBase: 60, reqGrowth: 1.16,
      hp: 7.5, atk: 0.75, def: 0.22,
      bossHp: 1.45, bossAtk: 1.2,
      stone: 6, exp: 0.7, trophyStep: 10,
    },
    stage: {
      key: 'stage', name: '闯关', max: STAGE_MAX,
      reqBase: 15, reqGrowth: 1.38,
      hp: 7.2, atk: 0.72, def: 0.2,
      bossHp: 1.4, bossAtk: 1.18,
      stone: 5, exp: 0.8, trophyStep: 5,
    },
    wild: {
      key: 'wild', name: '野外', max: WILD_MAX,
      reqBase: 30, reqGrowth: 1.9,
      hp: 6.8, atk: 0.68, def: 0.18,
      bossHp: 1.3, bossAtk: 1.12,
      stone: 3.5, exp: 0.45, trophyStep: 3,
    },
  };

  const MILESTONES = {
    tower: { 10: 'weapon', 20: 'armor', 30: 'helm', 40: 'boots', 50: 'artifact', 60: 'talisman' },
    stage: { 5: 'weapon', 10: 'armor', 15: 'helm', 20: 'boots', 25: 'artifact', 30: 'talisman' },
    wild: { 1: 'weapon', 3: 'armor', 5: 'helm', 7: 'boots', 9: 'artifact', 11: 'talisman' },
  };

  const SETS = {
    tower: {
      name: '镇塔', cls: 'set-tower',
      pieces: {
        weapon: '镇塔·斩妖剑', armor: '镇塔·玄鳞甲', helm: '镇塔·观星冠',
        boots: '镇塔·踏云履', artifact: '镇塔·镇魂印', talisman: '镇塔·封魔符',
      },
      bonuses: [
        { need: 2, text: '防御 +30%', apply: (b) => { b.def *= 1.3; } },
        { need: 4, text: '生命 +30%', apply: (b) => { b.hp *= 1.3; } },
        { need: 6, text: '受到伤害 -15%', apply: (b) => { b.dr += 0.15; } },
      ],
    },
    stage: {
      name: '征伐', cls: 'set-stage',
      pieces: {
        weapon: '征伐·破阵刀', armor: '征伐·百战袍', helm: '征伐·将军盔',
        boots: '征伐·疾风靴', artifact: '征伐·虎符', talisman: '征伐·帅旗',
      },
      bonuses: [
        { need: 2, text: '攻击 +20%', apply: (b) => { b.atk *= 1.2; } },
        { need: 4, text: '暴击率 +8%', apply: (b) => { b.crit += 0.08; } },
        { need: 6, text: '攻击 +35%', apply: (b) => { b.atk *= 1.35; } },
      ],
    },
    wild: {
      name: '荒狩', cls: 'set-wild',
      pieces: {
        weapon: '荒狩·噬骨矛', armor: '荒狩·兽皮甲', helm: '荒狩·狼首冠',
        boots: '荒狩·追风靴', artifact: '荒狩·兽王骨', talisman: '荒狩·猎魂幡',
      },
      bonuses: [
        { need: 2, text: '生命 +20%', apply: (b) => { b.hp *= 1.2; } },
        { need: 4, text: '攻击 +15%', apply: (b) => { b.atk *= 1.15; } },
        { need: 6, text: '攻击吸血 12%', apply: (b) => { b.lifesteal += 0.12; } },
      ],
    },
  };

  const TROPHIES = {
    tower: { name: '塔印', field: 'towerMarks', color: '#fbbf24' },
    stage: { name: '战功', field: 'warMerits', color: '#60a5fa' },
    wild: { name: '兽骨', field: 'beastBones', color: '#4ade80' },
  };

  const TRAININGS = {
    atk: { name: '战意', desc: '攻击 +3% / 级', lvField: 'trainAtk', currency: 'towerMarks' },
    hp: { name: '体魄', desc: '生命 +3% / 级', lvField: 'trainHp', currency: 'warMerits' },
    pierce: { name: '破甲', desc: '无视敌人防御 +1.5% / 级', lvField: 'trainPierce', currency: 'beastBones' },
  };

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
  ];

  const STAGE_CHAPTERS = [
    { name: '青石古道', icon: '山', monsters: ['山贼', '青蛇', '灰狼'], boss: '占山虎王' },
    { name: '幽篁林', icon: '竹', monsters: ['竹妖', '毒蛛', '林魈'], boss: '千年竹母' },
    { name: '赤炎峡', icon: '炎', monsters: ['火鼠', '炎蜥', '熔岩鬼'], boss: '赤炎魔君' },
    { name: '寒霜原', icon: '霜', monsters: ['雪狼', '冰魄', '霜巨人'], boss: '寒霜王' },
    { name: '九霄阶', icon: '雷', monsters: ['雷鹏', '云将', '天兵'], boss: '九霄雷帝' },
    { name: '天外墟', icon: '墟', monsters: ['星兽', '虚空影', '古神卫'], boss: '天外墟主' },
  ];

  const WILD_ZONES = [
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

  const RARITIES = [
    { name: '凡品', color: '#9aa4b2', weight: 1000, stone: 1, exp: 0 },
    { name: '灵品', color: '#4ade80', weight: 350, stone: 3, exp: 1 },
    { name: '玄品', color: '#60a5fa', weight: 100, stone: 10, exp: 3 },
    { name: '地品', color: '#c084fc', weight: 25, stone: 35, exp: 8 },
    { name: '天品', color: '#fbbf24', weight: 5, stone: 150, exp: 20 },
    { name: '仙品', color: '#f87171', weight: 1, stone: 800, exp: 50 },
  ];

  const SLOTS = [
    { key: 'weapon', name: '武器', icon: '剑' },
    { key: 'armor', name: '衣袍', icon: '衣' },
    { key: 'helm', name: '冠冕', icon: '冠' },
    { key: 'boots', name: '云靴', icon: '靴' },
    { key: 'artifact', name: '法宝', icon: '宝' },
    { key: 'talisman', name: '灵符', icon: '符' },
  ];

  const SLOT_MAP = {};
  for (const s of SLOTS) SLOT_MAP[s.key] = s;

  // 每个部位、每个品质的装备名池
  const ITEM_NAMES = {
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
  };

  const BASE_POWER = [3, 10, 30, 90, 280, 900];

  const REALMS = ['炼气', '筑基', '金丹', '元婴', '化神', '炼虚', '合体', '大乘', '渡劫', '仙人'];
  const REALM_COSTS = [0, 60, 400, 2500, 15000, 80000, 400000, 2000000, 10000000, 40000000];

  const UPGRADES = {
    speed: { label: '开箱速度', base: 50, growth: 1.55, max: 40 },
    gain: { label: '灵石收益', base: 40, growth: 1.6, max: 100 },
    luck: { label: '气运', base: 150, growth: 1.7, max: 50 },
  };

  const $ = (id) => document.getElementById(id);

  const emptyEquipped = () => ({
    weapon: null, armor: null, helm: null, boots: null, artifact: null, talisman: null,
  });

  const defaults = () => ({
    stones: 0,
    totalStones: 0,
    exp: 0,
    opens: 0,
    realm: 0,
    ascensions: 0,
    speedLv: 0,
    gainLv: 0,
    luckLv: 0,
    counts: [0, 0, 0, 0, 0, 0],
    best: -1,
    buffUntil: 0,
    lastSeen: Date.now(),
    muted: false,
    log: [],
    bag: [],
    equipped: emptyEquipped(),
    itemSeq: 1,
    bagWarned: false,
    towerCleared: 0,
    stageCleared: 0,
    wildZone: 1,
    wildCleared: [],
    wildKills: {},
    towerMarks: 0,
    warMerits: 0,
    beastBones: 0,
    trainAtk: 0,
    trainHp: 0,
    trainPierce: 0,
    autoHunt: false,
  });

  let state = defaults();
  let acc = 0;
  let last = 0;
  let lastRender = 0;
  let lastSave = 0;
  let lastBagPaint = 0;
  let bagDirty = true;
  let equipDirty = true;
  let logDirty = true;
  let combatDirty = true;
  let uiMode = 'stage';
  let battleCooldownUntil = 0;
  let huntAcc = 0;
  let lastBattles = { tower: null, stage: null, wild: null };
  let audioCtx = null;

  /* ---------------- 存档 ---------------- */

  function persist() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    } catch (e) {
      /* 隐私模式或空间不足时忽略 */
    }
  }

  function save() {
    if (!document.hidden) state.lastSeen = Date.now();
    persist();
  }

  function load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      state = Object.assign(defaults(), data);

      if (!Array.isArray(state.counts) || state.counts.length !== RARITIES.length) {
        state.counts = [0, 0, 0, 0, 0, 0];
      }
      if (!Array.isArray(state.log)) state.log = [];
      state.realm = Math.max(0, Math.min(REALMS.length - 1, state.realm | 0));
      state.best = Math.max(-1, Math.min(RARITIES.length - 1, state.best | 0));

      if (!Array.isArray(state.bag)) state.bag = [];
      state.bag = state.bag.filter(
        (it) => it && isFinite(it.power) && RARITIES[it.r] && SLOT_MAP[it.slot]
      );

      if (!state.equipped || typeof state.equipped !== 'object') state.equipped = emptyEquipped();
      for (const s of SLOTS) {
        const it = state.equipped[s.key];
        state.equipped[s.key] =
          (it && it.slot === s.key && isFinite(it.power) && SLOT_MAP[it.slot]) ? it : null;
      }

      let seq = typeof state.itemSeq === 'number' && state.itemSeq > 0 ? state.itemSeq : 1;
      let maxId = 0;
      const fixItem = (it) => {
        if (typeof it.id !== 'number') it.id = seq++;
        if (typeof it.lv !== 'number' || !isFinite(it.lv)) it.lv = 0;
        it.lv = Math.max(0, Math.min(MAX_ENHANCE, Math.floor(it.lv)));
        if (it.setKey && !SETS[it.setKey]) {
          delete it.setKey;
          delete it.special;
        }
        if (it.special) it.r = 5;
        if (it.id > maxId) maxId = it.id;
      };
      for (const it of state.bag) fixItem(it);
      for (const s of SLOTS) {
        if (state.equipped[s.key]) fixItem(state.equipped[s.key]);
      }
      state.itemSeq = Math.max(seq, maxId + 1);

      const fixInt = (v, lo, hi) => {
        const n = Math.floor(Number(v));
        return Math.max(lo, Math.min(hi, isFinite(n) ? n : 0));
      };
      state.towerCleared = fixInt(state.towerCleared, 0, TOWER_MAX);
      state.stageCleared = fixInt(state.stageCleared, 0, STAGE_MAX);
      state.towerMarks = fixInt(state.towerMarks, 0, 1e9);
      state.warMerits = fixInt(state.warMerits, 0, 1e9);
      state.beastBones = fixInt(state.beastBones, 0, 1e9);
      state.trainAtk = fixInt(state.trainAtk, 0, MAX_TRAIN);
      state.trainHp = fixInt(state.trainHp, 0, MAX_TRAIN);
      state.trainPierce = fixInt(state.trainPierce, 0, MAX_TRAIN);
      state.autoHunt = !!state.autoHunt;

      if (!Array.isArray(state.wildCleared)) state.wildCleared = [];
      state.wildCleared = Array.from(new Set(
        state.wildCleared.map((z) => fixInt(z, 1, WILD_MAX)).filter((z) => z >= 1 && z <= WILD_MAX)
      )).sort((a, b) => a - b);

      if (!state.wildKills || typeof state.wildKills !== 'object' || Array.isArray(state.wildKills)) {
        state.wildKills = {};
      }
      const kills = {};
      for (const key of Object.keys(state.wildKills)) {
        const z = fixInt(key, 1, WILD_MAX);
        if (z >= 1 && z <= WILD_MAX) kills[z] = fixInt(state.wildKills[key], 0, 1e9);
      }
      state.wildKills = kills;
      state.wildZone = fixInt(state.wildZone, 1, WILD_MAX);
    } catch (e) {
      state = defaults();
    }
  }

  /* ---------------- 数值 ---------------- */

  const realmMult = () => Math.pow(1.7, state.realm);
  const prestigeMult = () => 1 + 0.25 * state.ascensions;
  const buffOn = () => Date.now() < state.buffUntil;
  const buffMult = () => (buffOn() ? 2 : 1);

  const interval = () => Math.max(0.25, 2 * Math.pow(0.94, state.speedLv));

  function itemPower(it) {
    return Math.round(it.power * (1 + 0.18 * (it.lv || 0)));
  }

  function totalPower() {
    let p = 0;
    for (const s of SLOTS) {
      const it = state.equipped[s.key];
      if (it) p += itemPower(it);
    }
    return p;
  }

  const powerMult = () => 1 + totalPower() / 400;
  const baseGain = () => (3 + 0.9 * state.gainLv) * realmMult() * prestigeMult() * powerMult();
  const enhanceCost = (it) => it.special
    ? Math.floor((it.power * 2.2 + 30) * Math.pow(1.42, it.lv || 0))
    : Math.floor(RARITIES[it.r].stone * 10 * Math.pow(1.55, it.lv || 0));
  const salvageValue = (it) => it.special
    ? Math.floor((it.power * 2 + 20) * (1 + 0.35 * (it.lv || 0)))
    : Math.floor(RARITIES[it.r].stone * 2 * (1 + 0.4 * (it.lv || 0)) * (1 + 0.2 * state.gainLv));

  function weights() {
    const m = 1 + 0.1 * state.luckLv;
    return RARITIES.map((r, i) => r.weight * Math.pow(m, i));
  }

  function rollRarity() {
    const w = weights();
    let total = 0;
    for (let i = 0; i < w.length; i++) total += w[i];
    let roll = Math.random() * total;
    for (let i = 0; i < w.length; i++) {
      roll -= w[i];
      if (roll <= 0) return i;
    }
    return 0;
  }

  function expected() {
    const w = weights();
    let total = 0;
    let exp = 0;
    for (let i = 0; i < w.length; i++) {
      total += w[i];
      exp += w[i] * (1 + RARITIES[i].exp);
    }
    return { stone: baseGain(), exp: exp / total };
  }

  const upgradeCost = (key) => Math.floor(UPGRADES[key].base * Math.pow(UPGRADES[key].growth, state[key + 'Lv']));

  /* ---------------- 战斗数值 ---------------- */

  const contentReq = (mode, level) => {
    const cfg = MODES[mode];
    return cfg.reqBase * Math.pow(cfg.reqGrowth, Math.max(0, level - 1));
  };

  const isBoss = (mode, level) => {
    if (mode === 'tower') return level % 10 === 0;
    if (mode === 'stage') return level % 5 === 0;
    return level % 4 === 0 || level === WILD_MAX;
  };

  function enemyFor(mode, level) {
    const cfg = MODES[mode];
    const boss = isBoss(mode, level);
    const req = contentReq(mode, level);
    let name = '';
    let icon = '妖';
    let kicker = '';

    if (mode === 'tower') {
      const source = boss
        ? TOWER_BOSSES[Math.min(TOWER_BOSSES.length - 1, Math.floor((level - 1) / 10))]
        : TOWER_MONSTERS[(level - 1) % TOWER_MONSTERS.length];
      name = source.name;
      icon = source.icon;
      kicker = '镇塔 · 第 ' + level + ' 层';
    } else if (mode === 'stage') {
      const chapter = STAGE_CHAPTERS[Math.min(STAGE_CHAPTERS.length - 1, Math.floor((level - 1) / 5))];
      const idx = (level - 1) % 5;
      name = boss ? chapter.boss : chapter.monsters[(level - 1) % chapter.monsters.length];
      icon = chapter.icon;
      kicker = chapter.name + ' · 第 ' + level + ' 关';
    } else {
      const zone = WILD_ZONES[Math.min(WILD_ZONES.length - 1, level - 1)];
      name = zone.monster;
      icon = zone.icon;
      kicker = zone.name + ' · 危险度 ' + level;
    }

    return {
      name, icon, kicker, boss, req,
      hp: Math.max(1, Math.round(req * cfg.hp * (boss ? cfg.bossHp : 1))),
      atk: Math.max(1, Math.round(req * cfg.atk * (boss ? cfg.bossAtk : 1))),
      def: Math.max(0, Math.round(req * cfg.def * (boss ? 1.12 : 1))),
    };
  }

  function unlockedMode(mode) {
    if (mode === 'stage') return true;
    if (mode === 'wild') return state.stageCleared >= 3;
    return state.stageCleared >= 5;
  }

  function wildMaxUnlocked() {
    let max = 1;
    for (const z of state.wildCleared) {
      if (z + 1 > max) max = z + 1;
    }
    return Math.min(WILD_MAX, max);
  }

  function setCounts() {
    const counts = { tower: 0, stage: 0, wild: 0 };
    for (const s of SLOTS) {
      const it = state.equipped[s.key];
      if (it && it.setKey && counts[it.setKey] !== undefined) counts[it.setKey]++;
    }
    return counts;
  }

  function playerCombatStats() {
    const power = totalPower();
    let atk = 16 + power * 0.9;
    let hp = 120 + power * 5.5;
    let def = 3 + power * 0.28;
    let crit = 0.1;
    const critMult = 2;
    let lifesteal = 0;
    let dr = 0;
    let pierce = 0.015 * state.trainPierce;

    atk *= 1 + 0.12 * state.realm;
    hp *= 1 + 0.15 * state.realm;
    def *= 1 + 0.10 * state.realm;

    const ascMult = 1 + 0.08 * state.ascensions;
    atk *= ascMult;
    hp *= ascMult;

    const counts = setCounts();
    const b = { atk, hp, def, crit, dr, lifesteal };
    for (const key of Object.keys(SETS)) {
      for (const bonus of SETS[key].bonuses) {
        if (counts[key] >= bonus.need) bonus.apply(b);
      }
    }

    atk = b.atk * (1 + 0.03 * state.trainAtk);
    hp = b.hp * (1 + 0.03 * state.trainHp);
    def = b.def;
    crit = Math.min(0.6, b.crit);
    dr = Math.min(0.6, b.dr);
    lifesteal = Math.min(0.5, b.lifesteal);
    pierce = Math.min(0.6, pierce);

    return { power, atk, hp, def, crit, critMult, lifesteal, dr, pierce, counts };
  }

  const recommendedPower = (mode, level) =>
    Math.ceil(contentReq(mode, level) * (isBoss(mode, level) ? 1.35 : 1));

  function specialPower(mode, level) {
    const mult = mode === 'tower' ? 0.4 : mode === 'stage' ? 0.42 : 0.45;
    const base = 20 + contentReq(mode, level) * mult;
    return Math.max(1, Math.round(base * (0.9 + Math.random() * 0.2)));
  }

  function makeSpecialItem(mode, level, slotKey) {
    const slotDef = SLOT_MAP[slotKey] || SLOTS[Math.floor(Math.random() * SLOTS.length)];
    const set = SETS[mode];
    return {
      id: state.itemSeq++,
      r: 5,
      slot: slotDef.key,
      name: set.pieces[slotDef.key],
      power: specialPower(mode, level),
      lv: 0,
      special: true,
      setKey: mode,
      source: mode,
      sourceLevel: level,
    };
  }

  function trophyGain(mode, level, boss, first) {
    const cfg = MODES[mode];
    let n = 1 + Math.floor(level / cfg.trophyStep);
    if (boss) n += 2;
    if (first) n += 2;
    return n;
  }

  /* ---------------- 格式化 ---------------- */

  function fmt(n) {
    if (!isFinite(n)) return '∞';
    if (n < 0) return '-' + fmt(-n);
    n = Math.floor(n);
    if (n < 10000) return String(n);
    if (n >= 1e12) return trim((n / 1e12).toFixed(2)) + '兆';
    if (n >= 1e8) return trim((n / 1e8).toFixed(2)) + '亿';
    return trim((n / 1e4).toFixed(2)) + '万';
  }

  function trim(s) {
    return s.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  }

  function fmtRate(n) {
    return n < 100 ? String(Math.round(n * 10) / 10) : fmt(n);
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return h + ' 小时 ' + m + ' 分';
    if (m > 0) return m + ' 分 ' + (sec % 60) + ' 秒';
    return sec + ' 秒';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* ---------------- 日志 / 特效 ---------------- */

  function pushLog(text, cls) {
    state.log.unshift({ text, cls: cls || 'sys' });
    if (state.log.length > 14) state.log.length = 14;
    logDirty = true;
  }

  function floatText(text, color) {
    const wrap = document.querySelector('.box-wrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'float-text';
    el.textContent = text;
    el.style.color = color || '#f0d9a8';
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 950);
  }

  function burst(color, count) {
    const wrap = document.querySelector('.box-wrap');
    if (!wrap) return;
    for (let i = 0; i < count; i++) {
      const p = document.createElement('span');
      p.className = 'particle';
      const angle = Math.random() * Math.PI * 2;
      const dist = 50 + Math.random() * 72;
      p.style.setProperty('--x', (Math.cos(angle) * dist).toFixed(1) + 'px');
      p.style.setProperty('--y', (Math.sin(angle) * dist).toFixed(1) + 'px');
      p.style.background = color;
      wrap.appendChild(p);
      setTimeout(() => p.remove(), 760);
    }
  }

  let pulseTimer = null;
  function pulse() {
    const box = $('boxBtn');
    box.classList.remove('pop');
    void box.offsetWidth;
    box.classList.add('pop');
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => box.classList.remove('pop'), 340);
  }

  function beep(freq, dur) {
    if (state.muted) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.06, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    } catch (e) {
      /* 浏览器不允许自动播放时忽略 */
    }
  }

  /* ---------------- 装备 / 背包 ---------------- */

  function makeItem(ri) {
    const slotDef = SLOTS[Math.floor(Math.random() * SLOTS.length)];
    const pool = ITEM_NAMES[slotDef.key][ri];
    const name = pool[Math.floor(Math.random() * pool.length)];
    const power = Math.max(1, Math.round(BASE_POWER[ri] * (0.8 + Math.random() * 0.4)));
    return {
      id: state.itemSeq++,
      r: ri,
      slot: slotDef.key,
      name,
      power,
      lv: 0,
    };
  }

  function itemScore(it) {
    return itemPower(it) * 1000 + it.r * 10 + Math.min(it.lv || 0, MAX_ENHANCE);
  }

  function weakestBagIndex() {
    let wi = -1;
    for (let i = 0; i < state.bag.length; i++) {
      if (wi < 0 || itemScore(state.bag[i]) < itemScore(state.bag[wi])) wi = i;
    }
    return wi;
  }

  function addStones(n) {
    n = Math.floor(n);
    if (n <= 0) return 0;
    state.stones += n;
    state.totalStones += n;
    return n;
  }

  function addItem(item) {
    bagDirty = true;

    if (state.bag.length < BAG_CAP) {
      state.bag.push(item);
      state.bagWarned = false;
      return { kept: true, auto: false, value: 0 };
    }

    const wi = weakestBagIndex();
    const weakest = wi >= 0 ? state.bag[wi] : null;
    const keepNew = !weakest || itemScore(item) >= itemScore(weakest);
    let value = 0;

    if (keepNew) {
      if (weakest) {
        value = addStones(salvageValue(weakest));
        state.bag[wi] = item;
      }
    } else {
      value = addStones(salvageValue(item));
    }

    if (!state.bagWarned) {
      pushLog('背包已满：自动分解较弱装备，保留更强的一件', 'sys');
      floatText('背包已满', '#f87171');
      state.bagWarned = true;
    }

    return { kept: keepNew, auto: true, value };
  }

  function equipItem(id) {
    const idx = state.bag.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const item = state.bag[idx];
    if (!SLOT_MAP[item.slot]) return;

    const old = state.equipped[item.slot];
    state.bag.splice(idx, 1);
    if (old) state.bag.push(old);
    state.equipped[item.slot] = item;
    state.bagWarned = false;
    bagDirty = true;
    equipDirty = true;
    combatDirty = true;

    pushLog('穿戴「' + item.name + '」' + (item.lv ? ' +' + item.lv : '') + '，战力 ' + fmt(itemPower(item)), 'r' + item.r);
    beep(620, 0.06);
    render();
    paintBag(true);
    save();
  }

  function unequipSlot(slotKey) {
    const item = state.equipped[slotKey];
    if (!item) return;
    if (state.bag.length >= BAG_CAP) {
      floatText('背包已满', '#f87171');
      pushLog('背包已满，先分解或穿戴装备再卸下', 'sys');
      return;
    }
    state.equipped[slotKey] = null;
    state.bag.push(item);
    state.bagWarned = false;
    bagDirty = true;
    equipDirty = true;
    combatDirty = true;
    pushLog('卸下「' + item.name + '」', 'sys');
    render();
    paintBag(true);
    save();
  }

  function enhanceSlot(slotKey) {
    const item = state.equipped[slotKey];
    if (!item) return;
    if (item.lv >= MAX_ENHANCE) {
      floatText('已强化至 +' + MAX_ENHANCE, '#9aa4b2');
      return;
    }
    const cost = enhanceCost(item);
    if (state.stones < cost) {
      floatText('灵石不足', '#f87171');
      return;
    }
    state.stones -= cost;
    item.lv++;
    equipDirty = true;
    combatDirty = true;
    pushLog('强化「' + item.name + '」至 +' + item.lv + '，战力 ' + fmt(itemPower(item)), 'sys');
    beep(780, 0.07);
    render();
    save();
  }

  function salvageItem(id, quiet) {
    const idx = state.bag.findIndex((x) => x.id === id);
    if (idx < 0) return 0;
    const item = state.bag[idx];
    const value = addStones(salvageValue(item));
    state.bag.splice(idx, 1);
    state.bagWarned = false;
    bagDirty = true;

    if (!quiet) {
      pushLog('分解「' + item.name + '」，得 ' + fmt(value) + ' 灵石', 'sys');
      render();
      paintBag(true);
      save();
    }
    return value;
  }

  function salvageLow() {
    const ids = state.bag.filter((it) => it.r <= 1).map((it) => it.id);
    if (!ids.length) {
      floatText('没有凡品 / 灵品', '#9aa4b2');
      return;
    }
    let value = 0;
    for (const id of ids) value += salvageItem(id, true);
    state.bagWarned = false;
    pushLog('一键分解 ' + ids.length + ' 件低品装备，得 ' + fmt(value) + ' 灵石', 'sys');
    beep(520, 0.06);
    render();
    paintBag(true);
    save();
  }

  function salvageAll() {
    if (!state.bag.length) {
      floatText('背包是空的', '#9aa4b2');
      return;
    }
    if (!confirm('确定分解背包里的全部 ' + state.bag.length + ' 件装备？')) return;

    let value = 0;
    for (const it of state.bag) value += salvageValue(it);
    value = addStones(value);
    const count = state.bag.length;
    state.bag = [];
    state.bagWarned = false;
    bagDirty = true;
    pushLog('清空背包，分解 ' + count + ' 件装备，得 ' + fmt(value) + ' 灵石', 'sys');
    beep(420, 0.1);
    render();
    paintBag(true);
    save();
  }

  function autoEquip() {
    let changed = 0;

    for (const slotDef of SLOTS) {
      let best = -1;
      for (let i = 0; i < state.bag.length; i++) {
        if (state.bag[i].slot !== slotDef.key) continue;
        if (best < 0 || itemScore(state.bag[i]) > itemScore(state.bag[best])) best = i;
      }
      if (best < 0) continue;

      const current = state.equipped[slotDef.key];
      if (current && itemScore(current) >= itemScore(state.bag[best])) continue;

      const item = state.bag.splice(best, 1)[0];
      if (current) state.bag.push(current);
      state.equipped[slotDef.key] = item;
      changed++;
    }

    if (!changed) {
      floatText('没有更强的装备', '#9aa4b2');
      return;
    }

    state.bagWarned = false;
    bagDirty = true;
    equipDirty = true;
    combatDirty = true;
    pushLog('一键穿戴完成，更换 ' + changed + ' 件装备', 'sys');
    beep(820, 0.1);
    render();
    paintBag(true);
    save();
  }

  /* ---------------- 核心：开箱 ---------------- */

  function openBox(opts) {
    const silent = !!(opts && opts.silent);
    const bulk = !!(opts && opts.bulk);

    state.opens++;

    const crit = Math.random() < CRIT_CHANCE;
    const ri = rollRarity();
    const item = makeItem(ri);
    const gain = Math.max(1, Math.floor(baseGain() * (crit ? CRIT_MULT : 1) * buffMult()));

    state.stones += gain;
    state.totalStones += gain;
    state.exp += (1 + RARITIES[ri].exp) * (1 + 0.8 * state.realm) * (1 + 0.5 * state.ascensions);
    state.counts[ri]++;
    if (ri > state.best) state.best = ri;

    addItem(item);

    let buffed = false;
    if (!buffOn() && Math.random() < BUFF_CHANCE) {
      state.buffUntil = Date.now() + BUFF_MS;
      buffed = true;
    }

    if (!silent || ri >= 2) {
      pushLog(
        item.name + '（' + RARITIES[ri].name + '） 战力 +' + fmt(itemPower(item)) +
        (crit ? ' · 暴击×10' : '') + ' · +' + fmt(gain) + ' 灵石',
        'r' + ri
      );
    }
    if (buffed) pushLog('拾得「聚气丹」，30 秒内收益翻倍', 'buff');

    if (!silent || ri >= 4) floatText('+' + fmt(gain), RARITIES[ri].color);
    if (!bulk) {
      pulse();
      if (ri >= 3) burst(RARITIES[ri].color, ri >= 5 ? 18 : 10);
      if (ri >= 4) beep(ri === 5 ? 1046 : 880, 0.16);
    }

    return { ri, gain, item };
  }

  function manualOpen(n) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      total += openBox({ silent: n > 1, bulk: n > 1 }).gain;
    }
    if (n > 1) {
      floatText('+' + fmt(total), '#f0d9a8');
      pushLog('连开 ' + n + ' 次，共得 ' + fmt(total) + ' 灵石', 'sys');
    }
    render();
    paintBag(true);
    save();
  }

  function buy(key) {
    const cfg = UPGRADES[key];
    const lvKey = key + 'Lv';
    if (state[lvKey] >= cfg.max) return;
    const cost = upgradeCost(key);
    if (state.stones < cost) {
      floatText('灵石不足', '#f87171');
      return;
    }
    state.stones -= cost;
    state[lvKey]++;
    pushLog('淬炼「' + cfg.label + '」至 Lv.' + state[lvKey], 'sys');
    beep(720, 0.08);
    render();
    save();
  }

  function breakthrough() {
    if (state.realm >= REALMS.length - 1) return;
    const cost = REALM_COSTS[state.realm + 1];
    if (state.exp < cost) return;
    state.exp -= cost;
    state.realm++;
    combatDirty = true;
    pushLog('突破至「' + REALMS[state.realm] + '」', 'sys');
    burst('#d8b36a', 20);
    beep(660, 0.18);
    render();
    save();
  }

  function ascend() {
    if (state.realm < REALMS.length - 1 || state.stones < 1e8) return;
    if (!confirm('飞升会重置灵石、境界与淬炼，保留装备、背包、图鉴和仙缘。确定继续？')) return;
    const gain = Math.max(1, Math.floor(Math.sqrt(state.stones / 1e8)));
    state.ascensions += gain;
    state.stones = 0;
    state.exp = 0;
    state.realm = 0;
    state.speedLv = 0;
    state.gainLv = 0;
    state.luckLv = 0;
    state.buffUntil = 0;
    combatDirty = true;
    pushLog('飞升成功，得 ' + gain + ' 点仙缘，永久收益 +' + gain * 25 + '%', 'sys');
    burst('#f0d9a8', 26);
    beep(1046, 0.22);
    render();
    paintBag(true);
    save();
  }

  /* ---------------- 离线收益 ---------------- */

  function awardOffline() {
    const now = Date.now();
    const elapsed = Math.min(OFFLINE_CAP, Math.max(0, (now - state.lastSeen) / 1000));
    state.lastSeen = now;
    if (elapsed < 60) return;

    const n = Math.floor((elapsed / interval()) * OFFLINE_EFF);
    if (n <= 0) return;

    const e = expected();
    const stones = Math.floor(n * e.stone);
    const exp = n * e.exp * (1 + 0.8 * state.realm) * (1 + 0.5 * state.ascensions);

    state.stones += stones;
    state.totalStones += stones;
    state.exp += exp;
    state.opens += n;

    if (stones > 0 || exp > 0) {
      $('offlineText').innerHTML =
        '离线 <b>' + fmtDuration(elapsed) + '</b>，自动开箱 <b>' + fmt(n) + '</b> 次<br>' +
        '获得 <b>' + fmt(stones) + '</b> 灵石 · <b>' + fmt(exp) + '</b> 修为<br>' +
        '<span class="offline-note">离线只结算灵石与修为，装备需要在线开箱掉落</span>';
      $('offlineModal').classList.add('show');
      pushLog('离线收益已结算：+' + fmt(stones) + ' 灵石', 'sys');
    }
  }

  /* ---------------- 战斗结算 ---------------- */

  function currentLevel(mode) {
    if (mode === 'wild') {
      return Math.max(1, Math.min(wildMaxUnlocked(), state.wildZone || 1));
    }
    const max = MODES[mode].max;
    const cleared = mode === 'tower' ? state.towerCleared : state.stageCleared;
    return Math.min(max, cleared + 1);
  }

  function simulateBattle(player, enemy) {
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

      let edmg = Math.max(1, enemy.atk - player.def);
      edmg = Math.max(1, Math.floor(edmg * (1 - player.dr)));
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

  function addTrophy(mode, n) {
    const field = TROPHIES[mode].field;
    state[field] = (state[field] || 0) + n;
  }

  function grantSpecial(mode, level, slotKey) {
    const item = makeSpecialItem(mode, level, slotKey);
    const result = addItem(item);
    bagDirty = true;
    pushLog(
      '秘境掉落「' + item.name + '」（' + SETS[item.setKey].name + '套装）' +
      (result.kept ? '' : ' · 背包已满，自动分解'),
      'special'
    );
    return { item, result };
  }

  function doBattle(mode, opts) {
    const modeCfg = MODES[mode];
    if (!modeCfg || !unlockedMode(mode)) return;
    const auto = !!(opts && opts.auto);
    if (!auto) state.autoHunt = false;

    const now = performance.now();
    if (auto && now < battleCooldownUntil) return;
    if (!auto && $('battleModal').classList.contains('show')) return;
    battleCooldownUntil = now + 450;

    const level = currentLevel(mode);
    const cleared = mode === 'tower' ? state.towerCleared : state.stageCleared;
    const replay = mode !== 'wild' && cleared >= modeCfg.max;
    const first = mode === 'wild' ? !state.wildCleared.includes(level) : !replay;
    const enemy = enemyFor(mode, level);
    const player = playerCombatStats();
    const result = simulateBattle(player, enemy);
    const rewardScale = replay ? 0.5 : 1;
    const bossScale = enemy.boss ? 1.8 : 1;

    if (result.win) {
      const stoneGain = Math.floor(
        contentReq(mode, level) * modeCfg.stone * bossScale * (first ? 1.5 : 1) * rewardScale
      );
      const expGain = Math.floor(
        contentReq(mode, level) * modeCfg.exp * bossScale * (first ? 1.5 : 1) * rewardScale
      );
      const trophy = trophyGain(mode, level, enemy.boss, first);

      addStones(stoneGain);
      state.exp += expGain;
      addTrophy(mode, trophy);

      if (mode === 'wild') {
        state.wildKills[level] = (state.wildKills[level] || 0) + 1;
        if (first) state.wildCleared.push(level);
      } else if (!replay) {
        if (mode === 'tower') state.towerCleared = level;
        else state.stageCleared = level;
      }

      let special = null;
      const milestoneSlot = MILESTONES[mode][level];
      if (first && milestoneSlot) {
        special = grantSpecial(mode, level, milestoneSlot);
      } else if (mode === 'wild') {
        const kills = state.wildKills[level];
        if (first && level === WILD_MAX) {
          special = grantSpecial(mode, level, SLOTS[Math.floor(Math.random() * SLOTS.length)].key);
        } else if (kills % 12 === 0 || Math.random() < 0.06) {
          special = grantSpecial(mode, level, SLOTS[Math.floor(Math.random() * SLOTS.length)].key);
        }
      } else if (first && level === modeCfg.max) {
        special = grantSpecial(mode, level, SLOTS[Math.floor(Math.random() * SLOTS.length)].key);
      } else if (replay && Math.random() < 0.08) {
        special = grantSpecial(mode, level, SLOTS[Math.floor(Math.random() * SLOTS.length)].key);
      }

      lastBattles[mode] = {
        mode, level, win: true, result, enemy, player, stoneGain, expGain,
        trophy, special, first, replay,
      };

      pushLog(
        '通关「' + enemy.name + '」 · +' + fmt(stoneGain) + ' 灵石 · +' +
        fmt(expGain) + ' 修为 · +' + trophy + ' ' + TROPHIES[mode].name,
        'special'
      );
      beep(result.rounds <= 3 ? 1046 : 820, 0.14);
    } else {
      state.autoHunt = false;
      lastBattles[mode] = {
        mode, level, win: false, result, enemy, player,
        trophy: 0, first, replay,
      };
      pushLog('挑战「' + enemy.name + '」失败，未损失进度', 'sys');
      beep(220, 0.12);
    }

    combatDirty = true;
    render();
    paintBag(true);
    save();

    if (!auto) openBattleModal(lastBattles[mode]);
  }

  function upgradeTraining(key) {
    const cfg = TRAININGS[key];
    const lv = state[cfg.lvField] || 0;
    if (lv >= MAX_TRAIN) return;
    const cost = lv + 1;
    if ((state[cfg.currency] || 0) < cost) {
      floatText('战利品不足', '#f87171');
      return;
    }
    state[cfg.currency] -= cost;
    state[cfg.lvField] = lv + 1;
    combatDirty = true;
    pushLog('战技「' + cfg.name + '」提升至 Lv.' + (lv + 1), 'sys');
    beep(700, 0.08);
    render();
    save();
  }

  function setUiMode(mode) {
    if (!MODES[mode]) return;
    uiMode = mode;
    if (mode === 'wild') {
      state.wildZone = Math.max(1, Math.min(state.wildZone, wildMaxUnlocked()));
    }
    combatDirty = true;
    renderCombat();
  }

  function selectWildZone(zone) {
    if (!unlockedMode('wild')) return;
    if (zone < 1 || zone > wildMaxUnlocked()) return;
    state.wildZone = zone;
    combatDirty = true;
    save();
    renderCombat();
  }

  /* ---------------- 战斗动画 ---------------- */

  let battleTimers = [];
  let battleSeq = 0;
  let battleCurrent = null;

  function clearBattleTimers() {
    for (const t of battleTimers) clearTimeout(t);
    battleTimers = [];
  }

  function battleLogLine(ev, b) {
    if (ev.side === 'player') {
      const cls = ev.crit ? 'crit-line' : 'player-line';
      return '<p class="' + cls + '">第 ' + ev.round + ' 回合 · 你斩出 <b>' +
        fmt(ev.damage) + '</b> 伤害' + (ev.crit ? ' · 暴击！' : '') +
        (ev.heal ? ' · 吸血 +' + fmt(ev.heal) : '') + '</p>';
    }
    return '<p class="enemy-line">第 ' + ev.round + ' 回合 · ' + esc(b.enemy.name) +
      ' 反击 <b>' + fmt(ev.damage) + '</b> 伤害</p>';
  }

  function updateBattleBars(php, ehp, b) {
    const maxP = b.result.playerHp || b.player.hp || 1;
    const maxE = b.result.enemyHp || b.enemy.hp || 1;
    const pp = Math.max(0, Math.min(100, (php / maxP) * 100));
    const ep = Math.max(0, Math.min(100, (ehp / maxE) * 100));
    $('battlePlayerHp').style.width = pp.toFixed(1) + '%';
    $('battleEnemyHp').style.width = ep.toFixed(1) + '%';
    $('battlePlayerHpText').textContent = fmt(Math.max(0, php)) + ' / ' + fmt(maxP);
    $('battleEnemyHpText').textContent = fmt(Math.max(0, ehp)) + ' / ' + fmt(maxE);
  }

  function showBattleDamage(text, target, crit) {
    const span = document.createElement('span');
    span.className = 'battle-damage ' + (target === 'enemy' ? 'to-enemy' : 'to-player') +
      (crit ? ' crit' : '');
    span.style.marginLeft = Math.round((Math.random() * 2 - 1) * 10) + 'px';
    span.textContent = text;
    $('battleArena').appendChild(span);
    setTimeout(() => span.remove(), 620);
  }

  function animateFighter(attacker, target, token) {
    const a = $(attacker === 'player' ? 'battlePlayer' : 'battleEnemy');
    const t = $(target === 'player' ? 'battlePlayer' : 'battleEnemy');
    a.classList.remove('attack-right', 'attack-left');
    t.classList.remove('hit');
    void a.offsetWidth;
    a.classList.add(attacker === 'player' ? 'attack-right' : 'attack-left');
    t.classList.add('hit');
    battleTimers.push(setTimeout(() => {
      if (token !== battleSeq) return;
      a.classList.remove('attack-right', 'attack-left');
      t.classList.remove('hit');
    }, 300));
  }

  function applyBattleEvent(ev, b, token) {
    if (token !== battleSeq) return;
    $('battleRound').textContent = '第 ' + ev.round + ' 回合';
    const log = $('battleLog');

    if (ev.side === 'player') {
      animateFighter('player', 'enemy', token);
      updateBattleBars(ev.playerHp, ev.enemyHp, b);
      showBattleDamage((ev.crit ? '暴击 ' : '') + '-' + fmt(ev.damage), 'enemy', ev.crit);
    } else {
      animateFighter('enemy', 'player', token);
      updateBattleBars(ev.playerHp, ev.enemyHp, b);
      showBattleDamage('-' + fmt(ev.damage), 'player', false);
    }

    if (log.querySelector('.empty')) log.innerHTML = '';
    log.insertAdjacentHTML('beforeend', battleLogLine(ev, b));
    log.scrollTop = log.scrollHeight;
  }

  function battleResultHtml(b) {
    if (b.win) {
      let html =
        '<p class="result-title">战斗胜利</p>' +
        '<p>历时 <b>' + b.result.rounds + '</b> 回合 · 造成 <b>' + fmt(b.result.dealt) +
          '</b> 伤害 · 承受 <b>' + fmt(b.result.taken) + '</b> · 暴击 <b>' +
          b.result.crits + '</b> 次</p>' +
        '<p>获得 <b>+' + fmt(b.stoneGain) + '</b> 灵石 · <b>+' + fmt(b.expGain) +
          '</b> 修为 · <b>+' + b.trophy + '</b> ' + TROPHIES[b.mode].name + '</p>';
      if (b.special) {
        html += '<p class="loot-line">获得「' + esc(b.special.item.name) + '」 · ' +
          SETS[b.special.item.setKey].name + '套装 · 战力 ' + fmt(itemPower(b.special.item)) +
          (b.special.result.kept ? '' : ' · 背包已满，已自动分解') + '</p>';
      }
      return html;
    }
    return '<p class="result-title">战斗失败</p>' +
      '<p>敌方剩余 <b>' + fmt(b.result.enemyLeft) + '</b> 生命 · 建议战力 <b>' +
        fmt(recommendedPower(b.mode, b.level)) + '</b></p>' +
      '<p>战败不损失进度，调整装备或战技后再来。</p>';
  }

  function finishBattleAnimation(b, token) {
    if (token !== battleSeq) return;
    const finalP = Math.max(0, b.result.hpLeft);
    const finalE = b.win ? 0 : Math.max(0, b.result.enemyLeft);
    updateBattleBars(finalP, finalE, b);
    $('battleRound').textContent = '结束';
    $('battleTitle').textContent = b.win ? '战斗胜利' : '战斗失败';
    $('battleResult').innerHTML = battleResultHtml(b);
    $('battleResult').classList.remove('hidden');
    $('battleResult').classList.toggle('win', b.win);
    $('battleResult').classList.toggle('lose', !b.win);
    $('battleSkip').classList.add('hidden');
    const close = $('battleClose');
    close.disabled = false;
    close.textContent = b.win ? '收下战利品' : '返回秘境';
  }

  function skipBattleAnimation() {
    const b = battleCurrent;
    if (!b) return;
    battleSeq++;
    clearBattleTimers();
    const events = b.result.events || [];
    const log = $('battleLog');
    log.innerHTML = events.length
      ? events.map((ev) => battleLogLine(ev, b)).join('')
      : '<p class="empty">战斗结束。</p>';
    log.scrollTop = log.scrollHeight;
    finishBattleAnimation(b, battleSeq);
  }

  function closeBattleModal() {
    battleSeq++;
    clearBattleTimers();
    battleCurrent = null;
    $('battleModal').classList.remove('show');
    document.querySelectorAll('.battle-damage').forEach((el) => el.remove());
  }

  function openBattleModal(b) {
    if (!b) return;
    if (state.autoHunt) {
      state.autoHunt = false;
      combatDirty = true;
      save();
      renderCombat();
    }
    $('offlineModal').classList.remove('show');
    clearBattleTimers();
    document.querySelectorAll('.battle-damage').forEach((el) => el.remove());
    battleSeq++;
    const token = battleSeq;
    battleCurrent = b;
    const events = b.result.events || [];

    $('battleTitle').textContent = '战斗';
    $('battleKicker').textContent = b.enemy.kicker + '「' + b.enemy.name + '」';
    $('battleRound').textContent = '准备';
    $('battleEnemyIcon').textContent = b.enemy.icon;
    $('battleEnemyName').textContent = b.enemy.name;
    $('battlePlayer').classList.remove('attack-right', 'attack-left', 'hit');
    $('battleEnemy').classList.remove('attack-right', 'attack-left', 'hit');
    $('battleLog').innerHTML = events.length
      ? ''
      : '<p class="empty">战斗结束。</p>';
    $('battleResult').classList.add('hidden');
    $('battleResult').classList.remove('win', 'lose');
    $('battleSkip').classList.remove('hidden');
    const close = $('battleClose');
    close.disabled = true;
    close.textContent = '战斗进行中';

    updateBattleBars(b.result.playerHp || b.player.hp, b.result.enemyHp || b.enemy.hp, b);
    $('battleModal').classList.add('show');

    if (!events.length) {
      battleTimers.push(setTimeout(() => finishBattleAnimation(b, token), 300));
      return;
    }

    const step = Math.max(26, Math.min(230, 4200 / events.length));
    events.forEach((ev, i) => {
      battleTimers.push(setTimeout(() => applyBattleEvent(ev, b, token), 260 + i * step));
    });
    battleTimers.push(setTimeout(
      () => finishBattleAnimation(b, token),
      260 + events.length * step + 220
    ));
  }

  function replayBattleAnimation() {
    const b = lastBattles[uiMode];
    if (b) openBattleModal(b);
  }

  /* ---------------- 渲染 ---------------- */

  function difficultyFor(power, req) {
    const ratio = req > 0 ? power / req : 99;
    if (ratio >= 1.3) return { cls: 'safe', text: '碾压' };
    if (ratio >= 1.0) return { cls: 'even', text: '势均力敌' };
    if (ratio >= 0.75) return { cls: 'hard', text: '艰难' };
    return { cls: 'deadly', text: '危险' };
  }

  function renderCombat() {
    const mode = uiMode;
    const cfg = MODES[mode];
    const level = currentLevel(mode);
    const enemy = enemyFor(mode, level);
    const player = playerCombatStats();
    const unlocked = unlockedMode(mode);
    const cleared = mode === 'tower' ? state.towerCleared
      : mode === 'stage' ? state.stageCleared : 0;
    const replay = mode !== 'wild' && cleared >= cfg.max;
    const unit = mode === 'tower' ? '层' : mode === 'stage' ? '关' : '区';
    const req = recommendedPower(mode, level);
    const diff = difficultyFor(player.power, req);

    document.querySelectorAll('.combat-tab').forEach((tab) => {
      const m = tab.dataset.mode;
      tab.classList.toggle('active', m === mode);
      tab.classList.toggle('locked', !unlockedMode(m));
      tab.setAttribute('aria-selected', m === mode ? 'true' : 'false');
    });

    $('enemyIcon').textContent = enemy.icon;
    $('enemyKicker').textContent = enemy.kicker;
    $('enemyName').textContent = enemy.name;
    $('enemyTag').classList.toggle('hidden', !enemy.boss);
    $('enemyHp').textContent = fmt(enemy.hp);
    $('enemyAtk').textContent = fmt(enemy.atk);
    $('enemyDef').textContent = fmt(enemy.def);
    $('enemyReq').textContent = fmt(req);

    $('combatPower').textContent = fmt(player.power);
    $('combatAtk').textContent = fmt(player.atk);
    $('combatHp').textContent = fmt(player.hp);
    $('combatDef').textContent = fmt(player.def);
    $('difficultyBadge').textContent = diff.text;
    $('difficultyBadge').className = 'diff ' + diff.cls;

    const zoneStrip = $('zoneStrip');
    zoneStrip.classList.toggle('hidden', mode !== 'wild');
    if (mode === 'wild') {
      const maxZone = wildMaxUnlocked();
      zoneStrip.innerHTML = WILD_ZONES.map((zone, i) => {
        const z = i + 1;
        const locked = z > maxZone;
        return (
          '<button class="zone-chip' + (z === level ? ' active' : '') + (locked ? ' locked' : '') +
          '" data-zone="' + z + '"' + (locked ? ' disabled' : '') + '>' +
          z + ' · ' + zone.name + '</button>'
        );
      }).join('');
    }

    const huntBtn = $('huntBtn');
    huntBtn.classList.toggle('hidden', mode !== 'wild');
    huntBtn.textContent = '自动巡猎：' + (state.autoHunt ? '开' : '关');
    huntBtn.disabled = !unlocked;

    const battleBtn = $('combatBtn');
    battleBtn.disabled = !unlocked;
    if (!unlocked) {
      battleBtn.textContent = '尚未解锁';
    } else if (mode === 'wild') {
      battleBtn.textContent = '挑战「' + enemy.name + '」';
    } else {
      battleBtn.textContent = (replay ? '再战第 ' : '挑战第 ') + level + ' ' + unit;
    }

    let progress = '';
    if (!unlocked) {
      progress = mode === 'tower'
        ? '通关闯关第 5 关后解锁（当前 ' + state.stageCleared + ' 关）'
        : '通关闯关第 3 关后解锁（当前 ' + state.stageCleared + ' 关）';
    } else if (mode === 'wild') {
      const kills = state.wildKills[level] || 0;
      const nextWild = [1, 3, 5, 7, 9, 11].find((z) => !state.wildCleared.includes(z));
      progress = '已解锁 ' + wildMaxUnlocked() + ' / ' + WILD_MAX + ' 区域 · 本区击杀 ' +
        fmt(kills) + ' · 每 12 杀必掉荒狩套装' +
        (nextWild ? ' · 首通 ' + nextWild + ' 区必掉部件' : '');
    } else {
      progress = '已通关 ' + cleared + ' / ' + cfg.max + ' ' + unit +
        (replay ? ' · 再战最终' + unit + '奖励减半' : '');
      const nextMs = Object.keys(MILESTONES[mode])
        .map(Number)
        .sort((a, b) => a - b)
        .find((n) => n > cleared);
      if (nextMs) progress += ' · 下个套装部件：第 ' + nextMs + ' ' + unit;
    }
    $('combatProgress').textContent = progress;

    if (!unlocked) {
      $('combatHint').textContent = mode === 'tower'
        ? '爬塔是后期玩法：先闯关，再野外，凑齐套装后回来挑战。'
        : '野外是中期玩法：先通关闯关第 3 关，再来狩猎。';
    } else if (mode === 'tower') {
      $('combatHint').textContent = '每 10 层首领；首通 10 / 20 / 30 / 40 / 50 / 60 层掉落镇塔套装。';
    } else if (mode === 'stage') {
      $('combatHint').textContent = '每 5 关首领；首通 5 / 10 / 15 / 20 / 25 / 30 关掉落征伐套装。';
    } else {
      $('combatHint').textContent = '区域越深，怪物属性越高；自动巡猎不弹窗，战后可点「回看战报」。';
    }

    $('trophyList').innerHTML = Object.keys(TROPHIES).map((key) => {
      const t = TROPHIES[key];
      return '<li><span>' + t.name + '</span><b>' + fmt(state[t.field] || 0) + '</b></li>';
    }).join('');

    $('trainingList').innerHTML = Object.keys(TRAININGS).map((key) => {
      const t = TRAININGS[key];
      const lv = state[t.lvField] || 0;
      const cost = lv + 1;
      const maxed = lv >= MAX_TRAIN;
      const can = !maxed && (state[t.currency] || 0) >= cost;
      const trophy = TROPHIES[key === 'atk' ? 'tower' : key === 'hp' ? 'stage' : 'wild'];
      return (
        '<div class="training-row">' +
          '<span class="training-name">' + t.name + '<em>Lv.' + lv + '</em></span>' +
          '<button class="mini" data-train="' + key + '"' + (can ? '' : ' disabled') + '>' +
            (maxed ? '已满' : '升级 ' + cost + ' ' + trophy.name) + '</button>' +
          '<p class="training-desc">' + t.desc + '</p>' +
        '</div>'
      );
    }).join('');

    const report = $('battleReport');
    const b = lastBattles[mode];
    $('replayBattleBtn').disabled = !b;
    if (!b) {
      report.innerHTML = '<p class="empty">选择秘境，挑战守卫，赢取专属套装。</p>';
    } else {
      if (b.win) {
        const loot = b.special
          ? '<p class="loot">获得「' + esc(b.special.item.name) + '」 · ' +
            SETS[b.special.item.setKey].name + '套装 · 战力 ' + fmt(itemPower(b.special.item)) +
            (b.special.result.kept ? '' : ' · 背包已满，已自动分解') + '</p>'
          : '';
        report.innerHTML =
          '<p class="win">胜利 · ' + b.enemy.kicker + '「' + esc(b.enemy.name) + '」</p>' +
          '<p>历时 <b>' + b.result.rounds + '</b> 回合 · 造成 <b>' + fmt(b.result.dealt) +
            '</b> 伤害 · 承受 <b>' + fmt(b.result.taken) + '</b> · 暴击 <b>' + b.result.crits + '</b> 次</p>' +
          '<p>获得 <b>+' + fmt(b.stoneGain) + '</b> 灵石 · <b>+' + fmt(b.expGain) +
            '</b> 修为 · <b>+' + b.trophy + '</b> ' + TROPHIES[mode].name + '</p>' + loot;
      } else {
        report.innerHTML =
          '<p class="lose">战败 · ' + b.enemy.kicker + '「' + esc(b.enemy.name) + '」</p>' +
          '<p>敌方剩余 <b>' + fmt(b.result.enemyLeft) + '</b> 生命 · 建议战力 <b>' +
            fmt(recommendedPower(mode, b.level)) + '</b></p>' +
          '<p>调整装备、强化或提升战技后再来，战败不会损失进度。</p>';
      }
    }

    combatDirty = false;
  }

  function renderUpgrade(key, lvId, descId, btnId, descFn) {
    const cfg = UPGRADES[key];
    const lv = state[key + 'Lv'];
    $(lvId).textContent = 'Lv.' + lv;
    $(descId).textContent = descFn(lv);

    const btn = $(btnId);
    if (lv >= cfg.max) {
      btn.textContent = '已满级';
      btn.disabled = true;
      return;
    }
    const cost = upgradeCost(key);
    btn.textContent = fmt(cost) + ' 灵石';
    btn.disabled = state.stones < cost;
  }

  function renderEquip() {
    equipDirty = false;
    $('equipGrid').innerHTML = SLOTS.map((slotDef) => {
      const item = state.equipped[slotDef.key];
      if (!item) {
        return (
          '<div class="equip-slot empty" data-slot="' + slotDef.key + '">' +
            '<div class="slot-head"><span class="slot-icon">' + slotDef.icon + '</span>' +
            '<span class="slot-name">' + slotDef.name + '</span></div>' +
            '<p class="slot-empty">未装备</p>' +
          '</div>'
        );
      }

      const maxed = item.lv >= MAX_ENHANCE;
      const setCls = item.setKey ? ' item-special ' + SETS[item.setKey].cls : '';
      const meta = item.setKey
        ? '秘境 · ' + SETS[item.setKey].name + '套装'
        : RARITIES[item.r].name;
      return (
        '<div class="equip-slot item-r' + item.r + setCls + '" data-slot="' + slotDef.key + '">' +
          '<div class="slot-head"><span class="slot-icon">' + slotDef.icon + '</span>' +
          '<span class="slot-name">' + slotDef.name + '</span>' +
          '<span class="slot-lv">+' + item.lv + '</span></div>' +
          '<p class="slot-item-name">' + esc(item.name) + '</p>' +
          '<p class="slot-power">战力 <b>' + fmt(itemPower(item)) + '</b> · ' + meta + '</p>' +
          '<div class="slot-actions">' +
            '<button class="mini" data-act="enhance" data-slot="' + slotDef.key + '"' +
              ' data-cost="' + enhanceCost(item) + '"' + (maxed ? ' data-max="1"' : '') + '>' +
              (maxed ? '已满级' : '强化 ' + fmt(enhanceCost(item))) + '</button>' +
            '<button class="mini ghost" data-act="unequip" data-slot="' + slotDef.key + '">卸下</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    syncEquipButtons();
    renderSets();
  }

  function syncEquipButtons() {
    const buttons = document.querySelectorAll('#equipGrid button[data-act="enhance"]');
    for (const btn of buttons) {
      if (btn.dataset.max) {
        btn.disabled = true;
        continue;
      }
      btn.disabled = state.stones < Number(btn.dataset.cost || 0);
    }
  }

  function renderSets() {
    const counts = setCounts();
    $('setList').innerHTML = Object.keys(SETS).map((key) => {
      const set = SETS[key];
      const count = counts[key];
      const active = set.bonuses.filter((b) => count >= b.need);
      const next = set.bonuses.find((b) => count < b.need);
      const desc = active.length
        ? active.map((b) => b.text).join(' · ')
        : '未激活';
      const tail = next ? ' · 下一档 ' + next.need + ' 件' : ' · 已满';
      return (
        '<div class="set-row ' + set.cls + (count ? ' on' : '') + '">' +
          '<div class="set-head"><span class="set-name">' + set.name + '套</span>' +
          '<span class="set-count">' + count + ' / 6</span></div>' +
          '<p class="set-desc">' + desc + tail + '</p>' +
        '</div>'
      );
    }).join('');
  }

  function paintBag(force) {
    if (!bagDirty) return;
    const now = performance.now();
    if (!force && now - lastBagPaint < 800) return;
    lastBagPaint = now;
    bagDirty = false;

    const sorted = state.bag.slice().sort((a, b) => itemScore(b) - itemScore(a));
    const list = $('bagList');
    const keepScroll = list.scrollTop;
    $('bagCount').textContent = state.bag.length + ' / ' + BAG_CAP;
    $('bagCount').classList.toggle('full', state.bag.length >= BAG_CAP);

    if (!sorted.length) {
      list.innerHTML = '<li class="bag-empty">背包空空如也，开箱会掉落装备。</li>';
      return;
    }

    list.innerHTML = sorted.map((item) => {
      const setCls = item.setKey ? ' item-special ' + SETS[item.setKey].cls : '';
      const meta = item.setKey
        ? '秘境 · ' + SETS[item.setKey].name + '套装'
        : RARITIES[item.r].name;
      return (
        '<li class="bag-item item-r' + item.r + setCls + '" data-id="' + item.id + '">' +
          '<div class="bi-main">' +
            '<span class="bi-name">' + esc(item.name) + (item.lv ? ' <em>+' + item.lv + '</em>' : '') + '</span>' +
            '<span class="bi-meta">' + meta + ' · ' + SLOT_MAP[item.slot].name + '</span>' +
          '</div>' +
          '<span class="bi-power">' + fmt(itemPower(item)) + '</span>' +
          '<div class="bi-actions">' +
            '<button class="mini" data-act="wear" data-id="' + item.id + '">穿戴</button>' +
            '<button class="mini ghost" data-act="salvage" data-id="' + item.id + '">分解</button>' +
          '</div>' +
        '</li>'
      );
    }).join('');

    list.scrollTop = keepScroll;
  }

  function render() {
    $('realmName').textContent = REALMS[state.realm];
    $('stones').textContent = fmt(state.stones);
    $('opens').textContent = fmt(state.opens);
    $('intervalText').textContent = interval().toFixed(2);

    const e = expected();
    const perSec = e.stone * (1 + CRIT_CHANCE * (CRIT_MULT - 1)) * buffMult() / interval();
    $('perSec').textContent = fmtRate(perSec);
    const power = totalPower();
    $('powerTotal').textContent = fmt(power);
    $('powerPanel').textContent = fmt(power);
    $('powerBonus').textContent = '收益 ×' + powerMult().toFixed(2);

    renderUpgrade('speed', 'speedLv', 'speedDesc', 'buySpeed',
      () => '每 ' + interval().toFixed(2) + ' 秒自动开一次');
    renderUpgrade('gain', 'gainLv', 'gainDesc', 'buyGain',
      (lv) => '灵石收益 +' + lv * 30 + '%');
    renderUpgrade('luck', 'luckLv', 'luckDesc', 'buyLuck',
      (lv) => '高品质权重 +' + lv * 10 + '% / 阶');

    const maxRealm = state.realm >= REALMS.length - 1;
    $('realmNow').textContent = REALMS[state.realm];

    if (maxRealm) {
      $('realmNext').textContent = '已至仙人';
      $('expFill').style.width = '100%';
      $('expText').textContent = '修为圆满';
      $('breakBtn').textContent = '已至仙人';
      $('breakBtn').disabled = true;
    } else {
      const cost = REALM_COSTS[state.realm + 1];
      const enough = state.exp >= cost;
      $('realmNext').textContent = '→ ' + REALMS[state.realm + 1];
      $('expFill').style.width = (Math.min(1, state.exp / cost) * 100).toFixed(1) + '%';
      $('expText').textContent = enough
        ? '修为充足 · 可突破至 ' + REALMS[state.realm + 1]
        : fmt(state.exp) + ' / ' + fmt(cost) + ' 修为';
      $('breakBtn').textContent = '突破至 ' + REALMS[state.realm + 1];
      $('breakBtn').disabled = !enough;
    }

    $('ascendBtn').classList.toggle('hidden', !maxRealm);
    if (maxRealm) $('ascendBtn').disabled = state.stones < 1e8;

    let hint = '';
    if (state.ascensions > 0) {
      hint = '仙缘 ×' + state.ascensions + ' · 永久收益 +' + state.ascensions * 25 + '%';
    }
    if (maxRealm) {
      hint += (hint ? ' · ' : '') + '飞升需 1 亿灵石（当前 ' + fmt(state.stones) + '）';
    } else if (!hint) {
      hint = '每次开箱都会获得修为，修为够了就能突破。';
    }
    $('ascendHint').textContent = hint;

    if (buffOn()) {
      $('buffBadge').classList.remove('hidden');
      $('buffTime').textContent = Math.ceil((state.buffUntil - Date.now()) / 1000);
    } else {
      $('buffBadge').classList.add('hidden');
    }

    if (equipDirty) renderEquip();
    else syncEquipButtons();

    if (combatDirty) renderCombat();

    renderLog();
    renderCollection();
  }

  function renderLog() {
    if (!logDirty) return;
    logDirty = false;
    const ul = $('logList');
    if (!state.log.length) {
      ul.innerHTML = '<li class="empty">挂机中……玄品以上的掉落会记录在这里。</li>';
      return;
    }
    ul.innerHTML = state.log
      .map((x) => '<li class="' + esc(x.cls) + '">' + esc(x.text) + '</li>')
      .join('');
  }

  function renderCollection() {
    $('collectionList').innerHTML = RARITIES.map((r, i) =>
      '<li class="r' + i + '"><span class="dot"></span><span class="cname">' + r.name +
      '</span><span class="ccount">' + fmt(state.counts[i]) + '</span></li>'
    ).join('');

    $('bestText').textContent = state.best >= 0
      ? '最高收集：' + RARITIES[state.best].name
      : '最高收集：—';
  }

  function updateTimer() {
    const p = Math.min(1, acc / interval());
    $('timerFill').style.width = (p * 100).toFixed(1) + '%';
  }

  /* ---------------- 主循环 ---------------- */

  function loop() {
    if (document.hidden) return;

    const now = performance.now();
    let dt = (now - last) / 1000;
    last = now;
    if (!isFinite(dt) || dt < 0) dt = 0;
    if (dt > 2) dt = 2;

    acc += dt;

    let opened = 0;
    while (acc >= interval() && opened < 50) {
      acc -= interval();
      openBox({ silent: true, bulk: true });
      opened++;
    }

    if (opened > 0 && now - lastSave > 3000) {
      save();
      lastSave = now;
    }

    if (uiMode === 'wild' && state.autoHunt && unlockedMode('wild')) {
      huntAcc += dt;
      if (huntAcc >= 3) {
        huntAcc = 0;
        doBattle('wild', { auto: true });
      }
    } else {
      huntAcc = 0;
    }

    if (now - lastRender > 100) {
      render();
      lastRender = now;
    }

    paintBag(false);
    updateTimer();
  }

  /* ---------------- 事件 ---------------- */

  function updateMute() {
    $('muteBtn').textContent = '音效：' + (state.muted ? '关' : '开');
  }

  function bind() {
    $('boxBtn').addEventListener('click', () => manualOpen(1));
    $('open1').addEventListener('click', () => manualOpen(1));
    $('open10').addEventListener('click', () => manualOpen(10));

    $('buySpeed').addEventListener('click', () => buy('speed'));
    $('buyGain').addEventListener('click', () => buy('gain'));
    $('buyLuck').addEventListener('click', () => buy('luck'));

    $('breakBtn').addEventListener('click', breakthrough);
    $('ascendBtn').addEventListener('click', ascend);

    $('equipGrid').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      const slot = btn.dataset.slot;
      if (act === 'enhance') enhanceSlot(slot);
      else if (act === 'unequip') unequipSlot(slot);
    });

    $('bagList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = Number(btn.dataset.id);
      if (!id) return;
      if (btn.dataset.act === 'wear') equipItem(id);
      else if (btn.dataset.act === 'salvage') salvageItem(id, false);
    });

    $('autoEquip').addEventListener('click', autoEquip);
    $('salvageLow').addEventListener('click', salvageLow);
    $('salvageAll').addEventListener('click', salvageAll);

    document.querySelector('.combat-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.combat-tab');
      if (!tab) return;
      setUiMode(tab.dataset.mode);
    });

    $('combatBtn').addEventListener('click', () => doBattle(uiMode));

    $('huntBtn').addEventListener('click', () => {
      if (!unlockedMode('wild')) return;
      state.autoHunt = !state.autoHunt;
      huntAcc = 0;
      combatDirty = true;
      save();
      renderCombat();
      floatText(state.autoHunt ? '自动巡猎开启' : '自动巡猎关闭', '#d8b36a');
    });

    $('zoneStrip').addEventListener('click', (e) => {
      const chip = e.target.closest('.zone-chip');
      if (!chip || chip.disabled) return;
      selectWildZone(Number(chip.dataset.zone));
    });

    $('trainingList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-train]');
      if (!btn) return;
      upgradeTraining(btn.dataset.train);
    });

    $('replayBattleBtn').addEventListener('click', replayBattleAnimation);
    $('battleSkip').addEventListener('click', skipBattleAnimation);
    $('battleClose').addEventListener('click', closeBattleModal);
    $('battleModal').addEventListener('click', (e) => {
      if (e.target === $('battleModal')) closeBattleModal();
    });

    $('muteBtn').addEventListener('click', () => {
      state.muted = !state.muted;
      updateMute();
      save();
    });

    $('resetBtn').addEventListener('click', () => {
      if (!confirm('确定重置全部进度？此操作不可撤销。')) return;
      state = defaults();
      save();
      location.reload();
    });

    $('offlineClose').addEventListener('click', () => {
      $('offlineModal').classList.remove('show');
    });

    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || e.repeat) return;
      const t = e.target;
      if (t && (t.tagName === 'BUTTON' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      manualOpen(1);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        state.lastSeen = Date.now();
        persist();
      } else {
        awardOffline();
        acc = 0;
        last = performance.now();
        render();
        paintBag(true);
        save();
      }
    });

    window.addEventListener('beforeunload', save);
    window.addEventListener('pagehide', save);
  }

  /* ---------------- 启动 ---------------- */

  load();
  awardOffline();
  bind();
  updateMute();
  render();
  paintBag(true);

  last = performance.now();
  lastRender = last;
  lastSave = last;
  lastBagPaint = last;
  setInterval(loop, 50);
  save();
})();
