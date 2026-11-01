(() => {
  'use strict';

  /* ============================================================
   * 灵匣纪元 · Spirit Box Odyssey
   * 纯前端放置开箱游戏：背包、装备、战力、强化、词条、宝石、离线收益，
   * 以及闯关 / 爬塔 / 野外三套秘境征战与专属套装。
   * 数值集中在下面几组常量里，方便自己改。
   * 「后续计划」见 docs/HANDOFF.md，玩法说明见 docs/README.md。
   * ============================================================ */

  const THEME_KEY = 'lingxia_theme'; // 主题提示键（仅防首帧闪烁，非存档；正题随云端档走）
  const CLOUD_MIN_GAP = 5000;        // 两次云存档推送的最小间隔
  const OFFLINE_CAP = 4 * 3600;      // 离线收益最多结算 4 小时
  const OFFLINE_EFF = 0.5;           // 离线效率 50%
  const CRIT_CHANCE = 0.05;          // 暴击率
  const CRIT_MULT = 10;              // 暴击倍率
  const EQUIP_CHANCE = 0.01;         // 每次开箱掉装备的概率（品质在掉落内按权重另掷）
  const DUST_CHANCE = 0.1;           // 开箱未掉装备时掉碎屑的概率（1~3 枚，补偿空开）
  const BUFF_CHANCE = 0.008;         // 每次开箱掉丹药的概率（未生效时）
  const BUFF_MS = 30000;             // 丹药持续时间
  // 背包格数：默认 100，用「乾坤扩容符」每张 +20，最高 300
  const BAG_CAP_BASE = 100;
  const BAG_EXPAND_PER = 20;
  const BAG_EXTRA_MAX = 200;
  const bagCap = () => BAG_CAP_BASE + Math.min(state.bagExtra || 0, BAG_EXTRA_MAX);
  const MAX_ENHANCE = 200;           // 单件装备强化上限（全等级线统一 200）

  /* ---------------- 秘境征战 ---------------- */

  const TOWER_MAX = 200;
  const STAGE_MAX = 200;
  const WILD_MAX = 200;
  const WILD_GROUP_SIZE = 20;                            // 野外关卡分组：每 20 关一组
  const WILD_GROUP_COUNT = Math.ceil(WILD_MAX / WILD_GROUP_SIZE);
  const ENDLESS_GATE = 60;           // 无尽秘境仍按旧口径：通塔 60 层开启（避免老档被重新锁上）
  const MAX_TRAIN = 200;

  // 难度曲线分段：旧上限内沿用原曲线（老进度零变化），之后增长放缓续接到 200
  const CURVE_LEGACY = { stage: 30, tower: 60, wild: 12 };
  // 尾段曲线 2026-10-30 整体加陡（原 1.045/1.053/1.047）：200 关制后段按复利拉长，
  // 末段难度为旧曲线的 2.5~5 倍；legacy 段（关 30/塔 60/野 12 内）保持原曲线
  const CURVE_TAIL = { stage: 1.055, tower: 1.06, wild: 1.055 };
  // 敌人强度总乘区（血/攻/防同乘）：进度墙主力——不靠硬锁，靠怪的难度自然封顶推进；
  // 建议战力标签同乘此系数保持口径一致
  const ENEMY_DIFF = 3.0;
  // 怪物难度二档曲线（2026-11-01 用户指定「提升闯关/爬塔/野外/无尽怪物难度」）：
  // 按关卡数对血/攻/防复利加压，只作用于敌人属性与建议战力标签，不进奖励公式
  // （contentReq 仍是收益与套装件战力口径，服务端经济包络不受影响）。
  // +0.8%/关：20 关 +17%、50 关 +50%、100 关 ×2.2、200 关 ×4.9；封顶 300 关防失控
  const ENEMY_HARD_STEP = 1.008;
  const diffBoost = (mode, level) => Math.pow(ENEMY_HARD_STEP, Math.min(level | 0, 300));
  // 装备加成收敛（2026-10-30）：词条/宝石等百分比加成在 playerCombatStats 消费端折算，
  // 老档存量装备同步生效（装备面板显示的仍是词条原始值）；战力主通道走灵石/道具升级，
  // 装备只做补充。套装为数值表直改、文案同步；共鸣/符文组词量级仅 3-12% 不动；
  // 开箱收益暴击是另一套 CRIT_MULT=10，勿混用
  const GROWTH_SCALE = 0.25;      // 百分比加成保留比例
  const CRIT_CAP = 0.4;           // 暴击率上限（原 0.6）
  const COMBAT_CRIT_MULT = 1.75;  // 战斗暴击伤害倍率（原 2）

  const MODES = {
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

  // 无尽秘境词缀：按 (层数-1) % 3 轮换
  const ENCHANTS = [
    { name: '坚壁', desc: '敌方防御 ×1.6', def: 1.6 },
    { name: '狂暴', desc: '敌方攻击 ×1.35', atk: 1.35 },
    { name: '厚血', desc: '敌方生命 ×1.5', hp: 1.5 },
  ];

  // 套装件随机掉率（2026-11-01 用户指定逐次下调，末档 2026-11-01 定值：
  // 野外随机 0.8%/保底 50 杀/无尽与复战扫荡 0.8%；离线巡猎估算与 UI 文案
  // 同读本组常量，口径恒一致）。首通里程碑与满层/满野首通必掉是进度奖励骨架，不动
  const WILD_SET_PITY = 50;     // 野外本区击杀保底：每 N 杀必掉 1 件
  const WILD_SET_RATE = 0.008;  // 野外每场随机掉率 0.8%（离线巡猎估算同口径）
  const MODE_SET_RATE = 0.008;  // 无尽 / 闯关爬塔复战与扫荡的每场随机掉率 0.8%
  const OFFLINE_HUNT_PITY = 100; // 离线巡猎估算保底：每 N 胜必掉 1 件（2026-11-01 用户指定，弱于在线 50 杀）

  // 自动战斗节奏（2026-11-01 用户指定）：自动巡猎/连续挑战每场结束后间隔 1 分钟，
  // 离线巡猎估算同口径（1 场/分钟），四模式共用此节奏；体力闸门（一场 1 点）照常生效
  const HUNT_INTERVAL_S = 60;

  // 四秘境战斗修为 nerf（2026-11-01 用户指定）：闯关/爬塔/野外/无尽的修为报酬降为 1/50，
  // 在线战斗、扫荡与离线巡猎估算同乘此系数；开箱修为（expected()）与功法通道不动。
  // 灵石/碎屑/兽骨等其余奖励不动；只降不涨，服务端经济包络无需放宽
  const MODE_EXP_MULT = 1 / 50;

  // 首通里程碑：沿用原节奏（塔 10 / 关 5 / 野 2 一档）循环十二部位，一直铺到 200
  // （2026-11-01 槽位扩容：加入手镯/戒指/护腕/护腿/发箍/翅膀，轮转取模随数组长度走）
  const MILESTONE_SLOTS = ['weapon', 'armor', 'helm', 'boots', 'artifact', 'talisman',
    'bracelet', 'ring', 'wrist', 'legs', 'band', 'wings'];
  const MILESTONES = { tower: {}, stage: {}, wild: {} };
  for (let lv = 10; lv <= TOWER_MAX; lv += 10) MILESTONES.tower[lv] = MILESTONE_SLOTS[(lv / 10 - 1) % MILESTONE_SLOTS.length];
  for (let lv = 5; lv <= STAGE_MAX; lv += 5) MILESTONES.stage[lv] = MILESTONE_SLOTS[(lv / 5 - 1) % MILESTONE_SLOTS.length];
  for (let lv = 1; lv <= WILD_MAX; lv += 2) MILESTONES.wild[lv] = MILESTONE_SLOTS[((lv - 1) / 2) % MILESTONE_SLOTS.length];

  // 扫荡（2026-10-31）：已通关关卡 instant 重打；每日每玩法免费 10 次，用完可
  // 灵石加购 20 万/次、每日至多加购 10 次。奖励口径：闯关/爬塔按「再战」5 折、
  // 野外维持现状全额；一律无首通奖励、不推进关卡进度（野外击杀计数照常）。
  const SWEEP_DAILY_FREE = 10;
  const SWEEP_BUY_MAX = 30;
  const SWEEP_BUY_COST = 200000;
  // 野外已胜怪物每日挑战上限（2026-10-31）：全局共享 50 次/日（非每怪物各 50），
  // 挑战即计数（战败也占）；扫荡走独立额度不占此数；首通挑战不受限
  const WILD_REPEAT_DAILY = 50;
  const emptyDailySweep = () => ({ stage: 0, tower: 0, wild: 0 });
  const clampDailySweep = (raw, hi) => {
    const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const out = emptyDailySweep();
    for (const k of ['stage', 'tower', 'wild']) {
      out[k] = Math.max(0, Math.min(hi, Math.floor(src[k]) || 0));
    }
    return out;
  };

  const SETS = {
    tower: {
      name: '镇塔', cls: 'set-tower',
      pieces: {
        weapon: '镇塔·斩妖剑', armor: '镇塔·玄鳞甲', helm: '镇塔·观星冠',
        boots: '镇塔·踏云履', artifact: '镇塔·镇魂印', talisman: '镇塔·封魔符',
        // 第七批槽位（2026-11-01）：套装补齐 12 部位，与 MILESTONE_SLOTS / 服务端白名单对齐
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

  const TROPHIES = {
    tower: { name: '塔印', field: 'towerMarks', color: '#fbbf24' },
    stage: { name: '战功', field: 'warMerits', color: '#60a5fa' },
    wild: { name: '兽骨', field: 'beastBones', color: '#4ade80' },
    endless: { name: '塔印', field: 'towerMarks', color: '#fbbf24' }, // 无尽也产塔印
  };

  const TRAININGS = {
    // 战意/体魄消费端过 GROWTH_SCALE（×0.25，见 playerCombatStats），文案按实际值标；
    // 破甲消费端不折算（pierce = 0.015·级 原值），文案保持全值（2026-11-01 口径对齐）
    atk: { name: '战意', desc: '攻击 +0.75% / 级', lvField: 'trainAtk', currency: 'towerMarks' },
    hp: { name: '体魄', desc: '生命 +0.75% / 级', lvField: 'trainHp', currency: 'warMerits' },
    pierce: { name: '破甲', desc: '无视敌人防御 +1.5% / 级', lvField: 'trainPierce', currency: 'beastBones' },
  };
  // 战技升级成本（2026-10-30 陡峭化）：1.5 次幂增长（累计 ~22 万勋章）——
  // 按钮标价与 upgradeTraining 扣费必须同源走此函数，勿在各处内联公式
  const trainCost = (lv) => Math.ceil(Math.pow(lv + 1, 1.5));

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
  // 逢 10 层一主：补足到 200 层共 20 位塔主
  const TOWER_BOSS_POOL = [
    ['玄天塔主', '玄'], ['紫霄塔主', '紫'], ['万魔塔主', '魔'], ['灭世塔主', '灭'],
    ['鸿蒙塔主', '鸿'], ['混沌塔主', '混'], ['太初塔主', '初'], ['永夜塔主', '夜'],
    ['星陨塔主', '陨'], ['黄泉塔主', '泉'], ['九阳塔主', '阳'], ['北冥塔主', '冥'],
    ['无极塔主', '极'], ['归墟塔主', '墟'],
  ];
  for (const [name, icon] of TOWER_BOSS_POOL) TOWER_BOSSES.push({ name, icon });

  const STAGE_CHAPTERS = [
    { name: '青石古道', icon: '山', monsters: ['山贼', '青蛇', '灰狼'], boss: '占山虎王' },
    { name: '幽篁林', icon: '竹', monsters: ['竹妖', '毒蛛', '林魈'], boss: '千年竹母' },
    { name: '赤炎峡', icon: '炎', monsters: ['火鼠', '炎蜥', '熔岩鬼'], boss: '赤炎魔君' },
    { name: '寒霜原', icon: '霜', monsters: ['雪狼', '冰魄', '霜巨人'], boss: '寒霜王' },
    { name: '九霄阶', icon: '雷', monsters: ['雷鹏', '云将', '天兵'], boss: '九霄雷帝' },
    { name: '天外墟', icon: '墟', monsters: ['星兽', '虚空影', '古神卫'], boss: '天外墟主' },
  ];
  // 每章 5 关：补足 40 章（第 7~40 章，对应 31~200 关），深层主题按幕递进
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
  // 一级一区域：以 12 大区域为基底、按 20 级一档叠加时代前缀，扩到 200 区域
  const WILD_TIERS = ['幽', '煞', '狂', '古', '仙', '神', '虚空', '混沌', '鸿蒙', '太初'];
  for (let lv = WILD_ZONES.length + 1; lv <= WILD_MAX; lv++) {
    const base = WILD_ZONES[(lv - 1) % 12];
    const tier = WILD_TIERS[Math.floor((lv - 13) / 20)];
    WILD_ZONES.push({ name: tier + base.name, monster: tier + base.monster, icon: base.icon });
  }

  const RARITIES = [
    { name: '凡品', color: '#9aa4b2', weight: 1000, stone: 1, exp: 0 },
    { name: '灵品', color: '#4ade80', weight: 350, stone: 3, exp: 1 },
    { name: '玄品', color: '#60a5fa', weight: 100, stone: 10, exp: 3 },
    { name: '地品', color: '#c084fc', weight: 25, stone: 35, exp: 8 },
    { name: '天品', color: '#fbbf24', weight: 2, stone: 150, exp: 20 },
    { name: '仙品', color: '#f87171', weight: 0.4, stone: 800, exp: 50 },
  ];

  const SLOTS = [
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
    // 第七批槽位（2026-11-01）：命名沿用现有品质风味线（凡朴 / 灵青 / 玄紫 / 地煞九幽 / 天罡凤凰太虚 / 鸿蒙造化混沌）
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

  const BASE_POWER = [3, 10, 30, 90, 280, 900];

  /* ---------------- 词条 / 洗练 / 宝石 ---------------- */

  // 词条池：atk/hp/def 为属性百分比；crit/ls/pierce 直加战斗数值
  const AFFIXES = [
    { k: 'atk', name: '攻击', min: 0.03, max: 0.08 },
    { k: 'hp', name: '生命', min: 0.04, max: 0.12 },
    { k: 'def', name: '防御', min: 0.04, max: 0.10 },
    { k: 'crit', name: '暴击', min: 0.01, max: 0.03 },
    { k: 'ls', name: '吸血', min: 0.01, max: 0.03 },
    { k: 'pierce', name: '破甲', min: 0.01, max: 0.03 },
  ];
  const AFFIX_COUNT = [0, 0, 0, 1, 2, 3];               // 各品质词条条数：地1 / 天2 / 仙3
  const AFFIX_QMULT = [0.5, 0.6, 0.75, 0.9, 1.1, 1.35]; // 词条数值幅度随品质放大

  const GEM_TIERS = [
    { name: '下品', dust: 100 },
    { name: '中品', dust: 400 },
    { name: '上品', dust: 1000 },
  ];
  // 部位孔位费用递增（2026-10-31 指定）：首孔上品 1000、末孔（第 6 孔）上品 10 万，中间几何插值 ≈×2.5
  // 下/中品按 0.1 / 0.4 折算上品价；孔位数随飞升 2→6 逐步解锁，高价孔天然后置
  const GEM_SOCKET_MULT = [1, 2.5, 6.5, 16, 40, 100];
  const GEM_VALUES = {
    atk: [0.02, 0.04, 0.07],
    hp: [0.03, 0.06, 0.10],
    def: [0.03, 0.05, 0.08],
    crit: [0.008, 0.015, 0.025],
    ls: [0.008, 0.015, 0.025],
    pierce: [0.01, 0.02, 0.035],
  };
  const DUST_BY_RARITY = [0, 1, 2, 4, 8, 16]; // 分解普通装备得碎屑
  const SHORT_NAME = { atk: '攻', hp: '血', def: '防', crit: '暴', ls: '吸', pierce: '破' };

  /* ---------------- 灵宠 / 洞府 / 日常 / 成就 ---------------- */

  const PET_CHANCE = 0.004;   // 每次开箱掉招募券概率
  const PET_MAX_LV = 200;
  const PETS = [
    { id: 'fox', name: '雷灵狐', icon: '狐', stat: 'atk', per: 0.02, cost: 1, desc: '攻击' },
    { id: 'turtle', name: '铁甲龟', icon: '龟', stat: 'hp', per: 0.025, cost: 1, desc: '生命' },
    { id: 'rat', name: '灵瞳鼠', icon: '鼠', stat: 'crit', per: 0.004, cost: 2, desc: '暴击' },
    { id: 'pixiu', name: '招财貔貅', icon: '貔', stat: 'gain', per: 0.03, cost: 2, desc: '灵石收益' },
  ];
  // 灵宠图标（SVG，currentColor 随 .pet-icon 金色；缺省回退 p.icon 文字）
  const PET_ICONS = {
    fox: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M4 3l4.6 2.6C10 5.2 11 5 12 5s2 .2 3.4.6L20 3l-1.4 4.8c.9 1.3 1.4 2.8 1.4 4.4 0 4.6-3.6 7.8-8 7.8s-8-3.2-8-7.8c0-1.6.5-3.1 1.4-4.4L4 3zm3.2 9.2a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zm9.6 0a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2zM12 15.2c-1.2 0-2.2.6-2.2 1.2s1 .9 2.2.9 2.2-.3 2.2-.9-1-1.2-2.2-1.2z" fill-rule="evenodd"/></svg>',
    turtle: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M4.5 12a7.5 6.5 0 0 1 15 0v2h-15v-2z"/><path fill="currentColor" d="M2.5 14.5h3v3.5h-3zM18.5 14.5h3v3.5h-3zM7.5 16.5h3V20h-3zM13.5 16.5h3V20h-3z"/><circle fill="currentColor" cx="21" cy="12.5" r="2"/></svg>',
    rat: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M2.5 15.5c0-4.4 4.1-7.5 8.5-7.5 2.6 0 4.8 1 6.3 2.7.9-.5 2-.8 3.2-.6-.6 1-1.5 1.8-2.6 2.2.4.9.6 1.9.6 3.2h-16zm9.9-6.3a1 1 0 1 0-2 0 1 1 0 0 0 2 0zm1.6-1.7a3 3 0 1 1 0-4.3 3 3 0 0 1 0 4.3z"/></svg>',
    pixiu: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 3.5l2.6 2.6h3.2l-1.2 3.4 1.9 2.7c.1 4.9-3.4 8.8-6.5 8.8s-6.6-3.9-6.5-8.8l1.9-2.7-1.2-3.4h3.2L12 3.5zm-3.5 8.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zm7 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z" fill-rule="evenodd"/></svg>',
  };
  const petFeedCost = (lv) => Math.floor(200 * Math.pow(1.6, lv));

  const CAVE = {
    array: { name: '聚灵阵', icon: '阵', base: 500, growth: 1.7, max: 200, desc: '灵石收益 +8% / 级' },
    garden: { name: '药园', icon: '药', base: 800, growth: 1.75, max: 200, desc: '开箱暴击率 +0.4% / 级' },
    library: { name: '藏经阁', icon: '书', base: 1200, growth: 1.8, max: 200, desc: '修为收益 +10% / 级' },
  };
  // 洞府建筑图标（SVG，currentColor 随 .cave-icon 金色；缺省回退 def.icon 文字）
  const CAVE_ICONS = {
    array: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5l6 10.5H6z"/><path d="M12 20.5L6 10h12z"/></svg>',
    garden: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M20 4C11 4 5 9.5 5 16.5c0 1.9.8 3.5 1.5 4.5.8-5 4-10 9.5-13-4.5 4-7.5 9-8 13 .9.6 2 1 3.5 1C18 22 21 14 20 4z"/></svg>',
    library: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M7 2h11a1 1 0 0 1 1 1v17a1 1 0 0 1-1 1H7a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3zm0 15a1.5 1.5 0 0 0 0 3h11v-3H7z"/></svg>',
  };
  // 丹药图标（SVG）
  const ELIXIR_ICONS = {
    atk: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><g fill="currentColor"><g id="elixirSword"><path d="M3 3l3.2.4L14 11.2l-2.8 2.8L3.4 6.2 3 3z"/><path d="M9.6 13.6l4-4 1.9 1.9-4 4-1.9-1.9z"/><path d="M13.8 15.8l1.5-1.5 4.9 4.9-1.5 1.5-4.9-4.9z"/></g><use href="#elixirSword" transform="translate(24 0) scale(-1 1)"/></g></svg>',
    def: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 2l8 3.2V11c0 5.2-3.4 9.4-8 11-4.6-1.6-8-5.8-8-11V5.2L12 2z"/></svg>',
    gain: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM9.5 9.5h5v5h-5v-5z"/></svg>',
  };
  const caveCost = (key) => Math.floor(CAVE[key].base * Math.pow(CAVE[key].growth, state.cave[key]));

  // 旧日常数值放大（2026-10-30）：日活大盘子扩到 +5000 万~8000 万灵石/日（约翻倍），
  // 每日任务/签到/试炼/BossRush 灵石同批 ×1000；碎屑稀缺性保留不动
  const DAILY_TASKS = [
    { id: 'opens', name: '开箱 200 次', target: 200, reward: { stones: 3e6 } },
    { id: 'wins', name: '秘境获胜 15 场', target: 15, reward: { stones: 3e6, dust: 20 } },
    { id: 'forge', name: '工坊操作 5 次', target: 5, reward: { stones: 3e6, dust: 30 } },
  ];
  const DAILY_ALL_BONUS = { stones: 6e6, dust: 50 }; // 三项全部领取的额外奖励
  const SIGN_REWARDS = [
    { stones: 1e6, text: '100 万灵石' },
    { stones: 2e6, text: '200 万灵石' },
    { dust: 30, text: '30 碎屑' },
    { stones: 4e6, text: '400 万灵石' },
    { stones: 6e6, text: '600 万灵石' },
    { dust: 60, text: '60 碎屑' },
    { stones: 1.2e7, dust: 100, text: '1200 万灵石 + 100 碎屑' },
  ];
  // 赌狗签到：押上当日普通签到奖励掷倍率——49% 狂赚 2~5 倍 / 10% 保本 ×1 /
  // 20% 空手 / 21% 翻车倒扣 1~3 倍。倒扣直接减余额：灵石可负债（负到赚回来为止，
  // 不吃增益、不动 totalStones），碎屑倒扣以 0 为底；果报双掷取优/劣（与赌石同口径）
  const SIGN_GAMBLE = { pBig: 49, pKeep: 10, pZero: 20, bigMin: 2, bigMax: 5, bustMin: 1, bustMax: 3 };
  const SIGN_LOG_MAX = 30;   // 签到流水保留条数（新条目在前）
  const SIGN_LOG_SHOW = 7;   // 战绩面板展示条数

  // 部位化后「最高强化」= 六槽强化等级的最大值
  function maxItemLv(s) {
    let m = 0;
    for (const k of SLOTS) {
      const lv = (s.enh && s.enh[k.key]) || 0;
      if (lv > m) m = lv;
    }
    return m;
  }

  const ACHIEVEMENTS = [
    { id: 'open100', name: '初窥门径', desc: '累计开箱 100 次', cur: (s) => s.opens, target: 100, stones: 500 },
    { id: 'open1000', name: '开匣如流', desc: '累计开箱 1000 次', cur: (s) => s.opens, target: 1000, stones: 3000 },
    { id: 'open1w', name: '万匣归一', desc: '累计开箱 10000 次', cur: (s) => s.opens, target: 10000, stones: 30000, title: '开匣圣手' },
    { id: 'stone10w', name: '家底殷实', desc: '累计获得 10 万灵石', cur: (s) => s.totalStones, target: 100000, stones: 5000 },
    { id: 'stone1e', name: '灵石如山', desc: '累计获得 1 亿灵石', cur: (s) => s.totalStones, target: 1e8, stones: 100000, title: '富甲一方' },
    { id: 'bestDi', name: '地品入怀', desc: '首次开出到地品装备', cur: (s) => s.best, target: 3, stones: 1000 },
    { id: 'bestTian', name: '天眷之人', desc: '首次开出到天品装备', cur: (s) => s.best, target: 4, stones: 5000 },
    { id: 'bestXian', name: '仙缘初现', desc: '首次开出到仙品装备', cur: (s) => s.best, target: 5, stones: 20000 },
    { id: 'realm4', name: '元婴大成', desc: '境界达到元婴', cur: (s) => s.realm, target: 3, stones: 5000 },
    { id: 'realm9', name: '陆地神仙', desc: '境界达到仙人', cur: (s) => s.realm, target: 9, stones: 100000, title: '陆地神仙' },
    { id: 'stage10', name: '小有名气', desc: '通关闯关第 10 关', cur: (s) => s.stageCleared, target: 10, stones: 4000, trophies: { field: 'warMerits', n: 20 } },
    { id: 'stage30', name: '征伐天下', desc: '通关闯关第 30 关', cur: (s) => s.stageCleared, target: 30, stones: 50000, trophies: { field: 'warMerits', n: 100 }, title: '征伐大将军' },
    { id: 'tower30', name: '登塔三十', desc: '爬塔到达 30 层', cur: (s) => s.towerCleared, target: 30, stones: 20000, trophies: { field: 'towerMarks', n: 30 } },
    { id: 'tower60', name: '塔顶风光', desc: '爬塔到达 60 层', cur: (s) => s.towerCleared, target: 60, stones: 100000, trophies: { field: 'towerMarks', n: 100 }, title: '镇塔尊者' },
    { id: 'endless10', name: '无尽起步', desc: '无尽秘境到达 10 层', cur: (s) => s.endlessBest, target: 10, stones: 50000, trophies: { field: 'towerMarks', n: 100 }, title: '探幽先行' },
    { id: 'wild6', name: '荒猎好手', desc: '首通野外 6 个区域', cur: (s) => s.wildCleared.length, target: 6, stones: 15000, trophies: { field: 'beastBones', n: 30 } },
    { id: 'wild12', name: '荒域之主', desc: '首通野外 12 个区域', cur: (s) => s.wildCleared.length, target: 12, stones: 80000, trophies: { field: 'beastBones', n: 100 }, title: '荒域之主' },
    { id: 'setMax', name: '套装收藏家', desc: '任一套装图鉴集齐 6 件', cur: (s) => Math.max(collectCount('tower'), collectCount('stage'), collectCount('wild')), target: 6, stones: 30000, dust: 100, title: '收藏大家' },
    { id: 'enhance20', name: '强化宗师', desc: '部位强化至 +20', cur: (s) => maxItemLv(s), target: 20, stones: 10000, title: '神匠' },
    { id: 'ascend1', name: '超脱轮回', desc: '完成首次飞升', cur: (s) => s.ascensions, target: 1, stones: 200000, title: '超脱者' },
    // —— 二梯队 ——
    { id: 'open10w', name: '开匣传奇', desc: '累计开箱 100000 次', cur: (s) => s.opens, target: 100000, stones: 200000, title: '开匣传奇' },
    { id: 'dust1k', name: '碎屑成山', desc: '累计获得 1000 碎屑', cur: (s) => s.dustTotal || 0, target: 1000, stones: 20000 },
    { id: 'petMax', name: '心意相通', desc: '任一灵宠亲密度达到 10', cur: (s) => Math.max(0, ...Object.values(s.pets || {})), target: 10, stones: 30000 },
    { id: 'petAll', name: '四灵齐全', desc: '招募全部 4 只灵宠', cur: (s) => Object.keys(s.pets || {}).length, target: 4, stones: 50000, title: '驭灵师' },
    { id: 'tokenMax', name: '信物圆满', desc: '任一灵宠信物达到 10 级', cur: (s) => Math.max(0, ...Object.values(s.petTokens || {})), target: 10, stones: 40000 },
    { id: 'gongfaMax', name: '功法通玄', desc: '任一功法达到 5 级', cur: (s) => Math.max(s.gongfa.atk, s.gongfa.hp, s.gongfa.hui), target: 5, stones: 50000, title: '功法宗师' },
    { id: 'immortal5', name: '仙界大能', desc: '仙位达到 5', cur: (s) => s.immortal, target: 5, stones: 500000, title: '仙界大能' },
    { id: 'rogueClear', name: '探幽无阻', desc: '秘境探幽到达第 8 层', cur: (s) => s.rogue.best, target: 8, stones: 80000, dust: 200, title: '探幽宗师' },
    { id: 'trial30', name: '试炼大师', desc: '累计通过条件试炼 30 次', cur: (s) => s.trialWins || 0, target: 30, stones: 30000 },
    { id: 'rushS3', name: '连战如风', desc: '首领连战取得 3 次 S 级', cur: (s) => s.rushS || 0, target: 3, stones: 60000, dust: 150 },
  ];

  // —— 成就三梯队：规则化梯子（30 手写 + 170 生成 = 200 个，id 稳定可入档）——
  const ACHV_ZH = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const fmtAchvNum = (n) => {
    if (n >= 1e12) return n / 1e12 + ' 万亿';
    if (n >= 1e8) return n / 1e8 + ' 亿';
    if (n >= 1e4) return n / 1e4 + ' 万';
    return String(n);
  };
  const setTotalCount = (s) =>
    ['tower', 'stage', 'wild'].reduce(
      (n, k) => n + ((s.setCollection && s.setCollection[k]) ? s.setCollection[k].length : 0), 0);
  // 注意：须先于 ACHV_LADDERS 声明（其 label 闭包按名字直接引用，勿下移）
  const REALMS = ['炼气', '筑基', '金丹', '元婴', '化神', '炼虚', '合体', '大乘', '渡劫', '仙人'];

  // 十境徽标（境界 hero 卡右上角）：金线单色 SVG，突破境界时随 renderNow 换徽
  const REALM_EMBLEMS = [
    // 炼气：气旋升腾
    '<svg viewBox="0 0 48 48" fill="none" stroke="#f7edd2" stroke-width="2" stroke-linecap="round"><path d="M15 37c5-2 5-7 1-9 6-3 5-8 1-10 7-2 8-8 3-11"/><path d="M25 38c5-2 5-7 1-9 6-3 5-8 1-10" opacity=".75"/><path d="M34 36c4-2 4-6 1-8" opacity=".5"/></svg>',
    // 筑基：基台三层
    '<svg viewBox="0 0 48 48" fill="none" stroke="#f7edd2" stroke-width="2" stroke-linejoin="round"><rect x="12" y="34" width="24" height="5" rx="1.5"/><rect x="16" y="27" width="16" height="5" rx="1.5"/><rect x="20" y="20" width="8" height="5" rx="1.5"/><circle cx="24" cy="13" r="3"/></svg>',
    // 金丹：丹核悬辉
    '<svg viewBox="0 0 48 48" fill="none" stroke="#f7edd2" stroke-width="2"><circle cx="24" cy="24" r="9" fill="rgba(240,217,168,.3)"/><circle cx="20.5" cy="20.5" r="2.5" fill="#fff6d8" stroke="none"/><circle cx="36" cy="13" r="1.8" opacity=".8"/><circle cx="11" cy="34" r="1.8" opacity=".8"/></svg>',
    // 元婴：婴现莲台
    '<svg viewBox="0 0 48 48" fill="none" stroke="#f7edd2" stroke-width="2" stroke-linecap="round"><circle cx="24" cy="16" r="5.5"/><path d="M11 34c3-8 8-11 13-11s10 3 13 11"/><path d="M13 36c3 4 19 4 22 0" opacity=".8"/></svg>',
    // 化神：神变星芒
    '<svg viewBox="0 0 48 48" fill="none" stroke="#f7edd2" stroke-width="2" stroke-linejoin="round"><path d="M24 11l3.4 8.6L36 23l-8.6 3.4L24 35l-3.4-8.6L12 23l8.6-3.4z"/><circle cx="37" cy="13" r="1.8" opacity=".8"/><circle cx="11" cy="35" r="1.8" opacity=".8"/></svg>',
    // 炼虚：虚境空环
    '<svg viewBox="0 0 48 48" fill="none" stroke="#f7edd2" stroke-width="2"><circle cx="24" cy="24" r="10" stroke-dasharray="4 4"/><circle cx="24" cy="24" r="4" opacity=".7"/><path d="M7 24h4M37 24h-4" opacity=".6"/></svg>',
    // 合体：双环合契
    '<svg viewBox="0 0 48 48" fill="none" stroke="#f7edd2" stroke-width="2"><circle cx="19" cy="19" r="8.5"/><circle cx="29" cy="29" r="8.5"/></svg>',
    // 大乘：乘莲宝座
    '<svg viewBox="0 0 48 48" fill="none" stroke="#f7edd2" stroke-width="2" stroke-linecap="round"><path d="M10 33c2-10 8-15 14-15s12 5 14 15"/><path d="M14 33c4 5 16 5 20 0" opacity=".8"/><circle cx="24" cy="17" r="3.5"/></svg>',
    // 渡劫：云雷天罚
    '<svg viewBox="0 0 48 48" fill="none" stroke="#f7edd2" stroke-width="2" stroke-linejoin="round"><path d="M12 24c-3-6 2-12 8-11 2-5 10-5 12 0 5 1 7 7 3 11H12z" opacity=".85"/><path d="M26 20l-7 9h5l-4 9 8-11h-5z" fill="#f0d9a8" stroke="#d8b36a"/></svg>',
    // 仙人：登仙乘云
    '<svg viewBox="0 0 48 48" fill="none" stroke="#f7edd2" stroke-width="2" stroke-linecap="round"><circle cx="24" cy="13" r="4.5"/><path d="M15 33c0-7 4-11 9-11s9 4 9 11"/><path d="M17 37c2 3 12 3 14 0" opacity=".8"/><path d="M8 10c4-5 10-7 16-7s12 2 16 7" opacity=".45"/></svg>',
  ];
  // 突破修为门槛：前期平缓保新手节奏，化神起逐境加陡（6→8→10→12.5→15→16.7 倍），压制后期升级速度
  const REALM_COSTS = [0, 60, 400, 2500, 20000, 160000, 1600000, 20000000, 300000000, 5000000000];
  // 轮回门槛系数：每点仙缘全梯门槛 ×2.5，对冲仙缘收益成长（2026-11-01 起永久收益 +5%/点、开箱修为 +50%/点等），
  // 使每次飞升后下一轮周期比上一轮长约 1~2 天。state 运行时才初始化，仅在事件/渲染中调用。
  const realmCostOf = (i) =>
    Math.ceil(REALM_COSTS[Math.max(0, Math.min(REALM_COSTS.length - 1, i | 0))] *
      Math.pow(2.5, Math.max(0, state.ascensions | 0)));

  const ACHV_LADDERS = [
    { id: 'open', prefix: '开匣', cur: (s) => s.opens, label: (n) => '累计开箱 ' + fmtAchvNum(n) + ' 次',
      tiers: [2e5, 5e5, 1e6, 5e6, 1e7, 5e7, 1e8, 5e8, 1e9, 5e9], base: 3e5, ratio: 3,
      names: ['开匣不辍', '开匣成瘾', '开匣狂人', '开匣宗师', '开匣神话'], title: { 9: '开匣神话' } },
    { id: 'stone', prefix: '聚财', cur: (s) => s.totalStones, label: (n) => '累计获得 ' + fmtAchvNum(n) + ' 灵石',
      tiers: [1e6, 1e7, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16], base: 3e5, ratio: 3,
      names: ['堆石成丘', '灵石成山', '灵石成海', '富可敌国'] },
    { id: 'dust', prefix: '拾尘', cur: (s) => s.dustTotal || 0, label: (n) => '累计获得 ' + fmtAchvNum(n) + ' 碎屑',
      tiers: [5000, 2e4, 1e5, 5e5, 2e6, 1e7, 5e7], base: 2e5, ratio: 2.5,
      names: ['碎屑成堆', '碎屑成山', '碎屑成河'] },
    { id: 'realm', prefix: '问道', cur: (s) => s.realm, label: (n) => '境界达到「' + REALMS[n] + '」',
      tiers: [1, 2, 4, 5, 6, 7, 8], base: 2e5, ratio: 3, title: { 6: '渡劫真人' } },
    { id: 'stage', prefix: '征伐', cur: (s) => s.stageCleared, label: (n) => '通关闯关第 ' + n + ' 关',
      tiers: [50, 80, 120, 160, 200], base: 5e5, ratio: 3,
      names: ['征途漫漫', '关关相连', '百关斩将', '一路平推', '闯关无双'], title: { 4: '闯关无双' } },
    { id: 'tower', prefix: '登塔', cur: (s) => s.towerCleared, label: (n) => '爬塔到达 ' + n + ' 层',
      tiers: [90, 120, 150, 180, 200], base: 5e5, ratio: 3,
      names: ['塔势凌云', '高塔不倦', '塔心如一', '塔顶之巅', '通塔至尊'], title: { 4: '通塔至尊' } },
    { id: 'wild', prefix: '荒猎', cur: (s) => s.wildCleared.length, label: (n) => '首通野外 ' + n + ' 个区域',
      tiers: [30, 60, 100, 150, 200], base: 4e5, ratio: 3,
      names: ['猎踪遍野', '荒域行商', '百域猎王', '万野皆行', '万域之王'], title: { 4: '万域之王' } },
    { id: 'endless', prefix: '无尽', cur: (s) => s.endlessBest, label: (n) => '无尽秘境到达 ' + n + ' 层',
      tiers: [30, 60, 100, 150, 200, 300, 500, 800, 1000, 2000], base: 2e5, ratio: 2.5,
      names: ['无尽行者', '无尽斗者', '无尽战神', '无尽之主'], title: { 8: '无尽之主' } },
    { id: 'rogue', prefix: '探幽', cur: (s) => s.rogue.best, label: (n) => '秘境探幽到达第 ' + n + ' 层',
      tiers: [20, 40, 60, 80, 100, 130, 160, 200], base: 3e5, ratio: 3,
      names: ['幽径深行', '幽窟不惧', '幽深百层', '幽境之神'], title: { 7: '探幽之神' } },
    { id: 'bestiary', prefix: '博物', cur: (s) => Object.keys(s.bestiary || {}).length, label: (n) => '怪物图鉴收录 ' + n + ' 种物种',
      tiers: [5, 10, 20, 30, 50, 80, 120, 160, 200, 260, 320], base: 1e5, ratio: 2.2,
      names: ['格物初学', '万物有名', '百兽在册', '千妖入卷'] },
    { id: 'wins', prefix: '百战', cur: (s) => (s.battleStats && s.battleStats.wins) || 0, label: (n) => '秘境累计获胜 ' + fmtAchvNum(n) + ' 场',
      tiers: [100, 500, 2000, 1e4, 5e4, 2e5, 1e6, 5e6, 1e7, 1e8], base: 2e5, ratio: 2.6,
      names: ['小战连捷', '身经百战', '千锤百炼', '战意如虹'] },
    { id: 'dmg', prefix: '锋芒', cur: (s) => (s.battleStats && s.battleStats.dmg) || 0, label: (n) => '累计造成 ' + fmtAchvNum(n) + ' 点伤害',
      tiers: [1e6, 1e8, 1e10, 1e12, 1e14, 1e16], base: 3e5, ratio: 2.8,
      names: ['初露锋芒', '势如破竹', '一击百万', '伤害如山'] },
    { id: 'taken', prefix: '金身', cur: (s) => (s.battleStats && s.battleStats.taken) || 0, label: (n) => '累计承受 ' + fmtAchvNum(n) + ' 点伤害',
      tiers: [1e6, 1e8, 1e10, 1e12, 1e14, 1e16], base: 3e5, ratio: 2.8,
      names: ['皮糙肉厚', '刀枪不入', '以身为鼎', '不坏之躯'] },
    { id: 'trial', prefix: '试炼', cur: (s) => s.trialWins || 0, label: (n) => '累计通过条件试炼 ' + fmtAchvNum(n) + ' 次',
      tiers: [100, 300, 1000, 3000, 1e4, 3e4], base: 2e5, ratio: 2.5,
      names: ['试炼常客', '试炼行家', '试炼无双'] },
    { id: 'rush', prefix: '连战', cur: (s) => s.rushS || 0, label: (n) => '首领连战取得 ' + n + ' 次 S 级',
      tiers: [10, 30, 100, 300], base: 1e5, ratio: 3, names: ['连战如虹', 'S 级常客', '速战速决', '连战神话'] },
    { id: 'setall', prefix: '鉴藏', cur: setTotalCount, label: (n) => '套装图鉴共收录 ' + n + ' 件部件',
      tiers: [12, 18], base: 5e5, ratio: 2.5, names: ['套装大成', '鉴藏宗师'], title: { 1: '鉴藏宗师' } },
    { id: 'immortal', prefix: '仙位', cur: (s) => s.immortal, label: (n) => '仙位达到 ' + n,
      tiers: [10, 25, 50, 100, 200, 400], base: 1e6, ratio: 2.5, names: ['仙位高升', '仙班前列', '仙帝之姿'] },
    { id: 'ascend', prefix: '轮回', cur: (s) => s.ascensions, label: (n) => '累计飞升 ' + n + ' 次',
      tiers: [2, 5, 10, 25, 50, 100], base: 5e5, ratio: 2.5,
      names: ['再入轮回', '轮回熟客', '超脱常客', '轮回之主'] },
    { id: 'sign', prefix: '常伴', cur: (s) => s.signInDays || 0, label: (n) => '累计签到 ' + fmtAchvNum(n) + ' 天',
      tiers: [7, 30, 100, 365, 1000, 2000, 3650], base: 1e5, ratio: 2.5,
      names: ['七日之约', '月月相伴', '风雨无阻', '道心如一'] },
    { id: 'museum', prefix: '陈列', cur: (s) => Object.values(s.museum || {}).filter(Boolean).length, label: (n) => '陈列室封存 ' + n + ' 件绝品',
      tiers: [3, 6], base: 2e5, ratio: 2, names: ['初具规模', '满堂生辉'] },
    { id: 'merit', prefix: '战功', cur: (s) => s.warMerits || 0, label: (n) => '战功累计 ' + fmtAchvNum(n) + ' 点',
      tiers: [1e3, 1e4, 1e5, 1e6], base: 3e5, ratio: 3, names: ['战功赫赫', '功勋盖世'] },
    { id: 'mark', prefix: '塔痕', cur: (s) => s.towerMarks || 0, label: (n) => '塔印累计 ' + fmtAchvNum(n) + ' 枚',
      tiers: [500, 5000, 5e4, 5e5], base: 3e5, ratio: 3, names: ['塔印渐丰', '塔印如林'] },
    { id: 'bone', prefix: '兽骨', cur: (s) => s.beastBones || 0, label: (n) => '兽骨累计 ' + fmtAchvNum(n) + ' 根',
      tiers: [500, 5000, 5e4, 5e5], base: 3e5, ratio: 3, names: ['兽骨成堆', '兽骨成山'] },
    { id: 'gongfa', prefix: '功法', cur: (s) => (s.gongfa ? s.gongfa.atk + s.gongfa.hp + s.gongfa.hui : 0), label: (n) => '功法总层数达到 ' + n + ' 层',
      tiers: [10, 15], base: 3e5, ratio: 2, names: ['三诀同修', '功法圆满'] },
    { id: 'hunt', prefix: '巡猎', cur: (s) => Object.values(s.wildKills || {}).reduce((a, b) => a + b, 0), label: (n) => '野外累计斩杀 ' + fmtAchvNum(n) + ' 只妖兽',
      tiers: [1e3, 1e4, 1e5, 1e6], base: 2e5, ratio: 2.8, names: ['猎妖新手', '猎妖老手', '妖兽克星'] },
    { id: 'elixir', prefix: '丹心', cur: (s) => Object.values((s.elixir && s.elixir.owned) || {}).reduce((a, b) => a + b, 0), label: (n) => '囤丹 ' + n + ' 枚',
      tiers: [10, 50, 200], base: 1e5, ratio: 2.5, names: ['小药匣', '大药炉', '丹仓满库'] },
    { id: 'chapter', prefix: '天道', cur: (s) => (s.chapters || []).length, label: (n) => '天道录已读 ' + n + ' 卷',
      tiers: [3, 6, 10], base: 2e5, ratio: 2.5, names: ['初窥天道', '天道半卷', '天道全览'] },
    { id: 'ordeal', prefix: '苦修', cur: (s) => (s.ordealDone || []).length, label: (n) => '挑战修行功成 ' + n + ' 种',
      tiers: [1, 2, 3], base: 5e5, ratio: 2.5, names: ['一戒守心', '双戒护道', '三戒功圆'] },
    { id: 'cave', prefix: '洞府', cur: (s) => (s.cave ? s.cave.array + s.cave.garden + s.cave.library : 0), label: (n) => '洞府建筑总级数达到 ' + n + ' 级',
      tiers: [3, 6, 9, 12], base: 2e5, ratio: 2.5, names: ['初辟洞府', '洞天福地', '府邸生辉', '仙家气派'] },
    { id: 'forge', prefix: '神匠', cur: (s) => SLOTS.filter((sl) => (s.enh && s.enh[sl.key] || 0) >= MAX_ENHANCE).length, label: (n) => n + ' 个部位强化至 +' + MAX_ENHANCE,
      tiers: [3, 6], base: 5e5, ratio: 2, names: ['渐入化境', '登峰造极'] },
    { id: 'map', prefix: '探图', cur: (s) => (s.map && s.map.rev ? s.map.rev.length : 0), label: (n) => '秘境图已探明 ' + n + ' 格',
      tiers: [10, 30, 64, 96], base: 1.5e5, ratio: 2.5, names: ['迷雾初开', '图穷匕见', '全图皆知', '足迹满图'] },
  ];
  // 展开梯子（REALMS 已在上方声明，境界 label 可安全求值）：30 手写 + 170 生成 = 200
  for (const lad of ACHV_LADDERS) {
    lad.tiers.forEach((t, i) => {
      const stones = Math.round(lad.base * Math.pow(lad.ratio, i));
      ACHIEVEMENTS.push({
        id: lad.id + '_' + t,
        name: (lad.names && lad.names[i]) || lad.prefix + ' · ' + (ACHV_ZH[i] || (i + 1)),
        desc: lad.label(t),
        cur: lad.cur,
        target: t,
        stones,
        ...(i % 3 === 2 ? { dust: Math.min(2000, Math.max(20, Math.round(stones / 1000))) } : {}),
        ...(lad.title && lad.title[i] ? { title: lad.title[i] } : {}),
      });
    });
  }

  /* ---------------- 周常 / 签到里程碑 ---------------- */

  const WEEKLY_TASKS = [
    { id: 'opens', name: '开箱 15 万次', target: 150000, reward: { stones: 3000000, dust: 15000 } },
    { id: 'wins', name: '秘境获胜 80 场', target: 80, reward: { stones: 3000000, dust: 20000 } },
    { id: 'rogue', name: '探幽累计通过 12 层', target: 12, reward: { stones: 5000000, dust: 30000 } },
  ];
  const WEEKLY_ALL_BONUS = { stones: 2000000, dust: 10000 };

  const SIGN_MILESTONES = {
    30: { stones: 2e7, dust: 100, text: '2000 万灵石 + 100 碎屑' },
    100: { stones: 1e8, dust: 500, tickets: 2, text: '1 亿灵石 + 500 碎屑 + 2 招募券' },
    365: { stones: 1e9, dust: 2000, tickets: 7, text: '10 亿灵石 + 2000 碎屑 + 7 招募券' },
    1000: { stones: 1e10, dust: 10000, tickets: 30, text: '100 亿灵石 + 10000 碎屑 + 30 招募券' },
  };

  /* ---------------- 第九批：灵潮 / 朝贺 / 悬赏改档 / 问答 / 异象 / 灵气 / 占卜 / 同门互助 ---------------- */

  // 灵潮：每日两窗（12–14 / 20–22），窗口内开箱与秘境产出 ×2，各可领一枚灵潮符
  const TIDE_WINDOWS = [{ s: 12, e: 14 }, { s: 20, e: 22 }];
  const TIDE_MULT = 2;
  const TIDE_CLAIM = 4e6;             // 400 万灵石/符

  // 月度朝贺：与签到联动记本月到勤日，里程碑 10/20/26 天；缺勤次日可花灵石补签（每月 3 次）
  const MONTH_MILESTONES = [
    { n: 10, reward: { dust: 300 }, text: '碎屑 ×300（可合成中品宝石）' },
    { n: 20, reward: { boxTian: 1 }, text: '天品装备箱 ×1' },
    { n: 26, reward: { boxXian: 1 }, text: '仙品装备箱 ×1' },
  ];
  const MONTH_MAKEUP_COST = 5e5;      // 补签单价（灵石）
  const MONTH_MAKEUP_MAX = 3;

  // 悬赏令改档：每日 4 单（白/绿/蓝/紫 各一），可刷新 2 次；紫悬赏 5% 掉天品装备
  const BOUNTY_TIERS = [
    { key: 'bai', name: '白', color: '#9aa4b2', stones: 1.5e6, dust: 20 },
    { key: 'lv',  name: '绿', color: '#4ade80', stones: 3e6,  dust: 35 },
    { key: 'lan', name: '蓝', color: '#60a5fa', stones: 6e6,  dust: 50 },
    { key: 'zi',  name: '紫', color: '#c084fc', stones: 1.2e7, dust: 80, drop: 0.05 },
  ];
  const BOUNTY_SLOT_N = 4;
  const BOUNTY_REROLL_N = 2;
  const BOUNTY_REROLL_COST = 5e5;     // 50 万/次
  const BOUNTY_ALL_CLEAR = { stones: 5e6 };  // 四单全清额外奖励

  // 仙道问答：每日 10 题（按日期定题序），答对 60 万灵石 + 境界缩放修为；
  // 全对加奖 150 万 + 30 碎屑；连续 7 天全对得天品自选箱
  const QUIZ_N = 10;
  const QUIZ_PER_STONES = 6e5;
  const QUIZ_PER_EXP_K = 150;
  const QUIZ_ALL_BONUS = { stones: 1.5e6, dust: 30 };
  const QUIZ_STREAK_N = 7;

  // 异象秘境：每日按日期种子取 2 条词缀合成挑战 boss，每日一次；
  // 首通 1500 万灵石 + 100 碎屑 + 修为；按余血评级 S/A/B，S 级 5% 掉仙品；
  // 当月每日皆 S → 月末保底仙品一件
  const ANOMALY_FIRST = { stones: 1.5e7, dust: 100, expK: 600 };
  const ANOMALY_S_DROP = 0.05;
  const ANOMALY_AFFIXES = [
    { id: 'xueyue', name: '血月', desc: '敌攻 +50% · 灵石 ×1.5', atk: 1.5, stone: 1.5 },
    { id: 'tiemu',  name: '铁幕', desc: '敌防 +100%', def: 2 },
    { id: 'juling', name: '巨灵', desc: '敌血 +80%', hp: 1.8 },
    { id: 'xunying', name: '迅影', desc: '敌攻 +30% · 敌防 +30%', atk: 1.3, def: 1.3 },
    { id: 'kuling', name: '枯灵', desc: '敌血 +40% · 敌攻 +20%', hp: 1.4, atk: 1.2 },
    { id: 'tanlang', name: '贪狼', desc: '灵石 ×2 · 敌攻 +70%', atk: 1.7, stone: 2 },
    { id: 'cangfeng', name: '藏锋', desc: '敌防 +60% · 碎屑 ×2', def: 1.6, dust: 2 },
    { id: 'tianfa', name: '天罚', desc: '敌全属性 +40% · 修为 ×1.5', hp: 1.4, atk: 1.4, def: 1.4, exp: 1.5 },
  ];

  // 灵气盈满：页面在线每满 60 分钟聚 1 格灵气，至多 3 格，逐格领取
  const VIGOR_CELL_MIN = 60;
  const VIGOR_CELL_N = 3;
  const VIGOR_REWARD = { stones: 2e6, dust: 15 };

  // 每日占卜：免费一签定当日运势（日期种子，不可重摇）；上上签附当日产出 +5%
  const FORTUNE_SIGNS = [
    { name: '上上签', w: 10, stones: 3e6, prod: 0.05, cls: 'g-item',
      text: '紫气东来，今日百事皆宜，灵机充盈（产出 +5%）。' },
    { name: '上吉签', w: 20, stones: 1.5e6, cls: 'g-stone',
      text: '吉人天相，财帛顺遂，宜开箱历练。' },
    { name: '中平签', w: 40, stones: 1e6, cls: 'g-stone',
      text: '平顺一日，不进不退，稳字当头。' },
    { name: '小凶签', w: 30, dust: 20, cls: 'g-dust',
      text: '诸事不宜，闭关养性——道友赠碎屑以慰惊惶。' },
  ];

  // 同门互助：每日可向 1 位盟友传功、赠礼各一次，双方受益（服务端记账，奖励客户端发）
  const AID_SKILL = { stones: 3e6, expK: 300 };  // 传功双方各得
  const AID_GIFT = { dust: 20 };                 // 赠礼双方各得

  // 仙道问答题库：四选一，idx 为正确项下标（内容取自本作境界 / 品质 / 玩法 / 剧情）
  const QUIZ_BANK = [
    { q: '修行十境中，仅次于「仙人」的境界是？', a: ['大乘', '渡劫', '合体', '炼虚'], idx: 1 },
    { q: '装备品质从低到高，第三档是？', a: ['玄品', '地品', '天品', '灵品'], idx: 0 },
    { q: '仙品装备最多可有多少条词条？', a: ['1 条', '2 条', '3 条', '5 条'], idx: 2 },
    { q: '洗练最多可以锁定几条词条？', a: ['1 条', '2 条', '3 条', '不限（费用逐条翻倍）'], idx: 3 },
    { q: '秘境探幽一共有多少层？', a: ['100 层', '150 层', '200 层', '365 层'], idx: 2 },
    { q: '探幽神物「不灭」的效果是？', a: ['攻击翻倍', '战败复活再战一次', '吸血 +50%', '跳过一层'], idx: 1 },
    { q: '藏宝图需要几片残片合成？', a: ['3 片', '5 片', '8 片', '10 片'], idx: 1 },
    { q: '钓鱼每日默认可领多少枚鱼饵？', a: ['3 枚', '5 枚', '8 枚', '10 枚'], idx: 1 },
    { q: '洞府「藏经阁」升级带来的加成是？', a: ['灵石收益', '开箱暴击率', '修为收益', '防御'], idx: 2 },
    { q: '灵宠「招财貔貅」强化的属性是？', a: ['攻击', '生命', '暴击', '灵石收益'], idx: 3 },
    { q: '五行的相克关系中，火克？', a: ['金', '木', '土', '水'], idx: 0 },
    { q: '丹药「聚财丹」的效果是？', a: ['攻击 +15%', '防御 +20%', '灵石收益 +30%', '修为 +30%'], idx: 2 },
    { q: '本作主角随身的神秘宝匣名为？', a: ['灵匣', '天匣', '仙匣', '玄匣'], idx: 0 },
    { q: '故事中为「我」留下登阶名额的道侣是？', a: ['苏挽月', '林青璃', '云清瑶', '白芷若'], idx: 0 },
    { q: '九霄阶的尽头镇守着哪位大能留下的试炼？', a: ['九霄雷帝', '玄天老祖', '幽冥教主', '太虚剑君'], idx: 0 },
    { q: '苏挽月是在何处被幽冥教伏杀掳走的？', a: ['雷池祭礼', '宗门大比', '秘境深处', '仙盟大典'], idx: 0 },
    { q: '登顶九霄阶后，最后接待「我」的势力是？', a: ['玄天宗', '幽冥教', '天机阁', '万宝楼'], idx: 0 },
    { q: '「入仙界」需要消耗灵石并获得什么？', a: ['仙位', '仙器', '仙丹', '仙缘'], idx: 0 },
    { q: '周常任务「探幽累计通过 12 层」奖励是？', a: ['灵石 + 碎屑', '招募券', '器魂', '洗练券'], idx: 0 },
    { q: '黑市货单每日几点刷新？', a: ['0 点', '6 点', '12 点', '18 点'], idx: 0 },
    { q: '工坊洗练花费的货币是？', a: ['灵石', '碎屑', '器魂', '贡献'], idx: 1 },
    { q: '分解装备主要获得什么？', a: ['灵石', '碎屑', '器魂', '修为'], idx: 1 },
    { q: '器魂「炼器」定向打造哪个品质的装备？', a: ['地品', '天品', '仙品', '玄品'], idx: 1 },
    // 题目对齐实际机制：孔数 = 2 + 仙位（slotSocketCount，封顶 6），与品质/境界/强化/战力均无关
    { q: '宝石镶嵌的部位数量随什么变化？', a: ['装备品质', '仙位（飞升）', '装备强化等级', '战力'], idx: 1 },
    { q: '成就「万匣归一」需要累计开箱多少次？', a: ['1000 次', '5000 次', '10000 次', '20000 次'], idx: 2 },
    { q: '挑战修行「苦行」的禁忌是？', a: ['服用丹药', '开箱', '战斗', '购物'], idx: 0 },
    { q: '试炼「无息试炼」的通关条件是？', a: ['不靠吸血击败塔层守卫', '5 回合取胜', '承伤不超 30%', '无损取胜'], idx: 0 },
    { q: '首领连战（BossRush）每日可挑战几次？', a: ['1 次', '3 次', '5 次', '不限'], idx: 0 },
    { q: '离线挂机收益最多结算几个小时？', a: ['2 小时', '4 小时', '8 小时', '12 小时'], idx: 1 },
    { q: '天梯（仙盟之外的论剑）按什么匹配对手？', a: ['评分就近', '战力随机', '境界相同', '等级就近'], idx: 0 },
    { q: '盟主妖王每人每日可出手几场？', a: ['3 场', '5 场', '8 场', '10 场'], idx: 1 },
    { q: '世界妖王「噬山」等名字属于哪类玩法？', a: ['全服共讨的世界 BOSS', '探幽守将', '试炼守卫', '心魔幻象'], idx: 0 },
    { q: '心魔劫的触发与什么直接相关？', a: ['修为暴涨', '战力虚高', '灵石负债', '久不签到'], idx: 0 },
    { q: '「陈列室」陈列的是什么？', a: ['套装装备', '灵宠', '丹药', '功法'], idx: 0 },
    { q: '秘境图每次进入消耗什么？', a: ['行动力', '灵石', '碎屑', '体力'], idx: 0 },
    { q: '灵田（灵圃）收获的两种资材是？', a: ['矿石与灵药', '灵石与碎屑', '灵石与修为', '碎屑与器魂'], idx: 0 },
    { q: '道侣好感度提升的途径不包括？', a: ['赠礼', '同行历练', '闲聊', '切磋击败'], idx: 3 },
    { q: '兑换码在何处输入？', a: ['天下 · 兑换', '日常 · 签到', '工坊', '洞府'], idx: 0 },
    { q: '「赌狗签到」最低可能的结果是？', a: ['空手', '倒扣 1~3 倍', '正常奖励', '双倍奖励'], idx: 1 },
    { q: '本作英文名是？', a: ['Spirit Box Odyssey', 'Xiuxian Legend', 'Ling Box Story', 'Cultivator Tale'], idx: 0 },
  ];

  /* ---------------- 试炼 / 五行 / 丹药 / 功法 / 黑市 / 奇遇 ---------------- */


  // 五行相克：金克木、木克土、土克水、水克火、火克金
  const ELEMENTS = [
    { key: 'jin', name: '金', color: '#fbbf24' },
    { key: 'mu', name: '木', color: '#4ade80' },
    { key: 'shui', name: '水', color: '#60a5fa' },
    { key: 'huo', name: '火', color: '#f87171' },
    { key: 'tu', name: '土', color: '#c084fc' },
  ];
  const ELEMENT_BEATS = { jin: 'mu', mu: 'tu', tu: 'shui', shui: 'huo', huo: 'jin' };
  const randEl = () => ELEMENTS[Math.floor(Math.random() * ELEMENTS.length)].key;

  const ROGUE_FLOORS = 200;
  const ROGUE_BUFFS = [
    { id: 'atk15', name: '狂攻', desc: '攻击 +15%', apply: (b) => { b.atk *= 1.15; } },
    { id: 'hp20', name: '铁体', desc: '生命 +20%', apply: (b) => { b.hp *= 1.2; } },
    { id: 'def20', name: '磐石', desc: '防御 +20%', apply: (b) => { b.def *= 1.2; } },
    { id: 'ls8', name: '汲取', desc: '吸血 +8%', apply: (b) => { b.lifesteal += 0.08; } },
    { id: 'crit8', name: '锐目', desc: '暴击 +8%', apply: (b) => { b.crit += 0.08; } },
    { id: 'pierce10', name: '破军', desc: '破甲 +10%', apply: (b) => { b.pierce += 0.10; } },
    { id: 'dr10', name: '金身', desc: '受伤 -10%', apply: (b) => { b.dr += 0.10; } },
    { id: 'revive', name: '不灭', desc: '战败后复活再战一次', special: 'revive' },
  ];

  const TRIALS = [
    { id: 'swift', name: '迅捷试炼', desc: '5 回合内击败野外守护兽', enemy: 'wild' },
    { id: 'nols', name: '无息试炼', desc: '不靠吸血击败塔层守卫', enemy: 'tower', noLs: true },
    { id: 'wall', name: '铁壁试炼', desc: '承受不超最大生命 30% 取胜', enemy: 'stage' },
  ];
  const TRIAL_REWARD = { stones: 8e6, dust: 40 };

  const BOSS_RUSH_LEVELS = [];
  for (let lv = 5; lv <= STAGE_MAX; lv += 5) BOSS_RUSH_LEVELS.push(lv);
  const BOSS_RUSH_GRADES = [
    { max: 4, name: 'S', stones: 2e7, dust: 100 },
    { max: 7, name: 'A', stones: 1.2e7, dust: 60 },
    { max: 12, name: 'B', stones: 6e6, dust: 40 },
    { max: Infinity, name: 'C', stones: 3e6, dust: 20 },
  ];

  const ELIXIRS = [
    { id: 'atk', name: '狂战丹', icon: '攻', desc: '攻击 +15% · 5 分钟', cost: 3000, ms: 5 * 60000 },
    { id: 'def', name: '金刚丹', icon: '御', desc: '防御 +20% · 5 分钟', cost: 3000, ms: 5 * 60000 },
    { id: 'gain', name: '聚财丹', icon: '财', desc: '灵石收益 +30% · 5 分钟', cost: 6000, ms: 5 * 60000 },
  ];
  const PET_SLOT_COST = 5;      // 解锁第二出战位的券
  const TOKEN_COST = (lv) => 30 * (lv + 1);
  const TOKEN_MAX = 200;

  const GONGFA = {
    // 攻/生命消费端过 GROWTH_SCALE（×0.25），修为诀不折算——文案按实际值标（2026-11-01）
    atk: { name: '锋锐诀', desc: '攻击 +0.5% / 级', max: 200 },
    hp: { name: '玄功诀', desc: '生命 +0.5% / 级', max: 200 },
    hui: { name: '慧心诀', desc: '修为收益 +5% / 级', max: 200 },
  };
  // 功法成本几何化（2026-10-30）：原 (lv+1)×3000 线性太廉价，改每层 ×1.05 复利——
  // 修为（战斗产出=游戏时间）成为功法战力的节流阀，满层累计 ~2000 亿修为
  // （2026-10-31 用户指定：整体 ×5，满层累计 ~1 万亿修为）
  const gongfaCost = (lv) => (lv + 1) * 3000 * Math.pow(1.05, lv) * 5;

  const MARKET_POOL = [
    { id: 'dust', name: '碎屑包', desc: '碎屑 ×100', cost: 2500 },
    { id: 'dustBig', name: '碎屑大包', desc: '碎屑 ×300', cost: 7000 },
    { id: 'ticket', name: '灵宠招募券', desc: '招募券 ×1', cost: 6000 },
    { id: 'coupon', name: '洗练半价券', desc: '下次洗练半价（自动生效）', cost: 1500 },
  ];

  const ADVENTURE_CHANCE = 0.02;   // 手动单开触发概率
  const ADVENTURE_COOLDOWN = 5 * 60000;

  const WEEK_BUFFS = [
    { id: 'dust', name: '碎屑周', desc: '本周碎屑获取 +50%' },
    { id: 'stone', name: '灵石周', desc: '本周灵石获取 +20%' },
    { id: 'pet', name: '灵宠周', desc: '本周招募券掉率 ×2' },
    { id: 'forge', name: '工坊周', desc: '本周洗练费用 -30%' },
  ];

  function weekBuff() {
    const d = new Date();
    const w = Math.floor((d - new Date(d.getFullYear(), 0, 1)) / (7 * 86400000));
    return WEEK_BUFFS[w % WEEK_BUFFS.length];
  }
  const weekIs = (id) => weekBuff().id === id;
  const isWeekend = () => [0, 6].includes(new Date().getDay());

  /* ---------------- 共鸣 / 道童 / 升星 / 炼器 / 赌石 / 镜像 / 秘境图 / 挑战修行 / 陈列室 / 灵田 / 天道录 ---------------- */

  // 词条共鸣：已穿戴装备同词条凑 3/5 条；攻血防吃百分比，暴吸破吃直加
  const RESONANCE = [
    { need: 3, pct: 0.05, flat: 0.02 },
    { need: 5, pct: 0.12, flat: 0.05 },
  ];

  const SOULS_PER_SPECIAL = 3;                 // 分解专属件得器魂
  const SOULS_ROGUE_CLEAR = 5;                 // 探幽通关器魂
  const CRAFT_COST = { souls: 30, stones: 50000 };

  // 璞玉（2026-10-31 调价）：单次 20 万灵石，收益同步 ×100；单日至多开 500 次
  const GAMBLE_COST = 200000;
  const GAMBLE_DAILY_MAX = 500;
  const GAMBLE_TABLE = [
    { p: 62, type: 'none', text: '璞玉无瑕，只余石屑' },
    { p: 18, type: 'dust', min: 2000, max: 6000, text: '碎石流光' },
    { p: 10, type: 'stones', min: 300000, max: 600000, text: '玉髓天成' },
    { p: 9, type: 'dust', min: 15000, max: 26000, text: '琼英满膛' },
    { p: 1, type: 'item', text: '璞中藏珍！' },
  ];

  /* ---------------- 第七批：云游奇遇 / 藏宝图 / 钓鱼 / 内丹 / 采集 / 天象 ---------------- */

  // 善恶果报：云游奇遇的抉择改变果报（-10..+10），果报微调赌石与洗练运气
  const karma = () => Math.max(-10, Math.min(10, (state.wander && state.wander.karma) | 0));
  const karmaMult = (per) => Math.max(0.5, 1 + karma() * per);

  const WANDER_COOLDOWN = 25 * 60000;   // 两次奇遇的间隔（在线游玩计时）
  // fx：stones/dust/exp 为数组 [min,max] 或定值；ticket 招募券 / coupon 洗练券 /
  // item 天品装备 / elixir 限时丹药；cost 为选择的前置花费（灵石）
  const WANDER_EVENTS = [
    { id: 'bag', title: '山道遗囊', text: '山道上捡到一只鼓鼓的储物袋，物主早已走远。',
      choices: [
        { t: '开袋取物', k: 0, fx: { dust: [60, 120] }, msg: '袋中多是碎屑杂物，聊胜于无。' },
        { t: '归还门派', k: 2, fx: { stones: [2500, 4000] }, msg: '门派执事赠你谢银。' },
        { t: '视而不见', k: -1, fx: {}, msg: '你绕道而行，心里却有点不是滋味。' },
      ] },
    { id: 'elder', title: '溪畔老叟', text: '溪畔老叟迷了路，向你打听下山的道。',
      choices: [
        { t: '热心指路', k: 1, fx: { stones: [1500, 3000] }, msg: '老叟笑着塞给你几块灵石。' },
        { t: '索要谢礼', k: -2, fx: { dust: 80 }, msg: '老叟冷笑着丢下一把碎屑。' },
        { t: '匆匆赶路', k: 0, fx: {}, msg: '你低头赶路，身后叹息声渐渐远去。' },
      ] },
    { id: 'scholar', title: '断桥书生', text: '断桥边一位书生盘缠用尽，进京赶考的路走不成了。',
      choices: [
        { t: '赠银相助（1000 灵石）', k: 2, cost: 1000, fx: { exp: [800, 1600] }, msg: '书生长揖到地，你只觉心境通明。' },
        { t: '嘲其落魄', k: -2, fx: {}, msg: '书生涨红了脸，你扬长而去。' },
        { t: '默默绕行', k: 0, fx: {}, msg: '世道艰难，各人有各人的缘法。' },
      ] },
    { id: 'temple', title: '雨夜破庙', text: '雨夜借宿破庙，山门被风吹得吱呀作响。',
      choices: [
        { t: '修补庙门', k: 1, fx: { elixir: 'atk' }, msg: '夜里睡得极沉，晨起气血充盈。' },
        { t: '借宿一宵', k: 0, fx: { exp: [600, 1200] }, msg: '一夜无事，修为略有精进。' },
        { t: '拆梁烤火', k: -2, fx: { dust: [60, 120] }, msg: '火堆噼啪作响，梁上灰尘簌簌落下。' },
      ] },
    { id: 'cub', title: '妖兽幼崽', text: '林间一只妖兽幼崽落入猎户陷阱，嗷嗷待哺。',
      choices: [
        { t: '送归巢穴', k: 2, fx: { ticket: 1 }, msg: '母妖远远望着你，放下了一枚灵券。' },
        { t: '捕卖给贩子', k: -3, fx: { stones: [6000, 9000] }, msg: '贩子付钱爽快，你却半晌没说话。' },
        { t: '远远绕开', k: 0, fx: {}, msg: '山林自有山林的规矩。' },
      ] },
    { id: 'well', title: '古井封印', text: '荒村古井封着褪色的符纸，井口隐有寒气。',
      choices: [
        { t: '投石问路', k: -1, fx: { dust: [120, 200] }, msg: '石落深井，回上来的还有一层碎屑。' },
        { t: '添香祭拜', k: 1, fx: { exp: [1200, 2400] }, msg: '香烟袅袅，你只觉神识清朗。' },
        { t: '打捞残卷', k: 0, fx: { coupon: 1 }, msg: '井底捞出一卷湿透的功法残页。' },
      ] },
    { id: 'caravan', title: '商队遇劫', text: '山道转角商队正遭劫掠，护镖人节节败退。',
      choices: [
        { t: '仗义出手', k: 2, fx: { stones: [4000, 8000] }, msg: '劫匪溃逃，商队奉上酬金。' },
        { t: '趁乱捡货', k: -3, fx: { dust: [150, 260] }, msg: '你捡了几袋货，趁乱溜走。' },
        { t: '报信官府', k: 1, fx: { stones: [2000, 3500] }, msg: '巡检查明缘由，发了赏钱。' },
      ] },
    { id: 'herbalist', title: '药农求诊', text: '药农之子高热不退，他抱着孩子跪求路过的你。',
      choices: [
        { t: '分药施诊（2000 灵石）', k: 2, cost: 2000, fx: { exp: [1000, 2000] }, msg: '孩子退了热，药农千恩万谢。' },
        { t: '讨要诊金', k: -1, fx: { dust: [60, 110] }, msg: '药农变卖了药筐，凑齐诊金。' },
        { t: '直言不懂', k: 0, fx: {}, msg: '术业有专攻，你转身离去。' },
      ] },
    { id: 'vine', title: '断崖仙藤', text: '断崖边一株仙藤结着三枚灵果，藤身已有百年纹路。',
      choices: [
        { t: '攀摘灵果', k: 0, fx: { coupon: 1 }, msg: '灵果入腹微甜，藤叶簌簌作响。' },
        { t: '守护藤苗', k: 2, fx: { exp: [1500, 3000] }, msg: '你筑起石栏，隐隐感到藤木谢你。' },
        { t: '斧劈藤干', k: -3, fx: { dust: [200, 320] }, msg: '藤心流出金色汁液，凝成碎屑。' },
      ] },
    { id: 'famine', title: '雪夜山村', text: '雪夜借宿山村，村正说粮仓见底，恳求富人相助。',
      choices: [
        { t: '捐粮赈济（3000 灵石）', k: 2, cost: 3000, fx: { exp: [1200, 2400] }, msg: '全村在祠堂为你点了长明灯。' },
        { t: '高价售粮', k: -2, fx: { stones: [7000, 11000] }, msg: '粮食换成了满满一袋灵石。' },
        { t: '婉拒离去', k: 0, fx: {}, msg: '雪太大，你连夜下了山。' },
      ] },
  ];

  // 藏宝图：秘境征战胜利掉残片，5 片合成一张；合成后秘境图出现金光挖宝点
  const TREASURE_FRAG_COST = 5;
  const TREASURE_DROP = 0.05;          // 每场秘境征战胜利的残片掉率
  const TREASURE_TABLE = [
    { p: 34, type: 'stones', min: 4000, max: 12000, text: '官窑遗瓷' },
    { p: 30, type: 'dust', min: 60, max: 160, text: '前朝金屑' },
    { p: 20, type: 'stones', min: 20000, max: 60000, text: '窖藏灵石' },
    { p: 12, type: 'dust', min: 300, max: 600, text: '宝匣遗尘' },
    { p: 4, type: 'item', text: '镇图之宝！' },
  ];

  // 钓鱼：每日 5 枚鱼饵，抛竿后时机条左右游走，停得越正鱼获越好
  const FISH_BAIT_DAILY = 5;
  const FISH_BAIT_COST = 5000;
  const FISH_ROD_MS = 12000;           // 抛竿后 12 秒不收竿跑鱼
  const FISH_TABLE = [
    { p: 30, name: '小白鱼', stones: 800, text: '小家伙，放生都嫌小。' },
    { p: 28, name: '灵鳞鱼', dust: 12, text: '鳞片泛着微光。' },
    { p: 20, name: '霜华鳕', stones: 5000, text: '市集抢着要的肥美大鱼。' },
    { p: 14, name: '金锦鲤', dust: 90, text: '金鳞耀目，是吉祥的兆头。' },
    { p: 8, name: '灵龙鱼', big: true, text: '传说灵龙鱼通灵化形！' },
  ];

  // 灵宠内丹：兽骨喂养，3/6/10 级解锁特性（仅出战灵宠生效）
  const CORE_MAX = 10;
  const coreCost = (lv) => 20 * (lv + 1);
  const CORE_TRAITS = {
    fox: [
      { lv: 3, stat: 'atk', v: 0.03, name: '雷牙' },
      { lv: 6, stat: 'crit', v: 0.01, name: '雷瞳' },
      { lv: 10, stat: 'atk', v: 0.05, name: '雷魂' },
    ],
    turtle: [
      { lv: 3, stat: 'hp', v: 0.04, name: '厚甲' },
      { lv: 6, stat: 'dr', v: 0.01, name: '龟息' },
      { lv: 10, stat: 'hp', v: 0.06, name: '玄武' },
    ],
    rat: [
      { lv: 3, stat: 'crit', v: 0.01, name: '灵目' },
      { lv: 6, stat: 'pierce', v: 0.02, name: '穿髓' },
      { lv: 10, stat: 'crit', v: 0.02, name: '天机' },
    ],
    pixiu: [
      { lv: 3, stat: 'stone', v: 0.04, name: '纳财' },
      { lv: 6, stat: 'dust', v: 0.04, name: '聚宝' },
      { lv: 10, stat: 'stone', v: 0.06, name: '吞金' },
    ],
  };
  // 出战灵宠内丹特性对某属性的合计加成
  const coreBonus = (stat) => (state.activePets || []).reduce((sum, id) =>
    sum + (CORE_TRAITS[id] || [])
      .filter((t) => (state.petCores[id] | 0) >= t.lv && t.stat === stat)
      .reduce((a, t) => a + t.v, 0), 0);

  // 灵圃采集：矿脉产矿石、药圃产灵药，灵药可折半价炼丹，矿石可锻器魂
  const GATHER_MAX_LV = 60;
  const gatherCost = (lv) => Math.floor(4000 * Math.pow(1.5, lv));
  const GATHER_NODES = {
    ore: { name: '灵矿脉', icon: '矿', ms: 30 * 60000, base: 6 },
    herb: { name: '灵药圃', icon: '药', ms: 45 * 60000, base: 4 },
  };
  // 采集节点图标（SVG，currentColor 随 .cave-icon 金色；缺省回退 def.icon 文字）
  const GATHER_ICONS = {
    ore: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M6.5 3h11L22 9.2 12 21.5 2 9.2 6.5 3zm.9 2L5 9h5.4L12 4.3 7.4 5zM7.1 11l4.9 7.6L16.9 11H7.1z"/></svg>',
    herb: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M13 21v-5.2c4.4-.4 7-3.4 7-8.3V4h-3c-4.3 0-7.2 2.6-7.9 6.4C8.2 8.9 6.6 8 4.5 8H3v1c0 3.9 2.9 7 7 7.2V21h3z"/></svg>',
  };
  const gatherYield = (key) =>
    Math.round(GATHER_NODES[key].base * (1 + 0.1 * state.gather.nodes[key].lv));
  const HERB_ELIXIR_NEED = 10;   // 灵药合丹消耗
  const ORE_SOUL_NEED = 20;      // 矿石锻魂消耗
  const MELT_NEED = 5;           // 装备熔铸材料件数（2026-10-31 起仅天→仙、仙→仙升星两档）
  // 熔铸成功率：每次在 5%~15% 均匀浮动（目标 10% 上下 5%，2026-10-31 用户指定）；失败材料与手续费不退
  const MELT_RATE_MIN = 0.05;
  const MELT_RATE_SPAN = 0.10;
  const meltRate = () => MELT_RATE_MIN + Math.random() * MELT_RATE_SPAN;

  // 天象：每日一换，与时辰同框架的全局微 buff
  const SKIES = [
    { name: '晴空万里', desc: '宜修行' },
    { name: '雷雨交加', atk: 1.08, desc: '攻击 +8%' },
    { name: '皓月当空', dust: 1.2, desc: '碎屑 +20%' },
    { name: '紫气东来', gain: 0.10, desc: '收益 +10%' },
    { name: '天高云淡', stone: 1.10, desc: '灵石 +10%' },
    { name: '繁星满天', crit: 0.02, desc: '开箱暴击 +2%' },
    { name: '妖云压城', pierce: 0.03, pet: 2, desc: '破甲 +3% · 招募券 ×2' },
  ];
  const skyNow = () => {
    const s = todayStr();
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return SKIES[h % SKIES.length];
  };
  const skyVal = (k) => skyNow()[k] || 0;

  const MAP_W = 12;
  const MAP_H = 8;
  const MAP_AP_DAY = 6;
  const MAP_AP_MAX = 12;
  const MAP_BUY_MAX = 50;        // 每日加购次数上限
  const MAP_BUY_COST = 10000;    // 加购单价（灵石）

  const ORDEALS = [
    { id: 'fanYi', name: '凡衣修行', desc: '不穿戴专属套装装备完成一次飞升', reward: '灵石收益永久 +10%', gain: 0.10 },
    { id: 'wuJiang', name: '无匠修行', desc: '不洗练、不继承词条完成一次飞升', reward: '攻击与生命永久 +6%', combat: 0.06 },
    { id: 'kuXing', name: '苦行修行', desc: '不服用任何丹药完成一次飞升', reward: '攻击永久 +6%', atk: 0.06 },
  ];

  const FARM_SEEDS = [
    { id: 'cao', name: '灵草籽', cost: 800, ms: 30 * 60000, dust: 20, text: '30 分钟' },
    { id: 'hua', name: '灵花籽', cost: 2000, ms: 2 * 3600000, dust: 60, text: '2 小时' },
    { id: 'guo', name: '灵果籽', cost: 6000, ms: 8 * 3600000, dust: 200, text: '8 小时' },
  ];
  const FARM_PLOTS = 3;

  /* ---------------- 第四批：融合 / 符文 / 心魔 / 悬赏 / 时辰 / 天劫 / 道侣 / 战功碑 ---------------- */

  // 符文组词：单件装备宝石按顺序排列触发（攻血防走百分比，暴吸破减伤直加）
  const RUNEWORDS = [
    { seq: ['atk', 'hp'], name: '生生诀', desc: '攻击与生命 +3%', apply: { atk: 0.03, hp: 0.03 } },
    { seq: ['crit', 'pierce'], name: '锋破诀', desc: '破甲 +4%', apply: { pierce: 0.04 } },
    { seq: ['ls', 'def'], name: '金钟罩', desc: '减伤 +3%', apply: { dr: 0.03 } },
    { seq: ['atk', 'atk', 'atk'], name: '三清阵', desc: '攻击 +8%', apply: { atk: 0.08 } },
    { seq: ['hp', 'hp', 'hp'], name: '厚土阵', desc: '生命 +8%', apply: { hp: 0.08 } },
    { seq: ['crit', 'ls', 'pierce'], name: '杀伐阵', desc: '攻击与生命 +5%', apply: { atk: 0.05, hp: 0.05 } },
  ];

  // 十二时辰：现实 2 小时一个时辰，各带全局微 buff（无字段为无加成）
  const SHICHEN = [
    { name: '子时', desc: '碎屑 +30%', dust: 1.3 },
    { name: '丑时', desc: '万物归寂' },
    { name: '寅时', desc: '攻击 +5%', atk: 0.05 },
    { name: '卯时', desc: '收益 +10%', gain: 0.10 },
    { name: '辰时', desc: '开箱暴击 +2%', crit: 0.02 },
    { name: '巳时', desc: '收益 +10%', gain: 0.10 },
    { name: '午时', desc: '灵石 +10%', stone: 1.10 },
    { name: '未时', desc: '午后小憩' },
    { name: '申时', desc: '破甲 +3%', pierce: 0.03 },
    { name: '酉时', desc: '招募券掉率 ×2', pet: 2 },
    { name: '戌时', desc: '防御 +5%', def: 0.05 },
    { name: '亥时', desc: '万物归寂' },
  ];
  const shichenNow = () => SHICHEN[Math.floor(((new Date().getHours() + 1) % 24) / 2)];
  const shichenIs = (key) => !!shichenNow()[key];

  // 悬赏任务模板（2026-10-30 换档改造）：从旧 BOUNTY_POOL 迁移为按 metric 的模板池，
  // 每日四单（白/绿/蓝/紫 各一）各抽一条模板，目标数按档位倍率缩放，奖励取档位基准
  const BOUNTY_MISSIONS = [
    { id: 'el_huo', desc: '击败 {t} 只火行怪物', target: 20 },
    { id: 'el_mu', desc: '击败 {t} 只木行怪物', target: 20 },
    { id: 'el_shui', desc: '击败 {t} 只水行怪物', target: 20 },
    { id: 'el_tu', desc: '击败 {t} 只土行怪物', target: 20 },
    { id: 'rogue', desc: '探幽累计通过 {t} 层', target: 5 },
    { id: 'forge', desc: '工坊操作 {t} 次', target: 3 },
    { id: 'salvage', desc: '手动分解 {t} 件装备', target: 15 },
    { id: 'opens', desc: '开箱 {t} 次', target: 300 },
    { id: 'wins', desc: '秘境获胜 {t} 场', target: 30 },
  ];
  // 各档目标倍率：白 1.0 / 绿 1.2 / 蓝 1.5 / 紫 1.8（向上取整）
  const BOUNTY_TIER_SCALE = { bai: 1, lv: 1.2, lan: 1.5, zi: 1.8 };

  const DAO_NPCS = [
    { id: 'qing', name: '青璇', icon: '璇', desc: '结为道侣：灵石收益永久 +8%', lore: '青璇是药园的看守人，指尖总沾着晨露。她说灵石有味道，甜的那一颗要留给你。' },
    { id: 'bai', name: '白芷', icon: '芷', desc: '结为道侣：攻击永久 +5%', lore: '白芷的剑挂在洞府门口，三年来没出过鞘。她说等你打不过的那天，她再出。' },
    { id: 'shi', name: '石坚', icon: '石', desc: '结为道侣：生命永久 +6%', lore: '石坚话少，搬石头的时候更少。他说山是不会说话的道侣，而他愿意做你的。' },
  ];
  // 道侣行头像：复用人物志 AI 立绘（assets/p-<id>.jpg），加载失败回退文字图标
  const DAO_PORTRAIT = {
    qing: 'assets/p-qingxuan.jpg',
    bai: 'assets/p-baizhi.jpg',
    shi: 'assets/p-shijian.jpg',
  };
  const daoAvatar = (id) => {
    const img = DAO_PORTRAIT[id];
    if (!img) return '';
    const fallback = (DAO_NPCS.find((n) => n.id === id) || {}).icon || '';
    // 加载失败回退由 renderDao 统一挂 error 监听（CSP script-src 'self' 禁内联事件）
    return '<img class="dao-face" src="' + img + '" alt="" draggable="false">' +
      '<span class="dao-face-text">' + fallback + '</span>';
  };
  // 结缘难度上调（2026-10-31）：去掉灵宠礼；灵石礼 1000→100 万→5000 万（三次调整）、碎屑礼 50→10 万。
  // 结缘门槛（2026-10-31 二次调整）：单个道侣累计灵石礼满 20 亿或碎屑礼满 500 万可结缘，
  // 结缘进度（百分比，0.01% 粒度显示）由两条累计线中较高者的百分比折算——
  // 不取整：单次灵石礼 +2.5%（5000 万 / 20 亿），取整会让低额送礼的进度显示不精确
  const DAO_GIFTS = [
    { id: 'stones', name: '灵石礼', costLabel: '5000万 灵石', stones: 5e7 },
    { id: 'dust', name: '碎屑礼', costLabel: '10万 碎屑', dust: 100000 },
  ];
  const DAO_MARRY_AT = 100;
  const DAO_MARRY_STONES = 2e9;   // 累计灵石礼门槛：20 亿
  const DAO_MARRY_DUST = 5e6;     // 或累计碎屑礼门槛：500 万
  const daoSpend = (id) => {
    const s = (state.daoLv && state.daoLv.spend && state.daoLv.spend[id]) || {};
    return { stones: s.stones || 0, dust: s.dust || 0 };
  };
  const daoBonded = (id) => {
    const s = daoSpend(id);
    return s.stones >= DAO_MARRY_STONES || s.dust >= DAO_MARRY_DUST;
  };
  const daoAffOf = (id) => {
    const s = daoSpend(id);
    return Math.min(DAO_MARRY_AT,
      Math.max(s.stones / DAO_MARRY_STONES, s.dust / DAO_MARRY_DUST) * DAO_MARRY_AT);
  };
  // 结缘进度显示：按百分比（0.01% 粒度，去尾零）——单次灵石礼 +2.5% 能被精确看见
  const daoAffText = (a) => String(Math.round(a * 100) / 100);
  const DAO_BONUS = { qing: { gain: 0.08 }, bai: { atk: 0.05 }, shi: { hp: 0.06 } };

  const TRIBULATION_DAYS = 3;
  const TALISMAN_COST = 80;         // 炼制护体符碎屑
  const TALISMAN_REDUCE = 0.15;     // 每张减伤

  // 天道录：按境界解锁的十卷短章（原创文案）
  // 天道录参悟奖励基数（2026-10-31 ×500）：100 万 × (卷数 + 1)
  const CHAPTER_GAIN = 2000 * 500;
  const CHAPTERS = [
    { title: '第一卷 · 灵匣初开', text: '山中一匣，无故自鸣。你打开它的那一刻，灵石如尘落袋，修途自此始。老人说：匣中藏的不是物，是机缘。' },
    { title: '第二卷 · 筑基立身', text: '第一道门槛前，无数散修止步。你把开匣得来的每一件旧兵器都摸了一遍，忽然明白：所谓筑基，筑的不是塔，是心。' },
    { title: '第三卷 · 金丹问路', text: '金丹成时，雷云不散。有前辈留书于石壁：「丹是死的，路是活的。」你把这句话揣进了袖子。' },
    { title: '第四卷 · 元婴出窍', text: '元婴睁眼的那一瞬，你看清了自己这些日子攒下的每一件装备、每一只灵宠。原来陪你走夜路的，从来不止一盏灯。' },
    { title: '第五卷 · 化神合道', text: '化神之后，灵匣开始对你低语。它说万物有灵，器有器魂，分魂而葬者，可再铸新生。你学会了「炼器」。' },
    { title: '第六卷 · 炼虚御空', text: '踏出洞府那一刻，脚下已是云海。秘境的迷雾在你眼前铺开一张大图——图上没有路，路是走出来的。' },
    { title: '第七卷 · 合体归一', text: '与灵宠心意相通的刹那，你忽然想起自己也曾是个连铁剑都握不稳的少年。合的是体，也是来路。' },
    { title: '第八卷 · 大乘渡劫', text: '九道天雷依次落下。雷光里你看见了无数个自己：昨日的、上周的、上一世的。他们都在问你——还打得过吗？' },
    { title: '第九卷 · 仙人抚顶', text: '仙人抚你顶，长生授与你。可你握着那只旧灵匣，忽然不想就此停步：仙上是否还有仙？' },
    { title: '第十卷 · 天道无极', text: '你终于把灵匣举过了头顶。匣门大开，里面空无一物——原来机缘从来不在匣中，在开匣的手上。' },
  ];

  const UPGRADES = {
    // 上限 50 = 开箱间隔触底点（2.5×0.95^50≈0.19 被 0.2s 下限封住，2026-11-01 调整：
    // 原 2×0.94^60→0.05s），满级即极速，无废级；
    // growth 2026-10-30 各 +0.1：灵石升级成本曲线加陡，节流后期战力与收益膨胀
    // 开箱速度（2026-11-01 用户指定逆推）：base 100（同日 ×2 指定），第 50 级（Lv49→50 末次升级）
    // 锚定 50 兆灵石 → growth = (5e13/100)^(1/49) ≈ 1.7333，几何阶梯精确触达
    speed: { label: '开箱速度', base: 100, growth: Math.pow(5e11, 1 / 49), max: 50 },
    gain: { label: '灵石收益', base: 40, growth: 1.7, max: 60 },
    luck: { label: '气运', base: 150, growth: 1.8, max: 60 },
  };

  const $ = (id) => document.getElementById(id);

  // 默认穿戴/强化/宝石表：从 SLOTS 生成（2026-11-01 槽位扩容后不再手写键名，防漂移）
  const emptyEquipped = () => Object.fromEntries(SLOTS.map((s) => [s.key, null]));

  // 部位强化等级与部位宝石孔（2026-10-31 部位化：绑部位不随装备）
  const emptyEnhance = () => Object.fromEntries(SLOTS.map((s) => [s.key, 0]));
  const emptySlotGems = () => Object.fromEntries(SLOTS.map((s) => [s.key, []]));

  const defaults = () => ({
    stones: 0,
    totalStones: 0,
    dust: 0,
    exp: 0,
    opens: 0,
    realm: 0,
    realmPeak: 0,    // 境界水位：历史最高境界，飞升重置境界但不清水位——已解锁的境界门槛内容不回锁（2026-11-01 用户指定）
    ascensions: 0,
    clickCount: 0,   // 累计手动开箱点击（连点器服务端判定信号，随档上报）
    speedLv: 0,
    gainLv: 0,
    luckLv: 0,
    counts: [0, 0, 0, 0, 0, 0],
    best: -1,
    buffUntil: 0,
    lastSeen: Date.now(),
    muted: false,
    battleSpeed: 1,
    volume: 0.6,
    achievements: {},
    signInDays: 0,
    lastSignIn: '',
    lastSignMode: '',
    signLog: [],
    signStats: { plays: 0, big: 0, keep: 0, zero: 0, bust: 0, bestMult: 0, worstCut: 0 },
    daily: { date: '', opens: 0, wins: 0, forge: 0, claimed: [], sweep: emptyDailySweep(), sweepBought: emptyDailySweep(), wildRepeat: 0, gamble: 0 },
    weekly: { week: '', opens: 0, wins: 0, rogue: 0, claimed: [] },
    dustTotal: 0,
    trialWins: 0,
    rushS: 0,
    signMilestones: [],
    setCollection: { tower: [], stage: [], wild: [] },
    petTickets: 0,
    pets: {},
    activePet: '',
    activePets: [],
    petSlots: 1,
    petTokens: {},
    cave: { array: 0, garden: 0, library: 0 },
    elixir: { owned: {}, until: 0, id: '', crafting: null },
    gongfa: { atk: 0, hp: 0, hui: 0 },
    immortal: 0,
    rogue: { best: 0, run: null },
    bestiary: {},
    title: '',
    market: { date: '', sold: [] },
    trials: { date: '', done: [] },
    bossRush: { date: '', grade: '' },
    adventure: { lastAt: 0 },
    rerollCoupon: 0,
    endlessBest: 0,
    steward: { autoWear: false, autoSalvage: 0, autoMarket: [] },
    souls: 0,
    mirror: { week: '', snap: null, claimed: false },
    map: null,
    ordeal: { active: '', dirty: false },
    ordealDone: [],
    museum: emptyEquipped(),
    farm: { plots: [null, null, null] },
    chapters: [],
    story: { cleared: [], met: [] },
    innerDemon: null,
    bounty: { date: '', slots: [], rerolls: 0, allClaimed: false },
    talismans: 0,
    tribulation: { last: '', done: false },
    daoLv: { aff: {}, spend: {}, married: '' },
    battleStats: { dmg: 0, taken: 0, wins: 0 },
    log: [],
    bag: [],
    equipped: emptyEquipped(),
    enh: emptyEnhance(),
    slotGems: emptySlotGems(),
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
    featureSeen: [],
    tutorialSeen: false,
    fontScale: 1,
    theme: 'light',
    themeSet: false,
    bagTokens: 0,
    bagExtra: 0,
    power: 0,
    pvpSnap: null,
    boss: { claimed: '' },
    guildBoss: { claimed: '' },
    wander: { karma: 0, last: 0, pending: null, done: 0 },
    treasure: { frags: 0, maps: 0, at: -1, digs: 0 },
    fishing: { bait: 5, date: '', casts: 0, bestT: -1 },
    petCores: {},
    gather: { ore: 0, herb: 0, nodes: { ore: { lv: 0, until: 0 }, herb: { lv: 0, until: 0 } } },
    lastScene: '',
    tide: { date: '', claimed: [false, false] },
    month: { key: '', days: [], makeup: 0, claimed: [] },
    quiz: { date: '', idx: 0, correct: 0, done: false, streak: 0 },
    anomaly: { date: '', done: false, grade: '', sDays: [], bonusMonth: '' },
    vigor: { date: '', minutes: 0, claimed: 0, lastMs: 0 },
    fortune: { date: '', idx: -1, claimed: false },
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
  let lastBattles = { tower: null, stage: null, wild: null, endless: null };
  let audioCtx = null;
  let bagSort = 'power';   // 背包排序：power / rarity / slot（仅内存，不入档）
  let bagFilter = 'all';   // 背包筛选：all / 部位 key（仅内存，不入档）
  let achvFilter = 'all';  // 成就筛选：all / ready（未领取）/ done（已完成）/ todo（未完成）（仅内存，不入档）
  let wildGroupOpen = -1;  // 野外分组展开：-1 = 跟随当前所在关卡（仅内存，不入档）
  // 扫荡选关条独立展开组：与野外选区条分属不同玩法（闯关/爬塔 vs 野外），
  // 共用 wildGroupOpen 会在两玩法间互串展开组（2026-11-01 拆开）
  let sweepGroupOpen = -1;
  const sweepPick = { stage: 0, tower: 0 }; // 扫荡目标关：0 = 默认最高已通关（仅内存，不入档）
  let panelSigs = {};      // 新面板签名缓存（内容没变就不重绘）
  let tribPrompted = false;

  /* ---------------- 存档（云端唯一持久层，2026-10-31 去本地落盘） ---------------- */

  // 多标签页推送锁：心跳标记 + 过期判定，防止两个标签页同时往云端推档互相踩
  const TAB_LOCK_KEY = 'lingxia_idle_tab';
  const TAB_LOCK_MS = 6000;
  const TAB_ID = Math.random().toString(36).slice(2);

  function tabLockHeldByOther() {
    try {
      const raw = localStorage.getItem(TAB_LOCK_KEY);
      if (!raw) return false;
      const lock = JSON.parse(raw);
      return lock.id !== TAB_ID && Date.now() - lock.at < TAB_LOCK_MS;
    } catch (e) {
      return false;
    }
  }

  function tabHeartbeat() {
    try {
      localStorage.setItem(TAB_LOCK_KEY, JSON.stringify({ id: TAB_ID, at: Date.now() }));
    } catch (e) { /* 忽略 */ }
  }

  function persist() {
    try {
      // 登出流程中不再落盘：导航触发 hidden/pagehide 会再走 save()，把刚清掉的档写回去
      if (authSignedOut) return;
      // 同浏览器多标签：非持有页静默停写（跨设备互踢由服务端单会话保证）
      if (tabLockHeldByOther()) return;
      tabHeartbeat();
      // 战力档案随档上推：服务端落 users.power_score / realm / pvp_snapshot，供排行与竞技场用
      // （上报口径为实际战力 realPower：装备分 × 实战乘区，服务端 DEEP 上限已同步放宽）
      const cs = playerCombatStats();
      state.power = realPower();
      state.pvpSnap = {
        atk: Math.round(cs.atk * 100) / 100,
        hp: Math.round(cs.hp * 100) / 100,
        def: Math.round(cs.def * 100) / 100,
        crit: Math.round(cs.crit * 1000) / 1000,
        critMult: cs.critMult,
        lifesteal: Math.round(cs.lifesteal * 1000) / 1000,
        dr: Math.round(cs.dr * 1000) / 1000,
        pierce: Math.round(cs.pierce * 1000) / 1000,
      };
      const text = JSON.stringify(state);
      queueCloud(text); // 云端唯一持久层：进度同步入 SQLite（节流推送，关页有 beacon 兜底）
    } catch (e) {
      /* 序列化异常忽略 */
    }
  }

  /* ---------------- 云存档（服务端 SQLite） ---------------- */

  let cloudOn = false;         // 已通过登录门禁、/api 可用
  let cloudUser = null;        // 显示名（江湖称呼，非登录道号）
  let cloudPending = null;     // 待推送的存档文本
  let cloudLastPush = 0;
  let cloudTimer = 0;
  let cloudBusy = false;
  let cloudWarnAt = 0;         // 上次「云端拒收」提示时间（节流，10 分钟一次）
  let authSignedOut = false;   // 登出流程中：persist / 关页兜底全部停手（配合登出清本地档）

  // 统一带 401 处理的 API 调用：会话失效自动回登录页
  async function api(pathname, opts = {}) {
    const res = await fetch(pathname, Object.assign({
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' },
    }, opts));
    if (res.status === 401) {
      location.replace('/login.html');
      throw new Error('unauthorized');
    }
    return res;
  }

  function blockStart(msg) {
    const mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:#101614;color:#e8e6df;font:15px/1.8 -apple-system,"PingFang SC",sans-serif;text-align:center;padding:24px;';
    mask.textContent = msg;
    document.body.appendChild(mask);
  }

  // 登录门禁：未登录跳登录页；没有后端（纯静态托管）也拦下，账号玩法必须走服务端
  async function authGate() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } });
      if (res.status === 401) {
        location.replace('/login.html');
        return false;
      }
      if (!res.ok) throw new Error('bad status ' + res.status);
      const me = await res.json();
      cloudOn = true;
      cloudUser = me.displayName || me.username;
      return true;
    } catch (e) {
      if (e.message !== 'unauthorized') {
        blockStart('本版本需要登录账号才能修行：请通过游戏服务端访问（node server/index.js 启动后打开首页）。');
      }
      return false;
    }
  }

  // 启动恢复（云端唯一存档层）：拉云端档直接入 state；无档 = 全新账号全新开局；
  // 拉取失败或档损坏则拦下启动——不能拿空白档开局，否则首推会把云端真实进度顶掉
  async function cloudRestore() {
    try {
      const res = await api('/api/save');
      if (!res.ok) throw new Error('bad status ' + res.status);
      const body = await res.json();
      if (body && body.found && body.text) {
        applySaveData(JSON.parse(body.text)); // 档损坏会 throw，由下方统一拦截
      }
      applyClickBan(body && body.clickBanUntil);
      return true;
    } catch (e) {
      console.error('[cloud] 存档拉取失败', e);
      blockStart('云端存档拉取失败，请检查网络后刷新重试。');
      return false;
    }
  }

  function queueCloud(text) {
    if (!cloudOn) return;
    cloudPending = text;
    const now = Date.now();
    if (now - cloudLastPush >= CLOUD_MIN_GAP) {
      flushCloud();
    } else if (!cloudTimer) {
      cloudTimer = setTimeout(() => { cloudTimer = 0; flushCloud(); }, CLOUD_MIN_GAP - (now - cloudLastPush) + 20);
    }
  }

  async function flushCloud() {
    if (authSignedOut) return; // 登出/重置后不再推已作废的会话档（5 秒重试定时器也走这里）
    if (!cloudOn || !cloudPending || cloudBusy) return;
    const text = cloudPending;
    cloudBusy = true;
    try {
      const res = await api('/api/save', { method: 'POST', body: text });
      if (res.ok) {
        // await 期间 persist 可能已把 pending 换成更新的档：只清掉自己推的那份
        if (cloudPending === text) cloudPending = null;
        cloudLastPush = Date.now();
        try { applyClickBan((await res.json()).clickBanUntil); } catch (e) { /* 忽略非 JSON */ }
      } else if (res.status === 400 || res.status === 422) {
        // 服务端校验拒收（量级/增速 400）：丢弃本份待推档避免 5 秒死循环重试，
        // 节流提示一次；本地照常可玩，下次 persist 的自然重推即为重新同步。
        // 429 / 5xx 等临时故障不走这里——保留 pending 由下方 5 秒重试兜底（复审 P2-6）
        cloudPending = null;
        let msg = '';
        try { msg = (await res.json()).error || ''; } catch (e) { /* 忽略非 JSON 响应 */ }
        if (Date.now() - cloudWarnAt > 600000) {
          cloudWarnAt = Date.now();
          const tip = msg || '云端存档被拒';
          floatText('云端同步：' + tip, '#f87171');
          pushLog('云端存档被拒：' + tip + '（换设备首次同步可能出现，进度追上后自动恢复）', 'sys');
        }
      }
    } catch (e) { /* 失败保留 pending，由下一次存档或关页兜底重试 */ }
    cloudBusy = false;
    if (cloudPending && !cloudTimer) {
      cloudTimer = setTimeout(() => { cloudTimer = 0; flushCloud(); }, 5000);
    }
  }

  // 关页兜底：sendBeacon 尽力推最后一帧（挂了也有 5 秒节流内的常规推送顶着）
  function cloudFlushNow() {
    if (authSignedOut) return; // 登出后不再推已清档的会话
    if (!cloudOn || !cloudPending) return;
    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([cloudPending], { type: 'application/json' });
        if (navigator.sendBeacon('/api/save/beacon', blob)) cloudPending = null;
      }
    } catch (e) { /* 忽略 */ }
  }

  async function setDisplayName() {
    const input = $('displayNameInput');
    const name = ((input && input.value) || '').trim();
    if (!name) { floatText('先输入显示名', '#f87171'); return; }
    try {
      const out = await worldFetch('/api/profile/name', { method: 'POST', body: JSON.stringify({ name }) });
      cloudUser = out.displayName;
      paintUserChip();
      paintPlayerName(); // 主角名展示点（红尘录简介 / 战斗弹窗）随昵称即时刷新
      pushLog('江湖称呼已改为「' + out.displayName + '」', 'special');
      floatText('显示名已更新', '#facc15');
      input.value = '';
    } catch (e) {
      floatText(e.message, '#f87171');
    }
  }

  // 页脚版本号 + 服务器时间：来自 /api/version；时间按服务器时区走针（每秒）。
  // 兼做断服探针：连续拉取失败满 2 分钟即强制跳回登录页（?down=1 由登录页挂「维护中」横幅），
  // 不保留断服本地玩法；期间恢复连接则计时清零，无感续玩。
  (function serverFooter() {
    const verEl = $('gameVersion');
    const timeEl = $('serverTime');
    let offset = null; // 服务器 epoch − 本地 epoch
    let tzOff = 0;     // 服务器时区偏移（getTimezoneOffset 口径，UTC+8 为 -480）
    let downSince = 0; // 首次拉取失败的时刻；距此刻满 2 分钟即跳登录页
    const p2 = (n) => String(n).padStart(2, '0');
    function paint() {
      if (!timeEl || offset === null) return;
      // 服务器挂钟 = 服务器 epoch − 时区偏移；用 getUTC* 读出即服务器本地时刻
      const d = new Date(Date.now() + offset - tzOff * 60000);
      timeEl.textContent = '服务器时间 ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds());
      timeEl.title = '服务器日期 ' + d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) +
        '，竞技场 / 妖王等每日重置以服务器日期为准；签到 / 日常 / 商店等以设备本地日期为准';
    }
    async function sync() {
      try {
        const res = await fetch('/api/version', { credentials: 'same-origin' });
        if (!res.ok) throw new Error('bad status ' + res.status);
        downSince = 0;
        const body = await res.json();
        if (verEl && body && body.version) verEl.textContent = '版本 v' + body.version;
        if (body && typeof body.time === 'number') {
          offset = body.time - Date.now();
          tzOff = typeof body.tzOffset === 'number' ? body.tzOffset : 0;
          paint();
        }
      } catch (e) {
        const now = Date.now();
        if (!downSince) downSince = now;
        else if (now - downSince >= 120000) location.replace('/login.html?down=1');
      }
    }
    sync();
    setInterval(paint, 1000);
    setInterval(sync, 60000);
  })();

  function paintUserChip() {
    try {
      // 名称后缀展示飞升次数：+1 飞升一次、+2 两次（仙缘点数）
      const asc = Math.max(0, state.ascensions | 0);
      const name = cloudUser ? cloudUser + (asc > 0 ? '+' + asc : '') : '';
      const chip = $('userChip');
      if (chip && name) {
        chip.textContent = name;
        chip.title = '江湖称呼：' + cloudUser + (asc > 0 ? ' · 已飞升 ' + asc + ' 次' : '');
      }
      const now = $('displayNameNow');
      if (now && name) now.textContent = name;
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 教程 / 新玩法弹层 ---------------- */

  // 强制阅读的引导弹层：队列逐条出队。三个来源——
  // ① 全新档首次进入的「初入江湖」教程；② 新玩法解锁（复用 PLAY_MODES 元数据）；
  // ③ 故事全卷通关的「新卷开启」预告。仅内存排队，关闭即弃（可再遇，无持久负担）。
  const guideQueue = [];
  let guideOpen = false;

  function guidePump() {
    if (guideOpen || !guideQueue.length) return;
    // 其他弹层（故事对话 / 战斗 / 离线结算等）开着时不打断，等它关闭后由轮询补泵
    if (document.querySelector('.modal.show')) return;
    const g = guideQueue.shift();
    guideOpen = true;
    $('guideKicker').textContent = g.kicker + (guideQueue.length ? '（还有 ' + guideQueue.length + ' 条）' : '');
    $('guideTitle').textContent = g.title;
    $('guideBody').innerHTML = g.body;
    $('guideBtn').textContent = g.btn || '知道了';
    $('guideModal').classList.add('show');
  }

  function guideEnqueue(entry) {
    guideQueue.push(entry);
    guidePump();
  }

  function guideClose() {
    $('guideModal').classList.remove('show');
    guideOpen = false;
    guidePump();
  }
  // 队列非空时低频补泵：等占用中的其他弹层关闭后自动接续展示
  setInterval(guidePump, 1000);

  // 首次进入（全新档）：核心玩法循环一次讲清
  function enqueueFirstTimeTutorial() {
    guideEnqueue({
      kicker: '初入江湖 · 新手指南',
      title: '欢迎来到灵匣纪元',
      btn: '开始修行 ▸',
      body:
        '<p><b>开匣得宝</b>：修炼页点灵匣（或空格键）开匣，得装备、灵石与修为；开到的装备自动比较战力，更好的直接上身。</p>' +
        '<p><b>灵石淬炼</b>：灵石拿去淬炼开箱速度与收益，滚雪球越滚越快。</p>' +
        '<p><b>修为突破</b>：修为攒够就突破境界，境界越高，解锁的玩法越多——解锁时会弹窗告诉你。</p>' +
        '<p><b>秘境征战</b>：征战页打闯关 / 爬塔 / 野外，专属套装是战力的主力来源。</p>' +
        '<p><b>进度无忧</b>：进度自动保存在本机并同步云端，离线也有挂机收益。</p>' +
        '<p class="guide-tip clickable" id="guideTipJump">☝ 修炼页底部的「修行指南」面板随时可以回看全部玩法；设置页也可回看本教程（点击本行直达）。</p>',
    });
  }

  function save() {
    if (!document.hidden) state.lastSeen = Date.now();
    persist();
  }

  // 应用云端档（或重置后的空白档）：迁移/钳制口径与旧本地载入完全一致。
  // 逐键拷贝并跳过 __proto__/constructor/prototype——Object.assign 会触发
  // __proto__ setter，被改档的云端文本可借它重挂 state 的原型（原型注入）
  function applySaveData(data) {
    try {
      state = defaults();
      for (const k of Object.keys(data)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        state[k] = data[k];
      }
      // lastSeen 是唯一直接进时间运算的字段：坏值会让 awardOffline 产出 NaN
      // 灵石并污染后续所有推送（NaN 序列化为 null → 服务端 400 死循环）
      const ls = Number(state.lastSeen);
      state.lastSeen = Number.isFinite(ls) && ls > 0 ? ls : Date.now();

      if (!Array.isArray(state.counts) || state.counts.length !== RARITIES.length) {
        state.counts = [0, 0, 0, 0, 0, 0];
      }
      if (!Array.isArray(state.log)) state.log = [];
      if (!Array.isArray(state.featureSeen)) state.featureSeen = [];
      state.tutorialSeen = !!state.tutorialSeen;
      state.realm = Math.max(0, Math.min(REALMS.length - 1, state.realm | 0));
      // 境界水位（2026-11-01）：老档无此字段按当前境界种初始值，此后只升不降
      state.realmPeak = Math.max(
        Math.max(0, Math.min(REALMS.length - 1, state.realmPeak | 0)),
        state.realm
      );
      // 存量飞升档追溯：旧版飞升会丢水位，用 featureSeen（历史解锁播报）反推门槛下限——
      // 播报过的玩法必然达成过其境界门槛，按最高门槛回填
      if (Array.isArray(state.featureSeen)) {
        for (const fid of state.featureSeen) {
          const gate = FEATURE_GATES[fid] || 0;
          if (gate > state.realmPeak) state.realmPeak = Math.min(gate, REALMS.length - 1);
        }
      }
      state.best = Math.max(-1, Math.min(RARITIES.length - 1, state.best | 0));

      if (!Array.isArray(state.bag)) state.bag = [];
      state.bag = state.bag.filter(
        (it) => it && isFinite(it.power) && RARITIES[it.r] && SLOT_MAP[it.slot]
      );

      if (!state.equipped || typeof state.equipped !== 'object') state.equipped = emptyEquipped();
      for (const s of SLOTS) {
        const it = state.equipped[s.key];
        state.equipped[s.key] =
          (it && it.slot === s.key && isFinite(it.power) && RARITIES[it.r] && SLOT_MAP[it.slot]) ? it : null;
      }

      let seq = typeof state.itemSeq === 'number' && state.itemSeq > 0 ? state.itemSeq : 1;
      let maxId = 0;
      // 注意：fixInt 必须先于 fixItem 定义——fixItem 内部会调用它（TDZ）
      const fixInt = (v, lo, hi) => {
        const n = Math.floor(Number(v));
        return Math.max(lo, Math.min(hi, isFinite(n) ? n : 0));
      };
      const fixItem = (it) => {
        if (typeof it.id !== 'number') it.id = seq++;
        if (it.setKey && !SETS[it.setKey]) {
          delete it.setKey;
          delete it.special;
        }
        if (it.special) it.r = 5;
        if (!ELEMENT_BEATS[it.el]) it.el = randEl();
        // 反作弊：普通装备战力上界（仙品基准 ×1.3）
        if (!it.special) {
          const cap = Math.round(BASE_POWER[it.r] * 1.3);
          if (it.power > cap) it.power = Math.max(1, cap);
        }
        it.star = fixInt(it.star, 0, 5);
        if (typeof it.name !== 'string' || !it.name) {
          // 套装件按槽位还原正式件名（覆盖第七批槽位迁移期掉落的 undefined 名存量件）
          it.name = (it.setKey && SETS[it.setKey] && SETS[it.setKey].pieces[it.slot]) ||
            RARITIES[it.r].name + '遗物';
        }
        sanitizeAffixes(it);
        if (it.id > maxId) maxId = it.id;
      };
      for (const it of state.bag) fixItem(it);
      for (const s of SLOTS) {
        if (state.equipped[s.key]) fixItem(state.equipped[s.key]);
      }
      state.itemSeq = Math.max(seq, maxId + 1);

      state.towerCleared = fixInt(state.towerCleared, 0, TOWER_MAX);
      state.stageCleared = fixInt(state.stageCleared, 0, STAGE_MAX);
      state.towerMarks = fixInt(state.towerMarks, 0, 1e9);
      state.warMerits = fixInt(state.warMerits, 0, 1e9);
      state.beastBones = fixInt(state.beastBones, 0, 1e9);
      state.trainAtk = fixInt(state.trainAtk, 0, MAX_TRAIN);
      state.trainHp = fixInt(state.trainHp, 0, MAX_TRAIN);
      state.trainPierce = fixInt(state.trainPierce, 0, MAX_TRAIN);
      state.speedLv = fixInt(state.speedLv, 0, UPGRADES.speed.max);
      state.clickCount = fixInt(state.clickCount, 0, 1e12);
      state.gainLv = fixInt(state.gainLv, 0, UPGRADES.gain.max);
      state.luckLv = fixInt(state.luckLv, 0, UPGRADES.luck.max);
      state.dust = fixInt(state.dust, 0, 1e12);
      // 自动战斗需飞升一次：未飞升的老档读档时自动关
      state.autoHunt = !!state.autoHunt && (state.ascensions | 0) >= 1;
      state.battleSpeed = [1, 2, 4].includes(state.battleSpeed) ? state.battleSpeed : 1;
      if (!Number.isFinite(state.volume)) state.volume = 0.6;
      state.volume = Math.max(0, Math.min(1, Number(state.volume)));
      if (typeof state.lastSignIn !== 'string') state.lastSignIn = '';
      if (!['', 'normal', 'gamble'].includes(state.lastSignMode)) state.lastSignMode = '';
      // 签到流水：清非法条目、封顶保最新；x 为赌狗带符号倍率（普通签到无此字段）
      if (!Array.isArray(state.signLog)) state.signLog = [];
      state.signLog = state.signLog
        .filter((e) => e && typeof e === 'object' && !Array.isArray(e) &&
          typeof e.d === 'string' && (e.m === 'n' || e.m === 'g'))
        .slice(0, SIGN_LOG_MAX)
        .map((e) => ({
          d: e.d.slice(0, 5),
          m: e.m,
          x: typeof e.x === 'number' && isFinite(e.x) ? Math.max(-9.9, Math.min(9.9, e.x)) : undefined,
          s: fixInt(e.s, -1e12, 1e15),
          u: fixInt(e.u, 0, 1e12),
        }));
      if (!state.signStats || typeof state.signStats !== 'object' || Array.isArray(state.signStats)) {
        state.signStats = { plays: 0, big: 0, keep: 0, zero: 0, bust: 0, bestMult: 0, worstCut: 0 };
      }
      state.signStats = {
        plays: fixInt(state.signStats.plays, 0, 1e9),
        big: fixInt(state.signStats.big, 0, 1e9),
        keep: fixInt(state.signStats.keep, 0, 1e9),
        zero: fixInt(state.signStats.zero, 0, 1e9),
        bust: fixInt(state.signStats.bust, 0, 1e9),
        bestMult: fixInt(state.signStats.bestMult, 0, 99),
        worstCut: fixInt(state.signStats.worstCut, 0, 1e15),
      };
      if (!state.achievements || typeof state.achievements !== 'object' || Array.isArray(state.achievements)) {
        state.achievements = {};
      }
      state.signInDays = fixInt(state.signInDays, 0, 1e6);
      if (!state.daily || typeof state.daily !== 'object' || Array.isArray(state.daily)) {
        state.daily = { date: '', opens: 0, wins: 0, forge: 0, claimed: [] };
      }
      state.daily = {
        date: typeof state.daily.date === 'string' ? state.daily.date : '',
        opens: fixInt(state.daily.opens, 0, 1e9),
        wins: fixInt(state.daily.wins, 0, 1e9),
        forge: fixInt(state.daily.forge, 0, 1e9),
        claimed: Array.isArray(state.daily.claimed)
          ? state.daily.claimed.filter((id) => DAILY_TASKS.some((t) => t.id === id))
          : [],
        // 老档当日补默认：扫荡计数（钳制上限随 SWEEP_DAILY_FREE/SWEEP_BUY_MAX 常量走）
        sweep: clampDailySweep(state.daily.sweep, SWEEP_DAILY_FREE + SWEEP_BUY_MAX),
        sweepBought: clampDailySweep(state.daily.sweepBought, SWEEP_BUY_MAX),
        wildRepeat: fixInt(state.daily.wildRepeat, 0, WILD_REPEAT_DAILY),
        // 赌石当日次数：漏拷此键会让每次读档计数归零，500 次/日上限形同虚设（2026-11-01 修）
        gamble: fixInt(state.daily.gamble, 0, GAMBLE_DAILY_MAX),
      };
      const collected = { tower: [], stage: [], wild: [] };
      if (state.setCollection && typeof state.setCollection === 'object') {
        for (const key of Object.keys(collected)) {
          if (Array.isArray(state.setCollection[key])) {
            collected[key] = Array.from(new Set(
              state.setCollection[key].filter((sl) => SLOT_MAP[sl] && SETS[key].pieces[sl])
            ));
          }
        }
      }
      // 追溯收录：身上与包里的专属件并入图鉴
      const scanSet = (it) => {
        if (it && it.setKey && collected[it.setKey] &&
          SETS[it.setKey].pieces[it.slot] && !collected[it.setKey].includes(it.slot)) {
          collected[it.setKey].push(it.slot);
        }
      };
      for (const it of state.bag) scanSet(it);
      for (const s of SLOTS) scanSet(state.equipped[s.key]);
      state.setCollection = collected;
      state.petTickets = fixInt(state.petTickets, 0, 1e9);
      if (!state.pets || typeof state.pets !== 'object' || Array.isArray(state.pets)) state.pets = {};
      const petLv = {};
      for (const def of PETS) {
        if (state.pets[def.id] === undefined) continue; // 按「字段存在」判拥有，0 级也是拥有
        petLv[def.id] = fixInt(state.pets[def.id], 0, PET_MAX_LV);
      }
      state.pets = petLv;
      if (!PETS.some((p) => p.id === state.activePet) || !state.pets[state.activePet]) state.activePet = '';
      if (!state.cave || typeof state.cave !== 'object' || Array.isArray(state.cave)) {
        state.cave = { array: 0, garden: 0, library: 0 };
      }
      state.cave = {
        array: fixInt(state.cave.array, 0, CAVE.array.max),
        garden: fixInt(state.cave.garden, 0, CAVE.garden.max),
        library: fixInt(state.cave.library, 0, CAVE.library.max),
      };
      state.endlessBest = fixInt(state.endlessBest, 0, 1e9);
      // 试炼 / 养成 / 调味：新面板字段兜底
      if (!state.gongfa || typeof state.gongfa !== 'object' || Array.isArray(state.gongfa)) {
        state.gongfa = { atk: 0, hp: 0, hui: 0 };
      }
      state.gongfa = {
        atk: fixInt(state.gongfa.atk, 0, GONGFA.atk.max),
        hp: fixInt(state.gongfa.hp, 0, GONGFA.hp.max),
        hui: fixInt(state.gongfa.hui, 0, GONGFA.hui.max),
      };
      state.petSlots = state.petSlots === 2 ? 2 : 1;
      if (!Array.isArray(state.activePets)) {
        state.activePets = state.activePet && state.pets[state.activePet] !== undefined ? [state.activePet] : [];
      }
      state.activePets = state.activePets
        .filter((id) => PETS.some((p) => p.id === id) && state.pets[id] !== undefined)
        .slice(0, state.petSlots);
      if (!state.petTokens || typeof state.petTokens !== 'object' || Array.isArray(state.petTokens)) {
        state.petTokens = {};
      }
      const tokens = {};
      for (const def of PETS) {
        const lv = fixInt(state.petTokens[def.id], 0, TOKEN_MAX);
        if (lv > 0) tokens[def.id] = lv;
      }
      state.petTokens = tokens;
      // 云游奇遇 / 藏宝图 / 钓鱼 / 内丹 / 采集：老档补默认并钳制
      if (!state.wander || typeof state.wander !== 'object' || Array.isArray(state.wander)) {
        state.wander = { karma: 0, last: 0, pending: null, done: 0 };
      }
      state.wander = {
        karma: fixInt(state.wander.karma, -10, 10),
        last: isFinite(state.wander.last) ? Number(state.wander.last) : 0,
        pending: state.wander.pending && WANDER_EVENTS.some((w) => w.id === state.wander.pending.id)
          ? { id: state.wander.pending.id, at: Date.now() }
          : null,
        done: fixInt(state.wander.done, 0, 1e9),
      };
      if (!state.treasure || typeof state.treasure !== 'object' || Array.isArray(state.treasure)) {
        state.treasure = { frags: 0, maps: 0, at: -1, digs: 0 };
      }
      state.treasure = {
        frags: fixInt(state.treasure.frags, 0, 1e6),
        maps: fixInt(state.treasure.maps, 0, 99),
        at: fixInt(state.treasure.at, -1, MAP_W * MAP_H - 1),
        digs: fixInt(state.treasure.digs, 0, 1e6),
      };
      if (!state.fishing || typeof state.fishing !== 'object' || Array.isArray(state.fishing)) {
        state.fishing = { bait: FISH_BAIT_DAILY, date: '', casts: 0, bestT: -1 };
      }
      state.fishing = {
        bait: fixInt(state.fishing.bait, 0, 99),
        date: typeof state.fishing.date === 'string' ? state.fishing.date : '',
        casts: fixInt(state.fishing.casts, 0, 1e9),
        bestT: fixInt(state.fishing.bestT, -1, FISH_TABLE.length - 1),
      };
      if (!state.petCores || typeof state.petCores !== 'object' || Array.isArray(state.petCores)) {
        state.petCores = {};
      }
      const cores = {};
      for (const def of PETS) {
        if (state.pets[def.id] === undefined) continue; // 未拥有的宠（放生/未招募）不保留内丹
        const lv = fixInt(state.petCores[def.id], 0, CORE_MAX);
        if (lv > 0) cores[def.id] = lv;
      }
      state.petCores = cores;
      if (!state.gather || typeof state.gather !== 'object' || Array.isArray(state.gather) ||
        !state.gather.nodes || typeof state.gather.nodes !== 'object') {
        state.gather = { ore: 0, herb: 0, nodes: { ore: { lv: 0, until: 0 }, herb: { lv: 0, until: 0 } } };
      }
      const gatherNodes = {};
      for (const key of Object.keys(GATHER_NODES)) {
        const n = state.gather.nodes[key] || {};
        gatherNodes[key] = {
          lv: fixInt(n.lv, 0, GATHER_MAX_LV),
          until: isFinite(n.until) ? Number(n.until) : 0,
        };
      }
      state.gather = {
        ore: fixInt(state.gather.ore, 0, 1e6),
        herb: fixInt(state.gather.herb, 0, 1e6),
        nodes: gatherNodes,
      };
      if (typeof state.lastScene !== 'string') state.lastScene = '';
      if (!state.elixir || typeof state.elixir !== 'object' || Array.isArray(state.elixir)) {
        state.elixir = { owned: {}, until: 0, id: '', crafting: null };
      }
      const ownedElixir = {};
      const ownedRaw = (state.elixir.owned && typeof state.elixir.owned === 'object' &&
        !Array.isArray(state.elixir.owned)) ? state.elixir.owned : {};
      for (const def of ELIXIRS) {
        const n = fixInt(ownedRaw[def.id], 0, 99);
        if (n > 0) ownedElixir[def.id] = n;
      }
      const elixirMsMax = Math.max(...ELIXIRS.map((e) => e.ms));
      state.elixir = {
        owned: ownedElixir,
        // 效果与炉火结束时间只可能落在「现在 + 单份最长时长」以内，更远的都是改档
        until: isFinite(state.elixir.until) ? Math.min(Number(state.elixir.until), Date.now() + elixirMsMax) : 0,
        id: ELIXIRS.some((e) => e.id === state.elixir.id) ? state.elixir.id : '',
        crafting: state.elixir.crafting && ELIXIRS.some((e) => e.id === state.elixir.crafting.id) &&
          isFinite(state.elixir.crafting.doneAt)
          ? { id: state.elixir.crafting.id, doneAt: Math.min(Number(state.elixir.crafting.doneAt), Date.now() + elixirMsMax) }
          : null,
      };
      if (!state.rogue || typeof state.rogue !== 'object' || Array.isArray(state.rogue)) {
        state.rogue = { best: 0, run: null };
      }
      state.rogue.best = fixInt(state.rogue.best, 0, ROGUE_FLOORS);
      if (state.rogue.run && typeof state.rogue.run === 'object') {
        const buffs = Array.isArray(state.rogue.run.buffs)
          ? Array.from(new Set(state.rogue.run.buffs.filter((id) => ROGUE_BUFFS.some((b) => b.id === id))))
          : [];
        state.rogue.run = {
          floor: fixInt(state.rogue.run.floor, 1, ROGUE_FLOORS),
          buffs,
          reviveUsed: !!state.rogue.run.reviveUsed,
        };
      } else {
        state.rogue.run = null;
      }
      if (!state.bestiary || typeof state.bestiary !== 'object' || Array.isArray(state.bestiary)) {
        state.bestiary = {};
      }
      const beast = {};
      for (const key of Object.keys(state.bestiary)) {
        const n = fixInt(state.bestiary[key], 0, 1e9);
        if (n > 0 && typeof key === 'string' && key.length <= 20) beast[key] = n;
      }
      state.bestiary = beast;
      if (typeof state.title !== 'string') state.title = '';
      const ownedTitles = ACHIEVEMENTS.filter((a) => a.title && state.achievements[a.id]).map((a) => a.title);
      if (state.title && !ownedTitles.includes(state.title)) state.title = '';
      if (!state.market || typeof state.market !== 'object' || Array.isArray(state.market)) {
        state.market = { date: '', sold: [] };
      }
      state.market = {
        date: typeof state.market.date === 'string' ? state.market.date : '',
        sold: Array.isArray(state.market.sold) ? state.market.sold.filter((id) => MARKET_POOL.some((p) => p.id === id)) : [],
      };
      if (!state.trials || typeof state.trials !== 'object' || Array.isArray(state.trials)) {
        state.trials = { date: '', done: [] };
      }
      state.trials = {
        date: typeof state.trials.date === 'string' ? state.trials.date : '',
        done: Array.isArray(state.trials.done) ? state.trials.done.filter((id) => TRIALS.some((t) => t.id === id)) : [],
      };
      if (!state.bossRush || typeof state.bossRush !== 'object' || Array.isArray(state.bossRush)) {
        state.bossRush = { date: '', grade: '' };
      }
      state.bossRush = {
        date: typeof state.bossRush.date === 'string' ? state.bossRush.date : '',
        grade: typeof state.bossRush.grade === 'string' ? state.bossRush.grade : '',
      };
      if (!state.adventure || typeof state.adventure !== 'object' || Array.isArray(state.adventure)) {
        state.adventure = { lastAt: 0 };
      }
      state.adventure = {
        lastAt: isFinite(state.adventure.lastAt)
          ? Math.min(Math.max(0, Number(state.adventure.lastAt)), Date.now())
          : 0,
      };
      // 仙位钳制：过宽会溢出为 Infinity 污染全部分子分母；999 已远超玩法上限
      //（仙位收益倍率 2026-11-01 起为 1.1^n 收益 / 1.05^n 秘境缩放，钳制口径不变）
      state.immortal = fixInt(state.immortal, 0, 999);
      state.rerollCoupon = fixInt(state.rerollCoupon, 0, 99);

      // —— 部位化迁移（2026-10-31，旧档一次性）：强化等级与宝石从装备迁到部位 ——
      // 判定：档里没有 enh 字段即为旧档（迁移后的档必然带 enh）。
      // 强化：每槽取历史最高（穿戴 → 背包同部位 → 陈列室）；宝石：按同样顺序入槽，
      // 装不下的全额折算碎屑返还。迁移后所有装备剥离 lv / gems 字段。
      if (data && !data.enh) {
        for (const s of SLOTS) {
          let best = state.equipped[s.key] ? (state.equipped[s.key].lv || 0) : 0;
          for (const it of state.bag) {
            if (it.slot === s.key && (it.lv || 0) > best) best = it.lv || 0;
          }
          if (state.museum && state.museum[s.key] && (state.museum[s.key].lv || 0) > best) {
            best = state.museum[s.key].lv || 0;
          }
          state.enh[s.key] = Math.max(0, Math.min(MAX_ENHANCE, Math.floor(best) || 0));
        }
        let movedGems = 0;
        let overflowGems = 0;
        let refundDust = 0;
        const gemsOf = (it) => (it && Array.isArray(it.gems)) ? it.gems.slice(0, 12) : [];
        for (const s of SLOTS) {
          const arr = slotGemList(s.key);
          const sources = [];
          sources.push(...gemsOf(state.equipped[s.key]));
          for (const it of state.bag) {
            if (it.slot === s.key) sources.push(...gemsOf(it));
          }
          if (state.museum && state.museum[s.key]) sources.push(...gemsOf(state.museum[s.key]));
          for (const g of sources) {
            if (!g || !affixDef(g.k)) continue;
            const t = Math.max(1, Math.min(GEM_TIERS.length, g.t | 0));
            const idx = arr.indexOf(null);
            if (idx < 0) {
              overflowGems++;
              // 一次性迁移退款：装不下的宝石按首孔价退（新阶梯价下最保守口径）
              refundDust += gemCost(g.k, t);
              continue;
            }
            arr[idx] = { k: g.k, t };
            movedGems++;
          }
        }
        if (refundDust > 0) {
          state.dust += refundDust;
          state.dustTotal = (state.dustTotal || 0) + refundDust;
        }
        if (movedGems || overflowGems) {
          pushLog('装备部位化：宝石入槽 ' + movedGems + ' 颗' +
            (overflowGems ? '，' + overflowGems + ' 颗放不下折算 ' + refundDust + ' 碎屑' : ''), 'sys');
        }
      }
      // 所有档统一：装备剥离 lv / gems（部位化后装备不再携带）
      const stripSlotFields = (it) => {
        delete it.lv;
        delete it.gems;
      };
      for (const it of state.bag) stripSlotFields(it);
      for (const s of SLOTS) {
        if (state.equipped[s.key]) stripSlotFields(state.equipped[s.key]);
        if (state.museum && state.museum[s.key]) stripSlotFields(state.museum[s.key]);
      }
      for (const s of SLOTS) {
        state.enh[s.key] = Math.max(0, Math.min(MAX_ENHANCE, Math.floor(state.enh[s.key]) || 0));
      }
      sanitizeSlotGems();
      // —— 反作弊自洽校验（软修正）——
      if (data && data.dustTotal === undefined) state.dustTotal = fixInt(state.dust, 0, 1e15);
      state.dustTotal = fixInt(state.dustTotal, 0, 1e15);
      state.opens = fixInt(state.opens, 0, 1e15);
      if (!Number.isFinite(state.totalStones) || state.totalStones < 0) state.totalStones = 0;
      state.totalStones = Math.min(state.totalStones, 1e18); //与服务端校验同口径的量级天花板
      if (!Number.isFinite(state.stones)) state.stones = 0;
      // 赌狗签到可倒扣负债：灵石允许为负（下限 -1e12，与服务端校验同口径），
      // 但仍不可能超过历史总收益
      state.stones = Math.max(-1e12, Math.min(state.stones, state.totalStones));
      state.ascensions = fixInt(state.ascensions, 0, 1e6);
      state.exp = fixInt(state.exp, 0, realmCostOf(REALM_COSTS.length - 1) * 10); // 修为只需覆盖最高突破门槛（含轮回系数）
      state.buffUntil = isFinite(state.buffUntil)
        ? Math.min(Number(state.buffUntil), Date.now() + BUFF_MS)
        : 0;
      const counted = state.counts.reduce((a, b) => a + b, 0);
      if (counted > state.opens) {
        const scale = state.opens > 0 ? state.opens / counted : 0;
        state.counts = state.counts.map((n) => Math.floor(n * scale));
      }
      state.trialWins = fixInt(state.trialWins, 0, 1e9);
      state.rushS = fixInt(state.rushS, 0, 1e9);
      if (!Array.isArray(state.signMilestones)) state.signMilestones = [];
      state.signMilestones = state.signMilestones.filter((d) => SIGN_MILESTONES[d]);
      if (!state.weekly || typeof state.weekly !== 'object' || Array.isArray(state.weekly)) {
        state.weekly = { week: '', opens: 0, wins: 0, rogue: 0, claimed: [] };
      }
      state.weekly = {
        week: typeof state.weekly.week === 'string' ? state.weekly.week : '',
        opens: fixInt(state.weekly.opens, 0, 1e9),
        wins: fixInt(state.weekly.wins, 0, 1e9),
        rogue: fixInt(state.weekly.rogue, 0, 1e9),
        claimed: Array.isArray(state.weekly.claimed)
          ? state.weekly.claimed.filter((id) => WEEKLY_TASKS.some((t) => t.id === id))
          : [],
      };
      // —— 第三批（共鸣 / 道童 / 升星 / 炼器 / 镜像 / 秘境图 / 修行 / 陈列 / 灵田 / 天道录）——
      if (!state.steward || typeof state.steward !== 'object' || Array.isArray(state.steward)) {
        state.steward = { autoWear: false, autoSalvage: 0, autoMarket: [] };
      }
      state.steward = {
        autoWear: !!state.steward.autoWear,
        autoSalvage: fixInt(state.steward.autoSalvage, 0, 2),
        autoMarket: Array.isArray(state.steward.autoMarket)
          ? state.steward.autoMarket.filter((id) => MARKET_POOL.some((p) => p.id === id))
          : [],
      };
      state.souls = fixInt(state.souls, 0, 1e9);
      // —— 第九批（灵潮 / 朝贺 / 问答 / 异象 / 灵气 / 占卜 / 互助）——
      if (!state.tide || typeof state.tide !== 'object' || Array.isArray(state.tide)) {
        state.tide = { date: '', claimed: [false, false] };
      }
      state.tide = {
        date: typeof state.tide.date === 'string' ? state.tide.date : '',
        claimed: Array.isArray(state.tide.claimed)
          ? [0, 1].map((i) => !!state.tide.claimed[i])
          : [false, false],
      };
      if (!state.month || typeof state.month !== 'object' || Array.isArray(state.month)) {
        state.month = { key: '', days: [], makeup: 0, claimed: [] };
      }
      state.month = {
        key: typeof state.month.key === 'string' ? state.month.key : '',
        days: Array.isArray(state.month.days)
          ? state.month.days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(-40)
          : [],
        makeup: fixInt(state.month.makeup, 0, MONTH_MAKEUP_MAX),
        claimed: Array.isArray(state.month.claimed)
          ? state.month.claimed.filter((n) => MONTH_MILESTONES.some((m) => m.n === n))
          : [],
      };
      if (!state.quiz || typeof state.quiz !== 'object' || Array.isArray(state.quiz)) {
        state.quiz = { date: '', idx: 0, correct: 0, done: false, streak: 0 };
      }
      state.quiz = {
        date: typeof state.quiz.date === 'string' ? state.quiz.date : '',
        idx: fixInt(state.quiz.idx, 0, QUIZ_N),
        correct: fixInt(state.quiz.correct, 0, QUIZ_N),
        done: !!state.quiz.done,
        streak: fixInt(state.quiz.streak, 0, 366),
      };
      if (!state.anomaly || typeof state.anomaly !== 'object' || Array.isArray(state.anomaly)) {
        state.anomaly = { date: '', done: false, grade: '', sDays: [], bonusMonth: '' };
      }
      state.anomaly = {
        date: typeof state.anomaly.date === 'string' ? state.anomaly.date : '',
        done: !!state.anomaly.done,
        grade: ['S', 'A', 'B'].includes(state.anomaly.grade) ? state.anomaly.grade : '',
        sDays: Array.isArray(state.anomaly.sDays)
          ? state.anomaly.sDays.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(-40)
          : [],
        bonusMonth: typeof state.anomaly.bonusMonth === 'string' ? state.anomaly.bonusMonth : '',
      };
      if (!state.vigor || typeof state.vigor !== 'object' || Array.isArray(state.vigor)) {
        state.vigor = { date: '', minutes: 0, claimed: 0, lastMs: 0 };
      }
      state.vigor = {
        date: typeof state.vigor.date === 'string' ? state.vigor.date : '',
        minutes: fixInt(state.vigor.minutes, 0, VIGOR_CELL_MIN * VIGOR_CELL_N),
        claimed: fixInt(state.vigor.claimed, 0, VIGOR_CELL_N),
        lastMs: fixInt(state.vigor.lastMs, 0, Date.now() + 86400000),
      };
      if (!state.fortune || typeof state.fortune !== 'object' || Array.isArray(state.fortune)) {
        state.fortune = { date: '', idx: -1, claimed: false };
      }
      state.fortune = {
        date: typeof state.fortune.date === 'string' ? state.fortune.date : '',
        idx: state.fortune.idx >= 0 && state.fortune.idx < FORTUNE_SIGNS.length ? state.fortune.idx : -1,
        claimed: !!state.fortune.claimed,
      };
      if (!state.mirror || typeof state.mirror !== 'object' || Array.isArray(state.mirror)) {
        state.mirror = { week: '', snap: null, claimed: false };
      }
      state.mirror = {
        week: typeof state.mirror.week === 'string' ? state.mirror.week : '',
        snap: (state.mirror.snap && typeof state.mirror.snap === 'object' &&
          isFinite(state.mirror.snap.atk) && isFinite(state.mirror.snap.hp))
          ? {
            power: fixInt(state.mirror.snap.power, 1, 1e15),
            atk: fixInt(state.mirror.snap.atk, 1, 1e15),
            hp: fixInt(state.mirror.snap.hp, 1, 1e15),
            def: fixInt(state.mirror.snap.def, 0, 1e15),
          }
          : null,
        claimed: !!state.mirror.claimed,
      };
      if (!state.map || typeof state.map !== 'object' || Array.isArray(state.map)) {
        state.map = null;
      } else {
        const m = state.map;
        state.map = {
          seed: fixInt(m.seed, 0, 1e9),
          px: fixInt(m.px, 0, MAP_W - 1),
          py: fixInt(m.py, 0, MAP_H - 1),
          rev: Array.isArray(m.rev) ? m.rev.map((i) => fixInt(i, 0, MAP_W * MAP_H - 1)) : [],
          looted: Array.isArray(m.looted) ? m.looted.map((i) => fixInt(i, 0, MAP_W * MAP_H - 1)) : [],
          ap: fixInt(m.ap, 0, MAP_AP_MAX + MAP_BUY_MAX),
          buys: fixInt(m.buys, 0, MAP_BUY_MAX),
          buyDay: typeof m.buyDay === 'string' ? m.buyDay : '',
          date: typeof m.date === 'string' ? m.date : '',
        };
        state.map.rev = Array.from(new Set(state.map.rev));
        state.map.looted = Array.from(new Set(state.map.looted));
        // 拾取必发生在进入格子之后，而进入必探开：looted 是 rev 的子集
        const revSet = new Set(state.map.rev);
        state.map.looted = state.map.looted.filter((i) => revSet.has(i));
      }
      if (!state.ordeal || typeof state.ordeal !== 'object' || Array.isArray(state.ordeal)) {
        state.ordeal = { active: '', dirty: false };
      }
      state.ordeal = {
        active: ORDEALS.some((o) => o.id === state.ordeal.active) ? state.ordeal.active : '',
        dirty: !!state.ordeal.dirty,
      };
      if (!Array.isArray(state.ordealDone)) state.ordealDone = [];
      state.ordealDone = Array.from(new Set(state.ordealDone.filter((id) => ORDEALS.some((o) => o.id === id))));
      if (!state.museum || typeof state.museum !== 'object' || Array.isArray(state.museum)) {
        state.museum = emptyEquipped();
      }
      for (const s of SLOTS) {
        const it = state.museum[s.key];
        state.museum[s.key] = (it && it.slot === s.key && isFinite(it.power) && RARITIES[it.r]) ? it : null;
      }
      if (!state.farm || typeof state.farm !== 'object' || Array.isArray(state.farm) ||
        !Array.isArray(state.farm.plots)) {
        state.farm = { plots: [null, null, null] };
      }
      const farmMsMax = Math.max(...FARM_SEEDS.map((sd) => sd.ms));
      state.farm.plots = state.farm.plots.slice(0, FARM_PLOTS).map((p) =>
        p && FARM_SEEDS.some((sd) => sd.id === p.id) && isFinite(p.doneAt)
          ? { id: p.id, doneAt: Math.min(Number(p.doneAt), Date.now() + farmMsMax) }
          : null);
      while (state.farm.plots.length < FARM_PLOTS) state.farm.plots.push(null);
      if (!Array.isArray(state.chapters)) state.chapters = [];
      state.chapters = Array.from(new Set(state.chapters.map((n) => fixInt(n, 0, CHAPTERS.length - 1))));
      // —— 第四批（融合 / 符文 / 心魔 / 悬赏 / 时辰 / 天劫 / 道侣 / 战功碑）——
      if (!state.innerDemon || typeof state.innerDemon !== 'object' ||
        !isFinite(state.innerDemon.atk) || !isFinite(state.innerDemon.hp)) {
        state.innerDemon = null;
      } else {
        state.innerDemon = {
          atk: fixInt(state.innerDemon.atk, 1, 1e15),
          hp: fixInt(state.innerDemon.hp, 1, 1e15),
          def: fixInt(state.innerDemon.def, 0, 1e15),
          kills: fixInt(state.innerDemon.kills, 0, 1e9),
        };
      }
      if (!state.bounty || typeof state.bounty !== 'object' || Array.isArray(state.bounty)) {
        state.bounty = { date: '', slots: [], rerolls: 0, allClaimed: false };
      }
      // 悬赏换档（2026-10-30）：slots 带 tier；老档 rerolled 布尔折算为已用 1 次刷新
      state.bounty = {
        date: typeof state.bounty.date === 'string' ? state.bounty.date : '',
        rerolls: state.bounty.rerolled === true
          ? Math.max(0, BOUNTY_REROLL_N - 1)
          : fixInt(state.bounty.rerolls, 0, BOUNTY_REROLL_N),
        allClaimed: !!state.bounty.allClaimed,
        slots: Array.isArray(state.bounty.slots)
          ? state.bounty.slots
              .filter((sl) => sl && BOUNTY_MISSIONS.some((b) => b.id === sl.id) &&
                BOUNTY_TIERS.some((t) => t.key === sl.tier))
              .map((sl) => ({
                id: sl.id,
                tier: sl.tier,
                target: fixInt(sl.target, 1, 1e9),
                prog: fixInt(sl.prog, 0, 1e9),
                claimed: !!sl.claimed,
              }))
          : [],
      };
      state.talismans = fixInt(state.talismans, 0, 99);
      // —— 故事模式「红尘录」——
      if (!state.story || typeof state.story !== 'object' || Array.isArray(state.story)) {
        state.story = { cleared: [], met: [] };
      }
      state.story.cleared = Array.isArray(state.story.cleared)
        ? Array.from(new Set(state.story.cleared.map((n) => fixInt(n, 0, STORY_TOTAL - 1))))
          .filter((n) => n >= 0 && n < STORY_TOTAL)
        : [];
      state.story.met = Array.isArray(state.story.met)
        ? state.story.met.filter((id) => typeof id === 'string' && !!STORY_CAST[id])
        : [];
      if (!state.tribulation || typeof state.tribulation !== 'object' || Array.isArray(state.tribulation)) {
        state.tribulation = { last: '', done: false };
      }
      state.tribulation = {
        last: typeof state.tribulation.last === 'string' ? state.tribulation.last : '',
        done: !!state.tribulation.done,
      };
      if (!state.daoLv || typeof state.daoLv !== 'object' || Array.isArray(state.daoLv)) {
        state.daoLv = { aff: {}, spend: {}, married: '' };
      }
      const aff = {};
      const affRaw = (state.daoLv.aff && typeof state.daoLv.aff === 'object' &&
        !Array.isArray(state.daoLv.aff)) ? state.daoLv.aff : {};
      for (const npc of DAO_NPCS) aff[npc.id] = fixInt(affRaw[npc.id], 0, DAO_MARRY_AT);
      // 结缘改累计礼金门槛（2026-10-31）：spend[npcId] = { stones, dust }；
      // 旧档 aff 是情谊计数无法折算回礼金，一律从 0 起算
      const spend = {};
      const spendRaw = (state.daoLv.spend && typeof state.daoLv.spend === 'object' &&
        !Array.isArray(state.daoLv.spend)) ? state.daoLv.spend : {};
      for (const npc of DAO_NPCS) {
        const s = (spendRaw[npc.id] && typeof spendRaw[npc.id] === 'object' &&
          !Array.isArray(spendRaw[npc.id])) ? spendRaw[npc.id] : {};
        spend[npc.id] = {
          stones: fixInt(s.stones, 0, 1e15),
          dust: fixInt(s.dust, 0, 1e15),
        };
      }
      // 结缘进度一次性清零（2026-10-31 三次调整）：灵石礼单价调至 5000 万后旧累计口径作废，
      // 全员从 0 重新攒；已结缘（married）不受影响。wiped 标记随档持久防反复清零
      //（服务端原样存 JSON，未知字段不剥离）
      if (state.daoLv.wiped !== '20261031') {
        for (const k of Object.keys(spend)) spend[k] = { stones: 0, dust: 0 };
      }
      state.daoLv = {
        aff,
        spend,
        married: DAO_NPCS.some((n) => n.id === state.daoLv.married) ? state.daoLv.married : '',
        wiped: '20261031',
      };
      if (!state.battleStats || typeof state.battleStats !== 'object' || Array.isArray(state.battleStats)) {
        state.battleStats = { dmg: 0, taken: 0, wins: 0 };
      }
      state.battleStats = {
        dmg: fixInt(state.battleStats.dmg, 0, 1e18),
        taken: fixInt(state.battleStats.taken, 0, 1e18),
        wins: fixInt(state.battleStats.wins, 0, 1e9),
      };

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

      state.fontScale = Math.max(0.85, Math.min(1.25, Number(state.fontScale) || 1));
      // 默认亮色（2026-10-31）：themeSet 标记是否主动选过主题——从未选过的老档
      // 一次性翻到亮色，主动选了「暗」的保留其选择
      state.themeSet = !!state.themeSet;
      state.theme = state.themeSet ? (state.theme === 'light' ? 'light' : 'dark') : 'light';
      state.bagTokens = fixInt(state.bagTokens, 0, 99);
      state.bagExtra = fixInt(state.bagExtra, 0, BAG_EXTRA_MAX);
      state.power = Math.max(0, Math.floor(Number(state.power) || 0));
      state.pvpSnap = sanitizePvpSnap(state.pvpSnap);
      if (!state.boss || typeof state.boss !== 'object' || Array.isArray(state.boss)) {
        state.boss = { claimed: '' };
      }
      state.boss.claimed = typeof state.boss.claimed === 'string' ? state.boss.claimed : '';
      if (!state.guildBoss || typeof state.guildBoss !== 'object' || Array.isArray(state.guildBoss)) {
        state.guildBoss = { claimed: '' };
      }
      state.guildBoss.claimed = typeof state.guildBoss.claimed === 'string' ? state.guildBoss.claimed : '';
    } catch (e) {
      state = defaults();
      throw e; // 云端唯一存档层：档损坏必须拦下启动（cloudRestore 统一提示），不能拿空白档开局
    }
  }

  // 竞技场快照口径（与服务端钳制一致）：数值有限且不越界，脏档一律弃用
  function sanitizePvpSnap(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const num = (v, lo, hi) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
    };
    const atk = num(raw.atk, 1, 1e15);
    const hp = num(raw.hp, 1, 1e15);
    const def = num(raw.def, 0, 1e15);
    if (atk === null || hp === null || def === null) return null;
    return {
      atk, hp, def,
      crit: num(raw.crit, 0, 0.6) ?? 0.1,
      critMult: num(raw.critMult, 1, 10) ?? 2,
      lifesteal: num(raw.lifesteal, 0, 0.5) ?? 0,
      dr: num(raw.dr, 0, 0.6) ?? 0,
      pierce: num(raw.pierce, 0, 1) ?? 0,
    };
  }

  /* ---------------- 数值 ---------------- */

  const realmMult = () => Math.pow(1.7, state.realm);
  const prestigeMult = () => 1 + 0.05 * state.ascensions; // 飞升永久收益 +5%/次（2026-11-01 用户指定，原 +25%）
  const buffOn = () => Date.now() < state.buffUntil;
  const buffMult = () => (buffOn() ? 2 : 1);

  // 开箱节奏（2026-11-01 用户指定）：起始 2.5s/次，×0.95/级，满级 50 触底 0.2s/次
  // （2.5×0.95^50≈0.192 被下限 0.2 封住）；原 2s×0.94^60→0.05s 太快，服务端连点
  // 判定与增速包络的 20 次/秒假设同步放宽，只慢不快无需调包络
  const interval = () => Math.max(0.2, 2.5 * Math.pow(0.95, state.speedLv));

  // 装备战力（2026-10-31 部位化）：只含装备自身（基础战力 × 升星），强化改绑部位
  function itemPower(it) {
    return Math.round(it.power * (1 + 0.1 * (it.star || 0)));
  }

  function totalPower() {
    let p = 0;
    for (const s of SLOTS) {
      const it = state.equipped[s.key];
      // 部位强化（永久）：乘区挂穿戴件基础上，换装不丢
      if (it) p += itemPower(it) * (1 + 0.18 * (state.enh[s.key] || 0));
    }
    return Math.round(p);
  }

  // 战力收益系数：开平方软压（1 + √战力/20），战力线性放大灵石收益会让固定数值的
  // 各类灵石奖励沦为零头；早期（战力千级）系数近乎不变，后期大幅收敛
  const powerMult = () => 1 + Math.sqrt(Math.max(0, totalPower())) / 20;

  const todayStr = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  };

  function ensureDaily() {
    const today = todayStr();
    if (state.daily && state.daily.date === today) return;
    state.daily = {
      date: today, opens: 0, wins: 0, forge: 0, claimed: [],
      sweep: emptyDailySweep(), sweepBought: emptyDailySweep(), wildRepeat: 0, gamble: 0,
    };
  }

  const weekKey = () => {
    const d = new Date();
    return d.getFullYear() + '-W' + Math.floor((d - new Date(d.getFullYear(), 0, 1)) / (7 * 86400000));
  };

  function ensureWeekly() {
    const wk = weekKey();
    if (state.weekly && state.weekly.week === wk) return;
    state.weekly = { week: wk, opens: 0, wins: 0, rogue: 0, claimed: [] };
  }

  const collectCount = (key) =>
    (state.setCollection && state.setCollection[key]) ? state.setCollection[key].length : 0;

  // 套装图鉴收集加成（与战斗内套装效果独立）：2 件收益 +10%、4 件攻血 +8%、6 件收益再 +25%
  function collectionBonus() {
    let gain = 0;
    let combat = 0;
    for (const key of Object.keys(SETS)) {
      const n = collectCount(key);
      if (n >= 2) gain += 0.10;
      if (n >= 4) combat += 0.08;
      if (n >= 6) gain += 0.25;
    }
    return { gain, combat };
  }

  function activePetDefs() {
    return (state.activePets || [])
      .map((id) => PETS.find((p) => p.id === id))
      .filter((p) => p && state.pets[p.id] !== undefined);
  }
  const petBonus = (stat) => activePetDefs().reduce((sum, p) =>
    sum + (p.stat === stat
      ? p.per * state.pets[p.id] + 0.005 * (state.petTokens[p.id] || 0)
      : 0), 0);

  const caveGainBonus = () => 0.08 * state.cave.array;
  const expMult = () => (1 + 0.10 * state.cave.library) * (1 + 0.05 * state.gongfa.hui);
  const critChance = () => Math.min(0.5, CRIT_CHANCE + 0.004 * state.cave.garden +
    (shichenIs('crit') ? shichenNow().crit : 0) + skyVal('crit') + coreBonus('crit'));
  const elixirOn = (id) => state.elixir.id === id && Date.now() < state.elixir.until;

  const baseGain = () => (3 + 0.9 * state.gainLv) * realmMult() * prestigeMult() * powerMult()
    * (1 + collectionBonus().gain + petBonus('gain') + caveGainBonus())
    * (1 + 0.1 * (state.immortal || 0)) // 仙位收益 +10%/位（2026-11-01 用户指定，原 +50%）
    * (state.title ? 1.02 : 1)
    * (1 + museumBonus() + (state.ordealDone.includes('fanYi') ? 0.10 : 0))
    * (1 + (shichenNow().gain || 0) + skyVal('gain') + daoBonus('gain'))
    * (1 + 0.005 * guildBuffLevel()) // 仙盟等级加成（天下页缓存，每级 +0.5%，2026-11-01 由 +2% 下调）
    * (elixirOn('gain') ? 1.3 : 1);
  // 部位强化费用（2026-10-31 部位化）：强化绑部位永久生效，费用只与等级相关——
  // 若按穿戴装备计价，可穿低品刷满强化再换高品白拿；5000×1.5^lv 介于天品/仙品旧曲线之间
  const enhanceCost = (lv) => Math.floor(5000 * Math.pow(1.5, lv || 0));
  const salvageValue = (it) => it.special
    ? Math.floor(it.power * 2 + 20)
    : Math.floor(RARITIES[it.r].stone * 2 * (1 + 0.2 * state.gainLv));

  function weights() {
    // 气运对高品质呈指数放大，系数过大时满级仙品占比爆炸（曾达 23.6%），压到 0.02
    const m = 1 + 0.02 * state.luckLv;
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
    // 修为期望按开箱掉装备概率折算：未掉落只有基础 1 份
    return { stone: baseGain(), exp: (1 - EQUIP_CHANCE) + EQUIP_CHANCE * exp / total };
  }

  const upgradeCost = (key) => Math.floor(UPGRADES[key].base * Math.pow(UPGRADES[key].growth, state[key + 'Lv']));

  /* ---------------- 词条 / 宝石：生成与结算 ---------------- */

  const affixDef = (k) => AFFIXES.find((a) => a.k === k);
  const fmtPct = (v) => (v * 100).toFixed(1).replace(/\.0$/, '') + '%';

  // 部位宝石孔（2026-10-31 部位化）：孔位绑部位不随装备，孔数 = 2 + 飞升数（上限 6）
  const SLOT_GEMS_MAX = 6;
  const slotSocketCount = () => Math.max(2, Math.min(SLOT_GEMS_MAX, 2 + ((state.immortal || 0) | 0)));
  // 取某槽孔位数组（不足自动补空孔；所有槽位宝石读写都走这里）
  function slotGemList(slotKey) {
    let arr = state.slotGems[slotKey];
    if (!Array.isArray(arr)) arr = state.slotGems[slotKey] = [];
    while (arr.length < slotSocketCount()) arr.push(null);
    return arr;
  }

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

  // 旧档补词条 / 校验词条与宝石结构（load 用，不做破坏性迁移）
  function sanitizeAffixes(it) {
    const count = AFFIX_COUNT[it.r] || 0;
    if (!Array.isArray(it.affixes)) it.affixes = [];
    it.affixes = it.affixes
      .filter((a) => a && affixDef(a.k) && isFinite(a.v))
      .map((a) => {
        const fixed = { k: a.k, v: Math.max(0, Math.min(0.6, Math.round(a.v * 1000) / 1000)) };
        if (a.lock) fixed.lock = true;
        return fixed;
      });
    const seen = new Set();
    it.affixes = it.affixes.filter((a) => !seen.has(a.k) && seen.add(a.k));
    while (it.affixes.length > count) it.affixes.pop();
    while (it.affixes.length < count) {
      const def = AFFIXES[Math.floor(Math.random() * AFFIXES.length)];
      if (seen.has(def.k)) continue;
      seen.add(def.k);
      it.affixes.push({ k: def.k, v: rollAffixValue(def, it.r) });
    }
  }

  // 校验六槽孔位数组（load 用）：条目合法化、长度补齐/截断至当前孔位数
  function sanitizeSlotGems() {
    for (const s of SLOTS) {
      const old = Array.isArray(state.slotGems[s.key]) ? state.slotGems[s.key] : [];
      const n = slotSocketCount();
      const fixed = [];
      for (let i = 0; i < old.length && fixed.length < n; i++) {
        const g = old[i];
        const t = (g && (g.t | 0)) || 0;
        fixed.push(g && affixDef(g.k) && t >= 1 && t <= GEM_TIERS.length ? { k: g.k, t } : null);
      }
      while (fixed.length < n) fixed.push(null);
      state.slotGems[s.key] = fixed;
    }
  }

  const gemValue = (g) => (GEM_VALUES[g.k] ? GEM_VALUES[g.k][g.t - 1] || 0 : 0);
  const gemName = (g) => GEM_TIERS[g.t - 1].name + affixDef(g.k).name + '石';
  // 宝石费用 = 品质基价 × 孔位系数（socketIdx 从 1 计；缺省按首孔价，迁移退款等旧调用沿用）
  const gemCost = (k, t, socketIdx) =>
    GEM_TIERS[t - 1].dust * (GEM_SOCKET_MULT[Math.max(1, Math.min(GEM_SOCKET_MULT.length, socketIdx || 1)) - 1] || 1);
  // 洗练费用（2026-11-01 用户指定多锁指数加价）：品质基价 × 重随次数 1.3^n × 锁定条数 2^n
  const rerollCost = (it, lockN) =>
    Math.floor(RARITIES[it.r].stone * 12 * Math.pow(1.3, it.rerolls || 0) * Math.pow(2, lockN || 0));

  // 洗练：保留全部锁定词条（多锁，2026-11-01），其余重随机（同件装备词条不重复）
  function rerollAffixes(it) {
    const count = AFFIX_COUNT[it.r] || 0;
    if (!count) return false;
    const locked = (it.affixes || []).filter((a) => a.lock && affixDef(a.k));
    const used = new Set(locked.map((a) => a.k));
    const next = locked.map((a) => ({ k: a.k, v: a.v, lock: true }));
    while (next.length < count) {
      const def = AFFIXES[Math.floor(Math.random() * AFFIXES.length)];
      if (used.has(def.k)) continue;
      used.add(def.k);
      // 善恶果报微调洗练数值：果报每点 ±1.5%（正果报偏高点，封顶同软钳 0.6）
      const v = Math.min(0.6, rollAffixValue(def, it.r) * karmaMult(0.015));
      next.push({ k: def.k, v: Math.max(0, Math.round(v * 1000) / 1000) });
    }
    it.affixes = next;
    it.rerolls = (it.rerolls || 0) + 1;
    return true;
  }

  const dustValue = (it) => it.special
    ? Math.max(10, Math.round(20 + itemPower(it) * 0.12))
    : (DUST_BY_RARITY[it.r] || 0);
  const addDust = (n) => {
    n = Math.floor(n);
    if (n <= 0) return 0;
    if (weekIs('dust')) n = Math.max(1, Math.floor(n * 1.5));
    if (shichenIs('dust')) n = Math.max(1, Math.floor(n * shichenNow().dust));
    if (skyVal('dust')) n = Math.max(1, Math.floor(n * skyVal('dust')));
    if (coreBonus('dust')) n = Math.max(1, Math.floor(n * (1 + coreBonus('dust'))));
    state.dust += n;
    state.dustTotal = (state.dustTotal || 0) + n;
    return n;
  };

  // 镶嵌：放进部位第一个空孔，费用按孔位递增；拆卸返还所在孔位费用一半（宝石绑部位，换装不丢）
  function socketGem(slotKey, k, t) {
    if (!affixDef(k)) return { ok: false, msg: '未知宝石' };
    t = Math.max(1, Math.min(GEM_TIERS.length, t | 0));
    const gems = slotGemList(slotKey);
    const dest = gems.indexOf(null);
    if (dest < 0) return { ok: false, msg: '没有空孔了' };
    const cost = gemCost(k, t, dest + 1);
    if (state.dust < cost) return { ok: false, msg: '碎屑不足' };
    state.dust -= cost;
    gems[dest] = { k, t };
    return { ok: true };
  }

  function unsocketGem(slotKey, idx) {
    const gems = state.slotGems[slotKey];
    if (!Array.isArray(gems)) return null;
    const g = gems[idx];
    if (!g) return null;
    gems[idx] = null;
    addDust(Math.floor(gemCost(g.k, g.t, idx + 1) * 0.5));
    return g;
  }

  /* ---------------- 战斗数值 ---------------- */

  // 仙位对秘境的难度/产出缩放：×1.05/位（2026-11-01 用户指定，原 1.25）——
  // 抬敌人血攻防与奖励基线（contentReq 同源），也抬套装件战力；服务端 validateItem
  // 的 IMMORTAL_STEP=1.25 上界保持更松，不会误拒真玩家档
  const immortalMult = () => Math.pow(1.05, state.immortal || 0);

  // 分段难度表：旧上限（关30/塔60/野12）内沿用原曲线，之后按尾段增长率续接到 200
  // （尾段 2026-10-30 加陡拉长周期，见 CURVE_TAIL 注）；legacy 段难度不变
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

  const contentReq = (mode, level) => {
    const cfg = MODES[mode];
    const table = REQ_TABLE[mode];
    if (!table) return cfg.reqBase * Math.pow(cfg.reqGrowth, Math.max(0, level - 1)) * immortalMult();
    const lv = Math.max(1, Math.min(STAGE_MAX, level | 0));
    return table[lv] * immortalMult();
  };

  const isBoss = (mode, level) => {
    if (mode === 'tower' || mode === 'endless') return level % 10 === 0;
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
    let affDef = null; // 无尽词缀：分支内取一次，末尾复用（原先重复计算两遍）

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

  function unlockedMode(mode) {
    if (mode === 'stage') return true;
    if (mode === 'wild') return state.stageCleared >= 3;
    if (mode === 'endless') return state.towerCleared >= ENDLESS_GATE;
    return state.stageCleared >= 5;
  }

  // 需飞升过的通用门槛：自动战斗类功能与连开十次等便利功能，轮回≥1 才解锁
  // （仅 QoL 功能门槛，不锁战斗进度——进度墙由怪的难度自然形成）
  const needAscension = () => (state.ascensions | 0) < 1;

  /* ---------------- 玩法解锁链：境界递进 ---------------- */

  // 各玩法解锁境界（下标与 REALMS 对齐）；未列出的玩法开局即开
  const FEATURE_GATES = {
    gongfa: 2, rogue: 2, wander: 2, melt: 2,
    fish: 3,
    steward: 8, // 道童：渡劫后开启
    market: 3, bossrush: 3, craft: 3,
    trials: 4, bounty: 4, pets: 4, map: 4, treasure: 4,
    cave: 5, mirror: 5, gather: 5,
    farm: 6, museum: 6,
    dao: 7,
    trib: 9,
  };

  // 解锁判定境界：当前境界与历史水位取高——飞升轮回后境界归零，但已解锁过的玩法不回锁
  const gateRealm = () => Math.max(state.realm | 0, state.realmPeak | 0);

  function featureOpen(id) {
    return (FEATURE_GATES[id] || 0) <= gateRealm();
  }

  // 修行指南：全部玩法按解锁顺序排列；无 check 的条目默认解锁（开局即启）
  const PLAY_MODES = [
    { id: 'box', name: '灵匣开箱', where: '修炼', cond: '开局即启',
      desc: '点击灵匣或等自动开箱，得装备、灵石与修为；淬炼提速提收益，空格键手动开。' },
    { id: 'stage', name: '闯关', where: '征战 · 秘境征战', cond: '开局即启',
      desc: '秘境征战的起点，逐关推进，逢 5 关有首领，首通奖励闯关套装部件。' },
    { id: 'wild', name: '野外巡猎', where: '征战 · 秘境征战', cond: '闯关通过第 3 关',
      check: () => state.stageCleared >= 3,
      desc: '两百片野外刷战利品，离线也能估算收入；自动巡猎需飞升一次后开启。' },
    { id: 'tower', name: '爬塔', where: '征战 · 秘境征战', cond: '闯关通过第 5 关',
      check: () => state.stageCleared >= 5,
      desc: '两百层镇塔秘境，逢 10 层一主，产出镇塔套装，一路通到仙境尽头。' },
    { id: 'gongfa', name: '功法', where: '修炼 · 境界', cond: '境界「金丹」',
      check: () => featureOpen('gongfa'),
      desc: '消耗修为点亮攻 / 血 / 修为三系被动，永久生效，修为花在刀刃上。' },
    { id: 'wander', name: '云游奇遇', where: '闲趣', cond: '境界「金丹」',
      check: () => featureOpen('wander'),
      desc: '行走江湖偶遇事件，善恶抉择改变果报；果报微调赌石与洗练的运气。' },
    { id: 'steward', name: '道童', where: '修炼', cond: '境界「渡劫」',
      check: () => featureOpen('steward'),
      desc: '挂机策略中枢：自动穿戴、自动分解与黑市代购，睡觉也能变强。' },
    { id: 'rogue', name: '秘境探幽', where: '征战 · 试炼', cond: '境界「金丹」',
      check: () => featureOpen('rogue'),
      desc: '连闯 200 层 roguelike，每层胜后三选一神物加持，战败整局结束，越深越肥。' },
    { id: 'market', name: '黑市 · 赌石', where: '日常', cond: '境界「元婴」',
      check: () => featureOpen('market'),
      desc: '每日三件限购商品 + 20 万灵石开璞玉（单日 500 次），是灵石的重要消化口。' },
    { id: 'fish', name: '垂钓', where: '闲趣', cond: '境界「元婴」',
      check: () => featureOpen('fish'),
      desc: '每日 5 枚鱼饵抛竿起钓，时机条停得越正鱼获越肥，灵龙鱼可化形赠宝。' },
    { id: 'bossrush', name: '首领连战', where: '征战 · 试炼', cond: '境界「元婴」',
      check: () => featureOpen('bossrush'),
      desc: '连打闯关首领，按总回合评级发奖，每日一次。' },
    { id: 'craft', name: '炼器', where: '征战 · 装备', cond: '境界「元婴」',
      check: () => featureOpen('craft'),
      desc: '分解专属件积攒器魂，定向打造指定部位的天品装备。' },
    { id: 'melt', name: '装备熔铸', where: '征战 · 装备', cond: '境界「金丹」',
      check: () => featureOpen('melt'),
      desc: '五件天品熔仙品、五件仙品熔升星（封顶 ★5），成功率 10%±5%，失败材料与手续费不退，部位随机。' },
    { id: 'trials', name: '条件试炼', where: '征战 · 试炼', cond: '境界「化神」',
      check: () => featureOpen('trials'),
      desc: '每日三项限制试炼（速杀 / 禁吸血 / 限承伤），全通额外 60 碎屑。' },
    { id: 'bounty', name: '悬赏令', where: '征战 · 试炼', cond: '境界「化神」',
      check: () => featureOpen('bounty'),
      desc: '每日白 / 绿 / 蓝 / 紫四单悬赏自动计数，0 点换榜，可刷新两次，四单全清加奖。' },
    { id: 'pets', name: '灵宠', where: '闲趣', cond: '境界「化神」',
      check: () => featureOpen('pets'),
      desc: '开箱掉招募券，喂养提亲密度，出战给全局加成；兽骨养内丹觉醒特性，双宠位与融合在后方。' },
    { id: 'map', name: '秘境图', where: '征战', cond: '境界「化神」',
      check: () => featureOpen('map'),
      desc: '每日 12 点行动力探雾开格：采矿、拾尘、斩妖、闯藏宝窟，越远越肥。' },
    { id: 'treasure', name: '藏宝图', where: '征战 · 秘境图', cond: '境界「化神」',
      check: () => featureOpen('treasure'),
      desc: '征战胜利拾残片，五片合成藏宝图；宝点落在秘境图上，挖之得厚礼。' },
    { id: 'cave', name: '洞府 · 炼丹房', where: '闲趣', cond: '境界「炼虚」',
      check: () => featureOpen('cave'),
      desc: '聚灵阵 / 药园 / 藏经阁三建筑全局加成；炼丹房耗时炼丹，产限时强化。' },
    { id: 'gather', name: '灵圃采集', where: '闲趣 · 洞府', cond: '境界「炼虚」',
      check: () => featureOpen('gather'),
      desc: '矿脉采矿石、药圃采灵药：灵药折价合丹，矿石锻器魂，扩建提升产量。' },
    { id: 'mirror', name: '斗法 · 昨日之我', where: '征战 · 试炼', cond: '境界「炼虚」',
      check: () => featureOpen('mirror'),
      desc: '每周记录属性快照，挑战上周的自己，胜了拿周奖。' },
    { id: 'endless', name: '无尽秘境', where: '征战 · 秘境征战', cond: '通关爬塔 60 层',
      check: () => state.towerCleared >= ENDLESS_GATE,
      desc: '无限层挑战，坚壁 / 狂暴 / 厚血词缀轮换，0.8% 概率掉镇塔件。' },
    { id: 'farm', name: '灵田', where: '闲趣 · 洞府', cond: '境界「合体」',
      check: () => featureOpen('farm'),
      desc: '三种灵籽按现实时间生长，下线也在长，收获得碎屑。' },
    { id: 'museum', name: '陈列室', where: '闲趣 · 图鉴', cond: '境界「合体」',
      check: () => featureOpen('museum'),
      desc: '把各部位最强装备封存陈列，换全局收益加成，穿戴不受影响。' },
    { id: 'dao', name: '道侣', where: '闲趣', cond: '境界「大乘」',
      check: () => featureOpen('dao'),
      desc: '三位 NPC 赠礼结缘：单个道侣累计灵石礼满 20 亿或碎屑礼满 500 万可结为道侣，得永久加成与一段往事。' },
    { id: 'trib', name: '天劫', where: '征战 · 试炼', cond: '境界「仙人」',
      check: () => featureOpen('trib'),
      desc: '每三日九霄神雷来袭：提前用碎屑炼护体符减伤，抗住得重奖，输了亦无损。' },
    { id: 'ascend', name: '飞升轮回', where: '修炼 · 境界', cond: '境界「仙人」· 1 亿灵石',
      check: () => state.realm >= REALMS.length - 1,
      desc: '重置灵石、境界与淬炼换取仙缘，永久收益每点 +5%，并可挑战三系修行。' },
  ];

  // 检查解锁进度：announce 为 true 时对本次新解锁播报；返回本轮是否有新解锁
  function syncFeatureUnlocks(announce) {
    let changed = false;
    for (const f of PLAY_MODES) {
      if (state.featureSeen.includes(f.id)) continue;
      if (!(f.check ? f.check() : true)) continue;
      state.featureSeen.push(f.id);
      changed = true;
      if (announce) {
        pushLog('🔔 新玩法解锁：「' + f.name + '」（' + f.cond + '）· 详见修行指南', 'special');
        guideEnqueue({
          kicker: '🔔 新玩法解锁 · ' + f.cond,
          title: f.name,
          body:
            '<p>' + esc(f.desc) + '</p>' +
            '<p class="guide-tip">入口：' + esc(f.where) + '</p>',
        });
      }
    }
    if (changed && announce) chime([659, 784, 988]);
    return changed;
  }

  // 给未解锁的面板 / 区块上锁：加锁定样式与横幅，inert 屏蔽点击与聚焦
  const LOCK_TARGETS = [
    { sel: '#gongfaSec', id: 'gongfa' },
    { sel: '.panel.steward', id: 'steward' },
    { sel: '#rogueBoxRogue', id: 'rogue' },
    { sel: '.panel.market', id: 'market' },
    { sel: '#bossBox', id: 'bossrush' },
    { sel: '#craftSec', id: 'craft' },
    { sel: '#meltSec', id: 'melt' },
    { sel: '#trialsBox', id: 'trials' },
    { sel: '#bountyBox', id: 'bounty' },
    { sel: '.panel.pets', id: 'pets' },
    { sel: '.panel.map-panel', id: 'map' },
    { sel: '#caveSec', id: 'cave' },
    { sel: '#mirrorBox', id: 'mirror' },
    { sel: '#farmSec', id: 'farm' },
    { sel: '#gatherSec', id: 'gather' },
    { sel: '#museumSec', id: 'museum' },
    { sel: '.panel.dao', id: 'dao' },
    { sel: '#tribBox', id: 'trib' },
    { sel: '.panel.wander', id: 'wander' },
    { sel: '.panel.fishing', id: 'fish' },
  ];

  function applyLocks() {
    for (const t of LOCK_TARGETS) {
      const el = document.querySelector(t.sel);
      if (!el) continue;
      const open = featureOpen(t.id);
      el.classList.toggle('locked', !open);
      el.toggleAttribute('inert', !open);
      if (!open) {
        let note = el.querySelector('.lock-note');
        if (!note) {
          note = document.createElement('p');
          note.className = 'lock-note';
          el.insertBefore(note, el.firstChild);
        }
        const def = PLAY_MODES.find((f) => f.id === t.id);
        note.textContent = '🔒 ' + (def ? def.name + ' · ' + def.cond + '解锁' : '尚未解锁');
      } else {
        const note = el.querySelector('.lock-note');
        if (note) note.remove();
      }
    }
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
    const critMult = COMBAT_CRIT_MULT;
    let lifesteal = 0;
    let dr = 0;
    let pierce = 0.015 * state.trainPierce;

    atk *= 1 + 0.12 * state.realm;
    hp *= 1 + 0.15 * state.realm;
    def *= 1 + 0.10 * state.realm;

    const ascMult = 1 + 0.08 * state.ascensions;
    atk *= ascMult;
    hp *= ascMult;

    // 词条与宝石：词条逐装备汇总；宝石绑部位（2026-10-31），不随装备离手失效
    const agg = { atk: 0, hp: 0, def: 0, crit: 0, ls: 0, pierce: 0 };
    for (const s of SLOTS) {
      const it = state.equipped[s.key];
      if (it) {
        for (const a of it.affixes || []) {
          if (agg[a.k] !== undefined) agg[a.k] += a.v || 0;
        }
      }
      for (const g of state.slotGems[s.key] || []) {
        if (g && agg[g.k] !== undefined) agg[g.k] += gemValue(g);
      }
    }
    atk *= 1 + agg.atk * GROWTH_SCALE;
    hp *= 1 + agg.hp * GROWTH_SCALE;
    def *= 1 + agg.def * GROWTH_SCALE;
    crit += agg.crit * GROWTH_SCALE;
    lifesteal += agg.ls * GROWTH_SCALE;
    pierce += agg.pierce * GROWTH_SCALE;

    // 灵宠出战加成 + 套装图鉴收集加成 + 功法 + 丹药 + 怪物图鉴
    const colB = collectionBonus();
    atk *= 1 + (petBonus('atk') + 0.02 * state.gongfa.atk) * GROWTH_SCALE + colB.combat;
    hp *= 1 + (petBonus('hp') + 0.02 * state.gongfa.hp) * GROWTH_SCALE + colB.combat;
    crit += petBonus('crit') * GROWTH_SCALE;
    // 出战灵宠内丹特性
    atk *= 1 + coreBonus('atk') * GROWTH_SCALE;
    hp *= 1 + coreBonus('hp') * GROWTH_SCALE;
    crit += coreBonus('crit') * GROWTH_SCALE;
    dr += coreBonus('dr') * GROWTH_SCALE;
    pierce += coreBonus('pierce') * GROWTH_SCALE;
    def *= elixirOn('def') ? 1.2 : 1;
    atk *= elixirOn('atk') ? 1.15 : 1;
    const species = Object.keys(state.bestiary).length;
    if (species >= 5) {
      const beastMult = 1 + 0.005 * Math.floor(species / 5);
      atk *= beastMult;
      hp *= beastMult;
    }

    // 词条共鸣：同词条 3/5 条触发
    const res = resonanceInfo();
    atk *= 1 + (res.bonus.atk ? res.bonus.atk.pct : 0);
    hp *= 1 + (res.bonus.hp ? res.bonus.hp.pct : 0);
    def *= 1 + (res.bonus.def ? res.bonus.def.pct : 0);
    crit += res.bonus.crit ? res.bonus.crit.flat : 0;
    lifesteal += res.bonus.ls ? res.bonus.ls.flat : 0;
    pierce += res.bonus.pierce ? res.bonus.pierce.flat : 0;

    // 挑战修行永久乘区
    let ordealAtk = 0;
    let ordealHp = 0;
    if (state.ordealDone.includes('wuJiang')) { ordealAtk += 0.06; ordealHp += 0.06; }
    if (state.ordealDone.includes('kuXing')) ordealAtk += 0.06;
    atk *= 1 + ordealAtk;
    hp *= 1 + ordealHp;

    // 符文组词 + 时辰 + 道侣
    let rune = { atk: 0, hp: 0, def: 0, dr: 0, crit: 0, ls: 0, pierce: 0 };
    for (const s of SLOTS) {
      const w = runewordOf(state.slotGems[s.key]);
      if (w) for (const k of Object.keys(w.apply)) rune[k] += w.apply[k];
    }
    atk *= 1 + rune.atk;
    hp *= 1 + rune.hp;
    def *= 1 + rune.def;
    dr += rune.dr;
    crit += rune.crit;
    lifesteal += rune.ls;
    pierce += rune.pierce;
    if (shichenIs('atk')) atk *= 1.05;
    if (shichenIs('def')) def *= 1.05;
    if (shichenIs('pierce')) pierce += shichenNow().pierce;
    if (skyVal('atk')) atk *= skyVal('atk');
    if (skyVal('pierce')) pierce += skyVal('pierce');
    atk *= 1 + daoBonus('atk');
    hp *= 1 + daoBonus('hp');

    const counts = setCounts();
    const b = { atk, hp, def, crit, dr, lifesteal };
    for (const key of Object.keys(SETS)) {
      for (const bonus of SETS[key].bonuses) {
        if (counts[key] >= bonus.need) bonus.apply(b);
      }
    }

    atk = b.atk * (1 + 0.03 * GROWTH_SCALE * state.trainAtk);
    hp = b.hp * (1 + 0.03 * GROWTH_SCALE * state.trainHp);
    def = b.def;
    crit = Math.min(CRIT_CAP, b.crit);
    dr = Math.min(0.6, b.dr);
    lifesteal = Math.min(0.5, b.lifesteal);
    pierce = Math.min(0.6, pierce);

    // 破甲钳制 100%：超过只视为完全无视防御，防止战技 200 级后防御反向加伤
    return { power, atk, hp, def, crit, critMult, lifesteal, dr, pierce: Math.min(1, pierce), counts };
  }

  // 实际战力：装备分基数 × 实战综合乘区（境界/轮回/词条/宝石/灵宠/套装等，与
  // playerCombatStats 的攻击放大同源）——顶栏、角色状态、榜单上报统一按此口径；
  // 灵石收益等战力比例公式维持装备分（totalPower）不变。9e15 与服务端 safeCap 同界，
  // 防 JSON 里出现超 MAX_SAFE_INTEGER 的数把账号读取打挂
  function realPower() {
    const cs = playerCombatStats();
    const base = 16 + cs.power * 0.9;
    const mult = base > 1 ? cs.atk / base : 1;
    return Math.min(9e15, Math.round(cs.power * mult));
  }

  const recommendedPower = (mode, level) =>
    Math.ceil(contentReq(mode, level) * (isBoss(mode, level) ? 1.35 : 1) * ENEMY_DIFF * diffBoost(mode, level));

  function specialPower(mode, level) {
    // 套装件战力贬值（2026-10-30）：原 0.4/0.42/0.45 时 60 层就出 +20w，装备成了战力主通道；
    // 压到 0.16~0.18 后 60 层约 +8w，装备回归补充位，战力主通道走灵石/道具升级
    const mult = mode === 'tower' ? 0.12 : mode === 'stage' ? 0.13 : 0.14;
    const base = 20 + contentReq(mode, level) * mult;
    return Math.max(1, Math.round(base * (0.9 + Math.random() * 0.2)));
  }

  function makeSpecialItem(mode, level, slotKey) {
    const slotDef = SLOT_MAP[slotKey] || SLOTS[Math.floor(Math.random() * SLOTS.length)];
    const set = SETS[mode];
    // 兜底命名：套装件名必须为字符串（服务端 validateItem 拒收非字符串名，整档 400）
    const pieceName = set.pieces[slotDef.key] || (set.name + '·' + slotDef.name);
    return {
      id: state.itemSeq++,
      r: 5,
      slot: slotDef.key,
      name: pieceName,
      power: specialPower(mode, level),
      el: randEl(),
      affixes: rollAffixes(5),
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

  // 五行克制：顺（我方克敌）每件 +3% 攻，逆每件 -2%，下限 ×0.9
  function elementBonus(enemyEl) {
    let fav = 0;
    let adv = 0;
    if (enemyEl && ELEMENT_BEATS[enemyEl]) {
      for (const s of SLOTS) {
        const it = state.equipped[s.key];
        if (!it || !it.el) continue;
        if (ELEMENT_BEATS[it.el] === enemyEl) fav++;
        else if (ELEMENT_BEATS[enemyEl] === it.el) adv++;
      }
    }
    return { fav, adv, mult: Math.max(0.9, 1 + 0.03 * fav - 0.02 * adv) };
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

  // 资源小图标：内联 SVG 徽标，跟在花费 / 收益数字后，一眼分清货币种类
  const RES_ICONS = {
    stones: '<svg class="res-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 13.5 5v6L8 14.5 2.5 11V5Z" fill="#ffd76b" stroke="#8a6a1c" stroke-width="1"/><path d="M8 1.5v13" stroke="#c9973f" stroke-width=".8" opacity=".7"/></svg>',
    exp: '<svg class="res-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="#60a5fa" stroke-width="1.4"/><path d="M8 4.5c2 1.4 2 5.6 0 7M4.8 6.2c1.8 1 4.6 1 6.4 0" fill="none" stroke="#93c5fd" stroke-width="1.1" stroke-linecap="round"/></svg>',
    dust: '<svg class="res-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5 6.5 7 3 8.5Z" fill="#c084fc"/><path d="M12.5 4 11 8.5 8.5 5.5Z" fill="#a855f7"/><path d="M7 9.5 11 11l-2 3Z" fill="#d8b4fe"/></svg>',
    souls: '<svg class="res-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5c2.8 2.6 4.5 5 4.5 7.6A4.5 4.5 0 0 1 8 14a4.5 4.5 0 0 1-4.5-4.9C3.5 6.5 5.2 4.1 8 1.5Z" fill="#7ee0a3" opacity=".85"/><circle cx="8" cy="9.4" r="1.8" fill="#0d111a" opacity=".55"/></svg>',
    petTickets: '<svg class="res-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 5.5h13v2a1.5 1.5 0 0 0 0 3v2h-13v-2a1.5 1.5 0 0 0 0-3Z" fill="#f0a35e" stroke="#a86a2c" stroke-width=".9"/><path d="M8 5.5v7" stroke="#a86a2c" stroke-width=".9" stroke-dasharray="1.2 1.2"/></svg>',
    rerollCoupon: '<svg class="res-ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="3.5" width="13" height="9" rx="1.5" fill="#f9a8d4" stroke="#b0568a" stroke-width=".9"/><path d="M5.5 8a2.6 2.6 0 0 1 4.6-1.4M10.5 8a2.6 2.6 0 0 1-4.6 1.4" fill="none" stroke="#8a3a68" stroke-width="1.1" stroke-linecap="round"/></svg>',
    talismans: '<svg class="res-ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="2" width="7" height="12" rx="1" fill="#f87171" stroke="#8a2f28" stroke-width=".9"/><path d="M8 4v8M6 6.5h4" stroke="#fff" stroke-width="1" stroke-linecap="round" opacity=".85"/></svg>',
    towerMarks: '<svg class="res-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 14V9H4l4-7.5L12 9h-2v5Z" fill="#fbbf24" stroke="#8a6a1c" stroke-width=".9"/></svg>',
    warMerits: '<svg class="res-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="6.5" r="4" fill="#60a5fa" stroke="#24476e" stroke-width=".9"/><path d="M5.5 9.5 4 14.5l4-2 4 2-1.5-5" fill="#93c5fd" stroke="#24476e" stroke-width=".9"/></svg>',
    beastBones: '<svg class="res-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13 12 4l1-2 2 1-1.5 2L4.5 13.8Z" fill="#4ade80" stroke="#1f7a42" stroke-width=".8"/><circle cx="3.6" cy="12.4" r="1.6" fill="#86efac" stroke="#1f7a42" stroke-width=".8"/></svg>',
  };
  const resIcon = (key) => RES_ICONS[key] || '';

  // 装备部位小图标：金铜色系，形状区分六部位
  const SLOT_ICONS = {
    weapon: '<svg class="slot-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 2.5 6 10l-1.2-.3L4.2 11l1.2 1.2 1.3-.6-.3-1.2 7.3-7.4Z" fill="#d8b36a" stroke="#8a6a2c" stroke-width=".8"/><path d="M5 11.5 3 13.5M2.5 11l2.5 2.5" stroke="#8a6a2c" stroke-width="1.1" stroke-linecap="round"/></svg>',
    armor: '<svg class="slot-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 2 8 4l2.5-2 3 2-1 4h-1.5v6H5v-6H3.5l-1-4Z" fill="#d8b36a" stroke="#8a6a2c" stroke-width=".8"/><path d="M8 4v10" stroke="#8a6a2c" stroke-width=".8"/></svg>',
    helm: '<svg class="slot-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12V7a5 5 0 0 1 10 0v5l-1.6-1.4L9.8 12 8 10.6 6.2 12 4.6 10.6Z" fill="#d8b36a" stroke="#8a6a2c" stroke-width=".8"/><path d="M8 3v6" stroke="#8a6a2c" stroke-width=".8"/></svg>',
    boots: '<svg class="slot-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2h4v6l4.5 2.5V14H5Z" fill="#d8b36a" stroke="#8a6a2c" stroke-width=".8"/><path d="M5 12h8.5" stroke="#8a6a2c" stroke-width="1" opacity=".7"/></svg>',
    artifact: '<svg class="slot-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="7" r="4.2" fill="#d8b36a" stroke="#8a6a2c" stroke-width=".8"/><circle cx="6.8" cy="5.8" r="1.2" fill="#fff6d8" opacity=".9"/><path d="M5.5 13.5h5M8 11.2v2.3" stroke="#8a6a2c" stroke-width="1" stroke-linecap="round"/></svg>',
    talisman: '<svg class="slot-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h6l2 2v9H4Z" fill="#e8d5a8" stroke="#8a6a2c" stroke-width=".8"/><path d="M10 2.5v2h2" fill="none" stroke="#8a6a2c" stroke-width=".8"/><path d="M6.5 6v5M9 6v5" stroke="#8a2f28" stroke-width="1" stroke-linecap="round"/></svg>',
    bracelet: '<svg class="slot-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8.5" r="4.3" fill="none" stroke="#d8b36a" stroke-width="2.2"/><circle cx="8" cy="3.4" r="1.2" fill="#fff6d8" stroke="#8a6a2c" stroke-width=".6"/></svg>',
    ring: '<svg class="slot-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="9.8" r="3.9" fill="none" stroke="#d8b36a" stroke-width="1.8"/><path d="M8 2.2 10.2 4.6 8 7 5.8 4.6Z" fill="#f0d9a8" stroke="#8a6a2c" stroke-width=".7"/></svg>',
    wrist: '<svg class="slot-ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="5" width="9" height="6.5" rx="1.6" fill="#d8b36a" stroke="#8a6a2c" stroke-width=".8"/><path d="M3.5 7.6h9M3.5 9.8h9" stroke="#8a6a2c" stroke-width=".7" opacity=".7"/></svg>',
    legs: '<svg class="slot-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2h6v5.5L9.8 14H8.5L8 9.2 7.5 14H6.2L5 7.5Z" fill="#d8b36a" stroke="#8a6a2c" stroke-width=".8"/></svg>',
    band: '<svg class="slot-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 11c0-3.8 2.2-6.2 5-6.2s5 2.4 5 6.2" fill="none" stroke="#d8b36a" stroke-width="2"/><circle cx="11.6" cy="10.6" r="1.3" fill="#f0d9a8" stroke="#8a6a2c" stroke-width=".6"/></svg>',
    wings: '<svg class="slot-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13.5C6 13 2.8 10.8 1.8 6.4c2.3.2 4 1.1 5.1 2.4C6.6 6 7.2 3.8 8 2.2c.8 1.6 1.4 3.8 1.1 6.6 1.1-1.3 2.8-2.2 5.1-2.4-1 4.4-4.2 6.6-6.2 7.1Z" fill="#d8b36a" stroke="#8a6a2c" stroke-width=".7"/></svg>',
  };
  const slotIcon = (key) => SLOT_ICONS[key] || '';

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
    // 修炼页开匣区可见时飘在匣上；否则（设置/天下等隐藏页）用全局悬浮提示，
    // 避免改显示名等操作的成败反馈渲染进隐藏标签页、用户完全看不到
    const wrap = document.querySelector('.box-wrap');
    const onStage = wrap && wrap.getClientRects().length > 0;
    const el = document.createElement('div');
    el.className = 'float-text' + (onStage ? '' : ' global-toast');
    el.textContent = text;
    el.style.color = color || '#f0d9a8';
    (onStage ? wrap : document.body).appendChild(el);
    setTimeout(() => el.remove(), 1400);
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
    const vol = isFinite(state.volume) ? Math.max(0, Math.min(1, state.volume)) : 0.6;
    if (vol <= 0) return;
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
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.06 * vol), t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    } catch (e) {
      /* 浏览器不允许自动播放时忽略 */
    }
  }

  // 连音：套装掉落 / 首领击败 / 领奖等关键事件的短琶音
  function chime(freqs, gap = 90) {
    freqs.forEach((f, i) => setTimeout(() => beep(f, 0.12), i * gap));
  }

  /* ---------------- 装备 / 背包 ---------------- */

  function makeItem(ri, slotKey) {
    const slotDef = slotKey ? SLOT_MAP[slotKey] : SLOTS[Math.floor(Math.random() * SLOTS.length)];
    const pool = ITEM_NAMES[slotDef.key][ri];
    const name = pool[Math.floor(Math.random() * pool.length)];
    const power = Math.max(1, Math.round(BASE_POWER[ri] * (0.8 + Math.random() * 0.4)));
    return {
      id: state.itemSeq++,
      r: ri,
      slot: slotDef.key,
      name,
      power,
      el: randEl(),
      affixes: rollAffixes(ri),
    };
  }

  // 部位化后装备自身评分：只看自身战力与品质（强化在部位上，不参与装备对比）
  function itemScore(it) {
    return itemPower(it) * 1000 + it.r * 10;
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
    if (weekIs('stone')) n = Math.max(1, Math.floor(n * 1.2));
    if (shichenIs('stone')) n = Math.max(1, Math.floor(n * shichenNow().stone));
    if (skyVal('stone')) n = Math.max(1, Math.floor(n * skyVal('stone')));
    if (coreBonus('stone')) n = Math.max(1, Math.floor(n * (1 + coreBonus('stone'))));
    state.stones += n;
    state.totalStones += n;
    return n;
  }

  function addItem(item) {
    bagDirty = true;

    // 道童自动分解（套装件除外）
    if (state.steward.autoSalvage > 0 && !item.setKey && item.r <= state.steward.autoSalvage) {
      const v = addStones(salvageValue(item));
      addDust(dustValue(item));
      if (item.special) addSouls(SOULS_PER_SPECIAL);
      return { kept: false, auto: true, value: v, steward: true };
    }

    if (state.bag.length < bagCap()) {
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
        addDust(dustValue(weakest));
        if (weakest.special) addSouls(SOULS_PER_SPECIAL);
        state.bag[wi] = item;
      }
    } else {
      value = addStones(salvageValue(item));
      addDust(dustValue(item));
      if (item.special) addSouls(SOULS_PER_SPECIAL);
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
    if (state.ordeal.active === 'fanYi' && item.special) {
      state.ordeal.dirty = true;
      pushLog('凡衣修行破戒：穿上了专属装备', 'sys');
    }
    state.bagWarned = false;
    bagDirty = true;
    equipDirty = true;
    combatDirty = true;

    pushLog('穿戴「' + item.name + '」，战力 ' + fmt(itemPower(item)), 'r' + item.r);
    beep(620, 0.06);
    render();
    paintBag(true);
    save();
  }

  function unequipSlot(slotKey) {
    const item = state.equipped[slotKey];
    if (!item) return;
    if (state.bag.length >= bagCap()) {
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

  // 部位强化（2026-10-31 部位化）：等级绑部位永久生效，换装不丢；入口仍需槽位有装备
  function enhanceSlot(slotKey) {
    const item = state.equipped[slotKey];
    if (!item) return;
    const lv = state.enh[slotKey] || 0;
    if (lv >= MAX_ENHANCE) {
      floatText('已强化至 +' + MAX_ENHANCE, '#9aa4b2');
      return;
    }
    const cost = enhanceCost(lv);
    if (state.stones < cost) {
      floatText('灵石不足', '#f87171');
      return;
    }
    state.stones -= cost;
    state.enh[slotKey] = lv + 1;
    equipDirty = true;
    combatDirty = true;
    pushLog(SLOT_MAP[slotKey].name + '部位强化至 +' + (lv + 1), 'sys');
    beep(780, 0.07);
    render();
    save();
  }

  function salvageItem(id, quiet) {
    const idx = state.bag.findIndex((x) => x.id === id);
    if (idx < 0) return 0;
    const item = state.bag[idx];
    const value = addStones(salvageValue(item));
    const dust = addDust(dustValue(item));
    const souls = item.special ? addSouls(SOULS_PER_SPECIAL) : 0;
    ensureBounty();
    bountyProgress('salvage', 1);
    state.bag.splice(idx, 1);
    state.bagWarned = false;
    bagDirty = true;

    if (!quiet) {
      pushLog('分解「' + item.name + '」，得 ' + fmt(value) + ' 灵石' +
        (dust ? ' · ' + fmt(dust) + ' 碎屑' : '') +
        (souls ? ' · ' + souls + ' 器魂' : ''), 'sys');
      render();
      paintBag(true);
      save();
    }
    return value;
  }

  function salvageLow() {
    const items = state.bag.filter((it) => it.r <= 2);
    if (!items.length) {
      floatText('没有凡品 / 灵品 / 玄品', '#9aa4b2');
      return;
    }
    let value = 0;
    let dust = 0;
    for (const it of items) {
      value += salvageValue(it);
      dust += dustValue(it);
    }
    const ids = new Set(items.map((it) => it.id));
    state.bag = state.bag.filter((it) => !ids.has(it.id));
    bountyProgress('salvage', items.length); // 批量分解同属手动分解，与单件口径一致
    value = addStones(value);
    dust = addDust(dust);
    state.bagWarned = false;
    bagDirty = true;
    pushLog('一键分解 ' + items.length + ' 件低品装备，得 ' + fmt(value) + ' 灵石' +
      (dust ? ' · ' + fmt(dust) + ' 碎屑' : ''), 'sys');
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
    let dust = 0;
    let souls = 0;
    for (const it of state.bag) {
      value += salvageValue(it);
      dust += dustValue(it);
      if (it.special) souls += SOULS_PER_SPECIAL;
    }
    value = addStones(value);
    dust = addDust(dust);
    addSouls(souls);
    const count = state.bag.length;
    bountyProgress('salvage', count); // 批量分解同属手动分解，与单件口径一致
    state.bag = [];
    state.bagWarned = false;
    bagDirty = true;
    pushLog('清空背包，分解 ' + count + ' 件装备，得 ' + fmt(value) + ' 灵石' +
      (dust ? ' · ' + fmt(dust) + ' 碎屑' : '') +
      (souls ? ' · ' + souls + ' 器魂' : ''), 'sys');
    beep(420, 0.1);
    render();
    paintBag(true);
    save();
  }

  function autoEquip(silent) {
    let changed = 0;
    let vowSkipped = 0; // 凡衣修行戒律跳过的「确比穿戴件强」的专属件数（用于诚实提示）

    for (const slotDef of SLOTS) {
      let best = -1;
      for (let i = 0; i < state.bag.length; i++) {
        if (state.bag[i].slot !== slotDef.key) continue;
        // 凡衣修行期间自动穿戴不碰专属件：破戒是玩家的显式选择（手动穿仍照常判破戒），
        // 不能让道童/一键穿戴替玩家默默破戒
        if (state.ordeal.active === 'fanYi' && state.bag[i].special) {
          if (itemScore(state.bag[i]) > itemScore(state.equipped[slotDef.key] || { power: -1, r: -1 })) vowSkipped++;
          continue;
        }
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
      if (!silent) {
        floatText(vowSkipped ? '凡衣修行中：更强的专属件不自动穿（手动穿戴会破戒）' : '没有更强的装备', '#9aa4b2');
      }
      return 0;
    }

    state.bagWarned = false;
    bagDirty = true;
    equipDirty = true;
    combatDirty = true;
    pushLog((silent ? '道童自动' : '一键') + '穿戴完成，更换 ' + changed + ' 件装备', 'sys');
    if (!silent) beep(820, 0.1);
    render();
    paintBag(true);
    save();
    return changed;
  }

  /* ---------------- 核心：开箱 ---------------- */

  function openBox(opts) {
    const silent = !!(opts && opts.silent);
    const bulk = !!(opts && opts.bulk);

    state.opens++;
    ensureDaily();
    ensureWeekly();
    ensureBounty();
    state.daily.opens++;
    state.weekly.opens++;
    bountyProgress('opens', 1);
    rollBagToken('box');

    const crit = Math.random() < critChance();
    // 装备改为概率掉落：1% 掉装备，品质在掉落内按权重另掷；未掉落只有灵石/修为基础收益
    const drop = Math.random() < EQUIP_CHANCE;
    const ri = drop ? rollRarity() : -1;
    const item = drop ? makeItem(ri) : null;
    let gain = Math.max(1, Math.floor(baseGain() * (crit ? CRIT_MULT : 1) * buffMult() * dayProdMult()));

    gain = addStones(gain); // 统一走 addStones：灵石周/时辰/天象/核心增益对主收益路径生效
    state.exp += (drop ? 1 + RARITIES[ri].exp : 1) * (1 + 0.8 * state.realm) * (1 + 0.5 * state.ascensions) * expMult();
    if (drop) {
      state.counts[ri]++;
      if (ri > state.best) state.best = ri;
      addItem(item);
    }

    let buffed = false;
    if (!buffOn() && Math.random() < BUFF_CHANCE) {
      state.buffUntil = Date.now() + BUFF_MS;
      buffed = true;
    }

    let ticket = false;
    if (Math.random() < PET_CHANCE * ((weekIs('pet') || shichenIs('pet')) ? 2 : 1) * (skyVal('pet') || 1)) {
      state.petTickets++;
      ticket = true;
    }

    // 空开补偿：未掉装备时小概率掉 1~3 碎屑（走 addDust，吃周/时辰/天象/核心加成）
    let dusted = 0;
    if (!drop && Math.random() < DUST_CHANCE) {
      dusted = addDust(1 + Math.floor(Math.random() * 3));
    }

    if (drop) {
      if (!silent || ri >= 2) {
        pushLog(
          item.name + '（' + RARITIES[ri].name + '） 战力 +' + fmt(itemPower(item)) +
          (crit ? ' · 暴击×10' : '') + ' · +' + fmt(gain) + ' 灵石',
          'r' + ri
        );
      }
    } else if (!silent) {
      pushLog((crit ? '暴击×10 · ' : '') + '+' + fmt(gain) + ' 灵石', 'sys');
    }
    if (buffed) pushLog('拾得「聚气丹」，30 秒内收益翻倍', 'buff');
    if (ticket) pushLog('拾得「灵宠招募券」，可在灵宠面板招募伙伴', 'buff');
    if (dusted) pushLog('拾得碎屑 ×' + dusted, 'buff');

    if (!silent || (drop && ri >= 4)) floatText('+' + fmt(gain), drop ? RARITIES[ri].color : '#9aa4b2');
    if (!bulk) {
      pulse();
      if (ri >= 3) burst(RARITIES[ri].color, ri >= 5 ? 18 : 10);
      if (ri >= 4) beep(ri === 5 ? 1046 : 880, 0.16);
    }

    return { ri, gain, item };
  }

  /* ---------------- 反作弊：连点器（2026-10-31 服务端判定） ---------------- */

  // 判定与封禁时长全部由服务端裁定：客户端只随档上报累计手动点击数
  //（state.clickCount，服务端 30s 滑窗累计 ≥200 ≈6.7 次/秒持续即判定点击器，
  // 封点击 5 分钟），并按响应里的 clickBanUntil 阻止开箱点击。
  let botLockUntil = 0;

  // 服务端下发的封禁落地：只在延长时提示一次，剩余时间每次点击尝试时展示
  function applyClickBan(until) {
    const t = Number(until) || 0;
    if (t <= botLockUntil) return;
    botLockUntil = t;
    floatText('检测到连点器，封点击 5 分钟', '#f87171');
    pushLog('手速异常，服务端封点击 ' + Math.ceil((t - Date.now()) / 1000) + ' 秒', 'sys');
    beep(200, 0.2);
  }

  // 返回 true 表示本次手动开箱被拦截
  function clickBlocked(now) {
    if (now < botLockUntil) {
      floatText('点击封禁中，剩 ' + Math.ceil((botLockUntil - now) / 1000) + ' 秒', '#f87171');
      return true;
    }
    return false;
  }

  function manualOpen(n) {
    // botLockUntil 是服务端 epoch 时间戳，比较与倒计时都用 Date.now() 同一口径
    if (clickBlocked(Date.now())) return;
    state.clickCount = (state.clickCount || 0) + 1;
    if (n > 1 && needAscension()) {
      floatText('飞升一次后才能连开十次', '#f87171');
      return;
    }
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
    if (n === 1) maybeAdventure();
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
    const cost = realmCostOf(state.realm + 1);
    if (state.exp < cost) return;
    state.exp -= cost;
    state.realm++;
    if (state.realm > state.realmPeak) state.realmPeak = state.realm;
    combatDirty = true;
    spawnDemon();
    pushLog('突破至「' + REALMS[state.realm] + '」', 'sys');
    syncFeatureUnlocks(true);
    burst('#d8b36a', 20);
    beep(660, 0.18);
    render();
    save();
  }

  function ascend() {
    if (state.realm < REALMS.length - 1 || state.stones < 1e8) return;
    if (!confirm('飞升会重置灵石、境界与淬炼，保留装备、背包、图鉴和仙缘。确定继续？')) return;
    if (state.ordeal.active && !state.ordeal.dirty) {
      const def = ORDEALS.find((o) => o.id === state.ordeal.active);
      state.ordealDone.push(state.ordeal.active);
      pushLog('挑战修行「' + def.name + '」功成：' + def.reward, 'special');
      chime([659, 784, 1046, 1318]);
    }
    state.ordeal.active = '';
    state.ordeal.dirty = false;
    // 仙缘固定 +1/次（2026-11-01 用户指定）：原 √(灵石/1亿) 阶梯废除，飞升次数=仙缘点数；
    // 1 亿灵石仍是发起飞升的门槛（上方 stones 判定），只是不再影响获得量
    const gain = 1;
    state.ascensions += gain;
    state.stones = 0;
    state.exp = 0;
    state.realm = 0;
    state.innerDemon = null; // 心魔随境界走：轮回重开，旧形与斩杀计数一并清空，突破后重新现形
    state.speedLv = 0;
    state.gainLv = 0;
    state.luckLv = 0;
    state.buffUntil = 0;
    combatDirty = true;
    pushLog('飞升成功，得 ' + gain + ' 点仙缘，永久收益 +' + gain * 5 + '%', 'sys');
    burst('#f0d9a8', 26);
    beep(1046, 0.22);
    paintUserChip();
    render();
    paintBag(true);
    save();
  }

  /* ---------------- 离线收益 ---------------- */

  // 离线收益（2026-11-01 全量迁移 P1）：整体上收服务端复算——时间起点
  // （ledger.offline_at）、开箱期望、巡猎胜率、体力 clamp 全在服务端，
  // 客户端调钟彻底失效；本地只应用响应并展示
  async function awardOffline() {
    let out = null;
    try {
      out = await worldFetch('/api/combat/offline', { method: 'POST', body: '{}' });
    } catch (e) {
      return; // 断网不结算（云端唯一持久层口径：服务端裁定为准）
    }
    if (!out) return;
    if (out.stamina) {
      STAMINA.v = out.stamina.stamina;
      STAMINA.cap = out.stamina.cap;
      STAMINA.nextAt = out.stamina.nextAt;
      STAMINA.syncedAt = Date.now();
      updateStaminaChip();
    }
    if (!out.settled) return;

    const elapsed = out.elapsed;
    const n = out.opens;
    const stones = out.stones;
    const exp = out.exp;
    state.stones += stones;
    state.totalStones += stones;
    state.exp += exp;
    state.opens += n;

    let huntText = '';
    let huntDrops = 0;
    if (out.hunt) {
      const h = out.hunt;
      ensureDaily();
      state.daily.wins += h.wins;
      if (h.wildKills) state.wildKills = Object.assign({}, h.wildKills); // 权威击杀计数对齐
      if (h.trophy) state.beastBones = (state.beastBones || 0) + h.trophy;
      for (const d of h.drops || []) {
        d.id = state.itemSeq++;
        grantSpecial(d);
        huntDrops++;
      }
      if (h.wins > 0) {
        huntText = '自动巡猎 <b>' + fmt(h.wins) + '</b> 胜 / ' + fmt(h.hunts) + ' 场' +
          (h.clamped ? '（体力只够 ' + fmt(h.wins) + ' 场）' : '') + '<br>' +
          '获得 <b>' + fmt(h.stones) + '</b> 灵石 · <b>' + fmt(h.trophy) + '</b> 兽骨' +
          (huntDrops ? ' · 掉落 <b>' + huntDrops + '</b> 件荒狩装备' : '');
      } else {
        huntText = '自动巡猎 <b>0</b> 胜 / ' + fmt(h.hunts) + ' 场（体力不足，未结算）';
      }
    }

    // 驻留盘点：灵田 / 灵圃 / 炼丹炉的离线进度到点只报不代收（收取仍是手动）
    const sceneNames = { stage: '闯关', wild: '野外', tower: '爬塔', endless: '无尽秘境' };
    const idleParts = [];
    if (featureOpen('farm')) {
      const ready = state.farm.plots.filter((p) => p && Date.now() >= p.doneAt).length;
      if (ready) idleParts.push('灵田 <b>' + ready + '</b> 块待收');
    }
    if (featureOpen('gather')) {
      const rdy = Object.keys(GATHER_NODES).filter((k) => {
        const u = state.gather.nodes[k].until;
        return u > 0 && Date.now() >= u;
      }).length;
      if (rdy) idleParts.push('灵圃 <b>' + rdy + '</b> 处待收');
    }
    if (state.elixir.crafting && Date.now() >= state.elixir.crafting.doneAt) {
      idleParts.push('炉中丹药<b>已炼成</b>');
    }

    if (stones > 0 || exp > 0 || huntText || idleParts.length) {
      $('offlineText').innerHTML =
        '离线 <b>' + fmtDuration(elapsed) + '</b>，驻留「' + (sceneNames[state.lastScene] || '灵匣开箱') +
        '」，自动开箱 <b>' + fmt(n) + '</b> 次<br>' +
        '获得 <b>' + fmt(stones) + '</b> 灵石 · <b>' + fmt(exp) + '</b> 修为' +
        (huntText ? '<br>' + huntText : '') +
        (idleParts.length ? '<br>' + idleParts.join(' · ') : '') +
        '<br><span class="offline-note">离线只结算灵石与修为（巡猎除外），套装里程碑需要在线首通</span>';
      $('offlineModal').classList.add('show');
      pushLog('离线收益已结算：+' + fmt(stones) + ' 灵石', 'sys');
    }
  }

  /* ---------------- 战斗结算 ---------------- */

  function currentLevel(mode) {
    if (mode === 'wild') {
      return Math.max(1, Math.min(wildMaxUnlocked(), state.wildZone || 1));
    }
    if (mode === 'endless') return state.endlessBest + 1;
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

  // 服务端生成的套装件入包（2026-11-01 全量迁移：生成在服务端，id 由调用方重编）
  function grantSpecial(item) {
    const coll = state.setCollection[item.setKey];
    let newRecord = false;
    if (coll && SETS[item.setKey].pieces[item.slot] && !coll.includes(item.slot)) {
      coll.push(item.slot);
      newRecord = true;
    }
    const result = addItem(item);
    bagDirty = true;
    pushLog(
      '秘境掉落「' + item.name + '」（' + SETS[item.setKey].name + '套装）' +
      (newRecord ? ' · 图鉴收录' : '') +
      (result.kept ? '' : ' · 背包已满，自动分解'),
      'special'
    );
    chime([660, 880, 1046]);
    return { item, result };
  }

  /* ---------------- 征战体力（2026-11-01，服务端裁定） ----------------
   * 一场战斗 1 点，每日 300 点（本地日回满），每 5 分钟恢复 1 点，上限 300。
   * 数值唯一权威在服务端（users 表三列），客户端只持最近一次同步的展示快照：
   * 每场战斗（含扫荡/复战/自动巡猎）前必须 POST 扣点成功才开打，扣不动（429）
   * 就打不了——改内存/断网都无法绕过服务端闸门。 */
  const STAMINA_REGEN_MS = 5 * 60 * 1000;
  const STAMINA = { v: 0, cap: 300, nextAt: 0, syncedAt: 0 };

  async function staminaRefresh() {
    try {
      const out = await worldFetch('/api/stamina');
      STAMINA.v = out.stamina; STAMINA.cap = out.cap; STAMINA.nextAt = out.nextAt;
      STAMINA.syncedAt = Date.now();
    } catch (e) { /* 展示快照维持旧值；下次战斗/切页回来再同步 */ }
    updateStaminaChip();
  }

  // 体力扣点已并入 /api/combat/fight 事务（2026-11-01 全量迁移 P1），
  // 独立 spend 端点保留给运维 curl；客户端只剩展示快照同步。
  // 展示插值：服务端快照 + 本地按 5 分钟/点推进（每次真实同步会矫正）
  function staminaDisplay() {
    if (!STAMINA.syncedAt) return null;
    if (STAMINA.v >= STAMINA.cap) return { v: STAMINA.cap, cap: STAMINA.cap, nextAt: 0 };
    const gained = Math.floor(Math.max(0, Date.now() - STAMINA.syncedAt) / STAMINA_REGEN_MS);
    const v = Math.min(STAMINA.cap, STAMINA.v + gained);
    const nextAt = v >= STAMINA.cap ? 0 : STAMINA.nextAt;
    return { v, cap: STAMINA.cap, nextAt };
  }

  let staminaChipText = '';
  function updateStaminaChip() {
    const el = document.getElementById('combatStamina');
    if (!el) return;
    const s = staminaDisplay();
    const text = !s ? '…'
      : s.nextAt ? s.v + ' / ' + s.cap + '（' + fmtDuration(Math.max(0, s.nextAt - Date.now())) + '）'
        : s.v + ' / ' + s.cap;
    if (text !== staminaChipText) {
      staminaChipText = text;
      el.textContent = text;
    }
  }

  async function doBattle(mode, opts) {
    const modeCfg = MODES[mode];
    if (!modeCfg || !unlockedMode(mode)) return null;
    const auto = !!(opts && opts.auto);
    // 扫荡（2026-10-31）：opts.sweepLevel 指定已通关关卡 instant 重打——
    // 一律 first=false（无首通奖励/里程碑套装/进度推进），闯关/爬塔按「再战」5 折、野外全额；
    // 野外击杀计数照常（保底套装口径不变），闯关/爬塔复战套装掉率与「再战」一致（MODE_SET_RATE）
    const sweep = !!(opts && opts.sweepLevel != null);
    if (!auto) state.autoHunt = false;
    ensureDaily();
    state.lastScene = mode; // 离线驻留场景（结算文案用）

    const now = performance.now();
    if (auto && !sweep && now < battleCooldownUntil) return null; // 扫荡免冷却：连点每击必应
    if (!auto && $('battleModal').classList.contains('show')) return;
    battleCooldownUntil = now + 450;

    // —— 服务端结算（2026-11-01 全量迁移 P1）：胜负/奖励/进度/掉落/体力全部服务端
    // 裁定，本地只留「扫荡要不要加购」的预判（服务端复核）。关卡语义（打第几关、
    // 是否首通/复战）也以服务端裁定为准，客户端不再自行推断 ——
    let sweepLevel = null;
    let needBuy = false;
    if (sweep) {
      sweepLevel = Math.floor(opts.sweepLevel);
      const clearedNow = mode === 'tower' ? state.towerCleared : state.stageCleared;
      const ok = mode === 'wild'
        ? state.wildCleared.includes(sweepLevel)
        : sweepLevel >= 1 && sweepLevel <= clearedNow;
      if (!ok) return null;
      const used = (state.daily.sweep && state.daily.sweep[mode]) || 0;
      needBuy = used >= SWEEP_DAILY_FREE;
      if (needBuy) {
        const bought = (state.daily.sweepBought && state.daily.sweepBought[mode]) || 0;
        if (bought >= SWEEP_BUY_MAX) {
          floatText('今日扫荡加购次数已用完', '#f87171');
          return null;
        }
        if (state.stones < SWEEP_BUY_COST) {
          floatText('灵石不足（加购需 ' + fmt(SWEEP_BUY_COST) + '）', '#f87171');
          return null;
        }
      }
    } else if (mode === 'wild') {
      // 本地预判野外复战额度（服务端复核；首通挑战不受限）
      const zone = state.wildZone || 1;
      if (state.wildCleared.includes(zone) && (state.daily.wildRepeat || 0) >= WILD_REPEAT_DAILY) {
        if (auto) {
          state.autoHunt = false;
          combatDirty = true;
          pushLog('已战胜怪物今日 50 次挑战额度已用完，自动巡猎停止', 'sys');
        }
        floatText('已战胜怪物每日挑战已达上限（' + WILD_REPEAT_DAILY + '/' + WILD_REPEAT_DAILY + '）', '#f87171');
        return null;
      }
    }

    let out;
    try {
      const body = sweep
        ? { mode, sweepLevel, buy: needBuy }
        : (mode === 'wild' ? { mode, level: state.wildZone || 1 } : { mode });
      out = await worldFetch('/api/combat/fight', { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      const msg = (e && e.message) || '';
      if (e && e.status === 429 && /体力不足/.test(msg)) {
        STAMINA.v = 0;
        STAMINA.nextAt = Date.now() + STAMINA_REGEN_MS;
        updateStaminaChip();
        if (auto) {
          state.autoHunt = false;
          combatDirty = true;
          pushLog('体力耗尽，自动巡猎停止（每日 300 点，每 5 分钟恢复 1 点）', 'sys');
        }
        floatText(msg, '#f87171');
      } else if (e && e.status === 429 && /挑战上限/.test(msg)) {
        if (auto) {
          state.autoHunt = false;
          combatDirty = true;
          pushLog('已战胜怪物今日 50 次挑战额度已用完，自动巡猎停止', 'sys');
        }
        floatText(msg, '#f87171');
      } else if (!auto) {
        floatText(msg || '网络异常，请稍后再战', '#f87171');
      }
      // 静默失败（auto/网络抖动）由自动巡猎心跳与玩家下次点击自然重试
      return null;
    }

    // 体力展示快照以响应为准（扣点已在服务端事务内完成）
    if (out.stamina) {
      STAMINA.v = out.stamina.stamina;
      STAMINA.cap = out.stamina.cap;
      STAMINA.nextAt = out.stamina.nextAt;
      STAMINA.syncedAt = Date.now();
      updateStaminaChip();
    }

    const enemy = out.enemy;
    const result = out.result;
    const win = !!out.win;
    const level = out.level;
    const first = !!out.first;
    const replay = !!out.replay;
    const player = playerCombatStats(); // 仅战报展示用（结算已在服务端完成）

    if (win) {
      rollBagToken('battle');
      // 灵石/修为服务端已含全部增益：平加入账，不走 addStones 二次放大
      state.stones += out.stoneGain;
      state.totalStones += out.stoneGain;
      state.exp += out.expGain;
      const tField = out.trophyField || TROPHIES[mode].field;
      state[tField] = (state[tField] || 0) + out.trophy;
      state.daily.wins++;
      ensureWeekly();
      state.weekly.wins++;
      ensureBounty();
      bountyProgress('wins', 1);
      bountyProgress('el_' + enemy.el, 1);
      state.battleStats.dmg += result.dealt;
      state.battleStats.taken += result.taken;
      state.battleStats.wins++;
      state.bestiary[enemy.base] = (state.bestiary[enemy.base] || 0) + 1;
      if (out.frag) {
        state.treasure.frags = Math.min(1e6, (state.treasure.frags || 0) + 1);
        if (state.treasure.frags % TREASURE_FRAG_COST === 0) {
          pushLog('拾得藏宝图残片，已集齐 ' + state.treasure.frags + ' 片', 'sys');
        }
      }
      // 进度以服务端账本为准（权威镜像对齐）
      if (out.progress) {
        state.towerCleared = out.progress.towerCleared;
        state.stageCleared = out.progress.stageCleared;
        state.endlessBest = out.progress.endlessBest;
        state.wildCleared = out.progress.wildCleared.slice();
        state.wildKills = Object.assign({}, out.progress.wildKills);
      }
      if (mode === 'wild' && !sweep) {
        // 战胜后自动选择下一个怪物（口径同前）：仅「挑战」胜利顺势选中刚解锁的下一区
        const nextZone = level + 1;
        if (nextZone <= wildMaxUnlocked() && nextZone !== state.wildZone) {
          state.wildZone = nextZone;
          wildGroupOpen = -1;
        }
      }
      if (mode === 'tower' || mode === 'stage') syncFeatureUnlocks(true);
      let special = null;
      if (out.special) {
        out.special.id = state.itemSeq++; // 服务端发件不带 id，入包时本地重编
        special = grantSpecial(out.special);
      }

      lastBattles[mode] = {
        mode, level, win: true, result, enemy, player,
        stoneGain: out.stoneGain, expGain: out.expGain,
        trophy: out.trophy, special, first, replay,
      };

      pushLog(
        '通关「' + enemy.name + '」 · +' + fmt(out.stoneGain) + ' 灵石 · +' +
        fmt(out.expGain) + ' 修为 · +' + out.trophy + ' ' + TROPHIES[mode].name,
        'special'
      );
      if (enemy.boss) chime([523, 659, 784, 1046]);
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

    // 权威计数镜像对齐（扫荡/野外复战每日额度以服务端为准）
    if (out.counters) {
      if (out.counters.sweepUsed != null) state.daily.sweep[mode] = out.counters.sweepUsed;
      if (out.counters.sweepBought != null) state.daily.sweepBought[mode] = out.counters.sweepBought;
      if (out.counters.wildRepeatUsed != null) state.daily.wildRepeat = out.counters.wildRepeatUsed;
    }

    combatDirty = true;
    render();
    paintBag(true);
    save();

    if (!auto) openBattleModal(lastBattles[mode]);
    return lastBattles[mode];
  }

  // 扫荡入口（2026-10-31）：当前玩法选中的已通关关卡 instant 重打一次。
  // 每日每玩法免费 10 次；用完后自动按 20 万/次加购（每日至多加购 10 次）。
  // 2026-11-01 起扫荡也是一场战斗：doBattle 内先过服务端体力闸门（1 点/场）。
  async function sweepBattle() {
    const mode = uiMode;
    if (mode !== 'stage' && mode !== 'tower' && mode !== 'wild') {
      floatText('无尽没有扫荡', '#f87171');
      return;
    }
    if (!unlockedMode(mode)) {
      floatText('尚未解锁该玩法', '#f87171');
      return;
    }
    ensureDaily();
    const used = state.daily.sweep[mode] || 0;
    const needBuy = used >= SWEEP_DAILY_FREE;
    if (needBuy) {
      const bought = state.daily.sweepBought[mode] || 0;
      if (bought >= SWEEP_BUY_MAX) {
        floatText('今日扫荡次数已用完', '#f87171');
        return;
      }
      if (state.stones < SWEEP_BUY_COST) {
        floatText('灵石不足（加购需 ' + fmt(SWEEP_BUY_COST) + '）', '#f87171');
        return;
      }
    }
    let level;
    if (mode === 'wild') {
      level = state.wildZone || 1;
      if (!state.wildCleared.includes(level)) {
        floatText('先通关本区域才能扫荡', '#f87171');
        return;
      }
    } else {
      const cleared = mode === 'tower' ? state.towerCleared : state.stageCleared;
      level = sweepPick[mode] > 0 ? Math.min(sweepPick[mode], cleared) : cleared;
      if (level < 1) {
        floatText('先通关后再扫荡', '#f87171');
        return;
      }
    }
    const res = await doBattle(mode, { auto: true, sweepLevel: level, buy: needBuy });
    if (res) {
      // 扫荡是一场真实战斗：体力/次数/加购费用在服务端事务内即扣（胜负皆耗），
      // 次数镜像已由 doBattle 按 counters 对齐；本地只需补记加购灵石消耗
      if (needBuy) {
        state.stones -= SWEEP_BUY_COST;
        pushLog('扫荡加购：-' + fmt(SWEEP_BUY_COST) + ' 灵石（今日 ' +
          (state.daily.sweepBought[mode] || 0) + '/' + SWEEP_BUY_MAX + ' 次）', 'sys');
      }
      if (res.win) {
        floatText('扫荡成功：+' + fmt(res.stoneGain) + ' 灵石 · +' + fmt(res.expGain) + ' 修为', '#f0d9a8');
      } else {
        floatText('扫荡战败（体力与扫荡次数照常消耗）', '#f87171');
      }
    }
    combatDirty = true;
    renderCombat();
    save();
  }

  function upgradeTraining(key) {
    const cfg = TRAININGS[key];
    const lv = state[cfg.lvField] || 0;
    if (lv >= MAX_TRAIN) return;
    const cost = trainCost(lv);
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

  /* ---------------- 工坊：洗练 / 宝石（部位化后：宝石走槽位，词条走穿戴件） ---------------- */

  let forgeSlot = '';
  let forgePickerOpen = false;
  let forgeMsgTimer = null;

  // 当前工坊部位的穿戴件（洗练/升星/继承用；宝石直接走 slotGems）
  function forgeTarget() {
    return forgeSlot ? (state.equipped[forgeSlot] || null) : null;
  }

  function openForge(slotKey) {
    forgeSlot = slotKey;
    forgePickerOpen = false;
    renderForge();
    $('forgeModal').classList.add('show');
  }

  function closeForge() {
    forgeSlot = '';
    forgePickerOpen = false;
    $('forgeModal').classList.remove('show');
  }

  function forgeMsg(text) {
    const el = $('forgeMsg');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(forgeMsgTimer);
    forgeMsgTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  function renderForge() {
    const it = forgeTarget();
    if (!it) {
      closeForge();
      return;
    }

    $('forgeDust').textContent = fmt(state.dust);
    $('forgeKicker').textContent =
      it.name + ' · ' + RARITIES[it.r].name +
      ' · 已洗练 ' + (it.rerolls || 0) + ' 次';

    const count = AFFIX_COUNT[it.r] || 0;
    const arr = it.affixes || [];
    const affixBox = $('forgeAffixes');
    const rc = rerollCostNow(it); // 一次算好：下面按钮文案与禁用态共用（原先连算 3 次）
    if (!count) {
      affixBox.innerHTML = '<p class="forge-empty">凡 / 灵 / 玄品装备没有词条，可镶嵌宝石。</p>';
    } else {
      affixBox.innerHTML =
        '<p class="forge-section-title">词条</p>' +
        arr.map((a, i) => {
          const def = affixDef(a.k);
          return (
            '<div class="affix-row' + (a.lock ? ' locked' : '') + '">' +
              '<span class="affix-name">' + def.name + '</span>' +
              '<b>+' + fmtPct(a.v) + '</b>' +
              '<button class="mini ghost" data-act="lock" data-idx="' + i + '">' +
                (a.lock ? '已锁' : '锁定') + '</button>' +
            '</div>'
          );
        }).join('') +
        '<div class="forge-reroll">' +
          '<button class="btn" data-act="reroll">洗练 ' + fmt(rc.cost) + resIcon('stones') +
            (rc.coupon ? '（券）' : '') + '</button>' +
          '<p>可锁多条，其余重随机<br>每锁 1 条费用 ×2 · 每次洗练 ×1.3' +
            (state.rerollCoupon ? '<br>持有半价券 ×' + state.rerollCoupon : '') + '</p>' +
        '</div>';
      const rerollBtn = affixBox.querySelector('button[data-act="reroll"]');
      if (rerollBtn) rerollBtn.disabled = state.stones < rc.cost;
    }

    // 宝石区走部位孔位（2026-10-31 部位化），与穿戴件无关
    const gems = slotGemList(forgeSlot);
    let gemHtml =
      '<p class="forge-section-title">宝石（' + gems.filter(Boolean).length + ' / ' + gems.length + '）</p>' +
      gems.map((g, i) => g
        ? '<div class="affix-row">' +
            '<span class="affix-name">' + gemName(g) + '</span>' +
            '<b>+' + fmtPct(gemValue(g)) + '</b>' +
            '<button class="mini ghost" data-act="unsocket" data-idx="' + i + '">卸下</button>' +
          '</div>'
        : '<div class="affix-row empty-socket">' +
            '<span class="affix-name">空孔</span>' +
            '<button class="mini" data-act="picker">镶嵌宝石</button>' +
          '</div>'
      ).join('');

    // 宝石三合一
    const counts = gemCounts();
    const fuses = [];
    for (const key of Object.keys(counts)) {
      const parts = key.split("_");
      const t = Number(parts[1]);
      if (counts[key] >= 3 && t < GEM_TIERS.length) {
        fuses.push({ k: parts[0], t, n: counts[key] });
      }
    }
    if (fuses.length) {
      const fuseDest = gems.indexOf(null); // 融合入孔 = 首个空孔，孔费按孔位递增
      gemHtml += '<p class="forge-section-title">宝石融合（三合一）</p>' + fuses.map((f) => {
        const fcost = fuseDest < 0 ? Infinity : gemCost(f.k, f.t + 1, fuseDest + 1);
        return '<div class="affix-row">' +
          '<span class="affix-name">' + GEM_TIERS[f.t - 1].name + affixDef(f.k).name + '石 ×' + f.n + '</span>' +
          '<b>→ ' + GEM_TIERS[f.t].name + '（' + fmt(fcost) + ' 碎屑）</b>' +
          '<button class="mini" data-act="fuse" data-k="' + f.k + '" data-t="' + f.t + '"' +
            (fuseDest >= 0 && state.dust >= fcost ? '' : ' disabled') + '>融合</button>' +
        '</div>';
      }).join('');
    }
    $('forgeGems').innerHTML = gemHtml;

    const picker = $('forgePicker');
    if (!forgePickerOpen || !gems.includes(null)) {
      picker.classList.add('hidden');
      picker.innerHTML = '';
    } else {
      picker.classList.remove('hidden');
      const destIdx = gems.indexOf(null); // 镶嵌固定落首个空孔，价格按该孔位展示
      picker.innerHTML =
        '<p class="forge-section-title">选择宝石（合成即镶嵌 · 第 ' + (destIdx + 1) + ' 孔）</p>' +
        AFFIXES.map((def) =>
          '<div class="gem-row"><span>' + def.name + '</span>' +
          GEM_TIERS.map((tier, ti) => {
            const cost = gemCost(def.k, ti + 1, destIdx + 1);
            return '<button class="mini" data-act="socket" data-k="' + def.k + '" data-t="' + (ti + 1) + '"' +
              (state.dust < cost ? ' disabled' : '') + '>' +
              tier.name + ' +' + fmtPct(GEM_VALUES[def.k][ti]) + '<br>' + fmt(cost) + resIcon('dust') +
            '</button>';
          }).join('') +
          '</div>'
        ).join('');
    }

    if (it.special && it.setKey) {
      const star = it.star || 0;
      const dups = state.bag.filter((x) => x.id !== it.id && x.setKey === it.setKey && x.slot === it.slot);
      let starHtml = '<p class="forge-section-title">升星 ★' + star + ' / 5（每星战力 +10%）</p>';
      if (star >= 5) starHtml += '<p class="forge-empty">已至五星圆满。</p>';
      else if (!dups.length) starHtml += '<p class="forge-empty">背包里没有同套同部位的重复件可吞噬。</p>';
      else {
        starHtml += dups.slice(0, 6).map((d) =>
          '<div class="affix-row"><span class="affix-name">' + esc(d.name) + '</span>' +
          '<b>战力 ' + fmt(itemPower(d)) + '</b>' +
          '<button class="mini" data-act="star" data-id="' + d.id + '">吞噬</button></div>'
        ).join('');
      }
      $('forgeStars').innerHTML = starHtml;
    } else {
      $('forgeStars').innerHTML = '';
    }

    openInherit();
    renderRunes();
  }

  function toggleForgeLock(it, idx) {
    const a = (it.affixes || [])[idx];
    if (!a) return;
    if (a.lock) {
      delete a.lock;
    } else {
      // 多锁（2026-11-01 用户指定）：条数不限价随锁涨，但至少留 1 条可洗练
      const freeN = (it.affixes || []).filter((x) => !x.lock).length;
      if (freeN <= 1) {
        forgeMsg('至少保留 1 条可洗练词条');
        return;
      }
      a.lock = true;
    }
    renderForge();
  }

  // 洗练实际费用：锁定条数 2^n 指数加价在前；持半价券自动折半并消耗一张；工坊周全局 -30%
  function rerollCostNow(it) {
    const lockN = (it.affixes || []).filter((a) => a.lock).length;
    let cost = rerollCost(it, lockN);
    if (weekIs('forge')) cost = Math.ceil(cost * 0.7);
    let coupon = false;
    if (state.rerollCoupon > 0) {
      cost = Math.ceil(cost / 2);
      coupon = true;
    }
    return { cost, coupon };
  }

  function forgeReroll(it) {
    const count = AFFIX_COUNT[it.r] || 0;
    if (!count) return;
    const { cost, coupon } = rerollCostNow(it);
    if (state.stones < cost) {
      forgeMsg('灵石不足');
      return;
    }
    if (coupon) state.rerollCoupon--;
    state.stones -= cost;
    rerollAffixes(it);
    if (state.ordeal.active === 'wuJiang') {
      state.ordeal.dirty = true;
      pushLog('无匠修行破戒：动用了洗练', 'sys');
    }
    ensureBounty();
    bountyProgress('forge', 1);
    ensureDaily();
    state.daily.forge++;
    equipDirty = true;
    combatDirty = true;
    pushLog('洗练「' + it.name + '」词条，花费 ' + fmt(cost) + ' 灵石' + (coupon ? '（半价券）' : ''), 'sys');
    beep(700, 0.08);
    renderForge();
    save();
  }

  function forgeSocket(slotKey, k, t) {
    const res = socketGem(slotKey, k, t);
    if (!res.ok) {
      forgeMsg(res.msg);
      return;
    }
    equipDirty = true;
    combatDirty = true;
    ensureDaily();
    state.daily.forge++;
    ensureBounty();
    bountyProgress('forge', 1);
    pushLog(SLOT_MAP[slotKey].name + '部位镶嵌' + gemName({ k, t }), 'sys');
    beep(760, 0.07);
    renderForge();
    save();
  }

  function forgeUnsocket(slotKey, idx) {
    const g = unsocketGem(slotKey, idx);
    if (!g) return;
    equipDirty = true;
    combatDirty = true;
    pushLog('卸下' + gemName(g) + '，返还碎屑', 'sys');
    renderForge();
    save();
  }

  /* ---------------- 第三批：道童 / 升星 / 炼器 / 赌石 / 镜像 / 秘境图 / 修行 / 陈列 / 灵田 / 天道录 ---------------- */

  const addSouls = (n) => {
    n = Math.floor(n);
    if (n <= 0) return 0;
    state.souls += n;
    return n;
  };

  // 道童：5 秒一跳的挂机策略
  let stewardAcc = 0;

  function stewardTick() {
    ensureDaily();
    ensureWeekly();
    // 道童未解锁（筑基前）不做任何自动操作；黑市代购还需黑市本身解锁（金丹）
    const stewardOn = featureOpen('steward');
    if (stewardOn && state.steward.autoWear) autoEquip(true);

    if (stewardOn && featureOpen('market') && state.steward.autoMarket.length) {
      for (const p of marketPicks()) {
        if (state.steward.autoMarket.includes(p.id) &&
          !state.market.sold.includes(p.id) && state.stones >= p.cost) {
          buyMarket(p.id);
        }
      }
    }

    // 镜像：跨周生成「上周的我」快照；空装备/坏档状态不下快照，旧坏快照自愈（重打一次，奖励极小）
    const staleSnap = !state.mirror.snap || (state.mirror.snap.power <= 1 && totalPower() > 1);
    if (featureOpen('mirror') && (state.mirror.week !== weekKey() || staleSnap)) {
      const st = playerCombatStats();
      if (st.power > 1) {
        state.mirror = {
          week: weekKey(),
          snap: { power: st.power, atk: st.atk, hp: st.hp, def: st.def },
          claimed: false,
        };
        if (state.ascensions > 0 || state.realm > 2) {
          pushLog('「昨日之我」已就位，可去试炼挑战上周的自己', 'sys');
        }
      }
    }
  }

  // 词条共鸣：统计已穿戴同词条条数
  function resonanceInfo() {
    const counts = {};
    for (const s of SLOTS) {
      const it = state.equipped[s.key];
      if (!it) continue;
      for (const a of it.affixes || []) counts[a.k] = (counts[a.k] || 0) + 1;
    }
    const bonus = {};
    for (const k of Object.keys(counts)) {
      let pct = 0;
      let flat = 0;
      for (const r of RESONANCE) {
        if (counts[k] >= r.need) { pct = r.pct; flat = r.flat; }
      }
      if (pct > 0) bonus[k] = { pct, flat, n: counts[k] };
    }
    return { counts, bonus };
  }

  // 套装升星
  function feedStar(targetId, materialId) {
    const target = state.equipped && findAnywhere(targetId);
    const material = findAnywhere(materialId);
    if (!target || !material || target === material) return;
    if (!target.special || target.setKey !== material.setKey || target.slot !== material.slot) return;
    if ((target.star || 0) >= 5) {
      floatText('已至五星', '#9aa4b2');
      return;
    }
    consumeItem(material);
    target.star = (target.star || 0) + 1;
    equipDirty = true;
    combatDirty = true;
    pushLog('「' + target.name + '」升星至 ★' + target.star, 'special');
    chime([784, 1046]);
    renderForge();
    save();
  }

  // 在背包与已穿戴里找物品；consumeItem 从所在处移除
  function findAnywhere(id) {
    for (const s of SLOTS) {
      const it = state.equipped[s.key];
      if (it && it.id === id) return it;
    }
    return state.bag.find((x) => x.id === id) || null;
  }

  function consumeItem(item) {
    const idx = state.bag.findIndex((x) => x.id === item.id);
    if (idx >= 0) {
      state.bag.splice(idx, 1);
      bagDirty = true;
      return;
    }
    for (const s of SLOTS) {
      if (state.equipped[s.key] && state.equipped[s.key].id === item.id) {
        state.equipped[s.key] = null;
        equipDirty = true;
        combatDirty = true;
        return;
      }
    }
  }

  // 炼器
  function craftItem(slotKey) {
    if (!SLOT_MAP[slotKey]) return;
    if (state.souls < CRAFT_COST.souls || state.stones < CRAFT_COST.stones) {
      floatText('器魂或灵石不足', '#f87171');
      return;
    }
    state.souls -= CRAFT_COST.souls;
    state.stones -= CRAFT_COST.stones;
    const slotDef = SLOT_MAP[slotKey];
    const pool = ITEM_NAMES[slotKey][4];
    const item = {
      id: state.itemSeq++,
      r: 4,
      slot: slotKey,
      name: pool[Math.floor(Math.random() * pool.length)] + '（器）',
      power: Math.max(1, Math.round(BASE_POWER[4] * (0.9 + Math.random() * 0.3))),
      el: randEl(),
      affixes: rollAffixes(4),
    };
    addItem(item);
    bagDirty = true;
    pushLog('炼器成功：「' + item.name + '」', 'special');
    chime([659, 784, 1046]);
    render();
    paintBag(true);
    save();
  }

  // 赌石：单次掷取（副作用入账/日志/音效都在此），返回结果文本与配色类
  function gambleOnce() {
    state.stones -= GAMBLE_COST;
    // 善恶果报微调璞玉运势：正果报两次掷取好、负果报两次掷取差——
    // 幅度有界（天品 2% → 4% / 0.04%）且负果报也永远保住天品概率，不再零化
    let roll = Math.random() * 100;
    const kv = karma();
    if (kv !== 0) {
      const roll2 = Math.random() * 100;
      roll = kv > 0 ? Math.max(roll, roll2) : Math.min(roll, roll2);
    }
    let outcome = GAMBLE_TABLE[GAMBLE_TABLE.length - 1];
    for (const g of GAMBLE_TABLE) {
      if (roll < g.p) { outcome = g; break; }
      roll -= g.p;
    }
    let resText = '';
    let resCls = '';
    // 数值随结果一并返回：连开汇总不再从文案反解析——fmt 会把灵石输出成
    // 「30万」这类带单位串，正则永远匹配不到，汇总灵石恒为 0（2026-11-01 修）
    let resStones = 0;
    let resDust = 0;
    if (outcome.type === 'none') {
      addStones(20000);
      resStones = 20000;
      resText = outcome.text + '，回手 2万 灵石';
      resCls = 'g-none';
      pushLog('赌石：' + outcome.text + '，得回手 2万 灵石', 'sys');
      beep(300, 0.1);
    } else if (outcome.type === 'dust') {
      const n = Math.floor(outcome.min + Math.random() * (outcome.max - outcome.min));
      addDust(n);
      resDust = n;
      resText = outcome.text + '，+' + n + ' 碎屑';
      resCls = 'g-dust';
      pushLog('赌石：' + outcome.text + '，+' + n + ' 碎屑', 'special');
      chime([784, 988]);
    } else if (outcome.type === 'stones') {
      const n = Math.floor(outcome.min + Math.random() * (outcome.max - outcome.min));
      addStones(n);
      resStones = n;
      resText = outcome.text + '，+' + fmt(n) + ' 灵石';
      resCls = 'g-stone';
      pushLog('赌石：' + outcome.text + '，+' + fmt(n) + ' 灵石', 'special');
      chime([784, 1046]);
    } else {
      const item = makeItem(4);
      addItem(item);
      bagDirty = true;
      resText = outcome.text + '得「' + item.name + '」（' + RARITIES[4].name + '）';
      resCls = 'g-item';
      pushLog('赌石：' + outcome.text + '得「' + item.name + '」（' + RARITIES[4].name + '）', 'special');
      floatText('璞中藏珍！「' + item.name + '」', '#ffd479');
      chime([659, 784, 1046, 1318]);
    }
    return { text: resText, cls: resCls, stones: resStones, dust: resDust };
  }

  // 弹层再开按钮的次数随上一次操作走（1 = 再开一次 / 10 = 再开十次）
  let lastGambleTimes = 1;

  function doGamble(times) {
    const n = times || 1;
    ensureDaily();
    const opened = state.daily.gamble | 0;
    const left = Math.max(0, GAMBLE_DAILY_MAX - opened);
    if (left <= 0) {
      floatText('今日璞玉已开满 ' + GAMBLE_DAILY_MAX + ' 次，明天再来', '#f87171');
      return;
    }
    if (n > left) {
      floatText('今日璞玉只剩 ' + left + ' 次（单日上限 ' + GAMBLE_DAILY_MAX + '）', '#f87171');
      return;
    }
    const cost = GAMBLE_COST * n;
    if (state.stones < cost) {
      floatText('灵石不足（需 ' + fmt(cost) + '）', '#f87171');
      return;
    }
    state.daily.gamble = opened + n;
    const results = [];
    for (let i = 0; i < n; i++) results.push(gambleOnce());
    lastGambleTimes = n;

    // 行内结果条：单开显示原文，连开显示汇总
    const el = $('gambleResult');
    el.hidden = false;
    if (n === 1) {
      el.textContent = results[0].text;
      el.className = 'gamble-result ' + results[0].cls;
    } else {
      let sumStones = 0, sumDust = 0, items = 0;
      for (const r of results) {
        sumStones += r.stones || 0;
        sumDust += r.dust || 0;
        if (r.cls === 'g-item') items++;
      }
      el.textContent = '连开 ' + n + ' 块璞玉：' +
        (sumStones ? '+' + fmt(sumStones) + ' 灵石 · ' : '') +
        (sumDust ? '+' + fmt(sumDust) + ' 碎屑 · ' : '') +
        (items ? '天品装备 ×' + items : '未得天品');
      el.className = 'gamble-result ' + (items ? 'g-item' : results[results.length - 1].cls);
    }
    void el.offsetWidth;
    el.classList.add('pop');

    // 结果弹层：逐条明细 + 汇总；再开按钮文案随本次次数
    $('gambleModalList').innerHTML = results.map((r, i) =>
      '<p class="gamble-result ' + r.cls + '">' +
      (n > 1 ? '<b>#' + (i + 1) + '</b> ' : '') + r.text + '</p>'
    ).join('');
    $('gambleModalSum').textContent = (n > 1 ? '共 ' + n + ' 块璞玉 · ' : '') +
      '消耗 ' + fmt(cost) + ' 灵石 · 当前灵石 ' + fmt(state.stones);
    $('gambleModalAgain').textContent = n > 1 ? '再开十次' : '再开一次';
    $('gambleModalAgain').dataset.times = String(n);
    $('gambleModal').classList.add('show');

    render();
    save();
  }

  /* ---------------- 云游奇遇 / 藏宝图 / 钓鱼 / 内丹 / 采集 ---------------- */

  // 最近一次奇遇的结算展示（仅内存，不入档）
  let wanderResult = null;

  // 奇遇降临：在线游玩每 25 分钟一遇，一次只挂一件
  function tickWander() {
    if (!featureOpen('wander') || state.wander.pending) return;
    if (Date.now() - state.wander.last < WANDER_COOLDOWN) return;
    const ev = WANDER_EVENTS[Math.floor(Math.random() * WANDER_EVENTS.length)];
    state.wander.pending = { id: ev.id, at: Date.now() };
    pushLog('奇遇：「' + ev.title + '」——去闲趣页看看。', 'special');
    chime([660, 880]);
    render();
    save();
  }

  // 奇遇横幅（2026-10-30）：随机事件可玩时挂页顶，点击直达闲趣页奇遇面板；
  // tickWander 触发/chooseWander 结算都会走 render()，横幅随 renderNow 同步显隐
  function renderWanderBanner() {
    const el = $('wanderBanner');
    if (!el) return;
    const show = featureOpen('wander') && !!state.wander.pending;
    el.classList.toggle('hidden', !show);
    if (show) {
      const ev = WANDER_EVENTS.find((w) => w.id === state.wander.pending.id);
      $('wanderBannerText').textContent = '✦ 奇遇降临 · ' + (ev ? ev.title : '随机事件');
    }
  }

  function chooseWander(idx) {
    const ev = state.wander.pending && WANDER_EVENTS.find((w) => w.id === state.wander.pending.id);
    if (!ev) return;
    const c = ev.choices[idx];
    if (!c) return;
    if (c.cost && state.stones < c.cost) {
      floatText('灵石不足', '#f87171');
      return;
    }
    if (c.cost) state.stones -= c.cost;
    state.wander.karma = Math.max(-10, Math.min(10, state.wander.karma + c.k));
    const parts = [];
    for (const [key, val] of Object.entries(c.fx)) {
      const n = Array.isArray(val) ? Math.floor(val[0] + Math.random() * (val[1] - val[0])) : val;
      if (key === 'stones' && n > 0) { addStones(n); parts.push('+' + fmt(n) + ' 灵石'); }
      else if (key === 'dust') { addDust(n); parts.push('+' + n + ' 碎屑'); }
      else if (key === 'exp') { state.exp += n; parts.push('+' + fmt(n) + ' 修为'); }
      else if (key === 'ticket') { state.petTickets += n; parts.push('招募券 ×' + n); }
      else if (key === 'coupon') { state.rerollCoupon += n; parts.push('洗练半价券 ×' + n); }
      else if (key === 'elixir') {
        const ed = ELIXIRS.find((x) => x.id === n);
        if (ed) {
          state.elixir.owned[n] = (state.elixir.owned[n] || 0) + 1;
          parts.push('丹药「' + ed.name + '」×1');
        }
      } else if (key === 'item') {
        const it = makeItem(4);
        addItem(it);
        bagDirty = true;
        parts.push('「' + it.name + '」（天品）');
      }
    }
    state.wander.last = Date.now();
    state.wander.pending = null;
    state.wander.done++;
    wanderResult = {
      title: ev.title,
      text: c.msg + (parts.length ? '（' + parts.join(' · ') + '）' : ''),
      k: c.k,
    };
    pushLog('奇遇「' + ev.title + '」：' + c.t +
      (c.k ? '，果报 ' + (c.k > 0 ? '+' : '') + c.k : '') +
      (parts.length ? '，' + parts.join(' · ') : ''), c.k >= 0 ? 'special' : 'sys');
    beep(c.k >= 0 ? 760 : 320, 0.09);
    render();
    save();
  }

  function renderWander() {
    const box = $('wanderList');
    if (!box || !featureOpen('wander')) return;
    const kv = karma();
    const sig = (state.wander.pending ? state.wander.pending.id : 'idle') + '|' + kv + '|' +
      (wanderResult ? wanderResult.text : '') + '|' +
      (state.wander.pending
        ? Math.floor(state.stones / 1000) // 花费型按钮的可用态随灵石变化即时刷新
        : Math.ceil((WANDER_COOLDOWN - (Date.now() - state.wander.last)) / 60000));
    if (panelSigs.wander === sig) return;
    panelSigs.wander = sig;
    let html = '<p class="hint">善恶抉择改变果报，果报微调赌石与洗练运气。当前果报：<b class="' +
      (kv > 0 ? 'k-good' : kv < 0 ? 'k-bad' : '') + '">' + (kv > 0 ? '+' : '') + kv + '</b></p>';
    const ev = state.wander.pending && WANDER_EVENTS.find((w) => w.id === state.wander.pending.id);
    if (ev) {
      html += '<div class="wander-card">' +
        '<p class="wander-title">' + ev.title + '</p>' +
        '<p class="hint">' + ev.text + '</p>' +
        ev.choices.map((c, i) =>
          '<button class="btn wide" data-wander="' + i + '"' +
          (c.cost && state.stones < c.cost ? ' disabled' : '') + '>' + c.t + '</button>').join('') +
        '</div>';
    } else if (wanderResult) {
      html += '<div class="wander-card done"><p class="hint"><b>' + wanderResult.title + '</b> · ' +
        wanderResult.text + '</p></div>';
    } else {
      const left = Math.max(0, Math.ceil((WANDER_COOLDOWN - (Date.now() - state.wander.last)) / 60000));
      html += '<p class="hint">云游途中偶有奇遇' + (left > 0 ? '（约 ' + left + ' 分钟后将遇上一件）' : '，即将遇上……') + '</p>';
    }
    box.innerHTML = html;
  }

  // —— 藏宝图 ——
  function ensureTreasureSpot() {
    if (!featureOpen('treasure') || !state.map || state.treasure.maps <= 0) {
      if (state.treasure.at >= 0 && state.treasure.maps <= 0) state.treasure.at = -1;
      return;
    }
    if (state.treasure.at >= 0 && state.map.rev.includes(state.treasure.at)) return;
    const pool = state.map.rev.filter((i) => i !== state.map.py * MAP_W + state.map.px);
    if (!pool.length) return;
    state.treasure.at = pool[Math.floor(Math.random() * pool.length)];
  }

  function synthTreasure() {
    if (state.treasure.frags < TREASURE_FRAG_COST) {
      floatText('残片不足（' + state.treasure.frags + ' / ' + TREASURE_FRAG_COST + '）', '#f87171');
      return;
    }
    if (state.treasure.maps >= 99) return;
    state.treasure.frags -= TREASURE_FRAG_COST;
    state.treasure.maps++;
    ensureTreasureSpot();
    pushLog('合成藏宝图 ×1，秘境图上浮现金光宝点', 'special');
    chime([659, 880]);
    render();
    save();
  }

  // 秘境图事件弹层（2026-10-31）：矿/尘/窟/挖宝/偶遇结算后统一弹层展示收获
  function showMapEvent(title, bodyHtml) {
    $('mapEventTitle').textContent = title;
    $('mapEventBody').innerHTML = bodyHtml;
    // data-c 颜色经 CSSOM 落地：CSP style-src 'self' 拦内联 style 属性（含偶遇 NPC 名）；
    // 明色下按 themeInk 压暗，防亮色名落在纸底弹卡上看不清（2026-11-01 修）
    $('mapEventBody').querySelectorAll('[data-c]').forEach((el) => { el.style.color = themeInk(el.dataset.c); });
    $('mapEventModal').classList.add('show');
  }
  const MAP_EVENT_FLAVOR = {
    stones: ['矿脉在锄下泛起金芒。', '石屑纷飞，露出一窝晶亮的灵石。', '这窝矿埋得深，运气不错。'],
    dust: ['碎屑堆里翻出些炼器剩料。', '拂开浮土，是一小堆可用的碎屑。', '别人看不上的零碎，攒起来也是家底。'],
    shrine: ['洞中石壁刻满旧符文，深处藏着一窖灵石。', '窟里灵气凝而不散，满地灵石发着微光。', '这是哪位散修留下的洞府遗藏。'],
    dig: ['铲子落处金光乍现。', '图上的记号分毫不差。'],
  };
  const mapFlavor = (k) => MAP_EVENT_FLAVOR[k][Math.floor(Math.random() * MAP_EVENT_FLAVOR[k].length)];
  const mapEventHtml = (gainLine, flavorKey) =>
    '<p class="map-event-line">' + gainLine + '</p>' +
    '<p class="map-event-flavor">' + mapFlavor(flavorKey) + '</p>';

  function doDigTreasure() {
    if (state.treasure.maps <= 0 || state.treasure.at < 0) return;
    state.treasure.maps--;
    state.treasure.at = -1;
    state.treasure.digs++;
    let roll = Math.random() * 100;
    let outcome = TREASURE_TABLE[TREASURE_TABLE.length - 1];
    for (const g of TREASURE_TABLE) {
      if (roll < g.p) { outcome = g; break; }
      roll -= g.p;
    }
    let text = '';
    if (outcome.type === 'stones') {
      const n = Math.floor(outcome.min + Math.random() * (outcome.max - outcome.min));
      addStones(n);
      text = outcome.text + '，+' + fmt(n) + ' 灵石';
    } else if (outcome.type === 'dust') {
      const n = Math.floor(outcome.min + Math.random() * (outcome.max - outcome.min));
      addDust(n);
      text = outcome.text + '，+' + n + ' 碎屑';
    } else {
      const item = makeItem(4);
      addItem(item);
      bagDirty = true;
      text = outcome.text + '得「' + item.name + '」（天品）';
      floatText('镇图之宝！「' + item.name + '」', '#ffd479');
    }
    pushLog('挖宝：' + text, 'special');
    showMapEvent('挖宝', mapEventHtml(esc(text), 'dig'));
    chime([659, 784, 1046]);
    render();
    save();
  }

  function renderTreasureBox() {
    const box = $('treasureBox');
    if (!box || !featureOpen('treasure')) return;
    const t = state.treasure;
    const sig = t.frags + '|' + t.maps + '|' + (t.at >= 0 && state.map && state.map.rev.includes(t.at) ? 1 : 0);
    if (panelSigs.treasure === sig) return;
    panelSigs.treasure = sig;
    const spotReady = t.at >= 0 && state.map && state.map.rev.includes(t.at);
    box.innerHTML =
      '<div class="rogue-head"><span class="side-title">藏宝图</span></div>' +
      '<p class="hint">征战胜利有概率拾得残片（' + t.frags + ' / ' + TREASURE_FRAG_COST + '），' +
        '集齐合成藏宝图，秘境图上便会浮现金光宝点，点击即挖（不耗行动力）。</p>' +
      '<button class="btn wide" data-treasure="synth"' +
        (t.frags >= TREASURE_FRAG_COST && t.maps < 99 ? '' : ' disabled') + '>' +
        '合成藏宝图（' + t.frags + ' / ' + TREASURE_FRAG_COST + ' 残片 · 现有 ' + t.maps + ' 张）</button>' +
      (spotReady ? '<p class="hint treasure-tip">宝点已现——去秘境图点「宝」格挖宝！</p>' : '');
  }

  // —— 钓鱼 ——
  // 抛竿状态仅存内存：时机条光标随时间三角波游走，起竿越中越准
  let fishRod = null;
  let fishMsg = null; // 最近一次起竿/脱钩结果（仅内存，面板结果行展示）

  function ensureFishDaily() {
    if (state.fishing.date !== todayStr()) {
      state.fishing.date = todayStr();
      state.fishing.bait = Math.max(state.fishing.bait, FISH_BAIT_DAILY);
    }
  }

  const fishCursorPos = () => {
    const t = (Date.now() - fishRod.start) / 1100;
    const tri = Math.abs((t % 2) - 1);
    return 1 - tri;
  };

  function castRod() {
    ensureFishDaily();
    if (fishRod) return;
    if (state.fishing.bait <= 0) {
      floatText('鱼饵不足（每日补 5 枚）', '#f87171');
      return;
    }
    state.fishing.bait--;
    fishRod = { start: Date.now() };
    fishMsg = null;
    render();
    save();
  }

  function reelRod() {
    if (!fishRod) return;
    const held = Date.now() - fishRod.start;
    const acc = 1 - Math.abs(fishCursorPos() - 0.5) * 2;
    fishRod = null;
    if (held > FISH_ROD_MS) {
      fishMsg = { text: '迟疑太久，鱼儿脱钩游走了', cls: 'g-none' };
      pushLog('迟疑太久，鱼儿脱钩游走了', 'sys');
      render();
      return;
    }
    let roll = Math.random() * 62 + acc * 38;
    let tier = FISH_TABLE[FISH_TABLE.length - 1];
    for (const f of FISH_TABLE) {
      if (roll < f.p) { tier = f; break; }
      roll -= f.p;
    }
    const idx = FISH_TABLE.indexOf(tier);
    state.fishing.casts++;
    if (idx > state.fishing.bestT) state.fishing.bestT = idx;
    let text = '';
    let cls = 'g-none';
    if (tier.big) {
      cls = 'g-item';
      if (Math.random() < 0.6) {
        const item = makeItem(4);
        addItem(item);
        bagDirty = true;
        text = '「' + tier.name + '」化形赠宝：' + item.name + '（天品）';
        floatText('灵龙鱼化形！「' + item.name + '」', '#ffd479');
        chime([659, 784, 1046, 1318]);
      } else {
        addStones(30000);
        text = '「' + tier.name + '」腹中藏宝：+30000 灵石';
        chime([659, 784, 1046]);
      }
    } else if (tier.stones) {
      addStones(tier.stones);
      cls = tier.stones >= 5000 ? 'g-stone' : 'g-none';
      text = tier.name + '，+' + fmt(tier.stones) + ' 灵石';
      chime([523, 659]);
    } else {
      addDust(tier.dust);
      cls = 'g-dust';
      text = tier.name + '，+' + tier.dust + ' 碎屑';
      chime([523, 659]);
    }
    fishMsg = { text, cls };
    pushLog('钓得' + text + (acc > 0.85 ? '（妙手！）' : ''), 'special');
    render();
    save();
  }

  function buyBait() {
    if (state.fishing.bait >= 99) return;
    if (state.stones < FISH_BAIT_COST) {
      floatText('灵石不足', '#f87171');
      return;
    }
    state.stones -= FISH_BAIT_COST;
    state.fishing.bait++;
    beep(700, 0.06);
    render();
    save();
  }

  // 光标位移逐帧刷（不走 render 全量重绘）；超时不收竿则跑鱼
  function fishTick() {
    const cur = $('fishCursor');
    if (!cur || !fishRod) return;
    if (Date.now() - fishRod.start > FISH_ROD_MS) {
      fishRod = null;
      fishMsg = { text: '迟疑太久，鱼儿脱钩游走了', cls: 'g-none' };
      pushLog('迟疑太久，鱼儿脱钩游走了', 'sys');
      render();
      return;
    }
    cur.style.left = (fishCursorPos() * 100).toFixed(1) + '%';
  }

  function renderFishing() {
    const box = $('fishingBox');
    if (!box || !featureOpen('fish')) return;
    ensureFishDaily();
    const canBuy = state.stones >= FISH_BAIT_COST && state.fishing.bait < 99;
    const sig = state.fishing.bait + '|' + (fishRod ? 1 : 0) + '|' + state.fishing.casts + '|' +
      state.fishing.bestT + '|' + (canBuy ? 1 : 0) + '|' + (fishMsg ? fishMsg.text : '');
    if (panelSigs.fishing === sig) return;
    panelSigs.fishing = sig;
    const best = state.fishing.bestT >= 0 ? FISH_TABLE[state.fishing.bestT].name : '—';
    box.innerHTML =
      '<p class="hint">鱼饵 ' + state.fishing.bait + ' 枚（每日 0 点补 5）· 已钓 ' + state.fishing.casts +
        ' 竿 · 最旺 ' + best + '</p>' +
      '<div class="fish-track"><span class="fish-zone"></span>' +
        '<span class="fish-cursor' + (fishRod ? '' : ' hidden') + '" id="fishCursor"></span></div>' +
      '<button class="btn wide" id="fishBtn"' + (!fishRod && state.fishing.bait <= 0 ? ' disabled' : '') + '>' +
        (fishRod ? '起竿！（越中越准）' : '抛竿') + '</button>' +
      (fishMsg
        ? '<p class="gamble-result ' + fishMsg.cls + '">' + fishMsg.text + '</p>'
        : '');
    // 补饵钮常驻垂钓标题右侧（静态元素），此处只同步文案与可用态
    const baitBtn = $('fishBaitBtn');
    baitBtn.innerHTML = '补饵 ' + fmt(FISH_BAIT_COST) + resIcon('stones');
    baitBtn.disabled = !canBuy;
    $('fishBtn').addEventListener('click', fishRod ? reelRod : castRod);
  }

  // —— 灵宠内丹 ——
  function feedCore(id) {
    const def = PETS.find((p) => p.id === id);
    if (!def || state.pets[id] === undefined) return;
    const lv = state.petCores[id] | 0;
    if (lv >= CORE_MAX) return;
    const cost = coreCost(lv);
    if (state.beastBones < cost) {
      floatText('兽骨不足（野外征战可得）', '#f87171');
      return;
    }
    state.beastBones -= cost;
    state.petCores[id] = lv + 1;
    const hit = (CORE_TRAITS[id] || []).find((t) => t.lv === lv + 1);
    pushLog('「' + def.name + '」内丹升至 ' + (lv + 1) + ' 级' +
      (hit ? '，觉醒特性「' + hit.name + '」' : ''), 'special');
    if (hit) chime([659, 880, 1046]);
    combatDirty = true;
    render();
    save();
  }

  // —— 灵圃采集 ——
  function startGather(key) {
    const def = GATHER_NODES[key];
    const node = state.gather.nodes[key];
    if (!def || !node || node.until > Date.now()) return;
    if (node.until !== 0) {
      // 上一轮已到点未收取：禁止重开覆盖掉待收产出（UI 禁用之外的状态层兜底）
      floatText('上一轮尚未收取', '#f87171');
      return;
    }
    node.until = Date.now() + def.ms;
    pushLog('开始采集「' + def.name + '」（' + Math.round(def.ms / 60000) + ' 分钟）', 'sys');
    beep(620, 0.06);
    render();
    save();
  }

  function collectGather(key) {
    const def = GATHER_NODES[key];
    const node = state.gather.nodes[key];
    if (!def || !node || node.until === 0 || Date.now() < node.until) return;
    const n = gatherYield(key);
    node.until = 0;
    if (key === 'ore') state.gather.ore = Math.min(1e6, state.gather.ore + n);
    else state.gather.herb = Math.min(1e6, state.gather.herb + n);
    pushLog('「' + def.name + '」采集完成，' + (key === 'ore' ? '矿石' : '灵药') + ' +' + n, 'special');
    chime([784, 988]);
    render();
    save();
  }

  function upgradeGather(key) {
    const def = GATHER_NODES[key];
    const node = state.gather.nodes[key];
    if (!def || !node || node.lv >= GATHER_MAX_LV) return;
    const cost = gatherCost(node.lv);
    if (state.stones < cost) {
      floatText('灵石不足', '#f87171');
      return;
    }
    state.stones -= cost;
    node.lv++;
    pushLog('「' + def.name + '」扩至 ' + node.lv + ' 级', 'sys');
    beep(700, 0.06);
    render();
    save();
  }

  function renderGather() {
    const box = $('gatherList');
    if (!box || !featureOpen('gather')) return;
    const nodes = state.gather.nodes;
    const nodeSig = Object.keys(GATHER_NODES).map((k) => {
      const u = nodes[k].until;
      return u > Date.now() ? Math.ceil((u - Date.now()) / 60000) : u;
    }).join(',');
    // 扩建按钮可用性直接进签名：按 4000 分桶会让按钮长期滞留错误禁用/可点态
    const sig = nodeSig + '|' + nodes.ore.lv + '|' + nodes.herb.lv + '|' +
      state.gather.ore + '|' + state.gather.herb + '|' +
      (state.stones >= gatherCost(nodes.ore.lv) ? 1 : 0) + '|' +
      (state.stones >= gatherCost(nodes.herb.lv) ? 1 : 0);
    if (panelSigs.gather === sig) return;
    panelSigs.gather = sig;
    box.innerHTML = Object.keys(GATHER_NODES).map((key) => {
      const def = GATHER_NODES[key];
      const node = nodes[key];
      const busy = node.until > Date.now();
      const canCollect = node.until !== 0 && !busy;
      const left = busy ? fmtDuration((node.until - Date.now()) / 1000) : '';
      const stock = key === 'ore' ? state.gather.ore : state.gather.herb;
      return (
        '<div class="cave-row">' +
          '<span class="cave-icon" aria-hidden="true">' + (GATHER_ICONS[key] || def.icon) + '</span>' +
          '<div class="cave-main"><span class="cave-name">' + def.name + ' <em>' + node.lv + ' 级</em></span>' +
          '<p class="cave-desc">' + (busy ? '采集中 · 剩 ' + left : canCollect
            ? '可收取 ' + gatherYield(key) + ' ' + (key === 'ore' ? '矿石' : '灵药')
            : '闲置 · ' + Math.round(def.ms / 60000) + ' 分钟一轮') +
            ' · 存量 ' + fmt(stock) + '</p></div>' +
          '<div class="gather-actions">' +
            '<button class="mini" data-gather="collect" data-key="' + key + '"' + (canCollect ? '' : ' disabled') + '>收取</button>' +
            '<button class="mini" data-gather="start" data-key="' + key + '"' + (busy || canCollect ? ' disabled' : '') + '>' +
              (busy ? '采集中' : '采集') + '</button>' +
            '<button class="mini ghost" data-gather="up" data-key="' + key + '"' +
              (node.lv >= GATHER_MAX_LV || state.stones < gatherCost(node.lv) ? ' disabled' : '') + '>' +
              (node.lv >= GATHER_MAX_LV ? '已满级' : '扩建 ' + fmt(gatherCost(node.lv)) + resIcon('stones')) + '</button>' +
          '</div>' +
        '</div>'
      );
    }).join('') +
    '<p class="hint">灵药可在炼丹房折价合丹（' + HERB_ELIXIR_NEED + ' 灵药 + 四成灵石/枚），' +
      '矿石可在炼器坊锻器魂（' + ORE_SOUL_NEED + ' 矿石 → 器魂 3）。扩建提升单轮产量。</p>';
  }

  // 灵药合丹：十枚灵药 + 四成灵石，走同一炼丹炉
  function craftElixirHerb(id) {
    const def = ELIXIRS.find((e) => e.id === id);
    if (!def || state.elixir.crafting) return;
    if (state.gather.herb < HERB_ELIXIR_NEED) {
      floatText('灵药不足（灵药圃采集）', '#f87171');
      return;
    }
    const cost = Math.ceil(def.cost * 0.4);
    if (state.stones < cost) {
      floatText('灵石不足', '#f87171');
      return;
    }
    state.gather.herb -= HERB_ELIXIR_NEED;
    state.stones -= cost;
    state.elixir.crafting = { id, doneAt: Date.now() + def.ms };
    pushLog('以灵药合丹：「' + def.name + '」开始炼制（' + fmtDuration(def.ms / 1000) + '）', 'sys');
    beep(880, 0.08);
    panelSigs.elixir = null;
    render();
    save();
  }

  // 矿石锻魂：二十矿石换器魂 3（≈半件专属件的分解量）
  function forgeSouls() {
    if (state.gather.ore < ORE_SOUL_NEED) {
      floatText('矿石不足（灵矿脉采集）', '#f87171');
      return;
    }
    state.gather.ore -= ORE_SOUL_NEED;
    state.souls += 3;
    pushLog('矿石锻魂：器魂 +3', 'special');
    chime([659, 880]);
    render();
    save();
  }

  // 装备熔铸（2026-10-31 收敛为两档）：天品 ×5 → 仙品；仙品 ×5 → 星级 +1 的仙品
  //（封顶 ★5，星级只乘算战力、不改 power 字段，服务端校验口径不变）。材料取最弱
  // MELT_NEED 件（套装/专属件不入料），部位随机，手续费按档位固定。
  const meltStock = (r) => state.bag.filter((it) => it.r === r && !it.special).length;
  const meltFee = (r) => (r === 4 ? RARITIES[5].stone * 10 : RARITIES[5].stone * 25);
  function meltItem(r) {
    if (r !== 4 && r !== 5) return;
    const mats = state.bag
      .filter((it) => it.r === r && !it.special)
      .sort((a, b) => itemScore(a) - itemScore(b))
      .slice(0, MELT_NEED);
    if (mats.length < MELT_NEED) {
      floatText(RARITIES[r].name + '不足（需 ' + MELT_NEED + ' 件）', '#f87171');
      return;
    }
    const fee = meltFee(r);
    if (state.stones < fee) {
      floatText('灵石不足（熔铸手续费）', '#f87171');
      return;
    }
    const outLabel = r === 4
      ? '熔出 1 件仙品装备（部位随机）'
      : '熔出 1 件星级更高的仙品（封顶 ★5）';
    const rate = meltRate();
    if (!confirm('熔铸：消耗 ' + MELT_NEED + ' 件' + RARITIES[r].name + '装备（取最弱 ' + MELT_NEED +
      ' 件）+' + fmt(fee) + ' 灵石，成功率 ' + Math.round(rate * 100) + '%（10% 上下浮动 5%），' +
      outLabel + '。失败材料与手续费不退。确定？')) return;
    mats.forEach((it) => state.bag.splice(state.bag.indexOf(it), 1));
    state.stones -= fee;
    if (Math.random() >= rate) {
      bagDirty = true;
      pushLog('熔铸失败：' + RARITIES[r].name + ' ×' + MELT_NEED + ' 与 ' + fmt(fee) +
        ' 灵石手续费俱耗，仙火未成', 'sys');
      beep(220, 0.1);
      panelSigs.melt = null;
      render();
      paintBag(true);
      save();
      return;
    }
    let item;
    if (r === 4) {
      item = makeItem(5);
    } else {
      item = makeItem(5);
      const maxMatStar = mats.reduce((m, it) => Math.max(m, it.star || 0), 0);
      item.star = Math.min(5, maxMatStar + 1); // 品质稍高一点 = 星级 +1（封顶 ★5）
    }
    addItem(item);
    bagDirty = true;
    pushLog('熔铸成功：「' + item.name + '」（' + RARITIES[item.r].name +
      (item.star ? ' ★' + item.star : '') + '）', 'special');
    chime([659, 784]);
    panelSigs.melt = null;
    render();
    paintBag(true);
    save();
  }

  // 斗法·昨日之我
  function runMirror() {
    const snap = state.mirror.snap;
    if (!snap || state.mirror.claimed) return;
    const enemy = {
      name: '昨日之我',
      base: '昨日之我',
      icon: '影',
      kicker: '斗法 · 上周的你（战力 ' + fmt(snap.power) + '）',
      boss: false,
      req: snap.power,
      el: randEl(),
      affix: '',
      hp: Math.max(1, Math.round(snap.hp * 7.5)),
      atk: Math.max(1, Math.round(snap.atk)),
      def: Math.max(0, Math.round(snap.def)),
    };
    const player = playerCombatStats();
    player.atk *= elementBonus(enemy.el).mult;
    const result = simulateBattle(player, enemy);
    showBattlePopup(enemy, result, {
      title: '斗法 · 昨日之我', playerHp: player.hp, playerGray: true,
      closeText: '收下奖励', loseText: '离开',
      rewardText: result.win ? '+' + fmt(Math.max(2000, Math.floor(snap.power * 3))) + ' 灵石 · +50 碎屑' : undefined,
    });
    if (result.win) {
      if (!state.mirror.claimed) {
        const stones = Math.max(2000, Math.floor(snap.power * 3));
        addStones(stones);
        addDust(50);
        state.bestiary[enemy.base] = (state.bestiary[enemy.base] || 0) + 1;
        state.mirror.claimed = true;
        pushLog('胜过「昨日之我」：+' + fmt(stones) + ' 灵石 · 50 碎屑', 'special');
        chime([784, 1046, 1318]);
      }
    } else {
      pushLog('败给「昨日之我」，修炼还需更勤', 'sys');
      beep(220, 0.12);
    }
    renderTrials();
    save();
  }

  // 秘境地图
  function ensureMap() {
    ensureDaily();
    if (!state.map) {
      state.map = {
        seed: Math.floor(Math.random() * 1e9),
        px: Math.floor(MAP_W / 2),
        py: Math.floor(MAP_H / 2),
        rev: [],
        looted: [],
        ap: MAP_AP_DAY,
        buys: 0,
        buyDay: '',
        date: todayStr(),
      };
      revealAround();
    }
    if (state.map.date !== todayStr()) {
      state.map.date = todayStr();
      state.map.buys = 0;                       // 加购计数随每日重置清零
      state.map.ap = Math.min(MAP_AP_MAX, state.map.ap + MAP_AP_DAY);
    }
  }

  // 秘境图行动力加购：灵石购买，每日至多 MAP_BUY_MAX 次（加购点当日有效）
  function buyMapAp() {
    ensureMap();
    const today = todayStr();
    if (state.map.buyDay !== today) { state.map.buyDay = today; state.map.buys = 0; }
    if (state.map.buys >= MAP_BUY_MAX) { floatText('今日加购已达上限（' + MAP_BUY_MAX + ' 次）', '#f87171'); return; }
    if (state.stones < MAP_BUY_COST) { floatText('灵石不足', '#f87171'); return; }
    state.stones -= MAP_BUY_COST;
    state.map.buys++;
    state.map.ap++;
    pushLog('秘境图加购 1 行动力（-' + fmt(MAP_BUY_COST) + ' 灵石），今日已购 ' + state.map.buys + '/' + MAP_BUY_MAX, 'sys');
    floatText('行动力 +1', '#4ade80');
    beep(660, 0.1);
    save();
    renderMap();
  }

  const tileHash = (idx) => {
    let h = (state.map.seed ^ ((idx + 1) * 2654435761)) >>> 0;
    h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
    return ((h >>> 8) % 1000);
  };

  function tileInfo(idx) {
    const h = tileHash(idx);
    const h2 = tileHash(idx + 977);
    const el = ELEMENTS[h2 % ELEMENTS.length].key;
    if (h < 520) return { type: 'empty', icon: '·', name: '荒径', el };
    if (h < 560) return { type: 'encounter', icon: '遇', name: '故人偶遇', el };
    if (h < 700) return { type: 'stones', icon: '灵', name: '灵石矿', el };
    if (h < 840) return { type: 'dust', icon: '尘', name: '碎屑堆', el };
    if (h < 950) return { type: 'monster', icon: '妖', name: '据守妖物', el };
    return { type: 'shrine', icon: '洞', name: '藏宝窟', el };
  }

  // —— 偶遇（2026-10-31）：秘境图新格，与人物志已结识 NPC（state.story.met）随机相遇；
  // 对白由模板池按当前境界/区域随机拼装，赠礼加权随机（量级对齐藏宝图挖宝）。
  // 尚未结识任何人时回退到道侣三人（青璇/白芷/石坚的人物志版本）。
  const ENCOUNTER_POOL_FALLBACK = ['qingxuan', 'baizhi', 'shijian'];
  const ENCOUNTER_LINES = {
    open: [
      '山道转角，{npc}正负手望着一片云海出神。',
      '雾气散开，{npc}竟坐在溪边小憩，身旁搁着一壶灵茶。',
      '「好巧。」{npc}从一块界碑后转出来，说是顺着你的脚印一路找来的。',
    ],
    tale: [
      '「{player}道友，听闻你已入{realm}，这份进境放在当年也算罕见。」',
      '「我方才从{zone}那边过来，听说那片的妖物见了你都绕道。」',
      '「匣子认主，人也认路。你走到哪儿，热闹就跟到哪儿。」',
      '「修行是独行的事，只是路上偶尔有人搭句话，总归好走些。」',
      '「前些日子听说你在这里连破了好几处秘境，我特来瞧瞧真假。」',
    ],
  };
  // 赠礼加权：灵石 40 / 碎屑 25 / 丹药 15 / 券 15 / 天品装备 5（量级对齐挖宝表）
  const ENCOUNTER_GIFTS = [
    { p: 40, kind: 'stones' },
    { p: 25, kind: 'dust' },
    { p: 15, kind: 'elixir' },
    { p: 15, kind: 'ticket' },
    { p: 5, kind: 'item' },
  ];
  function encounterGift() {
    let roll = Math.random() * 100;
    for (const g of ENCOUNTER_GIFTS) {
      if (roll < g.p) return g.kind;
      roll -= g.p;
    }
    return 'stones';
  }

  function resolveMapEncounter(idx) {
    const pool = (state.story.met || []).filter((id) => STORY_CAST[id]);
    const met = pool.length ? pool : ENCOUNTER_POOL_FALLBACK.filter((id) => STORY_CAST[id]);
    if (!met.length) return;
    const id = met[Math.floor(Math.random() * met.length)];
    const npc = STORY_CAST[id];
    const zoneName = (WILD_ZONES[Math.min(WILD_ZONES.length - 1, (state.wildZone || 1) - 1)] || {}).name || '野外';
    const fill = (t) => String(t)
      .replace(/\{npc\}/g, esc(npc.name))
      .replace(/\{player\}/g, esc(playerName()))
      .replace(/\{realm\}/g, REALMS[Math.min(REALMS.length - 1, state.realm)] || '修行')
      .replace(/\{zone\}/g, esc(zoneName));
    const kind = encounterGift();
    let giftText = '';
    if (kind === 'stones') {
      const n = Math.max(100000, Math.floor(totalPower() * 20));
      addStones(n);
      giftText = fill('{npc}从袖中摸出一袋灵石：「盘缠而已，莫推辞。」（+' + fmt(n) + ' 灵石）');
    } else if (kind === 'dust') {
      const n = Math.max(30, Math.min(300, Math.floor(totalPower() / 120)));
      addDust(n);
      giftText = fill('{npc}把一小包碎屑塞进你手里：「炼器用得着，收好。」（+' + n + ' 碎屑）');
    } else if (kind === 'elixir') {
      const el = ELIXIRS[Math.floor(Math.random() * ELIXIRS.length)];
      state.elixir.owned[el.id] = (state.elixir.owned[el.id] || 0) + 1;
      giftText = fill('{npc}取出一枚' + el.name + '：「趁热服下，别搁到失效。」（' + el.name + ' ×1）');
    } else if (kind === 'ticket') {
      if (Math.random() < 0.5) {
        state.petTickets = Math.min(1e9, (state.petTickets || 0) + 1);
        giftText = fill('{npc}递来一张兽栏的通行券：「听说你又惦记灵宠了？」（招募券 ×1）');
      } else {
        state.rerollCoupon = Math.min(99, (state.rerollCoupon || 0) + 1);
        giftText = fill('{npc}把一张符纸折成方块递来：「拿去，下次洗练能省一半。」（洗练半价券 ×1）');
      }
    } else {
      const item = grantEquipBox(4, '偶遇之赠');
      giftText = fill('{npc}从储物袋里取出一件旧物：「合用便拿去，别嫌旧。」（' + (item ? esc(item.name) : '天品装备') + ' ×1）');
    }
    const body =
      '<div class="encounter-row">' + storyPortrait(id, 'enc') +
      '<div class="encounter-text">' +
      '<p class="encounter-name" data-c="' + esc(npc.color || '#8a6a2f') + '">' + esc(withPlayerName(npc.name)) + '</p>' +
      '<p class="map-event-line">' + fill(ENCOUNTER_LINES.open[Math.floor(Math.random() * ENCOUNTER_LINES.open.length)]) + '</p>' +
      '<p class="map-event-line">' + fill(ENCOUNTER_LINES.tale[Math.floor(Math.random() * ENCOUNTER_LINES.tale.length)]) + '</p>' +
      '<p class="map-event-line">' + giftText + '</p>' +
      '</div></div>';
    showMapEvent('偶遇 · ' + withPlayerName(npc.name), body);
    pushLog('秘境图偶遇「' + withPlayerName(npc.name) + '」，获赠' +
      (kind === 'item' ? '天品装备' : kind === 'elixir' ? '丹药' : kind === 'ticket' ? '券' : kind === 'stones' ? '灵石' : '碎屑'), 'special');
    state.map.looted.push(idx);
    chime([659, 880]);
  }

  // 五行灵脉：身上有克制该格五行的装备时产出 ×1.5
  function veinBonus(el) {
    let fav = 0;
    for (const s of SLOTS) {
      const it = state.equipped[s.key];
      if (it && it.el && ELEMENT_BEATS[it.el] === el) fav++;
    }
    return fav > 0 ? 1.5 : 1;
  }

  function revealAround() {
    const { px, py } = state.map;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = px + dx;
        const y = py + dy;
        if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
        const idx = y * MAP_W + x;
        if (!state.map.rev.includes(idx)) state.map.rev.push(idx);
      }
    }
  }

  function mapMove(idx) {
    ensureMap();
    // 挖宝点：点中金光格直接挖宝（不耗行动力、不要求相邻）
    if (idx === state.treasure.at && featureOpen('treasure')) {
      doDigTreasure();
      return;
    }
    const x = idx % MAP_W;
    const y = Math.floor(idx / MAP_W);
    const dist = Math.abs(x - state.map.px) + Math.abs(y - state.map.py);
    if (dist !== 1) {
      floatText('只能走相邻一格', '#9aa4b2');
      return;
    }
    if (state.map.ap <= 0) {
      floatText('行动力不足（每日 +6）', '#f87171');
      return;
    }
    const info = tileInfo(idx);
    // 已采光格（UI 渲染为 ∅）只做通路：不再触发战斗/产出，堵住在相邻空格间
    // 来回走无限重复收割的口子（looted 也因此天然不会重复 push）
    const already = info.type !== 'empty' && state.map.looted.includes(idx);

    if (info.type === 'monster' && !already) {
      const d = Math.abs(x - Math.floor(MAP_W / 2)) + Math.abs(y - Math.floor(MAP_H / 2));
      const req = Math.max(60, totalPower() * (0.45 + 0.12 * d) * immortalMult());
      const enemy = {
        name: info.name,
        base: '秘境妖物',
        icon: '妖',
        kicker: '秘境图 · ' + info.name,
        boss: false,
        req,
        el: info.el,
        affix: '',
        hp: Math.max(1, Math.round(req * 6.8)),
        atk: Math.max(1, Math.round(req * 0.72)),
        def: Math.max(0, Math.round(req * 0.2)),
      };
      const player = playerCombatStats();
      player.atk *= elementBonus(enemy.el).mult;
      const result = simulateBattle(player, enemy);
      showBattlePopup(enemy, result, { title: '秘境图', playerHp: player.hp, closeText: '离开' });
      if (!result.win) {
        pushLog('秘境图：「' + info.name + '」过强，未能踏入此格', 'sys');
        beep(220, 0.1);
        renderMap();
        save();
        return;
      }
      const vein = veinBonus(info.el);
      const loot = Math.max(20000, Math.floor(totalPower() * 45 * vein));
      addStones(loot);
      addDust(Math.max(8, Math.floor(totalPower() / 200 * vein)));
      state.bestiary[enemy.base] = (state.bestiary[enemy.base] || 0) + 1;
      pushLog('秘境图：斩「' + info.name + '」（' + ELEMENTS.find((e) => e.key === info.el).name + '行' +
        (vein > 1 ? '·灵脉相克 ×1.5' : '') + '），+' + fmt(loot) + ' 灵石', 'special');
      state.map.looted.push(idx);
    } else if (!already && info.type === 'stones') {
      const vein = veinBonus(info.el);
      const gain = Math.max(15000, Math.floor(totalPower() * 30 * vein));
      addStones(gain);
      state.map.looted.push(idx);
      pushLog('秘境图：采得灵石矿，+' + fmt(gain) + ' 灵石' + (vein > 1 ? '（灵脉相克）' : ''), 'special');
      showMapEvent('灵石矿', mapEventHtml('+' + fmt(gain) + ' 灵石' + (vein > 1 ? '（灵脉相克 ×1.5）' : ''), 'stones'));
      beep(700, 0.07);
    } else if (!already && info.type === 'dust') {
      const vein = veinBonus(info.el);
      const gain = Math.max(12, Math.min(150, Math.floor(totalPower() / 150 * vein)));
      addDust(gain);
      state.map.looted.push(idx);
      pushLog('秘境图：拾得碎屑堆，+' + gain + ' 碎屑' + (vein > 1 ? '（灵脉相克）' : ''), 'special');
      showMapEvent('碎屑堆', mapEventHtml('+' + gain + ' 碎屑' + (vein > 1 ? '（灵脉相克 ×1.5）' : ''), 'dust'));
      beep(700, 0.07);
    } else if (!already && info.type === 'shrine') {
      const vein = veinBonus(info.el);
      const gain = Math.max(50000, Math.floor(totalPower() * 100 * vein));
      addStones(gain);
      state.map.looted.push(idx);
      pushLog('秘境图：发现藏宝窟！+' + fmt(gain) + ' 灵石', 'special');
      showMapEvent('藏宝窟', mapEventHtml('+' + fmt(gain) + ' 灵石' + (vein > 1 ? '（灵脉相克 ×1.5）' : ''), 'shrine'));
      chime([659, 784, 1046]);
    } else if (!already && info.type === 'encounter') {
      resolveMapEncounter(idx);
    }

    state.map.ap--;
    state.map.px = x;
    state.map.py = y;
    revealAround();
    // 跑满图立即换新图（2026-10-31 用户指定）：探明全图即重置雾图与产出，
    // 行动力/加购计数不变（仍受每日经济约束），seed 重摇全图重生、回中心点
    if (state.map.rev.length >= MAP_W * MAP_H) {
      state.map.seed = Math.floor(Math.random() * 1e9);
      state.map.px = Math.floor(MAP_W / 2);
      state.map.py = Math.floor(MAP_H / 2);
      state.map.rev = [];
      state.map.looted = [];
      revealAround();
      pushLog('秘境图已探明全图！山移路转，一张新图在脚下展开', 'special');
      chime([659, 784, 1046]);
    }
    renderMap();
    save();
  }

  // 挑战修行
  function acceptOrdeal(id) {
    const def = ORDEALS.find((o) => o.id === id);
    if (!def) return;
    if (state.ordeal.active === id) {
      state.ordeal.active = '';
      pushLog('暂别「' + def.name + '」', 'sys');
    } else if (!state.ordeal.active) {
      state.ordeal.active = id;
      state.ordeal.dirty = false;
      pushLog('接受「' + def.name + '」：' + def.desc, 'special');
      chime([659, 784]);
    } else {
      floatText('已有修行在进行', '#f87171');
      return;
    }
    render();
    save();
  }

  // 陈列室
  function museumBonus() {
    let bonus = 0;
    for (const s of SLOTS) {
      const it = state.museum[s.key];
      if (!it) continue;
      bonus += (it.special || it.r >= 5) ? 0.02 : 0.01;
    }
    return bonus;
  }

  function sealItem(id) {
    if (!featureOpen('museum')) { floatText('陈列室境界「合体」后解锁', '#f87171'); return; }
    const item = state.bag.find((x) => x.id === id);
    if (!item) return;
    const stand = state.museum[item.slot];
    if (stand && itemScore(item) <= itemScore(stand)) {
      floatText('陈列台上有更强的', '#f87171');
      return;
    }
    if (stand) {
      if (state.bag.length >= bagCap()) {
        // 背包满：自动分解背包里最弱的一件（不含本次封存件）腾位，换下旧展品
        let wi = -1;
        for (let i = 0; i < state.bag.length; i++) {
          if (state.bag[i].id === item.id) continue;
          if (wi < 0 || itemScore(state.bag[i]) < itemScore(state.bag[wi])) wi = i;
        }
        if (wi < 0) {
          floatText('背包已满，换不下旧展品', '#f87171');
          return;
        }
        const victim = state.bag[wi];
        const v = addStones(salvageValue(victim));
        addDust(dustValue(victim));
        if (victim.special) addSouls(SOULS_PER_SPECIAL);
        state.bag.splice(wi, 1);
        pushLog('背包已满：自动分解「' + victim.name + '」为旧展品腾位（+' + fmt(v) + ' 灵石）', 'sys');
      }
      state.bag.push(stand);
      bagDirty = true;
    }
    state.museum[item.slot] = item;
    state.bag = state.bag.filter((x) => x.id !== item.id);
    bagDirty = true;
    pushLog('「' + item.name + '」入驻陈列室', 'special');
    chime([784, 1046]);
    render();
    paintBag(true);
    save();
  }

  // 灵田
  function plantSeed(plotIdx, seedId) {
    const def = FARM_SEEDS.find((sd) => sd.id === seedId);
    if (!def || state.farm.plots[plotIdx]) return;
    if (state.stones < def.cost) {
      floatText('灵石不足', '#f87171');
      return;
    }
    state.stones -= def.cost;
    state.farm.plots[plotIdx] = { id: seedId, doneAt: Date.now() + def.ms };
    pushLog('灵田种下「' + def.name + '」（' + def.text + '）', 'sys');
    beep(620, 0.07);
    render();
    save();
  }

  function harvestPlot(plotIdx) {
    const plot = state.farm.plots[plotIdx];
    if (!plot || Date.now() < plot.doneAt) return;
    const def = FARM_SEEDS.find((sd) => sd.id === plot.id);
    state.farm.plots[plotIdx] = null;
    if (def) {
      addDust(def.dust);
      pushLog('灵田收获「' + def.name + '」，+' + def.dust + ' 碎屑', 'special');
      chime([784, 988]);
    }
    render();
    save();
  }

  // 天道录
  function claimChapter(realm) {
    const def = CHAPTERS[realm];
    if (!def || realm > state.realm || state.chapters.includes(realm)) return;
    state.chapters.push(realm);
    const gain = CHAPTER_GAIN * (realm + 1);
    addStones(gain);
    pushLog('天道录·' + def.title + '：+' + fmt(gain) + ' 灵石', 'special');
    chime([659, 880, 1046]);
    render();
    save();
  }

  /* ---------------- 第四批：融合 / 符文 / 心魔 / 悬赏 / 天劫 / 道侣 / 战功碑 ---------------- */

  // 宝石三合一：六槽内同档同型 ×3 → 当前工坊部位空孔 ×1 高一档
  function gemCounts() {
    const counts = {};
    const add = (g) => {
      if (!g) return;
      const key = g.k + '_' + g.t;
      counts[key] = (counts[key] || 0) + 1;
    };
    for (const s of SLOTS) {
      for (const g of state.slotGems[s.key] || []) add(g);
    }
    return counts;
  }

  function takeGems(k, t, n) {
    let left = n;
    for (const s of SLOTS) {
      const arr = state.slotGems[s.key];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length && left > 0; i++) {
        if (arr[i] && arr[i].k === k && arr[i].t === t) {
          arr[i] = null;
          left--;
        }
      }
    }
    return left === 0;
  }

  function fuseGems(k, t) {
    if (!forgeSlot) return;
    if (t >= GEM_TIERS.length) {
      forgeMsg('已是最高档');
      return;
    }
    if ((gemCounts()[k + '_' + t] || 0) < 3) {
      forgeMsg('同档同型宝石不足三颗');
      return;
    }
    const arr = slotGemList(forgeSlot);
    const dest = arr.indexOf(null);
    if (dest < 0) {
      forgeMsg('当前部位没有空孔承接');
      return;
    }
    // 融合入孔同样按孔位收费：否则三颗低价孔宝石可免费落进高价孔，绕开阶梯费
    const cost = gemCost(k, t + 1, dest + 1);
    if (state.dust < cost) {
      forgeMsg('碎屑不足（本孔需 ' + fmt(cost) + '）');
      return;
    }
    if (!takeGems(k, t, 3)) return;
    state.dust -= cost;
    arr[dest] = { k, t: t + 1 };
    equipDirty = true;
    combatDirty = true;
    pushLog('宝石融合：三颗' + GEM_TIERS[t - 1].name + affixDef(k).name + '石化作一颗' +
      GEM_TIERS[t].name + affixDef(k).name + '石（孔费 ' + fmt(cost) + '）', 'special');
    chime([659, 784, 1046]);
    renderForge();
    save();
  }

  // 符文组词（参数为部位孔位数组）
  function runewordOf(gems) {
    const list = (gems || []).filter(Boolean);
    if (list.length < 2) return null;
    for (const w of RUNEWORDS) {
      if (w.seq.length === list.length && w.seq.every((k, i) => list[i].k === k)) return w;
    }
    return null;
  }

  function renderRunes() {
    if (!forgeSlot) return;
    const gems = slotGemList(forgeSlot);
    const w = runewordOf(gems);
    let html = '<p class="forge-section-title">符文组词（宝石按顺序排列触发）</p>';
    if (w) {
      html += '<div class="affix-row locked"><span class="affix-name">「' + w.name + '」</span>' +
        '<b>' + w.desc + '</b></div>';
    } else if (gems.filter(Boolean).length >= 2) {
      html += '<p class="forge-empty">当前排列未成词，试试调整组合。</p>';
    } else {
      html += '<p class="forge-empty">镶入两颗以上宝石即可组词。</p>';
    }
    html += '<p class="hint">' + RUNEWORDS.map((r) =>
      '「' + r.name + '」' + r.seq.map((k) => SHORT_NAME[k]).join('·') + '：' + r.desc).join(' · ') + '</p>';
    $('forgeRunes').innerHTML = html;
  }

  // 心魔劫
  function spawnDemon() {
    const st = playerCombatStats();
    state.innerDemon = {
      atk: Math.max(1, Math.round(st.atk * 1.2)),
      hp: Math.max(1, Math.round(st.hp * 1.2)),
      def: Math.round(st.def * 1.2),
      kills: 0,
    };
    pushLog('突破引动心魔劫：心魔已现形，随时可去征战斩之', 'special');
  }

  function fightDemon() {
    const d = state.innerDemon;
    if (!d) return;
    const mult = Math.pow(1.15, d.kills);
    const enemy = {
      name: '心魔·第 ' + (d.kills + 1) + ' 形',
      base: '心魔',
      icon: '魔',
      kicker: '心魔劫 · 随你成长，永不满足',
      boss: true,
      req: Math.round((d.atk * 1.1 + d.hp * 0.15) * mult),
      el: randEl(),
      affix: '',
      hp: Math.max(1, Math.round(d.hp * mult)),
      atk: Math.max(1, Math.round(d.atk * mult)),
      def: Math.max(0, Math.round(d.def * mult)),
    };
    const player = playerCombatStats();
    player.atk *= elementBonus(enemy.el).mult;
    const result = simulateBattle(player, enemy);
    // 心魔修为：首斩 1/6 门槛、逐形减半（÷2^已斩形数），50 次合计 ≈ 门槛的 1/3；
    // 不设硬预算：之后每形照给、越来越少（1 起底不归零），总和收敛于 1/3 不超出
    const demonExp = Math.max(1, Math.floor(realmCostOf(state.realm + 1) / 6 / Math.pow(2, d.kills)));
    showBattlePopup(enemy, result, {
      title: '心魔劫', playerHp: player.hp,
      closeText: '收下奖励', loseText: '离开',
      rewardText: result.win ? '+' + fmt(demonExp) + ' 修为' : undefined,
    });
    if (result.win) {
      d.kills++;
      state.exp += demonExp;
      state.bestiary[enemy.base] = (state.bestiary[enemy.base] || 0) + 1;
      pushLog('斩灭心魔第 ' + d.kills + ' 形：+' + fmt(demonExp) + ' 修为。下一形更强。', 'special');
      chime([784, 1046, 1318]);
    } else {
      pushLog('心魔不灭：它说「你还不够坚定」。', 'sys');
      beep(220, 0.12);
    }
    combatDirty = true;
    renderTrials();
    save();
  }

  // 悬赏令（2026-10-30 换档）：每日 4 单（白/绿/蓝/紫 各一），目标按档倍率缩放，
  // 奖励取档位基准；紫单 5% 掉天品装备；四单全清加发 BOUNTY_ALL_CLEAR
  function bountyMissionOf(id) {
    return BOUNTY_MISSIONS.find((b) => b.id === id);
  }

  function bountyDesc(sl) {
    const def = bountyMissionOf(sl.id);
    return def ? def.desc.replace('{t}', sl.target) : '';
  }

  function rollBountySlot(tier, exclude) {
    const pool = BOUNTY_MISSIONS.filter((b) => !exclude.includes(b.id));
    const def = pool[Math.floor(Math.random() * pool.length)] || BOUNTY_MISSIONS[0];
    return {
      id: def.id,
      tier,
      target: Math.max(1, Math.ceil(def.target * BOUNTY_TIER_SCALE[tier])),
      prog: 0,
      claimed: false,
    };
  }

  function ensureBounty() {
    ensureDaily();
    if (state.bounty.date === todayStr() && state.bounty.slots.length === BOUNTY_SLOT_N) return;
    state.bounty.date = todayStr();
    state.bounty.rerolls = BOUNTY_REROLL_N;
    state.bounty.allClaimed = false;
    const used = [];
    state.bounty.slots = BOUNTY_TIERS.map((t) => {
      const sl = rollBountySlot(t.key, used);
      used.push(sl.id);
      return sl;
    });
  }

  function bountyProgress(metric, n) {
    if (n <= 0) return;
    ensureBounty();
    for (const sl of state.bounty.slots) {
      if (sl.id === metric && !sl.claimed) {
        sl.prog = Math.min(1e9, sl.prog + n);
      }
    }
  }

  function rerollBounty(idx) {
    ensureBounty();
    if (state.bounty.rerolls <= 0) {
      floatText('今日刷新次数已用完', '#9aa4b2');
      return;
    }
    if (state.stones < BOUNTY_REROLL_COST) {
      floatText('灵石不足', '#f87171');
      return;
    }
    state.stones -= BOUNTY_REROLL_COST;
    state.bounty.rerolls--;
    const used = state.bounty.slots.map((sl) => sl.id);
    used.splice(idx, 1);
    const tier = state.bounty.slots[idx] ? state.bounty.slots[idx].tier : 'bai';
    state.bounty.slots[idx] = rollBountySlot(tier, used);
    pushLog('悬赏已刷新（余 ' + state.bounty.rerolls + ' 次）', 'sys');
    renderBounty();
    save();
  }

  function claimBounty(idx) {
    ensureBounty();
    const sl = state.bounty.slots[idx];
    if (!sl || sl.claimed) return;
    if (sl.prog < sl.target) return;
    sl.claimed = true;
    const tier = BOUNTY_TIERS.find((t) => t.key === sl.tier) || BOUNTY_TIERS[0];
    const gained = addStones(tier.stones);
    addDust(tier.dust);
    let extra = '';
    if (tier.drop && Math.random() < tier.drop) {
      grantEquipBox(4, '紫悬赏掉落');
      extra = ' · 天品装备掉落！';
    }
    pushLog('悬赏达成「' + bountyDesc(sl) + '」（' + tier.name + '单）：+' + fmt(gained) +
      ' 灵石 · ' + tier.dust + ' 碎屑' + extra, 'special');
    chime([784, 1046]);
    if (state.bounty.slots.every((x) => x.claimed) && !state.bounty.allClaimed) {
      state.bounty.allClaimed = true;
      const allGained = addStones(BOUNTY_ALL_CLEAR.stones);
      pushLog('四单全清！额外 +' + fmt(allGained) + ' 灵石', 'special');
      chime([659, 784, 1046, 1318]);
    }
    renderBounty();
    save();
  }

  /* ---------------- 第九批：灵潮 / 朝贺 / 问答 / 异象 / 灵气 / 占卜 ---------------- */

  // 公共：日期种子（FNV-1a）——问答选题 / 占卜抽签 / 异象词缀，跨刷新稳定
  function daySeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // 公共：境界缩放修为（K × contentReq('wild', 当前最高闯关)，随进度水涨船高）
  function grantExpK(k, why) {
    const base = contentReq('wild', Math.max(1, state.stageCleared));
    const gain = Math.max(1, Math.floor(base * k));
    state.exp += gain;
    pushLog(why + '：修为 +' + fmt(gain), 'sys');
    return gain;
  }

  // 公共：装备箱发放（makeItem 支持指定槽位；天品自选箱传 slotKey）
  function grantEquipBox(ri, why, slotKey) {
    const item = makeItem(ri, slotKey);
    addItem(item);
    bagDirty = true;
    pushLog(why + '：「' + item.name + '」（' + RARITIES[ri].name + '）', 'special');
    chime([659, 784, 1046, 1318]);
    floatText(RARITIES[ri].name + '「' + item.name + '」！', '#ffd479');
    return item;
  }

  // 公共：今日产出倍率（灵潮窗口 ×2 · 上上签 +5%），挂开箱 / 秘境 / 探幽三处产出
  const tideOn = () => {
    const h = new Date().getHours();
    return TIDE_WINDOWS.some((w) => h >= w.s && h < w.e);
  };
  function fortuneProd() {
    if (state.fortune.date !== todayStr() || !state.fortune.claimed || state.fortune.idx < 0) return 1;
    const s = FORTUNE_SIGNS[state.fortune.idx];
    return s && s.prod ? 1 + s.prod : 1;
  }
  const dayProdMult = () => (tideOn() ? TIDE_MULT : 1) * fortuneProd();

  // —— 灵潮时段 ——
  const tideWindowOpen = (i) => {
    const h = new Date().getHours();
    return h >= TIDE_WINDOWS[i].s && h < TIDE_WINDOWS[i].e;
  };
  function ensureTide() {
    if (ensureDated(state.tide)) state.tide.claimed = [false, false];
  }
  function claimTide(i) {
    ensureTide();
    if (!tideWindowOpen(i)) {
      floatText('未在灵潮时段', '#9aa4b2');
      return;
    }
    if (state.tide.claimed[i]) return;
    state.tide.claimed[i] = true;
    const gained = addStones(TIDE_CLAIM);
    pushLog('灵潮符已领：+' + fmt(gained) + ' 灵石（窗口内开箱与秘境产出 ×2）', 'special');
    chime([659, 784, 1046]);
    renderDailyExt();
    save();
  }

  // —— 月度朝贺 ——
  const monthKey = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  };
  const dateOf = (y, m, d) =>
    y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  function ensureMonth() {
    if (state.month.key !== monthKey()) {
      state.month = { key: monthKey(), days: [], makeup: 0, claimed: [] };
    }
  }
  function monthMarkToday() {
    ensureMonth();
    const ds = todayStr();
    if (!state.month.days.includes(ds)) state.month.days.push(ds);
  }
  function monthMakeup() {
    ensureMonth();
    if (state.month.makeup >= MONTH_MAKEUP_MAX) {
      floatText('本月补签次数已用完', '#9aa4b2');
      return;
    }
    const y = new Date(Date.now() - 86400000);
    const ds = dateOf(y.getFullYear(), y.getMonth(), y.getDate());
    // 补签只补本月：每月 1 日点补签会把上月末日记进本月到勤，白提前一天里程碑
    if (ds.slice(0, 7) !== monthKey()) {
      floatText('昨日不在本月，无需补签', '#9aa4b2');
      return;
    }
    if (state.month.days.includes(ds)) {
      floatText('昨日已到勤，无需补签', '#9aa4b2');
      return;
    }
    if (state.stones < MONTH_MAKEUP_COST) {
      floatText('灵石不足', '#f87171');
      return;
    }
    state.stones -= MONTH_MAKEUP_COST;
    state.month.makeup++;
    state.month.days.push(ds);
    pushLog('朝贺补签 ' + ds + '（本月还剩 ' + (MONTH_MAKEUP_MAX - state.month.makeup) + ' 次）', 'sys');
    renderDailyExt();
    save();
  }
  function claimMonth(n) {
    ensureMonth();
    const m = MONTH_MILESTONES.find((x) => x.n === n);
    if (!m || state.month.claimed.includes(n)) return;
    if (state.month.days.length < n) {
      floatText('本月到勤 ' + state.month.days.length + ' 天，未达 ' + n + ' 天', '#9aa4b2');
      return;
    }
    state.month.claimed.push(n);
    if (m.reward.boxTian) grantEquipBox(4, '朝贺 ' + n + ' 天');
    if (m.reward.boxXian) grantEquipBox(5, '朝贺 ' + n + ' 天');
    if (m.reward.dust) {
      addDust(m.reward.dust);
      pushLog('朝贺 ' + n + ' 天：+' + m.reward.dust + ' 碎屑', 'special');
    }
    chime([659, 784, 1046, 1318]);
    renderDailyExt();
    save();
  }

  // —— 仙道问答 ——
  function quizPick() {
    let s = daySeed('quiz-' + todayStr());
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const idxs = QUIZ_BANK.map((_, i) => i);
    for (let i = idxs.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = idxs[i];
      idxs[i] = idxs[j];
      idxs[j] = t;
    }
    return idxs.slice(0, QUIZ_N);
  }
  function ensureQuiz() {
    if (ensureDated(state.quiz)) {
      state.quiz.idx = 0;
      state.quiz.correct = 0;
      state.quiz.done = false;
    }
  }
  function quizAnswer(choice) {
    ensureQuiz();
    if (state.quiz.done) return;
    const ids = quizPick();
    const def = QUIZ_BANK[ids[state.quiz.idx]];
    const ok = choice === def.idx;
    let resultTitle, resultBody;
    if (ok) {
      state.quiz.correct++;
      const gained = addStones(QUIZ_PER_STONES);
      grantExpK(QUIZ_PER_EXP_K, '答题答对');
      floatText('答对 +' + fmt(gained) + ' 灵石', '#4ade80');
      resultTitle = '✦ 答对了';
      resultBody = '+' + fmt(gained) + ' 灵石 · 修为提升';
    } else {
      floatText('答错了', '#f87171');
      resultTitle = '答错了';
      resultBody = '正确答案：<b>' + esc(def.a[def.idx]) + '</b>';
    }
    state.quiz.idx++;
    if (state.quiz.idx >= QUIZ_N) {
      state.quiz.done = true;
      if (state.quiz.correct >= QUIZ_N) {
        state.quiz.streak++;
        const b = QUIZ_ALL_BONUS;
        addStones(b.stones);
        addDust(b.dust);
        pushLog('问答全对！连对 ' + state.quiz.streak + ' 天：+' + fmt(b.stones) +
          ' 灵石 · ' + b.dust + ' 碎屑', 'special');
        chime([659, 784, 1046, 1318]);
        resultBody += '<br>十题全对！连对 ' + state.quiz.streak + ' 天：+' +
          fmt(b.stones) + ' 灵石 · +' + b.dust + ' 碎屑';
        if (state.quiz.streak >= QUIZ_STREAK_N) {
          state.quiz.streak = 0;
          resultBody += '<br>满 ' + QUIZ_STREAK_N + ' 天连对，「天品自选箱」已送达！';
          openQuizBoxPick();
        }
      } else {
        if (state.quiz.streak > 0) pushLog('连对中断（' + state.quiz.streak + ' 天）', 'sys');
        state.quiz.streak = 0;
        resultBody += '<br>十题答对 ' + state.quiz.correct + ' 题 · 连对中断，明日再来';
      }
    }
    renderDailyExt();
    save();
    if ($('quizResultModal')) {
      $('quizResultTitle').textContent = resultTitle;
      $('quizResultBody').innerHTML = resultBody;
      $('quizResultModal').classList.add('show');
    }
  }
  // 问答连对 7 天：天品自选箱（选槽位直接生成天品装备）
  function openQuizBoxPick() {
    ensureQuiz();
    if ($('quizBoxModal')) {
      renderQuizBoxPick();
      $('quizBoxModal').classList.add('show');
    }
  }
  function renderQuizBoxPick() {
    const box = $('quizBoxSlots');
    if (!box) return;
    box.innerHTML = SLOTS.map((s) =>
      '<button class="btn tiny" data-quizbox="' + s.key + '">' + s.name + '</button>'
    ).join('');
  }
  function takeQuizBox(slotKey) {
    if (!$('quizBoxModal') || !$('quizBoxModal').classList.contains('show')) return;
    $('quizBoxModal').classList.remove('show');
    grantEquipBox(4, '问答连对七日奖励', slotKey);
    save();
  }

  // —— 异象秘境 ——
  function anomalyAffixes() {
    const seed = daySeed('anomaly-' + todayStr());
    const i1 = seed % ANOMALY_AFFIXES.length;
    const i2 = (seed >>> 8) % ANOMALY_AFFIXES.length;
    return i1 === i2 ? [ANOMALY_AFFIXES[i1]] : [ANOMALY_AFFIXES[i1], ANOMALY_AFFIXES[i2]];
  }
  function anomalyEnemy() {
    const affs = anomalyAffixes();
    const lv = Math.max(10, state.stageCleared);
    const req = contentReq('stage', lv) * 1.2;
    const m = { hp: 1, atk: 1, def: 1 };
    for (const a of affs) for (const k of ['hp', 'atk', 'def']) if (a[k]) m[k] *= a[k];
    const names = affs.map((a) => a.name).join('·');
    return {
      name: '异象之主·' + names,
      base: '异象之主',
      icon: '异',
      kicker: '异象秘境 · ' + names,
      boss: true,
      req,
      el: randEl(),
      affix: '',
      hp: Math.max(1, Math.round(req * 7.5 * 1.45 * m.hp)),
      atk: Math.max(1, Math.round(req * 0.75 * 1.35 * m.atk)),
      def: Math.max(0, Math.round(req * 0.22 * 1.15 * m.def)),
    };
  }
  function anomalyGrade(win, player, result) {
    if (!win) return '';
    const last = result.events.length ? result.events[result.events.length - 1].playerHp : 0;
    const ratio = player.hp > 0 ? last / player.hp : 0;
    return ratio >= 0.6 ? 'S' : ratio >= 0.25 ? 'A' : 'B';
  }
  function anomalyFight() {
    if (state.anomaly.date === todayStr() && state.anomaly.done) {
      floatText('今日异象已平', '#9aa4b2');
      return;
    }
    if (state.stageCleared < 5) {
      floatText('通关闯关第 5 关解锁', '#f87171');
      return;
    }
    const enemy = anomalyEnemy();
    const player = Object.assign({}, playerCombatStats());
    player.atk *= elementBonus(enemy.el).mult; // 与其余全部战斗入口同口径：计入五行克制
    const result = simulateBattle(player, enemy);
    const grade = anomalyGrade(result.win, player, result);
    showBattlePopup(enemy, result, {
      title: '异象秘境 · ' + enemy.kicker.split(' · ')[1],
      closeText: '收下奖励',
      loseText: '明日再战',
      rewardText: result.win ? grade + ' 级评定 · 奖励已入账' : undefined,
    });
    state.anomaly.date = todayStr();
    state.anomaly.done = true;
    state.anomaly.grade = grade;
    if (result.win) {
      if (grade === 'S' && !state.anomaly.sDays.includes(todayStr())) {
        state.anomaly.sDays.push(todayStr());
        // 月保底只读当月：旧月份条目裁掉，防 sDays 随年无界增长
        const ym = todayStr().slice(0, 7);
        state.anomaly.sDays = state.anomaly.sDays.filter((d) => d.slice(0, 7) === ym);
      }
      const affs = anomalyAffixes();
      let stone = ANOMALY_FIRST.stones;
      let dust = ANOMALY_FIRST.dust;
      let expK = ANOMALY_FIRST.expK;
      for (const a of affs) {
        if (a.stone) stone *= a.stone;
        if (a.dust) dust *= a.dust;
        if (a.exp) expK *= a.exp;
      }
      const gained = addStones(Math.floor(stone));
      addDust(Math.floor(dust));
      grantExpK(expK, '异象平定');
      let extra = grade + ' 级评定';
      if (grade === 'S' && Math.random() < ANOMALY_S_DROP) {
        grantEquipBox(5, '异象 S 级掉落');
        extra += ' · 仙品掉落！';
      }
      pushLog('异象平定（' + extra + '）：+' + fmt(gained) + ' 灵石 · ' +
        Math.floor(dust) + ' 碎屑', 'special');
      anomalyMonthBonus();
    } else {
      pushLog('异象未平，养精蓄锐明日再战', 'sys');
    }
    combatDirty = true;
    renderTrials();
    save();
  }
  // 异象月保底：当月每日皆 S 且今日为月末 → 保底仙品一件
  function anomalyMonthBonus() {
    const now = new Date();
    const y = now.getFullYear();
    const mo = now.getMonth();
    if (now.getDate() !== new Date(y, mo + 1, 0).getDate()) return;
    const dim = now.getDate();
    const sSet = new Set(state.anomaly.sDays);
    let full = true;
    for (let d = 1; d <= dim; d++) {
      if (!sSet.has(dateOf(y, mo, d))) { full = false; break; }
    }
    if (full && state.anomaly.bonusMonth !== monthKey()) {
      state.anomaly.bonusMonth = monthKey();
      grantEquipBox(5, '异象全勤月保底');
    }
  }

  // —— 灵气盈满 ——
  function vigorTick() {
    if (document.hidden) return;
    const today = todayStr();
    if (state.vigor.date !== today) {
      state.vigor = { date: today, minutes: 0, claimed: 0, lastMs: Date.now() };
    }
    const now = Date.now();
    if (now - (state.vigor.lastMs || 0) >= 60000) {
      const gain = Math.floor((now - state.vigor.lastMs) / 60000);
      state.vigor.lastMs = now;
      const cap = VIGOR_CELL_MIN * VIGOR_CELL_N;
      if (state.vigor.minutes < cap) {
        state.vigor.minutes = Math.min(cap, state.vigor.minutes + gain);
        renderDailyExt();
      }
    }
  }
  function claimVigor() {
    const today = todayStr();
    if (state.vigor.date !== today) return;
    const cells = Math.min(VIGOR_CELL_N, Math.floor(state.vigor.minutes / VIGOR_CELL_MIN));
    if (state.vigor.claimed >= cells) {
      floatText('灵气尚未盈满', '#9aa4b2');
      return;
    }
    state.vigor.claimed++;
    const gained = addStones(VIGOR_REWARD.stones);
    addDust(VIGOR_REWARD.dust);
    pushLog('灵气盈满（' + state.vigor.claimed + ' / ' + VIGOR_CELL_N + ' 格）：+' + fmt(gained) +
      ' 灵石 · ' + VIGOR_REWARD.dust + ' 碎屑', 'special');
    chime([659, 988]);
    renderDailyExt();
    save();
  }

  // —— 每日占卜 ——
  function fortunePick() {
    const seed = daySeed('fortune-' + todayStr());
    const total = FORTUNE_SIGNS.reduce((s, x) => s + x.w, 0);
    let acc = (seed % 100000) / 100000 * total;
    for (let i = 0; i < FORTUNE_SIGNS.length; i++) {
      acc -= FORTUNE_SIGNS[i].w;
      if (acc < 0) return i;
    }
    return 0;
  }
  function ensureFortune() {
    if (state.fortune.date !== todayStr()) {
      state.fortune = { date: todayStr(), idx: -1, claimed: false };
    }
  }
  function drawFortune() {
    ensureFortune();
    if (state.fortune.idx >= 0) return;
    state.fortune.idx = fortunePick();
    pushLog('今日运势：「' + FORTUNE_SIGNS[state.fortune.idx].name + '」', 'special');
    chime([523, 659]);
    renderDailyExt();
    save();
  }
  function claimFortune() {
    ensureFortune();
    const s = FORTUNE_SIGNS[state.fortune.idx];
    if (state.fortune.claimed || !s) return;
    state.fortune.claimed = true;
    if (s.stones) {
      const gained = addStones(s.stones);
      pushLog('占卜领签：+' + fmt(gained) + ' 灵石', 'special');
    }
    if (s.dust) {
      addDust(s.dust);
      pushLog('占卜领签：+' + s.dust + ' 碎屑（安慰奖）', 'special');
    }
    chime([784, 1046]);
    renderDailyExt();
    save();
  }

  // 天劫是否临头：last 由玩法门槛到达时起算（见主循环 5 秒巡检），每三日一临
  function tribulationDue() {
    if (!state.tribulation.last) return false;
    const days = Math.round((new Date(todayStr()) - new Date(state.tribulation.last)) / 86400000);
    if (days >= TRIBULATION_DAYS && state.tribulation.done) state.tribulation.done = false; // 三日后重开
    if (state.tribulation.done) return false;
    return days >= TRIBULATION_DAYS;
  }

  function openTribulation() {
    if (!tribulationDue()) return;
    $('tribModal').dataset.use = '0';
    renderTrib();
    $('tribModal').classList.add('show');
  }

  function renderTrib() {
    const tal = $('tribTalismans');
    const useBtn = $('tribUse');
    if (!tal || !useBtn) return;
    const use = Number($('tribModal').dataset.use || 0);
    const max = Math.min(state.talismans, 3);
    tal.textContent = '护体符 ×' + state.talismans + ' · 本次动用 ' + use +
      '（承伤 -' + Math.round(use * TALISMAN_REDUCE * 100) + '%）';
    tal.className = 'hint' + (max ? '' : ' title-empty');
    useBtn.disabled = use >= max;
    useBtn.textContent = '动用护体符（-15%）';
  }

  function craftTalisman() {
    if (state.dust < TALISMAN_COST) {
      floatText('碎屑不足', '#f87171');
      return;
    }
    state.dust -= TALISMAN_COST;
    state.talismans++;
    pushLog('炼成护体符 ×1', 'sys');
    beep(700, 0.07);
    renderTrib();
    render();
    save();
  }

  function fightTribulation() {
    if (!tribulationDue()) return;
    const use = Math.min(3, Number($('tribModal').dataset.use || 0));
    const st = playerCombatStats();
    const enemy = {
      name: '九霄神雷',
      base: '九霄神雷',
      icon: '雷',
      kicker: '天劫 · 三日一临',
      boss: true,
      req: Math.round(st.atk * 3 + st.hp * 0.2),
      el: 'shui',
      affix: '',
      hp: Math.max(1, Math.round(st.atk * 5 + 200)),
      atk: Math.max(1, Math.round(st.hp * 0.045 + 50)),
      def: 0,
    };
    const player = Object.assign({}, st);
    player.atk *= elementBonus(enemy.el).mult;
    const result = simulateBattle(player, enemy);
    const tribStones = Math.max(20000, Math.floor(st.power * 10));
    showBattlePopup(enemy, result, {
      title: '天劫防御战', playerHp: player.hp,
      closeText: '收下奖励', loseText: '离开',
      rewardText: result.win ? '+' + fmt(tribStones) + ' 灵石 · +300 碎屑 · +2 招募券' : undefined,
    });
    const taken = Math.round(result.taken * (1 - use * TALISMAN_REDUCE));
    if (result.win) {
      state.talismans = Math.max(0, state.talismans - use);
      state.tribulation.done = true;
      state.tribulation.last = todayStr();
      addStones(tribStones);
      addDust(300);
      state.petTickets += 2;
      state.bestiary[enemy.base] = (state.bestiary[enemy.base] || 0) + 1;
      pushLog('天劫已渡：+' + fmt(tribStones) + ' 灵石 · 300 碎屑 · 2 张招募券', 'special');
      chime([659, 784, 1046, 1318]);
      $('tribTitle').textContent = '天劫已渡';
      $('tribBody').innerHTML = '<p>九霄神雷散去，云开月明。<b>+' + fmt(tribStones) + '</b> 灵石 · 300 碎屑 · 2 张招募券已入囊中。三日后再临。</p>' +
        '<button class="btn primary wide" id="tribCloseBtn">收下</button>';
    } else {
      $('tribTitle').textContent = '渡劫未成';
      $('tribBody').innerHTML = '<p>神雷轰体，你且战且退——未伤根本，可再战。本次承受 <b>' + fmt(taken) + '</b> 伤害。</p>' +
        '<button class="btn primary wide" id="tribCloseBtn">再战</button>';
      beep(220, 0.12);
    }
    renderTrib();
    render();
    save();
    const btn = document.getElementById('tribCloseBtn');
    if (btn) btn.addEventListener('click', () => {
      $('tribModal').classList.remove('show');
      renderTrials();
    });
  }

  // 道侣
  function giftNpc(npcId, giftId) {
    const npc = DAO_NPCS.find((n) => n.id === npcId);
    const gift = DAO_GIFTS.find((g) => g.id === giftId);
    if (!npc || !gift) return;
    if (daoBonded(npcId)) {
      floatText('已可结缘', '#9aa4b2');
      return;
    }
    if (gift.stones && state.stones < gift.stones) { floatText('灵石不足', '#f87171'); return; }
    if (gift.dust && state.dust < gift.dust) { floatText('碎屑不足', '#f87171'); return; }
    if (gift.stones) state.stones -= gift.stones;
    if (gift.dust) state.dust -= gift.dust;
    const sp = daoSpend(npcId);
    state.daoLv.spend[npcId] = {
      stones: sp.stones + (gift.stones || 0),
      dust: sp.dust + (gift.dust || 0),
    };
    const now = state.daoLv.spend[npcId];
    pushLog('赠「' + gift.name + '」予' + npc.name + '（' +
      (gift.stones
        ? '灵石礼累计 ' + fmt(now.stones) + ' / ' + fmt(DAO_MARRY_STONES)
        : '碎屑礼累计 ' + fmt(now.dust) + ' / ' + fmt(DAO_MARRY_DUST)) + '）', 'sys');
    beep(720, 0.07);
    renderDao();
    save();
  }

  function marryNpc(npcId) {
    const npc = DAO_NPCS.find((n) => n.id === npcId);
    if (!npc) return;
    if (!daoBonded(npcId)) return;
    state.daoLv.married = npcId;
    combatDirty = true;
    pushLog('与' + npc.name + '结为道侣：' + npc.desc, 'special');
    pushLog(npc.lore, 'sys');
    chime([659, 784, 1046, 1318]);
    render();
    save();
  }

  const daoBonus = (key) => {
    const m = state.daoLv.married;
    return m && DAO_BONUS[m] && DAO_BONUS[m][key] ? DAO_BONUS[m][key] : 0;
  };


  function signIn() { doSignIn('normal'); }
  function signInGamble() { doSignIn('gamble'); }

  // 赌狗签到单次掷取：返回 { tier, mult }（mult 带符号，狂赚/翻车为小数）；
  // 档位从差到好排序（bust < zero < keep < big），正果报双掷取优、负果报取劣
  function rollSignGamble() {
    const G = SIGN_GAMBLE;
    const rollTier = () => {
      const r = Math.random() * 100;
      if (r < G.pBig) return { tier: 'big', mult: G.bigMin + Math.random() * (G.bigMax - G.bigMin) };
      if (r < G.pBig + G.pKeep) return { tier: 'keep', mult: 1 };
      if (r < G.pBig + G.pKeep + G.pZero) return { tier: 'zero', mult: 0 };
      return { tier: 'bust', mult: -(G.bustMin + Math.random() * (G.bustMax - G.bustMin)) };
    };
    const rank = { bust: 0, zero: 1, keep: 2, big: 3 };
    let out = rollTier();
    const kv = karma();
    if (kv !== 0) {
      const out2 = rollTier();
      const better = kv > 0 ? rank[out.tier] >= rank[out2.tier] : rank[out.tier] <= rank[out2.tier];
      out = better ? out : out2;
    }
    return out;
  }

  function doSignIn(mode) {
    ensureDaily();
    if (state.lastSignIn === todayStr()) {
      floatText('今日已签到', '#9aa4b2');
      return;
    }
    const reward = SIGN_REWARDS[state.signInDays % SIGN_REWARDS.length];
    state.lastSignIn = todayStr();
    state.signInDays++;
    state.lastSignMode = mode;
    monthMarkToday(); // 月度朝贺记到勤
    const dayNo = ((state.signInDays - 1) % 7 + 1);
    let ds = 0;   // 灵石实际增减（正走增益结算，负为倒扣实际值）
    let du = 0;   // 碎屑实际增减
    let entry;
    if (mode === 'gamble') {
      const g = rollSignGamble();
      const stakeStones = reward.stones || 0;
      const stakeDust = reward.dust || 0;
      let cutS = 0;   // 翻车时的灵石倒扣额（供战绩「最深倒扣」用）
      if (g.tier === 'big') {
        ds = stakeStones ? addStones(Math.floor(stakeStones * g.mult)) : 0;
        du = stakeDust ? addDust(Math.floor(stakeDust * g.mult)) : 0;
        pushLog('赌狗签到 · 第 ' + dayNo + ' 天：押 ' + reward.text + ' → ×' + g.mult.toFixed(1) +
          ' 狂赚 ' + (ds ? '+' + fmt(ds) + ' 灵石' : '') + (ds && du ? ' · ' : '') +
          (du ? '+' + du + ' 碎屑' : ''), 'special');
        chime([659, 784, 1046, 1318]);
        floatText('赌狗狂赚 ×' + g.mult.toFixed(1) + '！', '#ffd479');
      } else if (g.tier === 'keep') {
        ds = stakeStones ? addStones(stakeStones) : 0;
        du = stakeDust ? addDust(stakeDust) : 0;
        pushLog('赌狗签到 · 第 ' + dayNo + ' 天：押 ' + reward.text + ' → ×1.0 原地保本', 'sys');
        chime([659, 880]);
        floatText('赌狗保本 ×1.0', '#d8b36a');
      } else if (g.tier === 'zero') {
        pushLog('赌狗签到 · 第 ' + dayNo + ' 天：押 ' + reward.text + ' → 空手而归，天台见', 'sys');
        beep(300, 0.15);
        floatText('空手而归，天台见', '#9aa4b2');
      } else {
        // 翻车：灵石直接减余额（可负债，不吃增益、不动 totalStones）；碎屑以 0 为底
        cutS = Math.floor(stakeStones * -g.mult);
        const dustBefore = state.dust;
        state.stones -= cutS;
        state.dust = Math.max(0, dustBefore - Math.floor(stakeDust * -g.mult));
        ds = -cutS;
        du = state.dust - dustBefore;
        const parts = [];
        if (cutS > 0) parts.push(fmt(cutS) + ' 灵石');
        if (du < 0) parts.push((-du) + ' 碎屑');
        pushLog('赌狗签到 · 第 ' + dayNo + ' 天：押 ' + reward.text + ' → ×' + g.mult.toFixed(1) +
          ' 翻车倒扣 ' + (parts.join(' + ') || '0') +
          (state.stones < 0 ? '，负债 ' + fmt(-state.stones) : '，余额 ' + fmt(state.stones)), 'special');
        beep(240, 0.18);
        floatText('翻车 ×' + g.mult.toFixed(1) + (state.stones < 0 ? ' 负债！' : '！'), '#f87171');
      }
      const st = state.signStats;
      st.plays++;
      if (g.tier === 'big') {
        st.big++;
        if (g.mult > st.bestMult) st.bestMult = g.mult;
      } else if (g.tier === 'keep') st.keep++;
      else if (g.tier === 'zero') st.zero++;
      else {
        st.bust++;
        if (cutS > st.worstCut) st.worstCut = cutS;
      }
      entry = { d: todayStr().slice(5), m: 'g', x: g.mult, s: ds, u: du };
    } else {
      ds = reward.stones ? addStones(reward.stones) : 0;
      du = reward.dust ? addDust(reward.dust) : 0;
      pushLog('签到 · 第 ' + dayNo + ' 天：' + reward.text, 'sys');
      chime([659, 880]);
      floatText('签到成功', '#d8b36a');
      entry = { d: todayStr().slice(5), m: 'n', s: ds, u: du };
    }
    state.signLog.unshift(entry);
    if (state.signLog.length > SIGN_LOG_MAX) state.signLog.length = SIGN_LOG_MAX;

    const milestone = SIGN_MILESTONES[state.signInDays];
    if (milestone && !state.signMilestones.includes(state.signInDays)) {
      state.signMilestones.push(state.signInDays);
      if (milestone.stones) addStones(milestone.stones);
      if (milestone.dust) addDust(milestone.dust);
      if (milestone.tickets) state.petTickets += milestone.tickets;
      pushLog('签到里程碑 ' + state.signInDays + ' 天：' + milestone.text, 'special');
      chime([659, 784, 1046, 1318]);
      floatText('里程碑 ' + state.signInDays + ' 天！', '#f0d9a8');
    }
    render();
    save();
  }

  // 战绩面板：累计计数一行 + 最近流水（与签到流水合二为一）
  function signStatsText() {
    const st = state.signStats;
    if (!st.plays) return '尚未开赌——普通签到稳，赌狗签到凶，今日敢不敢梭一把？';
    return '赌狗 ' + st.plays + ' 场 · 狂赚 ' + st.big + ' · 保本 ' + st.keep + ' · 空手 ' + st.zero +
      ' · 翻车 ' + st.bust + ' · 最佳 ×' + st.bestMult.toFixed(1) +
      (st.worstCut > 0 ? ' · 最深倒扣 ' + fmt(st.worstCut) + ' 灵石' : '');
  }

  function signLogHtml() {
    if (!state.signLog.length) return '<p class="hint">暂无流水，今日签到后开始记录。</p>';
    return state.signLog.slice(0, SIGN_LOG_SHOW).map((e) => {
      const parts = [];
      if (e.s) parts.push((e.s > 0 ? '+' : '-') + fmt(Math.abs(e.s)) + ' 灵石');
      if (e.u) parts.push((e.u > 0 ? '+' : '-') + fmt(Math.abs(e.u)) + ' 碎屑');
      const mult = e.m === 'g' ? ' ×' + e.x.toFixed(1) : '';
      return '<div class="signlog-row' + (e.s < 0 ? ' signlog-debt' : '') + '">' +
        '<span>' + e.d + ' · ' + (e.m === 'g' ? '赌狗' : '普通') + mult + '</span>' +
        '<b>' + (parts.length ? parts.join(' · ') : '空手而归') + '</b></div>';
    }).join('');
  }

  function claimTask(id) {
    ensureDaily();
    const def = DAILY_TASKS.find((t) => t.id === id);
    if (!def || state.daily.claimed.includes(id)) return;
    if ((state.daily[id] || 0) < def.target) return;
    state.daily.claimed.push(id);
    if (def.reward.stones) addStones(def.reward.stones);
    if (def.reward.dust) addDust(def.reward.dust);
    pushLog('完成日常「' + def.name + '」', 'sys');
    chime([784, 988]);
    if (state.daily.claimed.length >= DAILY_TASKS.length) {
      addStones(DAILY_ALL_BONUS.stones);
      addDust(DAILY_ALL_BONUS.dust);
      pushLog('日常全部完成：额外 +' + fmt(DAILY_ALL_BONUS.stones) + ' 灵石 · +' +
        DAILY_ALL_BONUS.dust + ' 碎屑', 'special');
      chime([659, 784, 1046]);
    }
    render();
    save();
  }

  function claimWeekly(id) {
    ensureWeekly();
    const def = WEEKLY_TASKS.find((t) => t.id === id);
    if (!def || state.weekly.claimed.includes(id)) return;
    if ((state.weekly[id] || 0) < def.target) return;
    state.weekly.claimed.push(id);
    if (def.reward.stones) addStones(def.reward.stones);
    if (def.reward.dust) addDust(def.reward.dust);
    pushLog('完成周常「' + def.name + '」', 'sys');
    chime([784, 988]);
    if (state.weekly.claimed.length >= WEEKLY_TASKS.length) {
      addStones(WEEKLY_ALL_BONUS.stones);
      addDust(WEEKLY_ALL_BONUS.dust);
      pushLog('周常全部完成：额外 +' + fmt(WEEKLY_ALL_BONUS.stones) + ' 灵石 · +' +
        WEEKLY_ALL_BONUS.dust + ' 碎屑', 'special');
      chime([659, 784, 1046]);
    }
    render();
    save();
  }

  function claimAchievement(id) {
    const a = ACHIEVEMENTS.find((x) => x.id === id);
    if (!a || state.achievements[a.id] || a.cur(state) < a.target) return;
    state.achievements[id] = true;
    if (a.stones) addStones(a.stones);
    if (a.dust) addDust(a.dust);
    if (a.trophies) state[a.trophies.field] += a.trophies.n;
    pushLog('达成成就「' + a.name + '」' +
      (a.trophies ? ' · +' + a.trophies.n + ' ' + TROPHIES[a.trophies.field === 'towerMarks' ? 'tower' : a.trophies.field === 'warMerits' ? 'stage' : 'wild'].name : ''), 'special');
    chime([784, 1046]);
    combatDirty = true;
    render();
    save();
  }

  function recruitPet(id) {
    const def = PETS.find((p) => p.id === id);
    if (!def || state.pets[id] !== undefined) return;
    if (state.petTickets < def.cost) {
      floatText('招募券不足', '#f87171');
      return;
    }
    state.petTickets -= def.cost;
    state.pets[id] = 0;
    pushLog('招募灵宠「' + def.name + '」', 'special');
    chime([659, 880, 1046]);
    render();
    save();
  }

  function feedPet(id) {
    const def = PETS.find((p) => p.id === id);
    if (!def || state.pets[id] === undefined) return;
    const lv = state.pets[id];
    if (lv >= PET_MAX_LV) return;
    const cost = petFeedCost(lv);
    if (state.stones < cost) {
      floatText('灵石不足', '#f87171');
      return;
    }
    state.stones -= cost;
    state.pets[id] = lv + 1;
    combatDirty = true;
    pushLog('「' + def.name + '」亲密度提升至 ' + (lv + 1), 'sys');
    beep(760, 0.07);
    render();
    save();
  }

  function togglePet(id) {
    if (state.pets[id] === undefined) return;
    const def = PETS.find((p) => p.id === id);
    const idx = state.activePets.indexOf(id);
    if (idx >= 0) {
      state.activePets.splice(idx, 1);
      pushLog('「' + def.name + '」收起休息', 'sys');
    } else if (state.activePets.length < state.petSlots) {
      state.activePets.push(id);
      pushLog('「' + def.name + '」出战', 'sys');
    } else {
      floatText('出战位已满', '#f87171');
      return;
    }
    combatDirty = true;
    render();
    save();
  }

  function unlockPetSlots() {
    if (state.petSlots >= 2) return;
    if (state.petTickets < PET_SLOT_COST) {
      floatText('招募券不足', '#f87171');
      return;
    }
    state.petTickets -= PET_SLOT_COST;
    state.petSlots = 2;
    pushLog('解锁第二灵宠出战位', 'special');
    chime([659, 880]);
    render();
    save();
  }

  function releasePet(id) {
    const def = PETS.find((p) => p.id === id);
    if (!def || state.pets[id] === undefined) return;
    const refund = Math.ceil(def.cost / 2);
    if (!confirm('放生「' + def.name + '」？返还 ' + refund + ' 张招募券，亲密度与信物清零。')) return;
    delete state.pets[id];
    delete state.petTokens[id];
    delete state.petCores[id]; // 内丹随放生清零（与确认文案同口径，堵重招保留漏洞）
    state.activePets = state.activePets.filter((x) => x !== id);
    state.petTickets += refund;
    combatDirty = true;
    pushLog('放生「' + def.name + '」，返还招募券 ×' + refund, 'sys');
    render();
    save();
  }

  function upgradeToken(id) {
    const def = PETS.find((p) => p.id === id);
    if (!def || state.pets[id] === undefined) return;
    const lv = state.petTokens[id] || 0;
    if (lv >= TOKEN_MAX) return;
    const cost = TOKEN_COST(lv);
    if (state.dust < cost) {
      floatText('碎屑不足', '#f87171');
      return;
    }
    state.dust -= cost;
    state.petTokens[id] = lv + 1;
    combatDirty = true;
    pushLog('「' + def.name + '」信物升至 ' + (lv + 1) + ' 级', 'sys');
    beep(760, 0.07);
    render();
    save();
  }

  /* ---------------- 功法 / 仙界轮回 / 炼丹房 ---------------- */

  function upgradeGongfa(key) {
    const def = GONGFA[key];
    if (!def || state.gongfa[key] >= def.max) return;
    const cost = gongfaCost(state.gongfa[key]);
    if (state.exp < cost) {
      floatText('修为不足', '#f87171');
      return;
    }
    state.exp -= cost;
    state.gongfa[key]++;
    combatDirty = true;
    pushLog('功法「' + def.name + '」升至 ' + state.gongfa[key] + ' 层', 'sys');
    beep(700, 0.08);
    render();
    save();
  }

  // 仙位阶梯（2026-11-01 用户指定）：上限 10 位；第 1 位 100 亿，第 10 位 50 兆，
  // 中间按几何阶梯内插：r = (50兆/100亿)^(1/9) = 5000^(1/9) ≈ 2.576，第 k 位价格 = 100亿 × r^(k-1)
  // （100亿 / 258亿 / 664亿 / 1710亿 / 4400亿 / 1.13兆 / 2.92兆 / 7.52兆 / 19.4兆 / 50兆）
  const IMMORTAL_MAX = 10;
  const IMMORTAL_RATIO = Math.pow(50e12 / 1e10, 1 / (IMMORTAL_MAX - 1));
  const immortalCost = () => state.immortal >= IMMORTAL_MAX ? Infinity
    : 1e10 * Math.pow(IMMORTAL_RATIO, state.immortal || 0);

  function enterImmortal() {
    if (state.ascensions < 1) return;
    if (state.immortal >= IMMORTAL_MAX) {
      floatText('仙位已满（' + IMMORTAL_MAX + '/' + IMMORTAL_MAX + '）', '#9aa4b2');
      return;
    }
    const cost = immortalCost();
    if (state.stones < cost) {
      floatText('灵石不足', '#f87171');
      return;
    }
    if (!confirm('入仙界消耗 ' + fmt(cost) + ' 灵石，得 1 仙位：收益 +10%，秘境敌人与产出 ×1.05。确定？')) return;
    state.stones -= cost;
    state.immortal++;
    combatDirty = true;
    equipDirty = true;
    for (const s of SLOTS) slotGemList(s.key); // 孔数 = 2 + 飞升数：飞升后各部位补一个空孔
    pushLog('入仙界成功，仙位 ' + state.immortal + '，收益 +10%，各部位宝石孔 +1', 'special');
    chime([659, 784, 1046, 1318]);
    render();
    save();
  }

  function craftElixir(id) {
    const def = ELIXIRS.find((e) => e.id === id);
    if (!def || state.elixir.crafting) return;
    if (state.stones < def.cost) {
      floatText('灵石不足', '#f87171');
      return;
    }
    state.stones -= def.cost;
    state.elixir.crafting = { id, doneAt: Date.now() + def.ms };
    pushLog('开始炼制「' + def.name + '」', 'sys');
    beep(620, 0.08);
    render();
    save();
  }

  function takeElixir(id) {
    const def = ELIXIRS.find((e) => e.id === id);
    if (!def || (state.elixir.owned[id] || 0) <= 0) return;
    if (elixirOn(state.elixir.id)) {
      floatText('丹效进行中', '#f87171');
      return;
    }
    state.elixir.owned[id]--;
    state.elixir.id = id;
    state.elixir.until = Date.now() + def.ms;
    if (state.ordeal.active === 'kuXing') {
      state.ordeal.dirty = true;
      pushLog('苦行修行破戒：服用了丹药', 'sys');
    }
    combatDirty = true;
    pushLog('服用「' + def.name + '」：' + def.desc, 'buff');
    chime([659, 988]);
    render();
    save();
  }

  /* ---------------- 秘境探幽（Roguelike） ---------------- */

  let rogueChoices = [];

  function rogueEnemy(floor) {
    const req = Math.max(80, totalPower() * 0.65) * Math.pow(1.22, floor - 1) * immortalMult();
    const boss = floor === ROGUE_FLOORS || floor % 3 === 0;
    return {
      name: (boss ? '探幽守将' : '探幽邪祟') + ' · 第 ' + floor + ' 层',
      base: '探幽邪祟',
      icon: boss ? '幽' : '影',
      kicker: '秘境探幽 · 第 ' + floor + ' / ' + ROGUE_FLOORS + ' 层',
      boss,
      req,
      el: randEl(),
      affix: '',
      hp: Math.max(1, Math.round(req * 7.5 * (boss ? 1.45 : 1))),
      atk: Math.max(1, Math.round(req * 0.75 * (boss ? 1.2 : 1))),
      def: Math.max(0, Math.round(req * 0.22 * (boss ? 1.12 : 1))),
    };
  }

  function rogueStart() {
    if (state.stageCleared < 10) {
      floatText('通关闯关第 10 关解锁', '#f87171');
      return;
    }
    if (state.rogue.run) return;
    state.rogue.run = { floor: 1, buffs: [], reviveUsed: false };
    pushLog('进入秘境探幽', 'special');
    save();
    renderTrials();
  }

  function rogueGiveup() {
    if (!state.rogue.run) return;
    const run = state.rogue.run;
    state.rogue.run = null;
    pushLog('探幽于第 ' + run.floor + ' 层收手，保住奖励', 'sys');
    save();
    renderTrials();
  }

  function rogueFight() {
    const run = state.rogue.run;
    if (!run) return;
    const floor = run.floor;
    const enemy = rogueEnemy(floor);
    const player = Object.assign({}, playerCombatStats());
    for (const id of run.buffs) {
      const b = ROGUE_BUFFS.find((x) => x.id === id);
      if (b && b.apply) b.apply(player);
    }
    const elb = elementBonus(enemy.el);
    player.atk *= elb.mult;
    let result = simulateBattle(player, enemy);
    if (!result.win && run.buffs.includes('revive') && !run.reviveUsed) {
      run.reviveUsed = true;
      result = simulateBattle(player, enemy);
      pushLog('「不灭」生效，复活再战！', 'buff');
    }
    const rogueStones = result.win
      ? Math.max(800, Math.floor(totalPower() * 2 * (1 + 0.1 * floor) * dayProdMult())) : 0;
    showBattlePopup(enemy, result, {
      title: '秘境探幽 · 第 ' + floor + ' 层', playerHp: player.hp,
      closeText: '收下奖励', loseText: '撤出秘境',
      rewardText: result.win ? '+' + fmt(rogueStones) + ' 灵石' : undefined,
    });

    if (result.win) {
      const stones = rogueStones;
      addStones(stones);
      rollBagToken('rogue');
      addTrophy('tower', 2 + floor);
      state.rogue.best = Math.max(state.rogue.best, floor);
      ensureWeekly();
      state.weekly.rogue++;
      ensureBounty();
      bountyProgress('rogue', 1);
      if (floor >= ROGUE_FLOORS) {
        addStones(stones * 3);
        addDust(150);
        addSouls(SOULS_ROGUE_CLEAR);
        state.rogue.run = null;
        pushLog('探幽通关！额外 +' + fmt(stones * 3) + ' 灵石 · 150 碎屑', 'special');
        chime([659, 784, 1046, 1318]);
        floatText('探幽通关！', '#f0d9a8');
      } else {
        if (floor % 25 === 0) {
          addDust(50);
          pushLog('探幽深处 ' + floor + ' 层里程碑：额外 +50 碎屑', 'special');
        }
        run.floor++;
        rogueChoices = rollRogueChoices(run.buffs);
        pushLog('探幽通过第 ' + floor + ' 层，+' + fmt(stones) + ' 灵石', 'special');
        openRogueChoice();
      }
    } else {
      state.rogue.run = null;
      pushLog('探幽止步第 ' + floor + ' 层，整局结束', 'sys');
      beep(220, 0.12);
    }
    combatDirty = true;
    renderTrials();
    save();
  }

  function rollRogueChoices(owned) {
    const pool = ROGUE_BUFFS.filter((b) => b.special !== 'revive' || !owned.includes('revive'));
    const picks = [];
    const copy = pool.slice();
    while (picks.length < 3 && copy.length) {
      picks.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
    }
    return picks;
  }

  function openRogueChoice() {
    if (!rogueChoices.length) return;
    const box = $('rogueChoices');
    box.innerHTML = rogueChoices.map((b) =>
      '<button class="rogue-card" data-buff="' + b.id + '">' +
        '<span class="rogue-card-name">' + b.name + '</span>' +
        '<span class="rogue-card-desc">' + b.desc + '</span>' +
      '</button>'
    ).join('');
    $('rogueModal').classList.add('show');
  }

  function pickRogueBuff(id) {
    const run = state.rogue.run;
    if (!run || !rogueChoices.some((b) => b.id === id)) return;
    run.buffs.push(id);
    rogueChoices = [];
    $('rogueModal').classList.remove('show');
    const def = ROGUE_BUFFS.find((b) => b.id === id);
    pushLog('探幽拾得神物「' + def.name + '」', 'special');
    save();
    renderTrials();
  }

  /* ---------------- 首领连战 / 条件试炼 ---------------- */

  // 跨天检查：返回 true 表示日期已翻新，调用方自行重置自己的字段
  const ensureDated = (obj) => {
    if (obj.date !== todayStr()) {
      obj.date = todayStr();
      return true;
    }
    return false;
  };

  function runBossRush() {
    if (state.stageCleared < 5) {
      floatText('通关闯关第 5 关解锁', '#f87171');
      return;
    }
    if (ensureDated(state.bossRush)) state.bossRush.grade = '';
    if (state.bossRush.grade) {
      floatText('今日已挑战', '#9aa4b2');
      return;
    }
    const levels = BOSS_RUSH_LEVELS.filter((lv) => lv <= state.stageCleared);
    if (!levels.length) return;
    const player = playerCombatStats();
    let totalRounds = 0;
    let lost = false;
    let lastBattle = null;
    for (const lv of levels) {
      const enemy = enemyFor('stage', lv);
      const p = Object.assign({}, player);
      p.atk *= elementBonus(enemy.el).mult;
      const r = simulateBattle(p, enemy);
      totalRounds += r.rounds;
      lastBattle = { enemy, r, p };
      if (!r.win) { lost = true; break; }
    }
    if (lastBattle) {
      showBattlePopup(lastBattle.enemy, lastBattle.r,
        { title: '首领连战', playerHp: lastBattle.p.hp, closeText: '离开' });
    }
    if (lost) {
      state.bossRush.grade = '败';
      pushLog('首领连战中途战败，明日再来', 'sys');
    } else {
      const per = totalRounds / levels.length;
      const grade = BOSS_RUSH_GRADES.find((g) => per <= g.max);
      state.bossRush.grade = grade.name;
      if (grade.name === 'S') state.rushS = (state.rushS || 0) + 1;
      addStones(grade.stones);
      addDust(grade.dust);
      pushLog('首领连战 ' + levels.length + ' 位 · 平均 ' + per.toFixed(1) + ' 回合 · 评级 ' + grade.name +
        '，+' + fmt(grade.stones) + ' 灵石 · ' + grade.dust + ' 碎屑', 'special');
      chime([784, 1046]);
    }
    renderTrials();
    save();
  }

  function runTrial(id) {
    const def = TRIALS.find((t) => t.id === id);
    if (!def) return;
    if (!unlockedMode(def.enemy)) {
      floatText('对应秘境未解锁', '#f87171');
      return;
    }
    if (ensureDated(state.trials)) state.trials.done = [];
    if (state.trials.done.includes(id)) {
      floatText('今日已达成', '#9aa4b2');
      return;
    }
    const enemy = enemyFor(def.enemy, currentLevel(def.enemy));
    const player = Object.assign({}, playerCombatStats());
    player.atk *= elementBonus(enemy.el).mult;
    if (def.noLs) player.lifesteal = 0;
    const result = simulateBattle(player, enemy);
    showBattlePopup(enemy, result, {
      title: '条件试炼 · ' + def.name, playerHp: player.hp,
      closeText: '收下奖励', loseText: '离开',
      rewardText: result.win ? '+' + fmt(TRIAL_REWARD.stones) + ' 灵石 · +' + TRIAL_REWARD.dust + ' 碎屑' : undefined,
    });
    let pass = result.win;
    if (id === 'swift') pass = result.win && result.rounds <= 5;
    if (id === 'wall') pass = result.win && result.taken <= player.hp * 0.3;
    if (pass) {
      state.trials.done.push(id);
      state.trialWins = (state.trialWins || 0) + 1;
      addStones(TRIAL_REWARD.stones);
      addDust(TRIAL_REWARD.dust);
      pushLog('通过「' + def.name + '」，+' + fmt(TRIAL_REWARD.stones) + ' 灵石 · ' + TRIAL_REWARD.dust + ' 碎屑', 'special');
      chime([784, 988]);
      if (state.trials.done.length >= TRIALS.length) {
        addDust(60);
        pushLog('三项试炼全通：额外 60 碎屑', 'special');
      }
    } else {
      const why = !result.win ? '战斗失败' : id === 'swift' ? '耗时 ' + result.rounds + ' 回合（需 ≤5）' : '承伤超限';
      pushLog('「' + def.name + '」未通过：' + why, 'sys');
      beep(220, 0.1);
    }
    renderTrials();
    save();
  }

  /* ---------------- 黑市 / 奇遇 / 称号 / 词条继承 ---------------- */

  const marketPicks = () => {
    // 日种子用本地日（todayStr）：原 UTC 日在东八区早 8 点才换货，与 buyMarket 的
    // 本地 0 点限购重置、问答「0 点刷新」的口径都不一致（2026-11-01 修）
    const day = Number(todayStr().replaceAll('-', '')) || 0;
    return [0, 1, 2].map((i) => MARKET_POOL[(day + i) % MARKET_POOL.length]);
  };

  function buyMarket(id) {
    if (ensureDated(state.market)) state.market.sold = [];
    if (state.market.sold.includes(id)) return;
    const item = marketPicks().find((p) => p.id === id);
    if (!item) return;
    if (state.stones < item.cost) {
      floatText('灵石不足', '#f87171');
      return;
    }
    state.stones -= item.cost;
    state.market.sold.push(id);
    if (id === 'dust') addDust(100);
    else if (id === 'dustBig') addDust(300);
    else if (id === 'ticket') state.petTickets++;
    else if (id === 'coupon') state.rerollCoupon++;
    pushLog('黑市购入「' + item.name + '」', 'sys');
    beep(700, 0.07);
    render();
    save();
  }

  function maybeAdventure() {
    if (document.hidden) return;
    if (Date.now() - (state.adventure.lastAt || 0) < ADVENTURE_COOLDOWN) return;
    if (document.querySelector('.modal.show')) return;
    if (Math.random() >= ADVENTURE_CHANCE) return;
    state.adventure.lastAt = Date.now();
    const kinds = ['treasure', 'enemy', 'merchant'];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    $('adventureModal').dataset.kind = kind;
    $('adventureModal').dataset.used = '';
    const titles = { treasure: '野外拾宝', enemy: '路遇强敌', merchant: '游商叫卖' };
    $('adventureTitle').textContent = titles[kind];
    if (kind === 'treasure') {
      const gain = Math.max(500, Math.floor(baseGain() * 240));
      $('adventureModal').dataset.gain = gain;
      $('adventureBody').innerHTML =
        '<p>山道旁有一只遗落的宝匣，打开竟是 <b>' + fmt(gain) + '</b> 灵石！</p>' +
        '<button class="btn primary wide" data-adv="take">收下</button>';
    } else if (kind === 'enemy') {
      $('adventureBody').innerHTML =
        '<p>一头邪祟拦住了去路！战胜可得 <b>80 碎屑</b>，战败毫发无损。</p>' +
        '<button class="btn primary wide" data-adv="fight">迎战</button>' +
        '<button class="btn ghost wide" data-adv="close">绕道而行</button>';
    } else {
      $('adventureBody').innerHTML =
        '<p>游商压低了嗓子：「客官，<b>100 碎屑</b> 只要 <b>1800 灵石</b>，过了这村没这店。」</p>' +
        '<button class="btn primary wide" data-adv="buy">买下</button>' +
        '<button class="btn ghost wide" data-adv="close">摇头离开</button>';
    }
    $('adventureModal').classList.add('show');
  }

  function adventureAction(action) {
    const modal = $('adventureModal');
    const kind = modal.dataset.kind;
    if (action === 'close') {
      modal.classList.remove('show');
      return;
    }
    if (kind === 'treasure' && action === 'take') {
      addStones(Number(modal.dataset.gain || 500));
      pushLog('奇遇拾宝：+' + fmt(Number(modal.dataset.gain || 500)) + ' 灵石', 'special');
      chime([784, 1046]);
      modal.classList.remove('show');
    } else if (kind === 'enemy' && action === 'fight') {
      const req = totalPower() * 0.9;
      const enemy = {
        name: '拦路邪祟', base: '拦路邪祟', icon: '邪', kicker: '奇遇 · 路遇强敌',
        boss: false, req, el: randEl(), affix: '',
        hp: Math.max(1, Math.round(req * 6.8)),
        atk: Math.max(1, Math.round(req * 0.7)),
        def: Math.max(0, Math.round(req * 0.2)),
      };
      const player = Object.assign({}, playerCombatStats());
      player.atk *= elementBonus(enemy.el).mult;
      const result = simulateBattle(player, enemy);
      showBattlePopup(enemy, result, {
        title: '奇遇 · 路遇强敌', playerHp: player.hp,
        closeText: '收下奖励', loseText: '离开',
        rewardText: result.win ? '+80 碎屑' : undefined,
      });
      if (result.win) {
        addDust(80);
        state.bestiary[enemy.base] = (state.bestiary[enemy.base] || 0) + 1;
        $('adventureBody').innerHTML =
          '<p>邪祟授首！获得 <b>80 碎屑</b>。</p>' +
          '<button class="btn primary wide" data-adv="close">收下</button>';
        chime([784, 1046]);
      } else {
        $('adventureBody').innerHTML =
          '<p>邪祟诡诈，且战且退，并未伤到你。</p>' +
          '<button class="btn primary wide" data-adv="close">离开</button>';
        beep(220, 0.12);
      }
    } else if (kind === 'merchant' && action === 'buy') {
      if (state.stones < 1800) {
        $('adventureBody').innerHTML =
          '<p>游商眯眼一扫：「灵石不够，下回吧。」</p>' +
          '<button class="btn ghost wide" data-adv="close">离开</button>';
        return;
      }
      state.stones -= 1800;
      addDust(100);
      pushLog('游商交易：-1800 灵石 +100 碎屑', 'sys');
      beep(700, 0.07);
      modal.classList.remove('show');
    }
    render();
    save();
  }

  function equipTitle(name) {
    state.title = state.title === name ? '' : name;
    render();
    save();
  }

  // 词条继承：消耗材料装备，把它的第一条词条覆盖到目标装备第一条未锁词条；
  // 费用随目标锁定条数指数递增（2026-11-01 用户指定：200 碎屑 ×2^锁数）
  const inheritCostOf = (it) =>
    Math.floor(200 * Math.pow(2, ((it && it.affixes) || []).filter((a) => a.lock).length));

  function openInherit() {
    const it = forgeTarget();
    if (!it) return;
    const materials = state.bag.filter((x) => (x.affixes || []).length && x.id !== it.id);
    const box = $('forgeInherit');
    if (!materials.length) {
      box.innerHTML = '<p class="forge-empty">背包里没有带词条的装备可作材料。</p>';
      return;
    }
    box.innerHTML =
      '<p class="forge-section-title">词条继承（材料被分解，' + inheritCostOf(it) + ' 碎屑 / 次 · 目标每锁 1 条 ×2）</p>' +
      '<div class="inherit-list">' + materials.slice(0, 6).map((m) =>
        '<div class="affix-row">' +
          '<span class="affix-name">' + esc(m.name) + '</span>' +
          '<b>' + affixDef(m.affixes[0].k).name + ' +' + fmtPct(m.affixes[0].v) + '</b>' +
          '<button class="mini" data-act="inherit" data-id="' + m.id + '">转移</button>' +
        '</div>'
      ).join('') + '</div>';
  }

  function doInherit(materialId) {
    const target = forgeTarget();
    if (!target) return;
    const idx = state.bag.findIndex((x) => x.id === materialId);
    if (idx < 0) return;
    const material = state.bag[idx];
    const src = (material.affixes || [])[0];
    if (!src) return;
    if (AFFIX_COUNT[target.r] === 0) {
      forgeMsg('该品质没有词条位');
      return;
    }
    const slotIdx = (target.affixes || []).findIndex((a) => !a.lock);
    if (slotIdx < 0) {
      forgeMsg('目标词条已全部锁定');
      return;
    }
    // 同名词条查重：继承进重复 k 会在下次读档被 sanitizeAffixes 静默去重删除，
    // 碎屑与整件材料装备白花（reroll 侧一直有 used 查重，唯独继承漏了）
    if ((target.affixes || []).some((a, i) => i !== slotIdx && a.k === src.k)) {
      forgeMsg('目标已有同类词条，无法继承');
      return;
    }
    const inheritCost = inheritCostOf(target); // 按目标当前锁定数取价（锁定多则指数递增）
    if (state.dust < inheritCost) {
      forgeMsg('碎屑不足（需 ' + inheritCost + '）');
      return;
    }
    state.dust -= inheritCost;
    target.affixes[slotIdx] = { k: src.k, v: src.v };
    state.bag.splice(idx, 1);
    if (state.ordeal.active === 'wuJiang') {
      state.ordeal.dirty = true;
      pushLog('无匠修行破戒：动用了词条继承', 'sys');
    }
    bagDirty = true;
    equipDirty = true;
    combatDirty = true;
    pushLog('继承「' + material.name + '」的' + affixDef(src.k).name + '词条至「' + target.name + '」', 'special');
    chime([659, 880]);
    openInherit();
    renderForge();
    save();
  }

  function upgradeCave(key) {
    const def = CAVE[key];
    if (!def || state.cave[key] >= def.max) return;
    const cost = caveCost(key);
    if (state.stones < cost) {
      floatText('灵石不足', '#f87171');
      return;
    }
    state.stones -= cost;
    state.cave[key]++;
    combatDirty = true;
    pushLog('洞府「' + def.name + '」升至 ' + state.cave[key] + ' 级', 'sys');
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
    wildGroupOpen = -1; // 选关后分组跟随当前所在关卡
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
    // 特殊战斗（PvP / 妖王 / 试炼等）：没有掉落与模式字段，用独立文案
    if (b.specialBattle) {
      const base = '<p>历时 <b>' + b.result.rounds + '</b> 回合 · 造成 <b>' + fmt(b.result.dealt) +
        '</b> 伤害 · 承受 <b>' + fmt(b.result.taken) + '</b> · 暴击 <b>' + b.result.crits + '</b> 次</p>';
      if (b.win) {
        // 胜利兜底文案用中性句：不传 rewardText 的特殊战斗（切磋/秘境图等）
        // 原会顶上「再接再厉」这句败北语气（2026-11-01 修）
        return '<p class="result-title">战斗胜利</p>' + base +
          '<p class="loot-line">' + (b.rewardText || '胜名已记，道途无涯。') + '</p>';
      }
      return '<p class="result-title">战斗失败</p>' + base +
        '<p>敌方剩余 <b>' + fmt(b.result.enemyLeft) + '</b> 生命 · 回去打磨一番再来。</p>';
    }
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
    if (b.specialBattle) {
      // 特殊战斗：按钮文案由调用方按「有无实际奖励」声明（无奖励不写收下战利品）
      close.textContent = b.win ? (b.closeText || '离开') : (b.loseText || b.closeText || '离开');
    } else {
      close.textContent = b.win ? '收下战利品' : '返回秘境';
    }
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

  /* ================= 战斗头像体系 ================= */
  // 主人公用故事立绘（林小凡，AI 图优先 / 内置 SVG 回退）；特定敌人复用对应立绘；
  // 其余怪物 / NPC 按名字关键词映射到自设计的 SVG 徽记（圆底剪影，配色随族系）。

  const MONSTER_ART = (() => {
    const svg = (accent, art, bg) =>
      '<svg viewBox="0 0 64 64" aria-hidden="true">' +
      '<circle cx="32" cy="32" r="30" fill="' + (bg || 'rgba(10,13,20,0.85)') + '"/>' +
      '<circle cx="32" cy="32" r="30" fill="none" stroke="' + accent + '" stroke-opacity="0.45" stroke-width="1.6"/>' +
      art + '</svg>';
    return {
      wolf: (c) => svg(c,
        '<path d="M18 26 L26 14 L30 24 L38 24 L42 14 L50 26 L48 38 L38 50 L30 50 L20 38 Z" fill="none" stroke="' + c + '" stroke-width="2.4" stroke-linejoin="round"/>' +
        '<path d="M26 32 L29 34 M38 32 L35 34" stroke="' + c + '" stroke-width="2.2"/>' +
        '<path d="M31 41 L33 41 L32 44 Z" fill="' + c + '"/>'),
      serpent: (c) => svg(c,
        '<path d="M14 44 C14 34 26 36 30 30 C34 24 28 20 32 16 C36 12 44 14 46 20 C48 26 42 28 42 32" fill="none" stroke="' + c + '" stroke-width="3" stroke-linecap="round"/>' +
        '<circle cx="40" cy="19" r="5.2" fill="' + c + '"/>' +
        '<path d="M45 16 L51 14 M45 16 L50 19" stroke="' + c + '" stroke-width="1.6"/>' +
        '<circle cx="39" cy="18" r="1.2" fill="#0b0e14"/>'),
      bird: (c) => svg(c,
        '<path d="M20 40 C18 26 28 14 42 16 C50 17 52 24 48 28 L36 32 C42 34 46 38 44 46 L34 44 C26 46 22 44 20 40 Z" fill="none" stroke="' + c + '" stroke-width="2.4" stroke-linejoin="round"/>' +
        '<path d="M48 28 L56 30 L48 33 Z" fill="' + c + '"/>' +
        '<circle cx="38" cy="24" r="1.8" fill="' + c + '"/>'),
      bug: (c) => svg(c,
        '<ellipse cx="32" cy="38" rx="9" ry="12" fill="none" stroke="' + c + '" stroke-width="2.4"/>' +
        '<circle cx="32" cy="22" r="6" fill="' + c + '"/>' +
        '<path d="M32 16 L28 9 M32 16 L36 9" stroke="' + c + '" stroke-width="1.8"/>' +
        '<path d="M24 30 L12 24 M24 36 L10 36 M24 42 L12 50 M40 30 L52 24 M40 36 L54 36 M40 42 L52 50" stroke="' + c + '" stroke-width="1.8" stroke-linecap="round"/>'),
      ape: (c) => svg(c,
        '<circle cx="20" cy="22" r="5" fill="none" stroke="' + c + '" stroke-width="2.2"/>' +
        '<circle cx="44" cy="22" r="5" fill="none" stroke="' + c + '" stroke-width="2.2"/>' +
        '<path d="M16 40 C16 26 26 18 32 18 C38 18 48 26 48 40 C48 48 40 52 32 52 C24 52 16 48 16 40 Z" fill="none" stroke="' + c + '" stroke-width="2.6"/>' +
        '<path d="M25 36 L29 38 M39 36 L35 38 M28 45 C30 47 34 47 36 45" stroke="' + c + '" stroke-width="2" fill="none" stroke-linecap="round"/>'),
      bear: (c) => svg(c,
        '<circle cx="19" cy="18" r="6" fill="none" stroke="' + c + '" stroke-width="2.4"/>' +
        '<circle cx="45" cy="18" r="6" fill="none" stroke="' + c + '" stroke-width="2.4"/>' +
        '<path d="M14 36 C14 24 22 20 32 20 C42 20 50 24 50 36 C50 46 42 52 32 52 C22 52 14 46 14 36 Z" fill="none" stroke="' + c + '" stroke-width="2.6"/>' +
        '<ellipse cx="32" cy="42" rx="8" ry="6" fill="none" stroke="' + c + '" stroke-width="2"/>' +
        '<circle cx="25" cy="32" r="1.8" fill="' + c + '"/><circle cx="39" cy="32" r="1.8" fill="' + c + '"/>'),
      cat: (c) => svg(c,
        '<path d="M18 30 L20 12 L30 22 L34 22 L44 12 L46 30 C48 42 40 50 32 50 C24 50 16 42 18 30 Z" fill="none" stroke="' + c + '" stroke-width="2.4" stroke-linejoin="round"/>' +
        '<path d="M25 34 L30 36 M39 34 L34 36" stroke="' + c + '" stroke-width="2.2"/>' +
        '<path d="M28 44 C30 46 34 46 36 44 M32 40 L32 43" stroke="' + c + '" stroke-width="1.8" fill="none" stroke-linecap="round"/>'),
      plant: (c) => svg(c,
        '<path d="M32 52 C32 40 32 28 32 16" stroke="' + c + '" stroke-width="2.6" fill="none" stroke-linecap="round"/>' +
        '<path d="M32 34 C24 32 18 26 18 18 C26 18 32 24 32 34 Z" fill="none" stroke="' + c + '" stroke-width="2.2"/>' +
        '<path d="M32 26 C40 24 46 18 46 10 C38 10 32 16 32 26 Z" fill="none" stroke="' + c + '" stroke-width="2.2"/>' +
        '<circle cx="32" cy="14" r="4" fill="' + c + '"/>'),
      guard: (c) => svg(c,
        '<path d="M18 34 C18 22 24 14 32 14 C40 14 46 22 46 34 L42 40 L22 40 Z" fill="none" stroke="' + c + '" stroke-width="2.6" stroke-linejoin="round"/>' +
        '<path d="M32 14 L32 8 M26 10 L38 10" stroke="' + c + '" stroke-width="2.2"/>' +
        '<rect x="21" y="32" width="22" height="5" rx="2" fill="' + c + '"/>' +
        '<path d="M24 46 L40 46 M27 51 L37 51" stroke="' + c + '" stroke-width="2" stroke-linecap="round"/>'),
      monk: (c) => svg(c,
        '<circle cx="32" cy="26" r="12" fill="none" stroke="' + c + '" stroke-width="2.6"/>' +
        '<path d="M22 20 C24 12 40 12 42 20" fill="none" stroke="' + c + '" stroke-width="2.2"/>' +
        '<path d="M27 28 L30 29 M37 28 L34 29" stroke="' + c + '" stroke-width="2"/>' +
        '<path d="M20 50 C22 40 42 40 44 50" fill="none" stroke="' + c + '" stroke-width="2.4"/>' +
        '<circle cx="32" cy="44" r="2" fill="' + c + '"/><circle cx="26" cy="46" r="2" fill="' + c + '"/><circle cx="38" cy="46" r="2" fill="' + c + '"/>'),
      wraith: (c) => svg(c,
        '<path d="M18 50 L18 30 C18 18 26 12 32 12 C38 12 46 18 46 30 L46 50 L40 44 L34 50 L32 44 L30 50 L24 44 Z" fill="none" stroke="' + c + '" stroke-width="2.4" stroke-linejoin="round"/>' +
        '<ellipse cx="26" cy="28" rx="3" ry="4.5" fill="' + c + '"/>' +
        '<ellipse cx="38" cy="28" rx="3" ry="4.5" fill="' + c + '"/>'),
      fire: (c) => svg(c,
        '<path d="M32 10 C38 20 46 26 46 38 C46 48 40 54 32 54 C24 54 18 48 18 38 C18 30 24 26 26 18 C28 24 32 26 32 10 Z" fill="none" stroke="' + c + '" stroke-width="2.6" stroke-linejoin="round"/>' +
        '<path d="M32 34 C35 38 38 40 38 45 C38 49 35 51 32 51 C29 51 26 49 26 45 C26 41 30 39 32 34 Z" fill="' + c + '" fill-opacity="0.5"/>'),
      beastking: (c) => svg(c,
        '<path d="M14 24 L20 10 L26 20 L32 8 L38 20 L44 10 L50 24 C52 38 44 50 32 52 C20 50 12 38 14 24 Z" fill="none" stroke="' + c + '" stroke-width="2.4" stroke-linejoin="round"/>' +
        '<path d="M25 34 L29 36 M39 34 L35 36" stroke="' + c + '" stroke-width="2.2"/>' +
        '<path d="M26 44 L30 47 L32 44 L34 47 L38 44" stroke="' + c + '" stroke-width="1.8" fill="none" stroke-linecap="round"/>'),
      yaowang: (c) => svg(c,
        '<path d="M12 22 C16 12 24 10 26 16 C28 10 36 10 38 16 C40 10 48 12 52 22 C54 36 46 46 40 48 L24 48 C18 46 10 36 12 22 Z" fill="none" stroke="' + c + '" stroke-width="2.6" stroke-linejoin="round"/>' +
        '<path d="M22 30 L28 32 M42 30 L36 32" stroke="' + c + '" stroke-width="2.6"/>' +
        '<path d="M24 40 L29 44 L32 40 L35 44 L40 40" stroke="' + c + '" stroke-width="2" fill="none" stroke-linecap="round"/>' +
        '<path d="M26 48 L26 53 M38 48 L38 53" stroke="' + c + '" stroke-width="2.4"/>'),
      xiushi: (c) => svg(c,
        '<circle cx="32" cy="26" r="12" fill="none" stroke="' + c + '" stroke-width="2.6"/>' +
        '<path d="M28 12 C28 8 36 8 36 12 L34 16 L30 16 Z" fill="' + c + '"/>' +
        '<path d="M26 26 L30 28 M38 26 L34 28" stroke="' + c + '" stroke-width="2"/>' +
        '<path d="M18 50 C20 40 44 40 46 50" fill="none" stroke="' + c + '" stroke-width="2.4"/>' +
        '<path d="M46 44 L54 36 M52 34 L56 38" stroke="' + c + '" stroke-width="1.8" stroke-linecap="round"/>'),
      jianying: (c) => svg(c,
        '<path d="M32 8 L36 34 L32 44 L28 34 Z" fill="' + c + '" fill-opacity="0.75"/>' +
        '<path d="M32 44 L32 54 M26 40 L38 40" stroke="' + c + '" stroke-width="2.2"/>' +
        '<circle cx="32" cy="32" r="24" fill="none" stroke="' + c + '" stroke-opacity="0.5" stroke-width="1.4" stroke-dasharray="4 5"/>'),
      leishen: (c) => svg(c,
        '<circle cx="32" cy="32" r="12" fill="none" stroke="' + c + '" stroke-width="2.2"/>' +
        '<path d="M34 14 L26 32 L32 32 L28 50 L40 28 L33 28 L38 14 Z" fill="' + c + '"/>'),
      void: (c) => svg(c,
        '<circle cx="32" cy="32" r="14" fill="none" stroke="' + c + '" stroke-width="2.2"/>' +
        '<circle cx="32" cy="32" r="5" fill="' + c + '"/>' +
        '<ellipse cx="32" cy="32" rx="26" ry="9" fill="none" stroke="' + c + '" stroke-width="1.6" transform="rotate(-18 32 32)"/>'),
      mo: (c) => svg(c,
        '<path d="M20 20 L26 26 M44 20 L38 26" stroke="' + c + '" stroke-width="2.4"/>' +
        '<path d="M18 34 C18 22 24 16 32 16 C40 16 46 22 46 34 C46 44 40 50 32 50 C24 50 18 44 18 34 Z" fill="none" stroke="' + c + '" stroke-width="2.6"/>' +
        '<path d="M25 32 L30 34 M39 32 L34 34" stroke="' + c + '" stroke-width="2.2"/>' +
        '<path d="M27 42 C29 44 35 44 37 42" stroke="' + c + '" stroke-width="1.8" fill="none" stroke-linecap="round"/>'),
    };
  })();

  // 名字 → 徽记族系（顺序即优先级：具体动物在前，通配人形在后）
  const MONSTER_MATCH = [
    [/剑影/, 'jianying', '#7fb3ff'],
    [/妖王/, 'yaowang', '#e8b05e'],
    [/龙|蟒|蛇|蛟/, 'serpent', '#7ee0a3'],
    [/鹏|鹫|鹰/, 'bird', '#cfd8ea'],
    [/蛛|蝎/, 'bug', '#c084fc'],
    [/猿|魈/, 'ape', '#e0a35e'],
    [/熊/, 'bear', '#c99a6b'],
    [/狼/, 'wolf', '#9fb4d0'],
    [/虎|豹|狮|貂/, 'cat', '#f0b95e'],
    [/藤|竹|树|花|木/, 'plant', '#7ee0a3'],
    [/傀|甲士|天兵|云将|卫将/, 'guard', '#8ab8ff'],
    [/僧|刑|无面/, 'monk', '#b9a58c'],
    [/星兽|虚空|古神|陨/, 'void', '#9f8fff'],
    [/魂|幽|尸|僵/, 'wraith', '#9fb0ff'],
    [/影/, 'wraith', '#9fb0ff'],
    [/王|君|帝|主|母|魔君/, 'beastking', '#f0c96b'],
    [/雷|电/, 'leishen', '#c9a6ff'],
    [/火|炎|焰|焚|熔/, 'fire', '#f4906b'],
    [/客|贼|修|者|兵|人|首|领|乾|仙|圣|官|爷/, 'xiushi', '#e8d5a8'],
  ];

  // 特殊敌人 → 故事立绘（AI 图 / 内置 SVG）；昨日之我用主人公立绘加灰滤镜
  const ENEMY_CAST_MAP = [
    [/心魔/, 'xinmo', false],
    [/修罗/, 'xiuluo', false],
    [/独眼豹/, 'baofeng', false],
    [/巡天灵官/, 'lingguan', false],
    [/守梯石翁/, 'shiweng', false],
    [/万神墓主/, 'muzhu', false],
    [/天珩帝君/, 'tianjun', false],
    [/金甲武曲/, 'wuqu', false],
    [/幽冥老祖/, 'laozu', false],
    [/天外邪神/, 'xieshen', false],
  ];

  // 小怪 / NPC 立绘：assets/m-<名>.jpg（提示词见 assets/生图提示词.md）。
  // 生成后放入 assets/ 即自动生效；缺失时自动回退关键词徽记（404 不阻塞渲染）。
  const MONSTER_IMG = {
    // 闯关 · 前六章
    '山贼': 'shanzei', '青蛇': 'qingshe', '灰狼': 'huilang', '占山虎王': 'hushanwang',
    '竹妖': 'zhuyao', '毒蛛': 'duzhu', '林魈': 'linxiao', '千年竹母': 'zhumu',
    '火鼠': 'huoshu', '炎蜥': 'yanxi', '熔岩鬼': 'rongyangui', '赤炎魔君': 'chiyanmojun',
    '雪狼': 'xuelang', '冰魄': 'bingpo', '霜巨人': 'shuangjuren', '寒霜王': 'hanshuangwang',
    '雷鹏': 'leipeng', '云将': 'yunjiang', '天兵': 'tianbing', '九霄雷帝': 'jiuxiaoleidi',
    '星兽': 'xingshou', '虚空影': 'xukongying', '古神卫': 'gushenwei', '天外墟主': 'tianwaixuzhu',
    // 闯关 · 深层（章前缀由 monsterImgOf 剥离）
    '魔卒': 'mozu', '邪灵': 'xieling', '骨将': 'gujiang', '修罗': 'xiuluo-zu',
    '噬心鬼': 'shixingui', '灭魂使': 'miehunshi', '坠仙': 'zhuixian', '渊兽': 'yuanshou',
    '夜叉': 'yecha', '石像鬼': 'shixianggui', '血瞳': 'xuetong', '傀儡师': 'kuileishi',
    '冥渊魔君': 'mingyuanmojun', '血海妖皇': 'xuehaiyaohuang', '古神遗裔': 'gushenyiyi',
    '殛仙使者': 'jixianshizhe', '神墟之主': 'shenxuzhizhu', '混沌巨兽': 'hundunjushou',
    '鸿蒙道影': 'hongmengdaoying', '太初凶神': 'taichuxiongshen',
    // 爬塔（图待生成，放入即生效）
    '守塔石傀': 'shoutashikui', '青铜甲士': 'qingtongjiashi', '噬灵藤妖': 'shilingtengyao',
    '幽影剑客': 'youyingjianke', '赤瞳妖僧': 'chitongyaoseng', '铁脊狼王': 'tiejilangwang',
    '玄冰傀儡': 'xuanbingkuilei', '焚天火灵': 'fentianhuoling', '无面刑者': 'wumianxingzhe',
    '天关卫将': 'tianguanweijiang',
    '玄铁镇塔将': 'xuantiezhenjiang', '赤焰塔主': 'chiyanatazhu', '九幽塔主': 'jiuyoutazhu',
    '太虚塔主': 'taixutazhu', '天罡塔主': 'tiangangtazhu', '镇塔仙君': 'zhenataxianjun',
    '玄天塔主': 'xuantiantazhu', '紫霄塔主': 'zixiaotazhu', '万魔塔主': 'wanmatazhu',
    '灭世塔主': 'mieshitazhu', '鸿蒙塔主': 'hongmengtazhu', '混沌塔主': 'hunduntazhu',
    '太初塔主': 'taichutazhu', '永夜塔主': 'yongyatazhu', '星陨塔主': 'xingyuntazhu',
    '黄泉塔主': 'huangquantazhu', '九阳塔主': 'jiuyangtazhu', '北冥塔主': 'beimingtazhu',
    '无极塔主': 'wujitazhu', '归墟塔主': 'guixutazhu',
    // 野外守护兽（时代前缀由 monsterImgOf 剥离）
    '青狼': 'qinglang', '尸鹫': 'shijiu', '毒鳄': 'due', '沙蝎': 'shaxie', '幽魂': 'youhun',
    '雪熊': 'xuexiong', '雷蟒': 'leimang', '火狮': 'huoshi', '冥龙': 'minglong',
    '虚空兽': 'xukongshou', '太古兽王': 'taigushouwang',
    // 试炼与探幽
    '昨日之我': 'zuorizhiwo', '九霄神雷': 'jiuxiaoshenlei',
    '探幽邪祟': 'tanyouxiesui', '探幽守将': 'tanyoushoujiang',
    // 天下妖王
    '噬山妖王': 'shishanyaowang', '赤渊妖王': 'chiyuanyaowang', '玄冥妖王': 'xuanmingyaowang',
    '烛阴妖王': 'zhuyinyaowang', '穷奇妖王': 'qiongqiyaowang', '梼杌妖王': 'taowuyaowang',
    '饕餮妖王': 'taotieyaowang', '浑沌妖王': 'hundunyaowang',
    '墨麟凶兽': 'molinxiongshou', '血瞳凶兽': 'xuetongxiongshou', '赤炎凶兽': 'chiyanxiongshou',
    '玄冰凶兽': 'xuanbingxiongshou', '幽冥凶兽': 'youmingxiongshou', '狂岚凶兽': 'kuanglanxiongshou',
    '裂山凶兽': 'lieshanxiongshou', '噬魂凶兽': 'shihunxiongshou',
    // 故事模式 · 敌人（红尘录 30 卷，有人物立绘的走 ENEMY_CAST_MAP）
    '山贼刀客': 'shanzeidaoke', '黑风二当家': 'heifengerdangjia', '毒蛛精': 'duzhujing',
    '血影卫首领': 'xueyingweishouling', '妖修·貂爷': 'diaoye', '血手修罗·分身': 'xiuluofenshen',
    '赵乾': 'zhaoqian', '雷无涯': 'leiwuya', '幽冥傀儡': 'youmingkuilei',
    '熔岩鬼将': 'rongyanguijiang', '幽冥刺客': 'youmingcike', '寒霜王·傀': 'hanshuangwang-ji',
    '九霄云将': 'jiuxiaoyunjiang', '九霄雷帝·念': 'jiuxiaoleidi-nian', '星兽王': 'xingshouwang',
    '邪神之影': 'xieshenzhiying', '墟魉': 'xuliang', '落星傀儡': 'luoxingkuilei',
    '裂天魉王': 'liestianliangwang', '天兵什长': 'tianbingshizhang', '天兵都尉': 'tianbingduwei',
    '降魔枪骑': 'xiangmoqiangji', '焰纹重骑': 'yanwenzhongji', '降魔元帅': 'xiangmoyuanshuai',
    '罡风隼': 'gangfengsun', '巡空鹫卫': 'xunkongjiuwei', '封条守偶': 'fengtiaoshouou',
    '落门残卫': 'luomencanwei', '门神巨灵': 'menshenjuling', '缉星天犬': 'jixingtianguan',
    '缉星使': 'jixingshi', '冤魂狱卒': 'yuanhunyuzu', '罚恶司': 'faesi',
    '金甲武士': 'jinjiawushi', '执戟郎将': 'zhijilangjiang', '归墟触影': 'guixuchuying',
    '蚀忆巨影': 'shiyijuying', '守档傀儡': 'shoudangkuilei', '封天死士': 'fengtiansishi',
    '溪心镜影': 'xixinjingying', '幻尘迷障': 'huanchenmizhang', '心魔·天问': 'xinmotianwen',
    '愿力蠹群': 'yuanliduqun', '夜游蚀魂': 'yeyoushihun', '噬愿蠹王': 'shiyanduwang',
    '云海风兽': 'yunhaifengshou', '誓死卫队': 'shisiweidui', '镇梯将军': 'zhentijiangjun',
    '殿前剑侍': 'dianqianjianshi', '余烬死士': 'yujinsishi', '阵灵守偶': 'zhenlingshouou',
    '窥隙暗裔': 'kuixianyiyi', '枢机圣兽': 'shujishengshou', '暗裔潮头': 'anyichaotou',
    '蚀忆巨浪': 'shiyijulang', '归墟之口': 'guixuzhikou', '墓前石俑': 'muqianshiyong',
    '噬名暗蛟': 'shiminganjiao', '灭世蝗先锋': 'mieshihuangxianfeng', '断路妖蟾': 'duoluyaochan',
    '无名游影': 'wumingyouying', '蚀空巨口': 'shikongjukou', '归墟本相': 'guixubenxiang',
    '余暗拾遗': 'yuanshiyi', '终焉试炼': 'zhongyanshilian',
    // 天梯剑影（24 名假人共用一张）
    '青锋影': 'jianying', '白衣沽酒': 'jianying', '剑廿三': 'jianying', '踏雪无痕': 'jianying',
    '醉卧沙场': 'jianying', '一剑霜寒': 'jianying', '云深不知处': 'jianying', '孤鸿影': 'jianying',
    '落叶听风': 'jianying', '剑归何处': 'jianying', '半盏流年': 'jianying', '红尘一剑': 'jianying',
    '雪满弓刀': 'jianying', '月照花林': 'jianying', '风雪夜归人': 'jianying', '千山暮雪': 'jianying',
    '剑气近': 'jianying', '听雨眠': 'jianying', '孤舟蓑笠': 'jianying', '星河入梦': 'jianying',
    '断桥残雪': 'jianying', '一苇渡江': 'jianying', '青山不改': 'jianying', '剑心通明': 'jianying',
    // 其他 NPC
    '游商': 'youshang',
  };

  // 野外时代前缀 + 深层章节前缀（最长优先），命中 m- 图前先剥掉
  const MONSTER_TIER_RE = /^(?:幽冥|煞血|古神|仙殛|神墟|混沌|鸿蒙|太初|虚空|幽|煞|狂|古|仙|神)/;

  function monsterImgOf(name) {
    const clean = String(name || '').trim();
    if (!clean) return null;
    const tried = new Set();
    const candidates = [clean];
    if (clean.includes('·')) {
      clean.split('·').forEach((seg) => { const s = seg.trim(); if (s) candidates.push(s); });
    }
    let cur = clean;
    while (true) { // 前缀可能叠两层以上，逐层剥
      const next = cur.replace(MONSTER_TIER_RE, '');
      if (!next || next === cur) break;
      candidates.push(next);
      cur = next;
    }
    for (const c of candidates) {
      if (tried.has(c)) continue;
      tried.add(c);
      if (MONSTER_IMG[c]) return MONSTER_IMG[c];
    }
    return null;
  }

  // 头像包装：AI 图 + 加载失败回退的徽记 SVG（结构同 storyPortrait，不用 lazy，守卫见 armStoryArtGuard）
  function monsterImgWrap(stem, fallbackSvg) {
    return '<div class="story-art">' +
      '<img src="assets/m-' + stem + '.jpg" alt="" draggable="false">' +
      '<template class="art-fallback">' + fallbackSvg + '</template></div>';
  }

  function monsterBadgeSvg(name, icon) {
    const text = (name || '') + (icon || '');
    for (const [re, key, color] of MONSTER_MATCH) {
      if (re.test(text)) return MONSTER_ART[key](color);
    }
    return MONSTER_ART.mo('#c9b98a');
  }

  function monsterAvatarHtml(name, icon) {
    const stem = monsterImgOf(name);
    if (stem) return monsterImgWrap(stem, monsterBadgeSvg(name, icon));
    return monsterBadgeSvg(name, icon);
  }

  function enemyAvatarHtml(enemy) {
    if (enemy && enemy.avatarSvg) return enemy.avatarSvg;
    const text = ((enemy && enemy.name) || '') + ((enemy && enemy.icon) || '');
    for (const [re, cast] of ENEMY_CAST_MAP) {
      if (re.test(text)) return storyPortrait(cast, 'battle');
    }
    return monsterAvatarHtml(enemy && enemy.name, enemy && enemy.icon);
  }

  let playerAvatarCache = null; // SP_CFG 等立绘常量声明在本块之后，首次开战再取
  function playerAvatarHtml() {
    if (!playerAvatarCache) playerAvatarCache = storyPortrait('xiaofan', 'battle');
    return playerAvatarCache;
  }

  // 通用弹层入口：战斗结果照旧即时结算，弹层只做表现。
  // closeText/loseText：结算按钮文案（按实际奖励有无定，如无奖励用「离开」）；
  // rewardText：胜利奖励行（无则显示通用鼓励语）
  function showBattlePopup(enemy, result, opts) {
    openBattleModal({
      title: opts && opts.title,
      win: result.win, // finishBattleAnimation / 结果文案都读 b.win
      player: { hp: opts && opts.playerHp },
      enemy: Object.assign({}, enemy),
      result,
      specialBattle: true,
      playerGray: !!(opts && opts.playerGray),
      closeText: opts && opts.closeText,
      loseText: opts && opts.loseText,
      rewardText: opts && opts.rewardText,
    });
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

    $('battleTitle').textContent = b.title || '战斗';
    $('battleKicker').textContent = withPlayerName(b.enemy.kicker + '「' + b.enemy.name + '」');
    $('battleRound').textContent = '准备';
    // 玩家侧名字用主角名（昵称/道号），敌名过 withPlayerName（心魔·林小凡 → 心魔·昵称）
    $('battlePlayerName').textContent = playerName();
    // 头像：主人公用故事立绘（昨日之我加灰），敌人按立绘映射 / 族系徽记
    $('battlePlayerIcon').innerHTML = playerAvatarHtml();
    armStoryArtGuard($('battlePlayerIcon'));
    $('battlePlayerIcon').classList.toggle('avatar-gray', !!b.playerGray);
    $('battleEnemyIcon').innerHTML = enemyAvatarHtml(b.enemy);
    armStoryArtGuard($('battleEnemyIcon'));
    $('battleEnemyName').textContent = withPlayerName(b.enemy.name);
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

    const speed = state.battleSpeed || 1;
    $('battleSpeed').textContent = '倍速 ×' + speed;
    if (!events.length) {
      battleTimers.push(setTimeout(() => finishBattleAnimation(b, token), 300 / speed));
      return;
    }

    const step = Math.max(26, Math.min(230, 4200 / events.length)) / speed;
    const lead = 260 / speed;
    events.forEach((ev, i) => {
      battleTimers.push(setTimeout(() => applyBattleEvent(ev, b, token), lead + i * step));
    });
    battleTimers.push(setTimeout(
      () => finishBattleAnimation(b, token),
      lead + events.length * step + 220 / speed
    ));
  }

  function replayBattleAnimation() {
    const b = lastBattles[uiMode];
    if (b) openBattleModal(b);
  }

  /* ================= 故事模式「红尘录」 ================= */

/* 故事模式「红尘录」—— 草稿 Part 1：人物志 + 立绘 v2（合入 game.js 用） */
/* 古风半身构图：小头身比 + 发髻金钗 + 交领广袖 + 腰带结，偏写实工笔画风 */
/* ================================================================== */

  // —— 人物志：立绘 + 小传（随剧情结识解锁）——
  // 立绘默认用内置手绘 SVG；若 assets/p-<id>.jpg 存在（AI 生图，提示词见 assets/生图提示词.md）
  // 则自动优先使用，加载失败回退 SVG，无需改代码。
  const STORY_IMG = {
    xiaofan: 'assets/p-xiaofan.jpg',
    qingxuan: 'assets/p-qingxuan.jpg',
    baizhi: 'assets/p-baizhi.jpg',
    wantyue: 'assets/p-wantyue.jpg',
    chen: 'assets/p-chen.jpg',
    shijian: 'assets/p-shijian.jpg',
    qian: 'assets/p-qian.jpg',
    xuanji: 'assets/p-xuanji.jpg',
    baofeng: 'assets/p-baofeng.jpg',
    xiuluo: 'assets/p-xiuluo.jpg',
    xinmo: 'assets/p-xinmo.jpg',
    laozu: 'assets/p-laozu.jpg',
    xieshen: 'assets/p-xieshen.jpg',
    lingxi: 'assets/p-lingxi.jpg',
    tianjun: 'assets/p-tianjun.jpg',
    guixu: 'assets/p-guixu.jpg',
    wangshen: 'assets/p-wangshen.jpg',
    lingguan: 'assets/p-lingguan.jpg',
    wuqu: 'assets/p-wuqu.jpg',
    shiweng: 'assets/p-shiweng.jpg',
    muzhu: 'assets/p-muzhu.jpg',
    tiandao: 'assets/p-tiandao.jpg',
  };

  // 主角名（2026-10-31 用户指定）：所有展示「林小凡/小凡」的地方统一用玩家昵称
  // （服务端显示名；未改昵称即登录道号）。cloudUser 在 authGate 登录后赋值、
  // 设置页改名后同步更新；未登录兜底原名（登录门禁下实际到不了，防裸跑）。
  function playerName() {
    return (cloudUser && String(cloudUser).trim()) || '林小凡';
  }
  // 文本替换主角名：长名在前防「小凡」先替换截断「林小凡」；只用于展示层，
  // 故事数据原文（STORY 数据、foe.name 等）保持不动
  function withPlayerName(t) {
    return String(t).replace(/林小凡|小凡/g, playerName());
  }
  // 主角名展示点统一刷新：红尘录面板简介（从原文模板填充——昵称本身可能含「小凡」，
  // 不能对替换结果二次替换）+ 当前战斗弹窗玩家名（开战时会重设，这里兜底改名即时刷新）
  function paintPlayerName() {
    const lead = $('storyLead');
    if (lead) {
      lead.textContent = '青石镇的采药少年' + playerName() +
        '，捡到一只会自己响的旧灵匣。此后山贼、魔修、老祖、邪神——挡路者，一刀一个。';
    }
    const bp = $('battlePlayerName');
    if (bp) bp.textContent = playerName();
    // 人物志卡片（主角名/简介含主角名）走 renderStory 的签名缓存，这里清掉强制重绘
    panelSigs.story = null;
    renderStory();
  }

  const STORY_CAST = {
    xiaofan: { name: '林小凡', color: '#ffd76b', brief: '青石镇采药少年，捡到一只自鸣的旧灵匣。人人叫他小虾米，后来江湖叫他——刀君。' },
    chen: { name: '陈老', color: '#d8b36a', brief: '青石镇老药农，授小凡吐纳之法。临别只说了一句：匣是死的，人是活的。' },
    shijian: { name: '石坚', color: '#e0a35e', brief: '黑风寨脚夫出身的憨汉，一身蛮力重情义。他说山是不会说话的道侣，而他愿意做你的。' },
    qingxuan: { name: '青璇', color: '#7ee0a3', brief: '幽篁林药谷的采药少女，指尖总沾着晨露。她说灵石有味道，甜的那一颗，要留给你。' },
    baizhi: { name: '白芷', color: '#8ab8ff', brief: '白衣女剑客，剑挂门口三年不出鞘。她说等你打不过的那天，她再出——后来那剑为她自己出了。' },
    wantyue: { name: '苏挽月', color: '#c9a6ff', brief: '玄天宗圣女，月下抚琴，琴声能安人心魔。全宗门都说她清冷，只有你知道她笑起来有梨涡。' },
    qian: { name: '钱多多', color: '#f0b95e', brief: '云来坊市掌柜，见人说人话见鬼说鬼话，唯独对你从不虚报价格。他说：你是我压的宝。' },
    xuanji: { name: '玄机子', color: '#9fc6e8', brief: '玄天宗掌门，观星三十年算尽天机，唯独算不到你。他说：天道缺的那一格，原来是个人。' },
    baofeng: { name: '独眼豹', color: '#e88b5e', brief: '黑风寨主，占山二十年，独眼里只有两样东西：灵石，和不肯交灵石的人。' },
    xiuluo: { name: '血手修罗', color: '#f87171', brief: '幽冥教血使，一双血手染了三城。他杀人前爱问一句：求饶，还是要个痛快？' },
    xinmo: { name: '心魔·林小凡', color: '#b48aff', brief: '道心深处那个没有光的自己。大乘之前，人人都要与它一战。' },
    laozu: { name: '幽冥老祖', color: '#8fe8c0', brief: '寒霜原冰层下沉睡三百年的魔道老祖，灵匣的上一任主人。醒来第一件事，是讨回它。' },
    xieshen: { name: '天外邪神', color: '#b48aff', brief: '天外墟深处的古神残躯，以诸天香火为食。它说：你们的道，是我遗漏的一粒尘。' },
    lingxi: { name: '灵汐', color: '#7cd8e8', brief: '神庭叛逃的周天星官，掌一夜星图。她说天上的规矩比刀快，所以她把星图偷下了天。' },
    tianjun: { name: '天珩帝君', color: '#f0d9a8', brief: '神庭摄政，旧天道座前剑侍。天道死后，他替一个死人的天，执刀十万年。' },
    guixu: { name: '归墟', color: '#a8a4b8', brief: '天幕之外无形之饿。旧天道是它最后一口食，三界是它留着的下一口。' },
    wangshen: { name: '王婶', color: '#f0b95e', brief: '青石镇饭桌的定海神针。她不懂修行，只懂一条：火没灭，就有饭；有饭，就再种。' },
    lingguan: { name: '巡天灵官', color: '#f0d9a8', brief: '巡天三万年的天庭老吏。他见过魔头与古神，却在青石镇头一回见着——全镇人肯陪着死的少年。' },
    wuqu: { name: '武曲星君', color: '#fbbf24', brief: '神庭老将，烧刀子就豪言。他说天兵的刀是护天的——最后他护住的，是三万七千个名字。' },
    shiweng: { name: '守梯石翁', color: '#9aa4b2', brief: '通天古梯的砌梯人。三万六千级台阶，他一级一级数上去的人——比天上的星还熟。' },
    muzhu: { name: '万神墓主', color: '#c8d8ff', brief: '万古诸神残念之首。他问人间值不值得，答案不是话——是桥上那一盏一盏的灯。' },
    tiandao: { name: '旧天道', color: '#ffe9a8', brief: '以身为天者。他不设殿堂不收香火，只在人间留了一只匣子，和一个问不完的问题。' },
  };
  const STORY_CAST_ORDER = ['xiaofan', 'chen', 'shijian', 'qingxuan', 'baizhi', 'wantyue', 'qian', 'xuanji', 'baofeng', 'xiuluo', 'xinmo', 'laozu', 'xieshen', 'lingxi', 'tianjun', 'guixu', 'wangshen', 'lingguan', 'wuqu', 'shiweng', 'muzhu', 'tiandao'];

  /* 脸部基础件（画在以 (100,98) 为中心、缩放 0.78 的脸组内，坐标沿用全尺寸脸） */
  const SP_JAWS = {
    slim: 'M100,54 C122,54 132,74 131,98 C130,121 120,140 100,147 C80,140 70,121 69,98 C68,74 78,54 100,54 Z',
    base: 'M100,53 C124,53 134,74 133,99 C132,123 122,142 100,149 C78,142 68,123 67,99 C66,74 76,53 100,53 Z',
    broad: 'M100,52 C127,52 137,74 136,100 C135,125 124,145 100,152 C76,145 65,125 64,100 C63,74 73,52 100,52 Z',
    round: 'M100,52 C128,52 138,76 137,102 C136,128 124,148 100,155 C76,148 64,128 63,102 C62,76 72,52 100,52 Z',
    gaunt: 'M100,54 C122,54 131,74 130,99 C129,122 119,142 100,148 C81,142 71,122 70,99 C69,74 78,54 100,54 Z',
  };

  function spDefs(u, c) {
    return '<defs>' +
      '<radialGradient id="' + u + 'bg" cx="50%" cy="30%" r="90%">' +
        '<stop offset="0" stop-color="' + c.bg[0] + '"/><stop offset="1" stop-color="' + c.bg[1] + '"/>' +
      '</radialGradient>' +
      '<linearGradient id="' + u + 'sk" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="' + c.skin[0] + '"/>' +
        '<stop offset="0.62" stop-color="' + c.skin[1] + '"/>' +
        '<stop offset="1" stop-color="' + c.skin[2] + '"/>' +
      '</linearGradient>' +
      '<radialGradient id="' + u + 'ir" cx="42%" cy="34%" r="64%">' +
        '<stop offset="0" stop-color="' + c.eyeHi + '"/>' +
        '<stop offset="0.55" stop-color="' + c.eye + '"/>' +
        '<stop offset="1" stop-color="' + c.eyeLo + '"/>' +
      '</radialGradient>' +
      '<linearGradient id="' + u + 'cl" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="' + c.cloth[0] + '"/><stop offset="1" stop-color="' + c.cloth[1] + '"/>' +
      '</linearGradient>' +
      '<linearGradient id="' + u + 'hr" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="' + c.hair[0] + '"/><stop offset="1" stop-color="' + c.hair[1] + '"/>' +
      '</linearGradient>' +
      '<linearGradient id="' + u + 'rs" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="' + (c.sash || c.trim || c.cloth[0]) + '"/>' +
        '<stop offset="1" stop-color="' + (c.sashLo || c.cloth[1]) + '"/>' +
      '</linearGradient>' +
    '</defs>';
  }

  /* 古风长袍：A 字外袍 + 广袖褶 + 白袖口 + 交领缘 + 腰带结 + 飘带 */
  function spBody(u, c) {
    const wide = c.broad ? 8 : 0;
    const slim = c.female ? 4 : 0;
    const L = 68 - wide + slim, R = 132 + wide - slim;
    const bL = 50 - wide + slim, bR = 150 + wide - slim;
    const tr = c.trim || c.cloth[0];
    const inr = c.clothIn || '#f4f1ea';
    const nk = c.broad ? 11 : 8.5;
    let s = '';
    s += '<path d="M' + (100 - nk) + ',108 L' + (100 + nk) + ',108 L' + (100 + nk + 2.5) + ',134 Q100,141 ' + (100 - nk - 2.5) + ',134 Z" fill="url(#' + u + 'sk)"/>';
    s += '<path d="M' + (100 - nk - 2.5) + ',115 Q100,127 ' + (100 + nk + 2.5) + ',115 L' + (100 + nk + 2.5) + ',126 Q100,134 ' + (100 - nk - 2.5) + ',126 Z" fill="' + c.skin[2] + '" opacity="0.38"/>';
    s += '<path d="M100,116 C' + (L + 10) + ',116 ' + (L - 2) + ',127 ' + (L - 11) + ',142 C' + (bL + 7) + ',158 ' + (bL + 1) + ',194 ' + (bL - 1) + ',240 L' + (bR + 1) + ',240 C' + (bR - 1) + ',194 ' + (bR - 7) + ',158 ' + (R + 11) + ',142 C' + (R + 2) + ',127 ' + (R - 10) + ',116 100,116 Z" fill="url(#' + u + 'cl)"/>';
    s += '<path d="M' + (L - 9) + ',146 C' + (bL + 6) + ',164 ' + (bL + 2) + ',200 ' + (bL + 1) + ',240 L' + (bL + 12) + ',240 C' + (bL + 12) + ',202 ' + (L + 2) + ',164 ' + (L + 3) + ',146 Z" fill="#000" opacity="0.15"/>';
    s += '<path d="M' + (R + 9) + ',146 C' + (bR - 6) + ',164 ' + (bR - 2) + ',200 ' + (bR - 1) + ',240 L' + (bR - 12) + ',240 C' + (bR - 12) + ',202 ' + (R - 2) + ',164 ' + (R - 3) + ',146 Z" fill="#000" opacity="0.15"/>';
    s += '<path d="M' + (L + 15) + ',148 C' + (L + 4) + ',172 ' + (bL + 9) + ',206 ' + (bL + 8) + ',238" fill="none" stroke="' + c.cloth[1] + '" stroke-width="2" opacity="0.55"/>';
    s += '<path d="M' + (R - 15) + ',148 C' + (R - 4) + ',172 ' + (bR - 9) + ',206 ' + (bR - 8) + ',238" fill="none" stroke="' + c.cloth[1] + '" stroke-width="2" opacity="0.55"/>';
    s += '<path d="M' + (bL - 1) + ',240 C' + bL + ',218 ' + (bL + 4) + ',200 ' + (bL + 10) + ',189 C' + (bL + 17) + ',201 ' + (bL + 18) + ',222 ' + (bL + 16) + ',240 Z" fill="' + inr + '" opacity="0.94"/>';
    s += '<path d="M' + (bR + 1) + ',240 C' + bR + ',218 ' + (bR - 4) + ',200 ' + (bR - 10) + ',189 C' + (bR - 17) + ',201 ' + (bR - 18) + ',222 ' + (bR - 16) + ',240 Z" fill="' + inr + '" opacity="0.94"/>';
    s += '<path d="M100,120 L' + (100 - 11) + ',240 L' + (100 + 11) + ',240 Z" fill="' + inr + '"/>';
    s += '<path d="M100,117 C92,140 88,186 87,240 L96,240 C97,186 100,142 107,126 Z" fill="' + tr + '"/>';
    s += '<path d="M100,117 C108,140 112,186 113,240 L104,240 C103,186 100,142 93,126 Z" fill="' + tr + '"/>';
    s += '<path d="M' + (bL + 8) + ',195 C84,204 116,204 ' + (bR - 8) + ',195 L' + (bR - 6) + ',212 C116,221 84,221 ' + (bL + 6) + ',212 Z" fill="url(#' + u + 'rs)"/>';
    s += '<path d="M' + (bL + 8) + ',195 C84,204 116,204 ' + (bR - 8) + ',195" fill="none" stroke="#fff" stroke-width="1" opacity="0.2"/>';
    s += '<path d="M93,205 C86,200 80,202 81,208 C82,213 89,214 94,210 Z" fill="url(#' + u + 'rs)"/>';
    s += '<path d="M107,205 C114,200 120,202 119,208 C118,213 111,214 106,210 Z" fill="url(#' + u + 'rs)"/>';
    s += '<path d="M96,213 C92,224 93,232 95,240" fill="none" stroke="url(#' + u + 'rs)" stroke-width="5" stroke-linecap="round"/>';
    s += '<path d="M104,213 C108,222 108,231 106,239" fill="none" stroke="url(#' + u + 'rs)" stroke-width="4" stroke-linecap="round" opacity="0.92"/>';
    return s;
  }

  function spHead(u, c) {
    let s = '<ellipse cx="66.5" cy="103" rx="5.6" ry="9.4" fill="url(#' + u + 'sk)"/>' +
      '<ellipse cx="133.5" cy="103" rx="5.6" ry="9.4" fill="url(#' + u + 'sk)"/>' +
      '<path d="' + SP_JAWS[c.jaw || 'base'] + '" fill="url(#' + u + 'sk)"/>' +
      '<path d="M131,99 C130,121 121,139 104,146 C118,136 127,120 128,99 Z" fill="' + c.skin[2] + '" opacity="0.3"/>' +
      '<path d="M69,99 C70,121 79,139 96,146 C82,136 73,120 72,99 Z" fill="' + c.skin[2] + '" opacity="0.22"/>' +
      '<ellipse cx="96" cy="75" rx="16" ry="9.5" fill="#fff" opacity="0.13"/>' +
      '<ellipse cx="100" cy="142.5" rx="9" ry="3.6" fill="' + c.skin[2] + '" opacity="0.24"/>';
    if (c.blush) {
      s += '<ellipse cx="78.5" cy="112.5" rx="6.4" ry="3.4" fill="#e88a80" opacity="0.17"/>' +
        '<ellipse cx="121.5" cy="112.5" rx="6.4" ry="3.4" fill="#e88a80" opacity="0.17"/>';
    }
    if (c.sunken) {
      s += '<ellipse cx="82" cy="117" rx="5.4" ry="7" fill="' + c.skin[2] + '" opacity="0.5"/>' +
        '<ellipse cx="118" cy="117" rx="5.4" ry="7" fill="' + c.skin[2] + '" opacity="0.5"/>';
    }
    return s;
  }

  function spBrows(c) {
    const w = c.browW || (c.female ? 2.2 : 3);
    const angry = c.browAngry;
    const yA = angry ? 93.4 : 91.6, yB = angry ? 89.4 : 88.4, yC = angry ? 90.2 : 90.4;
    let s = '<path d="M79,' + yA + ' Q86,' + yB + ' 93,' + yC + '" fill="none" stroke="' + c.brow + '" stroke-width="' + w + '" stroke-linecap="round"/>';
    s += '<path d="M107,' + yC + ' Q114,' + yB + ' 121,' + yA + '" fill="none" stroke="' + c.brow + '" stroke-width="' + w + '" stroke-linecap="round"/>';
    return s;
  }

  function spEyes(u, c) {
    const one = (cx, out) => {
      let s = '';
      if (c.glow) s += '<circle cx="' + cx + '" cy="97.8" r="7" fill="' + c.glow + '" opacity="0.26"/>';
      if (c.eyeShade) s += '<path d="M' + (cx - 6.6) + ',94.6 Q' + cx + ',91.2 ' + (cx + 6.6) + ',94.6" stroke="#cf7a80" stroke-width="3" opacity="0.3" fill="none" stroke-linecap="round"/>';
      s += '<path d="M' + (cx - 6.4) + ',98.4 Q' + (cx - 3) + ',94.2 ' + cx + ',94 Q' + (cx + 4.5) + ',93.8 ' + (cx + 6.2 * out) + ',96.6 Q' + (cx + 4.6 * out) + ',100.8 ' + cx + ',101.2 Q' + (cx - 4) + ',101.4 ' + (cx - 6.4) + ',98.4 Z" fill="#f5efe4"/>';
      s += '<circle cx="' + (cx + 0.6 * out) + '" cy="97.6" r="3.9" fill="url(#' + u + 'ir)"/>' +
        '<circle cx="' + (cx + 0.6 * out) + '" cy="97.6" r="1.8" fill="' + (c.glow ? '#0c060a' : '#17100c') + '"/>' +
        '<circle cx="' + (cx + 0.6 * out - 1.4) + '" cy="95.9" r="1" fill="#fff" opacity="0.95"/>' +
        '<circle cx="' + (cx + 0.6 * out + 1.6) + '" cy="99.4" r="0.55" fill="#fff" opacity="0.6"/>';
      s += '<path d="M' + (cx - 6.8) + ',98.2 Q' + (cx - 3) + ',93.6 ' + cx + ',93.4 Q' + (cx + 4.5) + ',93.2 ' + (cx + 6.8 * out) + ',96.2" fill="none" stroke="' + c.line + '" stroke-width="2.2" stroke-linecap="round"/>';
      s += '<path d="M' + (cx - 4.6) + ',101.8 Q' + cx + ',102.8 ' + (cx + 4.4) + ',101.4" fill="none" stroke="' + c.skin[2] + '" stroke-width="0.9" opacity="0.45"/>';
      if (c.female) s += '<path d="M' + (cx + 6.2 * out) + ',96.4 l' + (3 * out) + ',-2.4" stroke="' + c.line + '" stroke-width="1.6" stroke-linecap="round"/>';
      return s;
    };
    return one(86, -1) + one(114, 1);
  }

  function spNose(c) {
    return '<path d="M100,97 L100,112" stroke="' + c.skin[0] + '" stroke-width="2.4" stroke-linecap="round" opacity="0.7"/>' +
      '<path d="M95.6,116.4 Q100,120.6 104.4,116.4" fill="none" stroke="' + c.skin[2] + '" stroke-width="1.5" stroke-linecap="round" opacity="0.75"/>' +
      '<path d="M95.2,114.4 q-1.2,1.4 -0.4,2.6" fill="none" stroke="' + c.skin[2] + '" stroke-width="1" opacity="0.5"/>' +
      '<path d="M104.8,114.4 q1.2,1.4 0.4,2.6" fill="none" stroke="' + c.skin[2] + '" stroke-width="1" opacity="0.5"/>';
  }

  function spMouth(c) {
    const y = c.mouthY || 131;
    if (c.mouth === 'grin') {
      return '<path d="M91,' + y + ' Q100,' + (y + 2.6) + ' 109,' + y + ' Q100,' + (y + 10.4) + ' 91,' + y + ' Z" fill="#5e2430"/>' +
        '<path d="M93.4,' + (y + 1.4) + ' L106.6,' + (y + 1.4) + ' L105,' + (y + 5) + ' L95,' + (y + 5) + ' Z" fill="#efe8da"/>';
    }
    if (c.female) {
      return '<path d="M93.5,' + y + ' Q96.8,' + (y - 2.6) + ' 100,' + (y - 2) + ' Q103.2,' + (y - 2.6) + ' 106.5,' + y + ' Q103.2,' + (y + 1.4) + ' 100,' + (y + 1.1) + ' Q96.8,' + (y + 1.4) + ' 93.5,' + y + ' Z" fill="' + c.lip + '"/>' +
        '<path d="M95.4,' + (y + 1.6) + ' Q100,' + (y + 6.6) + ' 104.6,' + (y + 1.6) + ' Q100,' + (y + 3.4) + ' 95.4,' + (y + 1.6) + ' Z" fill="' + (c.lipLo || c.lip) + '"/>' +
        '<ellipse cx="98.6" cy="' + (y + 3) + '" rx="1.8" ry="0.7" fill="#fff" opacity="0.35"/>';
    }
    return '<path d="M94,' + (y + 0.6) + ' Q100,' + (y - 1.2) + ' 106,' + (y + 0.6) + '" fill="none" stroke="' + c.lip + '" stroke-width="2.2" stroke-linecap="round"/>' +
      '<path d="M96,' + (y + 2.8) + ' Q100,' + (y + 4.4) + ' 104,' + (y + 2.8) + '" fill="none" stroke="' + c.lip + '" stroke-width="1.2" stroke-linecap="round" opacity="0.55"/>';
  }

  /* 发型与饰件：back=头后层（不缩放），front=脸组内（随脸缩放），extra=顶层（不缩放） */
  const SP_ART = {
    xiaofan: {
      back() {
        return '<path d="M100,48 C124,48 137,66 136,94 C135,116 131,132 126,142 L74,142 C69,132 65,116 64,94 C63,66 76,48 100,48 Z" fill="url(#HR)"/>' +
          '<path d="M104,42 C126,34 144,46 148,70 C151,94 144,118 132,134 C141,112 143,90 139,70 C135,50 122,42 104,42 Z" fill="url(#HR)"/>' +
          '<path d="M136,60 C144,64 148,74 148,86" fill="none" stroke="#fff" stroke-width="1.5" opacity="0.12"/>' +
          '<rect x="100" y="40" width="14" height="5" rx="2.4" transform="rotate(8 107 42)" fill="#1c1410"/>';
      },
      front(h0) {
        return '<path d="M67,100 C63,58 78,42 100,42 C122,42 137,58 133,101 C132,92 129,84 126,77 C118,66 108,62 98,63 C104,70 106,78 104,86 C99,74 90,68 80,68 C86,76 88,84 85,92 C79,80 72,78 68,84 C66,90 66,95 67,100 Z" fill="url(#HR)"/>' +
          '<path d="M85,47 L90,34 L96,44 Z" fill="' + h0 + '"/>' +
          '<path d="M67,95 L67,112 L74,100 Z" fill="url(#HR)"/>' +
          '<path d="M133,95 C134,102 134,108 132,114 L126,102 C130,100 132,98 133,95 Z" fill="url(#HR)"/>';
      },
      extra() {
        return '<path d="M93,172 Q100,181 107,172" fill="none" stroke="#d8b36a" stroke-width="1.2" opacity="0.85"/>' +
          '<rect x="95" y="181" width="10" height="7.5" rx="1.6" fill="#8a5f24" stroke="#d8b36a" stroke-width="0.9"/>' +
          '<rect x="95" y="182.4" width="10" height="1.6" fill="#ffd76b" opacity="0.9"/>' +
          '<circle cx="100" cy="186" r="1.5" fill="#ffe9a8"/>';
      },
    },
    chen: {
      back() {
        return '<path d="M75,62 C72,74 72,85 74,96 L79,96 C76,85 76,74 78,63 Z" fill="url(#HR)"/>' +
          '<path d="M125,62 C128,74 128,85 126,96 L121,96 C124,85 124,74 122,63 Z" fill="url(#HR)"/>' +
          '<circle cx="100" cy="51" r="7" fill="url(#HR)"/>';
      },
      front(h0) {
        return '<path d="M66,94 C62,104 63,114 66,122 C70,112 70,101 69,94 Z" fill="url(#HR)"/>' +
          '<path d="M134,94 C138,104 137,114 134,122 C130,112 130,101 131,94 Z" fill="url(#HR)"/>' +
          '<path d="M73,104 C71,140 83,163 100,167 C117,163 129,140 127,104 C125,126 114,140 100,140 C86,140 75,126 73,104 Z" fill="url(#HR)"/>' +
          '<path d="M92.5,120 Q92,127 95.5,132" fill="none" stroke="' + h0 + '" stroke-width="2.6" stroke-linecap="round"/>' +
          '<path d="M107.5,120 Q108,127 104.5,132" fill="none" stroke="' + h0 + '" stroke-width="2.6" stroke-linecap="round"/>';
      },
      extra() {
        return '<rect x="99" y="44" width="2.6" height="13" rx="1.3" transform="rotate(14 100 50)" fill="#8a6a3c"/>' +
          '<path d="M124,200 a6.5,7.5 0 1 0 0.1,0 Z" fill="#a8684e" opacity="0.9"/>' +
          '<rect x="127" y="196" width="5" height="6" rx="1.5" fill="#8a6a3c"/>' +
          '<path d="M130,196 C132,206 130,212 127,216" fill="none" stroke="#8a6a3c" stroke-width="1.6"/>';
      },
    },
    shijian: {
      front() {
        return '<path d="M67,98 C62,58 78,42 100,42 C122,42 138,58 133,98 C131,86 128,77 125,71 L128,56 L118,64 L118,50 L108,60 L104,46 L97,60 L89,47 L86,61 L76,52 L78,66 L72,72 C69,78 68,88 67,98 Z" fill="url(#HR)"/>' +
          '<path d="M67,79 Q100,66 133,79 L133,91 Q100,78 67,91 Z" fill="#6e2c1c"/>' +
          '<path d="M67,91 Q100,78 133,91" fill="none" stroke="#4a1c10" stroke-width="2.2" opacity="0.8"/>';
      },
      extra() {
        return '<path d="M131,84 q9,-2 12,4 q-8,3 -12,-4 Z" fill="#6e2c1c"/>' +
          '<path d="M132,88 q8,2 9,8 q-8,-1 -9,-8 Z" fill="#5e2418"/>' +
          '<path d="M75,79 L83,97" stroke="#a06b48" stroke-width="1.7" stroke-linecap="round"/>' +
          '<path d="M76.5,84 L82,83 M78,89 L83.5,88" stroke="#a06b48" stroke-width="1.2" stroke-linecap="round"/>' +
          '<path d="M84,138 Q100,148 116,138" fill="none" stroke="#8f5f3c" stroke-width="2.6" stroke-dasharray="1.6 3.2" opacity="0.55"/>';
      },
    },
    qingxuan: {
      back() {
        return '<path d="M100,48 C128,48 140,70 139,102 C138,138 133,168 127,196 L124,206 L76,206 L73,196 C67,168 62,138 61,102 C60,70 72,48 100,48 Z" fill="url(#HR)"/>' +
          '<path d="M100,36 C112,36 121,45 120,58 C114,50 108,47 100,47 C92,47 86,50 80,58 C79,45 88,36 100,36 Z" fill="url(#HR)"/>' +
          '<path d="M76,66 C73,102 77,140 87,172" fill="none" stroke="#fff" stroke-width="1.8" opacity="0.14"/>' +
          '<path d="M124,66 C127,102 123,140 113,172" fill="none" stroke="#fff" stroke-width="1.8" opacity="0.14"/>';
      },
      front() {
        return '<path d="M100,54 C86,54 75,63 70,82 C74,74 80,68 88,65 C93,63 97,62 100,62 Z" fill="url(#HR)"/>' +
          '<path d="M100,54 C114,54 125,63 130,82 C126,74 120,68 112,65 C107,63 103,62 100,62 Z" fill="url(#HR)"/>' +
          '<path d="M72,80 C70,94 66,105 60,113 C69,110 75,98 77,86 Z" fill="url(#HR)"/>' +
          '<path d="M128,80 C130,94 134,105 140,113 C131,110 125,98 123,86 Z" fill="url(#HR)"/>' +
          '<path d="M88,64 C86,72 84,78 80,84 C87,80 90,72 91,65 Z" fill="url(#HR)"/>' +
          '<path d="M112,64 C114,72 116,78 120,84 C113,80 110,72 109,65 Z" fill="url(#HR)"/>';
      },
      extra() {
        return '<rect x="64" y="52" width="70" height="2.4" rx="1.2" transform="rotate(-11 99 53)" fill="#e2b95f"/>' +
          '<path d="M60,51 q7,-9 16,-6 q-5,9 -16,6 Z" fill="#e8c05e" stroke="#b8892e" stroke-width="1"/>' +
          '<circle cx="66" cy="47" r="2.2" fill="#f2d98a" stroke="#b8892e" stroke-width="0.8"/>' +
          '<path d="M69,57 C67,68 66,79 65,90" fill="none" stroke="#d8b36a" stroke-width="1.1"/>' +
          '<circle cx="68" cy="64" r="1.5" fill="#f2d98a"/><circle cx="67" cy="72" r="1.5" fill="#f2d98a"/><circle cx="66" cy="80" r="1.5" fill="#f2d98a"/>' +
          '<path d="M66,90 q-4,4 -1,8 q5,1 6,-4 Z" fill="#5f8f6b"/>' +
          '<path d="M129,51 C131,62 132,73 133,84" fill="none" stroke="#d8b36a" stroke-width="1.1"/>' +
          '<circle cx="130" cy="58" r="1.5" fill="#f2d98a"/><circle cx="131" cy="66" r="1.5" fill="#f2d98a"/><circle cx="132" cy="74" r="1.5" fill="#f2d98a"/>' +
          '<circle cx="132" cy="81" r="2" fill="#e88a80"/>' +
          '<g fill="#fdf6ee"><circle cx="112" cy="42" r="2"/><circle cx="116.5" cy="39.5" r="2"/><circle cx="121" cy="42" r="2"/><circle cx="119" cy="46" r="2"/><circle cx="114" cy="46" r="2"/></g>' +
          '<circle cx="116.5" cy="42.5" r="1.4" fill="#f2d98a"/>';
      },
    },
    baizhi: {
      back() {
        return '<path d="M100,48 C122,48 133,68 132,98 C131,136 127,172 122,202 L118,210 L82,210 L78,202 C73,172 69,136 68,98 C67,68 78,48 100,48 Z" fill="url(#HR)"/>' +
          '<path d="M78,66 C75,104 79,144 89,178" fill="none" stroke="#fff" stroke-width="1.6" opacity="0.13"/>' +
          '<path d="M122,66 C125,104 121,144 111,178" fill="none" stroke="#fff" stroke-width="1.6" opacity="0.13"/>';
      },
      front() {
        return '<path d="M100,56 C88,56 79,62 75,76 C81,67 90,62 99,61 Z" fill="url(#HR)"/>' +
          '<path d="M100,56 C112,56 121,62 125,76 C119,67 110,62 101,61 Z" fill="url(#HR)"/>' +
          '<path d="M74,78 C72,98 73,120 77,142 C79,120 78,98 78,82 Z" fill="url(#HR)"/>' +
          '<path d="M126,78 C128,98 127,120 123,142 C121,120 122,98 122,82 Z" fill="url(#HR)"/>';
      },
      extra() {
        return '<rect x="87" y="50" width="27" height="2.2" rx="1.1" transform="rotate(7 100 51)" fill="#c9d4e4"/>' +
          '<circle cx="114" cy="47.5" r="1.8" fill="#eef2f8"/>' +
          '<circle cx="74" cy="112" r="1.3" fill="#c9d4e4"/><path d="M74,113 v4.5" stroke="#c9d4e4" stroke-width="0.9"/>' +
          '<circle cx="126" cy="112" r="1.3" fill="#c9d4e4"/><path d="M126,113 v4.5" stroke="#c9d4e4" stroke-width="0.9"/>' +
          '<g transform="rotate(26 151 148)"><rect x="147.8" y="108" width="6.4" height="33" rx="3" fill="#2c3440"/><rect x="146.7" y="108" width="2.2" height="33" fill="#4a5a74" opacity="0.85"/><rect x="141.5" y="138" width="20" height="4.6" rx="2" fill="#8a97ab"/><circle cx="151" cy="106" r="3.2" fill="#c9d4e4"/></g>' +
          '<path d="M76,144 L121,206" stroke="#3a4454" stroke-width="3.6" opacity="0.5"/>';
      },
    },
    wantyue: {
      back() {
        return '<path d="M100,48 C128,48 140,68 139,98 C138,136 134,172 129,204 L125,214 L75,214 L71,204 C66,172 62,136 61,98 C60,68 72,48 100,48 Z" fill="url(#HR)"/>' +
          '<path d="M100,36 C113,36 122,46 121,59 C115,51 108,48 100,48 C92,48 85,51 79,59 C78,46 87,36 100,36 Z" fill="url(#HR)"/>' +
          '<path d="M77,64 C74,106 78,150 88,188" fill="none" stroke="#fff" stroke-width="1.8" opacity="0.28"/>' +
          '<path d="M123,64 C126,106 122,150 112,188" fill="none" stroke="#fff" stroke-width="1.8" opacity="0.28"/>';
      },
      front() {
        return '<path d="M100,56 C88,56 79,62 75,77 C81,67 90,62 99,61 Z" fill="url(#HR)"/>' +
          '<path d="M100,56 C112,56 121,62 125,77 C119,67 110,62 101,61 Z" fill="url(#HR)"/>' +
          '<path d="M84,69 A19,17 0 0 1 116,69" fill="none" stroke="#d8c26a" stroke-width="2"/>' +
          '<circle cx="87" cy="66.5" r="1.2" fill="#efe0a8"/><circle cx="93.5" cy="63" r="1.2" fill="#efe0a8"/>' +
          '<circle cx="106.5" cy="63" r="1.2" fill="#efe0a8"/><circle cx="113" cy="66.5" r="1.2" fill="#efe0a8"/>' +
          '<circle cx="102.5" cy="70.5" r="4.2" fill="#e8c05e"/><circle cx="104.2" cy="69" r="3.4" fill="#f6ecd8"/>';
      },
      extra() {
        return '<path d="M64,52 C62,64 61,76 61,88 M136,52 C138,64 139,76 139,88" fill="none" stroke="#c9c2e0" stroke-width="1.1"/>' +
          '<circle cx="61" cy="92" r="2" fill="#eef2f8"/><circle cx="139" cy="92" r="2" fill="#eef2f8"/>' +
          '<path d="M26,232 C40,178 74,158 100,158 C126,158 160,178 174,232" fill="none" stroke="#f6f2fa" stroke-width="5" opacity="0.85"/>' +
          '<path d="M26,232 C40,178 74,158 100,158 C126,158 160,178 174,232" fill="none" stroke="#d8c26a" stroke-width="1.2" opacity="0.6"/>';
      },
    },
    qian: {
      front(h0) {
        return '<path d="M74,80 C72,62 84,52 100,52 C116,52 128,62 126,80 C118,66 110,62 100,62 C90,62 82,66 74,80 Z" fill="url(#HR)"/>' +
          '<path d="M87,122.5 Q94,119.5 98.5,123.5" fill="none" stroke="#1e1a16" stroke-width="2" stroke-linecap="round"/>' +
          '<path d="M113,122.5 Q106,119.5 101.5,123.5" fill="none" stroke="#1e1a16" stroke-width="2" stroke-linecap="round"/>' +
          '<path d="M86,147 Q100,155 114,147" fill="none" stroke="' + h0 + '" stroke-width="2" opacity="0.3"/>';
      },
      extra() {
        return '<path d="M76,54 C76,36 86,27 100,27 C114,27 124,36 124,54 Z" fill="#241f1c"/>' +
          '<rect x="73" y="50" width="54" height="7" rx="2.5" fill="#241f1c"/>' +
          '<path d="M76,54 C76,36 86,27 100,27 C114,27 124,36 124,54 Z" fill="none" stroke="#3a332c" stroke-width="1.2"/>' +
          '<circle cx="100" cy="36" r="3.4" fill="#d8b36a" stroke="#8a5f24" stroke-width="0.8"/>' +
          '<circle cx="100" cy="30.5" r="1.6" fill="#a8302a"/>';
      },
    },
    xuanji: {
      back() {
        return '<circle cx="100" cy="48" r="9" fill="url(#HR)"/>' +
          '<path d="M74,56 C70,70 70,84 72,96 L78,96 C75,84 75,70 78,58 Z" fill="url(#HR)"/>' +
          '<path d="M126,56 C130,70 130,84 128,96 L122,96 C125,84 125,70 122,58 Z" fill="url(#HR)"/>';
      },
      front() {
        return '<path d="M68,96 C64,56 80,44 100,44 C120,44 136,56 132,96 C130,78 125,66 100,64 C75,66 70,78 68,96 Z" fill="url(#HR)"/>' +
          '<path d="M80,112 C80,142 88,161 100,165 C112,161 120,142 120,112 C116,126 108,133 100,133 C92,133 84,126 80,112 Z" fill="url(#HR)"/>';
      },
      extra() {
        return '<path d="M89,52 L111,52 L107,36 L93,36 Z" fill="#3a4668" stroke="#8fa3c0" stroke-width="1.2"/>' +
          '<path d="M91,52 L109,52" stroke="#d8c26a" stroke-width="1.6"/>' +
          '<path d="M93,36 q7,-6 14,0" fill="none" stroke="#c8d2e0" stroke-width="2"/>' +
          '<circle cx="100" cy="32.5" r="2" fill="#f2d98a"/>';
      },
    },
    baofeng: {
      front() {
        return '<path d="M64,104 L58,82 L70,87 L64,62 L80,72 L82,46 L94,62 L100,34 L107,62 L118,44 L121,68 L135,56 L131,82 L142,78 L136,104 C130,72 118,58 100,58 C82,58 70,72 64,104 Z" fill="url(#HR)"/>' +
          '<path d="M66,83 L134,95" stroke="#17100a" stroke-width="4.4" stroke-linecap="round"/>' +
          '<path d="M119,92 L133,122" stroke="#17100a" stroke-width="3.6" stroke-linecap="round"/>' +
          '<rect x="105" y="85.5" width="24" height="18" rx="4.5" fill="#17100a" stroke="#3a2c1e" stroke-width="1.4"/>' +
          '<path d="M73,83 L87,99" stroke="#a06b48" stroke-width="1.7" stroke-linecap="round"/>' +
          '<path d="M75,88 L81,87 M79,93 L85,92" stroke="#a06b48" stroke-width="1.2" stroke-linecap="round"/>' +
          '<path d="M83,138 Q100,149 117,138" fill="none" stroke="#2e2018" stroke-width="3" stroke-dasharray="1.6 3" opacity="0.6"/>';
      },
      extra() {
        return '<path d="M46,178 C56,168 76,164 90,170 L84,196 C68,192 54,188 46,178 Z" fill="#8a6038" opacity="0.5"/>' +
          '<g fill="#5c4630"><circle cx="58" cy="176" r="2.2"/><circle cx="70" cy="171" r="2"/><circle cx="80" cy="176" r="2.2"/><circle cx="66" cy="184" r="2"/><circle cx="78" cy="185" r="1.8"/></g>';
      },
    },
    xiuluo: {
      back() {
        return '<path d="M100,16 C58,16 38,56 42,108 C44,146 56,172 74,180 L126,180 C144,172 156,146 158,108 C162,56 142,16 100,16 Z" fill="url(#CL)"/>' +
          '<path d="M100,16 C58,16 38,56 42,108 C44,146 56,172 74,180 L81,180 C62,168 52,144 50,108 C48,60 66,24 100,24 Z" fill="#000" opacity="0.3"/>' +
          '<ellipse cx="100" cy="100" rx="47" ry="60" fill="#140609"/>';
      },
      front() {
        return '<path d="M61,92 C58,114 60,132 65,148 C62,128 62,108 64,92 Z" fill="url(#HR)"/>' +
          '<path d="M139,92 C142,114 140,132 135,148 C138,128 138,108 136,92 Z" fill="url(#HR)"/>' +
          '<path d="M70,114 C76,146 86,158 100,160 C114,158 124,146 130,114 C118,124 82,124 70,114 Z" fill="#4a4e58"/>' +
          '<path d="M70,114 C76,146 86,158 100,160 C114,158 124,146 130,114 C118,122 82,122 70,114 Z" fill="#fff" opacity="0.08"/>' +
          '<path d="M79,133 L95,133 M105,137 L121,137 M81,143 L97,143" stroke="#22252c" stroke-width="2" opacity="0.85" stroke-linecap="round"/>' +
          '<circle cx="78" cy="121" r="1.3" fill="#22252c"/><circle cx="122" cy="121" r="1.3" fill="#22252c"/>';
      },
      extra() {
        return '<path d="M42,110 C44,146 56,172 74,180 M158,110 C156,146 144,172 126,180" fill="none" stroke="#7a2230" stroke-width="1.6" opacity="0.7"/>' +
          '<path d="M100,16 C142,16 162,56 158,108" fill="none" stroke="#7a2230" stroke-width="1.6" opacity="0.5"/>';
      },
    },
    xinmo: {
      back() {
        return '<path d="M100,48 C128,48 141,70 140,102 C139,140 134,170 128,196 L125,206 L75,206 L72,196 C66,170 61,140 60,102 C59,70 72,48 100,48 Z" fill="url(#HR)"/>' +
          '<path d="M100,30 C113,30 122,40 121,53 C115,45 108,42 100,42 C92,42 85,45 79,53 C78,40 87,30 100,30 Z" fill="url(#HR)"/>';
      },
      front() {
        return '<path d="M67,101 C63,58 78,42 100,42 C122,42 137,58 133,101 C132,94 130,88 128,82 L124,94 L119,77 L113,92 L108,75 L103,90 L98,74 L93,90 L88,76 L83,92 L78,80 L74,90 C70,93 68,97 67,101 Z" fill="url(#HR)"/>' +
          '<path d="M79,102 Q80,110 78,117" stroke="#b48aff" stroke-width="1.6" opacity="0.5" fill="none"/>' +
          '<path d="M121,102 Q120,110 122,117" stroke="#b48aff" stroke-width="1.6" opacity="0.5" fill="none"/>';
      },
    },
    laozu: {
      back() {
        return '<path d="M100,10 C56,10 36,54 40,110 C42,150 54,176 72,184 L128,184 C146,176 158,150 160,110 C164,54 144,10 100,10 Z" fill="url(#CL)"/>' +
          '<ellipse cx="100" cy="100" rx="46" ry="60" fill="#060a08"/>';
      },
      front() {
        return '<path d="M80,112 C80,144 88,164 100,168 C112,164 120,144 120,112 C116,128 108,136 100,136 C92,136 84,128 80,112 Z" fill="url(#HR)"/>';
      },
      extra() {
        return '<path d="M40,112 C42,150 54,176 72,184 M160,112 C158,150 146,176 128,184" fill="none" stroke="#22303a" stroke-width="1.6" opacity="0.8"/>' +
          '<path d="M46,178 q7,-16 0,-30 q12,12 7,30 q-3,7 -7,0 Z" fill="#8fe8c0" opacity="0.75"/>' +
          '<path d="M154,168 q6,-13 0,-24 q10,10 6,24 q-2,6 -6,0 Z" fill="#8fe8c0" opacity="0.6"/>' +
          '<path d="M40,140 q5,-10 0,-20 q8,8 5,20 q-2,5 -5,0 Z" fill="#8fe8c0" opacity="0.45"/>';
      },
    },
    xieshen: {
      back() {
        return '<path d="M100,16 C60,16 42,54 46,108 C48,146 58,170 74,178 L126,178 C142,170 152,146 154,108 C158,54 140,16 100,16 Z" fill="url(#CL)" opacity="0.9"/>';
      },
      extra() {
        return '<path d="M68,62 C54,48 50,28 58,12 C61,32 68,48 80,58 Z" fill="#3a3352" stroke="#6a5f92" stroke-width="1.4"/>' +
          '<path d="M132,62 C146,48 150,28 142,12 C139,32 132,48 120,58 Z" fill="#3a3352" stroke="#6a5f92" stroke-width="1.4"/>' +
          '<g fill="#e6dcff"><circle cx="88" cy="74" r="1"/><circle cx="108" cy="70" r="0.9"/><circle cx="94" cy="88" r="0.8"/>' +
          '<circle cx="116" cy="84" r="1"/><circle cx="80" cy="98" r="0.8"/><circle cx="112" cy="102" r="0.9"/>' +
          '<circle cx="88" cy="112" r="0.8"/><circle cx="120" cy="114" r="0.8"/><circle cx="100" cy="64" r="0.8"/></g>' +
          '<path d="M28,236 q6,-18 2,-34 q10,14 8,34 Z" fill="#241f38" opacity="0.85"/>' +
          '<path d="M174,238 q4,-16 0,-30 q9,12 7,30 Z" fill="#241f38" opacity="0.85"/>';
      },
    },
  };

  const SP_CFG = {
    xiaofan: { jaw: 'base', skin: ['#f6ddc4', '#ecc9a8', '#c99a76'], eye: '#7a4f2c', eyeHi: '#a06a38', eyeLo: '#4a2c16', line: '#2b1d12', brow: '#33241a', hair: ['#4a3626', '#2b1d12'], lip: '#b57a62', blush: true, cloth: ['#5c584e', '#33302a'], clothIn: '#d8d2c2', trim: '#45413a', sash: '#8a2f28', sashLo: '#5e1e1a', bg: ['#26231c', '#0d111a'], aura: '#ffd76b' },
    chen: { jaw: 'gaunt', skin: ['#e8c9a8', '#d8b28c', '#a87c58'], eye: '#8a8a72', eyeHi: '#b0ae94', eyeLo: '#57544a', line: '#8f8a80', brow: '#ddd8cc', browW: 3.4, browD: 1.2, hair: ['#e8e4da', '#a8a294'], lip: '#9a7258', cloth: ['#7a7a5e', '#4a4a38'], clothIn: '#c2bd9c', trim: '#5c5c44', sash: '#6e5a38', sashLo: '#4c3e24', bg: ['#22251e', '#0d111a'], aura: '#d8b36a', wrinkles: true },
    shijian: { jaw: 'broad', skin: ['#e2b58c', '#cf9a70', '#9a6642'], eye: '#4a321e', eyeHi: '#6e4e2e', eyeLo: '#241608', line: '#241a10', brow: '#241a10', browW: 3.4, hair: ['#241a10', '#100a05'], lip: '#8a5a42', broad: true, cloth: ['#6b4a30', '#3e2a18'], clothIn: '#c2a278', trim: '#8a6038', sash: '#4a3020', sashLo: '#322012', bg: ['#2a2118', '#0d111a'], aura: '#e0a35e' },
    qingxuan: { jaw: 'slim', skin: ['#f9e4cf', '#f0d2b4', '#cfa284'], eye: '#3f8f5c', eyeHi: '#6cc08a', eyeLo: '#1f5537', line: '#182a1e', brow: '#2f4a38', hair: ['#3a5242', '#1a2c20'], lip: '#d4706a', lipLo: '#b25a56', female: true, blush: true, eyeShade: true, cloth: ['#9cc98e', '#5f9455'], clothIn: '#f6f3ea', trim: '#e8e2d2', sash: '#e8a04a', sashLo: '#c47a2c', bg: ['#1c2e22', '#0d111a'], aura: '#7ee0a3' },
    baizhi: { jaw: 'slim', skin: ['#f7e7d8', '#ecd4c2', '#c9a28e'], eye: '#4a7ab8', eyeHi: '#8ab8e8', eyeLo: '#24476e', line: '#161b24', brow: '#2c3440', hair: ['#323a46', '#151a23'], lip: '#b06a6e', lipLo: '#925258', female: true, eyeShade: true, cloth: ['#8ba3bd', '#54688a'], clothIn: '#f2f4f8', trim: '#dde4ec', sash: '#42566e', sashLo: '#2c3c50', bg: ['#1c2430', '#0d111a'], aura: '#8ab8ff' },
    wantyue: { jaw: 'slim', skin: ['#fae8da', '#f0d8c4', '#d0a890'], eye: '#7a5ab0', eyeHi: '#b098e0', eyeLo: '#3f2a66', line: '#5a5470', brow: '#8f95a8', hair: ['#c8ccd8', '#868da2'], lip: '#c4727e', lipLo: '#a85a68', female: true, blush: true, eyeShade: true, cloth: ['#b4a6d4', '#7a68a2'], clothIn: '#f6f2fa', trim: '#e6def2', sash: '#8a76b8', sashLo: '#64528e', bg: ['#241f33', '#0d111a'], aura: '#c9a6ff' },
    qian: { jaw: 'round', skin: ['#f0cdae', '#e4b68e', '#b0805a'], eye: '#3a2c1e', eyeHi: '#5a4630', eyeLo: '#1e140a', line: '#1e1a16', brow: '#1e1a16', hair: ['#1e1a16', '#0c0a07'], lip: '#a8684e', cloth: ['#a8402e', '#651f12'], clothIn: '#e8c05e', trim: '#d8a84a', sash: '#e8c05e', sashLo: '#c49a3a', bg: ['#2a1c16', '#0d111a'], aura: '#f0b95e' },
    xuanji: { jaw: 'gaunt', skin: ['#e8d4b8', '#d6bd9c', '#a8825e'], eye: '#5a7a94', eyeHi: '#8aa8c0', eyeLo: '#2e465a', line: '#8f8a80', brow: '#c8c4bc', browW: 3.2, browD: 1, hair: ['#c8c4bc', '#87827a'], lip: '#9a7258', cloth: ['#4a5a78', '#29344a'], clothIn: '#c8d2e0', trim: '#8fa3c0', sash: '#33405c', sashLo: '#232c42', bg: ['#1c2430', '#0d111a'], aura: '#9fc6e8', wrinkles: true },
    baofeng: { jaw: 'broad', skin: ['#dcae85', '#c49266', '#8a5a38'], eye: '#6e4a20', eyeHi: '#9a6e34', eyeLo: '#3a2410', line: '#16100a', brow: '#2e2018', browW: 3.4, hair: ['#2e2018', '#120c07'], lip: '#7a4a34', mouth: 'grin', broad: true, cloth: ['#5c4630', '#342414'], clothIn: '#b09468', trim: '#8a6038', sash: '#3a2c1c', sashLo: '#281e12', bg: ['#261c14', '#0d111a'], aura: '#e88b5e' },
    xiuluo: { jaw: 'gaunt', skin: ['#ecd4cc', '#d8b0a8', '#a47068'], eye: '#e83a48', eyeHi: '#ff8a94', eyeLo: '#6e0d1a', line: '#331014', glow: '#ff3a4e', brow: '#331014', browW: 3, hair: ['#5c1e22', '#2c0c10'], lip: '#7a4a44', cloth: ['#4a1620', '#20060c'], clothIn: '#651a26', trim: '#7a2230', sash: '#200810', sashLo: '#140408', bg: ['#26101a', '#0d111a'], aura: '#f87171' },
    xinmo: { jaw: 'base', skin: ['#d8d2cf', '#c4b8b8', '#8f8086'], eye: '#8a5ad0', eyeHi: '#b89ae8', eyeLo: '#3f2468', line: '#1a100a', brow: '#1a100a', hair: ['#33241a', '#160d07'], lip: '#7a5a62', cloth: ['#3f3a4a', '#211d2b'], clothIn: '#8f8898', trim: '#322d3c', sash: '#4a3f68', sashLo: '#332b4a', bg: ['#1e1a28', '#0d0b14'], aura: '#b48aff' },
    laozu: { jaw: 'gaunt', skin: ['#dfe6da', '#c2cdba', '#84967f'], eye: '#3fe8a0', eyeHi: '#8affd0', eyeLo: '#0c4c30', line: '#3a4a3c', glow: '#3fe8a0', brow: '#b8c4b4', browW: 2.6, hair: ['#c8d2c4', '#788878'], lip: '#5f7a68', sunken: true, cloth: ['#101820', '#04070a'], clothIn: '#1a242c', trim: '#22303a', sash: '#0c1218', sashLo: '#060a0e', bg: ['#0f1c17', '#070b0a'], aura: '#8fe8c0', wrinkles: true },
    xieshen: { jaw: 'base', skin: ['#4a4458', '#35304a', '#1c1830'], eye: '#b48aff', eyeHi: '#e0ccff', eyeLo: '#3f2478', line: '#0e0b1a', glow: '#b48aff', brow: '#0e0b1a', browW: 2.4, hair: ['#241f38', '#0e0b1a'], lip: '#5a5078', cloth: ['#241f38', '#0c0918'], clothIn: '#322a4c', trim: '#4a3f6e', sash: '#322a4c', sashLo: '#221c38', bg: ['#171226', '#080612'], aura: '#b48aff' },
    lingxi: { jaw: 'slim', skin: ['#f6e8dc', '#ecd4c4', '#c8a08e'], eye: '#3a9ab0', eyeHi: '#7cd8e8', eyeLo: '#1c4c5e', line: '#12222a', brow: '#2a3e46', hair: ['#3e5a66', '#1a2e36'], lip: '#c4727e', lipLo: '#a85a68', female: true, blush: true, eyeShade: true, cloth: ['#7cbcc8', '#427e8c'], clothIn: '#eef6f4', trim: '#d2e8e4', sash: '#3a8a9a', sashLo: '#26606c', bg: ['#16262e', '#0a0f14'], aura: '#7cd8e8' },
    tianjun: { jaw: 'base', skin: ['#f2ddc2', '#e2c69e', '#b08a5e'], eye: '#c8a44a', eyeHi: '#f0d98a', eyeLo: '#6e5218', line: '#2a1e0c', glow: '#f0d98a', brow: '#3a2c14', browW: 3, hair: ['#e8e0cc', '#a89e84'], lip: '#9a6e52', cloth: ['#e8e2d2', '#a8a290'], clothIn: '#f8f4e8', trim: '#d8c89a', sash: '#8a6a28', sashLo: '#5e4818', bg: ['#2a2418', '#0d0c08'], aura: '#f0d9a8' },
    guixu: { jaw: 'gaunt', skin: ['#5a5866', '#454350', '#26242e'], eye: '#c8c4d4', eyeHi: '#eeecf4', eyeLo: '#3a3846', line: '#0e0d14', glow: '#c8c4d4', brow: '#0e0d14', browW: 2.2, hair: ['#26242e', '#0e0d14'], lip: '#4a4854', sunken: true, cloth: ['#1c1a24', '#08070c'], clothIn: '#2a2836', trim: '#3a3848', sash: '#14121c', sashLo: '#0a0910', bg: ['#12101a', '#060509'], aura: '#a8a4b8' },
    wangshen: { jaw: 'round', skin: ['#f2d4b2', '#e2bd94', '#a87850'], eye: '#4a321e', eyeHi: '#6e4e2e', eyeLo: '#241608', line: '#241a10', brow: '#3a2c1c', hair: ['#b8b2a4', '#787267'], lip: '#b57a5e', blush: true, cloth: ['#8a5a3a', '#54341e'], clothIn: '#e8dcc4', trim: '#c2a278', sash: '#a84a30', sashLo: '#7a3220', bg: ['#2c2118', '#0d111a'], aura: '#f0b95e', wrinkles: true },
    lingguan: { jaw: 'gaunt', skin: ['#ecd2b0', '#dab88e', '#a07c52'], eye: '#8a6a28', eyeHi: '#c8a44a', eyeLo: '#4a360e', line: '#2a1e0c', brow: '#c8bca0', browW: 3.2, hair: ['#d8d2c0', '#9a9482'], lip: '#9a6e52', cloth: ['#c8a84a', '#7a6224'], clothIn: '#f2e8cc', trim: '#e0cc88', sash: '#8a6a28', sashLo: '#5e4818', bg: ['#2a2414', '#0d0c08'], aura: '#f0d9a8', wrinkles: true },
    wuqu: { jaw: 'broad', skin: ['#e0b28a', '#cc9a6e', '#8f6038'], eye: '#5a3a18', eyeHi: '#8a5e2a', eyeLo: '#2c1a08', line: '#1e140a', brow: '#241a10', browW: 3.6, hair: ['#2c221a', '#120d08'], lip: '#8a5842', broad: true, cloth: ['#3a3428', '#1e1a12'], clothIn: '#c8a84a', trim: '#e0b95e', sash: '#8a2f28', sashLo: '#5e1e1a', bg: ['#28221a', '#0d111a'], aura: '#fbbf24', wrinkles: true },
    shiweng: { jaw: 'gaunt', skin: ['#c2c8bc', '#a8b0a2', '#6e786c'], eye: '#5a6a5e', eyeHi: '#8aa494', eyeLo: '#2c3830', line: '#26302a', glow: '#a8d8b8', brow: '#8a9488', browW: 2.8, hair: ['#8a988c', '#546055'], lip: '#6a7a6e', cloth: ['#5c6458', '#323a32'], clothIn: '#a8b0a2', trim: '#7a8478', sash: '#4a544a', sashLo: '#323c34', bg: ['#1c241e', '#0a0d0a'], aura: '#9aa4b2', wrinkles: true },
    muzhu: { jaw: 'gaunt', skin: ['#d8dcea', '#bfc6dc', '#8a94b8'], eye: '#7a9ad8', eyeHi: '#b8d0f8', eyeLo: '#2c3a6a', line: '#141a2c', glow: '#b8d0f8', brow: '#8a94b0', browW: 2.4, hair: ['#c8d2e8', '#7a86a8'], lip: '#7a82a0', sunken: true, cloth: ['#3a4058', '#181c2e'], clothIn: '#5a6280', trim: '#7a84a8', sash: '#262c44', sashLo: '#181c2e', bg: ['#141a2c', '#080a14'], aura: '#c8d8ff', wrinkles: true },
    tiandao: { jaw: 'base', skin: ['#f4e6ce', '#e6d2ac', '#b89868'], eye: '#c8a44a', eyeHi: '#ffe9a8', eyeLo: '#6e5218', line: '#2a1e0c', glow: '#ffe9a8', brow: '#3a2c14', hair: ['#f0e8d4', '#b0a488'], lip: '#a87858', cloth: ['#e8e0c8', '#a89e80'], clothIn: '#faf4e2', trim: '#e0d4a8', sash: '#b08a30', sashLo: '#7a5e1c', bg: ['#2c2818', '#0d0c08'], aura: '#ffe9a8' },
  };

  // 图片加载失败时回退为内置 SVG（供 img 的 onerror 内联调用，需全局可见）
  // 立绘加载失败回退：error 事件不冒泡，用 document 捕获阶段委托（替代内联 onerror，兼容 CSP）
  function storyArtFail(img) {
    const box = img.parentElement;
    const tpl = box && box.querySelector('template.art-fallback');
    if (!box || !tpl) { img.remove(); return; }
    box.classList.add('art-svg');
    box.insertBefore(tpl.content.cloneNode(true), img);
    img.remove();
    tpl.remove();
  }
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.closest('.story-art')) storyArtFail(t);
  }, true);

  function storyPortrait(id, ns) {
    const fallback = storyPortraitSvg(id, ns);
    const img = STORY_IMG[id];
    if (img) {
      // 不用 loading=lazy：Chromium/WebView 对「display:none 弹层里插入、展示后才进视口」
      // 的 lazy 图偶发不触发加载（error 也不 fire），个别立绘永久空白（安卓 Edge 实测）。
      // 立绘每屏至多两张，改成立即加载；另有 armStoryArtGuard 守卫兜底。
      return '<div class="story-art">' +
        '<img src="' + img + '" alt="" draggable="false">' +
        '<template class="art-fallback">' + fallback + '</template></div>';
    }
    return '<div class="story-art art-svg">' + fallback + '</div>';
  }

  // 立绘加载守卫：缓存中的失败图（complete 且 naturalWidth=0）立即回退 SVG；
  // 停滞加载 6 秒未完成也强制回退——error 事件兜不住「压根没开加载」的情况。
  // 重复 armed 无害：图若已成功，isConnected 且 complete，守卫直接返回。
  function armStoryArtGuard(box) {
    const img = box.querySelector('img');
    if (!img) return;
    if (img.complete && img.naturalWidth === 0) { storyArtFail(img); return; }
    setTimeout(() => {
      if (!img.isConnected) return;
      if (!img.complete || img.naturalWidth === 0) storyArtFail(img);
    }, 6000);
  }

  function storyPortraitSvg(id, ns) {
    const c = SP_CFG[id];
    const art = SP_ART[id] || {};
    if (!c) return '';
    const u = 'sp_' + id + '_' + (ns || 'a') + '_';
    const sub = (str) => str
      .replace(/url\(#HR\)/g, 'url(#' + u + 'hr)')
      .replace(/url\(#CL\)/g, 'url(#' + u + 'cl)')
      .replace(/BGTOP/g, c.bg[0]);
    let s = '<svg viewBox="0 0 200 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' + esc(STORY_CAST[id] ? withPlayerName(STORY_CAST[id].name) : id) + '立绘">';
    s += spDefs(u, c);
    s += '<rect width="200" height="240" fill="url(#' + u + 'bg)"/>';
    s += '<ellipse cx="100" cy="104" rx="66" ry="86" fill="' + c.aura + '" opacity="0.08"/>';
    if (art.back) s += sub(art.back(c.hair[0], c.skin[2], c.bg[0]));
    s += spBody(u, c);
    s += '<g transform="translate(100,98) scale(0.78) translate(-100,-98)">';
    s += spHead(u, c);
    s += spBrows(c) + spEyes(u, c) + spNose(c) + spMouth(c);
    if (c.wrinkles) {
      s += '<g stroke="' + c.skin[2] + '" stroke-width="1.2" fill="none" opacity="0.4">' +
        '<path d="M85,67 Q100,62 115,67"/><path d="M87,73 Q100,68.5 113,73"/>' +
        '<path d="M77,100 Q73,107 74,114"/><path d="M123,100 Q127,107 126,114"/>' +
        '<path d="M90,120 Q86,128 88.5,135"/><path d="M110,120 Q114,128 111.5,135"/></g>';
    }
    if (art.front) s += sub(art.front(c.hair[0], c.skin[2]));
    s += '</g>';
    if (art.extra) s += sub(art.extra(c.hair[0], c.skin[2], c.bg[0]));
    s += '<g fill="' + c.aura + '"><path d="M28,42 q1,4 5,5 q-4,1 -5,5 q-1,-4 -5,-5 q4,-1 5,-5 Z" opacity="0.75"/>' +
      '<path d="M174,56 q0.8,3.4 4.2,4.2 q-3.4,0.8 -4.2,4.2 q-0.8,-3.4 -4.2,-4.2 q3.4,-0.8 4.2,-4.2 Z" opacity="0.6"/>' +
      '<path d="M166,200 q0.7,3 3.7,3.7 q-3,0.7 -3.7,3.7 q-0.7,-3 -3.7,-3.7 q3,-0.7 3.7,-3.7 Z" opacity="0.45"/></g>';
    s += '</svg>';
    return s;
  }


/* 故事模式「红尘录」—— 草稿 Part 2：十卷五十关剧情数据（合入 game.js 用） */
/* 行格式：[说话人, 台词]；'n' = 旁白。type: story=纯剧情 / battle=战斗关 */
/* ================================================================== */

  const STORY_VOLUMES = [
    {
      title: '卷一 · 青石风云', realm: 0, place: '青石镇',
      intro: '灵匣落地的那一声响，惊动了整座青石镇，也惊醒了沉睡三百年的江湖。',
      stages: [
        { name: '灵匣初鸣', type: 'story',
          pre: [
            ['n', '青石镇多雨。采药少年林小凡在溪涧边，救回一位快断气的老人，还有一只自己会响的旧木匣。'],
            ['xiaofan', '老人家，你这匣子在响……要开了吗？'],
            ['chen', '咳咳……别怕，它认主。小子，你救我一命，我便赌你一程造化。'],
            ['chen', '开匣吧。记住——匣里出来的不是宝，是你的路。'],
            ['n', '匣开一线，金尘如雨。一枚下品灵石落进掌心，温润发烫。'],
            ['xiaofan', '这就是……灵石？原来仙师画像上画的，都是骗人的。'],
            ['chen', '灵石只是开始。从今日起，采药之余，照我教的吐纳法门练。'],
            ['xiaofan', '陈老，您到底是什么人？'],
            ['chen', '一个看走眼过一次的人。这次，我不会再看错。'],
          ],
          post: [] },
        { name: '黑风寨来客', type: 'battle',
          foe: { name: '山贼刀客', icon: '贼', el: 'jin' },
          pre: [
            ['n', '三日后，黑风寨的收租队踏进了青石镇。'],
            ['n', '刀客一脚踹翻药摊：「黑风寨收捐！每户十枚灵石——交不出的，拿命抵！」'],
            ['xiaofan', '镇上连饭都吃不饱，哪来的灵石。'],
            ['n', '刀客的刀，已经架上了王婶的脖子。'],
            ['xiaofan', '放开她。（握紧了柴刀）'],
          ],
          post: [
            ['n', '柴刀断成两截，刀客也倒了下去。围观的人群鸦雀无声。'],
            ['chen', '三流身手，胆气满分。回去把吐纳练到第二层，才配真正出手。'],
            ['xiaofan', '黑风寨不会就这么算了的，对吧？'],
            ['chen', '当然不会。所以——今晚跟我夜探黑风寨。'],
          ] },
        { name: '夜探黑风寨', type: 'story',
          pre: [
            ['n', '月黑风高。寨子后山的牢里，绑着一个遍体鳞伤的汉子。'],
            ['shijian', '……过路的？别管我，快走，寨主养着食人兽。'],
            ['xiaofan', '我叫林小凡，青石镇的。今天既然看见了，就管定了。'],
            ['shijian', '哈哈哈……好，有种！我叫石坚，给寨子搬了五年石头。你要是能解开这锁——'],
            ['n', '小凡摸出开匣时得到的一枚细铁签，锁应声而断。'],
            ['shijian', '……兄弟！这五年，头一回有人回来开这把锁。'],
            ['chen', '（低喝）别感动了，巡夜的来了。石坚，能打吗？'],
            ['shijian', '五年的火气，就等这一仗。'],
          ],
          post: [] },
        { name: '寨门血战', type: 'battle',
          foe: { name: '黑风二当家', icon: '刀', el: 'tu' },
          pre: [
            ['n', '警锣炸响。二当家提着鬼头刀拦在寨门前。'],
            ['n', '二当家：「哪来的野小子？敢动黑风寨的人！」'],
            ['xiaofan', '石坚是我朋友。要么让路，要么躺下。'],
          ],
          post: [
            ['n', '鬼头刀哐当落地。二当家捂着断腕连滚带爬地退进了寨子深处。'],
            ['shijian', '独眼豹要亲自出来了。兄弟，怕不怕？'],
            ['xiaofan', '怕。但更想赢。'],
          ] },
        { name: '独眼豹之死', type: 'battle', boss: true,
          foe: { name: '独眼豹', icon: '豹', el: 'huo' },
          pre: [
            ['n', '寨门轰然洞开。独眼豹拎着狼牙棒踏火而来，独眼里燃着凶光。'],
            ['baofeng', '哪来的杂种，坏我二十年的买卖？报上名来——本王棒下不死无名之辈。'],
            ['xiaofan', '青石镇，林小凡。记好了，因为这是你最后一次记人名。'],
            ['baofeng', '哈哈哈哈！一颗灵石都没交齐的穷小子，也配跟本王放狠话？！'],
            ['xiaofan', '灵石。（摊开手，金尘在掌心明灭）你要的灵石，我带来了。'],
          ],
          post: [
            ['n', '狼牙棒断，独眼豹轰然倒地。黑风寨二十年的凶名，一夕而散。'],
            ['shijian', '赢了！兄弟，你他娘的真是天生的修士！'],
            ['chen', '独眼豹不过炼气三层的莽夫。小凡，你的路不在山上，在山外——西去三百里，有仙人的地方。'],
            ['xiaofan', '陈老，您呢？'],
            ['chen', '老骨头就不碍眼了。记住：匣开一路，人走一生。去吧。'],
            ['n', '青石镇的清晨，第一次有风自西来。少年背起行囊，踏出了人生第一步。'],
          ] },
      ],
    },
    {
      title: '卷二 · 幽篁仙缘', realm: 1, place: '幽篁林',
      intro: '幽篁林里竹海如潮。潮声尽头有一座药庐，药庐里的少女指尖沾着晨露。',
      stages: [
        { name: '幽篁遇仙', type: 'story',
          pre: [
            ['n', '西行第七日，竹海无边。少年迷了路，也快没了干粮。'],
            ['qingxuan', '站住！再往前三十步就是毒雾瘴了。……咦，你身上有好干净的灵气。'],
            ['xiaofan', '姑娘好眼力。我自幼采药，辨不出毒雾，但辨得出好人。'],
            ['qingxuan', '贫嘴。……我叫青璇，前面药谷就是我家。饿了吧，锅里还有竹笋羹。'],
            ['xiaofan', '多谢。（喝了一大口）比肉香。'],
            ['qingxuan', '傻子，那本来就放了腊肉。……你这灵匣，是哪儿来的？'],
            ['xiaofan', '青石镇捡的老人所赠。姑娘识得此物？'],
            ['qingxuan', '传说里有它一面之缘。它认主，也择主——它选中的人，命里有一场大劫，也有一场大笑化。'],
          ],
          post: [] },
        { name: '竹母之毒', type: 'battle',
          foe: { name: '毒蛛精', icon: '蛛', el: 'mu' },
          pre: [
            ['n', '青璇为采七叶断肠草，被守草的毒蛛精伤了手腕，毒气攻心。'],
            ['qingxuan', '别过来……蛛毒见血封喉，你救不了……'],
            ['xiaofan', '我辨不出药，但我砍得动蜘蛛。'],
            ['qingxuan', '那是二阶妖物……你的胆子比修为跑得快多了……'],
            ['xiaofan', '它咬了你，这就是它全部的道理。'],
          ],
          post: [
            ['n', '蛛腹破处滚出解毒珠。少年连滚带爬地捧回药谷，青璇的唇色一点点回了过来。'],
            ['qingxuan', '傻子……为了我，值得吗？我们才认识三天。'],
            ['xiaofan', '采药人救人，不讲天数。'],
            ['qingxuan', '……好。那从今天起，我教你辨药识毒。命是你给的，本事我还给你。'],
          ] },
        { name: '药庐情愫', type: 'story',
          pre: [
            ['n', '竹雨敲窗。药庐里，青璇把一株株灵草摆在少年面前，像摆开一局棋。'],
            ['qingxuan', '这是雪见，止血。这是龙葵，清心。这一株……是合欢，你别碰。'],
            ['xiaofan', '为什么？'],
            ['qingxuan', '采药人自己知道。（耳根微红，转头去拨炉火）'],
            ['n', '炉上药汤翻滚，香气缠着竹香。少年忽然觉得，这条路走慢一点也不错。'],
            ['qingxuan', '林小凡，你的灵匣又响了。'],
            ['xiaofan', '嗯，它最近一响，就有好事。……你说，它是不是也想留下？'],
            ['qingxuan', '留下的不该是匣子。（声音很轻）是人才对。'],
          ],
          post: [] },
        { name: '血手初现', type: 'story',
          pre: [
            ['n', '夜半，山外血光冲天。一伙红衣修士踏碎山门，为首者十指滴血。'],
            ['n', '血手修罗：「药谷灵田，收了。人——一个不留。」'],
            ['xiaofan', '青璇！带乡亲们从竹道走，我断后！'],
            ['qingxuan', '你断什么后！他是一血城魔修——'],
            ['xiaofan', '那你就跑快点。回来时，我要药庐还是热的。'],
          ],
          post: [
            ['n', '火光里，少年第一次挡在一座药谷身前。他输了，输得很惨，被一掌拍进溪涧。'],
            ['n', '但血手修罗的追杀，也因一声灵匣自鸣而迟疑了半息。半息，够了。'],
            ['qingxuan', '你疯了……你真的疯了……（哭着包扎）药庐烧了可以再建，你死了我去哪儿再捡一个傻子？'],
            ['xiaofan', '说到做到。药庐……还是热的。'],
            ['qingxuan', '哪里有！它塌了！（破涕为笑）……走，去云来坊市。这仇，记下了。'],
          ] },
        { name: '血影追击', type: 'battle', boss: true,
          foe: { name: '血影卫首领', icon: '影', el: 'shui' },
          pre: [
            ['n', '修罗大军退了，留下一队血影卫衔尾追杀。竹林深处，杀气如网。'],
            ['n', '血影卫（齐声）：「修罗爷要的东西，连土都不能少。交出灵匣——」'],
            ['xiaofan', '想要它？先问问我的刀。哦对了，我的刀昨天断了。（拔起柴刀）那就用这把新的。'],
            ['n', '血影卫狞笑围拢。青璇立在小凡身侧，指尖缠上一缕青色灵藤。'],
            ['qingxuan', '傻子，这次换我们一起。'],
          ],
          post: [
            ['n', '血影散尽，竹海重静。远山之巅，一道血衣身影遥遥望着这边，转身没入夜色。'],
            ['n', '血手修罗：「有点意思。一个凡人坯子，一只能吓退我的匣子。……留着，秋天再来收。」'],
            ['xiaofan', '修为不够，连仇恨都排不上号。（握拳）青璇，我要变强，快得不能再快的那种。'],
            ['qingxuan', '云来坊市有去玄天宗的引荐令。三个月后开考。……我陪你去。'],
          ] },
      ],
    },
    {
      title: '卷三 · 坊市风云', realm: 2, place: '云来坊市',
      intro: '云来坊市，龙蛇混杂。有人在这里倾家荡产，有人在这里一战成名。',
      stages: [
        { name: '云来坊市', type: 'story',
          pre: [
            ['n', '坊市十里长街，法宝灵药堆成山。少年看得眼睛都不够用。'],
            ['qian', '哎哎哎，小兄弟，好眼力！这柄「斩马玄铁刀」，上古遗珍，今日结缘只收八百灵石——'],
            ['xiaofan', '掌柜的，这刀昨天你自己说是「切肉好刀」，喊价八十。'],
            ['qian', '……咳！小兄弟好记性！八十就八十，交个朋友！'],
            ['xiaofan', '七十。再送两瓶疗伤药。'],
            ['qian', '（捂心口）造孽啊……成交！小兄弟，你这样的客人，钱多多这辈子见一个亏一个，偏偏还就盼着你来。'],
            ['qingxuan', '（憋笑）他亏的是本，赚的是眼球。满街人都看傻了。'],
          ],
          post: [] },
        { name: '白衣剑鸣', type: 'story',
          pre: [
            ['n', '长街尽头，恶霸围住一名白衣女子，为首者嬉皮笑脸伸手就去挑人家的面纱。'],
            ['n', '恶霸：「小美人，陪爷喝——」'],
            ['n', '剑光只是一闪。没人看清那柄剑是怎么出鞘的，恶霸的手已经齐腕而断，钉在了三丈外的柱子上。'],
            ['xiaofan', '好剑。（由衷地）姑娘，这一剑叫什么？'],
            ['baizhi', '没名字。剑是用来杀人的，不是用来起名的。'],
            ['xiaofan', '在下林小凡。姑娘这一剑，我记十年。'],
            ['baizhi', '十年太长。你说说，你为什么要修行？'],
            ['xiaofan', '起初是为了不让乡亲挨刀。后来……是有人等我变强。现在，是我不想让等我的那个人失望。'],
            ['baizhi', '（看了他很久）……巧了。我也是。'],
          ],
          post: [] },
        { name: '夺灵果', type: 'battle',
          foe: { name: '妖修·貂爷', icon: '貂', el: 'jin' },
          pre: [
            ['n', '拍卖会上，一株「九窍灵果」刚落槌，一道黑影破顶而入，抢了就跑。'],
            ['n', '貂爷（尖笑）：「多谢各位捧场！这果子妖爷我笑纳了——」'],
            ['xiaofan', '白姑娘，妖修腿快，你截前，我追尾。'],
            ['baizhi', '……谁跟你熟？（人已掠出三丈）别拖后腿。'],
            ['xiaofan', '嘿，嘴上说不要，剑倒是很快。'],
          ],
          post: [
            ['n', '巷战三合，灵果回到拍卖行。满场修士看着这两个年轻人，鸦雀无声。'],
            ['baizhi', '那妖修是金丹。你一个筑基，怎么敢接他第三爪？'],
            ['xiaofan', '不知道啊。我只看见它抓向你。'],
            ['baizhi', '……蠢材。（转身，耳尖微红）灵果分你三成。别跟着我了。'],
            ['qian', '（幽幽出现）二位！打坏了坊市三块地砖，按规定……算了算了，请你们吃饭！'],
          ] },
        { name: '旧剑之谜', type: 'story',
          pre: [
            ['n', '城外桃林。白芷擦拭着一柄缺口的老剑，动作轻得像在擦拭一块碑。'],
            ['xiaofan', '这柄剑，不是你背上那柄。'],
            ['baizhi', '嗯。这是我师父的。七年前，落霞剑派满门四十一口，一夜之间……死在一双手上。'],
            ['xiaofan', '血手修罗。'],
            ['baizhi', '你怎么知道？！'],
            ['xiaofan', '幽篁林，他屠我朋友的家。同一个十指滴血的习惯。（顿了顿）白芷，我闻过他血里的味道。'],
            ['baizhi', '（猛地起身）他现在在哪。'],
            ['xiaofan', '不知道。但他会来找我们——灵匣、老剑、新仇旧恨，我们俩加起来，够他惦记一辈子。'],
            ['baizhi', '……那就让他来。（第一次，她笑了）林小凡，从今天起，我们同路。'],
          ],
          post: [] },
        { name: '修罗分身', type: 'battle', boss: true,
          foe: { name: '血手修罗·分身', icon: '修', el: 'huo' },
          pre: [
            ['n', '归途中，血云压城。修罗的三具分身踏空而来，血手遮天。'],
            ['xiuluo', '一只灵匣，一柄老剑，两条不知死活的小命。今夜，本座一次收齐。'],
            ['xiaofan', '白芷，师门之仇——'],
            ['baizhi', '我知道。（长剑出鞘，剑吟如龙）这一剑等了七年。师兄师姐，看着我。'],
            ['xiuluo', '就凭你们？本座一根手指——'],
            ['xiaofan', '你的手指。（灵匣金光大盛）先问问它答不答应。'],
          ],
          post: [
            ['n', '一具分身当场斩落，血云溃散。本体在十里外冷冷收回了目光。'],
            ['xiuluo', '（残念消散前）有趣……本座记住你们了。秋猎之期，幽冥见。'],
            ['baizhi', '（收剑，手在抖）七年的债……终于讨回了一成。（转头，眼眶红了）林小凡，谢谢你。'],
            ['xiaofan', '谢字太轻。等斩了他本体，你再谢我，我收利息。'],
            ['baizhi', '……无赖。（却笑了）去玄天宗吧。你我都需要更大的舞台。'],
          ] },
      ],
    },
    {
      title: '卷四 · 玄天问道', realm: 3, place: '玄天宗',
      intro: '玄天宗立派三千年，收徒只看灵根。这一年的测灵台上，来了一个五灵根的少年。',
      stages: [
        { name: '测灵之嘲', type: 'story',
          pre: [
            ['n', '测灵台高九丈。少年按上手掌，灵纹五色俱现——俱杂。'],
            ['n', '执事长老（嗤笑）：「五灵根，下下之资。玄天宗三千年，没收过这等废材。」'],
            ['n', '台下哄笑。唯有观星台上，玄机子掌门的目光穿过人群，落在那只旧灵匣上。'],
            ['xuanji', '妙。三千年了，测灵石第一次不敢给一个人定级。'],
            ['xiaofan', '掌门，灵根是天给的。路是人走的。'],
            ['xuanji', '说得好。可本座只收天才，不收嘴硬的。（袖袍一挥）——外门执役，即日起。'],
            ['n', '哄笑声更大了。没人注意到，掌门转身时嘴角的笑意。'],
            ['xuanji', '（传音入密）小子，杂役院有座藏经阁，三层往下，禁书随便看。——别谢，本座赌你成仙。'],
          ],
          post: [] },
        { name: '杂役与圣女', type: 'story',
          pre: [
            ['n', '杂役院的日子，挑水、扫地、喂灵鹤。少年把每件事都做成了修行。'],
            ['n', '月夜，圣女苏挽月的琴声自琼华峰飘下，绕着杂役院转了三匝，散入少年窗前。'],
            ['wantyue', '（隔空传音）这曲《安神引》，为你弹的。测灵台那日，你脚下那三步，很有意思。'],
            ['xiaofan', '圣女谬赞。我就是没处站，往边上让了让。'],
            ['wantyue', '三千人，只有你往边上让。人人都想站到台中央，只有你知道台会塌。'],
            ['xiaofan', '……圣女这话说得，比琴还好听。'],
            ['wantyue', '（轻笑）油嘴滑舌。琴声每晚都有，听不听随你。——对了，明日起，琼华峰的灵泉水，杂役院份例翻倍。'],
            ['n', '次日，杂役院众弟子对着灵泉发疯，唯有少年对着泉水发呆。'],
          ],
          post: [] },
        { name: '藏经阁夜战', type: 'battle',
          foe: { name: '赵乾', icon: '乾', el: 'jin' },
          pre: [
            ['n', '有人在掌门面前告状：杂役林小凡，夜闯藏经阁禁层。'],
            ['n', '赵乾（阴笑）：「人赃并获！掌门，此子偷学本派心法，按律——废去修为！」'],
            ['xiaofan', '赵师兄，我进的是掌门批过的三层。你的告状信，字是我帮你写的吧？笔画都对上了。'],
            ['xuanji', '（缓缓睁眼）哦？那本座倒要问问——赵乾，你的字，怎么会在告你自己的信上？'],
            ['n', '赵乾脸色剧变，恼羞成怒，一掌直取小凡天灵！'],
            ['xiaofan', '掌门，弟子自卫。（侧身让过）您看着，别眨眼。'],
          ],
          post: [
            ['n', '一合。只一合，赵乾躺平在藏经阁前，姿势标准得像练过。'],
            ['xuanji', '筑基初期，败筑基后期。掌门我三十年没见过这么不讲理的赢了。'],
            ['xiaofan', '掌门，他背后还有人递刀。查不查？'],
            ['xuanji', '查。但你先去琼华峰——圣女点了你的名，说大比要与你合奏一曲。'],
            ['n', '全宗哗然：圣女百年未收男徒，更遑论合奏。'],
          ] },
        { name: '大比扬名', type: 'battle',
          foe: { name: '雷无涯', icon: '雷', el: 'huo' },
          pre: [
            ['n', '宗门大比，擂台千丈。连胜九场的少年，迎来了内门第一，雷无涯。'],
            ['n', '雷无涯：「杂役院的兄弟，我给你个机会——现在跪着退赛，还能留个全须全尾。」'],
            ['xiaofan', '雷师兄，我从青石镇走到这里，一千三百里，没用过膝盖。'],
            ['n', '雷霆一击轰然落下，擂台碎裂三丈。少年自烟尘中走出，衣角都没焦。'],
            ['xiaofan', '该我了。'],
          ],
          post: [
            ['n', '第九合，雷无涯的雷印碎了。少年刀背一压，将他钉在擂台边缘。'],
            ['xiaofan', '雷师兄，承让。你很快，但我的匣子，比你快一线。'],
            ['n', '满山寂静。观星台上，玄机子抚须大笑，笑声滚过九峰。'],
            ['xuanji', '哈哈哈哈！好一个「比你快一线」！诸位，记住今日——三年后，他就是玄天宗的下一位掌门。'],
            ['wantyue', '（台下轻声）不是三年。……是三年后，连掌门之位都留不住他了。'],
          ] },
        { name: '傀儡夜袭', type: 'battle', boss: true,
          foe: { name: '幽冥傀儡', icon: '傀', el: 'tu' },
          pre: [
            ['n', '大比当夜，九峰地脉齐震。三具幽冥傀儡破山门而入，直扑藏经阁下的封印之地。'],
            ['n', '傀儡胸腔里传出沙哑声音：「匣……主……交……出……」'],
            ['xiaofan', '找了半年，原来是你在背后递刀。赵乾只是你的爪子，幽冥教才是你的身子。'],
            ['xuanji', '（护山大阵开启）小凡！傀儡核心在胸口！本座镇阵，你去摘心！'],
            ['xiaofan', '掌门看好了——杂役院的活，我干得最利索。'],
          ],
          post: [
            ['n', '傀儡轰然而碎，碎片里滚出一枚幽冥令。山风血腥，星星却亮得反常。'],
            ['xuanji', '幽冥教……三十年前老祖沉睡，如今爪牙又动了。（郑重）林小凡，听封——自今日起，你为玄天宗亲传，赐剑「开山」。'],
            ['xiaofan', '掌门，我更想要藏经阁四层的钥匙。'],
            ['xuanji', '……给！都给！宗门库房随你挑！'],
            ['wantyue', '（月光下走近）林小凡，接下来去哪？——赤炎峡有离火精出世，宗门的名额，我给你留了。'],
            ['xiaofan', '圣女亲自留名额，这面子比掌门的剑值钱。'],
          ] },
      ],
    },
    {
      title: '卷五 · 赤炎炼心', realm: 4, place: '赤炎峡',
      intro: '赤炎峡地火千年一沸。火底有剑冢，剑冢里有前人的魂，和今人的路。',
      stages: [
        { name: '峡口重逢', type: 'story',
          pre: [
            ['n', '赤炎峡口，热浪灼天。队伍里，一个背着药篓的身影快步上前。'],
            ['qingxuan', '林小凡！可算逮着你了——药王谷保举我随队，采离火精周边的火绒草。'],
            ['xiaofan', '青璇？（又惊又喜）你怎么晒黑了。'],
            ['qingxuan', '废话，火绒草长在火山口！（翻了个白眼，又忍不住笑）……好了，别贫。这次任务凶险，我们互相照应。'],
            ['xiaofan', '照应谈不上。你的命是我的，我的命也是你的——一次毒蛛换来的交情，我记一辈子。'],
            ['qingxuan', '……又来了。（背过身去）走了！掉队的不许哭。'],
          ],
          post: [] },
        { name: '熔岩鬼潮', type: 'battle',
          foe: { name: '熔岩鬼将', icon: '熔', el: 'huo' },
          pre: [
            ['n', '峡谷深处，地火骤然倒卷。成千上万熔岩鬼自岩浆里攀出，鬼潮如浪。'],
            ['qingxuan', '鬼潮！是鬼将在驱赶它们——小凡，路断了！'],
            ['xiaofan', '路断了就踩出一条。青璇，背靠背，你的毒我的刀，老规矩。'],
            ['qingxuan', '哪来的老规矩，我们就配合过一次！'],
            ['xiaofan', '一次就够记一辈子了。'],
          ],
          post: [
            ['n', '鬼潮退去，两人瘫在焦岩上，笑得直不起腰。'],
            ['qingxuan', '喏，最后那一下，我把断肠散喂进了鬼将嘴里，你才砍中它的——说好的谁厉害？'],
            ['xiaofan', '你厉害。药王谷青璇，一毒退千军。'],
            ['qingxuan', '这还差不多。（枕着药篓，看天）小凡，火底好像有东西在响……和你的匣子，一个调子。'],
          ] },
        { name: '剑冢传承', type: 'story',
          pre: [
            ['n', '地火深处，万剑倒插成林。剑冢中央，一具枯坐的白骨，指间还扣着一柄无锋重剑。'],
            ['n', '剑灵（苍茫之声）：「三千年了……来的不是天骄，不是天命，是个背药篓的姑娘和一个提柴刀的少年？」'],
            ['xiaofan', '前辈，我们只是路过——'],
            ['n', '剑灵：「路过？哈哈哈哈！三千年了，头一回有人跟本座说『路过』！小娃娃，天骄们进来都是抢的，抢本座的剑，夺本座的道！」'],
            ['xiaofan', '那前辈想让人拿走吗？'],
            ['n', '剑灵静了半晌：「……想。本座等的从来不是抢的人，是问的人。剑是凶器，道是问出来的。——重剑无锋，拿去。」'],
            ['qingxuan', '（小声）小凡，它哭了。'],
            ['xiaofan', '嗯。（郑重叩首）前辈，剑我拿走。你的道，我替你问下去。'],
          ],
          post: [] },
        { name: '故人之影', type: 'story',
          pre: [
            ['n', '剑冢之外，血香飘来。一处焦黑的营地，红衣修士的旗帜倒插在灰烬里。'],
            ['baizhi', '（循踪而至，看见旗帜，指节捏得发白）血手修罗……他来过赤炎峡，不超过三天。'],
            ['xiaofan', '白芷！你怎么来了？'],
            ['baizhi', '宗门通令，幽冥教在赤炎峡活动。我主动请的缨。（盯着灰烬）林小凡，这次不是同路了。这次，我剑出鞘，就没打算回去。'],
            ['xiaofan', '那我陪你一起不回去。'],
            ['baizhi', '……你的嘴还是这么欠。（难得地，语气软了）跟上。别死在我前头。'],
            ['qingxuan', '（在后面小声）喂——那我呢？我也去！别当我不存在啊！'],
          ],
          post: [] },
        { name: '赤炎魔君', type: 'battle', boss: true,
          foe: { name: '赤炎魔君', icon: '炎', el: 'huo' },
          pre: [
            ['n', '峡底火山口，赤炎魔君盘踞岩浆之上——他眼里缠着血丝，是修罗的血蛊迷了心窍。'],
            ['n', '赤炎魔君（嘶吼）：「血食……拿血食来！修罗爷许我——吞了你们，就放我出这火牢！」'],
            ['xiaofan', '他被自己的主子卖了还替人数钱。白芷，断他退路；青璇，解他的血蛊；我——去会会他。'],
            ['baizhi', '解蛊？魔君炼虚巅峰。'],
            ['qingxuan', '药王谷的方子，没写着「怕境界」三个字。'],
          ],
          post: [
            ['n', '血蛊拔除的刹那，魔君浑身血焰化作青烟。他跪在岩浆边，许久，深深一拜。'],
            ['n', '赤炎魔君：「三百年……本座终于又是赤炎峡的守火人了。小友，离火精赠你——另，修罗本体在寒霜原。他去那里，不是躲，是接什么东西。」'],
            ['baizhi', '接？'],
            ['n', '赤炎魔君：「接他们的祖宗。冰层下面睡着的老东西——幽冥老祖，要醒了。」'],
            ['xiaofan', '（与白芷对视）那就去寒霜原。赶在他睁眼之前。'],
          ] },
      ],
    },
    {
      title: '卷六 · 寒霜旧事', realm: 5, place: '寒霜原',
      intro: '寒霜原的雪下了三百年没停。雪下面埋着一座冰城，冰城下面，睡着一个魔。',
      stages: [
        { name: '雪落故乡', type: 'story',
          pre: [
            ['n', '寒霜原边缘，一座半埋在雪里的村落。白芷在一户塌了半边的宅院前站定，再没说话。'],
            ['xiaofan', '这里是……'],
            ['baizhi', '我家。落霞剑派覆灭那晚，我娘把我塞进地窖。（拂去门楣的雪）她说过，雪停的时候就回来。'],
            ['xiaofan', '（默默摘下肩上的剑，插在院门边）白姐，剑先给家里站个岗。人，跟我们走。'],
            ['baizhi', '……谁准你叫我白姐的。（声音哑了）……就这一次。'],
            ['qingxuan', '（把一小坛酒埋进雪里）伯母，我们喝的。等雪停，一起。'],
          ],
          post: [] },
        { name: '雪岭伏杀', type: 'battle',
          foe: { name: '幽冥刺客', icon: '刺', el: 'shui' },
          pre: [
            ['n', '雪岭隘口，风雪骤停——风雪不是停了，是被血气冻住了。八方雪幕里，刺客无声落下。'],
            ['n', '幽冥刺客（齐声）：「老祖有令：匣主之血，祭冰城之锁。」'],
            ['xiaofan', '三年了，幽冥教还是这套开场白。白芷，左边三个归你；青璇，毒雾压阵；——右边的，我来。'],
            ['baizhi', '分赃倒是很熟练。'],
            ['xiaofan', '跟你们俩学的。'],
          ],
          post: [
            ['n', '刺客尽墨。雪地上，一枚令牌指向冰城方向，令牌背面刻着一个「锁」字。'],
            ['baizhi', '匣主之血祭冰城之锁……林小凡，你的灵匣，就是老祖的钥匙。'],
            ['xiaofan', '所以从我捡起它的那天起，就是他睡着都惦记的仇人。（笑）这缘分，斩不断了。'],
            ['qingxuan', '少得意。走，趁老祖没醒——咱们去他家，拆他床。'],
          ] },
        { name: '冰下孤城', type: 'story',
          pre: [
            ['n', '冰层千丈之下，一座黑玉孤城悬浮于寒渊。城门上锁着九条锁链，链头没入虚空。'],
            ['n', '城门侧，累累冰雕——每一尊，都是一位前来封印的先辈修士，保持着出剑的姿势。'],
            ['baizhi', '（逐一抚过冰雕）封印的人……都没能走出去。'],
            ['xiaofan', '那我们就做头一批进去还能出来的。（灵匣自鸣，九条锁链应声而颤）'],
            ['n', '深渊底部，一声叹息隔着千丈冰层传来，像大地的梦呓。'],
            ['laozu', '（意念如潮）「小家伙……匣又换主人了啊。别急，让老夫，再睡最后一场。醒了，就去找你。」'],
            ['xiaofan', '（反手把灵匣按在冰面上）听见了？他约我了。青璇，白芷——记下这日子，回头当忌日给他过。'],
            ['qingxuan', '都这时候了你还贫！跑！封印要撑不住了！'],
          ],
          post: [] },
        { name: '师门遗剑', type: 'story',
          pre: [
            ['n', '归途雪坡，白芷忽然停步。雪下露出一角剑鞘——落霞剑派的制式。'],
            ['baizhi', '……这是我师父的佩剑「听雪」。他老人家战死那晚，剑一直没找到。（跪坐雪中，双手刨雪）'],
            ['n', '剑出雪的一刻，剑身悲鸣。剑柄上缠着的红绳，是七年前小师妹亲手系的。'],
            ['baizhi', '（抱着剑，终于哭出了声）师父……我把剑带回来了。四十一口，就剩我一个……不，现在是三个了。'],
            ['xiaofan', '（蹲下来，与她平视）白芷，听我说。落霞剑派没有灭门。你活着，剑活着，师门的道就活着——从今往后，你每赢一剑，他们都在。'],
            ['qingxuan', '（轻声）把师门的牌位带上吧。等斩了修罗，我们替你回去，重立山门。'],
            ['baizhi', '（起身，拭泪，眼神前所未有地亮）好。那从现在起——我的剑，为活着的人出鞘。'],
          ],
          post: [] },
        { name: '寒霜王·傀', type: 'battle', boss: true,
          foe: { name: '寒霜王·傀', icon: '霜', el: 'shui' },
          pre: [
            ['n', '风雪中央，寒霜王自冰原拔地而起——他的动作僵硬如傀，眼瞳深处燃着幽绿的火。'],
            ['laozu', '（借傀开口）「小匣主，见面礼。老夫睡迷了，手脚借本地的王用用——接得住，老夫高看你一眼。」'],
            ['xiaofan', '老东西，梦里递战书，醒了敢不敢亲自来？'],
            ['laozu', '（笑）「敢。但现在，先让你看看——你护着的人，一个个躺下，是什么滋味。」'],
            ['xiaofan', '做梦。（拔刀）我的朋友，我一个都不少！'],
          ],
          post: [
            ['n', '寒霜王轰然崩塌。幽绿的火在雪里熄灭前，留下最后一声轻笑。'],
            ['laozu', '「好胆气。老夫等你——秋猎，天外墟。带上你的匣子，你的姑娘们，你的朋友们。老夫摆席，等你入席。」'],
            ['baizhi', '（收剑）秋猎，天外墟。'],
            ['qingxuan', '他这是……请帖？'],
            ['xiaofan', '是请帖。也是我们给他的——（灵匣金光暴涨三尺）讣告。'],
          ] },
      ],
    },
    {
      title: '卷七 · 九霄惊变', realm: 6, place: '九霄阶',
      intro: '九霄阶三万级，级级落雷。仙人以此选人，雷帝以此选继。',
      stages: [
        { name: '三万天梯', type: 'story',
          pre: [
            ['n', '九霄阶前，云海翻涌。登阶者九死一生，雷劫随身——每一级，都是一重小天劫。'],
            ['wantyue', '（等候在阶前）你来了。宗门推举你登阶，全票通过。'],
            ['xiaofan', '圣女专程等我？这不合规矩吧。'],
            ['wantyue', '规矩是给凡人定的。（转身先行）我在雷池等你。九霄阶的尽头，有一场雷帝留下的试炼——历代登顶者，无一生还。'],
            ['xiaofan', '无一生还还叫我上去？'],
            ['wantyue', '因为历代登顶者，都没有你的匣子。（回眸一笑）加油，杂役出身的掌门候选人。'],
          ],
          post: [] },
        { name: '雷池悟道', type: 'story',
          pre: [
            ['n', '第一万级，雷海如瀑。少年浑身焦黑，却在大笑。'],
            ['xiaofan', '哈！雷帝老儿，你这三万级的雷，是给我淬体的！再来！'],
            ['n', '第两万级，少年盘坐雷眼，任雷加身。金尘自灵匣溢出，与雷霆纠缠成茧。'],
            ['n', '第两万九千级，茧开。少年一步跨出，衣袂无伤——他悟了：雷不是劫，是天借给你的力气。'],
            ['xiaofan', '借雷诀，第一式——「天梯」。（弹指，一道细雷应声而出）老儿，你的东西，我借走了，利息记你账上。'],
            ['n', '雷海深处，一声苍老的、像是笑叹的轰鸣，滚滚而过。'],
          ],
          post: [] },
        { name: '云将拦路', type: 'battle',
          foe: { name: '九霄云将', icon: '云', el: 'jin' },
          pre: [
            ['n', '最后百级，甲士列阵。九霄云将横戟而立——天条：登顶者，视为僭越，格杀。'],
            ['n', '九霄云将：「凡人，止步。天梯尽头非你该窥探之地。」'],
            ['xiaofan', '云将，借过。雷帝的试炼帖子在我手里——白纸黑字，哦不，雷纹电字。'],
            ['n', '九霄云将：「雷帝三万年未开金口，何来帖子？！——起戟！」'],
            ['xiaofan', '（叹气）跟你们天上的讲不通道理。那就讲拳头。'],
          ],
          post: [
            ['n', '云将的单戟断成两截。他怔怔看着少年，忽然单膝跪地。'],
            ['n', '九霄云将：「三万年前，帝君留谕：『有匣者，天梯任行。』……末将有眼无珠。请——登阶。」'],
            ['xiaofan', '（扶起他）三万年前的留言，你背了三万年。辛苦了，云将。'],
            ['n', '云海裂开一线，天梯尽头的光，第一次落在一个凡人肩上。'],
          ] },
        { name: '圣女被困', type: 'story',
          pre: [
            ['n', '登顶之日，玄天宗急报：苏挽月赴雷池祭礼，被幽冥教伏杀掳走——祭坛就设在九霄阶背面的渊底。'],
            ['xuanji', '（传音，罕见地急促）小凡！幽冥教要以圣女纯阴之体祭开天外墟的裂缝！时辰就在今夜子时！'],
            ['xiaofan', '她为我留了登阶的名额，我欠她一场祭礼。（转身，一步跨下深渊）——玄天宗的救援呢？'],
            ['xuanji', '大阵封锁，倾巢而出至少三日！'],
            ['xiaofan', '三日？（笑声自渊底传上来）她撑不到三日。我一个人，今夜到。'],
            ['baizhi', '谁说的。（剑光自侧翼掠至）你一个人，谁给你照火把？'],
            ['qingxuan', '还有我。（药香弥漫）渊底湿毒重，没有我的药，你走不到祭坛。'],
            ['xiaofan', '（大笑）好！老规矩——背靠背！'],
          ],
          post: [] },
        { name: '雷帝残念', type: 'battle', boss: true,
          foe: { name: '九霄雷帝·念', icon: '帝', el: 'huo' },
          pre: [
            ['n', '渊底祭坛，幽冥教众环绕。而祭坛之上的雷海裂隙里，一道帝影缓缓凝聚——雷帝残念，被以圣女为引强行召来。'],
            ['n', '雷帝残念：「三万年了……又是妄图借本座之雷开墟的蝼蚁。」'],
            ['laozu', '（意念得意）「多谢帝君赏脸。圣女之血一泼，墟门一开——老夫的新世界，就到了。」'],
            ['wantyue', '（祭坛锁链中，虚弱而清醒）林小凡……别管我，斩裂隙！墟门开一条缝，就是万劫不复！'],
            ['xiaofan', '闭眼。数三个数。（拔刀）借雷诀·第九式——我借你的雷，你也借我的胆，帝君。'],
          ],
          post: [
            ['n', '雷海倒卷。帝影在三数之内寸寸碎裂，裂隙轰然闭合——幽冥老祖隔着深渊的咆哮，震塌了半座祭坛。'],
            ['n', '雷帝残念（消散前）：「小辈……雷不是借的。雷认主。……本座等你，来九霄之上。」'],
            ['xiaofan', '（背起昏迷的挽月，踏渊而上）帝君的话我记下了。但先说好——利息，我一分都不少你们的。幽冥教、老祖，一个都跑不了。'],
            ['wantyue', '（在背上，半醒）……你说话的时候，能不能别震得我耳朵疼……'],
            ['xiaofan', '醒了就自己走。圣女的架子，背多了会长娇气的。'],
            ['wantyue', '（低低地笑）……混蛋。我就赖在你背上了。'],
          ] },
      ],
    },
    {
      title: '卷八 · 大乘对决', realm: 7, place: '幽冥总坛',
      intro: '大乘之前，先斩心中之敌。心魔斩尽处，方见真我。',
      stages: [
        { name: '单骑破阵', type: 'story',
          pre: [
            ['n', '幽冥教总坛，血煞大阵困住三位前来救援的宗门长老。阵眼处，修罗亲自坐镇。'],
            ['xiuluo', '玄天宗的援兵？就这？——把他们也祭了！'],
            ['xiaofan', '（自天而降）修罗！你的血煞阵，阵眼七处，我踩碎了五处——剩下两处，你猜在哪儿？'],
            ['xiuluo', '（霍然起身）不可能！你进阵不过一炷香——'],
            ['xiaofan', '一炷香，够了。（灵匣金光如炬）剩下的两处，一处在我脚下，一处在——你身后。'],
            ['n', '修罗猛然回头。大阵轰然自爆，血雨漫天。'],
            ['baizhi', '（三剑破雾而入，剑指修罗）血手修罗。七年了，先把名字还给我们。'],
          ],
          post: [] },
        { name: '血手末路', type: 'battle', boss: true,
          foe: { name: '血手修罗', icon: '修', el: 'huo' },
          pre: [
            ['n', '血雨里，修罗双臂血焰滔天——他终于不再轻慢，动了真格。'],
            ['xiuluo', '七年了，你们追了我七年——今日就让你们明白，蝼蚁仰望天的距离！'],
            ['baizhi', '（剑出鞘，剑身悲鸣如泣）我师门四十一口的血，今夜，一滴一滴跟你算。'],
            ['xiuluo', '落霞剑派的遗种？哈！当年那四十一颗人头，本座一颗一颗数的——你师父求饶的样子，本座还记得——'],
            ['baizhi', '住口！！'],
            ['xiaofan', '（横刀挡在她身前）别听。他扰乱你，就是他怕你。白芷——你的剑，出鞘吧。'],
          ],
          post: [
            ['n', '天光破云的一瞬，白芷的剑穿过了修罗的心口。七年的血债，一剑清账。'],
            ['xiuluo', '（血焰散尽，难以置信）不可能……老祖说……老祖答应过我不死……'],
            ['xiaofan', '你的老祖，忙着给自己收尸呢。（收刀）修罗，黄泉路上慢点走——幽冥教没了，老祖也快了。你赶得早，不如赶得巧。'],
            ['baizhi', '（剑归鞘，仰头看天，泪流满面却笑着）师父，师兄，师姐……看见了吗。雪停了。'],
            ['qingxuan', '（轻轻靠上她的肩）嗯，雪停了。回家吧——这次，是三个人的家。'],
          ] },
        { name: '老祖之怒', type: 'story',
          pre: [
            ['n', '修罗陨落的血气，惊动了千里冰层之下的梦。幽冥老祖，睁眼了。'],
            ['laozu', '（意念如天倾）「血手……本座养了三百年的狗。小匣主，你让老夫的棋盘，散了一角。」'],
            ['n', '一根手指，自地脉深处隔空探出。漫天血云凝成指影，轻轻一按——三位大乘长老，道基齐碎。'],
            ['xuanji', '（喷血倒飞）全体撤退！！他是渡劫！渡劫巅峰！！'],
            ['laozu', '「撤？」（轻笑）「老夫的宴席还没开，谁准你们走了。」'],
            ['xiaofan', '（灵匣挡在众人身前，金光与指影硬撼，虎口崩裂）老东西！约的是天外墟——堂堂渡劫，玩以多欺少？'],
            ['laozu', '（指影一顿，竟真的收回）「……也好。天外墟，秋猎。小匣主，别忘了带匣子——那是老夫的东西。」'],
            ['n', '意念退去，天地重静。人人后背湿透，唯有少年拄刀而立，一字一句。'],
            ['xiaofan', '你的东西？（举起灵匣，笑得嚣张）来拿啊。'],
          ],
          post: [] },
        { name: '三人同心', type: 'story',
          pre: [
            ['n', '玄天宗，琼华峰。伤药煎了三天，三位姑娘围着少年，谁也不肯先走。'],
            ['qingxuan', '（换药，下手毫不留情）虎口崩裂还硬撼渡劫，林小凡，你的手不要了？'],
            ['xiaofan', '哎哎轻点——白芷的手艺比你好。'],
            ['baizhi', '（默默递上自己调的金疮药）我的方子。青璇验过的。'],
            ['wantyue', '（抚琴，琴音镇痛）……众女围着英雄的画面，史官都不敢这么写。（顿了顿，耳根微红）史官会怎么写你，林小凡？'],
            ['xiaofan', '就写：青石镇林小凡，采药出身，一生所求——把等过我的人，一个个等回家。'],
            ['n', '满室忽然安静。炉上药汤咕嘟作响，三个人的耳尖，不约而同地红了。'],
            ['qingxuan', '（别过头）……油嘴滑舌。'],
            ['baizhi', '（擦剑，擦得飞快）……幼稚。'],
            ['wantyue', '（琴音乱了一拍）……下流。（三人对视，忽然都笑了）'],
          ],
          post: [] },
        { name: '大乘斩魔', type: 'battle', boss: true,
          foe: { name: '心魔·林小凡', icon: '魔', el: 'tu' },
          pre: [
            ['n', '突破大乘之夜，心魔自道心深处走来——它穿着少年的脸，眼里却没有光。'],
            ['xinmo', '我。你心底最深处的那个人。你敢否认吗——你变强的每一步，都是为了有人看。'],
            ['xiaofan', '说对一半。'],
            ['xinmo', '哦？'],
            ['xiaofan', '我为她们变强，但道是我自己的。她们在，我走得更远；她们不在——（拔刀）我也走到今天给你看。'],
            ['xinmo', '好胆。那就斩了你自己，让我来看看，剩下的还是不是你！'],
          ],
          post: [
            ['n', '一刀两断。心魔消散处，道基轰鸣，大乘天成。灵匣悬空自鸣，如贺如歌。'],
            ['xiaofan', '（收刀，长长吐出一口气）老东西，听见了么——大乘了。天外墟，我来了。'],
            ['n', '千里冰层之下，一声悠长的叹息，像一句迟来的、郑重的回应。'],
          ] },
      ],
    },
    {
      title: '卷九 · 天外墟', realm: 8, place: '天外墟',
      intro: '天外墟，诸天陨落之地。墟里没有生灵，只有旧神的骸骨和新客的野心。',
      stages: [
        { name: '墟门大开', type: 'story',
          pre: [
            ['n', '秋猎之日，天外墟墟门自开。四海上千修士齐聚——有人为机缘，有人为泄愤，有人为送死。'],
            ['xuanji', '（临行）小凡，此去凶险胜过此前一切。老夫算尽天机，只算出四个字。'],
            ['xiaofan', '哪四个字？'],
            ['xuanji', '「道在人为。」（大笑三声，广袖一挥）去吧！老夫在宗门备好庆功酒——记住，是庆功酒，不是解厄酒！'],
            ['xiaofan', '（转身，一步跨进墟门）掌门，多备几坛。庆功的人，一个都不能少。'],
          ],
          post: [] },
        { name: '星兽之王', type: 'battle',
          foe: { name: '星兽王', icon: '星', el: 'tu' },
          pre: [
            ['n', '墟中第一层，星骸如林。兽潮自骸骨间涌出，星兽王踏着万兽脊背而来。'],
            ['n', '星兽王：「外来的……血肉……好吃……」'],
            ['xiaofan', '直说吧，你们墟里的开场白能不能换换？三句话不离吃。'],
            ['n', '星兽王：「……那就——吃了再说！！」'],
            ['xiaofan', '这不还是吃吗！（迎面而上）白芷青璇挽月，老规矩——'],
            ['baizhi', '（齐声）「背靠背！」'],
          ],
          post: [
            ['n', '星兽王轰然倒地，万兽潮水般退去。少年拄刀喘息，忽然笑了。'],
            ['xiaofan', '发现没有，它其实挺实在的——说吃就真吃，不像某人，请客都带三次转折。'],
            ['wantyue', '你说老祖？（轻笑）他的转折，一次比一次致命。走，下一层——石坚的部族，就在前面接应。'],
          ] },
        { name: '蛮荒来援', type: 'story',
          pre: [
            ['n', '墟中绿洲，篝火连营。一队肤色黝黑的蛮族武士列阵相迎，为首的壮汉声若洪钟。'],
            ['shijian', '兄弟！！（熊抱，地动山摇）五年了！老子回青石镇找不到你，一路打听——好家伙，你把天捅穿了！'],
            ['xiaofan', '石坚！（也捶他背）你这体格，蛮族养得挺好啊。'],
            ['shijian', '部族收了我，我还当上猎首了！听说你要跟老祖宗级别的魔头干仗——（拍胸脯）我带了三百猎手，山一样的胆子！'],
            ['xiaofan', '（大笑）好！这次让你打头阵——黑风寨的兄弟，上石！'],
            ['shijian', '（抹了把脸）呜……兄弟，你这话，老子等了半辈子。'],
            ['qingxuan', '（小声）他们俩哭什么？'],
            ['wantyue', '男人的友情，史官也写不明白。'],
          ],
          post: [] },
        { name: '古神之卫', type: 'battle',
          foe: { name: '古神卫', icon: '神', el: 'jin' },
          pre: [
            ['n', '墟心外围，神骸如山。骸骨缝隙间，一尊百丈古神卫轰然苏醒，独目如月。'],
            ['n', '古神卫：「墟禁：渡劫之下，不得入内。」'],
            ['xiaofan', '（抬头，缓缓活动手腕）老规矩，讲道理你听不懂，那就讲拳头——'],
            ['laozu', '（意念插话，带着笑）「古神卫，放行。这一位——是老夫的贵客。」'],
            ['n', '古神卫的独目转向深渊，又转回来，缓缓让开一条道。'],
            ['xiaofan', '（眯眼）老东西，你放我进去做什么？请君入瓮？'],
            ['laozu', '「瓮里有酒，有肉，有真相。小匣主——你不想知道，这匣子最初，是从哪儿来的吗？」'],
            ['xiaofan', '（沉默片刻，笑了）想。太想了。走着。'],
          ],
          post: [
            ['n', '百丈神躯轰然跪地，让出神殿之门。众人面面相觑，唯有少年踏门而入。'],
            ['baizhi', '他真进去了？！'],
            ['wantyue', '（望着殿门，轻声）他知道是局。……但他要去赴。这就是他。'],
            ['qingxuan', '（抓紧药篓）那就快跟上！谁也别想让他一个人进局！'],
          ] },
        { name: '渡劫雷海', type: 'battle', boss: true,
          foe: { name: '邪神之影', icon: '邪', el: 'shui' },
          pre: [
            ['n', '神殿之巅，渡劫雷海轰然而落——少年选择在此突破。而雷海尽头，邪神之影自天外俯瞰。'],
            ['n', '邪神之影：「九重劫雷，一重一重，敲开你们的壳。壳里的东西——本座尝过，三界之前。」'],
            ['xiaofan', '（立于雷眼，仰头大笑）老祖约我秋猎，帝君约我九霄之上，你约我三界之前——好忙啊我。（举刀）排队！一个一个来！'],
            ['n', '第一重劫雷落。少年以刀承雷。第二重，第三重——至第九重，他以自身为引，把九道天雷拧成了一道。'],
            ['xiaofan', '借雷诀·终式——「还雷」！帝君，你的东西，还你！连本带利！'],
          ],
          post: [
            ['n', '雷海尽碎，邪神之影寸寸崩解。渡劫天成——天地寂静三息，随后风云倒卷，万灵齐鸣。'],
            ['n', '邪神之影（崩解前）：「小东西……本体醒时……墟门自开……你在劫中，我在……」'],
            ['xiaofan', '（收刀，截断它的话）行了行了，遗言别拖泥带水。（望向墟心深处）老东西，就剩你了。'],
          ] },
      ],
    },
    {
      title: '卷十 · 天道无极', realm: 9, place: '墟心神殿',
      intro: '仙路尽头，天道之上。有人求长生，有人求无敌——而他，只是回家。',
      stages: [
        { name: '故人话别', type: 'story',
          pre: [
            ['n', '墟门前夜。篝火堆旁，众人围坐，谁都没睡。'],
            ['shijian', '兄弟，明天那仗打完……回青石镇不？我猎了一头百丈荒牛，全村吃三天。'],
            ['xiaofan', '回。王婶的酱料方子你还留着吧？'],
            ['shijian', '留着！你走那年她就说：小凡回来那天，酱料管够！'],
            ['baizhi', '（擦拭听雪剑）落霞山门的重建图纸，画好了。掌门的位置，我给你留着。'],
            ['xiaofan', '我当掌门？我可是杂役出身。'],
            ['baizhi', '杂役怎么了。（瞥他一眼）杂役赢了全宗大比，顺便把掌门骗到手了。'],
            ['wantyue', '（抚琴，琴音温柔）《安神引》，改了个名字。'],
            ['xiaofan', '叫什么？'],
            ['wantyue', '《等你回家》。（顿了顿）林小凡，明天之后，别再让我等了。'],
            ['qingxuan', '（把一株合欢塞进他衣襟，声音很小）……药庐重建好了。灶上，永远给你温着竹笋羹。'],
            ['xiaofan', '（收好花，站起身，望着墟心）都听好了——明天这仗，谁都别死。打完，回家。'],
          ],
          post: [] },
        { name: '幽冥终焉', type: 'battle', boss: true,
          foe: { name: '幽冥老祖', icon: '幽', el: 'tu' },
          pre: [
            ['n', '墟心神殿，幽冥老祖端坐神座之上——渡劫巅峰的威压，压得整座墟都在呻吟。'],
            ['laozu', '小匣主，你来了。三百年了，老夫终于能亲手摸一摸这只匣子。'],
            ['xiaofan', '老东西，先说清楚。匣子为什么会响？你为什么找它？'],
            ['laozu', '因为老夫是它的——上一任主人。（缓缓起身）三百年前，老夫以它开墟，想窃天之火，被天道一掌拍进冰里。匣子飞了，老夫睡了。如今，该物归原主了。'],
            ['xiaofan', '原来如此。（灵匣悬于头顶，金光大盛）那我问你——它为什么选我？'],
            ['laozu', '……什么？'],
            ['xiaofan', '它在陈老手里，不响。在我手里，步步开天。（拔刀）因为——匣择人，人择路。你的路断了，老东西。三百年的执念，今天就到了结的时候。'],
          ],
          post: [
            ['n', '三百年的恩怨，一刀两断。老祖的神座崩塌，冰封的执念化作漫天飞灰。'],
            ['laozu', '（飞灰将散）匣择人，人择路……原来如此……原来，老夫输在这里……'],
            ['xiaofan', '（收刀，长出一口气）老前辈，转世投个好胎。下辈子，别修魔了——修不动的。'],
            ['n', '话音未落——整座天外墟，骤然震颤。墟心深处，一双紫金色的巨目，缓缓睁开。'],
            ['wantyue', '小凡！！墟心——邪神本体要醒了！老祖是它的……守门人！'],
            ['xiaofan', '（转身，迎着巨目，笑）好啊。守门的死了，正主终于肯露面了。'],
          ] },
        { name: '邪神降临', type: 'story',
          pre: [
            ['n', '墟心崩裂。天外邪神的真身自裂缝降临——祂无面，无身，只有一双俯瞰众生的目，和一片吞光的暗。'],
            ['n', '邪神：「小东西。老祖是你杀的？好。祂守门三百年，工钱本座还没结。你替祂省了——本座便省下这道工序：直接吃。」'],
            ['xiaofan', '你吃得了谁？就凭你那点遮天的黑雾？'],
            ['n', '邪神：「凭这个。」（暗雾一卷，千里星骸尽数崩解，化作祂的食粮）「这墟里沉睡的每一位古神，都是本座的旧账。你们的道——不过是本座遗漏的一粒尘。」'],
            ['baizhi', '（剑横身前）漏出来的这粒尘，扎得你守门人满手是血。'],
            ['n', '邪神的目光第一次凝聚：「有意思。……那就让本座看看，尘，能扎多深。」'],
            ['xiaofan', '（灵匣大亮）众人听令——老规矩！'],
            ['n', '背靠背。这一次，是十万修士，与祂背靠背。'],
          ],
          post: [] },
        { name: '万灵来朝', type: 'story',
          pre: [
            ['n', '决战前夜，天外墟万火齐明。玄天宗的大阵自天而降，四海修士列阵星骸之上。'],
            ['xuanji', '（踏虚而来，广袖飘飘）小凡！老夫把家底全带来了——九峰弟子三千，护山老人九位，还有你那口藏经阁的钥匙！'],
            ['xiaofan', '掌门，您一个合体修士跑来干什么！'],
            ['xuanji', '胡说！老夫是来监考的。（大笑）你从小虾米到大乘，每一步老夫都看着——最后一战，老夫不能缺席！'],
            ['qian', '（推着满载灵石的货车挤进阵中）林掌柜！哦不，林大侠！云来坊市全体商户，劳军物资十万车！记账上——打赢了一起还，打输了……就没这个账本了！'],
            ['chen', '（自人群深处，缓缓走出。白衣胜雪，哪里还有半分老态）'],
            ['xiaofan', '陈……老？您——'],
            ['chen', '三百年前，天道一掌拍散了老夫的躯壳，残魂守着匣子等一个主人。等了三百年，等到一个肯对它说话的少年。（微笑）小凡，天道录十卷，你走到了最后一卷。现在——为师把这一卷，亲笔交给你。'],
            ['n', '天道之上，钟鸣九响。万灵齐呼，声震诸天。'],
          ],
          post: [] },
        { name: '天外邪神', type: 'battle', boss: true,
          foe: { name: '天外邪神', icon: '邪', el: 'shui' },
          pre: [
            ['n', '决战。邪神的暗幕遮蔽诸天，十万修士的火光在暗幕下如烛如豆。'],
            ['n', '邪神：「三界之尘，也敢挡本座？」'],
            ['xiaofan', '（灵匣高举，金光如虹贯通天穹）老东西，最后教你一课——'],
            ['xiaofan', '尘不挡你。尘，只是不想活在你的天里！（横刀）三界修士——随我，开天！！'],
            ['n', '金光过处，暗幕如纸。灵匣历代主人的影子在光中依次浮现——陈老、历代匣主、无数普通的名字。'],
            ['n', '邪神（第一次后退）：「不可能……你们不过是——」'],
            ['xiaofan', '不过是人。人这一字，你花了三万年，也没读懂。'],
          ],
          post: [
            ['n', '暗幕崩碎，天外之光第一次照进天外墟。邪神在光中寸寸消解，如雪见日。'],
            ['n', '邪神（消散前）：「匣择人，人择路……原来天道……偏爱的从来不是最强……是最像……」'],
            ['xiaofan', '（收刀）是最像人。（转身，面向十万修士，大笑）诸位！仗打完了——回家！！'],
            ['n', '那年春天，青石镇的酱料管够。落霞山门重立，琼华峰琴声不断，药王谷的灶上温着竹笋羹。'],
            ['n', '云来坊市的说书人拍响了醒木：要说那林大侠，起于微末，一步一个脚印，斩尽不平——'],
            ['n', '而故事的最后，少年把灵匣轻轻放回溪涧边。匣里空空如也，一如天道录第十卷所写：机缘从来不在匣中——在开匣的手上。'],
            ['xiaofan', '（对着溪水，摆好一只新木匣）下一个捡到它的人，你好。这条路很长，但值得。'],
          ] },
      ],
    },
  ];

/* 故事模式「红尘录」—— 后传二十卷（卷十一 ~ 卷三十）：新天纪          */
/* 旧天已问、邪神已陨，天幕之外另有乾坤。境界皆需「仙人」，               */
/* 战力门槛自卷十缓曲线续接（见 storyReq，不随仙位放大）。                */
/* ================================================================== */

  const STORY_VOLUMES_SEQUEL = [
    {
      title: '卷十一 · 墟门余波', realm: 9, place: '星落原',
      intro: '大战过后，碎星如雨，落满了千里星落原。人们说天下太平了——可天上的裂缝，一直没有合上。',
      stages: [
        { name: '凯旋之后', type: 'story',
          pre: [
            ['n', '天外墟归来第七天。星落原上，碎星还在往下落，像一场下不完的葬礼。'],
            ['xiaofan', '（接住一颗碎星，掌心一烫）老东西，你说邪神死了，这天上的口子怎么还没合？'],
            ['chen', '（望着天际）伤口结疤，也要看伤有多深。它在那儿趴了三万年，不是一刀就能算清的。'],
            ['shijian', '管它呢！兄弟，庆功宴都摆三天了，就等你回去开席！'],
            ['qingxuan', '（小声）可是……你们看裂缝边上，那道金光，一闪一闪的。'],
            ['n', '众人齐齐抬头。天幕裂缝深处，一线金芒巡弋而过，像一只睁开的眼睛。'],
          ],
          post: [] },
        { name: '星原魉影', type: 'battle',
          foe: { name: '墟魉', icon: '魂', el: 'shui' },
          pre: [
            ['n', '入夜，落星越下越密。碎星落地不响——因为落地之前，就被什么东西吃了。'],
            ['n', '星骸之间，一缕缕灰白的影子立了起来，朝着人群的篝火漂过来。'],
            ['baizhi', '（剑已出鞘三寸）邪神死了，可它吃下去的东西，还在它肚子里记着路。'],
            ['xiaofan', '墟魉。老熟人的余孽罢了。（横刀）送上门的，正好——试试新刀开不开锋。'],
          ],
          post: [
            ['n', '灰影散作飞灰，落星重新亮了起来。可裂缝深处，那道金光更亮了。'],
            ['wantyue', '（按住琴弦）小凡，金光在看我们。不是看这片原——是看你，和你的匣子。'],
            ['xiaofan', '（拍了拍腰间的木匣）行啊，排队。前面还有一场庆功宴，让你插个队。'],
          ] },
        { name: '天下布置', type: 'story',
          pre: [
            ['n', '玄天宗连夜聚将。四海修士的传讯符雪片一样飞来——天上的裂缝，正在一道一道变宽。'],
            ['xuanji', '（掐算星盘，脸色发白）怪哉，怪哉。老夫夜观天象三十年，从没见过这样的星——天上有人巡夜。'],
            ['qian', '（举手）掌门的，说人话。'],
            ['xuanji', '说人话就是：咱们打完了妖怪，惊动了衙门。天上的衙门。'],
            ['xiaofan', '天上的衙门……管人间的事？'],
            ['chen', '（缓缓道）自古就有。只是十万年没下过界了——上一回下界，是来抓一只匣子。'],
          ],
          post: [] },
        { name: '落星结阵', type: 'battle',
          foe: { name: '落星傀儡', icon: '星', el: 'tu' },
          pre: [
            ['n', '裂痕越来越宽，落星在原上排成阵势——碎星自行拼合，站起了一尊尊石傀儡。'],
            ['n', '傀儡没有眼睛，动作却齐整如一，朝着灵匣的方向，一步一步压过来。'],
            ['shijian', '兄弟，这些石头货是冲你来的！'],
            ['xiaofan', '（灵匣在腰间嗡嗡作响，像在报警）它们不是冲我——是冲它。护住百姓营地，结阵！'],
            ['baizhi', '（长剑归鞘又出鞘，第一次先于人出手）左边给我。'],
          ],
          post: [
            ['n', '最后一尊傀儡碎在黎明前。原上安静了，天上那道金光却落了下来——'],
            ['n', '金光落地化作一员天将，甲叶铮铮，声如洪钟：「下界杂修，天规三章：不得窥天、不得僭越、不得藏匿天枢失物。缴匣者，免罪。」'],
            ['xiaofan', '（把木匣往身后一背，笑了）天枢失物？老先生，它在我这儿响了一路，可从来没丢过。'],
          ] },
        { name: '裂天魉王', type: 'battle', boss: true,
          foe: { name: '裂天魉王', icon: '王', el: 'shui' },
          pre: [
            ['n', '天将话音未落，裂缝轰然撕开——万丈魉气自天倾泻，凝成一尊遮天的魉王。'],
            ['n', '魉王：「钥匙……交出来……归墟饿着……」'],
            ['xiaofan', '（横刀在天将身前，仰头）听听，你家的看门狗都会说人话了。这天上的衙门，到底看的是什么门？'],
            ['n', '天将不答，拔刀与少年并肩——这一刀，是天兵与凡修第一次同向。'],
            ['xiaofan', '（大笑）好啊！打完这场，你给我把话说全！'],
          ],
          post: [
            ['n', '魉王崩散，裂缝缓缓合拢。天将收刀，深深看了少年一眼，化作金光去了。'],
            ['wantyue', '它临走前说了一个词。你没听见吗——归墟。'],
            ['xiaofan', '（望着合拢的天缝，轻声）听见了。老东西，看来咱们的庆功宴，要摆到天上去了。'],
            ['chen', '（把一颗碎星收进袖中）去吧。这一次，为师陪你到南天门。'],
          ] },
      ],
    },
    {
      title: '卷十二 · 天兵临镇', realm: 9, place: '青石镇',
      intro: '天兵下界，直取青石镇。他们说灵匣是天枢失钥，藏匣者死——可青石镇的人只晓得，那是小凡的匣子。',
      stages: [
        { name: '镇口布告', type: 'story',
          pre: [
            ['n', '青石镇雨季。镇口的老槐树上，一夜之间贴了一张金符，字字如刀：「缉窃钥者林小凡。」'],
            ['qian', '（蹲在符下看了半天）好家伙，通缉令都发到镇口了。林掌柜的招牌，可比这金符气派多了。'],
            ['n', '王婶拢着袖子站在符下，没说话，往地上啐了一口。'],
            ['xiaofan', '（把金符揭下来，掂了掂）料子不错。石坚，回头裁了给娃们做护身符。'],
            ['shijian', '（嘿嘿笑）天上人不知道，你把他们的通缉令做成护身符，够他们气一年。'],
          ],
          post: [] },
        { name: '云梯垂天', type: 'battle',
          foe: { name: '天兵什长', icon: '兵', el: 'jin' },
          pre: [
            ['n', '第三日，云开。一道天梯自云端垂到镇口，甲士列队而下，戈矛如林。'],
            ['n', '什长：「奉天规，缉拿窃钥者。镇民让开——藏匣者，同罪。」'],
            ['n', '青石镇的人没有让。王婶拎着擀面杖站在最前面，身后是全镇的人。'],
            ['xiaofan', '（从人群里走出来，把木匣高举过头）匣子在我身上。要拿，冲我来——动镇上一根草，我掀了你们的天。'],
            ['n', '什长举戈：「放肆！结阵——」'],
          ],
          post: [
            ['n', '什长败退，天兵阵脚自镇口退到了云梯之下。'],
            ['shijian', '（摩拳擦掌）兄弟，痛快！再来一百个，咱青石镇管饱！'],
            ['xiaofan', '（收刀，望着云梯深处）不对劲。他们退得太整齐了——这不是败退，是换将。'],
          ] },
        { name: '全镇一诺', type: 'story',
          pre: [
            ['n', '当夜，全镇人聚在祠堂。火把照着每一张脸，没有一张脸劝小凡交匣。'],
            ['wangshen', '小凡，婶子不懂什么天规。婶子就懂一条：三年前你替全镇挡了黑风寨，今天全镇替你挡一回天。'],
            ['qingxuan', '（把一小罐药塞进他怀里）伤药我备了三个月的量。……不许用完。'],
            ['xiaofan', '（喉头一哽，笑着接过来）用不完。都听好了——天亮之前，谁也不许硬来。他们冲的是我。'],
            ['n', '祠堂外，雨停了。云梯上的甲光，一夜未熄。'],
          ],
          post: [] },
        { name: '阵前论法', type: 'battle',
          foe: { name: '天兵都尉', icon: '将', el: 'jin' },
          pre: [
            ['n', '天亮，天兵换了将。都尉按剑立于阵前，身后是三百重甲。'],
            ['n', '都尉按剑开口：「林小凡。本将读过上古卷：那匣子三百年一响，响时必出大患。幽冥老祖，天外邪神——皆是因它而起。缴匣，是为苍生。」'],
            ['xiaofan', '（静静听完，摇头）你都尉读的卷是神庭写的。我给你读一本真的——（翻开随身的册子）青石镇，三年，开匣四千次。大患零次。饱腹四千次。'],
            ['n', '都尉冷笑：「……强词夺理。」'],
            ['xiaofan', '这不是强词夺理，这是账。神庭的账上只有天，人间的账上还有人。今天我让你选一回：你的刀，落哪本账上？'],
          ],
          post: [
            ['n', '都尉握刀的手松了半寸——就在这半寸里，少年先动了手。'],
            ['baizhi', '（收剑）他最后那一下没还手。'],
            ['xiaofan', '（望着退上云梯的重甲）他也是个听账本的人。可惜啊——他的账本，握在别人手里。'],
          ] },
        { name: '巡天灵官', type: 'battle', boss: true,
          foe: { name: '巡天灵官', icon: '官', el: 'jin' },
          pre: [
            ['n', '第七日，云梯上走下来一位金冠老者。不列阵，不叫阵，只在镇口站定。'],
            ['n', '灵官：「老夫巡天三万年，见过魔头，见过古神。像你这般——全镇人肯陪你死的，头一个。」'],
            ['xiaofan', '（走出人群，把木匣递到灵官面前）老先生，先别急着拿。它响不响，你听听——'],
            ['n', '木匣在灵官手边，轻轻鸣了一声。像招呼，又像叹息。'],
            ['lingguan', '（浑身一震，猛地退后三步）……天枢钥，认你了。三万年了，它头一回……认人。'],
            ['xiaofan', '那就别拿了。回去告诉你们的天——它认的不是我，是人间。'],
            ['lingguan', '（良久，叹）小子，神庭会派元帅来。届时刀兵无眼——你，当真不交？'],
            ['xiaofan', '（把匣子收回腰间，笑）它响，我就养着它。它是我捡来的家。'],
          ],
          post: [
            ['n', '灵官转身登梯，走出几步，停住，没有回头——'],
            ['lingguan', '「三百年前，有个老家伙也这么说过。他叫……罢了。元帅十日后至。青石镇，早做打算。」'],
            ['xiaofan', '（猛地抬头）等等——你说谁？！'],
            ['n', '金光没入云端，只留下一句散在风里的话，和少年攥紧的刀柄。'],
          ] },
      ],
    },
    {
      title: '卷十三 · 诸宗会盟', realm: 9, place: '落霞山',
      intro: '十日后，神庭元帅将至。四海修士齐聚落霞山——有人来结盟，有人来看热闹，有人来赌一个新天。',
      stages: [
        { name: '群雄上山', type: 'story',
          pre: [
            ['n', '落霞山，白芷重立的剑宗山门。各宗修士循着请柬上山，山道上人来人往，比坊市还热闹。'],
            ['baizhi', '（立在山门，一一还礼）剑宗重开三年，头一回这么多人。都进——帖子是我发的，饭是我管的。'],
            ['qian', '（挑着账本上山）白掌门，劳军物资云来坊市包了！记账上——这一回要是打赢了，利息就免了！'],
            ['xuanji', '（抚须）钱掌柜，你这账本打赢了怎么免息，打输了怎么办？'],
            ['qian', '（一本正经）打输了？打输了账本送给元帅，让他也学着记账。'],
          ],
          post: [] },
        { name: '帅旗压境', type: 'battle',
          foe: { name: '降魔枪骑', icon: '骑', el: 'huo' },
          pre: [
            ['n', '会盟第三日，天边烧红了一线。不是晚霞——是神庭元帅的先锋，枪骑五百，踏云而来。'],
            ['n', '枪骑不攻山，只把落霞山围了一圈，像给山系了一条火的腰带。'],
            ['shijian', '（扛着部族的猎旗上山）兄弟！三百猎手，一个不少！蛮族没别的，就是不怕天！'],
            ['xiaofan', '（站在山门，望着火环）他们不急着打。这是围点——等元帅到了，再打援。'],
            ['baizhi', '（拔剑）那就在元帅到之前，先撕开一道口子，杀杀他们的气焰。'],
          ],
          post: [
            ['n', '枪骑退潮般撤围三十里。火腰带松了，山上人心却拧紧了。'],
            ['wantyue', '（抚琴压阵，琴音所过，枪骑阵型自乱）他们的阵，靠军心。军心这东西，琴最懂。'],
          ] },
        { name: '星盘问天', type: 'story',
          pre: [
            ['n', '入夜，玄机子独自登上观星台，把三十年没动过的星盘全数摆开。小凡守在旁边添灯油。'],
            ['xuanji', '（盯着星盘，忽然）小凡，你可知道「神庭」二字，最老的一笔写在何处？'],
            ['xiaofan', '写在……天规上？'],
            ['xuanji', '写在旧天道的遗诏上。（指尖划过星图）十万年前，天道不是衙门，是个「人」。他以人身行道，万灵敬他为天。后来他死了——死在天牢里。神庭摄政至今。'],
            ['xiaofan', '（灯油差点洒了）天……也会死？'],
            ['xuanji', '天不会死。会死的，从来都是扛着天的那个人。（转身，目光炯炯）老夫算尽天机，只算出一句：要问旧案，上楼去问。'],
            ['xiaofan', '楼是哪座楼？'],
            ['xuanji', '（大笑，广袖直指天穹）南天门里，周天星台！'],
          ],
          post: [] },
        { name: '夜袭火带', type: 'battle',
          foe: { name: '焰纹重骑', icon: '骑', el: 'huo' },
          pre: [
            ['n', '元帅主帐立在三十里外的云头。斥候回报：帐中运来了一口囚笼，笼中黑气隐隐。'],
            ['qingxuan', '（皱眉）那黑气……好熟悉。像寒霜原冰层下的味道。'],
            ['xiaofan', '（眼神一冷）他们抓了人。或者是……抓了什么别的东西当刀。'],
            ['baizhi', '（已然按剑）夜袭主帐，放笼，退兵。三炷香之内。'],
            ['xiaofan', '（点将）石坚带猎手断后路，挽月琴音乱阵，白芷随我撬笼。清璇守山——今夜的伤药，别浪费。'],
          ],
          post: [
            ['n', '囚笼撬开，里面不是人——是一截封在玄冰里的、魔气森然的断角。'],
            ['chen', '（接过断角，神色复杂）幽冥老祖的角。神庭把他从转世路上截了下来，磨成了刀。'],
            ['xiaofan', '（沉默半晌，把断角包好）先收着。这笔账，连本带利，记到元帅头上。'],
          ] },
        { name: '降魔元帅', type: 'battle', boss: true,
          foe: { name: '降魔元帅', icon: '帅', el: 'jin' },
          pre: [
            ['n', '第十日，元帅至。金甲白袍，未带一兵——只提一杆降魔杵，独身落在落霞山门前。'],
            ['n', '元帅：「林小凡。本帅不诛你。交匣，随本帅上天领罚——三界之兵，即刻自退。」'],
            ['xiaofan', '（独自出阵）元帅好算计：拿你一个，换我四海罢兵。可惜你算漏了一样——'],
            ['n', '山门之后，四海修士列阵而出，旌旗蔽野。没有人后退半步。'],
            ['xiaofan', '——我这个人，从来不单独挨打。'],
            ['n', '元帅举杵，金光贯野：「那便以降魔二字，会一会你这人间二字！」'],
          ],
          post: [
            ['n', '降魔杵断，元帅单膝触地，金甲上裂纹如蛛网。他没有再起身，只是仰头看着少年。'],
            ['n', '元帅喘着，忽然问：「……十万年，本帅头一回打赢一半。小辈，你可知为何神庭必欲得匣？」'],
            ['xiaofan', '愿闻其详。'],
            ['n', '元帅一字一顿：「天幕之外，有物名归墟。旧天道，是它吃掉的最后一口食。匣开，天漏。神庭锁的不是你——是天外那一张嘴。」'],
            ['n', '满山寂静。风吹过落霞山，第一次有了寒意。'],
            ['xiaofan', '（收刀，缓缓伸手拉起元帅）老将军，这话，你早说就好了。走，上山喝口热茶——这一回，咱们换个问法。'],
          ] },
      ],
    },
    {
      title: '卷十四 · 登天梯', realm: 9, place: '通天古梯',
      intro: '神庭既言天幕有漏，那便上天亲眼看。通天古梯自海底升起——十万年了，它第一次朝人间开放。',
      stages: [
        { name: '海眼开梯', type: 'story',
          pre: [
            ['n', '东海海眼，七天七夜的潮退。第九日清晨，一道青石古梯自海底缓缓升起，直没入云。'],
            ['qian', '（看着梯子咽口水）诸位，这梯子……有多少级？'],
            ['xuanji', '（掐算）三万六千级。一步一重天。'],
            ['qian', '……我就送到这儿。账本你们带上，打赢了记得回来结账。'],
            ['xiaofan', '（笑）钱掌柜，你的货船不是号称「云来快脚」吗？'],
            ['qian', '（一拍大腿）对啊！走水路！——等等，这是梯子，没有水路！'],
            ['shijian', '（把两筐干粮捆上背，咧嘴）钱掌柜，兄弟背你。管饭就行。'],
          ],
          post: [] },
        { name: '梯上云阶', type: 'battle',
          foe: { name: '罡风隼', icon: '隼', el: 'jin' },
          pre: [
            ['n', '第一万级往上，罡风如刀。风里有隼——羽翼是青金石的颜色，叫声能割裂云层。'],
            ['n', '罡风隼不伤人，只啄梯。青石台阶被啄落之处，云海便漏出一个洞。'],
            ['qingxuan', '（扒着栏杆看了一眼洞底，脸色发白）下面……下面没有海了。是星。'],
            ['xiaofan', '（横刀护住队尾）别看下面，看脚下。这些隼在守规矩——它们啄的不是人，是「不该上天的重物」。'],
            ['shijian', '（拍拍背上的干粮筐）那俺这俩筐……'],
            ['xiaofan', '（大笑）你是「该上天的力气」，不算重物！上！'],
          ],
          post: [
            ['n', '过了风隼岭，云海豁然开阔。回头望，人间已成棋盘大小。'],
            ['wantyue', '（第一次露出怯意，又忍住了）原来我们守了半辈子的天下……只是云下的一块田。'],
            ['xiaofan', '（把她的琴囊往上托了托）田好。天上人打了一万年，就是忘了田。'],
          ] },
        { name: '半山石语', type: 'story',
          pre: [
            ['n', '两万级处，古梯中段，一块丈高的青石立在梯心，石上刀刻密密麻麻的名字。'],
            ['chen', '（抚过石面，轻声）登天录。每一个凭自己脚力登天的人，都留了名。三万六千个名字——最末一个，十万年前刻的。'],
            ['xiaofan', '（凑近去看最后一个名字，念）「陈……」'],
            ['chen', '（不动声色地岔开）看什么呢，走了。天黑前得过云线。'],
            ['xiaofan', '（盯着师父的背影，没再问，只在心里把那个名字描了一遍）'],
          ],
          post: [] },
        { name: '云线之战', type: 'battle',
          foe: { name: '巡空鹫卫', icon: '卫', el: 'jin' },
          pre: [
            ['n', '云线之上，天兵的巡逻密了。鹫卫骑着空鹫，一来就是九骑，戈尖挑着拘魂锁。'],
            ['n', '鹫卫：「登天无诏者，拘。携天枢失物者，格杀。」'],
            ['shijian', '（把大旗往肩上一插）兄弟们，梯子窄，正好一打一！蛮族的规矩：谁先喊疼谁下山！'],
            ['xiaofan', '（笑骂）都收着点——拘魂锁别碰着，被勾住魂，神仙难救。（拔刀）三万级之前，杀穿他们！'],
          ],
          post: [
            ['n', '九骑尽退。少年拄刀喘息，指尖擦过刀身上的缺口——这是渡劫之后，刀第一次崩口。'],
            ['baizhi', '（替他看了眼刀口）天上的铁，比地上的硬。'],
            ['xiaofan', '（直起身，咧嘴）那正好。我的刀，还缺一场硬的。'],
          ] },
        { name: '守梯石翁', type: 'battle', boss: true,
          foe: { name: '守梯石翁', icon: '翁', el: 'tu' },
          pre: [
            ['n', '三万六千级，梯尽处云海翻涌——一位石人老翁拄杖立于天门之前，身上落满了十万年的云。'],
            ['n', '石翁：「梯，是老夫砌的。人，是老夫一个一个数上去的。三万六千个名字里，没有你。」'],
            ['xiaofan', '（收刀入鞘，整了整衣冠，长揖到地）老先生，晚辈林小凡，青石镇人。今日登天，不为窥天，不为僭越——只为问一句旧案。'],
            ['shiweng', '（杖尖轻轻点地）问案？十万年了，头一个上梯问案的。（浑浊的石眼亮了半分）那老夫换个问法——'],
            ['n', '石杖轰然砸下，云海炸开千丈：「——人间的事，人间解决不了，才上梯。你，解决得了吗？！」'],
            ['xiaofan', '（迎着石杖，一步不退，直起腰来）解决不了。所以才上去学！学会了，回去解决！'],
            ['n', '石杖停在少年头顶三寸。云海静了。'],
          ],
          post: [
            ['n', '石翁盯着少年看了很久很久，忽然笑了。石头笑起来，像春天冻土开裂。'],
            ['shiweng', '「上一个这么答的，如今在天牢里。（侧身让路，杖指天门）上去吧。替他——把这一问，问完。」'],
            ['xiaofan', '（心脏重重一跳）前辈，上一个……叫什么？'],
            ['shiweng', '「登天录最末一个名字。自己去看——哦，你已经在半山看过了。」'],
            ['n', '少年怔在原地。天门缓缓开启，门内是天上的光。'],
          ] },
      ],
    },
    {
      title: '卷十五 · 南天旧门', realm: 9, place: '南天门遗迹',
      intro: '南天门塌了一半，另一半上挂满了蛛网般的封条。门后没有天宫，只有一座空了十万年的、旧天道的家。',
      stages: [
        { name: '断门风声', type: 'story',
          pre: [
            ['n', '南天门。半扇门斜插在云里，封条层层叠叠，最老的一张已经脆得一碰就碎。'],
            ['xiaofan', '（抚过门上刀痕）这刀痕……不是外敌砍的。是从里面，往外破的。'],
            ['chen', '（背着手，声音很低）十万年前，有人从这里出去过一回。之后，神庭就把门封了。'],
            ['shijian', '（压低声音）师父，里头有人吗？'],
            ['n', '风穿过断门，呜呜作响。像有人隔着一座天，吹了一声口哨。'],
          ],
          post: [] },
        { name: '门缝夜谈', type: 'battle',
          foe: { name: '封条守偶', icon: '傀', el: 'jin' },
          pre: [
            ['n', '入夜，封条上的镇字符活了，化作纸人守偶，见了生人就撕。'],
            ['n', '守偶不说话，动作却整齐地指向一处——门后最深处的星台方向。'],
            ['xiaofan', '（刀背拍飞一只纸人）这些封条是神庭贴的，可这些纸人指的路，不是神庭的路。'],
            ['baizhi', '（剑挑纸人，忽而）有人在借封条引路。这门里，除了神庭，还有别人。'],
          ],
          post: [
            ['n', '最后一只纸人撕碎了，碎片在半空排成两个字，随即散去：「快走。」'],
            ['xiaofan', '（与白芷对视一眼）走。但走正门——人家引的路，未必是好意。'],
          ] },
        { name: '偷星的人', type: 'story',
          pre: [
            ['n', '断门内的星台废墟里，篝火的光。火边坐着一个少女，正就着火光，往一张星图上描最后几笔。'],
            ['n', '少女头也不抬：「过路的？登记住丢了，自己补一张。星台西侧不能睡，漏星雨。」'],
            ['xiaofan', '（打量她衣袍——神庭星官制式，但摘了所有徽记）星官大人，好雅兴，偷完星还描图？'],
            ['lingxi', '（笔尖一顿，抬头，眼睛亮得吓人）「偷」？（把星图一抖）周天星台三百六十座，神庭封了三百五十九座，只许他们算天，不许别人看天——我把星图描下来给三界看，这叫偷？'],
            ['xiaofan', '（笑了）不叫偷。这叫记账。和我干的是同一行。'],
            ['lingxi', '（警惕地眯眼）……你是谁？'],
            ['xiaofan', '林小凡。被你们通缉的那个「窃钥者」。'],
            ['lingxi', '（猛地站起来，星图哗啦散了一地——她顾不上捡，一把抓住小凡的袖子）天枢钥？！你真把它带上来了？！快、快给我看看——它到底为什么响？！'],
          ],
          post: [] },
        { name: '残星成阵', type: 'battle',
          foe: { name: '落门残卫', icon: '卫', el: 'jin' },
          pre: [
            ['n', '星台外围，神庭的守卫残部循着灯光摸了过来。为首的甲士举着缚仙索。'],
            ['n', '甲士：「叛星官灵汐，私描天图，罪加一等。携钥者林小凡，一并锁拿。」'],
            ['lingxi', '（把星图往怀里一塞，抄起测星的长杆）林小凡！帮你打架可以——但说好了，打完这仗，你带我下山！'],
            ['xiaofan', '（横刀，笑）成交。天上这破地方，本来也没什么好待的。'],
          ],
          post: [
            ['n', '残卫溃退。灵汐拄着长杆喘气，忽然想起来什么似的，瞪圆了眼——'],
            ['lingxi', '等等，我刚才是不是……主动说要下界了？（哀嚎）我的星籍！我攒了三百年的月俸！'],
            ['shijian', '（拍她肩，语重心长）妹子，想开点。下界的账本，比天上的俸禄值钱。'],
          ] },
        { name: '门神巨灵', type: 'battle', boss: true,
          foe: { name: '门神巨灵', icon: '神', el: 'tu' },
          pre: [
            ['n', '离断门百丈，地面隆起——一尊百丈巨灵自云根里坐起，肩上驮着半扇倒塌的门。'],
            ['n', '巨灵的声音像山崩前的前兆：「门塌之日，老夫发过誓——神庭的人，一个不放；旧主的人……」（独目扫过众人）「也一个不放。十万年了，没人配过这扇门。」'],
            ['xiaofan', '（踏前一步，仰头）老前辈，我们不配。可我们身后的三界——快配不上了。'],
            ['n', '灵匣在少年腰间，嗡的一声，鸣得又长又亮。'],
            ['n', '巨灵独目骤缩：「这声音……这声音老夫听过。十万年前，每一级台阶上，都响过。」'],
            ['xiaofan', '那就再听一回。（拔刀）我们过去，门就不会再塌第二次。'],
          ],
          post: [
            ['n', '巨灵缓缓跪坐回云根，让开的路正对断门——门后，周天星台的星光连成一线。'],
            ['n', '巨灵缓缓侧首：「去吧。老夫驮着这半扇门等了十万年，就等一个……敢把门重新装回去的。」'],
            ['lingxi', '（小声）周天星台在星轨正中，神庭必重兵把守——喂，你不会真打算硬闯吧？'],
            ['xiaofan', '（望着星光，笑了）硬闯多难看。我们去，借星星看一眼天。'],
          ] },
      ],
    },
    {
      title: '卷十六 · 周天星台', realm: 9, place: '周天星台',
      intro: '周天星台，天上第一个说真话的地方。星图铺开的那一夜，所有人都看见了同一件事——天，曾经是一个人。',
      stages: [
        { name: '星台点灯', type: 'story',
          pre: [
            ['n', '周天星台。三百六十盏星灯次第亮起，把整座天穹的旧星图照得纤毫毕现。'],
            ['lingxi', '（铺开星图，指尖划过一处空白）看这儿。周天星图十万年不缺角——缺的这一个人形，就是被神庭从天上抹掉的。'],
            ['n', '星图上，那人形以身为梁，撑着整片天穹。梁下万灵，梁上归墟。'],
            ['wantyue', '（轻声念出星图旁的注）「以身为天者，殁，葬于天牢。」'],
            ['xiaofan', '（盯着那道梁看了很久）他撑着天的时候……人间在干什么？'],
            ['lingxi', '（翻出另一角星图）在种田，在开匣，在吵架，在过节。跟他现在做的事，一模一样。'],
          ],
          post: [] },
        { name: '星轨异动', type: 'battle',
          foe: { name: '缉星天犬', icon: '犬', el: 'huo' },
          pre: [
            ['n', '星灯亮到第三百盏，天边传来锁链拖地般的声音——神庭的缉星天犬，循着星光找来了。'],
            ['n', '天犬不吠。它们的眼睛是两团火，看见星图就烧，看见记星的人就追。'],
            ['lingxi', '（抄起长杆护住星图）烧一张我描一张！气死他们！'],
            ['shijian', '（大笑，拎着猎旗上阵）好志气！妹子，这架蛮族帮你打了！'],
            ['xiaofan', '（横刀断后，回头看了一眼星图缺口）接着点灯。今夜灯全亮——让全天上都看看那个人形。'],
          ],
          post: [
            ['n', '天犬退去。第三百六十盏星灯亮起的一瞬，整座周天星台嗡然长鸣——十万年第一次。'],
            ['chen', '（立在星图下，久久不动。灯影里，没人看见他抬手抹了一下眼角）'],
          ] },
        { name: '帝君传音', type: 'story',
          pre: [
            ['n', '星台长鸣未歇，一道传音符破空而入，悬在半空，字字如钟——'],
            ['tianjun', '「林小凡。十日前，青石镇，本座未至，是给灵官面子。今夜星台灯亮，本座再问最后一次：交匣。」'],
            ['xiaofan', '（对着传音符，慢条斯理）帝君，先答我一句——旧天道，是不是你们杀的？'],
            ['n', '传音符沉默了足足十息。天上的云，都仿佛停了。'],
            ['tianjun', '「……不是神庭杀的。是本座，亲手囚的。」（顿）「他死了。天不能没有规矩。本座替他执了十万年——这十万年，三界无一处天漏。」'],
            ['xiaofan', '那你今夜怕什么？星台一盏灯，你就坐不住了。'],
            ['tianjun', '「因为灯一亮，人间就要问。问，是漏。」（传音符烧尽前，最后一字像叹息）「小辈，天漏了，归墟就来了。你来替三界赔么？」'],
          ],
          post: [] },
        { name: '缉星使至', type: 'battle',
          foe: { name: '缉星使', icon: '星', el: 'shui' },
          pre: [
            ['n', '话音未落，星台外星光倒卷——一位白袍星使踏着拘星锁而来，身后三十六根星钉，根根锁着空星位。'],
            ['n', '缉星使：「奉帝君令，封星台，拘叛星官，拿窃钥者。」'],
            ['lingxi', '（把最后一张星图塞进小凡怀里，抄杆而立）图你拿着！我断后——林小凡，图比我的命值钱！'],
            ['xiaofan', '（把图原样塞回她怀里，拔刀）都闭嘴。图、人、命，我全都要。'],
            ['n', '他转身面向缉星使，刀尖挑起第一根星钉——'],
            ['xiaofan', '天上的规矩我记下了：问，是漏。（刀光一闪）那今夜，我就把天问成筛子。'],
          ],
          post: [
            ['n', '三十六根星钉尽数崩落。缉星使败退时，回头看了一眼星图上那个人形，忽然收了手印，整了整衣冠，朝星图拜了三拜，方才遁走。'],
            ['lingxi', '（怔怔地）他……是帝君的贴身星使啊。'],
            ['wantyue', '（轻声）天上的心，也不是铁打的。'],
          ] },
        { name: '星官归心', type: 'story',
          pre: [
            ['n', '战罢。星台灯下，灵汐把三百张星图摊开，一张一张重新拼好，像在拼一个时代的伤口。'],
            ['lingxi', '（拼到最后一张，手停了）林小凡，我问你一句实话。你要是把天问漏了，归墟下来，三界赔不起——你想过没有？'],
            ['xiaofan', '想过。（盘腿坐下，把木匣搁在膝上）所以我不当只管掀桌子的。掀了旧的，得有人搭新的。'],
            ['lingxi', '谁搭？'],
            ['xiaofan', '（敲了敲木匣）它搭。它响一次，人间就多一个开匣的人。开匣的人多了——（抬眼，笑）搭天的砖就多了。'],
            ['lingxi', '（盯着他看了半晌，忽然把长杆一收）……行。星官灵汐，从今夜起，记你账上。'],
            ['xiaofan', '（大笑）不记我账上——记三界的账上。'],
          ],
          post: [] },
      ],
    },
    {
      title: '卷十七 · 天牢旧魂', realm: 9, place: '天牢',
      intro: '天牢在天的最底层，关着十万年不敢放出来的旧案。牢中最深处那一间，没有门——因为里面的人，从没想过再出去。',
      stages: [
        { name: '牢门问名', type: 'story',
          pre: [
            ['n', '天牢。层层狱门向下，每一扇门上都刻着罪名，最重的一扇刻的是：「僭天。」'],
            ['lingxi', '（声音发紧）「僭天」这间牢……没有锁。'],
            ['chen', '（立在门前，久久不动）不需要锁。自愿进来的，何须锁。（抬手，轻轻叩了三下门）'],
            ['n', '门内，传来一声极轻极轻的、如钟磬余音的叹息：「……门外，是几个人？」'],
            ['xiaofan', '（对着门，认真地）四个。还有一个，在门里。'],
            ['n', '门内静了很久，然后笑了。那笑声很轻，却让整座天牢的狱火都亮了一分：「四个人，来翻十万年的旧案。好，好啊。」'],
          ],
          post: [] },
        { name: '狱底寒渊', type: 'battle',
          foe: { name: '冤魂狱卒', icon: '魂', el: 'shui' },
          pre: [
            ['n', '下行的狱梯上，旧年的冤魂循着活人的气息聚来。它们不是恶灵——只是十万年没人听过它们说话。'],
            ['n', '冤魂们围过来，一遍一遍重复着自己的名字，像在确认自己存在过。'],
            ['qingxuan', '（掏出药囊点燃安神香，声音发颤但手很稳）别打。听——他们在报名字。'],
            ['xiaofan', '（收刀，深吸一口气，一个名字一个名字地应）「铁匠张……采药刘……教书李……」（一个一个，郑重点头）在的。都在的。'],
            ['n', '冤魂们安静下来，让开一条路。十万年，天牢第一次有人被「听见」着送行。'],
          ],
          post: [
            ['n', '狱底到了。「僭天」之门就在眼前，门缝里透出的不是狱火——是星光，和人间灶火一样的暖黄色。'],
          ] },
        { name: '旧魂夜话', type: 'story',
          pre: [
            ['n', '门开了。牢中无刑具，无锁链，只有一盏灯、一卷没写完的星图，和一个由光凝成的、看不清面目的身影。'],
            ['n', '旧魂：「十万年了。头一个客人，是个采药少年。上一个……」（声音顿了顿）「也是个不肯交匣子的。」'],
            ['xiaofan', '（心跳如鼓，仍稳稳开口）前辈，晚辈有三问。一问：归墟到底饿什么？二问：神庭错了吗？三问——'],
            ['tiandao', '（抬手止住）第三问，问你自己。（光影像是笑了）前两问，老夫答你：归墟饿的不是血肉，神庭也没有全错——怕死的规矩，也是规矩。'],
            ['xiaofan', '那它到底饿什么？'],
            ['tiandao', '「饿『没人记得』。」（光影晃了晃，像叹息）「归墟吞掉的每一位神、每一桩事，只要世间还有一人记得，它就还没真正吃下去。老夫撑了十万年天，靠的也不是法力——是人间还记得『天该是个人』。」'],
            ['xiaofan', '（浑身一震，忽然懂了）所以匣子响。所以开匣的人，都是在……记着您？'],
            ['tiandao', '「不。（光影缓缓摇头）是在记着——人自己。」'],
          ],
          post: [] },
        { name: '牢中劫火', type: 'battle',
          foe: { name: '罚恶司', icon: '刑', el: 'jin' },
          pre: [
            ['n', '夜话未尽，天牢顶层传来轰鸣——神庭的罚恶司到了，率狱卒铁卫，要「清牢」。'],
            ['n', '罚恶司：「帝君有令：僭天旧魂，就地湮灭。探牢者，同罪。」'],
            ['tiandao', '（光影微微一晃）「孩子们，出去。老夫这里，从来只是时间问题。」'],
            ['xiaofan', '（横身挡在牢门前，刀已出鞘）前辈，您十万年没问过一句话——今夜话没说完，谁也别想灭这儿的一点灯火。'],
            ['n', '身后，冤魂们无声聚拢，站在了少年身后。'],
          ],
          post: [
            ['n', '罚恶司败退。天牢的狱火第一次烧成了暖金色——那是十万年来，头一回有人在这底下「赢」。'],
            ['tiandao', '（光影淡了几分，笑声却亮了）「好刀。小凡，上来。老夫欠天上一问——你替我问。」'],
          ] },
        { name: '天问残章', type: 'story',
          pre: [
            ['n', '临别，旧魂以最后的光，在少年刀身里渡了一点星光。'],
            ['tiandao', '「这一式，叫『天问』。不增杀力，只增一物——你每一刀，都在替天下人发问。」（光影开始散，声音却越来越清）「记住，小凡。天可以塌，规矩可以改。只有一件事不能——」'],
            ['xiaofan', '（跪坐灯前，一字一句）「不能忘了人。」'],
            ['tiandao', '「……答对了。（笑声散在星光里）去吧。牢门不用关——从今夜起，天牢，改成登天录的分册。」'],
            ['n', '星光落尽。满牢冤魂的狱火，齐齐亮如白昼。'],
          ],
          post: [] },
      ],
    },
    {
      title: '卷十八 · 神庭之乱', realm: 9, place: '神庭外朝',
      intro: '天兵也是人修上去的。当「天规」和「账本」摆在一起，十万年不曾有人问过的问题，终于摆上了神庭的朝堂。',
      stages: [
        { name: '朝天阙', type: 'story',
          pre: [
            ['n', '神庭外朝。金阙千重，天兵十万，甲光映得云海都是白的。'],
            ['qian', '（扒着云头往下看，倒吸凉气）我的娘诶，这一朝的天兵，顶我们三界全部修士……的十倍军费！'],
            ['lingxi', '（白他一眼）重点是这个吗？'],
            ['qian', '（一本正经）重点就是这个。养兵要钱，钱从哪来？香火、灵石、贡赋——天上也要过日子，过日子就有账本。有账本，就有得谈！'],
            ['xiaofan', '（笑）钱掌柜，你打算跟神庭……对账？'],
            ['qian', '（拍胸脯）对账是俺祖传的手艺！'],
          ],
          post: [] },
        { name: '阵前对账', type: 'battle',
          foe: { name: '金甲武士', icon: '甲', el: 'jin' },
          pre: [
            ['n', '外朝门前，金甲武士百人列阵。不攻，只拦——十万年，神庭第一次遇到「上门问话」的凡人。'],
            ['n', '领头的武士沉沉开口：「退回去。本将奉的是天规。天规没有『问话』这一条。」'],
            ['xiaofan', '（不拔刀，往前走了一步）那本账上有没有这一条：十万年，天兵的抚恤，发到人间几家了？'],
            ['n', '百人金甲，静了。有人的戈，往下沉了半寸。'],
            ['n', '领头武士的声音哑了一瞬：「……你，怎么知道的。」'],
            ['xiaofan', '（抬手，身后钱多多哗啦翻开账本）因为有人替你们记着。三百年，一笔没漏。'],
          ],
          post: [
            ['n', '金甲阵，自己裂开了一条道。没有命令——是武士们自己让的。'],
            ['qian', '（合上账本，擦汗，小声）林掌柜，成了？'],
            ['xiaofan', '（望着朝堂深处）开了个头。天上的心，也是肉长的——就是锈了十万年，得一点点擦。'],
          ] },
        { name: '武曲夜宴', type: 'story',
          pre: [
            ['n', '当夜，武曲星君设私宴——没有传召，没有仪仗，只有一坛酒，两个杯。'],
            ['n', '武曲（卸了甲，是个满脸风霜的老将模样）：「小辈，酒是人间烧刀子。三百年前，一个青石镇的小子给本将带过一坛。」'],
            ['xiaofan', '（执杯的手一顿）王婶家的酒。'],
            ['wuqu', '「就是那个味道。（一饮而尽）本将问你——你可知帝君为何十万年不肯见你？』'],
            ['xiaofan', '怕我问。'],
            ['wuqu', '「错。是不敢答。（望着杯底）旧天道进天牢那年，帝君是执刀人。刀是他亲手落的。从那夜起，他再没卸过甲——他不是怕你问，他是怕自己答。」'],
          ],
          post: [] },
        { name: '朝堂惊变', type: 'battle',
          foe: { name: '执戟郎将', icon: '郎', el: 'jin' },
          pre: [
            ['n', '第三日，小凡依约上朝。朝堂之上，帝君未至——摄政的礼官却宣了一道新的天规：「凡间修士林小凡，妖言惑众，褫夺登天录名籍，永拘天牢。」'],
            ['xiaofan', '（立于丹墀之下，不跪，笑）好大的规矩。请问礼官，这条天规，是十万年前就有的，还是昨夜新写的？'],
            ['n', '满朝寂静。每一位天官的袖子里，都藏着一部自己的账。'],
            ['n', '礼官额头冒汗：「天规……天规即是如此！执戟郎，拿下！」'],
            ['n', '执戟郎将上前——却在半途横戟立定，挡在了礼官身前。'],
            ['n', '执戟郎将横戟立定，声音不大，满朝皆闻：「末将的戟，十万年只奉旧例。旧例里，没有『不许问』。」'],
          ],
          post: [
            ['n', '朝堂哗然。半数天官出列，站到了郎将一侧。神庭十万年的铁桶，从里面裂开了第一道缝。'],
            ['lingxi', '（在云头看着，喃喃）原来不是天不可撼——是没人问过。'],
          ] },
        { name: '金甲武曲', type: 'battle', boss: true,
          foe: { name: '金甲武曲', icon: '君', el: 'jin' },
          pre: [
            ['n', '乱起时，武曲披甲而出——不是为了镇压，是为了把乱局拦在帝君大殿之前。'],
            ['wuqu', '「小辈，本将敬你是条汉子。但朝堂之下是兵枢，兵枢之再下，是帝君的剑冢——那一步，跨不得。」'],
            ['xiaofan', '（横刀，抱拳）老将军，我不是来跨那一步的。我是来递一句话——当面递。'],
            ['wuqu', '「帝君不见。」'],
            ['xiaofan', '那就打到你见。（刀起）打赢了，您替我递话；打输了，这颗头颅给您，话也照样递到——用刀刻在您甲上。'],
            ['wuqu', '（大笑，金甲铮然）「好！十万年没听人跟本将这么讲过话了——接刀！」'],
          ],
          post: [
            ['n', '三百回合。金甲崩了一角，刀锋卷了半寸。最后，两件兵器同时停在了对方的咽喉前一寸——平手。'],
            ['wuqu', '（收甲，长啸）「痛快！——话，本将递。但帝君答不答，看天意。」'],
            ['xiaofan', '（还刀入鞘，喘着笑）天意？老将军，天意这东西——（指了指自己胸口）如今在人间。'],
          ] },
      ],
    },
    {
      title: '卷十九 · 外天暗渊', realm: 9, place: '天幕之眼',
      intro: '天幕之眼，是十万年来唯一一道能窥见外天的缝。缝的那一边，不是星空——是一张慢慢合拢的、饿的嘴。',
      stages: [
        { name: '启眼', type: 'story',
          pre: [
            ['n', '天幕之眼。神庭封了十万年的大阵前，帝君终于现身——金甲未卸，面容比传闻里年轻，眼神却比天牢还旧。'],
            ['tianjun', '「你要看，本座便给你看。看完之后——」（甲叶轻响）「要么随本座重封天幕，永镇归墟；要么，你来做那个十万年前的旧人。」'],
            ['xiaofan', '先看。看完再选。'],
            ['n', '大阵开启。天幕裂开一线——外天的景象，第一次映进众人眼中。'],
          ],
          post: [] },
        { name: '渊上一瞥', type: 'story',
          pre: [
            ['n', '外天没有光。没有星。只有「暗」在缓缓地、极有耐心地流动——像胃壁的蠕动。'],
            ['n', '暗流之中，悬浮着无数残骸：古神的骨、旧天的碎片、整座整座的星球——都被啃得干干净净，只剩「形状」。'],
            ['qingxuan', '（捂住嘴）那些星星……是空的。里面的东西都被吃掉了。'],
            ['n', '暗流深处，缓缓浮起一块碑。碑上旧天道的笔迹，力透万古：「归墟不灭。它是『遗忘』本身。」'],
            ['xiaofan', '（盯着那块碑，一字一字念完，忽然笑了）我懂了。（转身，环视众人）它不是兽，不是魔——它是「没人记得」这件事本身。'],
            ['chen', '（望着碑，轻声）所以旧天道败了。他一个人扛着全天的记忆——一个人的记忆，再重，也有吃完的一天。'],
          ],
          post: [] },
        { name: '触影初探', type: 'battle',
          foe: { name: '归墟触影', icon: '影', el: 'shui' },
          pre: [
            ['n', '天幕之眼开启过久，外天的暗流涌了过来——一只由「遗忘」凝成的巨影，顺着缝隙探了进来。'],
            ['n', '触影所过之处，众人脑中的记忆开始发白：石坚忘了娘的脸，清璇忘了药圃的垄数，挽月的指尖忘了琴弦的位置——'],
            ['xiaofan', '（一刀斩落漫过来的暗，厉声）都报自己名字！大声报！——石坚！你娘叫王秀娘！清璇！你的药圃三十六垄！'],
            ['n', '众人嘶声报着彼此的名字、彼此的事。记忆像退潮又涨潮，一寸一寸抢了回来。'],
            ['xiaofan', '（横刀立于阵前，声震天幕）记住！它吃的是「忘」——咱们偏要「记」！'],
          ],
          post: [
            ['n', '触影缩回外天。天幕之眼缓缓合拢前，暗流深处传来一声若有若无的、失望的叹息。'],
            ['shijian', '（抱着头蹲在地上，好半天，才抬起来，眼睛通红）兄弟……俺娘的脸，回来了。'],
            ['xiaofan', '（重重捶了他胸口一拳，自己的手也在抖）回来了就别再丢了。都记住今夜——记性，就是咱们的兵器。'],
          ] },
        { name: '帝君之夜', type: 'story',
          pre: [
            ['n', '天幕之眼合拢。当夜，帝君独自站在阵前，站了一整夜。天亮时，小凡提着两杯热茶上了天阶。'],
            ['xiaofan', '（递过一杯）帝君，青石镇的粗茶。'],
            ['tianjun', '（接过，久久没喝）「十万年，本座封的不是天。」'],
            ['xiaofan', '我知道。你封的是那道疤——旧天道倒下时，你没能救回来的那道。'],
            ['tianjun', '「……本座杀不了归墟。封天，是唯一试过的活路。（终于饮尽那杯茶）小辈，你若有第三条路——」'],
            ['xiaofan', '（望着天幕，笑）有。它吃「没人记得」。那就让它永远吃不着——十万年都办不到的事，人间这十万年，天天在办。'],
            ['tianjun', '「……讲。」'],
            ['xiaofan', '开匣。天下人，一起开。'],
          ],
          post: [] },
        { name: '武曲殉道', type: 'battle', boss: true,
          foe: { name: '蚀忆巨影', icon: '影', el: 'shui' },
          pre: [
            ['n', '第三夜，天幕之眼裂缝突然自行扩大——外天的暗流试出来了路，蜂拥而入。为首的巨影，比上回大十倍。'],
            ['n', '蚀忆巨影不攻人，直扑神庭的「名籍库」——那里存着十万年所有天兵天将的名录。'],
            ['wuqu', '（率亲兵横身拦在库前）「名录在，弟兄们就还在！——小辈，带人堵缝！这儿，交给老夫！」'],
            ['xiaofan', '（目眦欲裂）老将军——！'],
            ['wuqu', '（头也不回，金甲在暗流里烧成白炽）「递话的事，本将办完了。（举刀）这一件，是本将自己选的——替十万年所有战死的弟兄，把名字守住！」'],
          ],
          post: [
            ['n', '裂缝堵上了。名籍库无损。武曲和他的亲兵，与巨影同归于尽——名录上，他们三万七千个名字，一笔未失。'],
            ['tianjun', '（跪坐库前，抚着名录，一夜白头）（起身时，帝君把金甲卸了，穿着一身素袍，走到小凡面前，长揖及地）「第三条路，本座，陪你走。」'],
            ['xiaofan', '（还礼，眼眶通红，声音却稳）帝君，不陪我。带路。'],
          ] },
      ],
    },
    {
      title: '卷二十 · 议政殿两难', realm: 9, place: '神庭议政殿',
      intro: '神庭十万年第一次开朝议「退」还是「战」。可三界的账，从来不是殿上算清的——是在人间，一匣一匣攒出来的。',
      stages: [
        { name: '殿前问计', type: 'story',
          pre: [
            ['n', '议政殿。天官分列，帝君素袍主位，小凡以「客卿」身份立殿中——十万年破例头一遭。'],
            ['tianjun', '「殿上只议一事：天幕，封，还是开。」'],
            ['n', '天官们吵了三天。封天派说：封天虽闷，能活。开天派说：闷了十万年，外天已到门口，闷死也是死。'],
            ['lingxi', '（凑到小凡耳边）吵不出结果的。天上的架，吵了十万年都是这德行。'],
            ['xiaofan', '（望着殿外的人间方向，笑）那就别在天上吵。这架的账本，在人间。'],
          ],
          post: [] },
        { name: '封天旧档', type: 'battle',
          foe: { name: '守档傀儡', icon: '傀', el: 'tu' },
          pre: [
            ['n', '为找旧天道当年留下的「开天预案」，众人潜入封存十万年的旧档窟。窟中傀儡十年不动，见人翻档便醒。'],
            ['n', '傀儡:「旧档重地。旧主有令——预案，只授继任者。」'],
            ['xiaofan', '（一边格挡一边喊）我就是继任者！开匣的都算！'],
            ['n', '守偶们齐声：「口说无凭。」'],
            ['n', '灵匣在少年腰间，嗡地一声长鸣。傀儡们齐齐一顿，单膝跪了下去。'],
            ['xiaofan', '（愣住，随即失笑）……好嘛，原来钥匙真的能刷开十万年前的门。'],
          ],
          post: [
            ['n', '旧档最深处，一卷《开天预案》静静躺着。扉页旧天道亲笔：「若老夫不在——天，不必一个人扛。」'],
            ['chen', '（看到这行字，终于落下泪来）师兄……你早留了后路。你一直，都在等今天。'],
            ['n', '满殿众人，齐齐看向陈老。「师兄」二字，像一声雷，劈开了十万年的旧案。'],
          ] },
        { name: '师兄', type: 'story',
          pre: [
            ['n', '旧档窟外，云阶之上。所有人都看着陈老。'],
            ['chen', '（负手望着云海，好半天，才开口）十万年前，旧天道座前有两位。一位执剑，是天珩。（顿）一位管「开匣」，是老夫。'],
            ['xiaofan', '（心跳漏了一拍）开匣……？'],
            ['chen', '「天不是他一个人撑的。他撑外面，老夫撑里面——人间每一只开匣的手，都是老夫一根一根接上去的血管。（转身，眼底是十万年的旧光）小凡，你当老夫是青石镇的老药农。其实老夫，是这世上最后一个还记得『开匣』该怎么教的人。」'],
            ['xiaofan', '（忽然明白了什么，声音发颤）那三年前，溪涧边……不是您落难。是您在——挑人。'],
            ['chen', '（笑了，笑纹里全是慈悲）「挑了十万年，就挑到一个肯对匣子说话的。孩子，为师没看走眼——这一回，不会再看走眼了。」'],
          ],
          post: [] },
        { name: '殿上摊牌', type: 'battle',
          foe: { name: '封天死士', icon: '士', el: 'jin' },
          pre: [
            ['n', '《开天预案》呈上议政殿的当夜，封天派死士闯殿焚档——十万年的路，有人不想让它通。'],
            ['n', '死士不说话，烧档的手却稳得可怕。为首者的令牌，是礼官的私印。'],
            ['xiaofan', '（一刀劈飞火折子）礼官，十万年了，神庭养你们这群人，就为了烧自己家祖先的遗书？'],
            ['n', '礼官被郎将死死按住，犹自嘶声：「开了天，归墟进来，谁负责？！宁可万年活死人，不可一朝全族灭——」'],
            ['xiaofan', '（把他踢到一边，护住档案，忽而笑了）这话说反了。人间烧饭要开灶门，开窗要透气——封死的屋子，才先闷死人。'],
          ],
          post: [
            ['n', '档全。礼官下狱。天官们捧着那卷预案，一页一页传阅过去——读到扉页那行字的，都沉默了很久。'],
            ['tianjun', '（合上预案，望向小凡）「三日后，朝议重开。这一次——人间来议。」'],
          ] },
        { name: '天珩帝君', type: 'battle', boss: true,
          foe: { name: '天珩帝君', icon: '君', el: 'jin' },
          pre: [
            ['n', '朝议前夜，帝君单独召小凡入殿。殿中无灯，只有帝君亲手把自己的佩剑横在两人之间。'],
            ['tianjun', '「预案老夫看过十万遍了。每一行都对，只有一件事它没算——开天那日，第一条涌进来的暗流，必冲着灵匣。届时万灵仰望，你若接不住——」（按剑）「三界，连垫背的都没有。」'],
            ['xiaofan', '（看着那柄剑，忽然问）帝君，十万年前落刀的时候，您闭眼了吗？'],
            ['n', '殿内死一样的静。帝君的甲叶，极轻地响了一声。'],
            ['tianjun', '「……没有。本座看着他，他也看着本座。他说：『珩儿，刀落之前，替我看看新天。』（素袍之下，声音哑透）「十万年了。本座没敢看。今夜你若连本座这一关都过不去——就永远别去开那个门。」'],
            ['xiaofan', '（拔刀，横剑而立，眼中却无杀意，只有敬意）帝君，晚辈不接您这一刀——晚辈替旧天道，接您这一刀。'],
          ],
          post: [
            ['n', '一战。殿瓦尽碎，梁柱俱燃。最终帝君的剑钉在少年肩头三寸外的地砖里——他收了三成力。'],
            ['tianjun', '（踉跄半步，望着少年，忽然老泪纵横）「……师兄。新天，有人替你看住了。」'],
            ['xiaofan', '（按着流血的肩，咧嘴笑）帝君，血您也看见了。三日后的朝议——人间，带账本来。'],
          ] },
      ],
    },
    {
      title: '卷二一 · 匣之真相', realm: 9, place: '青石镇溪涧',
      intro: '开天之前，最后一桩旧案要清：这只匣子，到底是什么。答案不在天上——在三百年前那条溪涧边。',
      stages: [
        { name: '溪边旧匣', type: 'story',
          pre: [
            ['n', '青石镇，溪涧。三年前捡到匣子的那块青石还在。水还是那么凉，匣子还是那么旧。'],
            ['xiaofan', '（把匣子搁回青石上）师父，它到底是谁造的？'],
            ['chen', '（蹲下来，掬了捧溪水）旧天道。他殁之前，把自己最后一点本源，混着人间三样东西，铸了它。'],
            ['xiaofan', '哪三样？'],
            ['chen', '「一捧五色土，是人间烟火。一根旧秤砣，是公道。一缕将熄的灯花，是盼头。（笑）所以它响——人间烟火每烧一天，它就响一天。」'],
            ['xiaofan', '（怔住，忽然低头，轻声）那……邪神说它「认主」。归墟说它是「钥匙」。神庭叫它「天枢」——它到底是什么？'],
            ['chen', '「是个问题。（把匣子推回少年怀里）造它就是为了问的：天塌了之后，人还接不接着过日子。每开一次匣，就是答一次。」'],
          ],
          post: [] },
        { name: '镜影照心', type: 'battle',
          foe: { name: '溪心镜影', icon: '镜', el: 'shui' },
          pre: [
            ['n', '匣子归溪的一瞬，水面忽然立起一面镜。镜里走出来的，是少年自己——只是那一个，眼神里没有光。'],
            ['n', '镜影：「开天？你就是个捡匣子的。天塌下来，砸的也是你这种运气好而已的普通人。」'],
            ['xiaofan', '（静静听完，忽然笑了）你说对了一半。我运气是好。'],
            ['n', '镜影冷冷反问：「另一半呢？」'],
            ['xiaofan', '（拔刀）另一半是——运气好的人，也得干活。'],
          ],
          post: [
            ['n', '镜影碎成水雾，落回溪里，汇成一句极轻的话：「……去吧。替我，也开一回。」'],
            ['xiaofan', '（在水边站了很久，才转身，笑得干净）师父，走了。回去干活。'],
          ] },
        { name: '铸天图纸', type: 'story',
          pre: [
            ['n', '溪边夜话。陈老从袖中取出一卷图——《铸天图纸》，旧天道亲手所绘。'],
            ['chen', '「新天不是一座殿，一道门。是一架桥。桥这头是三界，桥那头是外天。桥面——」（指尖点在图上一格一格的纹路）「是开匣的人。一人一格，一格一命。缺一块，塌一段。」'],
            ['lingxi', '（倒吸凉气）那得多少人？'],
            ['chen', '「越多越好。（看向小凡，目光灼灼）多到——归墟吃不完。」'],
            ['xiaofan', '（盯着图上密密麻麻的格子，忽然笑了，笑得眼眶发热）好家伙。这哪是图纸——这是全人间的户口本啊。'],
          ],
          post: [] },
        { name: '旧宅灯火', type: 'battle',
          foe: { name: '幻尘迷障', icon: '障', el: 'huo' },
          pre: [
            ['n', '图纸带下山时，幻尘迷障自暮色里生了出来——它不伤人，只把人往回赶：赶回各自最舒服的旧日子里去。'],
            ['n', '幻境里，小凡回到了三年前：还是那个采药的穷小子，匣子还没响，天下没这么大事。王婶在灶前喊吃饭。'],
            ['n', '幻境很暖。他坐了很久。'],
            ['xiaofan', '（终于起身，替灶里的火添了根柴，轻声）婶子，饭很香。可我得走了——外头还有人等开饭。（提刀出门，头也不回）'],
            ['n', '幻境应声而碎。碎时，灶膛的火光暖了他一背。'],
          ],
          post: [
            ['n', '众人陆续破障而出，人人眼里都带着泪，人人手里都攥着一样从幻境里带出来的东西。'],
            ['wantyue', '（攥着一支幻境里的木簪，轻声）回不去了。但记得住。'],
            ['xiaofan', '（点头）记得住，就够了。归墟最怕的，就是这个。'],
          ] },
        { name: '心魔·天问', type: 'battle', boss: true,
          foe: { name: '心魔·天问', icon: '问', el: 'shui' },
          pre: [
            ['n', '开拔前夜，小凡独坐溪边练刀。刀至酣处，心魔再临——这一回，它不幻化旧影，只问问题。'],
            ['xinmo', '「你开天，是为了三界，还是为了你自己那一口不服？」'],
            ['xiaofan', '（刀不停）都有。'],
            ['xinmo', '「万灵为你筑桥，你受不受得住这份重？」'],
            ['xiaofan', '受不住也得受。'],
            ['xinmo', '「若新天开成，人人有匣，人人开匣——再没人需要林小凡了呢？」'],
            ['n', '刀，停了。少年立于溪心，闭上眼。很久，很静。'],
            ['xiaofan', '（睁眼，笑得前所未有的亮堂）那是我这辈子最想赢的一次。'],
            ['n', '心魔笑了一声，散在风里。这一战，赢了。'],
          ],
          post: [
            ['n', '溪水东流。少年把刀归鞘，对着水面照了照——水里的人，眼神干净。'],
            ['xiaofan', '（对水里的自己点点头）走。造桥去。'],
          ] },
      ],
    },
    {
      title: '卷二二 · 万灵共举', realm: 9, place: '三界',
      intro: '图纸传遍三界，万灵响应。可愿力太盛，也会招虫——专蛀「盼头」的虫。',
      stages: [
        { name: '三界动员', type: 'story',
          pre: [
            ['n', '《铸天图纸》抄本下发三界那一天，四海沸腾。'],
            ['shijian', '（在蛮荒擂鼓聚众）兄弟们！造桥！一人一格！俺们蛮族出十万条汉子——力气管够！'],
            ['qian', '（在坊市挂出巨牌）云来坊市承包全部石材运输！造桥期间，全坊市物价——打九九折！'],
            ['xuanji', '（在星台点齐星灯）星台三十六座，全数开放——夜里干活，天上给照明！'],
            ['qingxuan', '（药圃前支起大锅）伤药、伙食，药王谷包了！管饱！'],
            ['xiaofan', '（站在人间最高的山头，看着四面八方的火把汇成河，轻声）师父，您看见了吗。桥，还没造——格子已经满了。'],
          ],
          post: [] },
        { name: '愿力成川', type: 'battle',
          foe: { name: '愿力蠹群', icon: '蠹', el: 'mu' },
          pre: [
            ['n', '万灵愿力汇成川流，昼夜不息。第七天，川里生了虫。'],
            ['n', '愿蠹不啃桥基，专蛀人心：被蛀的人会忽然丧气——「造什么桥，天塌砸大家」「管什么闲事，过日子得了」。'],
            ['qingxuan', '（给染蠹的工人施针，急得眼圈红）针压得住一时。这虫，蛀的是盼头。'],
            ['xiaofan', '（蹲下来，握住一个工人的手）老哥，你家娃几岁了？——五岁？那你告诉他，爹在造天。等他长大，天上有他爹一块砖。'],
            ['n', '工人的眼神，一寸一寸亮回来。愿蠹在他肩上，无声化成了灰。'],
          ],
          post: [
            ['n', '一夜之间，工地上人人都学会了一句话——「等他长大，天上有我一块砖。」'],
            ['wantyue', '（抚琴压阵，琴音里全是笑意）蠹虫蛀不动这句。'],
          ] },
        { name: '桥基定桩', type: 'story',
          pre: [
            ['n', '通天古梯旧址，新桥第一桩开打。旧梯的石翁亲自扶桩——十万年前的手艺，十万年后接着用。'],
            ['shiweng', '「桩要正。天可以斜，桩不能斜。」'],
            ['xiaofan', '（抡下第一锤）老先生，您说这桥，能成吗？'],
            ['shiweng', '「老夫砌梯那会儿，也这么问过旧天道。（石眼里有笑）他答：成不成，问走上去的人。」'],
            ['n', '第一桩落定，三界万灵的愿力轰然涌入——桥基之上，第一块「人砖」亮起，砖上浮出一个名字：王秀娘。'],
          ],
          post: [] },
        { name: '夜巡工地', type: 'battle',
          foe: { name: '夜游蚀魂', icon: '魂', el: 'shui' },
          pre: [
            ['n', '桥基初成，外天的暗流夜里来犯。蚀魂物不拆桥，专偷「名字」——砖上的名字，一夜被舔掉几十个。'],
            ['xiaofan', '（连夜召集工头）名字丢了，人就白造了？——不行。从今夜起，改规矩：每一块砖的名字，三界各备份一份。天上偷，地上记；地上丢，天上补。'],
            ['shijian', '（扛来一整车的名册）俺娘的名，俺背了三份！'],
            ['baizhi', '（率剑宗弟子结阵夜巡）剑阵所至，寸暗不侵。'],
          ],
          post: [
            ['n', '蚀魂物再无所获。外天的暗流退去时，桥上忽然多亮了三万七千块砖——武曲和他的亲兵，名籍库的名，全部上了桥。'],
            ['tianjun', '（立于桥头，望着那一片新砖，整夜未眠）'],
          ] },
        { name: '噬愿蠹王', type: 'battle', boss: true,
          foe: { name: '噬愿蠹王', icon: '王', el: 'mu' },
          pre: [
            ['n', '桥成三分之一，川底忽然翻起绿潮——万愿所聚，引出了蛀空过三个古文明的蠹王。'],
            ['n', '蠹王不说话。它一生只做一件事：找到「盼头」最盛的地方，一口吞掉。'],
            ['n', '它锁定了桥。'],
            ['xiaofan', '（立于桥头，拔刀）来对地方了。这桥上没有盼头——（身后，十万工地的灯火次第亮起，如星河落地）只有「一定会成」。'],
            ['n', '万灵举火，声震三界。蠹王的绿潮，撞在了人间的灯火山上。'],
          ],
          post: [
            ['n', '蠹王崩散，绿潮退尽。桥上名砖，一块未损。'],
            ['chen', '（望着灯火，久久，轻声）「师兄，你看见了吗。这回不是一个人扛——是万灵共举。」'],
            ['n', '桥基深处，传来极轻的一声鸣。像很多年前，溪涧边那一声。'],
          ] },
      ],
    },
    {
      title: '卷二三 · 天梯再开', realm: 9, place: '通天梯云海',
      intro: '桥要通天，还须天梯引路。可神庭内部，仍有人抱着十万年的旧墙不放——那就在云海里，把这堵墙聊塌。',
      stages: [
        { name: '云海誓师', type: 'story',
          pre: [
            ['n', '通天古梯下，大军誓师。天兵倒戈者过半——灵官亲自执旗，走在最前。'],
            ['lingguan', '（扛着「天问」大旗，声若洪钟）「老夫巡天三万年，今日巡个明白！旗在此——愿问天的，跟上来！」'],
            ['xiaofan', '（抱拳）老先生，通缉令还欠我一件事没说全：三百年前，那个说「匣子是家」的人——'],
            ['lingguan', '（目光一黯，随即一笑）「登完梯，老夫带你去个地方。那儿有一座坟，坟里没有骨头——只有一坛没喝完的酒。」'],
          ],
          post: [] },
        { name: '云涛列阵', type: 'battle',
          foe: { name: '云海风兽', icon: '兽', el: 'mu' },
          pre: [
            ['n', '大军登梯，云海翻腾——风兽自涛中起，不认旗，不认人，只认十万年前「不得登天」的旧令。'],
            ['n', '风兽成群，撕扯大军阵型。旌旗猎猎，人链却一节一节咬死不松。'],
            ['shijian', '（吼）一打一！蛮族的规矩没变过！'],
            ['lingxi', '（长杆挑飞一只风兽）规矩是死的！风是活的——都看旗！旗往哪指，风就从哪来！'],
          ],
          post: [
            ['n', '风兽退潮。云海之上，十万大军旌旗未乱一角。'],
            ['tianjun', '（素袍按剑，走在中军，头一回没有乘辇）「十万年，本座头一回……跟着旗走。」'],
          ] },
        { name: '半梯劝降', type: 'story',
          pre: [
            ['n', '半梯处，倒戈的天兵与守旧的天兵隔云对峙。谁都没先动手——都是十万年的袍泽。'],
            ['xiaofan', '（独自走到阵前，摘了刀，朗声）守梯的弟兄，我就问一句：十万年了，你们可有一次，轮到过自己拿主意？'],
            ['n', '云海死寂。守军的矛，一根一根，微微发着抖。'],
            ['xiaofan', '没有。命令都是上头下的——上头的命令，是怕下的。（拾起地上那卷《开天预案》，高高举起）如今图纸在这儿，路在这儿。问天，不砍人头——只问一句：你们，想不想自己走一回这条梯？'],
            ['n', '第一杆矛落了地。然后是第二杆。第十杆。'],
          ],
          post: [] },
        { name: '内讧惊变', type: 'battle',
          foe: { name: '誓死卫队', icon: '卫', el: 'jin' },
          pre: [
            ['n', '就在守军放下兵器的当口，一支黑甲卫队自云底暴起——神庭最后的死硬派，誓死队。他们不守梯，只杀人：杀倒戈的、杀议和的、杀所有「放下矛」的。'],
            ['n', '黑甲过处，倒戈天兵成片倒下。云海，第一次染了自己人的血。'],
            ['lingguan', '（目眦欲裂，举旗迎上）「畜生！天兵的刀是护天的——不是护你们那点怕！」'],
            ['xiaofan', '（拔刀，声震云海）结阵！天兵的兄弟往后撤——这一仗，人间的刀来打！'],
          ],
          post: [
            ['n', '誓死队尽墨。云海之上，十万天兵为倒戈的袍泽默立三息——十万年，天上的规矩第一次为「人」让了路。'],
            ['tianjun', '（亲手为阵亡天兵合上眼）「名录都记上。名字，一块砖都不少。」'],
          ] },
        { name: '镇梯将军', type: 'battle', boss: true,
          foe: { name: '镇梯将军', icon: '将', el: 'jin' },
          pre: [
            ['n', '梯顶，最后一人横刀而立。镇梯将军——十万年前旧天道亲封的最后一任守梯人，袍泽尽散，他不动。'],
            ['n', '镇梯将军按刀而立：「旧主有令：梯在人在。将军卸梯之日，除非旧主亲至。」'],
            ['xiaofan', '（一步步登上梯顶，把木匣解下来，捧到他面前）将军，旧主来不了了。但他的话，在这儿。'],
            ['n', '灵匣在匣中，长鸣一声——像十万年前，每一次有人登梯时的那声招呼。'],
            ['n', '镇梯将军握刀的手第一次抖了：「……这声音。老夫守了一辈子，就守着它再响一回。」（他缓缓收刀，单膝跪地，老泪纵横）「旧主有灵。梯——交你了。」'],
          ],
          post: [
            ['n', '镇梯将军转身，一步一级，亲手把十万年未曾全开的封梯禁制，一层一层拆了下来。'],
            ['n', '镇梯将军一句一顿：「梯通新桥，桥面是人间。将军守的不是梯——是人还愿意上天这条路。」'],
          ] },
      ],
    },
    {
      title: '卷二四 · 帝君之败', realm: 9, place: '神庭大殿',
      intro: '礼成之前，还有最后一关——不是打过帝君的剑，是接过帝君十万年不敢放的那口气。',
      stages: [
        { name: '殿前整军', type: 'story',
          pre: [
            ['n', '神庭大殿之前，三界联军与天兵合营。旌旗如林，人喊如潮——天上地下，第一次兵合一处。'],
            ['qian', '（在营中支起账房，忙得脚不沾地）联军的粮草对账、天兵的抚恤补发、阵亡名录的三界备份——都排号！都排号！'],
            ['xuanji', '（抚须笑）钱掌柜，你这账房，快成半个神庭了。'],
            ['qian', '（头也不抬）神庭管天，俺管账。天上的事天说了算，账上的事——俺说了算！'],
          ],
          post: [] },
        { name: '剑冢叩门', type: 'battle',
          foe: { name: '殿前剑侍', icon: '侍', el: 'jin' },
          pre: [
            ['n', '大殿深处是帝君的剑冢——十万年卸下的每一分怕，都铸成了剑。剑侍守冢，见人便战。'],
            ['n', '剑侍不问来意，出手就是死手。剑光如瀑，殿砖成粉。'],
            ['baizhi', '（仗剑缠住剑侍，剑势如雪）小凡，去！这儿的剑，交给我——剑客的事，剑客了！'],
            ['xiaofan', '（深深看她一眼，夺路而入）白芷，留一只手——她也是十万年没被人问过一句！'],
          ],
          post: [
            ['n', '剑冢之内，白芷与剑侍从殿内战到殿脊，三百招后，双双收剑——剑侍输了半招，却没有再拔剑。'],
            ['n', '剑侍收剑入鞘，望向殿内，轻声：「……十万年，头一回有人跟我说『留一只手』。进去吧。他等这一天，等得比我还久。」'],
          ] },
        { name: '卸甲', type: 'story',
          pre: [
            ['n', '大殿最深处。帝君负手立于旧天道留下的那面星图墙前，背影站成了一杆插了十万年的旗。'],
            ['tianjun', '「来了。」'],
            ['xiaofan', '（立在丈外）来了。'],
            ['tianjun', '「朝议之前，本座最后一个问题——（转身，眼底是十万年的血与霜）「若开天那日，万灵筑桥、帝君压阵、而你持刀当先——暗流破桥的刹那，你救桥，还是救人？」'],
            ['xiaofan', '（不假思索）救人。'],
            ['tianjun', '「桥塌了，三界危。」'],
            ['xiaofan', '桥塌了，再造。人没了，名字就没了。（直视帝君，一字一句）名字没了——归墟就赢了。'],
            ['n', '大殿里静了很久很久。然后，帝君笑了。十万年，头一回。'],
            ['tianjun', '「……师兄教出来的，果然不一样。（解下佩剑，掷于小凡脚边）「此剑随本座十万年，不曾一败。今日败给一句话——拿去。开天那日，本座压阵。』'],
          ],
          post: [] },
        { name: '朝议定鼎', type: 'battle',
          foe: { name: '余烬死士', icon: '士', el: 'huo' },
          pre: [
            ['n', '朝议当夜，礼官余党狗急跳墙，焚殿谋乱——火起处，死士挟持了名籍库。'],
            ['n', '火光里，小凡与帝君背靠着背，并肩而立。'],
            ['tianjun', '「小辈，左手边的归你，右手边的归本座。」'],
            ['xiaofan', '（提刀，笑）帝君，别抢——左手的也归我。你压阵。'],
            ['n', '帝君大笑，一步踏出，十万年的剑意化作一堵墙，把整座大殿的火光挡在了外面。'],
          ],
          post: [
            ['n', '乱平。朝钟九响。议政殿上，三界与神庭共署《开天盟约》——十万年的封天印，当着满天神人的面，碎成了粉。'],
            ['lingxi', '（在钟声里仰头，眼泪下来了）天亮了。天上，也天亮了。'],
          ] },
        { name: '天珩之诺', type: 'battle', boss: true,
          foe: { name: '天珩帝君', icon: '君', el: 'jin' },
          pre: [
            ['n', '盟约既定，还差最后一战——不是恩怨，是「验刀」。帝君要亲眼确认：持刀人，配得上开天那日。'],
            ['tianjun', '「全力来。本座不收力——收力的胜负，是给归墟看的笑话。」'],
            ['xiaofan', '（横刀，这回眼里有杀气，也有敬意）帝君，得罪。'],
            ['n', '一战天地失色。剑与刀撞出的光，把神庭的夜烧成了白昼。三千回合后——'],
            ['n', '帝君的剑第一次被磕飞。剑落地的脆响里，满殿神人鸦雀无声。'],
            ['tianjun', '（望着虎口崩裂的手，忽然放声大笑，笑声里有泪）「十万年……十万年啊！师兄，你看见了吗——（转身，朝三界联军，长揖及地）「天珩，代旧天道，谢诸位——接住了。」'],
          ],
          post: [
            ['n', '礼成。神庭大殿更名「问天殿」。殿前新立一碑，帝君亲笔：「天规始于问。」'],
            ['xiaofan', '（把帝君的剑郑重挂上碑侧）走。还差最后一站——天幕之眼。'],
          ] },
      ],
    },
    {
      title: '卷二五 · 封天之钥', realm: 9, place: '天幕之眼',
      intro: '十万年的封印，要改造成一扇门。天幕之眼前的最后七日，是三界十万年来最忙碌、也最亮堂的七日。',
      stages: [
        { name: '改锁为门', type: 'story',
          pre: [
            ['n', '天幕之眼。十万年的封天大阵前，神庭匠师与人间工匠挤作一处，吵吵嚷嚷，却热火朝天。'],
            ['lingxi', '（举着测星仪喊）阵眼偏三尺！封天印拆了改门轴，星轨必须重校——谁再瞎敲，扣工钱！'],
            ['qian', '（抱着账本跟在后面）工钱俺发！灵汐姑娘你只管喊！'],
            ['xiaofan', '（挽袖子搬石料，被石坚一肩膀挤开）'],
            ['shijian', '（扛着千斤门轴健步如飞）兄弟你让让！这活儿讲究巧劲——你那劲儿，那是傻劲！'],
            ['n', '笑声里，十万年的封印，一块砖一块砖，变成了门槛。'],
          ],
          post: [] },
        { name: '枢机初试', type: 'battle',
          foe: { name: '阵灵守偶', icon: '偶', el: 'jin' },
          pre: [
            ['n', '封天印改门轴，旧阵不认——阵灵守偶尽出，要「纠正」这十万年第一桩僭越。'],
            ['n', '守偶不伤人，只拆活：拆一块门轴，它就修一段封印。'],
            ['xuanji', '（掐算阵图，大喊）别硬拼！它们听印不听人——把印拿给它们看！'],
            ['xiaofan', '（把灵匣举过头顶）都看好了——「天枢钥在此，开天！」'],
            ['n', '灵匣长鸣。守偶们僵在原地，随后齐齐单膝跪地，让出阵心。'],
          ],
          post: [
            ['n', '阵心让开处，十万年的封天大阵第一次自行倒转——封印之力，尽数转作了门轴的咬合。'],
            ['chen', '（望着倒转的阵光，轻声）「师兄连这一步都算好了。他把归墟挡在外面的每一分力，都留着今天开门用。」'],
          ] },
        { name: '人间来使', type: 'story',
          pre: [
            ['n', '第七日，三界使团抵达天幕之眼——不是来观礼，是来「交砖」。'],
            ['wangshen', '（由石坚扶着，捧着一只小木匣，一步一步走上天阶）小凡，婶子不识字，不会写名。婶子就纳了这么一双鞋垫——（把鞋垫垫进桥基第一格）你的脚，从今往后踩着婶子的针脚。'],
            ['xiaofan', '（跪接鞋垫，喉头哽住，久久说不出一个字）'],
            ['wangshen', '（拍拍他的头，像三年前那样）哭啥。干活。'],
            ['n', '使团络绎不绝：蛮荒的猎旗、坊市的秤、药谷的药锄、剑宗的断剑、琴宗的旧弦……一块一块，砌进了桥基。'],
          ],
          post: [] },
        { name: '暗流试探', type: 'battle',
          foe: { name: '窥隙暗裔', icon: '裔', el: 'shui' },
          pre: [
            ['n', '门轴合拢的巨响传出天外。外天的暗流第一次「排队」涌来——它们闻到了门的味道。'],
            ['n', '暗裔成群扑向桥基，啃食名砖。桥身微微发颤。'],
            ['tianjun', '（一步踏出，素袍猎猎）「列阵。神庭十万年没打过开门仗——今日打个样给归墟看！」'],
            ['n', '天兵与三界联军混编成阵，枪戟如林，灯火如海。暗裔撞进来，一块砖一块砖地被夺回去。'],
          ],
          post: [
            ['n', '暗流退去。桥基上的名砖，一块未丢——三界备份的名册，当夜补录了三遍。'],
            ['lingxi', '（瘫坐在门槛上，笑骂）这帮外天的东西，学乖了，会挑夜里来了。'],
            ['xiaofan', '（望着合拢的门轴，目光却越过天幕，望向更深的暗）它不是学乖了。它是在等——等门开的那一天，一次吃个饱。'],
          ] },
        { name: '枢机圣兽', type: 'battle', boss: true,
          foe: { name: '枢机圣兽', icon: '兽', el: 'tu' },
          pre: [
            ['n', '门成之日，门心最后一道锁亮起——锁里浮出一头圣兽，白身九尾，目如点漆。'],
            ['n', '圣兽：「老夫是旧天道座前枢机，守这把锁十万年。锁可开——须答老夫三问。答错一门，重封十万年。」'],
            ['xiaofan', '（整衣冠，长揖）请赐问。'],
            ['n', '圣兽开口，声如古钟：「第一问：天为何物？」'],
            ['xiaofan', '「是担子。谁肯扛，谁是天。」'],
            ['n', '「第二问：门开之后，外天的饿涌进来，谁当第一个吃的？」'],
            ['xiaofan', '「我。（顿了顿，笑）但吃不完。桥上有的是人。」'],
            ['n', '九尾微动。「第三问：若万灵皆退，只余你一人，你还开不开？」'],
            ['n', '门前列阵的十万大军，齐齐上前一步，甲叶雷动。石坚扛起猎旗，清璇举着药锄，钱多多举着账本，挽月按着琴弦，白芷按着剑——'],
            ['xiaofan', '（回头看了看，再转回来，笑得坦荡）前辈，这问题不成立。你看——我从来没一个人站过。'],
            ['n', '圣兽盯着他看了很久，九尾缓缓垂落，让开了锁心。'],
          ],
          post: [
            ['n', '锁开。十万年的封天印化作漫天光雨，落进三界——每一滴光雨落地，都化作一只小小的、会响的木匣。'],
            ['chen', '（仰头看光雨，喃喃）「师兄，你的匣子，如今满天下都是了。」'],
          ] },
      ],
    },
    {
      title: '卷二六 · 归墟怒潮', realm: 9, place: '天幕裂口',
      intro: '门开了。归墟的怒潮，比所有人预想的都来得快——它等这一口，等了十万年。',
      stages: [
        { name: '潮前一夜', type: 'story',
          pre: [
            ['n', '开门前夜，天幕裂口。十万大军列阵以待，火把连成星河。'],
            ['xiaofan', '（沿着阵线走了一遍，走到哪儿，哪儿就是一阵大笑和吆喝）'],
            ['lingxi', '（跟在他身后，小声）你就不怕？'],
            ['xiaofan', '怕。（回头看了一眼身后的人间灯火，笑）但你看——这么多人都怕，还都站这儿了。这就不是我的怕了，是大家的。大家的怕，就压得下去。'],
            ['n', '天幕之外，暗流停了。那种安静，比涛声更吓人——那是嘴张开之前的安静。'],
          ],
          post: [] },
        { name: '第一潮', type: 'battle',
          foe: { name: '暗裔潮头', icon: '裔', el: 'shui' },
          pre: [
            ['n', '黎明，潮至。第一浪暗裔撞进门来，像整片夜砸进白昼。'],
            ['n', '联军结阵死守。枪戟的丛林里，人人都在喊同一个字——「记！」'],
            ['n', '每斩落一只暗裔，阵中就有人高声报名字：阵亡的、故去的、牵挂的——名字像箭，一只一只钉回去。'],
            ['shijian', '（吼得声嘶力裂）王秀娘！俺娘叫王秀娘！青石镇西头老槐树下住着的——都是俺娘！！'],
          ],
          post: [
            ['n', '第一潮退去。桥基震颤，未损一砖。'],
            ['tianjun', '（按剑立于门心，素袍尽染暗渍）「传令各军：以名为箭，以忆为甲——它要忘，我们偏要记。」'],
          ] },
        { name: '桥心血战', type: 'story',
          pre: [
            ['n', '第三潮直扑桥心。桥面上，护砖的死士一排一排倒下，又一排一排有人补上。'],
            ['baizhi', '（剑已卷刃，仍在桥头）再上来一步，先过我。'],
            ['wantyue', '（十指见血，琴音不歇）《安神引》——都别乱！心一乱，砖就凉！'],
            ['qingxuan', '（拖着药箱在阵里跑，嗓子喊哑了）伤员往里抬！死了的不许盖脸——名字还亮着呢，都看着呢！'],
            ['n', '桥心名砖在血与火里一块一块亮着。暗流一波一波涌上来，又一波一波退下去。'],
          ],
          post: [] },
        { name: '第二夜', type: 'battle',
          foe: { name: '蚀忆巨浪', icon: '浪', el: 'shui' },
          pre: [
            ['n', '第二夜，归墟改了打法——不再冲阵，化作漫天细雨，无声无息渗进每个人的记忆里。'],
            ['n', '阵中开始有人呆立，有人痛哭，有人喊着陌生人的名字——被渗的人，正在忘记自己是谁。'],
            ['xuanji', '（星盘全碎，嘶声）「星官听令！全星台点灯——照名字！一个名字一盏灯，给弟兄们照着回家的路！」'],
            ['xiaofan', '（提刀穿阵，逢人便喊）报名字！你叫什么！家在哪儿！——大声！'],
            ['n', '十万盏星灯次第亮起。雨一样的遗忘里，人间的名字烧成了一片灯火的海。'],
          ],
          post: [
            ['n', '蚀忆巨浪撞进灯海，如雪投炉。潮退时，天幕裂口内外，静得能听见心跳。'],
            ['lingxi', '（数着星灯，声音发抖）三百六十座星台，三百六十万盏……一盏都没灭。'],
          ] },
        { name: '归墟之口', type: 'battle', boss: true,
          foe: { name: '归墟之口', icon: '口', el: 'shui' },
          pre: [
            ['n', '第三日正午，天光最盛时——归墟终于亲至。'],
            ['n', '没有咆哮，没有形态。只是天幕外的「暗」忽然有了纵深：一张没有边界的口，缓缓对着门的方向张开。'],
            ['guixu', '（声音不来自任何方向，像所有人心里最冷的那个念头）「十万年……封印的味道，本座尝够了。开门揖盗——你，是第一个。」'],
            ['xiaofan', '（持刀立于门心，仰面直视那片无边之暗）吃人前，先答我一问。'],
            ['guixu', '「……问。」'],
            ['xiaofan', '你吃了旧天道。他到死都没散——为什么？'],
            ['n', '无边之暗，停了一瞬。'],
            ['guixu', '「……因为他记得太多。本座嚼不动。」'],
            ['xiaofan', '（笑了，刀已出鞘）那就对了。今儿这满桥的人，个个都记得——你嚼得动吗？'],
          ],
          post: [
            ['n', '归墟之口第一次「退」了半分。潮水般的暗，第一次有了迟疑。'],
            ['guixu', '「……有意思。十万年，门里终于出来一个，先问本的。」（暗潮缓缓合拢，声音沉下去）「小东西。你不解饿。但你，值得亲口。」'],
            ['xiaofan', '（收刀，朗声大笑）排队！——先让你尝尝什么叫「记得」！'],
          ] },
      ],
    },
    {
      title: '卷二七 · 万神之墓', realm: 9, place: '神骸星海',
      intro: '正面挡不住归墟，就得搬救兵——三界之外，还有一座埋了万古的墓。墓里的诸位，生前都是天。',
      stages: [
        { name: '墓海航路', type: 'story',
          pre: [
            ['n', '新桥之外，旧天残骸连成星海——万神之墓。灵汐以周天星图为引，寻出了航路。'],
            ['lingxi', '（指尖划过星图）神骸星海，古神埋骨之地。归墟吃过他们一轮——但「被吃过」和「被忘掉」是两回事。只要还有名字……'],
            ['xiaofan', '就能请他们再战一场。（把木匣背紧）走。请神。'],
            ['shijian', '（咽了口唾沫）兄弟，请神这活儿……得带什么供品？'],
            ['xiaofan', '（想了想，认真）带名字。他们最缺这个。'],
          ],
          post: [] },
        { name: '墓前石俑', type: 'battle',
          foe: { name: '墓前石俑', icon: '俑', el: 'tu' },
          pre: [
            ['n', '星海入口，万尊石俑列墓而立——那是古神们的墓卫，十万年不语不动。'],
            ['n', '一行人踏进墓道，石俑齐齐转头。'],
            ['n', '墓卫：「生人止步。神骸之地，不容再辱。」'],
            ['xiaofan', '（站定，不拔刀，朗声）晚辈不是来辱神骨的——是来请神出山的。'],
            ['n', '万尊石俑齐声：「神骨已朽，神名已蚀。请谁？」'],
            ['xiaofan', '（从怀中取出一卷名册——那是三界联军连夜抄录的《万神名录》）「各位的名字，我们抄回来了。」'],
          ],
          post: [
            ['n', '名册展开的一瞬，十万石俑的独目齐齐亮起——像一片倒悬的星空，忽然全部记起了自己。'],
          ] },
        { name: '请神', type: 'story',
          pre: [
            ['n', '墓海最深处，万神之主残念凝成一座由星光搭成的高台。台上坐着的，是一团快要散尽的、温柔的光。'],
            ['n', '墓主（万神残念之首）：「人间的孩子。我们睡了很多年。梦里全是被啃食的声音——直到昨夜，梦里有人喊我们的名字。」'],
            ['xiaofan', '（把名册举过头顶，跪呈）晚辈林小凡，三界一介开匣人。归墟叩门，三界死守。晚辈斗胆——请诸位前辈，再战一场。'],
            ['muzhu', '「……我们战败过。败给归墟，尸骨无存，只剩残念。你请我们，不怕再败？」'],
            ['xiaofan', '（抬头，目光清亮）怕。可前辈，败了有人记着名字，就不算真败。你们被记了十万年——这笔账，晚辈来还。'],
            ['n', '星光高台静了很久。然后，那团光笑了——笑声散开，化作满星海墓碑上亮起的、万点残念。'],
            ['muzhu', '「好孩子。十万年了，头一个不是来求庇护、不是来盗神骨的——是来「还账」的。（残念起身，星光如潮）万神听令——随这孩子，再战一场！」'],
          ],
          post: [] },
        { name: '残念归队', type: 'battle',
          foe: { name: '噬名暗蛟', icon: '蛟', el: 'shui' },
          pre: [
            ['n', '归途，归墟的暗蛟咬住了星海航路的尾巴——它闻到了万神残念的味道，这是它没吃完的旧账。'],
            ['n', '暗蛟掀涛，星海倒卷。万神残念初醒，力弱难聚。'],
            ['n', '危急关头，桥基方向传来隐隐钟声——三界星台全数点灯，为星海里的名字引路。'],
            ['xiaofan', '（横刀断后，大笑）前辈们！三界在给各位点灯——跟紧了，回家的路亮着呢！'],
          ],
          post: [
            ['n', '万神残念随钟声渡过天幕，落进新桥——每一缕残念落定，桥上便多一段发着星光的新砖。'],
            ['muzhu', '「桥上……真暖。比当年当神的时候，暖。」'],
          ] },
        { name: '万神墓主', type: 'battle', boss: true,
          foe: { name: '万神墓主', icon: '神', el: 'tu' },
          pre: [
            ['n', '万神归桥前，最后一道关：墓主的残念须先「验桥」——它要确认，三界配得上这万点神火。'],
            ['muzhu', '「孩子，老朽不是不信你。老朽是替满墓故人，最后问一回：桥上的人间，值得吗？」'],
            ['xiaofan', '（不答，侧身让开——让墓主自己看）'],
            ['n', '星光俯瞰：桥上有咬牙搬石的蛮汉，有连夜赶工的匠人，有给伤兵喂药的少女，有把最后一块鞋垫垫进砖缝的老妪。'],
            ['n', '墓主看了很久很久。星光里的声音，第一次有了温度。'],
            ['muzhu', '「……十万年前，我们把天让给了规矩。十万年后，人间把规矩改成了灯。（残念俯身，郑重一礼）这一战，万神——随人间。」'],
          ],
          post: [
            ['n', '验桥礼成。万点神火落桥，新桥自两头同时生长，贯通天幕内外——只差最后一段，便可直抵归墟之心。'],
            ['tianjun', '（望着即将合龙的桥，轻声）「最后一战了。」'],
            ['xiaofan', '（按刀而立，望着桥尽头的无边之暗）最后一战。师父——咱们回家那顿饭，快吃上了。'],
          ] },
      ],
    },
    {
      title: '卷二八 · 人间一日', realm: 9, place: '青石镇',
      intro: '决战之前，全军回青石镇休整一日。这一日没有战报，没有阵亡——只有灶火、酒、和一整个人间。',
      stages: [
        { name: '班师回镇', type: 'story',
          pre: [
            ['n', '大军开进青石镇。十万甲士轻手轻脚，生怕踩坏了镇口的菜畦。'],
            ['wangshen', '（叉腰立在镇口，身后是流水般的饭桌）都进都进！天兵咋了，天兵也得吃饭！酱料管够——'],
            ['shijian', '（鼻子一酸，虎目含泪）婶子……三年了，还是这个味儿。'],
            ['wangshen', '（一巴掌拍在他背上）嚎啥！三年前你就这样，一碗酱料哭半宿。吃！'],
            ['n', '青石镇这一天，全镇的烟囱没有一根歇火。天兵与蛮汉拼桌，星官与工匠对饮，帝君的素袍上蹭了酱料——没人告诉他。'],
          ],
          post: [] },
        { name: '镇上闲走', type: 'story',
          pre: [
            ['n', '午后，小凡独自在镇里走了一圈。每一处都是旧样子，每一处都多了些新的灯。'],
            ['qingxuan', '（在药圃里掐菜，头也不抬）站那儿干嘛，帮着浇水。'],
            ['xiaofan', '（接过水瓢，浇了半晌，忽然）清璇，打完这仗——'],
            ['qingxuan', '（耳朵红了，掐菜的手更快）打完再说。灶上温着竹笋羹，先吃饭。'],
            ['wantyue', '（在槐树下抚琴，琴音不紧不慢）这曲子还没有名字。'],
            ['xiaofan', '（侧耳听完，笑了）叫《人间一日》吧。打完仗，我回来听你弹全的。'],
            ['wantyue', '（指尖一颤，一个错音。她低下头，轻轻「嗯」了一声）'],
          ],
          post: [] },
        { name: '溪边双匣', type: 'story',
          pre: [
            ['n', '黄昏，溪涧边。陈老在三年前那块青石旁，摆了两只匣子——一旧一新。'],
            ['chen', '（拍拍身旁的石头）坐。'],
            ['xiaofan', '（坐下）师父，两只匣子，一只给谁？'],
            ['chen', '「一只给你。（把旧的推过去）旧天道铸的那只。开天那日，它得在场。」（又把新的往前推了推）「另一只，老夫新削的。给下一个捡到它的人。」'],
            ['xiaofan', '（摩挲着旧匣上的纹路，忽然）师父，您说……十万年前，旧天道把匣子放进溪里的那天，是不是也这样，跟人坐在这儿说过话？'],
            ['chen', '（望着溪水，很久，笑）「他就是在这儿坐着的。他说：天塌下来之前，总得有人先把匣子做好。」'],
            ['n', '溪水东流，两只匣子在暮色里并排响了一声——像两代人的应答。'],
          ],
          post: [] },
        { name: '夜袭烽烟', type: 'battle',
          foe: { name: '灭世蝗先锋', icon: '蝗', el: 'huo' },
          pre: [
            ['n', '夜半，镇外烽火骤起——归墟的先锋不讲武德，循着人间最亮的灯火，直扑青石镇。'],
            ['n', '灭世蝗群蔽月而来，过境之处，田垄、屋瓦、老槐，尽数成了灰。'],
            ['xiaofan', '（提刀上房，目眦欲裂）全阵迎敌——百姓入祠堂！谁也不许伤镇上一人！'],
            ['n', '这一战不在天幕，不在桥头——就在饭桌与菜畦之间。天兵的枪护着祠堂，蛮汉的盾堵着巷口，王婶的灶火，一次都没灭。'],
          ],
          post: [
            ['n', '蝗群尽灭。青石镇的一草一木，烧了又生——名砖的光落在灰烬上，草木以肉眼可见的速度重新抽芽。'],
            ['wangshen', '（望着重新立起的老槐，半天，转身回灶上）……火没灭，就有饭。有饭，就再种。'],
            ['xiaofan', '（立在房顶听完这句话，忽然懂了什么叫「桥面」）（转身，对全军，声震四野）弟兄们！看见没有——这就是咱们要护的东西！明日决战，一步，不许退！'],
          ] },
        { name: '出征', type: 'battle', boss: true,
          foe: { name: '断路妖蟾', icon: '蟾', el: 'shui' },
          pre: [
            ['n', '天明，大军开拔。归墟遣断路妖蟾堵在天幕裂口——决战之前，最后的拦路。'],
            ['n', '妖蟾口吐迷雾，雾里全是幻象：有人看见功成名就，有人看见长生不老，有人看见故人还乡。'],
            ['n', '十万大军，无一人在雾里停步。'],
            ['shijian', '（扛旗走在最前，随手拍碎一只幻象）俺不看你这些。俺娘在家做酱——俺打完仗回家吃。让开！'],
            ['xiaofan', '（大笑，横刀开路）都听着——雾里的都是假的！真的在雾那头：桥上，灯下，家里！'],
          ],
          post: [
            ['n', '妖蟾崩散，迷雾尽开。天幕裂口之内，归墟之心近在眼前。'],
            ['n', '十万大军列阵门前。帝君压阵，万神守桥，灵匣在手——只欠一步，踏入那片无边之暗。'],
            ['xiaofan', '（回身，环视众人，深深一揖）诸位。这一仗打完——都回家。'],
          ] },
      ],
    },
    {
      title: '卷二九 · 执刀问天', realm: 9, place: '归墟之心',
      intro: '归墟不是一座城，一颗星。它是「遗忘」本身——讨伐它的战场，不在天地之间，在每个人不肯松手的那点记忆里。',
      stages: [
        { name: '入暗', type: 'story',
          pre: [
            ['n', '踏进归墟的第一步，所有人都听不见彼此的声音了——暗把声音、光、方向，一口一口咽下去。'],
            ['n', '黑暗里，只剩心口那一点微光：各自最不肯忘的那件事。'],
            ['lingxi', '（望着自己掌心的光，那是一整座星台的灯）……原来把人拴住不撒手的，从来不是法力。'],
            ['xiaofan', '（掌心的光，是一只旧木匣的轮廓）都攥住了？——攥住了就走。它吃得掉光，吃不掉「攥着光的手」。'],
          ],
          post: [] },
        { name: '遗忘之滩', type: 'battle',
          foe: { name: '无名游影', icon: '影', el: 'shui' },
          pre: [
            ['n', '暗里的一片滩涂，游荡着归墟吞下的万物残影——它们没有名字，没有形状，只是「忘掉的东西」在飘。'],
            ['n', '游影无声扑来，缠上谁，谁就开始变淡。'],
            ['qingxuan', '（药箱里的药一瓶瓶失去标签，声音发抖）林小凡，我记着药方——我记着！三十六垄，七味主药——'],
            ['xiaofan', '（一刀斩开缠向她的游影，回头，目光稳）念出来！大声念！药方也好、名字也好——念出声的，它就吃不掉！'],
            ['n', '黑暗里，众人一个接一个开口。声音连成一片，滩涂上的「静」，第一次被撕开了口子。'],
          ],
          post: [
            ['n', '游影退散。滩涂尽头，浮起一块碑——旧天道留下的最后一块：「问它。它经不住问。」'],
            ['chen', '（抚碑，轻声）「师兄。你留的题，他答到最后一关了。」'],
          ] },
        { name: '一粒尘的自述', type: 'story',
          pre: [
            ['n', '再往深处，暗流凝成了画面——归墟的「一生」在众人眼前流过。'],
            ['n', '它曾是天开天辟地时落下的第一粒尘埃：没人记得它是谁、从哪来。它饿，它找，它吃掉一切「将被忘记」的——它以为自己在收藏，其实它在挨饿。'],
            ['guixu', '（暗流四面八方响起）「看见了？本座不是恶。本座是……天都不要的那一粒。」'],
            ['xiaofan', '（静静看完，忽然）所以你吃旧天道。他是「所有人记得」的那个——你吃不下，又不甘心。'],
            ['guixu', '「……」'],
            ['xiaofan', '（一步步走进暗流最深处，声音不大，字字清楚）你不是饿「存在」。你是饿「被记得」。这一味药，人间有的是——可惜你十万年，只顾着张嘴，没学过伸手。'],
          ],
          post: [] },
        { name: '天问一式', type: 'battle',
          foe: { name: '蚀空巨口', icon: '口', el: 'shui' },
          pre: [
            ['n', '归墟怒了。无边之暗化作巨口，当头罩下——这一口，要吞掉整支军队连同他们的记忆。'],
            ['n', '刀身里那一点旧天道的星光，忽然大亮。'],
            ['tiandao', '（星光里，声音清朗如初）「小凡。天问一式，今日传你——不增杀力，只增一问。刀出之时，心中默念：你要问它的那一句。」'],
            ['xiaofan', '（横刀，暗光映在眼里。他问了——）「归墟！你把万古吞了这么多——可有一口，记得你自己的名字？！」'],
            ['n', '一刀出。星光如虹，贯入无边的暗。'],
          ],
          post: [
            ['n', '巨口崩裂。无边之暗，第一次露出了里面层层叠叠的、被吞的残骸——和残骸深处，一粒微微发着光的尘埃。'],
            ['guixu', '（那一粒尘埃的声音，忽然小了，像任何一只迷路的东西）「……本座的名字……本座的……」'],
            ['n', '它想不起来自己。十万年来，头一回。'],
          ] },
        { name: '归墟本相', type: 'battle', boss: true,
          foe: { name: '归墟本相', icon: '虚', el: 'shui' },
          pre: [
            ['n', '垂死的归墟倾尽万古吞噬之力，凝出最后的本相——不再遮掩，不再伪装，只是一片纯粹的、饿的暗。'],
            ['guixu', '「记与忘……本是同根。人间记性再长，也长不过本座的岁月——小东西，你拿什么喂？」'],
            ['xiaofan', '（横刀立于暗前，身后是十万大军的火光、桥上万块名砖的微光、满天星台的灯）拿这个喂。'],
            ['n', '他把灵匣高举过顶——匣开一线，金尘如雨。雨落之处，黑暗里亮起了数不清的名字：张铁匠、刘采药、李夫子、王秀娘、武曲、三万七千亲兵、万古诸神……'],
            ['xiaofan', '（一声长喝）归墟——人间替你报名字了！接好了！！'],
          ],
          post: [
            ['n', '名雨落进暗里，暗一寸一寸亮了。饿，被一声一声的名字喂住了。'],
            ['guixu', '（暗潮退成一线，最后的声音很轻，像一个终于睡着的人）「……原来……被人念着的滋味……是暖的……」'],
            ['n', '无边之暗缓缓合拢，凝成一粒尘埃，轻轻落在少年的掌心——和天开地辟时一样小，一样轻。'],
            ['chen', '（走到少年身边，望着那粒尘埃，轻声）「带回去吧。埋在溪边。让它……也听一回匣响。」'],
          ] },
      ],
    },
    {
      title: '卷三十 · 新天', realm: 9, place: '诸天之上',
      intro: '最后一战不在归墟，在人心：新天立起来之后——谁来当天？答案，十万年前就写在第一只木匣里了。',
      stages: [
        { name: '合龙', type: 'story',
          pre: [
            ['n', '归墟既平，新桥合龙。最后一块砖落定处，众人都看着小凡。'],
            ['shijian', '（捅捅他）兄弟，该你了——第一块是你，最后一块也该你。'],
            ['xiaofan', '（摇头，把砖递给身后的王婶）婶子来。'],
            ['wangshen', '（在十万双眼睛里，稳稳把砖砌进合龙口，拍拍手上的灰）好了。开饭。'],
            ['n', '桥成。贯通天幕内外，人间灯火与外天星光，在桥心汇成了同一条河。'],
          ],
          post: [] },
        { name: '天位之邀', type: 'story',
          pre: [
            ['n', '庆功宴摆在桥心。酒过三巡，帝君起身，当着满天神人与三界万灵，把天位的印玺捧到了小凡面前。'],
            ['tianjun', '「旧天已问，归墟已平。天不可一日无主——林小凡，三界共举，请你继任天道。」'],
            ['n', '满桥寂静。万灵的目光，齐齐落在少年身上。'],
            ['xiaofan', '（盯着印玺看了很久，忽然笑了，把印玺推了回去）帝君，晚辈受不起——不是谦虚，是这个位子，本身就错了。'],
            ['tianjun', '「……讲。」'],
            ['xiaofan', '旧天道为何败？他一个人扛天。神庭为何锈？你们一群人替一个死人守天。天不该是一个人的，也不该是一群人的差事——（起身，指向桥面）该是它这样的：一块砖一个人，谁肯出力，谁就是天。'],
            ['n', '满桥寂静，随即轰然。帝君怔了半晌，忽然大笑，笑出了十万年没落过的泪。'],
            ['tianjun', '「好……好啊。（捧着印玺，郑重放到桥心）那这东西，就镇在这儿——谁出力，谁来用。天道不再是一个人——是一份，谁都能领的差事。」'],
          ],
          post: [] },
        { name: '新天三条', type: 'story',
          pre: [
            ['n', '新天立约。万灵公议，立了三条，刻在桥头的碑上——'],
            ['n', '第一条：天不设主。桥上格子，出力者填之。'],
            ['n', '第二条：天不闭户。天幕之门，永为开匣者开。'],
            ['n', '第三条：天不忘人。凡间每一声呼唤，天上必有一盏灯应。'],
            ['lingxi', '（念完碑文，摸了摸碑角，忽然一笑）第三条好。往后星官的差事，就是点灯——这差事，我领了。'],
            ['shijian', '（挠头）那……俺领啥？'],
            ['xiaofan', '（笑）你领搬砖。天大无边，砖大有用。'],
            ['n', '笑声震得桥灯乱晃。新天的第一夜，满天都是灯。'],
          ],
          post: [] },
        { name: '散场', type: 'battle',
          foe: { name: '余暗拾遗', icon: '影', el: 'shui' },
          pre: [
            ['n', '新天立成的当夜，归墟的最后一缕余暗循着桥灯摸了上来——它已经不是敌了，只是一点没吃饱的、迷路的饿。'],
            ['n', '余暗扑向桥上最小的一块砖——王婶那块鞋垫砖。'],
            ['xiaofan', '（一步跨到砖前，没拔刀，蹲下来，对着那缕暗，像对一个孩子）还没饱？'],
            ['n', '余暗不安地蜷着。'],
            ['xiaofan', '（想了想，从怀里掏出那卷《万神名录》的抄本，撕下一页，轻轻盖在它身上）听好了——这一页上有一万个名字，先念着。念完了，桥上有的是。'],
          ],
          post: [
            ['n', '余暗伏在名页上，一点一点，安静地亮了——它成了桥头第一盏「归墟灯」，专照迷路的暗。'],
            ['tianjun', '（望着那盏灯，久久）「以名为食……它倒是，找着活了。」'],
          ] },
        { name: '归途', type: 'battle', boss: true,
          foe: { name: '终焉试炼', icon: '终', el: 'jin' },
          pre: [
            ['n', '新天既立，万灵散去之前——天忽然齐齐一暗。旧天道留在天地间的最后一道试炼，醒了。'],
            ['n', '星光凝成一尊持刀的人影，眉目与小凡有七分像——那是旧天道按着「未来持刀人」的模样，留下的最后一问。'],
            ['n', '试炼之声如洪钟，又轻如耳语：「持刀人。天问三试，此为最后一试——」'],
            ['n', '「新天已立，万灵已安，你的刀，从今往后，为谁而握？」'],
            ['n', '桥上万灵屏息。少年握着刀，想了很久很久。然后他笑了。'],
            ['xiaofan', '为下一个捡到匣子的人。'],
            ['n', '刀光起处，试炼的身影散作漫天星光，落进桥上每一块名砖——新天，就此落成。'],
          ],
          post: [
            ['n', '多年以后。青石镇的溪涧边，多了一块小碑，碑边常年摆着两只木匣——一旧，一新。'],
            ['n', '旧的那只，偶尔会响。镇上的老人说，那是林大侠路过。年轻人说不对，是有人在很远的天上，开了匣。'],
            ['n', '桥上灯火十万年不熄。每一盏灯下，都有一只匣子，和一只伸向匣子的手。'],
            ['xiaofan', '（最后一次出现在故事里的声音，笑着，年轻）下一个捡到它的人——你好。匣里有灵石，有盼头，有一整个肯搭把手的人间。'],
            ['xiaofan', '「开吧。这条路很长——但值得。」'],
            ['n', '——红尘录·终——'],
          ] },
      ],
    },
  ];

  STORY_VOLUMES.push(...STORY_VOLUMES_SEQUEL);

  const STORY_TOTAL = STORY_VOLUMES.reduce((n, v) => n + v.stages.length, 0);


/* 故事模式「红尘录」—— 草稿 Part 3：引擎（合入 game.js 用）           */
/* 依赖：state/$/fmt/esc/floatText/pushLog/chime/addStones/expMult/     */
/*       playerCombatStats/elementBonus/simulateBattle/REALMS/panelSigs */
/* ================================================================== */

  const storyStageInfo = (gi) => {
    let v = 0;
    let rest = gi;
    while (v < STORY_VOLUMES.length - 1 && rest >= STORY_VOLUMES[v].stages.length) {
      rest -= STORY_VOLUMES[v].stages.length;
      v++;
    }
    return { v, li: rest, vol: STORY_VOLUMES[v], st: STORY_VOLUMES[v].stages[rest] };
  };

  // 关卡门槛：随卷数（境界）指数抬升，卷内逐关 +28%。
  // 后传卷（十一起，境界已满仙人）用缓曲线 1.75^n 续接：按满养成极限校准，30 卷全通可达；
  // 不乘仙位倍率（immortalMult）——轮回抬秘境难度收益，故事门槛保持静态，避免越飞越远
  const storyReq = (vi, li) => {
    const base = vi < 10
      ? 25 * Math.pow(3.4, vi)
      : 25 * Math.pow(3.4, 9) * Math.pow(1.75, vi - 9);
    return Math.round(base * (1 + li * 0.28));
  };

  function storyStateOf(gi) {
    if (state.story.cleared.indexOf(gi) >= 0) return 'cleared';
    const info = storyStageInfo(gi);
    if (gateRealm() < info.vol.realm) return 'locked';
    if (info.li > 0) {
      // 卷内顺序解锁：先过上一关
      if (state.story.cleared.indexOf(gi - 1) < 0) return 'locked';
    } else if (info.v > 0) {
      // 跨卷：上一卷全部通关才开本卷第一章
      const prevLen = STORY_VOLUMES[info.v - 1].stages.length;
      for (let k = gi - prevLen; k < gi; k++) {
        if (state.story.cleared.indexOf(k) < 0) return 'locked';
      }
    }
    return 'open';
  }

  function storyEnemyOf(st, req) {
    const boss = !!st.boss;
    return {
      name: st.foe.name,
      base: st.foe.name,
      icon: st.foe.icon,
      kicker: '拦路之敌',
      boss,
      el: st.foe.el,
      hp: Math.max(1, Math.round(req * (boss ? 13 : 8.2))),
      atk: Math.max(1, Math.round(req * (boss ? 1.05 : 0.82))),
      def: Math.max(0, Math.round(req * 0.2)),
    };
  }

  let storyFlow = null;

  function openStoryStage(gi, review) {
    const stState = storyStateOf(gi);
    if (stState === 'locked') {
      floatText('尚未解锁', '#f87171');
      return;
    }
    const info = storyStageInfo(gi);
    storyFlow = {
      gi, v: info.v, li: info.li, vol: info.vol, st: info.st,
      review: !!review && stState === 'cleared',
      rewarded: stState === 'cleared',
      phase: 'pre', idx: 0, partner: '', reward: null,
    };
    $('offlineModal').classList.remove('show');
    $('storyTitle').textContent = info.vol.title;
    $('storyKicker').textContent =
      (review || stState === 'cleared' ? '回顾 · ' : '') +
      '第 ' + (info.li + 1) + ' 关 · ' + info.st.name +
      '（' + info.vol.place + '）';
    $('storyModal').classList.add('show');
    storyShowLine();
  }

  function storyMeet(sp) {
    if (!sp || sp === 'n' || !STORY_CAST[sp]) return;
    if (state.story.met.indexOf(sp) >= 0) return;
    state.story.met.push(sp);
    if (!storyFlow || !storyFlow.review) {
      pushLog('人物志 · 初次结识「' + withPlayerName(STORY_CAST[sp].name) + '」', 'special');
      chime([659, 880]);
    }
  }

  function storySetSlot(el, sp, active) {
    if (!sp) {
      el.innerHTML = '';
      delete el.dataset.sp; // 清空必须连标记一起清：否则同一角色下个对话再登场会被旧标记跳过填充，留下空立绘
      return;
    }
    const memo = STORY_CAST[sp] || { name: '?', color: '#999' };
    // 自愈兜底：标记匹配但内容不在场（任何路径清空/清丢了内容）也强制重填，
    // 保证「说话人登场 ⇒ 槽内必有立绘」这一不变式，杜绝空立绘复发
    if (el.dataset.sp !== sp || !el.querySelector('.story-art')) {
      el.dataset.sp = sp;
      el.innerHTML = storyPortrait(sp, 'dlg');
      armStoryArtGuard(el);
    }
    el.classList.toggle('active', !!active);
  }

  function storyShowLine() {
    const f = storyFlow;
    if (!f) return;
    let speaker = '', text = '', sys = false;

    if (f.phase === 'result') {
      sys = true;
      text = f.resultLine;
    } else {
      const lines = f.phase === 'pre' ? f.st.pre : (f.st.post || []);
      const line = lines[f.idx] || ['', ''];
      speaker = line[0];
      text = line[1];
    }

    if (sys) {
      storySetSlot($('storySlotL'), f.partner || null, false);
      storySetSlot($('storySlotR'), 'xiaofan', false);
      $('storyName').textContent = '——';
      applyStoryNameColor('#d8b36a');
      $('storyText').textContent = withPlayerName(text);
      $('storyText').classList.add('sys');
    } else {
      storyMeet(speaker);
      if (speaker && speaker !== 'n') {
        if (speaker === 'xiaofan') {
          storySetSlot($('storySlotR'), 'xiaofan', true);
          storySetSlot($('storySlotL'), f.partner || null, false);
        } else {
          f.partner = speaker;
          storySetSlot($('storySlotL'), speaker, true);
          storySetSlot($('storySlotR'), 'xiaofan', false);
        }
        $('storyName').textContent = withPlayerName(STORY_CAST[speaker].name);
        applyStoryNameColor(STORY_CAST[speaker].color);
      } else {
        storySetSlot($('storySlotL'), f.partner || null, false);
        storySetSlot($('storySlotR'), 'xiaofan', false);
        $('storyName').textContent = '旁白';
        applyStoryNameColor('#8b93a7');
      }
      $('storyText').textContent = withPlayerName(text);
      $('storyText').classList.remove('sys');
    }
    storySyncButtons();
    beep(520, 0.04);
  }

  function storySyncButtons() {
    const f = storyFlow;
    if (!f) return;
    const next = $('storyNext');
    const giveup = $('storyGiveup');
    const skip = $('storySkip');
    giveup.classList.add('hidden');
    next.disabled = false;
    if (f.phase === 'pre' || f.phase === 'post') {
      const lines = f.phase === 'pre' ? f.st.pre : (f.st.post || []);
      const last = f.idx >= lines.length - 1;
      if (f.phase === 'pre' && last && f.st.type === 'battle') {
        next.textContent = '⚔ 迎战';
      } else if (f.phase === 'post' && last) {
        next.textContent = f.reward ? '收下奖励 ▸' : '合上书页 ▸';
      } else {
        next.textContent = '继续 ▸';
      }
      skip.classList.remove('hidden');
    } else if (f.phase === 'result') {
      if (!f.fought) {
        next.textContent = '⚔ 迎战';
        giveup.classList.remove('hidden');
      } else if (f.won) {
        next.textContent = f.st.post && f.st.post.length ? '继续 ▸' : '收下奖励 ▸';
      } else {
        next.textContent = '再战 ⚔';
        giveup.classList.remove('hidden');
      }
      skip.classList.add('hidden');
    }
  }

  function storyAdvance() {
    const f = storyFlow;
    if (!f) return;
    if (f.phase === 'result') { storyAction(); return; }
    const lines = f.phase === 'pre' ? f.st.pre : (f.st.post || []);
    if (f.idx < lines.length - 1) {
      f.idx++;
      storyShowLine();
      return;
    }
    // 段落播完
    if (f.phase === 'pre') {
      if (f.st.type === 'battle') {
        f.phase = 'result';
        f.resultLine = '「' + f.st.foe.name + '」拦在面前——';
        f.won = false;
        storyShowLine();
      } else {
        storyGrantRewards();
        if (f.st.post && f.st.post.length) {
          f.phase = 'post';
          f.idx = 0;
          storyShowLine();
        } else {
          storyFinish();
        }
      }
    } else {
      storyFinish();
    }
  }

  function storyAction() {
    const f = storyFlow;
    if (!f) return;
    if (f.phase === 'pre' || f.phase === 'post') {
      // 按钮在段落中间等同推进；段尾则按语义处理
      const lines = f.phase === 'pre' ? f.st.pre : (f.st.post || []);
      const last = f.idx >= lines.length - 1;
      if (!last) { storyAdvance(); return; }
      if (f.phase === 'pre' && f.st.type === 'battle') { storyAdvance(); return; }
      if (f.phase === 'post' && last) { storyFinish(); return; }
      storyAdvance();
      return;
    }
    if (f.phase === 'result') {
      if (f.won) {
        if (f.st.post && f.st.post.length) {
          f.phase = 'post';
          f.idx = 0;
          storyShowLine();
        } else {
          storyFinish();
        }
      } else {
        storyFight();
      }
    }
  }

  function storyFight() {
    const f = storyFlow;
    if (!f) return;
    const req = storyReq(f.v, f.li);
    const enemy = storyEnemyOf(f.st, req);
    enemy.kicker = f.vol.title + ' · ' + f.st.name;
    const player = playerCombatStats();
    const elb = elementBonus(enemy.el);
    player.atk *= elb.mult;
    const result = simulateBattle(player, enemy);
    showBattlePopup(enemy, result, {
      title: '红尘录 · ' + f.vol.title,
      playerHp: player.hp,
      // 回顾模式不再发奖（storyGrantRewards 有 rewarded 守卫），弹层文案如实标注
      closeText: f.review ? '离开' : '收下奖励', loseText: '返回故事',
      rewardText: result.win && !f.review ? '战后结算灵石 · 碎屑 · 修为' : undefined,
    });
    // 战功口径（2026-11-01）：锋芒/金身只记秘境征战，与「百战」同口径——
    // 红尘录战斗（尤其回顾模式可无限重刷）不再灌入成就进度
    state.bestiary[enemy.base] = (state.bestiary[enemy.base] || 0) + 1;

    if (result.win) {
      f.won = true;
      f.fought = true;
      storyGrantRewards();
      const adv = enemy.boss ? '，一战功成！' : '，斩于马下！';
      f.phase = 'result';
      f.resultLine = '『' + result.rounds + ' 合之内，' + f.st.foe.name + '授首' + adv + '』';
      if (enemy.boss) chime([523, 659, 784, 1046]);
      beep(result.rounds <= 3 ? 1046 : 820, 0.14);
    } else {
      f.won = false;
      f.fought = true;
      f.phase = 'result';
      f.resultLine = '『不敌……' + f.st.foe.name + '当前，先行退走，来日再战。』';
      beep(220, 0.12);
    }
    combatDirty = true;
    storyShowLine();
    save();
  }

  function storyGrantRewards() {
    const f = storyFlow;
    if (!f || f.rewarded) return;
    f.rewarded = true;
    const req = storyReq(f.v, f.li);
    const bossMul = f.st.boss ? 2 : 1;
    const stones = Math.round(req * 6 * bossMul);
    const dust = (f.st.boss ? 40 : 12) + f.v * 15;
    const exp = Math.floor(req * 0.9 * (f.st.boss ? 1.6 : 1) * expMult());
    addStones(stones);
    addDust(dust);
    state.exp += exp;
    if (state.story.cleared.indexOf(f.gi) < 0) state.story.cleared.push(f.gi);

    let volDone = false;
    const base = f.gi - f.li;
    if (f.vol.stages.every((s, i) => state.story.cleared.indexOf(base + i) >= 0)) {
      volDone = true;
      const vStones = Math.round(req * 10);
      const vDust = 60 + f.v * 30;
      addStones(vStones);
      addDust(vDust);
      pushLog('红尘录 · ' + f.vol.title + ' 全卷通关！+' + fmt(vStones) + ' 灵石 +' + vDust + ' 碎屑', 'special');
      // 新卷开启预告：下一卷已解锁（跨卷规则=上一卷全通），弹窗告知新内容
      const next = STORY_VOLUMES[f.v + 1];
      if (next) {
        const realmGap = state.realm < next.realm;
        guideEnqueue({
          kicker: '📖 新卷开启 · 红尘录 ' + (f.v + 2) + ' / ' + STORY_VOLUMES.length + ' 卷',
          title: next.title,
          body:
            '<p>' + esc(withPlayerName(next.intro)) + '</p>' +
            '<p class="guide-tip">故事 · ' + esc(next.place) + ' · 共 ' + next.stages.length +
            ' 关' + (realmGap ? ' · 需境界「' + REALMS[next.realm] + '」' : ' · 现在即可入卷') + '</p>',
        });
      }
    }
    f.reward = { stones, dust, exp, volDone };
    pushLog('红尘录 · 「' + f.st.name + '」通关 · +' + fmt(stones) + ' 灵石 +' + dust + ' 碎屑 +' + fmt(exp) + ' 修为', 'special');
    save();
  }

  function storyFinish() {
    const f = storyFlow;
    if (!f) return;
    const r = f.reward;
    const box = $('storyText');
    $('storyName').textContent = '本关小结';
    applyStoryNameColor('#d8b36a');
    storySetSlot($('storySlotL'), f.partner || null, false);
    storySetSlot($('storySlotR'), 'xiaofan', true);
    if (f.review || !r) {
      box.textContent = '旧卷重读，江湖如昨。（回顾模式不重复发奖）';
    } else {
      box.textContent = '通关「' + f.st.name + '」：灵石 +' + fmt(r.stones) +
        '，碎屑 +' + r.dust + '，修为 +' + fmt(r.exp) +
        (r.volDone ? '。' + f.vol.title + ' · 全卷功成，另有大赏！' : '。');
    }
    box.classList.add('sys');
    $('storyNext').textContent = '合上书页 ▸';
    $('storySkip').classList.add('hidden');
    $('storyGiveup').classList.add('hidden');
    f.phase = 'done';
    renderStory();
    save();
  }

  function storySkipAll() {
    const f = storyFlow;
    if (!f) return;
    // 跳过也把被跳过台词的说话人记入人物志（storyMeet 幂等）：跳过 ≠ 漏收集，
    // 否则对应卡片停在「？？？/随剧情结识」且玩家无从知晓（2026-11-01 修）
    const meetAll = (lines) => { (lines || []).forEach((line) => storyMeet(line[0])); };
    if (f.phase === 'pre') {
      meetAll(f.st.pre);
      if (f.st.type === 'battle') {
        f.idx = f.st.pre.length - 1;
        storyAdvance();
      } else {
        storyGrantRewards();
        if (f.st.post && f.st.post.length) {
          meetAll(f.st.post); // post 段整体跳过，说话人一并入志
          f.phase = 'post';
          f.idx = f.st.post.length - 1;
          storyFinish();
        } else {
          storyFinish();
        }
      }
    } else if (f.phase === 'post') {
      storyFinish();
    } else if (f.phase === 'result' && f.won) {
      storyAction();
    }
  }

  function storyClose() {
    storyFlow = null;
    $('storyModal').classList.remove('show');
    renderStory();
    save();
  }

  /* ---------------- 故事面板渲染 ---------------- */

  // 章节折叠（2026-10-31 用户指定）：手风琴式单卷展开——自动展开到「最新章节」
  //（最深一卷已激活的），激活新章节时自动改展开新卷并合上上一卷；点卷头可临时
  // 展开/折叠任意卷，最新章节再次变化时重新自动跟随
  let storyOpenVol = null;   // 当前展开卷（null = 全部折叠）
  let storyFollowVol = null; // 上次自动跟随的「最新章节」卷号

  function storyDefaultVol() {
    let gi = 0;
    for (let vi = 0; vi < STORY_VOLUMES.length; vi++) {
      const len = STORY_VOLUMES[vi].stages.length;
      for (let li = 0; li < len; li++) {
        if (state.story.cleared.indexOf(gi + li) < 0) return vi;
      }
      gi += len;
    }
    return STORY_VOLUMES.length - 1;
  }

  // 「最新章节」：最深一卷已激活（境界达标且上一卷全部通关）；全通后停在末卷
  function storyLatestVol() {
    let gi = 0, latest = 0, prevDone = true;
    for (let vi = 0; vi < STORY_VOLUMES.length; vi++) {
      const vol = STORY_VOLUMES[vi];
      const len = vol.stages.length;
      if (gateRealm() >= vol.realm && (vi === 0 || prevDone)) latest = vi;
      const done = vol.stages.filter((st, i) => state.story.cleared.indexOf(gi + i) >= 0).length;
      prevDone = done === len;
      gi += len;
    }
    return latest;
  }

  // 故事小章节方块图标：剧情=书卷、战斗=交叉剑（currentColor 随 ss-icon 金色）
  var SS_ICONS = {
    story: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/></svg>',
    battle: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><g fill="currentColor"><g id="ssSword"><path d="M3 3l3.2.4L14 11.2l-2.8 2.8L3.4 6.2 3 3z"/><path d="M9.6 13.6l4-4 1.9 1.9-4 4-1.9-1.9z"/><path d="M13.8 15.8l1.5-1.5 4.9 4.9-1.5 1.5-4.9-4.9z"/></g><use href="#ssSword" transform="translate(24 0) scale(-1 1)"/></g></svg>'
  };

  function renderStory() {
    const latestVol = storyLatestVol();
    if (storyFollowVol !== latestVol) {
      // 激活新章节（或首次进入）：自动展开新卷，其余章节折叠
      storyFollowVol = latestVol;
      storyOpenVol = latestVol;
    }
    const sig = state.realm + '|' + state.story.cleared.join(',') + '|' + state.story.met.join(',') + '|' + storyOpenVol;
    if (panelSigs.story === sig) return;
    panelSigs.story = sig;

    let gi = 0;
    const volHtml = STORY_VOLUMES.map((vol, vi) => {
      const realmOk = gateRealm() >= vol.realm;
      const done = vol.stages.filter((s, i) => state.story.cleared.indexOf(gi + i) >= 0).length;
      const open = storyOpenVol === vi;
      let body = '';
      if (open) {
        let rows = '';
        vol.stages.forEach((st, li) => {
          const idx = gi + li;
          const stState = storyStateOf(idx);
          const req = storyReq(vi, li);
          const cls = stState === 'cleared' ? 'done' : stState === 'open' ? 'open' : 'locked';
          const typeTag = st.type === 'battle' ? (st.boss ? '首领' : '战斗') : '剧情';
          let stateText = '';
          if (stState === 'cleared') stateText = '<span class="ss-state ok">已通关</span><button class="mini" data-story="' + idx + '" data-review="1">回顾</button>';
          else if (stState === 'open') stateText = '<span class="ss-state">建议战力 ' + fmt(req) + '</span><button class="mini primary" data-story="' + idx + '">推进</button>';
          else {
            let reason;
            if (state.realm < vol.realm) reason = '需境界 ' + REALMS[vol.realm];
            else if (li === 0 && vi > 0) reason = '通关上一卷全部关卡';
            else reason = '先通过上一关';
            stateText = '<span class="ss-state">🔒 ' + reason + ' · 建议战力 ' + fmt(req) + '</span>';
          }
          rows += '<div class="story-stage-row ' + cls + '">' +
            '<span class="ss-icon">' + (st.type === 'battle' ? SS_ICONS.battle : SS_ICONS.story) + '</span>' +
            '<div class="ss-info"><b>' + (li + 1) + '. ' + esc(st.name) + '</b>' +
            '<span class="ss-note">' + typeTag + (st.foe ? ' · 敌 ' + esc(withPlayerName(st.foe.name)) : '') + '</span></div>' +
            stateText + '</div>';
        });
        body = '<p class="story-vol-intro">' + esc(withPlayerName(vol.intro)) + '</p>' +
          '<div class="story-stage-list">' + rows + '</div>';
      }
      gi += vol.stages.length;
      return '<div class="story-vol ' + (realmOk ? (done === vol.stages.length ? 'vol-done' : 'vol-active') : 'vol-locked') + '">' +
        '<button class="story-vol-head" data-vol="' + vi + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
        '<span class="story-vol-chev">' + (open ? '▾' : '▸') + '</span>' +
        '<span class="story-vol-name">' + esc(vol.title) + '</span>' +
        '<span class="story-vol-place">' + esc(vol.place) + '</span>' +
        '<span class="count">' + done + ' / ' + vol.stages.length + '</span></button>' +
        body + '</div>';
    }).join('');

    $('storyBox').innerHTML = volHtml;
    $('storyProg').textContent = state.story.cleared.length + ' / ' + STORY_TOTAL + ' 关';

    const castHtml = STORY_CAST_ORDER.map((id) => {
      const met = state.story.met.indexOf(id) >= 0;
      const c = STORY_CAST[id];
      return '<div class="cast-card ' + (met ? 'met' : 'unknown') + '" title="' + esc(met ? withPlayerName(c.brief) : '尚未结识') + '">' +
        '<div class="cast-art">' + (met ? storyPortrait(id, 'cast') : '<span>?</span>') + '</div>' +
        '<b>' + (met ? esc(withPlayerName(c.name)) : '？？？') + '</b>' +
        '<span class="cast-brief">' + (met ? esc(withPlayerName(c.brief)) : '随剧情结识') + '</span></div>';
    }).join('');
    $('castGrid').innerHTML = castHtml;
    $('castCount').textContent = state.story.met.length + ' / ' + STORY_CAST_ORDER.length;
  }

  function bindStory() {
    $('storyBox').addEventListener('click', (e) => {
      const head = e.target.closest('.story-vol-head');
      if (head) {
        const vi = Number(head.dataset.vol);
        storyOpenVol = storyOpenVol === vi ? null : vi;
        renderStory();
        return;
      }
      const btn = e.target.closest('button[data-story]');
      if (!btn) return;
      openStoryStage(Number(btn.dataset.story), btn.dataset.review === '1');
    });
    $('storyNext').addEventListener('click', () => {
      const f = storyFlow;
      if (f && f.phase === 'done') { storyClose(); return; }
      storyAction();
    });
    $('storySkip').addEventListener('click', storySkipAll);
    $('storyGiveup').addEventListener('click', storyClose);
    $('storyDialog').addEventListener('click', () => {
      const f = storyFlow;
      if (f && (f.phase === 'pre' || f.phase === 'post')) storyAdvance();
    });
    $('storyStage').addEventListener('click', () => {
      const f = storyFlow;
      if (f && (f.phase === 'pre' || f.phase === 'post')) storyAdvance();
    });
    $('storyCloseBtn').addEventListener('click', storyClose);
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
    const replay = mode !== 'wild' && mode !== 'endless' && cleared >= cfg.max;
    const unit = mode === 'tower' || mode === 'endless' ? '层' : mode === 'stage' ? '关' : '区';
    const req = recommendedPower(mode, level);
    const diff = difficultyFor(player.power, req);

    document.querySelectorAll('.combat-tab').forEach((tab) => {
      const m = tab.dataset.mode;
      tab.classList.toggle('active', m === mode);
      tab.classList.toggle('locked', !unlockedMode(m));
      tab.setAttribute('aria-selected', m === mode ? 'true' : 'false');
    });

    // 敌方头像 SVG 只随敌人身份重建：同一关卡反复巡猎时免去每战重灌 innerHTML
    const enemySig = enemy.name + (enemy.boss ? 'B' : '');
    if (panelSigs.combatEnemy !== enemySig) {
      panelSigs.combatEnemy = enemySig;
      $('enemyIcon').innerHTML = monsterAvatarHtml(enemy.name, enemy.icon);
    }
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
    const elb = elementBonus(enemy.el);
    $('combatEl').textContent = elb.fav > elb.adv
      ? '顺 ×' + elb.fav
      : elb.adv > elb.fav ? '逆 ×' + elb.adv : '持平';
    $('enemyEl').textContent = ELEMENTS.find((e) => e.key === enemy.el).name;
    $('enemyEl').className = 'enemy-el el-' + enemy.el;
    $('difficultyBadge').textContent = diff.text;
    $('difficultyBadge').className = 'diff ' + diff.cls;

    const zoneStrip = $('zoneStrip');
    zoneStrip.classList.toggle('hidden', mode !== 'wild');
    if (mode === 'wild') {
      const maxZone = wildMaxUnlocked();
      const cur = currentLevel('wild');
      // 分区按钮是静态结构：解锁数/所在关/展开组不变就不重建（自动巡猎每战都进来）
      const zsig = maxZone + '|' + cur + '|' + wildGroupOpen;
      if (panelSigs.combatZone !== zsig) {
        panelSigs.combatZone = zsig;
        // 每 20 关一组：标签行 + 当前展开组的关卡行；默认展开当前所在关卡组
        const openIdx = Math.min(WILD_GROUP_COUNT - 1, wildGroupOpen >= 0
        ? wildGroupOpen
        : Math.floor((cur - 1) / WILD_GROUP_SIZE));
      let html = '<div class="zone-groups">';
      for (let gi = 0; gi < WILD_GROUP_COUNT; gi++) {
        const gs = gi * WILD_GROUP_SIZE + 1;
        const ge = Math.min(WILD_MAX, gs + WILD_GROUP_SIZE - 1);
        const anyOpen = gs <= maxZone;
        html += '<button class="zone-group' + (anyOpen ? ' has-open' : ' locked') +
          (gi === openIdx ? ' open' : '') + (cur >= gs && cur <= ge ? ' cur' : '') +
          '" data-group="' + gi + '"' + (gi === openIdx ? ' aria-pressed="true"' : '') +
          '>' + gs + '-' + ge + '</button>';
      }
      html += '</div><div class="zone-list">';
      const gs = openIdx * WILD_GROUP_SIZE + 1;
      const ge = Math.min(WILD_MAX, gs + WILD_GROUP_SIZE - 1);
      for (let z = gs; z <= ge; z++) {
        const zone = WILD_ZONES[z - 1];
        const locked = z > maxZone;
        html += '<button class="zone-chip' + (z === cur ? ' active' : '') + (locked ? ' locked' : '') +
          '" data-zone="' + z + '"' + (locked ? ' disabled' : '') + '>' +
          z + ' · ' + zone.name + '</button>';
      }
      zoneStrip.innerHTML = html + '</div>';
      }
    }

    // 扫荡条（2026-10-31）：闯关/爬塔选已通关卡片（野外沿用 zoneStrip 选中区即扫荡目标）
    const sweepStrip = $('sweepStrip');
    const sweepCleared = mode === 'tower' ? state.towerCleared : state.stageCleared;
    // 通关 0 关时没有任何可扫荡目标，不渲染选关条（否则 pick=0 会算出负数关卡组）
    const sweepable = unlocked && sweepCleared >= 1 && (mode === 'stage' || mode === 'tower');
    sweepStrip.classList.toggle('hidden', !sweepable);
    if (sweepable) {
      const cleared = sweepCleared;
      const pick = sweepPick[mode] > 0 ? Math.min(sweepPick[mode], cleared) : cleared;
      const unit = mode === 'tower' ? '层' : '关';
      // 展示口径与野外对齐（2026-10-31 用户指定）：分组标签恒为真实区间（不随已通关
      // 收窄，此前会出现「21-11」这类乱码标签），未通关组灰置；展开组内逐关列出，
      // 未通关的灰置禁点
      const modeMax = MODES[mode].max;
      const groupCount = Math.min(WILD_GROUP_COUNT, Math.ceil(modeMax / WILD_GROUP_SIZE));
      const openIdx = Math.max(0, Math.min(groupCount - 1,
        sweepGroupOpen >= 0 ? sweepGroupOpen : Math.floor((pick - 1) / WILD_GROUP_SIZE)));
      const ssig = mode + '|' + cleared + '|' + pick + '|' + openIdx;
      if (panelSigs.combatSweep !== ssig) {
        panelSigs.combatSweep = ssig;
        let html = '<div class="zone-groups">';
        for (let gi = 0; gi < groupCount; gi++) {
          const gs = gi * WILD_GROUP_SIZE + 1;
          const ge = Math.min(modeMax, gs + WILD_GROUP_SIZE - 1);
          const anyOpen = gs <= cleared;
          html += '<button class="zone-group' + (anyOpen ? ' has-open' : ' locked') +
            (gi === openIdx ? ' open' : '') + (pick >= gs && pick <= ge ? ' cur' : '') +
            '" data-group="' + gi + '"' + (gi === openIdx ? ' aria-pressed="true"' : '') +
            '>' + gs + '-' + ge + '</button>';
        }
        html += '</div><div class="zone-list">';
        const gs = openIdx * WILD_GROUP_SIZE + 1;
        const ge = Math.min(modeMax, gs + WILD_GROUP_SIZE - 1);
        for (let z = gs; z <= ge; z++) {
          const locked = z > cleared;
          html += '<button class="zone-chip' + (z === pick ? ' active' : '') + (locked ? ' locked' : '') +
            '" data-sweep="' + z + '"' + (locked ? ' disabled' : '') + '>' + z + ' ' + unit + '</button>';
        }
        sweepStrip.innerHTML = html + '</div>';
      }
    }

    // 扫荡按钮：免费额度内显示剩余次数，用完显示加购单价与已购次数
    const sweepBtn = $('sweepBtn');
    const sweepOn = unlocked && (mode === 'stage' || mode === 'tower' || mode === 'wild');
    sweepBtn.classList.toggle('hidden', !sweepOn);
    if (sweepOn) {
      ensureDaily();
      const used = state.daily.sweep[mode] || 0;
      const bought = state.daily.sweepBought[mode] || 0;
      const freeLeft = Math.max(0, SWEEP_DAILY_FREE - used);
      sweepBtn.textContent = freeLeft > 0
        ? '扫荡 · 剩 ' + freeLeft + '/' + SWEEP_DAILY_FREE
        : '扫荡 ' + fmt(SWEEP_BUY_COST) + '灵石/次（购 ' + bought + '/' + SWEEP_BUY_MAX + '）';
      sweepBtn.disabled = freeLeft <= 0 && bought >= SWEEP_BUY_MAX;
      sweepBtn.title = mode === 'wild'
        ? '扫荡当前选中区域（需已通关）'
        : '扫荡选中的已通关' + (mode === 'tower' ? '层' : '关');
    }

    const autoBtn = $('autoBtn');
    autoBtn.textContent = needAscension()
      ? '飞升一次后开启'
      : (mode === 'wild' ? '自动巡猎：' : '连续挑战：') + (state.autoHunt ? '开' : '关');
    autoBtn.disabled = !unlocked || needAscension();

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
        : mode === 'endless'
          ? '通关爬塔 60 层后解锁（当前 ' + state.towerCleared + ' 层）'
          : '通关闯关第 3 关后解锁（当前 ' + state.stageCleared + ' 关）';
    } else if (mode === 'wild') {
      const kills = state.wildKills[level] || 0;
      const nextWild = Object.keys(MILESTONES.wild).map(Number)
        .sort((a, b) => a - b)
        .find((z) => !state.wildCleared.includes(z));
      ensureDaily(); // 跨日后未触发任何战斗时，保证额度显示即时重置（惰性重置的显示层兜底）
      const wildLeft = Math.max(0, WILD_REPEAT_DAILY - (state.daily.wildRepeat || 0));
      progress = '已解锁 ' + wildMaxUnlocked() + ' / ' + WILD_MAX + ' 区域 · 本区击杀 ' +
        fmt(kills) + ' · 每 ' + WILD_SET_PITY + ' 杀必掉荒狩套装' +
        (nextWild ? ' · 首通 ' + nextWild + ' 区必掉部件' : '') +
        ' · 已胜怪挑战剩 ' + wildLeft + '/' + WILD_REPEAT_DAILY + '（扫荡不计）';
    } else if (mode === 'endless') {
      const aff = ENCHANTS[(level - 1) % ENCHANTS.length];
      progress = '无尽最高 ' + state.endlessBest + ' 层 · 本层词缀「' + aff.name + '」' + aff.desc +
        ' · ' + (Math.round(MODE_SET_RATE * 1000) / 10) + '% 概率掉镇塔套装';
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
        : mode === 'endless'
          ? '无尽秘境是终局玩法：通关爬塔 60 层后开启。'
          : '野外是中期玩法：先通关闯关第 3 关，再来狩猎。';
    } else if (mode === 'tower') {
      $('combatHint').textContent = '每 10 层一主；每 10 层首通都掉镇塔套装部件，一路铺到 ' + TOWER_MAX + ' 层。';
    } else if (mode === 'stage') {
      $('combatHint').textContent = '每 5 关首领；每 5 关首通都掉征伐套装部件，一路铺到 ' + STAGE_MAX + ' 关。';
    } else if (mode === 'endless') {
      $('combatHint').textContent = '无尽没有终点：每层词缀轮换、难度无限攀升，塔印产出最高。';
    } else {
      $('combatHint').textContent = '区域越深，怪物属性越高；自动巡猎不弹窗，战后可点「回看战报」。';
    }

    // 战功/修炼列表是低频结构：每战都重建会让按钮悬停态闪烁，改签名门控
    const tsig = ['tower', 'stage', 'wild'].map((key) => state[TROPHIES[key].field] || 0).join('|');
    if (panelSigs.combatTrophy !== tsig) {
      panelSigs.combatTrophy = tsig;
      $('trophyList').innerHTML = ['tower', 'stage', 'wild'].map((key) => {
        const t = TROPHIES[key];
        return '<li><span>' + t.name + '</span><b>' + fmt(state[t.field] || 0) + resIcon(t.field) + '</b></li>';
      }).join('');
    }

    const trsig = Object.keys(TRAININGS).map((key) => {
      const t = TRAININGS[key];
      const lv = state[t.lvField] || 0;
      return lv + ':' + (lv < MAX_TRAIN && (state[t.currency] || 0) >= trainCost(lv) ? 1 : 0);
    }).join('|');
    if (panelSigs.combatTrain !== trsig) {
      panelSigs.combatTrain = trsig;
      $('trainingList').innerHTML = Object.keys(TRAININGS).map((key) => {
        const t = TRAININGS[key];
        const lv = state[t.lvField] || 0;
        const cost = trainCost(lv);
        const maxed = lv >= MAX_TRAIN;
        const can = !maxed && (state[t.currency] || 0) >= cost;
        const trophy = TROPHIES[key === 'atk' ? 'tower' : key === 'hp' ? 'stage' : 'wild'];
        return (
          '<div class="training-row">' +
            '<span class="training-name">' + t.name + '<em>Lv.' + lv + '</em></span>' +
            '<button class="mini" data-train="' + key + '"' + (can ? '' : ' disabled') + '>' +
              (maxed ? '已满' : '升级 ' + cost + resIcon(trophy.field)) + '</button>' +
            '<p class="training-desc">' + t.desc + '</p>' +
          '</div>'
        );
      }).join('');
    }

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
    btn.innerHTML = '升级 ' + fmt(cost) + resIcon('stones');
    btn.disabled = state.stones < cost;
  }

  function renderEquip() {
    equipDirty = false;
    $('equipGrid').innerHTML = SLOTS.map((slotDef) => {
      const item = state.equipped[slotDef.key];
      const enhLv = state.enh[slotDef.key] || 0;
      if (!item) {
        return (
          '<div class="equip-slot empty" data-slot="' + slotDef.key + '">' +
            '<div class="slot-head"><span class="slot-icon">' + slotIcon(slotDef.key) + '</span>' +
            '<span class="slot-name">' + slotDef.name + '</span>' +
            (enhLv ? '<span class="slot-lv">+' + enhLv + '</span>' : '') + '</div>' +
            '<p class="slot-empty">未装备' + (enhLv ? ' · 部位强化 +' + enhLv + ' 保留' : '') + '</p>' +
          '</div>'
        );
      }

      const maxed = enhLv >= MAX_ENHANCE;
      const setCls = item.setKey ? ' item-special ' + SETS[item.setKey].cls : '';
      const elDef = ELEMENTS.find((e) => e.key === item.el);
      const meta = (elDef ? '<b class="' + item.el + '">' + elDef.name + '</b> · ' : '') +
        (item.setKey ? '秘境 · ' + SETS[item.setKey].name + '套装' : RARITIES[item.r].name);
      const affixText = (item.affixes || [])
        .map((a) => SHORT_NAME[a.k] + ' +' + fmtPct(a.v))
        .join(' · ');
      const gems = slotGemList(slotDef.key);
      const gemText = gems.filter(Boolean).length
        ? '宝石：' + gems.map((g) => (g ? GEM_TIERS[g.t - 1].name + SHORT_NAME[g.k] + '石' : '空孔')).join(' · ')
        : '';
      return (
        '<div class="equip-slot item-r' + item.r + setCls + '" data-slot="' + slotDef.key + '">' +
          '<div class="slot-head"><span class="slot-icon">' + slotIcon(slotDef.key) + '</span>' +
            '<span class="slot-name">' + slotDef.name + '</span>' +
            '<span class="slot-lv">+' + enhLv + '</span></div>' +
          '<p class="slot-item-name">' + esc(item.name) + '</p>' +
          '<p class="slot-power">战力 <b>' + fmt(itemPower(item)) + '</b> · ' + meta + '</p>' +
          (affixText ? '<p class="slot-affix">' + affixText + '</p>' : '') +
          (gemText ? '<p class="slot-gems">' + gemText + '</p>' : '') +
          '<div class="slot-actions">' +
            '<button class="mini" data-act="enhance" data-slot="' + slotDef.key + '"' +
              ' data-cost="' + enhanceCost(enhLv) + '"' + (maxed ? ' data-max="1"' : '') + '>' +
              (maxed ? '已满级' : '强化 ' + fmt(enhanceCost(enhLv)) + resIcon('stones')) + '</button>' +
            '<button class="mini ghost" data-act="forge" data-slot="' + slotDef.key + '">工坊</button>' +
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
          '<span class="set-count">' + count + ' / ' + Object.keys(set.pieces).length + '</span></div>' +
          '<p class="set-desc">' + desc + tail + '</p>' +
        '</div>'
      );
    }).join('');
  }

  const SLOT_ORDER = {};
  SLOTS.forEach((s, i) => { SLOT_ORDER[s.key] = i; });

  const BAG_SORTS = {
    power: (a, b) => itemScore(b) - itemScore(a),
    rarity: (a, b) => (b.r - a.r) || (itemScore(b) - itemScore(a)),
    slot: (a, b) => (SLOT_ORDER[a.slot] - SLOT_ORDER[b.slot]) || (itemScore(b) - itemScore(a)),
  };

  function paintBag(force) {
    if (!bagDirty) return;
    const now = performance.now();
    if (!force && now - lastBagPaint < 800) return;
    lastBagPaint = now;
    bagDirty = false;

    const base = bagFilter === 'all' ? state.bag : state.bag.filter((it) => it.slot === bagFilter);
    const sorted = base.slice().sort(BAG_SORTS[bagSort] || BAG_SORTS.power);
    const list = $('bagList');
    const keepScroll = list.scrollTop;
    $('bagCount').textContent = state.bag.length + ' / ' + bagCap();
    $('bagCount').classList.toggle('full', state.bag.length >= bagCap());
    const expandBtn = $('bagExpandBtn');
    const canExpand = state.bagTokens > 0 && state.bagExtra < BAG_EXTRA_MAX;
    expandBtn.classList.toggle('hidden', !canExpand);
    if (canExpand) {
      expandBtn.textContent = '使用扩容符 +20（剩 ' + state.bagTokens + '）';
    }

    if (!sorted.length) {
      list.innerHTML = '<li class="bag-empty">背包空空如也，开箱会掉落装备。</li>';
      return;
    }

    list.innerHTML = sorted.map((item) => {
      const setCls = item.setKey ? ' item-special ' + SETS[item.setKey].cls : '';
      const meta = item.setKey
        ? '秘境 · ' + SETS[item.setKey].name + '套装'
        : RARITIES[item.r].name;
      const extra = (item.affixes || []).map((a) => SHORT_NAME[a.k] + (a.v * 100).toFixed(1) + '%');
      const elName = ELEMENTS.find((e) => e.key === item.el);
      const elHtml = elName ? '<b class="' + item.el + '">' + elName.name + '</b> · ' : '';
      const cur = state.equipped[item.slot];
      const cmp = cur ? itemPower(item) - itemPower(cur) : null;
      const cmpHtml = cmp === null ? '' :
        '<b class="bi-cmp ' + (cmp > 0 ? 'up' : cmp < 0 ? 'down' : 'eq') +
        '" title="与已穿戴同部位装备对比">' + (cmp > 0 ? '▲' : cmp < 0 ? '▼' : '＝') + '</b>';
      // 封存按钮按陈列室已封存状态判断（2026-10-31 用户指定）：空位或比展品强才可封存；
      // 陈列室未解锁（境界未到合体）一律禁用
      const stand = state.museum[item.slot];
      const canSeal = featureOpen('museum') && (!stand || itemScore(item) > itemScore(stand));
      return (
        '<li class="bag-item item-r' + item.r + setCls + '" data-id="' + item.id + '">' +
          '<div class="bi-main">' +
            '<div class="bi-headline">' +
              '<span class="bi-name">' + esc(item.name) + '</span>' +
              '<span class="bi-power">' + cmpHtml + fmt(itemPower(item)) + '</span>' +
            '</div>' +
            '<span class="bi-meta">' + elHtml + meta + ' · ' + SLOT_MAP[item.slot].name + '</span>' +
            (extra.length ? '<span class="bi-affix">' + extra.join(' · ') + '</span>' : '') +
          '</div>' +
          '<div class="bi-actions">' +
            '<button class="mini" data-act="wear" data-id="' + item.id + '">穿戴</button>' +
            '<button class="mini ghost" data-act="salvage" data-id="' + item.id + '">分解</button>' +
            '<button class="mini ghost" data-act="seal" data-id="' + item.id + '"' + (canSeal ? '' : ' disabled') + '>封存</button>' +
          '</div>' +
        '</li>'
      );
    }).join('');

    list.scrollTop = keepScroll;
  }

  // render 合帧节流（2026-10-30）：63 处调用全量跑 35 个子面板，连点时同帧多次调用
  // 互相挤兑、主线程被同步重绘占满造成「点了没反应」；同帧合并为一次，rAF 下一帧统一重绘
  let renderQueued = false;
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderNow();
    });
  }

  function renderNow() {
    $('realmName').textContent = REALMS[state.realm];
    $('stones').textContent = fmt(state.stones);
    $('opens').textContent = fmt(state.opens);
    $('intervalText').textContent = interval().toFixed(2);

    // 连开十次门槛：未飞升置灰并提示（值不变不重复写 DOM）
    const o10 = $('open10');
    const bulkLocked = needAscension();
    if (o10.disabled !== bulkLocked) {
      o10.disabled = bulkLocked;
      o10.textContent = bulkLocked ? '飞升一次后开启' : '连开十次';
    }

    const e = expected();
    const perSec = e.stone * (1 + critChance() * (CRIT_MULT - 1)) * buffMult() / interval();
    $('perSec').textContent = fmtRate(perSec);
    const power = totalPower();
    // 总战力统一实战口径 realPower（2026-10-31）：与顶栏徽章 / 战力榜上报一致；
    // 装备战力（纯装备分，收益加成的计算基数）降为面板次要信息展示
    const realP = fmt(realPower());
    $('powerTotal').textContent = realP;
    $('powerPanel').textContent = realP;
    const gearEl = $('powerGear');
    if (gearEl) gearEl.textContent = '装备战力 ' + fmt(power);
    $('powerBonus').textContent = '收益 ×' + powerMult().toFixed(2);

    renderUpgrade('speed', 'speedLv', 'speedDesc', 'buySpeed',
      () => '每 ' + interval().toFixed(2) + ' 秒自动开一次');
    renderUpgrade('gain', 'gainLv', 'gainDesc', 'buyGain',
      (lv) => '灵石收益 +' + lv * 30 + '%');
    renderUpgrade('luck', 'luckLv', 'luckDesc', 'buyLuck',
      (lv) => '高品质权重 +' + lv * 10 + '% / 阶');

    const maxRealm = state.realm >= REALMS.length - 1;
    $('realmNow').textContent = REALMS[state.realm];
    renderRealmList();
    renderStatus();

    if (maxRealm) {
      $('expFill').style.width = '100%';
      $('expText').textContent = '修为圆满';
      $('breakBtn').textContent = '已至仙人';
      $('breakBtn').disabled = true;
    } else {
      const cost = realmCostOf(state.realm + 1);
      const enough = state.exp >= cost;
      $('expFill').style.width = (Math.min(1, state.exp / cost) * 100).toFixed(1) + '%';
      $('expText').innerHTML = enough
        ? '修为充足 · 可突破至 ' + REALMS[state.realm + 1]
        : fmt(state.exp) + ' / ' + fmt(cost) + resIcon('exp');
      $('breakBtn').textContent = '突破至 ' + REALMS[state.realm + 1];
      $('breakBtn').disabled = !enough;
    }
    // 境界 hero 卡（卡牌风）附加字段
    $('heroTag').textContent = (state.immortal > 0 ? '仙位 ' + state.immortal + ' · ' : '') + '修士';
    $('heroAscPill').textContent = '✦ 仙缘 ×' + (state.ascensions | 0);
    $('heroOpens').textContent = fmt(state.opens);
    $('heroAsc').textContent = String(state.ascensions | 0);
    const emblemBox = $('heroEmblem');
    if (emblemBox && renderNow.emblemRealm !== (state.realm | 0)) {
      renderNow.emblemRealm = state.realm | 0;
      emblemBox.innerHTML = REALM_EMBLEMS[Math.min(state.realm | 0, REALM_EMBLEMS.length - 1)];
    }

    $('ascendBtn').classList.toggle('hidden', !maxRealm);
    if (maxRealm) $('ascendBtn').disabled = state.stones < 1e8;

    let hint = '';
    if (state.ascensions > 0) {
      hint = '仙缘 ×' + state.ascensions + ' · 永久收益 +' + state.ascensions * 5 +
        '% · 境界门槛 ×' + fmt(Math.pow(2.5, state.ascensions));
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
    renderSetCollect();
    renderPets();
    renderCave();
    renderGongfa();
    renderElixir();
    renderTrials();
    renderMarket();
    renderDaily();
    renderDailyExt();
    renderWeekly();
    renderAchv();
    renderResonance();
    renderSteward();
    renderCraft();
    renderMelt();
    renderMirror();
    renderMap();
    renderOrdeal();
    renderMuseum();
    renderFarm();
    renderChapter();
    renderShichen();
    renderDemon();
    renderBounty();
    renderDao();
    renderBattleStats();
    renderBestiary();
    renderStory();
    renderGuide();
    renderWander();
    renderWanderBanner();
    renderFishing();
    renderGather();
    renderTreasureBox();
    applyLocks();
  }

  // 修行指南：玩法解锁链一览（内容随境界 / 关卡进度变化，签名没变就不重绘）
  function renderGuide() {
    const sig = state.realm + '|' + state.stageCleared + '|' +
      state.towerCleared + '|' + state.featureSeen.length;
    if (panelSigs.guide === sig) return;
    panelSigs.guide = sig;
    const next = PLAY_MODES.find((f) => !(f.check ? f.check() : true));
    $('guideLead').textContent = next
      ? '下一目标：「' + next.name + '」——' + next.cond + '解锁。'
      : '诸法皆通，飞升在望。';
    $('guideList').innerHTML = PLAY_MODES.map((f) => {
      const open = f.check ? f.check() : true;
      const cls = open ? 'open' : (f === next ? 'locked next' : 'locked');
      return '<div class="guide-row ' + cls + '">' +
        '<span class="g-status">' + (open ? '✓' : '🔒') + '</span>' +
        '<div class="g-main">' +
          '<p class="g-name">' + f.name + '<span class="g-where">' + f.where + '</span></p>' +
          '<p class="g-desc">' + f.desc + '</p>' +
        '</div>' +
        '<span class="g-cond">' + (open ? '已解锁' : f.cond) + '</span>' +
        '</div>';
    }).join('');
    $('guideMeta').textContent =
      '始终相伴：日常签到 · 成就称号 · 套装图鉴 · 工坊洗练宝石 · 奇遇心魔 · 天道录 · 挑战修行';
  }

  // 境界清单：点击面板标题展开，十境一览并高亮当前所处境界
  function renderRealmList() {
    const el = $('realmList');
    if (!el || el.classList.contains('hidden')) return;
    const sig = String(state.realm);
    if (panelSigs.realmList === sig) return;
    panelSigs.realmList = sig;
    el.innerHTML = REALMS.map((name, i) => {
      const st = i < state.realm ? 'done' : i === state.realm ? 'cur' : 'lock';
      const note = st === 'done' ? '✓ 已突破'
        : st === 'cur' ? '◆ 当前境界'
        : '需 ' + fmt(realmCostOf(i)) + ' 修为';
      return '<div class="realm-row ' + st + '">' +
        '<span class="r-idx">' + (i + 1) + '</span>' +
        '<span class="r-name">' + name + '</span>' +
        '<span class="r-note">' + note + '</span>' +
        '</div>';
    }).join('');
  }

  // 角色状态总览：人物 / 资源 / 进度 / 装备四组，内容不变不重绘；仙盟名复用天下页缓存，未加载时异步拉一次
  let statusGuildAsked = false;
  let statusGuildRetryAt = 0; // 失败退避：renderStatus 随渲染循环 ~10Hz 调用，接口持续
  // 失败时不退避会变成每秒约 10 次的无限重试风暴（每个请求还各挂 15s AbortController）
  let achvEls = new Map();   // 成就 id → { prog, btn, row }，壳重建时重建，补丁循环免查全文档
  function renderStatus() {
    const el = $('statusGrid');
    if (!el) return;
    if (!WORLD.guild && !statusGuildAsked && Date.now() >= statusGuildRetryAt) {
      statusGuildAsked = true;
      statusGuildRetryAt = Date.now() + 60 * 1000;
      worldFetch('/api/guild').then((out) => {
        WORLD.guild = out;
        panelSigs.status = '';
        renderStatus();
      }).catch(() => {
        statusGuildAsked = false; // 失败允许重试（勿永久卡「查询中」），但至少隔 60s
      });
    }
    const g = WORLD.guild && WORLD.guild.guild;
    const eq = state.equipped || {};
    const vol = STORY_VOLUMES[storyDefaultVol()];
    const volName = (vol.title.split(' · ')[1] || vol.title);
    const asc = Math.max(0, state.ascensions | 0);
    // 结构签名只含低频字段：exp/realPower/stones/dust/opens 等挂机时每跳都变，
    // 进签名会把整个面板打到渲染上限全量重建（~30 行 innerHTML，最高 10Hz）；
    // 这些高频数值改走下方 data-st 文本补丁，DOM 结构不动
    const eqKey = SLOTS.map((s) => {
      const it = eq[s.key];
      return (it ? it.name + ',' + (it.r || 0) : '-') + ',' + (state.enh[s.key] || 0);
    }).join(';');
    const sig = [cloudUser || '', asc, state.realm, state.immortal, state.title,
      g ? g.name + '|' + g.level : (WORLD.guild ? 'none' : 'loading'),
      state.story.cleared.length, state.towerCleared, state.stageCleared, state.wildCleared.length,
      state.endlessBest, (state.rogue && state.rogue.best) || 0, eqKey].join('|');
    if (panelSigs.status !== sig) {
      panelSigs.status = sig;
      const eqRow = SLOTS.map((s) => {
        const it = eq[s.key];
        const rn = it ? ((RARITIES[it.r] || RARITIES[0]).name) : '';
        return '<div><dt>' + slotIcon(s.key) + s.name + '</dt><dd>' + (it
          ? esc(it.name) + '<br><span class="muted">' + rn +
            ' +' + (state.enh[s.key] || 0) + (it.star ? ' · ★' + it.star : '') + '</span>'
          : '<span class="muted">空缺</span>') + '</dd></div>';
      }).join('');
      const name = (cloudUser || '—') + (asc > 0 ? '+' + asc : '');
      // 每组（标题+数据）独立成格：网格自动排布时标题紧贴自己的数据，不留跨列空白
      const group = (t, rows) => '<div class="status-group"><p class="side-title">' + t + '</p><dl class="stats">' + rows + '</dl></div>';
      // 带 key 的行走 <dd data-st="...">，供高频补丁定位
      const row = (k, v, key) => '<div><dt>' + k + '</dt><dd' + (key ? ' data-st="' + key + '"' : '') + '>' + v + '</dd></div>';
      el.innerHTML =
        group('人物', [
          row('名称', esc(name)),
          row('境界', REALMS[state.realm] + (state.immortal > 0 ? ' · 仙位 ' + state.immortal : '')),
          row('飞升', asc + ' 次'),
          row('修为', '', 'exp'),
          row('战力', '', 'power'),
          row('称号', state.title ? '「' + esc(state.title) + '」' : '<span class="muted">无</span>'),
          row('仙盟', g ? esc(g.name) + ' · Lv.' + g.level : '<span class="muted">' + (WORLD.guild ? '未加入' : '查询中') + '</span>'),
        ].join('')) +
        group('资源', [
          row(resIcon('stones') + ' 灵石', '', 'stones'),
          row(resIcon('dust') + ' 碎屑', '', 'dust'),
          row(resIcon('souls') + ' 器魂', '', 'souls'),
          row(resIcon('petTickets') + ' 招募券', '', 'petTickets'),
          row(resIcon('rerollCoupon') + ' 洗练券', '', 'rerollCoupon'),
          row(resIcon('talismans') + ' 护体符', '', 'talismans'),
        ].join('')) +
        group('进度', [
          row('故事', esc(volName) + ' · ' + state.story.cleared.length + '/' + STORY_TOTAL + ' 章'),
          row('爬塔', state.towerCleared + ' / ' + TOWER_MAX + ' 层'),
          row('闯关', state.stageCleared + ' / ' + STAGE_MAX + ' 关'),
          row('野外', state.wildCleared.length + ' / ' + WILD_MAX + ' 片'),
          row('无尽', state.endlessBest + ' 层'),
          row('探幽', ((state.rogue && state.rogue.best) || 0) + ' 层'),
          row('累计开箱', '', 'opens'),
          row('累计灵石', '', 'totalStones'),
        ].join('')) +
        group('装备', eqRow);
    }
    // 高频数值补丁：每次渲染只做十来次 textContent，重建零开销
    const patch = (key, v) => {
      const n = el.querySelector('[data-st="' + key + '"]');
      if (n) n.textContent = v;
    };
    patch('exp', fmt(state.exp));
    patch('power', fmt(realPower()));
    patch('stones', fmt(state.stones));
    patch('dust', fmt(state.dust));
    patch('souls', fmt(state.souls));
    patch('petTickets', fmt(state.petTickets));
    patch('rerollCoupon', fmt(state.rerollCoupon));
    patch('talismans', fmt(state.talismans));
    patch('opens', fmt(state.opens) + ' 次');
    patch('totalStones', fmt(state.totalStones));
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
    const sig = state.counts.join(',') + '|' + state.best;
    if (panelSigs.collection === sig) return;
    panelSigs.collection = sig;
    $('collectionList').innerHTML = RARITIES.map((r, i) =>
      '<li class="r' + i + '"><span class="dot"></span><span class="cname">' + r.name +
      '</span><span class="ccount">' + fmt(state.counts[i]) + '</span></li>'
    ).join('');

    $('bestText').textContent = state.best >= 0
      ? '最高收集：' + RARITIES[state.best].name
      : '最高收集：—';
  }

  /* ---------------- 新面板渲染（签名缓存，内容没变不重绘） ---------------- */

  function renderSetCollect() {
    const sig = JSON.stringify(state.setCollection);
    if (panelSigs.setCollect === sig) return;
    panelSigs.setCollect = sig;
    $('setCollect').innerHTML = Object.keys(SETS).map((key) => {
      const set = SETS[key];
      const n = collectCount(key);
      const bonus = [];
      if (n >= 2) bonus.push('收益 +10%');
      if (n >= 4) bonus.push('攻血 +8%');
      if (n >= 6) bonus.push('收益 +25%');
      return (
        '<div class="set-row ' + set.cls + (n ? ' on' : '') + '">' +
          '<div class="set-head"><span class="set-name">' + set.name + '图鉴</span>' +
          '<span class="set-count">' + Math.min(n, 6) + ' / 6</span></div>' +
          '<p class="set-desc">' + (bonus.length ? '收集加成：' + bonus.join(' · ') : '集齐 2 / 4 / 6 件激活') + '</p>' +
        '</div>'
      );
    }).join('');
  }

  function renderPets() {
    const afford = PETS.map((p) => (state.pets[p.id] !== undefined
      ? (state.pets[p.id] >= PET_MAX_LV ? 2 : state.stones >= petFeedCost(state.pets[p.id]) ? 1 : 0)
      : state.petTickets >= p.cost ? 1 : 0)).join(',');
    const coreAfford = PETS.map((p) => ((state.petCores[p.id] | 0) >= CORE_MAX ? 2 :
      state.beastBones >= coreCost(state.petCores[p.id] | 0) ? 1 : 0)).join(',');
    const sig = state.petTickets + '|' + JSON.stringify(state.pets) + '|' +
      state.activePets.join('+') + '|' + state.petSlots + '|' +
      JSON.stringify(state.petTokens) + '|' + afford + '|' + coreAfford + '|' +
      JSON.stringify(state.petCores);
    if (panelSigs.pets === sig) return;
    panelSigs.pets = sig;
    $('ticketCount').textContent = '券 ' + fmt(state.petTickets);
    const slotsBtn = $('petSlotsBtn');
    if (state.petSlots >= 2) {
      slotsBtn.classList.add('hidden');
    } else {
      slotsBtn.classList.remove('hidden');
      slotsBtn.textContent = '解锁双宠位（' + PET_SLOT_COST + ' 券）';
      slotsBtn.disabled = state.petTickets < PET_SLOT_COST;
    }
    $('petList').innerHTML = PETS.map((p) => {
      const lv = state.pets[p.id];
      if (lv === undefined) {
        return (
          '<div class="pet-row locked">' +
            '<span class="pet-icon" aria-hidden="true">' + (PET_ICONS[p.id] || p.icon) + '</span>' +
            '<div class="pet-main"><span class="pet-name">？？？</span>' +
            '<p class="pet-desc">' + p.desc + '加成 · 招募需 ' + p.cost + resIcon('petTickets') + '</p></div>' +
            '<button class="mini" data-pet="recruit" data-id="' + p.id + '"' +
              (state.petTickets >= p.cost ? '' : ' disabled') + '>招募</button>' +
          '</div>'
        );
      }
      const active = state.activePets.includes(p.id);
      const maxed = lv >= PET_MAX_LV;
      const cost = petFeedCost(lv);
      const tokenLv = state.petTokens[p.id] || 0;
      const coreLv = state.petCores[p.id] | 0;
      const coreMaxed = coreLv >= CORE_MAX;
      const traits = (CORE_TRAITS[p.id] || []).filter((t) => coreLv >= t.lv).map((t) => t.name).join('·');
      // 战斗向加成消费端过 GROWTH_SCALE（×0.25，见 playerCombatStats 的 petBonus 折算），
      // 灵石收益（gain）不折算——展示口径与实际效果对齐（2026-11-01 修）
      const shownScale = p.stat === 'gain' ? 1 : GROWTH_SCALE;
      const bonusText = (p.per * shownScale * lv * 100).toFixed(1).replace(/\.0$/, '') + '%' +
        (tokenLv ? ' · 信物 +' + (tokenLv * 0.5 * shownScale).toFixed(1).replace(/\.0$/, '') + '%' : '') +
        (coreLv ? ' · 内丹 ' + coreLv + ' 级' + (traits ? '（' + traits + '）' : '') : '');
      return (
        '<div class="pet-row' + (active ? ' active' : '') + '">' +
          '<span class="pet-icon" aria-hidden="true">' + (PET_ICONS[p.id] || p.icon) + '</span>' +
          '<div class="pet-main"><span class="pet-name">' + p.name + (active ? ' <em>出战中</em>' : '') + '</span>' +
          '<p class="pet-desc">' + p.desc + ' +' + bonusText + ' · 亲密度 ' + lv + ' / ' + PET_MAX_LV +
            ' · 信物 ' + tokenLv + ' / ' + TOKEN_MAX + ' · 内丹 ' + coreLv + ' / ' + CORE_MAX + '</p></div>' +
          '<div class="pet-actions">' +
            '<button class="mini" data-pet="feed" data-id="' + p.id + '"' +
              (maxed || state.stones < cost ? ' disabled' : '') + '>' +
              (maxed ? '已满级' : '喂养 ' + fmt(cost)) + '</button>' +
            '<button class="mini" data-pet="token" data-id="' + p.id + '"' +
              (tokenLv >= TOKEN_MAX || state.dust < TOKEN_COST(tokenLv) ? ' disabled' : '') + '>' +
              (tokenLv >= TOKEN_MAX ? '信物满' : '信物 ' + TOKEN_COST(tokenLv) + ' ' + resIcon('dust')) + '</button>' +
            '<button class="mini" data-pet="core" data-id="' + p.id + '"' +
              (coreMaxed || state.beastBones < coreCost(coreLv) ? ' disabled' : '') + '>' +
              (coreMaxed ? '内丹满' : '内丹 ' + coreCost(coreLv) + ' 骨') + '</button>' +
            '<button class="mini ghost" data-pet="toggle" data-id="' + p.id + '">' + (active ? '休息' : '出战') + '</button>' +
            '<button class="mini ghost" data-pet="release" data-id="' + p.id + '">放生</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  function renderCave() {
    const afford = Object.keys(CAVE).map((k) =>
      state.cave[k] >= CAVE[k].max ? 2 : state.stones >= caveCost(k) ? 1 : 0).join(',');
    const sig = JSON.stringify(state.cave) + '|' + afford;
    if (panelSigs.cave === sig) return;
    panelSigs.cave = sig;
    $('caveList').innerHTML = Object.keys(CAVE).map((key) => {
      const def = CAVE[key];
      const lv = state.cave[key];
      const maxed = lv >= def.max;
      const cost = caveCost(key);
      const curText = lv
        ? (key === 'garden' ? '+' + (lv * 0.4).toFixed(1) + '%' : '+' + lv * (key === 'array' ? 8 : 10) + '%')
        : '';
      return (
        '<div class="cave-row">' +
          '<span class="cave-icon" aria-hidden="true">' + (CAVE_ICONS[key] || def.icon) + '</span>' +
          '<div class="cave-main"><span class="cave-name">' + def.name + ' <em>Lv.' + lv + '</em></span>' +
          '<p class="cave-desc">' + def.desc + (curText ? '（当前 ' + curText + '）' : '') + '</p></div>' +
          '<button class="mini" data-cave="' + key + '"' + (maxed || state.stones < cost ? ' disabled' : '') + '>' +
            (maxed ? '已满级' : '升级 ' + fmt(cost) + resIcon('stones')) + '</button>' +
        '</div>'
      );
    }).join('');
  }

  function renderDaily() {
    ensureDaily();
    const signed = state.lastSignIn === todayStr();
    const wb = weekBuff();
    const claimedSet = state.daily.claimed.join(',');
    // 壳签名：仅结构相关（日期/签到/领取集合/气运）——不含每跳变的进度值，
    // 自动开箱高频渲染时只走下方动态补丁，按钮 DOM 稳定不重建（防悬停闪烁与点击落空）
    const sig = signed + '|' + state.signInDays + '|' + claimedSet + '|' + wb.id +
      (isWeekend() ? '|we' : '') + '|' + (state.lastSignMode || '');
    if (panelSigs.dailyShell !== sig) {
      panelSigs.dailyShell = sig;
      const nextReward = SIGN_REWARDS[state.signInDays % SIGN_REWARDS.length];
      $('weekBuffLine').textContent = '本周气运：' + wb.name + '（' + wb.desc + '）' +
        (isWeekend() ? ' · 周末秘境灵石 ×2 进行中' : '');
      $('signInBox').innerHTML =
        '<div class="signin-row">' +
          '<span>累计签到 <b>' + state.signInDays + '</b> 天 · 本日可领 ' + nextReward.text + '</span>' +
          (signed
            ? '<span class="mini signin-done">今日已签（' + (state.lastSignMode === 'gamble' ? '赌狗' : '普通') + '）</span>'
            : '<span class="signin-actions">' +
              '<button class="mini" id="signInBtn">普通签到</button>' +
              '<button class="mini" id="signGambleBtn">赌狗签到</button>' +
              '</span>') +
        '</div>' +
        (signed ? '' :
          '<p class="hint signin-odds">赌狗 · 49% ×2~5 倍 · 10% ×1 · 20% 空手 · ' +
          '21% 倒扣 1~3 倍（灵石可负债）</p>');
      $('signStatsLine').textContent = signStatsText();
      $('signLogList').innerHTML = signLogHtml();
      $('dailyList').innerHTML = DAILY_TASKS.map((t) => {
        const rewardText = (t.reward.stones ? fmt(t.reward.stones) + ' 灵石' : '') +
          (t.reward.dust ? (t.reward.stones ? ' · ' : '') + t.reward.dust + ' 碎屑' : '');
        return (
          '<div class="daily-row" data-drow="' + t.id + '">' +
            '<div class="pet-main"><span class="pet-name">' + t.name + '</span>' +
            '<p class="pet-desc"><span data-dprog="' + t.id + '"></span> · 奖励 ' + rewardText + '</p></div>' +
            '<button class="mini" data-daily="' + t.id + '" data-dbtn="' + t.id + '"></button>' +
          '</div>'
        );
      }).join('');
    }
    // 动态补丁：进度文本 + 按钮状态
    for (const t of DAILY_TASKS) {
      const cur = Math.min(state.daily[t.id] || 0, t.target);
      const done = cur >= t.target;
      const claimed = state.daily.claimed.includes(t.id);
      const prog = document.querySelector('[data-dprog="' + t.id + '"]');
      if (prog) prog.textContent = cur + ' / ' + t.target;
      const btn = document.querySelector('[data-dbtn="' + t.id + '"]');
      if (btn) {
        btn.textContent = claimed ? '已领取' : done ? '领取' : '未完成';
        btn.disabled = !(done && !claimed);
      }
      const rowEl = document.querySelector('[data-drow="' + t.id + '"]');
      if (rowEl) rowEl.classList.toggle('claimed', claimed);
    }
  }

  function renderWeekly() {
    ensureWeekly();
    const claimedSet = state.weekly.claimed.join(',');
    // 壳签名：周标识 + 领取集合（不含每跳进度），动态部分走补丁
    const sig = state.weekly.week + '|' + claimedSet;
    if (panelSigs.weeklyShell !== sig) {
      panelSigs.weeklyShell = sig;
      $('weeklyList').innerHTML = WEEKLY_TASKS.map((t) => {
        const rewardText = (t.reward.stones ? fmt(t.reward.stones) + ' 灵石' : '') +
          (t.reward.dust ? (t.reward.stones ? ' · ' : '') + t.reward.dust + ' 碎屑' : '');
        return (
          '<div class="daily-row" data-wrow="' + t.id + '">' +
            '<div class="pet-main"><span class="pet-name">' + t.name + '</span>' +
            '<p class="pet-desc"><span data-wprog="' + t.id + '"></span> · 奖励 ' + rewardText + '</p></div>' +
            '<button class="mini" data-weekly="' + t.id + '" data-wbtn="' + t.id + '"></button>' +
          '</div>'
        );
      }).join('');
    }
    for (const t of WEEKLY_TASKS) {
      const cur = Math.min(state.weekly[t.id] || 0, t.target);
      const done = cur >= t.target;
      const claimed = state.weekly.claimed.includes(t.id);
      const prog = document.querySelector('[data-wprog="' + t.id + '"]');
      if (prog) prog.textContent = fmt(cur) + ' / ' + fmt(t.target);
      const btn = document.querySelector('[data-wbtn="' + t.id + '"]');
      if (btn) {
        btn.textContent = claimed ? '已领取' : done ? '领取' : '进行中';
        btn.disabled = !(done && !claimed);
      }
      const rowEl = document.querySelector('[data-wrow="' + t.id + '"]');
      if (rowEl) rowEl.classList.toggle('claimed', claimed);
    }
  }

  function renderAchv() {
    const states = ACHIEVEMENTS.map((a) => {
      const claimed = !!state.achievements[a.id];
      const cur = Math.min(a.cur(state), a.target);
      const isReady = !claimed && cur >= a.target;
      return { a, cur, claimed, isReady };
    });
    const claimedN = states.filter((s2) => s2.claimed).length;
    const ready = states.filter((s2) => s2.isReady).length;
    const nTodo = states.length - ready - claimedN;
    const claimedIds = states.filter((s2) => s2.claimed).map((s2) => s2.a.id).join(',');
    // 壳签名：筛选 + 领取集合 + 已佩称号（不含每跳进度——进度走下方补丁，
    // 自动开箱高频渲染时按钮 DOM 稳定，防悬停闪烁与点击落空）
    const sig = achvFilter + '|' + claimedIds + '|' + state.title;
    if (panelSigs.achvShell !== sig) {
      panelSigs.achvShell = sig;
      const shown = states.filter((s2) =>
        achvFilter === 'ready' ? s2.isReady
          : achvFilter === 'done' ? s2.claimed
          : achvFilter === 'todo' ? !s2.claimed && !s2.isReady
          : true);
      $('achvList').innerHTML = shown.length
        ? shown.map(({ a }) =>
            '<div class="achv-row" data-arow="' + a.id + '">' +
              '<div class="pet-main"><span class="pet-name">' + a.name +
                (a.title ? ' <em>称号·' + a.title + '</em>' : '') + '</span>' +
              '<p class="pet-desc">' + a.desc + ' · <span data-aprog="' + a.id + '"></span></p></div>' +
              '<button class="mini" data-achv="' + a.id + '" data-abtn="' + a.id + '"></button>' +
            '</div>'
          ).join('')
        : '<p class="hint">该分类下暂无成就。</p>';
      const countMapShell = { all: states.length, ready, done: claimedN, todo: nTodo };
      const filterDefs = [
        ['all', '全部'], ['ready', '未领取'], ['done', '已完成'], ['todo', '未完成'],
      ];
      $('achvFilterRow').innerHTML = filterDefs.map(([key, label]) =>
        '<button class="bag-chip' + (achvFilter === key ? ' active' : '') + '" data-achv-filter="' + key + '">' +
          label + ' (<span data-count="' + key + '">' + countMapShell[key] + '</span>)</button>').join('');
      const titles = states.filter((s2) => s2.claimed && s2.a.title).map((s2) => s2.a.title);
      $('titleRow').innerHTML = titles.length
        ? titles.map((t) =>
            '<button class="bag-chip' + (state.title === t ? ' active' : '') + '" data-title="' + t + '">' + t + '</button>'
          ).join('')
        : '<span class="title-empty">达成标杆成就解锁称号</span>';
      // 一次性收集本壳的行元素引用：补丁循环每帧 61×3 次全文档 querySelector 太贵
      achvEls = new Map();
      $('achvList').querySelectorAll('[data-arow]').forEach((rowEl) => {
        achvEls.set(rowEl.dataset.arow, {
          prog: rowEl.querySelector('[data-aprog]'),
          btn: rowEl.querySelector('[data-abtn]'),
          row: rowEl,
        });
      });
    }
    // 动态补丁：计数、每行进度、按钮状态
    $('achvCount').textContent = claimedN + ' / ' + ACHIEVEMENTS.length;
    const countMap = { all: states.length, ready, done: claimedN, todo: nTodo };
    document.querySelectorAll('#achvFilterRow [data-count]').forEach((chip) => {
      chip.textContent = String(countMap[chip.dataset.count]);
    });
    $('titleBadge').classList.toggle('hidden', !state.title);
    $('titleBadge').textContent = '「' + state.title + '」';
    for (const { a, cur, claimed, isReady } of states) {
      const els = achvEls.get(a.id);
      if (!els) continue;
      if (els.prog) els.prog.textContent = fmt(cur) + ' / ' + fmt(a.target);
      if (els.btn) {
        els.btn.textContent = claimed ? '已达成' : '领 ' + fmt(a.stones) + ' 灵石';
        els.btn.disabled = !isReady;
      }
      if (els.row) {
        els.row.classList.toggle('claimed', claimed);
        els.row.classList.toggle('ready', isReady && !claimed);
      }
    }
  }

  function renderGongfa() {
    const afford = Object.keys(GONGFA).map((k) =>
      state.gongfa[k] >= GONGFA[k].max ? 2 : state.exp >= gongfaCost(state.gongfa[k]) ? 1 : 0).join(',');
    const sig = JSON.stringify(state.gongfa) + '|' + afford + '|' + state.immortal +
      '|' + Math.floor(state.stones / 1e8);
    if (panelSigs.gongfa === sig) return;
    panelSigs.gongfa = sig;
    $('gongfaList').innerHTML = Object.keys(GONGFA).map((key) => {
      const def = GONGFA[key];
      const lv = state.gongfa[key];
      const maxed = lv >= def.max;
      const cost = gongfaCost(lv);
      return (
        '<div class="cave-row">' +
          '<div class="cave-main"><span class="cave-name">' + def.name + ' <em>' + lv + ' / ' + def.max + ' 层</em></span>' +
          '<p class="cave-desc">' + def.desc + ' · 参悟需 ' + fmt(cost) + resIcon('exp') + '</p></div>' +
          '<button class="mini" data-gongfa="' + key + '"' + (maxed || state.exp < cost ? ' disabled' : '') + '>' +
            (maxed ? '已圆满' : '参悟') + '</button>' +
        '</div>'
      );
    }).join('');
    const btn = $('immortalBtn');
    if (state.ascensions < 1) {
      btn.classList.add('hidden');
      $('immortalHint').classList.add('hidden');
    } else {
      btn.classList.remove('hidden');
      $('immortalHint').classList.remove('hidden');
      const cost = immortalCost();
      if (state.immortal >= IMMORTAL_MAX) {
        btn.innerHTML = '仙位已满（' + IMMORTAL_MAX + '/' + IMMORTAL_MAX + '）';
        btn.disabled = true;
      } else {
        const can = state.stones >= cost;
        btn.innerHTML = '入仙界（' + fmt(cost) + resIcon('stones') + '）';
        btn.disabled = !can;
      }
      $('immortalHint').textContent = '仙位 ' + state.immortal + ' / ' + IMMORTAL_MAX +
        ' · 每位收益 +10%，秘境敌人与产出 ×1.05';
    }
  }

  function renderElixir() {
    const c = state.elixir.crafting;
    const bucket = c ? Math.ceil(Math.max(0, c.doneAt - Date.now()) / 1000) : 0;
    const activeBucket = elixirOn(state.elixir.id) ? Math.ceil((state.elixir.until - Date.now()) / 1000) : 0;
    const afford = ELIXIRS.map((e) => state.stones >= e.cost ? 1 : 0).join(',');
    // 合丹按钮阈值是四成价（1200/2400），与全价桶（3000/6000）不重合——须单独入签名，
    // 否则灵石跨过四成线时按钮保持错误的禁用/可点（2026-11-01 修）
    const affordHerb = ELIXIRS.map((e) => state.stones >= Math.ceil(e.cost * 0.4) ? 1 : 0).join(',');
    const sig = JSON.stringify(state.elixir.owned) + '|' + bucket + '|' + activeBucket + '|' + afford + '|' + affordHerb +
      (c ? c.id : '') + '|' + Math.floor(state.gather.herb / HERB_ELIXIR_NEED) + '|' +
      Math.floor(state.stones / 2000);
    if (panelSigs.elixir === sig) return;
    panelSigs.elixir = sig;
    $('elixirList').innerHTML = ELIXIRS.map((def) => {
      const owned = state.elixir.owned[def.id] || 0;
      const active = elixirOn(def.id);
      let action;
      if (c && c.id === def.id) {
        action = '<button class="mini" disabled>炼制中 ' + fmtDuration(bucket) + '</button>';
      } else if (c) {
        action = '<button class="mini" disabled>炉被占用</button>';
      } else {
        action = '<button class="mini" data-elixir="craft" data-id="' + def.id + '"' +
          (state.stones < def.cost ? ' disabled' : '') + '>炼制 ' + fmt(def.cost) + resIcon('stones') + '</button>' +
          '<button class="mini" data-elixir="herb" data-id="' + def.id + '"' +
          (state.gather.herb >= HERB_ELIXIR_NEED && state.stones >= Math.ceil(def.cost * 0.4) ? '' : ' disabled') +
          '>灵药合丹 ' + HERB_ELIXIR_NEED + '+四成灵石</button>';
      }
      return (
        '<div class="cave-row">' +
          '<span class="cave-icon" aria-hidden="true">' + (ELIXIR_ICONS[def.id] || def.icon) + '</span>' +
          '<div class="cave-main"><span class="cave-name">' + def.name +
            (owned ? ' <em>存 ' + owned + '</em>' : '') + (active ? ' <em>生效中 ' + fmtDuration(activeBucket) + '</em>' : '') + '</span>' +
          '<p class="cave-desc">' + def.desc + '</p></div>' +
          (owned && !active && !elixirOn(state.elixir.id)
            ? '<button class="mini" data-elixir="take" data-id="' + def.id + '">服用</button>'
            : action) +
        '</div>'
      );
    }).join('');
  }

  function renderTrials() {
    const run = state.rogue.run;
    const bossDone = state.bossRush.date === todayStr() && state.bossRush.grade;
    const trialsDone = state.trials.date === todayStr() ? state.trials.done : [];
    const anomalyDone = state.anomaly.date === todayStr() && state.anomaly.done;
    const sig = JSON.stringify(run) + '|' + state.rogue.best + '|' + bossDone + '|' +
      trialsDone.join('+') + '|' + state.stageCleared + '|' + anomalyDone + '|' + state.anomaly.grade;
    if (panelSigs.trials === sig) return;
    panelSigs.trials = sig;
    $('rogueBest').textContent = '最远 ' + state.rogue.best + ' / ' + ROGUE_FLOORS + ' 层';
    const rogueBtn = $('rogueBtn');
    if (run) {
      rogueBtn.textContent = '挑战第 ' + run.floor + ' 层';
      rogueBtn.disabled = false;
      $('rogueStatus').textContent = '探幽进行中 · 神物：' +
        (run.buffs.length ? run.buffs.map((id) => ROGUE_BUFFS.find((b) => b.id === id).name).join('、') : '无');
    } else {
      rogueBtn.textContent = '开始探幽';
      rogueBtn.disabled = state.stageCleared < 10;
      $('rogueStatus').textContent = state.stageCleared < 10
        ? '通关闯关第 10 关解锁' : '未在进行中';
    }
    $('rogueGiveup').classList.toggle('hidden', !run);

    const rushBtn = $('bossRushBtn');
    rushBtn.disabled = state.stageCleared < 5 || !!bossDone;
    rushBtn.textContent = bossDone
      ? '今日评级：' + bossDone
      : state.stageCleared < 5 ? '通关闯关第 5 关解锁' : '首领连战';
    $('bossRushNote').textContent = state.stageCleared < 5
      ? '连打已通关的闯关首领，按平均回合评级发奖，每日一次。'
      : '对手：' + BOSS_RUSH_LEVELS.filter((lv) => lv <= state.stageCleared).join(' / ') + ' 关首领 · 每日一次';

    $('trialList').innerHTML = TRIALS.map((t) => {
      const done = trialsDone.includes(t.id);
      const unlocked = unlockedMode(t.enemy);
      return (
        '<div class="pet-row' + (done ? ' claimed' : '') + '">' +
          '<div class="pet-main"><span class="pet-name">' + t.name + '</span>' +
          '<p class="pet-desc">' + t.desc + ' · 奖励 ' + fmt(TRIAL_REWARD.stones) + ' 灵石 + ' +
            TRIAL_REWARD.dust + ' 碎屑</p></div>' +
          '<button class="mini" data-trial="' + t.id + '"' + (done || !unlocked ? ' disabled' : '') + '>' +
            (done ? '已达成' : !unlocked ? '未解锁' : '挑战') + '</button>' +
        '</div>'
      );
    }).join('') +
    // 异象秘境：日期种子词缀每日一换，S 级 5% 掉仙品、月全勤 S 保底仙品
    (() => {
      const affs = anomalyAffixes().map((a) => a.name + '（' + a.desc + '）').join(' + ');
      const anomBtn = $('anomalyBtn');
      if (anomBtn) {
        anomBtn.disabled = anomalyDone || state.stageCleared < 5;
        anomBtn.textContent = anomalyDone
          ? (state.anomaly.grade ? '今日已平 · ' + state.anomaly.grade + ' 级' : '今日异象未平')
          : state.stageCleared < 5 ? '通关闯关第 5 关解锁' : '平定异象';
      }
      const note = $('anomalyNote');
      if (note) {
        note.textContent = state.stageCleared < 5
          ? '每日词缀挑战，按余血评级发奖。'
          : '今日词缀：' + affs + ' · 首通 +' + fmt(ANOMALY_FIRST.stones) + ' 灵石 · S 级 ' +
            Math.round(ANOMALY_S_DROP * 100) + '% 掉仙品';
      }
      return '';
    })();
  }

  function renderMarket() {
    // 璞玉按钮带当日剩余次数：必须在市场签名检查之前更新——
    // 开璞玉不改市场货单，签名不变会被 early-return 跳过（2026-10-31 实测踩坑）
    ensureDaily();
    const gmLeft = Math.max(0, GAMBLE_DAILY_MAX - (state.daily.gamble | 0));
    const gmBtn = $('gambleBtn'), gm10 = $('gamble10Btn');
    if (gmBtn) {
      gmBtn.textContent = '开璞玉（20 万灵石）· 今日剩 ' + gmLeft;
      gmBtn.disabled = gmLeft <= 0 || state.stones < GAMBLE_COST;
    }
    if (gm10) {
      gm10.textContent = '连开 10 次（200 万灵石）· 今日剩 ' + gmLeft;
      gm10.disabled = gmLeft < 10 || state.stones < GAMBLE_COST * 10;
    }
    if (ensureDated(state.market)) state.market.sold = [];
    const picks = marketPicks();
    const sig = state.market.date + '|' + state.market.sold.join('+') + '|' +
      picks.map((p) => state.stones >= p.cost ? 1 : 0).join(',');
    if (panelSigs.market === sig) return;
    panelSigs.market = sig;
    $('marketDate').textContent = '今日货单';
    $('marketList').innerHTML = picks.map((p) => {
      const sold = state.market.sold.includes(p.id);
      return (
        '<div class="pet-row' + (sold ? ' claimed' : '') + '">' +
          '<div class="pet-main"><span class="pet-name">' + p.name + '</span>' +
          '<p class="pet-desc">' + p.desc + '</p></div>' +
          '<button class="mini" data-market="' + p.id + '"' + (sold || state.stones < p.cost ? ' disabled' : '') + '>' +
            (sold ? '已购' : fmt(p.cost) + resIcon('stones')) + '</button>' +
        '</div>'
      );
    }).join('');
  }

  // 怪物出处检索（2026-11-01 用户指定：点图鉴名称弹详情）——按名字匹配各玩法怪物表
  function beastHabitat(name) {
    const out = [];
    const wi = WILD_ZONES.findIndex((z) => z.monster === name);
    if (wi >= 0) out.push('野外 · ' + WILD_ZONES[wi].name + ' · 危险度 ' + (wi + 1));
    if (TOWER_MONSTERS.some((m) => m.name === name)) out.push('爬塔 / 无尽秘境 · 常规守卫');
    if (TOWER_BOSSES.some((b) => b.name === name)) out.push('爬塔 · 每 10 层镇塔主');
    const ci = STAGE_CHAPTERS.findIndex((c) => c.boss === name || c.monsters.includes(name));
    if (ci >= 0) out.push('闯关 · ' + STAGE_CHAPTERS[ci].name +
      (STAGE_CHAPTERS[ci].boss === name ? ' · 关底首领' : ''));
    if (name === '心魔') out.push('试炼 · 心魔劫');
    if (CHAPTER_BOSSES.includes(name.replace(/·.*$/, ''))) out.push('天下 · 世界妖王');
    if (!out.length) out.push('秘境征战与各类事件');
    return out;
  }

  // 详情行小图标（currentColor 随主题）：剑=击杀，罗盘=出处（图标旁配汉字标签）
  const BEAST_ICONS = {
    kill: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
      '<path d="M2.2 13.8l.6-2.6 7.4-7.4 2 2-7.4 7.4-2.6.6z" fill="currentColor"/>' +
      '<path d="M11.2 2.4l2.4 2.4.9-.9a.8.8 0 0 0 0-1.1l-1.3-1.3a.8.8 0 0 0-1.1 0l-.9.9z" fill="currentColor" opacity=".65"/></svg>',
    pin: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
      '<path d="M8 1.2a4.8 4.8 0 0 1 4.8 4.8c0 3.4-4.8 8.8-4.8 8.8S3.2 9.4 3.2 6A4.8 4.8 0 0 1 8 1.2z" fill="currentColor"/>' +
      '<circle cx="8" cy="6" r="1.8" fill="rgba(0,0,0,.4)"/></svg>',
  };

  function openBeast(name) {
    const kills = state.bestiary[name] || 0;
    $('beastTitle').textContent = name;
    const wi = WILD_ZONES.find((z) => z.monster === name);
    const ti = TOWER_MONSTERS.find((m) => m.name === name) || TOWER_BOSSES.find((b) => b.name === name);
    const icon = wi ? wi.icon : (ti ? ti.icon : (name === '心魔' ? '魔' : '妖'));
    // 头像：有 AI 立绘用立绘（monsterImgOf 剥词缀前缀匹配），无则徽记 SVG 兜底
    const habitats = beastHabitat(name);
    $('beastBody').innerHTML =
      '<div class="beast-detail">' +
        '<div class="inspect-line">' +
          '<div class="beast-avatar">' + monsterAvatarHtml(name, icon) + '</div>' +
          '<span class="inspect-power">' + BEAST_ICONS.kill + ' 击杀 ' + fmt(kills) + '</span>' +
        '</div>' +
        habitats.map((h) =>
          '<div class="beast-row">' + BEAST_ICONS.pin + '<i>出处</i><span>' + esc(h) + '</span></div>').join('') +
      '</div>';
    $('beastModal').classList.add('show');
  }

  function renderBestiary() {
    const species = Object.keys(state.bestiary).length;
    const sig = JSON.stringify(state.bestiary);
    if (panelSigs.bestiary === sig) return;
    panelSigs.bestiary = sig;
    $('bestiaryCount').textContent = species + ' 种' +
      (species >= 5 ? ' · 攻血 +' + (0.5 * Math.floor(species / 5)).toFixed(1) + '%' : '');
    const entries = Object.keys(state.bestiary).sort((a, b) => state.bestiary[b] - state.bestiary[a]);
    $('bestiaryList').innerHTML = entries.length
      ? entries.map((name) =>
          '<span class="beast-chip" data-beast="' + esc(name) + '" title="查看怪物详情">' +
          esc(name) + ' <i>' + fmt(state.bestiary[name]) + '</i></span>'
        ).join('')
      : '<span class="title-empty">尚无击杀记录，去秘境开张。</span>';
  }

  /* ---------------- 第三批渲染 ---------------- */

  function renderResonance() {
    const res = resonanceInfo();
    const sig = JSON.stringify(res.bonus) + '|' + Object.keys(res.counts).map((k) => k + res.counts[k]).join(',');
    if (panelSigs.resonance === sig) return;
    panelSigs.resonance = sig;
    const keys = Object.keys(res.counts).filter((k) => res.counts[k] >= 3);
    $('resonanceBox').innerHTML = keys.length
      ? keys.map((k) => {
        const b = res.bonus[k];
        const name = affixDef(k).name;
        const eff = (k === 'crit' || k === 'ls' || k === 'pierce')
          ? '+' + (b.flat * 100).toFixed(1).replace(/\.0$/, '') + '%'
          : '+' + (b.pct * 100).toFixed(0) + '%';
        return '<span class="res-chip' + (b.n >= 5 ? ' max' : '') + '">' + name + '×' + b.n +
          ' 共鸣 ' + eff + '</span>';
      }).join('')
      : '<span class="title-empty">同词条凑 3 条触发共鸣（攻/血/防 +5%，暴/吸/破 +2%），5 条翻倍。</span>';
  }

  function renderSteward() {
    const st = state.steward;
    const sig = JSON.stringify(st); // 四组 chip 不展示灵石，stones 进签名只会白重建（开箱即闪）
    if (panelSigs.steward === sig) return;
    panelSigs.steward = sig;
    const chip = (group, val, label, on) =>
      '<button class="bag-chip' + (on ? ' active' : '') + '" data-steward="' + group + '" data-val="' + val + '">' + label + '</button>';
    $('stewardWear').innerHTML = chip('autoWear', 1, st.autoWear ? '自动穿戴：开' : '自动穿戴：关', st.autoWear);
    $('stewardSalvage').innerHTML =
      chip('autoSalvage', 0, '关', st.autoSalvage === 0) +
      chip('autoSalvage', 1, '分凡灵', st.autoSalvage === 1) +
      chip('autoSalvage', 2, '分到玄品', st.autoSalvage === 2);
    $('stewardMarket').innerHTML = marketPicks().map((p) =>
      chip('market', p.id, p.name + (st.autoMarket.includes(p.id) ? '：自动' : ''), st.autoMarket.includes(p.id))
    ).join('');
  }

  function renderCraft() {
    const sig = state.souls + '|' + Math.floor(state.stones / CRAFT_COST.stones) + '|' +
      Math.floor(state.gather.ore / ORE_SOUL_NEED);
    if (panelSigs.craft === sig) return;
    panelSigs.craft = sig;
    $('soulCount').innerHTML = resIcon('souls') + ' 器魂 ' + fmt(state.souls);
    $('craftList').innerHTML = SLOTS.map((s) => {
      const can = state.souls >= CRAFT_COST.souls && state.stones >= CRAFT_COST.stones;
      return '<button class="mini" data-craft="' + s.key + '"' + (can ? '' : ' disabled') + '>' +
        slotIcon(s.key) + ' ' + s.name + '</button>';
    }).join('') +
      '<button class="mini" data-oreforge="1"' + (state.gather.ore >= ORE_SOUL_NEED ? '' : ' disabled') + '>' +
      '矿石锻魂 ' + ORE_SOUL_NEED + ' → 器魂 3（存矿 ' + fmt(state.gather.ore) + '）</button>';
  }

  // 装备熔铸面板：两档各一行（天→仙 / 仙→仙升星），材料实时盘点不入档
  function renderMelt() {
    const sig = state.bag.length + '|' + Math.floor(state.stones / 10);
    if (panelSigs.melt === sig) return;
    panelSigs.melt = sig;
    $('meltList').innerHTML = [4, 5].map((r) => {
      const n = meltStock(r);
      const can = n >= MELT_NEED && state.stones >= meltFee(r);
      const out = r === 4 ? '仙品' : '仙品 ★+1';
      return '<button class="mini" data-melt="' + r + '"' + (can ? '' : ' disabled') + '>' +
        RARITIES[r].name + ' ×' + n + ' → ' + out +
        '（成功率 10%±5% · ' + fmt(meltFee(r)) + ' 灵石/件）</button>';
    }).join('');
  }

  function renderMirror() {
    const snap = state.mirror.snap;
    const sig = state.mirror.week + '|' + (snap ? snap.power : 0) + '|' + state.mirror.claimed;
    if (panelSigs.mirror === sig) return;
    panelSigs.mirror = sig;
    const box = $('mirrorBox');
    if (!snap) {
      box.innerHTML = '<p class="hint">本周快照尚未生成（挂机 5 秒后自动记录），下周即可挑战「昨日之我」。</p>';
      return;
    }
    box.innerHTML =
      '<div class="rogue-head"><span class="side-title">上周的你 · 战力 ' + fmt(snap.power) + '</span></div>' +
      '<p class="hint">攻 ' + fmt(snap.atk) + ' · 血 ' + fmt(snap.hp) + ' · 防 ' + fmt(snap.def) +
        ' · 胜后 ' + fmt(Math.max(2000, Math.floor(snap.power * 3))) + ' 灵石 + 50 碎屑（每周一次）</p>' +
      '<button class="btn wide" id="mirrorBtn"' + (state.mirror.claimed ? ' disabled' : '') + '>' +
        (state.mirror.claimed ? '本周已胜' : '挑战昨日之我') + '</button>';
    const btn = document.getElementById('mirrorBtn');
    if (btn) btn.addEventListener('click', runMirror);
  }

  function renderMap() {
    ensureMap();
    ensureTreasureSpot();
    const m = state.map;
    const sig = m.seed + '|' + m.rev.length + '|' + m.looted.length + '|' + m.px + '.' + m.py + '|' +
      m.ap + '|' + state.treasure.at + '|' + state.treasure.frags + '|' + state.treasure.maps;
    if (panelSigs.map === sig) return;
    panelSigs.map = sig;
    const buyBtn = document.getElementById('mapBuyBtn');
    if (buyBtn) {
      const maxed = m.buys >= MAP_BUY_MAX;
      buyBtn.textContent = maxed ? '今日加购已满' : '加购 1 行动力（1 万灵石）';
      buyBtn.disabled = maxed || state.stones < MAP_BUY_COST;
    }
    $('mapAp').textContent = '行动力 ' + m.ap + ' / ' + (MAP_AP_MAX + m.buys) + '（每日 +6 · 已购 ' + m.buys + '/' + MAP_BUY_MAX + '）';
    const canMove = (idx) => {
      const x = idx % MAP_W;
      const y = Math.floor(idx / MAP_W);
      return Math.abs(x - m.px) + Math.abs(y - m.py) === 1;
    };
    let html = '';
    const spot = featureOpen('treasure') ? state.treasure.at : -1;
    for (let idx = 0; idx < MAP_W * MAP_H; idx++) {
      const revealed = m.rev.includes(idx);
      const looted = m.looted.includes(idx);
      const here = idx === m.py * MAP_W + m.px;
      const info = tileInfo(idx);
      const adj = canMove(idx);
      let icon = '?';
      let cls = 'fog';
      if (here) { icon = '我'; cls = 'here'; }
      else if (revealed) {
        icon = looted && info.type !== 'empty' ? '∅' : info.icon;
        cls = looted ? 'looted' : info.type;
      } else if (adj) { icon = '+'; cls = 'adj'; }
      const isSpot = idx === spot;
      if (isSpot) { icon = '宝'; cls = 'treasure-spot'; }
      html += '<button class="map-tile ' + cls + '" data-tile="' + idx + '"' +
        (!adj && !isSpot || here || (m.ap <= 0 && !isSpot) ? ' disabled' : '') + ' title="' +
        (isSpot ? '藏宝点（点击挖宝）' : revealed ? info.name : '迷雾') + '">' +
        icon + '</button>';
    }
    $('mapGrid').style.gridTemplateColumns = 'repeat(' + MAP_W + ', 1fr)';
    $('mapGrid').innerHTML = html;
  }

  function renderOrdeal() {
    const sig = state.ordeal.active + '|' + state.ordeal.dirty + '|' + state.ordealDone.join('+');
    if (panelSigs.ordeal === sig) return;
    panelSigs.ordeal = sig;
    $('ordealList').innerHTML = ORDEALS.map((o) => {
      const done = state.ordealDone.includes(o.id);
      const active = state.ordeal.active === o.id;
      return (
        '<div class="pet-row' + (done ? ' claimed' : active ? ' active' : '') + '">' +
          '<div class="pet-main"><span class="pet-name">' + o.name +
            (done ? ' <em>已功成</em>' : active ? ' <em>进行中' + (state.ordeal.dirty ? '·已破戒' : '') + '</em>' : '') + '</span>' +
          '<p class="pet-desc">' + o.desc + ' · ' + o.reward + '</p></div>' +
          '<button class="mini" data-ordeal="' + o.id + '"' + (done ? ' disabled' : '') + '>' +
            (done ? '功成' : active ? '放下' : '接受') + '</button>' +
        '</div>'
      );
    }).join('');
  }

  function renderMuseum() {
    const sig = SLOTS.map((s) => {
      const it = state.museum[s.key];
      return it ? s.key + ':' + it.id + ':' + itemScore(it) : s.key + ':0';
    }).join('|') + '|' + state.bag.length;
    if (panelSigs.museum === sig) return;
    panelSigs.museum = sig;
    $('museumList').innerHTML = SLOTS.map((s) => {
      const it = state.museum[s.key];
      return (
        '<div class="pet-row' + (it ? ' active' : '') + '">' +
          '<span class="pet-icon" aria-hidden="true">' + slotIcon(s.key) + '</span>' +
          '<div class="pet-main"><span class="pet-name">' + (it ? esc(it.name) : s.name + '展位') + '</span>' +
          '<p class="pet-desc">' + (it
            ? '战力 ' + fmt(itemPower(it)) + ' · 收益加成 ' + ((it.special || it.r >= 5) ? 2 : 1) + '%'
            : '空置 · 封存后给收益加成') + '</p></div>' +
        '</div>'
      );
    }).join('') +
    '<p class="hint">背包里更强的同部位装备可「封存」替换展品；展品离手，加成全局生效（当前 +' + (museumBonus() * 100).toFixed(0) + '% 收益）。</p>';
  }

  function renderFarm() {
    const bucket = state.farm.plots.map((p) =>
      p ? p.id + ':' + Math.ceil(Math.max(0, p.doneAt - Date.now()) / 15000) : 'empty').join('|');
    const afford = FARM_SEEDS.map((sd) => state.stones >= sd.cost ? 1 : 0).join(',');
    const sig = bucket + '|' + afford;
    if (panelSigs.farm === sig) return;
    panelSigs.farm = sig;
    let html = '';
    for (let i = 0; i < FARM_PLOTS; i++) {
      const plot = state.farm.plots[i];
      if (plot) {
        const def = FARM_SEEDS.find((sd) => sd.id === plot.id);
        const left = plot.doneAt - Date.now();
        html += '<div class="cave-row"><div class="cave-main">' +
          '<span class="cave-name">' + def.name + ' <em>' +
          (left > 0 ? '生长中 ' + fmtDuration(left / 1000) : '可收获') + '</em></span>' +
          '<p class="cave-desc">收获 ' + def.dust + ' 碎屑</p></div>' +
          '<button class="mini" data-harvest="' + i + '"' + (left > 0 ? ' disabled' : '') + '>收获</button></div>';
      } else {
        html += '<div class="cave-row"><div class="cave-main"><span class="cave-name">空田</span>' +
          '<p class="cave-desc">选一种灵籽播种</p></div>' +
          '<div class="pet-actions seed-actions">' + FARM_SEEDS.map((sd) =>
            '<button class="mini" data-plant="' + i + '" data-seed="' + sd.id + '" title="' + sd.text + '"' +
              (state.stones < sd.cost ? ' disabled' : '') + '>' + sd.name + ' ' + fmt(sd.cost) + resIcon('stones') + '</button>'
          ).join('') + '</div></div>';
      }
    }
    $('farmList').innerHTML = html;
  }

  function renderChapter() {
    const sig = state.chapters.join(',') + '|' + state.realm;
    if (panelSigs.chapter === sig) return;
    panelSigs.chapter = sig;
    const realm = state.realm;
    const def = CHAPTERS[realm];
    const claimed = state.chapters.includes(realm);
    $('chapterBox').innerHTML =
      '<p class="side-title">天道录 · ' + def.title +
        (claimed ? ' <span class="title-empty">已参悟</span>' : '') + '</p>' +
      '<p class="chapter-text">' + def.text + '</p>' +
      (claimed ? '' : '<button class="btn tiny" id="chapterBtn">参悟（+' + fmt(CHAPTER_GAIN * (realm + 1)) + ' 灵石）</button>');
    const btn = document.getElementById('chapterBtn');
    if (btn) btn.addEventListener('click', () => claimChapter(realm));
  }

  /* ---------------- 第四批渲染 ---------------- */

  function renderShichen() {
    const sc = shichenNow();
    const text = sc.name + ' · ' + sc.desc;
    if ($('shichenBadge').textContent !== text) $('shichenBadge').textContent = text;
    $('shichenBadge').classList.remove('hidden');
    // 天象徽章：每日一换，与时辰并列展示
    const sky = skyNow();
    const skyText = sky.name + ' · ' + sky.desc;
    const skyEl = $('skyBadge');
    if (skyEl) {
      if (skyEl.textContent !== skyText) skyEl.textContent = skyText;
      skyEl.classList.remove('hidden');
    }
  }

  function renderDemon() {
    const d = state.innerDemon;
    const sig = d ? d.kills + '|' + d.hp : 'none';
    if (panelSigs.demon === sig) return;
    panelSigs.demon = sig;
    const box = $('demonBox');
    if (!d) {
      box.innerHTML = '<p class="hint">突破境界后，心魔将现形。它随你成长，斩之得大额修为。</p>';
      return;
    }
    const mult = Math.pow(1.15, d.kills);
    box.innerHTML =
      '<div class="rogue-head"><span class="side-title">心魔 · 已斩 ' + d.kills + ' 形</span></div>' +
      '<p class="hint">当前形攻 ' + fmt(d.atk * mult) + ' · 血 ' + fmt(d.hp * mult) +
        ' · 战胜可得大额修为，随后化形更强。</p>' +
      '<button class="btn wide" id="demonBtn">斩心魔</button>';
  }

  function renderBounty() {
    ensureBounty();
    const sig = state.bounty.date + '|' + state.bounty.slots.map((sl) =>
      sl.id + ':' + sl.tier + ':' + sl.prog + ':' + sl.claimed).join('|') + '|' +
      state.bounty.rerolls + '|' + state.bounty.allClaimed + '|' +
      (state.stones >= BOUNTY_REROLL_COST ? 1 : 0);
    if (panelSigs.bounty === sig) return;
    panelSigs.bounty = sig;
    const allDone = state.bounty.allClaimed;
    $('bountyList').innerHTML = state.bounty.slots.map((sl, i) => {
      const tier = BOUNTY_TIERS.find((t) => t.key === sl.tier) || BOUNTY_TIERS[0];
      const done = sl.prog >= sl.target;
      const rewardText = fmt(tier.stones) + ' 灵石 · ' + tier.dust + ' 碎屑' +
        (tier.drop ? ' · ' + Math.round(tier.drop * 100) + '% 掉天品' : '');
      return (
        '<div class="pet-row' + (sl.claimed ? ' claimed' : '') + '">' +
          '<div class="pet-main"><span class="pet-name">' +
            '<i class="bounty-tier bounty-' + sl.tier + '">【' + tier.name + '】</i> ' + bountyDesc(sl) + '</span>' +
          '<p class="pet-desc">' + fmt(Math.min(sl.prog, sl.target)) + ' / ' + fmt(sl.target) +
            ' · ' + rewardText + '</p></div>' +
          '<div class="pet-actions">' +
            '<button class="mini" data-bounty-reroll="' + i + '"' +
              (state.bounty.rerolls <= 0 || state.stones < BOUNTY_REROLL_COST ? ' disabled' : '') +
              '>刷新 ' + fmt(BOUNTY_REROLL_COST) + resIcon('stones') + '</button>' +
            '<button class="mini" data-bounty-claim="' + i + '"' +
              (done && !sl.claimed ? '' : ' disabled') + '>' +
              (sl.claimed ? '已领' : done ? '领取' : '悬赏中') + '</button>' +
          '</div>' +
        '</div>'
      );
    }).join('') +
    '<p class="hint">四单全清额外 +' + fmt(BOUNTY_ALL_CLEAR.stones) + ' 灵石' +
    (allDone ? '（已达成）' : '') + ' · 今日余刷新 ' + state.bounty.rerolls + ' 次</p>';
  }

  /* ---------------- 日常扩容渲染（灵潮 / 占卜 / 灵气 / 问答 / 朝贺） ---------------- */

  function renderDailyExt() {
    // 灵潮
    ensureTide();
    ensureFortune();
    const box = $('dailyExt');
    if (!box) return;
    const h = new Date().getHours();
    const inWindow = tideOn();
    const tideHtml = TIDE_WINDOWS.map((w, i) => {
      const open = h >= w.s && h < w.e;
      const claimed = state.tide.claimed[i];
      const nextWin = open ? '进行中' : (h < w.s ? '今日 ' + w.s + ':00 开启' : '已结束');
      return (
        '<div class="pet-row' + (claimed ? ' claimed' : '') + '">' +
          '<div class="pet-main"><span class="pet-name">灵潮 · ' + w.s + ':00 – ' + w.e + ':00</span>' +
          '<p class="pet-desc">' + nextWin + ' · 领符 +' + fmt(TIDE_CLAIM) + ' 灵石 · 窗口内产出 ×' + TIDE_MULT + '</p></div>' +
          '<button class="mini" data-tide="' + i + '"' +
            (!open || claimed ? ' disabled' : '') + '>' + (claimed ? '已领' : '领符') + '</button>' +
        '</div>'
      );
    }).join('');
    // 占卜
    const fIdx = state.fortune.idx;
    const fSign = fIdx >= 0 ? FORTUNE_SIGNS[fIdx] : null;
    const fortuneHtml =
      '<div class="pet-row' + (state.fortune.claimed ? ' claimed' : '') + '">' +
        '<div class="pet-main"><span class="pet-name">每日占卜' +
          (fSign ? ' · 「' + fSign.name + '」' : '') + '</span>' +
          '<p class="pet-desc">' + (fSign ? esc(fSign.text) : '免费一签，定今日运势（上上签产出 +5%）') + '</p></div>' +
        (!fSign
          ? '<button class="mini" id="fortuneDrawBtn">摇签</button>'
          : '<button class="mini" id="fortuneClaimBtn"' + (state.fortune.claimed ? ' disabled' : '') + '>' +
            (state.fortune.claimed ? '已领' : '领签') + '</button>') +
      '</div>';
    // 灵气盈满
    const vigorCells = Math.min(VIGOR_CELL_N, Math.floor(state.vigor.minutes / VIGOR_CELL_MIN));
    const vigorHtml =
      '<div class="pet-row' + (state.vigor.claimed >= vigorCells ? ' claimed' : '') + '">' +
        '<div class="pet-main"><span class="pet-name">灵气盈满 · ' + state.vigor.claimed + ' / ' + vigorCells + ' 格</span>' +
        '<p class="pet-desc">在线每 ' + VIGOR_CELL_MIN + ' 分钟聚 1 格（至多 ' + VIGOR_CELL_N + ' 格）· 每格 +' +
        fmt(VIGOR_REWARD.stones) + ' 灵石 +' + VIGOR_REWARD.dust + ' 碎屑' +
        (vigorCells < VIGOR_CELL_N ? ' · 下一格还需 ' + (VIGOR_CELL_MIN - state.vigor.minutes % VIGOR_CELL_MIN) + ' 分钟' : '') + '</p></div>' +
        '<button class="mini" id="vigorClaimBtn"' + (state.vigor.claimed >= vigorCells ? ' disabled' : '') + '>领取</button>' +
      '</div>';
    // 仙道问答
    ensureQuiz();
    const quizDone = state.quiz.done;
    const quizIds = quizPick();
    const quizDef = quizDone ? null : QUIZ_BANK[quizIds[state.quiz.idx]];
    const quizHtml =
      '<div class="pet-row' + (quizDone ? ' claimed' : '') + '">' +
        '<div class="pet-main"><span class="pet-name">仙道问答 · ' +
          (quizDone ? '今日已毕 ' + state.quiz.correct + ' / ' + QUIZ_N : '第 ' + (state.quiz.idx + 1) + ' / ' + QUIZ_N + ' 题') +
          ' · 连对 ' + state.quiz.streak + ' 天</span>' +
          '<p class="quiz-q">' + (quizDone
            ? (state.quiz.correct >= QUIZ_N
              ? '全对！连对 ' + state.quiz.streak + ' 天' + (state.quiz.streak === 0 ? '（七日连对已得天品自选箱）' : '，满 ' + QUIZ_STREAK_N + ' 天得「天品自选箱」') + ' · 明日再来'
              : '答对 ' + state.quiz.correct + ' 题 · 连对中断，明日再来')
            : esc(quizDef.q)) + '</p>' +
          (quizDone ? '' :
            '<div class="quiz-opts">' + quizDef.a.map((opt, oi) =>
              '<button class="mini" data-quiz="' + oi + '">' + esc(opt) + '</button>').join('') + '</div>') +
        '</div>' +
      '</div>';
    // 月度朝贺
    ensureMonth();
    const signedToday = state.lastSignIn === todayStr();
    const monthHtml = MONTH_MILESTONES.map((m) => {
      const claimed = state.month.claimed.includes(m.n);
      const reach = state.month.days.length >= m.n;
      return (
        '<div class="pet-row' + (claimed ? ' claimed' : '') + '">' +
          '<div class="pet-main"><span class="pet-name">朝贺 ' + m.n + ' 天</span>' +
          '<p class="pet-desc">' + m.text + ' · 本月到勤 ' + state.month.days.length + ' / ' + m.n + ' 天</p></div>' +
          '<button class="mini" data-month="' + m.n + '"' + (claimed || !reach ? ' disabled' : '') + '>' +
            (claimed ? '已领' : reach ? '领取' : '未达成') + '</button>' +
        '</div>'
      );
    }).join('') +
      '<p class="hint">本月补签 ' + state.month.makeup + ' / ' + MONTH_MAKEUP_MAX +
      ' 次' + (signedToday ? '' : ' · 今日尚未签到，先去签到') +
      ' <button class="mini" id="monthMakeupBtn"' +
      (state.month.makeup >= MONTH_MAKEUP_MAX || signedToday || state.stones < MONTH_MAKEUP_COST ? ' disabled' : '') +
      '>补签昨日 ' + fmt(MONTH_MAKEUP_COST) + resIcon('stones') + '</button></p>';
    // 壳签名：只有结构变化才重建（灵气分钟数跳变走局部补丁）
    const sig = state.tide.date + '|' + state.tide.claimed.join(',') + '|' + inWindow + '|' + h +
      '|' + state.fortune.date + '|' + state.fortune.idx + '|' + state.fortune.claimed +
      '|' + state.vigor.claimed + '|' + vigorCells +
      '|' + state.quiz.date + '|' + state.quiz.idx + '|' + state.quiz.correct + '|' + state.quiz.done + '|' + state.quiz.streak +
      '|' + state.month.key + '|' + state.month.days.length + '|' + state.month.claimed.join(',') + '|' +
      state.month.makeup + '|' + signedToday + '|' + (state.stones >= MONTH_MAKEUP_COST ? 1 : 0);
    if (panelSigs.dailyExt === sig) return;
    panelSigs.dailyExt = sig;
    box.innerHTML =
      '<p class="side-title">灵潮时段 <span class="count">产出 ×' + dayProdMult() + '</span></p>' +
      tideHtml +
      '<p class="side-title">每日占卜</p>' +
      fortuneHtml +
      '<p class="side-title">灵气盈满</p>' +
      vigorHtml +
      '<p class="side-title">仙道问答 <span class="count">每日 ' + QUIZ_N + ' 题</span></p>' +
      quizHtml +
      '<p class="side-title">月度朝贺 <span class="count">' + monthKey() + '</span></p>' +
      monthHtml;
  }

  function renderDao() {
    const sig = JSON.stringify(state.daoLv);
    if (panelSigs.dao === sig) return;
    panelSigs.dao = sig;
    $('daoList').innerHTML = DAO_NPCS.map((npc) => {
      const aff = daoAffOf(npc.id);
      const sp = daoSpend(npc.id);
      const bonded = daoBonded(npc.id);
      const married = state.daoLv.married === npc.id;
      return (
        '<div class="pet-row' + (married ? ' active' : '') + '">' +
          '<span class="pet-icon dao-avatar-box">' + daoAvatar(npc.id) + '</span>' +
          '<div class="pet-main"><span class="pet-name">' + npc.name +
            (married ? ' <em>道侣</em>' : '') + '</span>' +
          '<p class="pet-desc">结缘进度 ' + daoAffText(aff) + '% / 100%' +
            ' · 灵石礼 ' + fmt(sp.stones) + ' / ' + fmt(DAO_MARRY_STONES) +
            ' · 碎屑礼 ' + fmt(sp.dust) + ' / ' + fmt(DAO_MARRY_DUST) +
            ' · ' + npc.desc + '</p></div>' +
          (bonded && !married
            ? '<button class="mini" data-dao-marry="' + npc.id + '">结为道侣</button>'
            : '<button class="mini" disabled>' + (married ? '相伴中' : '未结缘') + '</button>') +
        '</div>' +
        '<div class="dao-gifts">' +
          DAO_GIFTS.map((g) => {
            const can = (g.stones && state.stones >= g.stones) ||
              (g.dust && state.dust >= g.dust);
            const costStr = (g.stones ? fmt(g.stones) + resIcon('stones') : '') +
              (g.dust ? fmt(g.dust) + resIcon('dust') : '');
            // title 写真实增量：结缘进度按累计线折算（单次灵石礼 +2.5% / 碎屑礼 +0.2%），
            // 旧版 aff 字段已废弃，不得再显示「好感 +2」误导
            const perAff = daoAffText(Math.min(DAO_MARRY_AT, (g.stones || g.dust) /
              (g.stones ? DAO_MARRY_STONES : DAO_MARRY_DUST) * DAO_MARRY_AT));
            const tip = !can
              ? (g.stones ? '灵石不足，无法赠礼' : '碎屑不足，无法赠礼')
              : (bonded ? '已可结缘' : '结缘进度 +' + perAff + '%');
            return '<button class="mini" data-dao-gift="' + npc.id + ':' + g.id + '" title="' + tip + '"' +
              (can && !bonded ? '' : ' disabled') + '>' + g.name + ' ' + costStr + '</button>';
          }).join('') +
        '</div>'
      );
    }).join('');
    // 头像加载失败回退字标：CSP 禁内联 onerror，渲染后统一挂 error 监听
    // （error 事件异步派发，innerHTML 后同步挂上必能接到）
    $('daoList').querySelectorAll('img.dao-face').forEach((im) => {
      im.addEventListener('error', () => im.classList.add('dao-face-bad'), { once: true });
    });
  }

  function renderBattleStats() {
    const bs = state.battleStats;
    const sig = bs.dmg + '|' + bs.taken + '|' + bs.wins;
    if (panelSigs.battleStats === sig) return;
    panelSigs.battleStats = sig;
    $('battleStatsBox').innerHTML =
      '<div class="stat-line"><span>累计造成伤害</span><b>' + fmt(bs.dmg) + '</b></div>' +
      '<div class="stat-line"><span>累计承受伤害</span><b>' + fmt(bs.taken) + '</b></div>' +
      '<div class="stat-line"><span>累计胜场</span><b>' + fmt(bs.wins) + '</b></div>';
  }

  function updateTimer() {
    const p = Math.min(1, acc / interval());
    // 变化才写（2026-11-01 手机降载）：主循环 20Hz 调用，宽度每 1% 才落一次样式，
    // 省掉无变化的强制样式失效（配合触屏端停常驻动画，压低手机端主线程占用）
    const step = Math.round(p * 100);
    if (step === updateTimer.last) return;
    updateTimer.last = step;
    $('timerFill').style.width = (step) + '%';
  }

  /* ---------------- 主循环 ---------------- */

  function loop() {
    if (document.hidden) return;

    vigorTick(); // 灵气盈满：页面在线时长累计

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

    // 自动保存节流 60s（2026-11-01 用户指定，由 30s 上调）：开箱产出攒 60 秒落一次盘，
    // 关键动作（送礼/熔铸/突破等）各自即时 save() 不受此节流影响
    if (opened > 0 && now - lastSave > 60000) {
      save();
      lastSave = now;
    }

    if (state.elixir.crafting && Date.now() >= state.elixir.crafting.doneAt) {
      const c = state.elixir.crafting;
      state.elixir.crafting = null;
      state.elixir.owned[c.id] = (state.elixir.owned[c.id] || 0) + 1;
      const def = ELIXIRS.find((e) => e.id === c.id);
      pushLog('炼丹完成：「' + def.name + '」', 'sys');
      beep(880, 0.1);
      panelSigs.elixir = null;
      render();
    }

    stewardAcc += dt;
    if (stewardAcc >= 5) {
      stewardAcc = 0;
      stewardTick();
      tickWander();
      if (featureOpen('bounty')) ensureBounty();
      // 天劫计时起点：首次到达天劫门槛（渡劫→仙人档）时起算，三日一临
      if (featureOpen('trib') && !state.tribulation.last) {
        state.tribulation.last = todayStr();
        save();
      }
      if (tribulationDue() && !tribPrompted && featureOpen('trib')) {
        tribPrompted = true;
        openTribulation();
      }
      // 每 5 秒顺带巡一遍玩法解锁（爬塔/野外进度型解锁在这里补播报）
      if (syncFeatureUnlocks(true)) save();
    }

    // 心跳：主循环活着就续锁（后台标签页 loop 早退，锁 6 秒自动过期）
    if (now - (window.__tabBeat || 0) > 2000) {
      window.__tabBeat = now;
      tabHeartbeat();
    }

    if (state.autoHunt && unlockedMode(uiMode) && !needAscension()) {
      huntAcc += dt;
      if (huntAcc >= HUNT_INTERVAL_S) {
        huntAcc = 0;
        doBattle(uiMode, { auto: true }); // 每场（含异步扣点）结束后由下个间隔重计
      }
    } else {
      huntAcc = 0;
    }

    if (fishRod) fishTick();

    if (now - lastRender > 100) {
      render();
      lastRender = now;
    }

    paintBag(false);
    paintResources();
    updateTimer();
    updateStaminaChip(); // 体力量展示插值（文本变化才写 DOM）
  }

  /* ---------------- 天下玩法（排行 / 竞技场 / 妖王 / 仙盟） ---------------- */

  // 服务端为准的运行时缓存；guild 里的 level 供 baseGain 仙盟加成读取
  const WORLD = {
    rank: null, pvp: null, boss: null, guild: null, guildList: null, ladder: null,
    bossBusy: false, arenaBusy: {}, gBossBusy: false,
  };
  // 立盟门槛（2026-11-01 用户指定）：境界「化神」+ 1000 万灵石 + 2 万修为（服务端同口径校验）
  const GUILD_CREATE_COST = 10000000;
  const GUILD_CREATE_EXP_COST = 20000;
  const GUILD_CREATE_REALM = 4;
  // 基金阶梯（与服务端 fundNeed 同口径）：升到第 N 级累计需 20万×N(N-1)/2——首次 20 万，每级 +20 万
  const guildFundNeed = (lv) => 200000 * lv * (lv - 1) / 2;

  const guildBuffLevel = () => (WORLD.guild && WORLD.guild.guild ? WORLD.guild.guild.level : 0);
  const realmName = (n) => REALMS[Math.max(0, Math.min(REALMS.length - 1, Number(n) | 0))];

  async function worldFetch(pathname, opts) {
    // 15s 超时中止：请求悬挂时调用方的 busy 锁（arenaBusy/bossBusy 等）会一直占着，
    // 对应功能永久卡死；超时后走 catch 解锁并给出可读错误
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await api(pathname, Object.assign({}, opts, { signal: ctrl.signal }));
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('网络超时，请稍后再试');
      throw e;
    }
    clearTimeout(timer);
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) {
      const err = new Error((body && body.error) || ('请求失败 ' + res.status));
      err.status = res.status; // 调用方按状态码分流（如 409 快照未就绪 → 立即补推快照）
      throw err;
    }
    return body;
  }

  // 切到「天下」页时拉全量；15 秒内重复切入不重发（各面板自带刷新按钮）
  let worldLastFetch = 0;
  function worldActivate() {
    if (!cloudOn) return;
    if (Date.now() - worldLastFetch < 15000) return;
    worldLastFetch = Date.now();
    loadRank();
    pvpLoad();
    ladderLoad();
    bossLoad();
    guildLoad();
    guildListLoad();
  }

  // ---- 战力榜 ----

  async function loadRank() {
    try {
      WORLD.rank = await worldFetch('/api/rank');
      renderRank();
    } catch (e) {
      $('rankList').innerHTML = '<p class="hint">加载失败：' + esc(e.message) + '</p>';
    }
  }

  function renderRank() {
    if (!WORLD.rank) return;
    const rows = WORLD.rank.top.map((r) =>
      '<div class="rank-row' + (r.rank <= 3 ? ' top3' : '') + '">' +
      '<span class="rk">' + r.rank + '</span>' +
      '<span class="nm"><b class="rk-name" data-inspect="' + r.id + '" title="点击查看装备">' + esc(r.name) + '</b>' +
      ' <i class="gd">' + realmName(r.realm) + '</i>' +
      (r.guild ? ' <i class="gd">『' + esc(r.guild) + '』</i>' : '') + '</span>' +
      '<span class="pw">' + realmName(r.realm) + ' · 战力 ' + fmt(r.power) + '</span></div>'
    ).join('');
    $('rankList').innerHTML = rows || '<p class="hint">榜上无人，速去修炼。</p>';
    const me = WORLD.rank.me;
    $('rankMe').textContent = me.rank > 0
      ? '我的排名：第 ' + me.rank + ' 名 · 战力 ' + fmt(me.power)
      : '尚未上榜：战力不为零后自动入榜。';
  }

  // 装备查验：点战力榜名字拉对方穿戴六件（服务端只回展示字段），弹层展示
  async function inspectPlayer(id) {
    try {
      const out = await worldFetch('/api/rank/inspect', { method: 'POST', body: JSON.stringify({ id }) });
      $('inspectTitle').textContent =
        (out.name || '这位修士') + ' · ' + realmName(out.realm) + ' · 战力 ' + fmt(out.power);
      const rows = SLOTS.map((s) => {
        const it = out.equipped && out.equipped[s.key];
        if (!it) return '<div class="inspect-row"><span class="nm">' + s.name +
          '<span class="inspect-empty">（未穿戴）</span></span></div>';
        const rar = RARITIES[it.r] || RARITIES[0];
        const stars = it.star ? ' ★' + it.star : '';
        const setName = it.setKey && SETS[it.setKey] ? ' · ' + SETS[it.setKey].name + '套装' : '';
        const elName = ELEMENTS.find((e) => e.key === it.el);
        const affixes = (it.affixes || []).map((a) =>
          (SHORT_NAME[a.k] || a.k) + (a.v * 100).toFixed(1) + '%').join(' · ');
        // 三行布局（2026-11-01 手机竖屏修复）：原单行里 meta 被 long 词条挤成省略号，
        // 战力根本看不到——行1 名字+星级 …… 战力（右对齐）；行2 品质·套装·五行·部位；行3 词条
        return '<div class="inspect-row">' +
          '<div class="inspect-line">' +
            '<span class="nm"><b data-c="' + rar.color + '">' + esc(it.name) + '</b>' + stars + '</span>' +
            '<span class="inspect-power">战力 ' + fmt(it.power) + '</span>' +
          '</div>' +
          '<div class="inspect-sub">' +
            '<span class="inspect-meta">' + rar.name + setName +
            (elName ? ' · ' + elName.name : '') + ' · ' + s.name + '</span>' +
            (affixes ? '<span class="pw">' + esc(affixes) + '</span>' : '') +
          '</div>' +
        '</div>';
      }).join('');
      $('inspectBody').innerHTML = rows;
      // 品质色经 CSSOM 落地：CSP style-src 'self' 拦内联 style 属性；明色按 themeInk 压暗
      $('inspectBody').querySelectorAll('[data-c]').forEach((el) => { el.style.color = themeInk(el.dataset.c); });
      $('inspectModal').classList.add('show');
    } catch (e) {
      floatText(e.message, '#f87171');
    }
  }

  // ---- 天梯榜（假人「剑影」常驻，真人打满一场入榜） ----

  async function ladderLoad() {
    try {
      WORLD.ladder = await worldFetch('/api/ladder');
      renderLadder();
    } catch (e) {
      $('ladderList').innerHTML = '<p class="hint">加载失败：' + esc(e.message) + '</p>';
    }
  }

  function renderLadder() {
    const data = WORLD.ladder;
    if (!data) return;
    $('ladderList').innerHTML = data.top.map((r) =>
      '<div class="rank-row' + (r.rank <= 3 ? ' top3' : '') + '">' +
      '<span class="rk">' + r.rank + '</span>' +
      '<span class="nm">' + esc(r.name) +
      (r.bot ? ' <i class="bot-tag">剑影</i>' : '') +
      (r.guild ? ' <i class="gd">『' + esc(r.guild) + '』</i>' : '') + '</span>' +
      '<span class="pw">' + r.rating + ' 分 · ' + r.wins + '胜' + r.losses + '负</span></div>'
    ).join('');
    const me = data.me;
    $('ladderMe').textContent = me.rank > 0
      ? '我的排名：第 ' + me.rank + ' 名 · ' + me.rating + ' 分（' + me.wins + '胜' + me.losses + '负）'
      : '尚未入榜：赢下第一场切磋即上榜。';
  }

  // ---- 竞技场 ----

  async function pvpLoad() {
    try {
      WORLD.pvp = await worldFetch('/api/pvp');
      renderArena();
      return true;
    } catch (e) {
      $('arenaInfo').textContent = '加载失败：' + e.message;
      return false;
    }
  }

  function renderArena() {
    const p = WORLD.pvp;
    if (!p) return;
    $('arenaInfo').textContent =
      '天梯分 ' + p.rating + ' · 胜 ' + p.wins + ' / 负 ' + p.losses + ' · 今日 ' + p.used + ' / ' + p.cap +
      ' 场 · 已购 ' + (p.buys || 0) + '/' + (p.buyMax || 10);
    const buyBtn = $('arenaBuy');
    if (buyBtn) {
      const maxed = (p.buys || 0) >= (p.buyMax || 10);
      buyBtn.textContent = maxed ? '今日加购已满' : '加购 1 场（1 万灵石）';
      buyBtn.disabled = maxed || state.stones < (p.buyCost || 10000);
    }
    $('arenaOpps').innerHTML = p.opponents.map((o) =>
      '<div class="arena-card">' +
      '<div class="ac-head"><b>' + esc(o.name) + (o.bot ? ' <i class="bot-tag">剑影</i>' : '') + '</b>' +
      '<span>' + realmName(o.realm) + ' · 战力 ' + fmt(o.power) + ' · 分 ' + o.rating + '</span></div>' +
      '<button class="btn tiny" data-act="arena" data-id="' + o.id + '"' +
      (p.used >= p.cap ? ' disabled' : '') + '>切磋</button></div>'
    ).join('') || '<p class="hint">暂时没有对手：等其他修士把战力立起来再来看。</p>';
  }

  // 竞技场刷新对手：重拉 /api/pvp，服务端每次随机洗牌即换一批名单
  async function arenaRefresh() {
    if (WORLD.arenaBusy.refresh) return;
    WORLD.arenaBusy.refresh = true;
    const btn = $('arenaRefresh');
    if (btn) btn.disabled = true;
    // pvpLoad 内部自带 try/catch 不再抛错，按返回值区分成败
    const ok = await pvpLoad();
    floatText(ok ? '对手已刷新' : '刷新失败，请稍后再试', ok ? '#4ade80' : '#f87171');
    if (btn) btn.disabled = false;
    WORLD.arenaBusy.refresh = false;
  }

  // 竞技场加购：服务端记权益（users.pvp_buys，日切清零），灵石在此扣（货币归存档管）
  async function arenaBuy() {
    const p = WORLD.pvp;
    if (!p || WORLD.arenaBusy.buy) return;
    if ((p.buys || 0) >= (p.buyMax || 10)) { floatText('今日加购已满', '#f87171'); return; }
    if (state.stones < (p.buyCost || 10000)) { floatText('灵石不足', '#f87171'); return; }
    WORLD.arenaBusy.buy = true;
    try {
      const out = await worldFetch('/api/pvp/buy', { method: 'POST', body: '{}' });
      state.stones -= p.buyCost || 10000;
      Object.assign(WORLD.pvp, { buys: out.buys, cap: out.cap });
      pushLog('竞技场加购 1 场（-' + fmt(p.buyCost || 10000) + ' 灵石），今日可战 ' + out.cap + ' 场', 'sys');
      floatText('场次 +1 · 今日上限 ' + out.cap, '#4ade80');
      beep(660, 0.1);
      save();
      renderArena();
      paintResources();
    } catch (e) {
      floatText(e.message, '#f87171');
    }
    WORLD.arenaBusy.buy = false;
  }

  async function arenaFight(id) {
    const p = WORLD.pvp;
    if (!p || WORLD.arenaBusy[id]) return;
    const opp = p.opponents.find((o) => o.id === id);
    if (!opp || !opp.snap) return;
    if (p.used >= p.cap) { floatText('今日切磋已尽', '#f87171'); return; }
    WORLD.arenaBusy[id] = true;
    try {
      const mine = playerCombatStats();
      const sim = simulateBattle(combatSnapOf(mine), opp.snap);
      showBattlePopup({
        name: opp.name, icon: '',
        kicker: '竞技场 · 天梯 ' + opp.rating,
        hp: opp.snap.hp,
        avatarSvg: opp.bot
          ? monsterImgWrap('jianying', MONSTER_ART.jianying('#7fb3ff'))
          : MONSTER_ART.xiushi('#e8d5a8'),
        closeText: '离开', // 竞技场无战利品，天梯分变动在面板结算
      }, sim, { title: '竞技场 · 切磋', playerHp: mine.hp });
      const out = await worldFetch('/api/pvp/fight', {
        method: 'POST', body: JSON.stringify({ targetId: id, win: sim.win }),
      });
      Object.assign(WORLD.pvp, { rating: out.rating, wins: out.wins, losses: out.losses, used: out.used });
      // 胜负以服务端复算为准（2026-10-31 起服务端不采信上报的 win）；本地 sim 只做战斗动画
      const win = out.win !== undefined ? out.win : sim.win;
      const delta = (out.delta >= 0 ? '+' : '') + out.delta;
      pushLog('竞技场对「' + opp.name + '」' + (win ? '得胜' : '落败') + '（' + sim.rounds + ' 回合），天梯分 ' + delta + ' → ' + out.rating, win ? 'special' : 'sys');
      floatText(win ? '胜！天梯分 ' + delta : '负 · 天梯分 ' + delta, win ? '#facc15' : '#f87171');
      chime(win ? [660, 880, 1174] : [392, 262]);
      renderArena();
      ladderLoad(); // 天梯榜名次随本场刷新
    } catch (e) {
      if (e && e.status === 409) {
        // 快照未就绪（存量档快照列回填前）：persist 重打包 pvpSnap 并立即上推，几秒后可再战
        persist();
        floatText('快照同步中，几秒后再战', '#f87171');
      } else {
        floatText(e.message, '#f87171');
      }
    }
    WORLD.arenaBusy[id] = false;
  }

  // 战斗模拟入参：只取模拟需要的八项
  function combatSnapOf(cs) {
    return {
      atk: cs.atk, hp: cs.hp, def: cs.def, crit: cs.crit, critMult: cs.critMult,
      lifesteal: cs.lifesteal, dr: cs.dr, pierce: cs.pierce,
    };
  }

  // ---- 世界妖王 ----

  async function bossLoad() {
    try {
      WORLD.boss = await worldFetch('/api/boss');
      renderBoss();
      bossMaybeClaim();
    } catch (e) {
      $('bossHpText').textContent = '加载失败：' + e.message;
    }
  }

  function renderBoss() {
    const b = WORLD.boss;
    if (!b) return;
    $('bossName').textContent = b.name;
    const pct = b.maxHp > 0 ? Math.max(0, Math.min(100, (b.hp / b.maxHp) * 100)) : 0;
    $('bossBarFill').style.width = pct.toFixed(1) + '%';
    $('bossHpText').textContent = b.defeated
      ? '今日妖王已被讨平！明日再战。'
      : '剩余气血 ' + fmt(b.hp) + ' / ' + fmt(b.maxHp) + '（' + pct.toFixed(1) + '%）';
    $('bossMy').textContent =
      '今日 ' + b.myHits + ' / ' + b.cap + ' 场 · 我共造成 ' + fmt(b.myDamage) + ' 伤害' +
      (state.boss.claimed === b.day && b.myDamage > 0 ? ' · 讨伐奖励已领' : '');
    $('bossAttack').disabled = b.defeated || b.myHits >= b.cap;
    $('bossAttack').textContent = b.defeated ? '妖王已伏诛' : (b.myHits >= b.cap ? '今日已打满' : '出手攻妖');
    $('bossTop').innerHTML = (b.top || []).map((t, i) =>
      '<div class="rank-row"><span class="rk">' + (i + 1) + '</span>' +
      '<span class="nm">' + esc(t.name) + '</span>' +
      '<span class="pw">' + fmt(t.damage) + ' · ' + t.hits + ' 场</span></div>'
    ).join('') || '<p class="hint">今日尚无战功。</p>';
  }

  // 妖王战力随血池伸缩：120 回合的伤害竞速，防秒杀也防打不死
  function bossEnemyOf(maxHp) {
    const s = Math.sqrt(maxHp || 1);
    return { hp: 1e15, atk: s * 0.5, def: s * 0.04, crit: 0.05, critMult: 2, lifesteal: 0, dr: 0, pierce: 0 };
  }

  async function bossAttack() {
    const b = WORLD.boss;
    if (!b || WORLD.bossBusy || b.defeated || b.myHits >= b.cap) return;
    WORLD.bossBusy = true;
    try {
      const meNow = playerCombatStats();
      const sim = simulateBattle(combatSnapOf(meNow), bossEnemyOf(b.maxHp));
      showBattlePopup({
        name: b.name, icon: '',
        kicker: '世界妖王 · 全服共讨（今日 ' + b.myHits + '/' + b.cap + '）',
        hp: b.maxHp,
        avatarSvg: monsterImgOf(b.name)
          ? monsterImgWrap(monsterImgOf(b.name), MONSTER_ART.yaowang('#e8b05e'))
          : MONSTER_ART.yaowang('#e8b05e'),
        closeText: '离开', // 伤害入池，贡献结算在世界妖王面板
      }, sim, { title: '世界妖王', playerHp: meNow.hp });
      const out = await worldFetch('/api/boss/hit', {
        method: 'POST', body: JSON.stringify({ damage: sim.dealt }),
      });
      Object.assign(WORLD.boss, {
        hp: out.hp, defeated: out.defeated, myDamage: out.myDamage,
        myHits: out.myHits, killer: out.killer,
      });
      pushLog('攻「' + b.name + '」，一场造成 ' + fmt(out.dealt) + ' 伤害', 'sys');
      if (out.defeated) {
        chime([523, 659, 784, 1046]);
        bossMaybeClaim();
      }
      renderBoss();
    } catch (e) {
      floatText(e.message, '#f87171');
    }
    WORLD.bossBusy = false;
  }

  // 讨伐奖励：全服打掉当日妖王后，有战功者各领一份（伤害越高越多，结击者加倍）；只发一次
  function bossMaybeClaim() {
    const b = WORLD.boss;
    if (!b || !b.defeated || !(b.myDamage > 0) || state.boss.claimed === b.day) return;
    let stones = Math.min(200000, 8000 + Math.floor(b.myDamage / 50));
    let dust = Math.min(5000, 20 + Math.floor(b.myDamage / 5000));
    let extra = '';
    if (b.killer === 'me') {
      stones *= 2;
      extra = '（致命一击加倍）';
    }
    stones = addStones(stones);
    dust = addDust(dust);
    state.boss.claimed = b.day;
    pushLog('讨平「' + b.name + '」！+' + fmt(stones) + ' 灵石 · +' + fmt(dust) + ' 碎屑' + extra, 'special');
    persist();
  }

  // ---- 仙盟 ----

  async function guildLoad() {
    try {
      WORLD.guild = await worldFetch('/api/guild');
      renderGuild();
    } catch (e) {
      $('guildBox').innerHTML = '<p class="hint">加载失败：' + esc(e.message) + '</p>';
    }
  }

  async function guildListLoad() {
    try {
      WORLD.guildList = await worldFetch('/api/guild/list');
      if (WORLD.guild && !WORLD.guild.guild) renderGuild();
    } catch (e) { /* 名录失败不阻塞主面板 */ }
  }

  function renderGuild() {
    const g = WORLD.guild && WORLD.guild.guild;
    if (!g) {
      const list = (WORLD.guildList && WORLD.guildList.list) || [];
      $('guildBox').innerHTML =
        '<p class="hint">立盟需境界「化神」· ' + fmt(GUILD_CREATE_COST) + ' 灵石 + ' +
        fmt(GUILD_CREATE_EXP_COST) + ' 修为，每盟至多 ' +
        ((WORLD.guildList && WORLD.guildList.list[0] && WORLD.guildList.list[0].cap) || 30) +
        ' 员；基金阶梯升级——首次 20 万，之后每级 +20 万，每级全局收益 +0.5%。</p>' +
        '<div class="guild-row-input"><input id="guildName" maxlength="8" placeholder="盟名（2-8 字）" autocomplete="off">' +
        '<button class="btn primary" data-act="guildCreate">立盟</button></div>' +
        '<p class="side-title">仙盟名录</p>' +
        (list.map((it) =>
          '<div class="guild-row"><span class="nm">' + esc(it.name) + ' <i class="gd">Lv.' + it.level + '</i></span>' +
          '<span class="pw">' + it.members + ' 员 · 基金 ' + fmt(it.fund) + '</span>' +
          '<button class="btn tiny" data-act="guildJoin" data-id="' + it.id + '">入盟</button></div>'
        ).join('') || '<p class="hint">天下尚无仙盟，你来开先河。</p>');
      return;
    }
    const leader = g.isLeader;
    const boss = g.boss;
    const pct = boss.maxHp > 0 ? Math.max(0, Math.min(100, (boss.hp / boss.maxHp) * 100)) : 0;
    const fmtReward = (r) => fmt(r.stones) + ' 灵石 +' + r.contribution + ' 贡献';
    // 同门互助状态块（传功 / 赠礼权益在服务端，领取按钮走 guildAidCollect）
    const aid = g.aid || { skillGiven: false, giftGiven: false, from: null };
    const aidBlock =
      '<div class="guild-row"><span class="nm">传功：双方 +' + fmt(AID_SKILL.stones) +
      ' 灵石 + 修为 · 赠礼：双方 +' + AID_GIFT.dust + ' 碎屑</span>' +
      '<span class="pw">' + (aid.skillGiven ? '已传功' : '未传功') + ' · ' +
        (aid.giftGiven ? '已赠礼' : '未赠礼') + '</span></div>' +
      (aid.from
        ? '<div class="guild-row"><span class="nm">' +
            (aid.from.type === 'skill' ? '「' + esc(aid.from.name) + '」向你传功' : '「' + esc(aid.from.name) + '」向你赠礼') +
          '</span><span class="pw"><button class="btn tiny" data-act="guildAidCollect">领取</button></span></div>'
        : '');
    $('guildBox').innerHTML =
      '<div class="guild-head"><b>' + esc(g.name) + '</b><span>Lv.' + g.level + ' · 基金 ' + fmt(g.fund) +
      (g.level < 10 ? ' · 下级基金 ' + fmt(guildFundNeed(g.level + 1)) : '') +
      ' · ' + g.members.length + '/' + g.memberCap + ' 员 · 我的贡献 ' + fmt(g.myContribution) + '</span></div>' +
      '<p class="hint">公告：' + (g.notice ? esc(g.notice) : '（暂无）') + '</p>' +
      (leader
        ? '<div class="guild-row-input"><input id="guildNotice" maxlength="120" placeholder="发布盟主公告" autocomplete="off">' +
          '<button class="btn tiny" data-act="guildNotice">发布</button></div>'
        : '') +
      '<p class="side-title">仙盟任务 <span class="count">完成后每日各领一次</span></p>' +
      g.tasks.map((t) =>
        '<div class="guild-row"><span class="nm">' + esc(t.name) +
        ' <i class="gd">' + (t.progress >= t.target ? '已完成' : esc(t.desc)) + '</i></span>' +
        '<span class="pw">' + fmt(t.progress) + ' / ' + fmt(t.target) + ' · ' + fmtReward(t.reward) + '</span>' +
        (t.claimed
          ? '<button class="btn tiny" disabled>已领</button>'
          : '<button class="btn tiny" data-act="guildTask" data-id="' + esc(t.id) + '"' +
            (t.progress >= t.target ? '' : ' disabled') + '>领取</button>') +
        '</div>').join('') +
      '<p class="side-title">盟主妖王 <span class="count" id="guildBossName">' + esc(boss.name) + '</span></p>' +
      '<div class="bar"><div class="bar-fill" id="guildBossBarFill"></div></div>' +
      '<p class="hint" id="guildBossText">—</p>' +
      '<button class="btn wide primary" data-act="guildBossAttack">出手攻妖</button>' +
      '<p class="hint" id="guildBossMy">—</p>' +
      '<p class="side-title">贡献商店 <span class="count">捐献与攻妖得贡献</span></p>' +
      g.shop.map((it) =>
        '<div class="guild-row"><span class="nm">' + esc(it.name) +
        ' <i class="gd">' + it.cost + ' 贡献</i></span>' +
        '<span class="pw">今日 ' + it.bought + ' / ' + it.times + '</span>' +
        '<button class="btn tiny" data-act="guildShop" data-id="' + esc(it.id) + '"' +
        (it.bought >= it.times ? ' disabled' : '') + '>购买</button></div>').join('') +
      '<p class="side-title">捐献 <span class="count">每日上限 ' + fmt(100000) + ' 灵石 · 每 2000 得 1 贡献</span></p>' +
      '<div class="guild-row-input"><input id="guildDonate" placeholder="灵石数额" autocomplete="off">' +
      '<button class="btn primary" data-act="guildDonate">捐献</button></div>' +
      '<p class="side-title">同门互助 <span class="count">传功 / 赠礼 · 每日各一次</span></p>' +
      aidBlock +
      '<p class="side-title">同门</p>' +
      g.members.filter((m) => !m.me).map((m) =>
        '<div class="guild-row"><span class="nm">' + esc(m.name) +
        (m.role === 'leader' ? ' <i class="gd">盟主</i>' : '') + '</span>' +
        '<span class="pw">战力 ' + fmt(m.power) + ' · 贡献 ' + fmt(m.contribution) + '</span>' +
        '<span class="pw">' +
          '<button class="btn tiny" data-act="guildAid" data-aid-type="skill" data-id="' + m.id + '"' +
            (g.aid && g.aid.skillGiven ? ' disabled' : '') + '>传功</button> ' +
          '<button class="btn tiny" data-act="guildAid" data-aid-type="gift" data-id="' + m.id + '"' +
            (g.aid && g.aid.giftGiven ? ' disabled' : '') + '>赠礼</button>' +
        '</span>' +
        (leader && m.role !== 'leader'
          ? '<button class="btn tiny ghost" data-act="guildKick" data-id="' + m.id + '">移出</button>'
          : '') +
        '</div>').join('') +
      '<button class="btn wide ghost" data-act="guildLeave">退盟' +
      (leader ? '（盟位转交最早入盟者，贡献清零）' : '（贡献清零）') + '</button>';
    // 妖王血条与状态（JS 设宽，CSP 不许内联样式）
    $('guildBossBarFill').style.width = pct.toFixed(1) + '%';
    $('guildBossText').textContent = boss.defeated
      ? '今日妖王已被同门讨平！明日再战。'
      : '剩余气血 ' + fmt(boss.hp) + ' / ' + fmt(boss.maxHp) + '（' + pct.toFixed(1) + '%）· 每日 ' + boss.cap + ' 场';
    $('guildBossMy').textContent =
      '今日 ' + boss.myHits + ' / ' + boss.cap + ' 场 · 我共造成 ' + fmt(boss.myDamage) + ' 伤害' +
      (state.guildBoss.claimed === boss.day && boss.myDamage > 0 ? ' · 讨伐奖励已领' : '');
    const attackBtn = document.querySelector('#guildBox button[data-act="guildBossAttack"]');
    if (attackBtn) {
      attackBtn.disabled = boss.defeated || boss.myHits >= boss.cap;
      attackBtn.textContent = boss.defeated ? '妖王已伏诛' : (boss.myHits >= boss.cap ? '今日已打满' : '出手攻妖');
    }
    guildBossMaybeClaim();
  }

  function guildRefresh() {
    guildLoad();
    guildListLoad();
  }

  async function guildCreate() {
    const input = $('guildName');
    const name = ((input && input.value) || '').trim();
    if (!name) { floatText('先想好盟名', '#f87171'); return; }
    if (state.realm < GUILD_CREATE_REALM) {
      floatText('立盟需境界「化神」', '#f87171');
      return;
    }
    if (state.exp < GUILD_CREATE_EXP_COST) {
      floatText('立盟需 ' + fmt(GUILD_CREATE_EXP_COST) + ' 修为', '#f87171');
      return;
    }
    if (state.stones < GUILD_CREATE_COST) {
      floatText('立盟需 ' + fmt(GUILD_CREATE_COST) + ' 灵石', '#f87171');
      return;
    }
    try {
      const out = await worldFetch('/api/guild/create', { method: 'POST', body: JSON.stringify({ name }) });
      state.stones -= GUILD_CREATE_COST;
      state.exp -= GUILD_CREATE_EXP_COST;
      WORLD.guild = { guild: out.guild };
      pushLog('仙盟「' + out.guild.name + '」立！广纳同门吧。', 'special');
      chime([523, 659, 784]);
      persist();
      guildRefresh();
    } catch (e) {
      floatText(e.message, '#f87171');
    }
  }

  async function guildJoin(id) {
    try {
      const out = await worldFetch('/api/guild/join', { method: 'POST', body: JSON.stringify({ id }) });
      WORLD.guild = { guild: out.guild };
      pushLog('加入仙盟「' + out.guild.name + '」，共享基金加成。', 'special');
      chime([523, 659]);
      guildRefresh();
    } catch (e) {
      floatText(e.message, '#f87171');
    }
  }

  async function guildLeave() {
    const g = WORLD.guild && WORLD.guild.guild;
    if (!g) return;
    if (!confirm('确定退出「' + g.name + '」？' + (g.isLeader ? '盟位将转交最早入盟的同门。' : ''))) return;
    try {
      await worldFetch('/api/guild/leave', { method: 'POST', body: JSON.stringify({}) });
      WORLD.guild = { guild: null };
      pushLog('已退出仙盟「' + g.name + '」。', 'sys');
      guildRefresh();
    } catch (e) {
      floatText(e.message, '#f87171');
    }
  }

  async function guildKick(id) {
    const m = ((WORLD.guild || {}).guild || {}).members?.find((x) => x.id === id);
    if (!confirm('确定将同门「' + (m ? m.name : '该成员') + '」移出仙盟？此操作不可撤销。')) return;
    try {
      const out = await worldFetch('/api/guild/kick', { method: 'POST', body: JSON.stringify({ userId: id }) });
      WORLD.guild = { guild: out.guild };
      renderGuild();
    } catch (e) {
      floatText(e.message, '#f87171');
    }
  }

  async function guildNoticeSet() {
    const input = $('guildNotice');
    const text = ((input && input.value) || '').trim();
    if (!text) { floatText('公告不能为空', '#f87171'); return; }
    try {
      const out = await worldFetch('/api/guild/notice', { method: 'POST', body: JSON.stringify({ text }) });
      if (WORLD.guild && WORLD.guild.guild) WORLD.guild.guild.notice = out.notice;
      renderGuild();
      floatText('公告已发布', '#facc15');
    } catch (e) {
      floatText(e.message, '#f87171');
    }
  }

  // 捐献/传功/赠礼带在途锁：双击连发两个请求会被服务端都受理（捐献双倍扣款），
  // 或第二个被日限拒绝弹红字（2026-11-01 修，比照 arenaBusy/gBossBusy 口径）
  let guildDonateBusy = false;
  async function guildDonate() {
    if (guildDonateBusy) return;
    const input = $('guildDonate');
    const amount = Math.floor(Number(input && input.value));
    if (!Number.isFinite(amount) || amount <= 0) { floatText('输入有效数额', '#f87171'); return; }
    if (state.stones < amount) { floatText('灵石不足', '#f87171'); return; }
    guildDonateBusy = true;
    try {
      const out = await worldFetch('/api/guild/donate', { method: 'POST', body: JSON.stringify({ amount }) });
      state.stones -= out.accepted;
      if (WORLD.guild && WORLD.guild.guild) {
        WORLD.guild.guild.fund = out.fund;
        WORLD.guild.guild.level = out.level;
        WORLD.guild.guild.myContribution = out.contribution;
      }
      pushLog('为仙盟捐献 ' + fmt(out.accepted) + ' 灵石，基金升至 ' + fmt(out.fund) + '（Lv.' + out.level + '），贡献 +' + fmt(Math.floor(out.accepted / 2000)), 'sys');
      floatText('+' + fmt(out.accepted) + ' 基金', '#facc15');
      if (input) input.value = '';
      persist();
      guildLoad(); // 顺带刷新盟任务进度
    } catch (e) {
      floatText(e.message, '#f87171');
    } finally {
      guildDonateBusy = false;
    }
  }

  // ---- 盟主妖王 ----

  // 盟妖王战力同世界妖王口径：血池开方伸缩，120 回合伤害竞速
  async function guildBossAttack() {
    const g = WORLD.guild && WORLD.guild.guild;
    if (!g || WORLD.gBossBusy) return;
    const b = g.boss;
    if (!b || b.defeated || b.myHits >= b.cap) return;
    WORLD.gBossBusy = true;
    try {
      const meNow = playerCombatStats();
      const sim = simulateBattle(combatSnapOf(meNow), guildBossEnemyOf(b.maxHp));
      showBattlePopup({
        name: b.name, icon: '',
        kicker: '盟主妖王 · 今日 ' + b.myHits + '/' + b.cap,
        hp: b.maxHp,
        avatarSvg: monsterImgOf(b.name)
          ? monsterImgWrap(monsterImgOf(b.name), MONSTER_ART.yaowang('#e88b5e'))
          : MONSTER_ART.yaowang('#e88b5e'),
        closeText: '离开', // 产出贡献与伤害入池，结算在仙盟面板
      }, sim, { title: '盟主妖王', playerHp: meNow.hp });
      const out = await worldFetch('/api/guild/boss/hit', {
        method: 'POST', body: JSON.stringify({ damage: sim.dealt }),
      });
      Object.assign(b, {
        hp: out.hp, defeated: out.defeated, myDamage: out.myDamage,
        myHits: out.myHits, killer: out.killer,
      });
      g.myContribution = out.contribution;
      pushLog('攻「' + b.name + '」，一场造成 ' + fmt(out.dealt) + ' 伤害，贡献 +' + fmt(Math.floor(out.dealt / 5000)), 'sys');
      if (out.defeated) {
        chime([523, 659, 784, 1046]);
        guildBossMaybeClaim();
      }
      guildLoad(); // 顺带刷新盟任务进度
    } catch (e) {
      floatText(e.message, '#f87171');
    }
    WORLD.gBossBusy = false;
  }

  function guildBossEnemyOf(maxHp) {
    const s = Math.sqrt(maxHp || 1);
    return { hp: 1e15, atk: s * 0.5, def: s * 0.04, crit: 0.05, critMult: 2, lifesteal: 0, dr: 0, pierce: 0 };
  }

  // 讨平奖励：有战功者每日一份（伤害越高越多，结击者加倍）；贡献由服务端按伤害结算
  function guildBossMaybeClaim() {
    const g = WORLD.guild && WORLD.guild.guild;
    if (!g || !g.boss || !g.boss.defeated || !(g.boss.myDamage > 0)) return;
    const b = g.boss;
    if (state.guildBoss.claimed === b.day) return;
    let stones = Math.min(80000, 4000 + Math.floor(b.myDamage / 40));
    let dust = Math.min(1500, 10 + Math.floor(b.myDamage / 4000));
    let extra = '';
    if (b.killer === 'me') {
      stones *= 2;
      extra = '（致命一击加倍）';
    }
    stones = addStones(stones);
    dust = addDust(dust);
    state.guildBoss.claimed = b.day;
    pushLog('盟讨平「' + b.name + '」！+' + fmt(stones) + ' 灵石 · +' + fmt(dust) + ' 碎屑' + extra, 'special');
    persist();
  }

  // ---- 盟任务领取 / 贡献商店 ----

  const guildTaskBusy = {};
  async function guildTaskClaim(taskId) {
    if (guildTaskBusy[taskId]) return; // 连点防抖：同一任务在途请求只放行一次
    guildTaskBusy[taskId] = true;
    const g = WORLD.guild && WORLD.guild.guild;
    const task = (g && g.tasks.find((x) => x.id === taskId)) || null;
    const taskName = task ? task.name : taskId;
    try {
      const out = await worldFetch('/api/guild/task/claim', {
        method: 'POST', body: JSON.stringify({ taskId }),
      });
      addStones(out.stones);
      if (g) {
        g.myContribution = out.contribution;
        if (task) task.claimed = true;
      }
      pushLog('盟任务「' + taskName + '」达成：+' + fmt(out.stones) + ' 灵石，贡献 +' +
        (task && task.reward ? task.reward.contribution : 25), 'special');
      chime([660, 880]);
      persist();
      guildLoad();
    } catch (e) {
      if (e && e.status === 409) {
        // 409 = 今日已领取（连点竞态 / 多端先领）：不算错误，本地对账刷新即可
        if (g && task) task.claimed = true;
        renderGuild();
        guildLoad();
        floatText('该任务今日已领取', '#9aa4b2');
      } else {
        floatText(e.message, '#f87171');
      }
    }
    guildTaskBusy[taskId] = false;
  }

  const GUILD_SHOP_REWARD_TEXT = {
    stones: '灵石', dust: '碎屑', coupon: '洗练券', talisman: '护体符', tickets: '招募券',
  };

  // 同门互助：传功（双方各 300 万灵石 + 境界缩放修为）/ 赠礼（双方各 20 碎屑），每日各一次
  const guildAidBusy = {};
  async function guildAid(type, targetId) {
    const busyKey = type + ':' + targetId;
    if (guildAidBusy[busyKey]) return;
    guildAidBusy[busyKey] = true;
    try {
      const out = await worldFetch('/api/guild/aid', {
        method: 'POST', body: JSON.stringify({ type, targetId }),
      });
      if (WORLD.guild) WORLD.guild.guild = out.guild;
      if (type === 'skill') {
        const gained = addStones(AID_SKILL.stones);
        grantExpK(AID_SKILL.expK, '传功同道');
        pushLog('已向同门传功：+' + fmt(gained) + ' 灵石（对方同样受益）', 'special');
        chime([659, 988]);
      } else {
        addDust(AID_GIFT.dust);
        pushLog('已向同门赠礼：+' + AID_GIFT.dust + ' 碎屑（对方同样受益）', 'special');
        chime([523, 659]);
      }
      persist();
      renderGuild();
    } catch (e) {
      floatText(e.message, '#f87171');
    } finally {
      guildAidBusy[busyKey] = false;
    }
  }

  async function guildAidCollect() {
    try {
      const out = await worldFetch('/api/guild/aid/collect', { method: 'POST', body: '{}' });
      if (out.type === 'skill') {
        const gained = addStones(AID_SKILL.stones);
        grantExpK(AID_SKILL.expK, '受同门传功');
        pushLog('受「' + out.name + '」传功：+' + fmt(gained) + ' 灵石', 'special');
        chime([659, 988]);
      } else {
        addDust(AID_GIFT.dust);
        pushLog('收「' + out.name + '」赠礼：+' + AID_GIFT.dust + ' 碎屑', 'special');
        chime([523, 659]);
      }
      persist();
      renderGuild();
    } catch (e) {
      floatText(e.message, '#f87171');
    }
  }

  async function guildShopBuy(itemId) {
    try {
      const out = await worldFetch('/api/guild/shop/buy', {
        method: 'POST', body: JSON.stringify({ itemId }),
      });
      const r = out.reward;
      if (r.stones) addStones(r.stones);
      if (r.dust) addDust(r.dust);
      if (r.petTickets) state.petTickets += r.petTickets;
      if (r.rerollCoupon) state.rerollCoupon += r.rerollCoupon;
      if (r.talismans) state.talismans += r.talismans;
      const g = WORLD.guild && WORLD.guild.guild;
      if (g) {
        g.myContribution = out.contribution;
        const it = g.shop.find((x) => x.id === itemId);
        if (it) it.bought = out.bought;
      }
      const label = Object.keys(r).map((k) => '+' + fmt(r[k]) + (GUILD_SHOP_REWARD_TEXT[k] || k)).join(' · ');
      pushLog('贡献商店兑换「' + (GUILD_SHOP_REWARD_TEXT[itemId] || itemId) + '」：' + label, 'special');
      chime([660, 880]);
      persist();
      guildLoad();
    } catch (e) {
      floatText(e.message, '#f87171');
    }
  }

  /* ---------------- 事件 ---------------- */

  function updateMute() {
    $('muteBtn').textContent = '音效：' + (state.muted ? '关' : '开');
  }

  function useBagToken() {
    if (!(state.bagTokens > 0)) { floatText('没有扩容符', '#f87171'); return; }
    bagDirty = true; // 用符只改容量/符数、不动背包内容，不置脏 paintBag 会提前返回
    if (state.bagExtra >= BAG_EXTRA_MAX) {
      floatText('已达 300 格上限', '#f87171');
      paintBag(true); // 刷新按钮隐藏态
      return;
    }
    state.bagTokens--;
    state.bagExtra = Math.min(BAG_EXTRA_MAX, (state.bagExtra || 0) + BAG_EXPAND_PER);
    pushLog('使用「乾坤扩容符」：背包扩至 ' + bagCap() + ' 格（剩 ' + state.bagTokens + ' 张）', 'special');
    chime([523, 659, 784]);
    persist();
    paintBag(true);
  }

  // 「乾坤扩容符」掉落：各种活动中极低概率（调概率只动这三个数）
  const BAG_TOKEN_CHANCE = { box: 1 / 15000, battle: 1 / 3500, rogue: 1 / 2000 };
  function rollBagToken(kind) {
    if (Math.random() >= BAG_TOKEN_CHANCE[kind]) return;
    state.bagTokens = Math.min(99, state.bagTokens + 1);
    bagDirty = true; // 按钮显隐/文案随符数变化，不置脏 paintBag 不重绘（与 useBagToken 同因）
    pushLog('拾得「乾坤扩容符」！背包面板可使用（+20 格）', 'special');
    chime([784, 988, 1318]);
  }

  // 顶部物资条（战力 / 灵石 / 飞升，realm-badge 同款样式）：随渲染节流刷新
  let resStonesSig = '';
  function paintResources() {
    $('resPower').textContent = fmt(realPower());
    if (state.stones !== resStonesSig) {
      resStonesSig = state.stones;
      $('resStones').textContent = fmt(state.stones);
    }
    // 顶栏资源行：碎屑 / 器魂 / 招募券 / 洗练券（随渲染节流刷新）
    $('resDust').textContent = fmt(state.dust);
    $('resSouls').textContent = fmt(state.souls);
    $('resTickets').textContent = fmt(state.petTickets);
    $('resReroll').textContent = fmt(state.rerollCoupon);
    const asc = Math.max(0, state.ascensions | 0);
    $('ascBadge').classList.toggle('hidden', asc <= 0);
    if (asc > 0) $('resAsc').textContent = '+' + asc;
  }

  // ---- 设置：字号（body zoom，85%–125%）与主题（明/暗） ----

  const FONT_MIN = 0.85, FONT_MAX = 1.25, FONT_STEP = 0.05;

  function applyFontScale() {
    const v = Math.max(FONT_MIN, Math.min(FONT_MAX, state.fontScale || 1));
    state.fontScale = v;
    document.body.style.zoom = String(v);
    const label = $('fontScaleLabel');
    if (label) label.textContent = Math.round(v * 100) + '%';
  }

  function nudgeFontScale(dir) {
    state.fontScale = Math.max(FONT_MIN, Math.min(FONT_MAX, (state.fontScale || 1) + dir * FONT_STEP));
    applyFontScale();
    floatText('字号 ' + Math.round(state.fontScale * 100) + '%', '#f0d9a8');
    save();
  }

  // 剧情角色名配色按主题加深（2026-10-31）：STORY_CAST 色板为暗底调校，
  // 浅金/浅蓝系内联色在亮色纸底不可读；乘法压暗保留各角色色相，暗色主题原样使用。
  let storyNameRawColor = '';
  // 明色主题下把暗底调校的强调色统一压暗（×0.6）：CSP 拦内联 style，
  // data-c / 故事名这类经 CSSOM 落地的内联色无法被 CSS 主题覆盖，必须 JS 折算
  function themeInk(color) {
    if (state.theme !== 'light' || !color || color[0] !== '#') return color;
    const hex = color.length === 4
      ? '#' + color[1] + color[1] + color[2] + color[2] + color[3] + color[3]
      : color;
    const n = parseInt(hex.slice(1), 16);
    const f = 0.6;
    const r = Math.round(((n >> 16) & 255) * f);
    const g = Math.round(((n >> 8) & 255) * f);
    const b = Math.round((n & 255) * f);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  function applyStoryNameColor(color) {
    storyNameRawColor = color || '';
    const el = $('storyName');
    if (el) el.style.color = themeInk(color) || '';
  }

  function applyTheme() {
    document.body.classList.toggle('theme-light', state.theme === 'light');
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute('content', state.theme === 'light' ? '#ccd2c0' : '#101614');
    // 主题提示键：正题在云端档里，这里只留一个非存档的本地 hint 供 theme-boot 防首帧闪烁
    try { localStorage.setItem(THEME_KEY, state.theme === 'light' ? 'light' : 'dark'); } catch (e) { /* 忽略 */ }
    if (storyNameRawColor) applyStoryNameColor(storyNameRawColor);
    const sun = $('themeIconSun'), moon = $('themeIconMoon');
    if (sun && moon) {
      const light = state.theme === 'light';
      sun.style.display = light ? 'none' : '';
      moon.style.display = light ? '' : 'none';
    }
    const dark = $('themeDark'), light = $('themeLight');
    if (dark && light) {
      dark.classList.toggle('primary', state.theme !== 'light');
      light.classList.toggle('primary', state.theme === 'light');
    }
  }

  function setTheme(theme) {
    state.theme = theme === 'light' ? 'light' : 'dark';
    state.themeSet = true;   // 主动选过，此后不再参与「默认亮色」迁移
    applyTheme();
    floatText(state.theme === 'light' ? '明色主题' : '暗色主题', '#f0d9a8');
    save();
  }

  // 功能页序列（滑动切页 / 点标签的方向动画共用）：左右滑动按此顺序翻页
  const SWIPE_TABS = ['equip', 'richang', 'zhan', 'xiu', 'gushi', 'world', 'xian'];

  // 目标页相对当前页的方向：'next' | 'prev' | undefined（同页不动画）
  function pageDir(name) {
    const cur = document.querySelector('.tab-page.active');
    const from = SWIPE_TABS.indexOf(cur ? cur.dataset.page : '');
    const to = SWIPE_TABS.indexOf(name);
    return to > from ? 'next' : to < from ? 'prev' : undefined;
  }

  // 顶部功能标签：修炼 / 征战 / 闲趣
  // dir = 'next' | 'prev'：给新激活页加方向平移淡入（滑动与点标签共用）；缺省不动画（首屏）
  function setTopTab(name, dir) {
    document.querySelectorAll('#topTabs .top-tab').forEach((btn) =>
      btn.classList.toggle('active', btn.dataset.tab === name));
    document.querySelectorAll('.tab-page').forEach((page) => {
      const on = page.dataset.page === name;
      page.classList.remove('slide-next', 'slide-prev');
      page.classList.toggle('active', on);
      if (on && dir) {
        void page.offsetWidth; // 先移类再强排，连续切页也能重新触发动画
        page.classList.add(dir === 'next' ? 'slide-next' : 'slide-prev');
      }
    });
  }

  function bind() {
    $('topTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.top-tab');
      if (!btn) return;
      setTopTab(btn.dataset.tab, pageDir(btn.dataset.tab));
      if (btn.dataset.tab === 'world') worldActivate();
    });

    // 天下页：排行刷新 / 竞技场切磋 / 妖王出手 / 仙盟（列表内按钮走委托）
    $('rankRefresh').addEventListener('click', loadRank);
    // 战力榜点名字查装备：事件委托 + 查验弹层开关
    $('rankList').addEventListener('click', (e) => {
      const el = e.target.closest('[data-inspect]');
      if (el) inspectPlayer(Number(el.dataset.inspect));
    });
    $('inspectBtn').addEventListener('click', () => $('inspectModal').classList.remove('show'));
    // 查看装备：仅按钮关闭（2026-11-01 用户指定：除设置外弹窗一律禁点遮罩关闭）
    // 怪物图鉴：点名称弹详情，仅按钮关闭
    $('bestiaryList').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-beast]');
      if (!chip) return;
      openBeast(chip.dataset.beast);
    });
    $('beastCloseBtn').addEventListener('click', () => $('beastModal').classList.remove('show'));
    // 新手教程的「直达修行指南」提示行：关弹层并滚到修炼页指南面板
    $('guideModal').addEventListener('click', (e) => {
      if (e.target.id !== 'guideTipJump') return;
      guideClose();
      const panel = document.querySelector('.panel.guide');
      if (panel) panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    // 设置页：随时回看新手教程
    $('replayTutorial').addEventListener('click', () => {
      enqueueFirstTimeTutorial();
      floatText('玩法指南已打开', '#d8b36a');
    });
    // 整体玩法说明弹层：按钮开、✕/知道了关（2026-11-01 起禁点遮罩关闭）
    $('gameplayGuideBtn').addEventListener('click', () => $('helpModal').classList.add('show'));
    $('helpClose').addEventListener('click', () => $('helpModal').classList.remove('show'));
    // 资源图例（图标:名称）注入玩法说明：图标与 RES_ICONS 同源，图标更新自动同步；
    // 一次性构建（幂等防重复插入），插在「核心循环」一节之后
    (() => {
      const helpBody = document.querySelector('#helpModal .help-body');
      if (!helpBody || helpBody.querySelector('.res-legend')) return;
      const RES_LEGEND = [
        ['stones', '灵石'], ['exp', '修为'], ['dust', '碎屑'], ['souls', '器魂'],
        ['petTickets', '招募券'], ['rerollCoupon', '洗练券'], ['talismans', '护体符'],
        ['towerMarks', '塔印'], ['warMerits', '战功'], ['beastBones', '兽骨'],
      ];
      const sec = document.createElement('div');
      sec.className = 'res-legend';
      sec.innerHTML = '<h3>资源图例</h3><div class="res-legend-list">' +
        RES_LEGEND.map(([k, n]) => '<span class="res-legend-item">' + resIcon(k) + n + '</span>').join('') +
        '</div>';
      const h3s = [...helpBody.querySelectorAll('h3')];
      const core = h3s.find((h) => h.textContent.indexOf('核心循环') >= 0);
      helpBody.insertBefore(sec, core && core.nextElementSibling ? core.nextElementSibling.nextElementSibling : null);
    })();
    // 顶栏明暗切换：点按在亮/暗之间来回
    $('themeToggleBtn').addEventListener('click', () => {
      state.theme = state.theme === 'light' ? 'dark' : 'light';
      state.themeSet = true;   // 主动选过，此后不再参与「默认亮色」迁移
      applyTheme();
      save();
    });
    // 设置弹层：顶栏齿轮开，✕/遮罩关
    $('setOpenBtn').addEventListener('click', () => $('setModal').classList.add('show'));
    $('setCloseBtn').addEventListener('click', () => $('setModal').classList.remove('show'));
    $('setModal').addEventListener('click', (e) => {
      if (e.target === $('setModal')) $('setModal').classList.remove('show');
    });
    $('mapBuyBtn').addEventListener('click', buyMapAp);
    $('wanderGo').addEventListener('click', () => {
      setTopTab('xian', pageDir('xian'));
      const panel = document.querySelector('.panel.wander');
      if (panel) panel.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    $('arenaBuy').addEventListener('click', arenaBuy);
    $('arenaRefresh').addEventListener('click', arenaRefresh);
    $('fishBaitBtn').addEventListener('click', buyBait);
    $('arenaOpps').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act="arena"]');
      if (btn) arenaFight(Number(btn.dataset.id));
    });
    $('bossAttack').addEventListener('click', bossAttack);
    $('guildBox').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = Number(btn.dataset.id);
      const act = btn.dataset.act;
      if (act === 'guildCreate') guildCreate();
      else if (act === 'guildJoin') guildJoin(id);
      else if (act === 'guildNotice') guildNoticeSet();
      else if (act === 'guildDonate') guildDonate();
      else if (act === 'guildKick') guildKick(id);
      else if (act === 'guildLeave') guildLeave();
      else if (act === 'guildBossAttack') guildBossAttack();
      else if (act === 'guildTask') guildTaskClaim(btn.dataset.id);
      else if (act === 'guildShop') guildShopBuy(btn.dataset.id);
      else if (act === 'guildAid') guildAid(btn.dataset.aidType, id);
      else if (act === 'guildAidCollect') guildAidCollect();
    });
    $('bagExpandBtn').addEventListener('click', useBagToken);
    $('displayNameBtn').addEventListener('click', setDisplayName);
    $('guideBtn').addEventListener('click', guideClose);
    $('displayNameInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') setDisplayName();
    });

    // 设置页：字号 / 主题
    $('fontMinus').addEventListener('click', () => nudgeFontScale(-1));
    $('fontPlus').addEventListener('click', () => nudgeFontScale(1));
    $('fontReset').addEventListener('click', () => { state.fontScale = 1; applyFontScale(); save(); });
    $('themeDark').addEventListener('click', () => setTheme('dark'));
    $('themeLight').addEventListener('click', () => setTheme('light'));


    $('boxBtn').addEventListener('click', () => manualOpen(1));
    $('open1').addEventListener('click', () => manualOpen(1));
    $('open10').addEventListener('click', () => {
      if (needAscension()) { floatText('飞升一次后才能连开十次', '#f87171'); return; }
      manualOpen(10);
    });

    $('buySpeed').addEventListener('click', () => buy('speed'));
    $('buyGain').addEventListener('click', () => buy('gain'));
    $('buyLuck').addEventListener('click', () => buy('luck'));

    $('breakBtn').addEventListener('click', breakthrough);
    $('ascendBtn').addEventListener('click', ascend);

    // 点击「境界」标题：展开 / 收起境界清单（高亮当前境界）
    $('realmTitle').addEventListener('click', () => {
      const list = $('realmList');
      list.classList.toggle('hidden');
      $('realmToggle').textContent = list.classList.contains('hidden') ? '▸' : '▾';
      renderRealmList();
    });

    $('equipGrid').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      const slot = btn.dataset.slot;
      if (act === 'enhance') enhanceSlot(slot);
      else if (act === 'unequip') unequipSlot(slot);
      else if (act === 'forge') openForge(slot);
    });

    $('bagList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = Number(btn.dataset.id);
      if (!id) return;
      if (btn.dataset.act === 'wear') equipItem(id);
      else if (btn.dataset.act === 'salvage') salvageItem(id, false);
      else if (btn.dataset.act === 'seal') sealItem(id);
    });

    $('autoEquip').addEventListener('click', () => autoEquip(false)); // 直传会把 MouseEvent 当 silent
    $('salvageLow').addEventListener('click', salvageLow);
    $('salvageAll').addEventListener('click', salvageAll);

    $('bagSortRow').addEventListener('click', (e) => {
      const chip = e.target.closest('.bag-chip');
      if (!chip) return;
      bagSort = chip.dataset.sort;
      for (const el of document.querySelectorAll('#bagSortRow .bag-chip')) {
        el.classList.toggle('active', el.dataset.sort === bagSort);
      }
      bagDirty = true;
      paintBag(true);
    });

    $('bagFilterRow').addEventListener('click', (e) => {
      const chip = e.target.closest('.bag-chip');
      if (!chip) return;
      bagFilter = chip.dataset.slot;
      for (const el of document.querySelectorAll('#bagFilterRow .bag-chip')) {
        el.classList.toggle('active', el.dataset.slot === bagFilter);
      }
      bagDirty = true;
      paintBag(true);
    });

    document.querySelector('.combat-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.combat-tab');
      if (!tab) return;
      setUiMode(tab.dataset.mode);
    });

    $('combatBtn').addEventListener('click', () => doBattle(uiMode));

    $('autoBtn').addEventListener('click', () => {
      if (!unlockedMode(uiMode)) return;
      if (needAscension()) {
        floatText('飞升一次后才能开启自动战斗', '#f87171');
        return;
      }
      state.autoHunt = !state.autoHunt;
      huntAcc = 0; // 首场也吃 1 分钟间隔：开启后由主循环节奏发起，连点开关不产生额外战斗
      combatDirty = true;
      save();
      renderCombat();
      floatText((uiMode === 'wild' ? '自动巡猎' : '连续挑战') + (state.autoHunt ? '开启' : '关闭'), '#d8b36a');
    });

    $('zoneStrip').addEventListener('click', (e) => {
      const groupBtn = e.target.closest('.zone-group');
      if (groupBtn) {
        const gi = Number(groupBtn.dataset.group);
        wildGroupOpen = (gi === wildGroupOpen) ? -1 : gi; // 点开着的标签收起、回到跟随当前关
        renderCombat();
        return;
      }
      const chip = e.target.closest('.zone-chip');
      if (!chip || chip.disabled) return;
      selectWildZone(Number(chip.dataset.zone));
    });

    // 扫荡（2026-10-31）：闯关/爬塔选已通关卡片 + 扫荡按钮
    $('sweepBtn').addEventListener('click', sweepBattle);
    $('sweepStrip').addEventListener('click', (e) => {
      const groupBtn = e.target.closest('.zone-group');
      if (groupBtn) {
        const gi = Number(groupBtn.dataset.group);
        sweepGroupOpen = (gi === sweepGroupOpen) ? -1 : gi; // 独立于野外选区条的展开组
        renderCombat();
        return;
      }
      const chip = e.target.closest('.zone-chip[data-sweep]');
      if (!chip || chip.disabled) return;
      sweepPick[uiMode] = Number(chip.dataset.sweep);
      combatDirty = true;
      renderCombat();
    });

    $('trainingList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-train]');
      if (!btn) return;
      upgradeTraining(btn.dataset.train);
    });

    $('replayBattleBtn').addEventListener('click', replayBattleAnimation);
    bindStory();
    $('battleSkip').addEventListener('click', skipBattleAnimation);
    $('battleClose').addEventListener('click', closeBattleModal);

    $('petList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-pet]');
      if (!btn || btn.disabled) return;
      const id = btn.dataset.id;
      if (btn.dataset.pet === 'recruit') recruitPet(id);
      else if (btn.dataset.pet === 'feed') feedPet(id);
      else if (btn.dataset.pet === 'toggle') togglePet(id);
      else if (btn.dataset.pet === 'release') releasePet(id);
      else if (btn.dataset.pet === 'token') upgradeToken(id);
      else if (btn.dataset.pet === 'core') feedCore(id);
    });

    $('petSlotsBtn').addEventListener('click', unlockPetSlots);

    $('gongfaList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-gongfa]');
      if (!btn || btn.disabled) return;
      upgradeGongfa(btn.dataset.gongfa);
    });
    $('immortalBtn').addEventListener('click', enterImmortal);

    $('elixirList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-elixir]');
      if (!btn || btn.disabled) return;
      if (btn.dataset.elixir === 'craft') craftElixir(btn.dataset.id);
      else if (btn.dataset.elixir === 'herb') craftElixirHerb(btn.dataset.id);
      else if (btn.dataset.elixir === 'take') takeElixir(btn.dataset.id);
    });

    $('rogueBtn').addEventListener('click', () => {
      if (state.rogue.run) rogueFight();
      else rogueStart();
    });
    $('rogueGiveup').addEventListener('click', rogueGiveup);
    $('rogueChoices').addEventListener('click', (e) => {
      const card = e.target.closest('button[data-buff]');
      if (!card) return;
      pickRogueBuff(card.dataset.buff);
    });
    $('rogueModal').addEventListener('click', (e) => {
      if (e.target === $('rogueModal')) { /* 探幽选buff不允许点遮罩跳过 */ }
    });

    $('bossRushBtn').addEventListener('click', runBossRush);
    $('anomalyBtn').addEventListener('click', anomalyFight);
    $('trialList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-trial]');
      if (!btn || btn.disabled) return;
      runTrial(btn.dataset.trial);
    });

    // 日常扩容（灵潮 / 占卜 / 灵气 / 问答 / 朝贺）事件委托
    $('dailyExt').addEventListener('click', (e) => {
      const tide = e.target.closest('button[data-tide]');
      if (tide) {
        if (!tide.disabled) claimTide(Number(tide.dataset.tide));
        return;
      }
      if (e.target.closest('#fortuneDrawBtn')) { drawFortune(); return; }
      if (e.target.closest('#fortuneClaimBtn')) { claimFortune(); return; }
      if (e.target.closest('#vigorClaimBtn')) { claimVigor(); return; }
      if (e.target.closest('#monthMakeupBtn')) { monthMakeup(); return; }
      const quiz = e.target.closest('button[data-quiz]');
      if (quiz) {
        quizAnswer(Number(quiz.dataset.quiz));
        return;
      }
      const month = e.target.closest('button[data-month]');
      if (month) {
        if (!month.disabled) claimMonth(Number(month.dataset.month));
      }
    });
    $('quizBoxSlots').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-quizbox]');
      if (!btn) return;
      takeQuizBox(btn.dataset.quizbox);
    });

    // 问答结果弹层：仅按钮关闭（2026-11-01 起禁点遮罩关闭）
    $('quizResultBtn').addEventListener('click', () => $('quizResultModal').classList.remove('show'));

    $('marketList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-market]');
      if (!btn || btn.disabled) return;
      buyMarket(btn.dataset.market);
    });

    $('titleRow').addEventListener('click', (e) => {
      const chip = e.target.closest('button[data-title]');
      if (!chip) return;
      equipTitle(chip.dataset.title);
    });

    $('adventureModal').addEventListener('click', (e) => {
      /* 奇遇弹窗不允许点遮罩关闭（2026-10-31）：误触空白会错过奇遇，必须点弹窗按钮 */
      const btn = e.target.closest('button[data-adv]');
      if (!btn) return;
      adventureAction(btn.dataset.adv);
    });

    // 道童
    const stewardHandler = (group) => (e) => {
      const chip = e.target.closest('button[data-steward]');
      if (!chip || chip.dataset.steward !== group) return;
      const val = chip.dataset.val;
      if (group === 'autoWear') state.steward.autoWear = !state.steward.autoWear;
      else if (group === 'market') {
        const id = val;
        const arr = state.steward.autoMarket;
        state.steward.autoMarket = arr.includes(id) ? arr.filter((x) => x !== id) : arr.concat(id);
      } else state.steward[group] = Number(val);
      save();
      renderSteward();
    };
    $('stewardWear').addEventListener('click', stewardHandler('autoWear'));
    $('stewardSalvage').addEventListener('click', stewardHandler('autoSalvage'));
    $('stewardMarket').addEventListener('click', stewardHandler('market'));

    // 炼器 / 赌石 / 秘境图 / 修行 / 灵田 / 升星
    $('craftList').addEventListener('click', (e) => {
      const ore = e.target.closest('button[data-oreforge]');
      if (ore && !ore.disabled) { forgeSouls(); return; }
      const btn = e.target.closest('button[data-craft]');
      if (!btn || btn.disabled) return;
      craftItem(btn.dataset.craft);
    });

    $('meltList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-melt]');
      if (!btn || btn.disabled) return;
      meltItem(Number(btn.dataset.melt));
    });

    $('gambleBtn').addEventListener('click', () => doGamble(1));
    $('gamble10Btn').addEventListener('click', () => doGamble(10));
    $('gambleModalClose').addEventListener('click', () => $('gambleModal').classList.remove('show'));
    $('gambleModalAgain').addEventListener('click', (e) => doGamble(Number(e.target.dataset.times) || 1));

    // 秘境图事件弹层（2026-10-31）：仅按钮关闭（2026-11-01 起禁点遮罩关闭）
    $('mapEventBtn').addEventListener('click', () => $('mapEventModal').classList.remove('show'));

    $('wanderList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-wander]');
      if (!btn || btn.disabled) return;
      chooseWander(Number(btn.dataset.wander));
    });

    $('treasureBox').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-treasure]');
      if (!btn || btn.disabled) return;
      synthTreasure();
    });

    $('gatherList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-gather]');
      if (!btn || btn.disabled) return;
      const key = btn.dataset.key;
      if (btn.dataset.gather === 'collect') collectGather(key);
      else if (btn.dataset.gather === 'start') startGather(key);
      else if (btn.dataset.gather === 'up') upgradeGather(key);
    });

    $('mapGrid').addEventListener('click', (e) => {
      const tile = e.target.closest('button[data-tile]');
      if (!tile || tile.disabled) return;
      mapMove(Number(tile.dataset.tile));
    });

    $('ordealList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-ordeal]');
      if (!btn || btn.disabled) return;
      acceptOrdeal(btn.dataset.ordeal);
    });

    $('farmList').addEventListener('click', (e) => {
      const plant = e.target.closest('button[data-plant]');
      if (plant && !plant.disabled) {
        plantSeed(Number(plant.dataset.plant), plant.dataset.seed);
        return;
      }
      const harvest = e.target.closest('button[data-harvest]');
      if (harvest && !harvest.disabled) harvestPlot(Number(harvest.dataset.harvest));
    });

    $('demonBox').addEventListener('click', (e) => {
      if (e.target.closest('#demonBtn')) fightDemon();
    });

    $('bountyList').addEventListener('click', (e) => {
      const reroll = e.target.closest('button[data-bounty-reroll]');
      if (reroll && !reroll.disabled) { rerollBounty(Number(reroll.dataset.bountyReroll)); return; }
      const claim = e.target.closest('button[data-bounty-claim]');
      if (claim && !claim.disabled) claimBounty(Number(claim.dataset.bountyClaim));
    });

    $('daoList').addEventListener('click', (e) => {
      const marry = e.target.closest('button[data-dao-marry]');
      if (marry && !marry.disabled) { marryNpc(marry.dataset.daoMarry); return; }
      const gift = e.target.closest('button[data-dao-gift]');
      if (gift && !gift.disabled) {
        const parts = gift.dataset.daoGift.split(':');
        giftNpc(parts[0], parts[1]);
      }
    });

    $('tribCraft').addEventListener('click', craftTalisman);
    $('tribUse').addEventListener('click', () => {
      const m = $('tribModal');
      m.dataset.use = String(Math.min(3, Number(m.dataset.use || 0) + 1));
      renderTrib();
    });
    $('tribFight').addEventListener('click', fightTribulation);
    $('tribBtn').addEventListener('click', () => {
      if (!tribulationDue()) {
        floatText('天劫未至（三日一临）', '#9aa4b2');
        return;
      }
      $('tribModal').dataset.use = '0';
      renderTrib();
      $('tribModal').classList.add('show');
    });

    $('caveList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-cave]');
      if (!btn || btn.disabled) return;
      upgradeCave(btn.dataset.cave);
    });

    $('signInBox').addEventListener('click', (e) => {
      if (e.target.closest('#signInBtn')) signIn();
      if (e.target.closest('#signGambleBtn')) signInGamble();
    });

    $('dailyList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-daily]');
      if (!btn || btn.disabled) return;
      claimTask(btn.dataset.daily);
    });

    $('weeklyList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-weekly]');
      if (!btn || btn.disabled) return;
      claimWeekly(btn.dataset.weekly);
    });

    $('achvList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-achv]');
      if (!btn || btn.disabled) return;
      claimAchievement(btn.dataset.achv);
    });

    $('achvFilterRow').addEventListener('click', (e) => {
      const chip = e.target.closest('button[data-achv-filter]');
      if (!chip || chip.classList.contains('active')) return;
      achvFilter = chip.dataset.achvFilter;
      render();
    });

    const volSlider = $('volumeSlider');
    volSlider.value = Math.round((isFinite(state.volume) ? state.volume : 0.6) * 100);
    volSlider.addEventListener('input', () => {
      // 拖动只改内存值（input 事件每秒可达数十次，全量落盘会高频序列化整档）
      state.volume = Number(volSlider.value) / 100;
    });
    volSlider.addEventListener('change', () => {
      save();
      beep(660, 0.08);
    });
    $('battleSpeed').addEventListener('click', () => {
      const order = [1, 2, 4];
      state.battleSpeed = order[(order.indexOf(state.battleSpeed || 1) + 1) % order.length];
      $('battleSpeed').textContent = '倍速 ×' + state.battleSpeed;
      save();
    });
    // 战斗弹层：仅按钮关闭（2026-11-01 起禁点遮罩关闭，防误触丢战报）

    $('forgeModal').addEventListener('click', (e) => {
      // 工坊弹层：仅按钮关闭（2026-11-01 起禁点遮罩关闭）
      const btn = e.target.closest('button[data-act]');
      if (!btn || btn.disabled) return;
      const act = btn.dataset.act;
      // 宝石类操作走部位（forgeSlot），词条/升星/继承走穿戴件
      if (act === 'picker') {
        if (!forgeSlot) return;
        forgePickerOpen = !forgePickerOpen;
        renderForge();
        return;
      }
      if (act === 'socket' || act === 'unsocket' || act === 'fuse') {
        if (!forgeSlot) return;
        if (act === 'socket') forgeSocket(forgeSlot, btn.dataset.k, Number(btn.dataset.t));
        else if (act === 'unsocket') forgeUnsocket(forgeSlot, Number(btn.dataset.idx));
        else fuseGems(btn.dataset.k, Number(btn.dataset.t));
        return;
      }
      const it = forgeTarget();
      if (!it) return;
      if (act === 'lock') toggleForgeLock(it, Number(btn.dataset.idx));
      else if (act === 'reroll') forgeReroll(it);
      else if (act === 'inherit') doInherit(Number(btn.dataset.id));
      else if (act === 'star') feedStar(it.id, Number(btn.dataset.id));
    });
    $('forgeClose').addEventListener('click', closeForge);

    $('muteBtn').addEventListener('click', () => {
      state.muted = !state.muted;
      updateMute();
      save();
    });

    $('resetBtn').addEventListener('click', async () => {
      if (!confirm('确定重置全部进度？云端存档与账本一并清除，此操作不可撤销。')) return;
      try {
        const res = await fetch('/api/reset', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'X-Requested-With': 'fetch' },
        });
        if (!res.ok) { floatText('重置失败，请稍后再试', '#f87171'); return; }
      } catch (e) { floatText('重置失败，请稍后再试', '#f87171'); return; }
      authSignedOut = true; // 停 persist / 关页兜底 / flushCloud：reload 前不得把重置前的内存档推回云端
      cloudPending = null;
      if (cloudTimer) { clearTimeout(cloudTimer); cloudTimer = 0; }
      location.reload();  // 云端已清空，重新启动按全新档开局
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

    // 左右滑动手势切换功能页（2026-10-31）：向左滑 = 下一页（如修炼→故事），
    // 向右滑 = 上一页。只认横向主导位移（|dx|≥60px 且 ≥1.5×|dy|），不与纵向滚动
    // 和列表滑动抢手势；弹层开启 / 触点在输入控件上时不触发。桌面鼠标无此手势。
    // （2026-10-31：SWIPE_TABS 上移到 setTopTab 旁共用；切页带方向平移淡入）
    let swipeX = 0, swipeY = 0, swipeOk = false;
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { swipeOk = false; return; }
      const t = e.touches[0];
      swipeX = t.clientX;
      swipeY = t.clientY;
      swipeOk = !(e.target.closest && e.target.closest('input, textarea, select'));
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
      if (!swipeOk) return;
      swipeOk = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - swipeX;
      const dy = t.clientY - swipeY;
      if (Math.abs(dx) < 60 || Math.abs(dx) < 1.5 * Math.abs(dy)) return;
      if (document.querySelector('.modal.show')) return;
      const page = document.querySelector('.tab-page.active');
      const cur = SWIPE_TABS.indexOf(page ? page.dataset.page : '');
      const next = cur + (dx < 0 ? 1 : -1);
      if (cur < 0 || next < 0 || next >= SWIPE_TABS.length) return;
      setTopTab(SWIPE_TABS[next], dx < 0 ? 'next' : 'prev');
      if (SWIPE_TABS[next] === 'world') worldActivate();
      floatText(document.querySelector('.top-tab.active').textContent.trim(), '#f0d9a8');
    }, { passive: true });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        state.lastSeen = Date.now();
        persist();
        cloudFlushNow(); // 本地不再落盘：切后台立即用 beacon 把最新 lastSeen 推上云端（离线结算起点）
      } else {
        awardOffline();
        staminaRefresh(); // 切回前台顺带同步体力（离线恢复折算以服务端为准）
        acc = 0;
        last = performance.now();
        render();
        paintBag(true);
        save();
      }
    });

    window.addEventListener('beforeunload', () => { save(); cloudFlushNow(); });
    window.addEventListener('pagehide', () => { save(); cloudFlushNow(); });

    $('logoutBtn').addEventListener('click', async () => {
      authSignedOut = true; // 先停 persist/关页兜底，防导航期间把清掉的档写回
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'X-Requested-With': 'fetch' },
        });
      } catch (e) { /* 即使请求失败也回登录页 */ }
      authSignedOut = true; // 停 persist / flushCloud，防登出瞬间在途推送把旧档推回新会话
      cloudPending = null;
      if (cloudTimer) { clearTimeout(cloudTimer); cloudTimer = 0; }
      // 清推送锁与会话标记再走：本地不再落盘（云端唯一存档），换账号登录自然从云端恢复
      try {
        localStorage.removeItem(TAB_LOCK_KEY);
        sessionStorage.clear();
      } catch (e) { /* 忽略 */ }
      location.replace('/login.html');
    });
  }

  /* ---------------- 启动 ---------------- */

  // 调试钩子仅限本机使用（127.0.0.1 / localhost / [::1]），线上部署不暴露，防控制台改数值
  const debugOn = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
  if (debugOn) {
    window.LX = {
      state: () => state,
      stats: () => playerCombatStats(),
      enemy: (m, l) => enemyFor(m, l),          // 同源断言用（scripts/parity-check.mjs）
      req: (m, l) => contentReq(m, l),          // 同源断言用
      open: (n) => manualOpen(Math.max(1, Math.min(10000, n | 0))),
      offline: () => awardOffline(),
      refresh: () => {
        equipDirty = combatDirty = bagDirty = logDirty = true;
        render();
        paintBag(true);
      },
    };
  }

  // 启动：脚本若被提前（如 head 中）执行，等 DOM 就绪再初始化，避免元素查不到
  async function start() {
  if (!(await authGate())) return;    // 登录门禁：未登录 / 无后端不进入游戏
  if (!(await cloudRestore())) return; // 云端唯一存档：拉取失败/档损坏不进入游戏（见 cloudRestore）
  awardOffline();
  staminaRefresh(); // 征战体力展示快照（服务端裁定，见 doBattle 体力闸门）
  ensureDaily();
  syncFeatureUnlocks(false); // 存档里已满足的解锁静默记账，只有此后新达成的才播报
  bind();
    // 首次进入（全新档）：强制弹一次玩法教程；老玩家档不打扰
    if (!state.tutorialSeen && state.opens === 0 && state.totalStones === 0 && state.realm === 0) {
      enqueueFirstTimeTutorial();
      state.tutorialSeen = true;
    }
    paintUserChip();
    paintPlayerName(); // 主角名展示点（红尘录简介 / 战斗弹窗玩家名）按昵称填充
    updateMute();
    applyFontScale();
    applyTheme();
    paintResources();
    $('battleSpeed').textContent = '倍速 ×' + (state.battleSpeed || 1);
    render();
    paintBag(true);

    last = performance.now();
    lastRender = last;
    lastSave = last;
    lastBagPaint = last;
    setInterval(loop, 50);
    save();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
