// 天下玩法服务：战力排行 / PvP 竞技场 / 世界 BOSS / 仙盟 / 兑换码（零依赖）
// 原则：天梯分、血条、盟务、兑换状态以本服务为准。2026-10-31 起战斗结算也服务端化：
// PvP 胜负、妖王伤害由服务端用双方 PvP 快照复算（battle.js），客户端上报不采信；
// 灵石类花费（加购/立盟/捐献）凭增速账本余额（save_ledger，saves.js 维护）校验。
import { sendJSON, SlidingWindow } from './http-util.js';
import { simulateBattle, bossEnemyOf } from './battle.js';
import { findBannedWord } from './moderation.js';

const GUILD_CAP = 30;                 // 仙盟人数上限
// 基金阶梯（2026-11-01 用户指定）：升到第 N 级累计需 20万×N(N-1)/2——首次 20 万，
// 之后每级增量 +20 万（20万/60万/120万/…）；每级全局收益 +0.5%（客户端 baseGain 同步）
const GUILD_LEVEL_FUND = 200000;      // 阶梯基础步长
const GUILD_LEVEL_CAP = 10;
const fundNeed = (lv) => GUILD_LEVEL_FUND * lv * (lv - 1) / 2; // 升到 lv 级的累计基金门槛
const GUILD_CREATE_REALM = 4;         // 立盟境界门槛：化神（与 FEATURE_GATES.trials 对齐）
const GUILD_CREATE_EXP_COST = 20000;  // 立盟修为消耗（与灵石一并双币扣）
const DONATE_DAILY_CAP = 100000;      // 每人每日捐献上限
const DONATE_CONTRIB_PER = 2000;      // 捐献每 2000 灵石 +1 贡献
const PVP_DAILY_CAP = 15;             // 每人每日挑战次数（可灵石加购）
const PVP_BUY_MAX = 10;               // 每日加购次数上限
const PVP_BUY_COST = 10000;           // 加购单价（灵石）——扣款在客户端（货币归存档管），服务端只记权益
const PVP_PER_TARGET_DAILY = 3;       // 同一对手每日场次上限（防双号互刷）
const PVP_COOLDOWN_MS = 3000;         // 两次挑战最小间隔
const BOSS_DAILY_HITS = 30;           // 每人每日攻击次数（世界妖王）
const BOSS_MIN_HP = 2e7;              // 妖王血量下限（无强者时兜底）
const BOSS_HP_PER_POWER = 800;        // 血量 = 首个到访者时全服最高战力 × 此系数
const BOSS_MAX_HP = 1e12;
const GBOSS_DAILY_HITS = 5;           // 每人每日攻击次数（盟主妖王）
const GBOSS_MIN_HP = 2e6;             // 盟妖王血量下限
const GBOSS_MAX_HP = 5e10;
const GBOSS_CONTRIB_PER = 5000;       // 盟妖王每 5000 伤害 +1 贡献
const ELO_K = 32;
const RATING_FLOOR = 100;
const WRITE_PER_MIN = 60;             // 单用户写接口滑窗限流
const REDEEM_DAILY_CAP = 10;          // 单用户每日兑换次数
const REDEEM_RE = /^[A-Z0-9]{4,32}$/;
const GUILD_NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9]{2,8}$/;
const GUILD_CREATE_COST = 10000000;   // 立盟灵石（2026-11-01 用户指定 5 万→1000 万；另有 2 万修为 + 境界化神门槛）
const TASK_CLAIM_REWARD = { stones: 20000, contribution: 25 }; // 每项盟任务领取奖励

// —— 悬赏妖踪（2026-11-04 天下扩容）：每日三只精英妖 ——
// 敌人以玩家自己的 PvP 快照为基底按倍率缩放（快照含装备词条，人人有得打且不随服膨胀）；
// 每人每只一日一场，胜负都占场；胜负由服务端 simulateBattle 复算，战胜赏格服务端直发
// 账本 + action_log 授权流水。倍率/赏格公式与 game.js bountyEnemyOf 同源，改动须双侧同步。
const BOUNTY_TIERS = [
  { mult: 1.0, title: '妖将' },
  { mult: 1.7, title: '妖将统领' },
  { mult: 2.6, title: '妖王亲卫' },
];
const ELITE_NAMES = ['血牙', '玄鳞', '赤瞳', '蚀骨', '霜翼', '雷煞', '幽爪', '焚尾'];
const BOUNTY_STONE_BASE = 2e4;        // 赏格基线
const BOUNTY_STONE_PER_POWER = 1 / 40; // 赏格随战力成长（power/40）
const BOUNTY_STONE_CAP = 3e5;         // 单只赏格封顶（×倍率后最高 78 万/日）
const BOUNTY_DUST_BASE = 6;
const BOUNTY_DUST_PER_POWER = 1 / 1e6;
const BOUNTY_DUST_CAP = 300;

// —— 回忆之战（2026-11-04 红尘再启）：周常一名红尘录旧首领 ——
// 名单按周键种子确定性轮换（全服同一场）；敌人以玩家自己的 PvP 快照为基底按
// memoryEnemyOf 缩放（与 game.js 同源，改动须双侧同步）；每人每周一场、胜负都占场，
// 战胜周赏服务端直发账本 + action_log 授权流水；users.memory_week 防重打。
const MEMORY_BOSSES = [
  { name: '独眼豹', title: '黑风旧主', desc: '二十年的凶名散了，独眼里那点不服气还没散。' },
  { name: '血手修罗', title: '幽冥血使', desc: '三城的血债偿清了，血手在回忆里依旧发烫。' },
  { name: '幽冥老祖', title: '冰下三百年', desc: '冰层压不住的执念：那只匣子，它说还是它的。' },
  { name: '心魔·林小凡', title: '道心暗面', desc: '没有光的那个自己，每次回忆都要再战一遍。' },
  { name: '天外邪神', title: '墟中残响', desc: '以香火为食的古神，在回忆里仍旧饿着。' },
  { name: '天珩帝君', title: '执刀十万年', desc: '替一个死人的天执刀的人，刀还没入鞘。' },
  { name: '归墟', title: '天幕之饿', desc: '无形之饿。回忆是它的下一口，你来让它噎着。' },
  { name: '万神墓主', title: '残念之首', desc: '他还在问人间值不值得——答案由刀来答。' },
  { name: '守梯石翁', title: '三万六千级', desc: '梯上那块歪砖还在。他想看看，你还记不记得疼。' },
  { name: '旧天道', title: '一问千年', desc: '只留了一只匣子的问题。回忆里，它把问题又问了一遍。' },
];
const MEMORY_STONE_BASE = 5e4;        // 周赏基线
const MEMORY_STONE_PER_POWER = 1 / 16; // 周赏随战力成长（power/16）
const MEMORY_STONE_CAP = 8e6;         // 单周封顶（约悬赏全清的十倍量级）
const MEMORY_DUST_BASE = 60;
const MEMORY_DUST_PER_POWER = 1 / 2e6;
const MEMORY_DUST_CAP = 2000;

// —— 天梯日俸（2026-11-04 天下扩容）：按当前天梯分档位每日领俸 ——
// 需职业生涯打过一场竞技场；数额服务端现算直发（账本 + 授权流水），client 不传数额
const LADDER_PAY_TIERS = [
  { min: 1300, name: '登峰', stones: 6e5 },
  { min: 1100, name: '入阁', stones: 2.5e5 },
  { min: 900,  name: '立雪', stones: 1e5 },
  { min: 0,    name: '初阶', stones: 3e4 },
];

// —— 洞府访客（2026-11-04 日常扩容）：每日一位访客，三选一互动，选定即占当日 ——
// 访客与台词按（日期 + uid）种子确定性推导；切磋服务端复算（敌方=自身快照缩放，
// bountyEnemyOf 同款思路，倍率略高于悬赏 t1）；三路奖励全部服务端直发账本 + 授权流水。
const VISITORS = [
  { name: '苏挽月',   say: ['月下抚琴，闻道友洞府灵气清正，特来叨扰。', '玄天宗今日休沐，我带了些新谱的琴曲。', '路过贵府，闻得药香，想来讨盏灵茶。'] },
  { name: '雷无涯',   say: ['宗门大比归来，手痒，找你过上两招。', '近日悟了记新刀法，不切磋一番实在难受。', '听闻你近来进境飞快，我来验验成色。'] },
  { name: '玄玑子',   say: ['老道云游至此，见你洞府上有紫气，随缘一叙。', '今日卦象宜讲道，老道便厚着脸皮上门了。', '游兴未消，随脚一游，不想竟是你这里。'] },
  { name: '药尘翁',   say: ['老夫炼了一炉九曲还魂丹，分你闻闻药香。', '药材收多了，来你府上换些灵石使。', '丹炉炸了三次，出来散心，顺路访友。'] },
  { name: '琴娘阿阮', say: ['公子姐姐们都说你洞府雅致，特来瞧瞧。', '新制了一张焦尾琴，想寻个知音听听。', '坊市今日歇市，来你这儿躲躲闲话。'] },
  { name: '游方散人', say: ['贫道步履天下，今日恰好行至此处。', '换了一双新草鞋，旧的就送你镇宅罢。', '讨口水喝，顺带说说外头的见闻。'] },
  { name: '行脚商人', say: ['好货不贵，今日开张，先访熟客。', '新到一批星河深处的稀罕物，掌柜的看看？', '账上缺进项，来你这儿寻些生意。'] },
  { name: '说书先生', say: ['新编了段《灵匣记》，先在你这儿试说一折。', '茶馆歇业，说书人没了场子，来你府上练练嘴。', '收集民间轶闻，闻你洞府故事多。'] },
];
// 切磋：敌方缩放与赏格（随战力成长、封顶）；战败无奖励（当日已占）
const VISITOR_DUEL_ENEMY = { atk: 0.62, hp: 2.6, def: 0.85, pierce: 0.1 };
const VISITOR_DUEL_STONE_BASE = 8e3;
const VISITOR_DUEL_STONE_PER_POWER = 1 / 60;
const VISITOR_DUEL_STONE_CAP = 1.2e5;
const VISITOR_DUEL_DUST_BASE = 4;
const VISITOR_DUEL_DUST_PER_POWER = 1 / 2.5e6;
const VISITOR_DUEL_DUST_CAP = 120;
// 赠礼：花 20 万灵石换人缘（碎屑 + 鱼饵），余额不足 400 不占当日
const VISITOR_GIFT_COST = 2e5;
const VISITOR_GIFT_REWARD = { dust: 80, bait: 2 };
// 求教：免费听道，得灵石（随战力成长、封顶）
const VISITOR_ASK_STONE_BASE = 2e5;
const VISITOR_ASK_STONE_PER_POWER = 1 / 120;
const VISITOR_ASK_STONE_CAP = 8e5;

// —— 仙盟共修（2026-11-04 日常扩容）：盟员每日捐灵石入共修池（20 万/次、3 次/日），
// 池子按日归零；达档全盟可领（每人每档一次），奖励服务端直发账本 + 授权流水；
// 领取后当日「共修心得」小增益由客户端结算（同周增益链，+3% 灵石/碎屑）。
const CULT_AMOUNT = 2e5;
const CULT_DAILY_TIMES = 3;
const CULT_TIERS = [
  { name: '小成', need: 6e5, stones: 3e5, dust: 30 },
  { name: '大成', need: 2e6, stones: 8e5, dust: 60 },
  { name: '圆满', need: 5e6, stones: 2e6, dust: 100 },
];

// 盟任务：进度全部由服务端从真实行为表聚合（捐献额 / 盟妖王伤害 / 盟员切磋场数）。
// donate 目标取单人每日捐献上限，保证独行侠盟也能做完。
const GUILD_TASKS = [
  { id: 'donate', name: '盟库充盈', target: 100000, desc: '盟员今日捐献 10 万灵石' },
  { id: 'gboss', name: '共讨妖君', target: 3000000, desc: '盟员今日对盟主妖王累计伤害 300 万' },
  { id: 'pvp', name: '切磋砥砺', target: 15, desc: '盟员今日切磋合计 15 场' },
];

// 贡献商店：贡献为个人属性（挂 guild_members，随退盟清零），每日限购服务端记账
const GUILD_SHOP = [
  { id: 'stones', name: '灵石俸禄', cost: 20, times: 5, reward: { stones: 20000 } },
  { id: 'dust', name: '碎屑包', cost: 30, times: 3, reward: { dust: 500 } },
  { id: 'coupon', name: '洗练券', cost: 40, times: 1, reward: { rerollCoupon: 1 } },
  { id: 'talisman', name: '护体符', cost: 60, times: 1, reward: { talismans: 1 } },
  { id: 'tickets', name: '招募券', cost: 50, times: 2, reward: { petTickets: 1 } },
];

const BOSS_NAMES = ['噬山', '赤渊', '玄冥', '烛阴', '穷奇', '梼杌', '饕餮', '浑沌'];
const GBOSS_NAMES = ['墨麟', '血瞳', '赤炎', '玄冰', '幽冥', '狂岚', '裂山', '噬魂'];

// ---------------- 假人「剑影」名册 ----------------
// users.status='bot' 的预置账号：不可登录（password_hash 非法格式即验不过）、
// 不进战力榜（榜单过滤 status='active'）、常驻天梯榜。与真人同走 Elo 与对位日限。
const BOT_NAMES = [
  '青锋影', '白衣沽酒', '剑廿三', '踏雪无痕', '醉卧沙场', '一剑霜寒',
  '云深不知处', '孤鸿影', '落叶听风', '剑归何处', '半盏流年', '红尘一剑',
  '雪满弓刀', '月照花林', '风雪夜归人', '千山暮雪', '剑气近', '听雨眠',
  '孤舟蓑笠', '星河入梦', '断桥残雪', '一苇渡江', '青山不改', '剑心通明',
];
const BOT_REALM_AT = [0, 800, 4e3, 2e4, 1e5, 5e5, 2.5e6, 1.2e7, 6e7, 3e8];
const BOT_PASSWORD_HASH = 'bot$no$login'; // verifyPassword 按段解析必失败，且 status='bot' 拿不到会话

function botRealmForPower(power) {
  let realm = 0;
  for (let i = 0; i < BOT_REALM_AT.length; i++) {
    if (power >= BOT_REALM_AT[i]) realm = i;
  }
  return Math.min(9, realm);
}

function buildBotSnapshot(power, seed) {
  // 与真人量级口径一致（playerCombatStats 基线 ×上下浮动），钳制函数同款边界内
  const fuzz = (base, pct) => Math.round(base * (1 - pct + ((seed * 7 + base) % 100) / 100 * pct * 2));
  return {
    atk: fuzz(power * 1.1, 0.15),
    hp: fuzz(power * 6, 0.2),
    def: fuzz(power * 0.35, 0.2),
    crit: 0.1 + ((seed * 13) % 15) / 100,
    critMult: 2,
    lifesteal: ((seed * 3) % 10) / 100,
    dr: ((seed * 5) % 15) / 100,
    pierce: 0.05 + ((seed * 11) % 20) / 100,
  };
}

export function guildLevel(fund) {
  // 阶梯式（2026-11-01）：fund 达到 fundNeed(N) 即 N 级——20万/60万/120万/…
  let lv = 1;
  while (lv < GUILD_LEVEL_CAP && (fund || 0) >= fundNeed(lv + 1)) lv++;
  return lv;
}

function dayStr(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 今日零点（服务器本地时区）：切磋场数等带时间戳的聚合从此起算
function dayStart(now = Date.now()) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function createSocialService(db) {
  const writeWindow = new SlidingWindow(60 * 1000, WRITE_PER_MIN);
  const stmts = {
    // 排行榜（战力榜只收真人）
    top: db.prepare(
      `SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.username) AS name, u.realm, u.power_score, g.name AS guild
       FROM users u
       LEFT JOIN guild_members gm ON gm.user_id = u.id
       LEFT JOIN guilds g ON g.id = gm.guild_id
       WHERE u.power_score > 0 AND u.status = 'active'
       ORDER BY u.power_score DESC LIMIT 50`),
    betterCount: db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE power_score > ? AND status = 'active'"),
    byId: db.prepare('SELECT id, username, display_name, realm, power_score, pvp_rating, pvp_wins, pvp_losses, pvp_snapshot, pvp_day, pvp_used, pvp_buys, pvp_buy_day, last_pvp_at, ladder_pay_day, memory_week FROM users WHERE id = ?'),
    // PvP（真人候选池不含假人；假人由 botCandidates 按战力就近补位）
    candidates: db.prepare(
      `SELECT id, COALESCE(NULLIF(display_name, ''), username) AS name, realm, power_score, pvp_rating, pvp_snapshot, 0 AS bot
       FROM users WHERE id != ? AND status = 'active' AND pvp_snapshot IS NOT NULL
       ORDER BY ABS(pvp_rating - ?) LIMIT 8`),
    // 假人候选：就近池（战力最近 12 个）里随机抽 6——纯 ORDER BY ABS(power_score-?)
    // 是确定性排序，每次刷新都同一批假人（线上实测「总是刷出重复的剑影」）；
    // 内层就近保匹配强度，外层 RANDOM() 保刷新多样性，假人不足 12 个时自然退化全量
    botCandidates: db.prepare(
      `SELECT id, COALESCE(NULLIF(display_name, ''), username) AS name, realm, power_score, pvp_rating, pvp_snapshot, 1 AS bot
       FROM (
         SELECT id, display_name, username, realm, power_score, pvp_rating, pvp_snapshot
         FROM users WHERE status = 'bot' AND pvp_snapshot IS NOT NULL
         ORDER BY ABS(power_score - ?) LIMIT 12
       ) ORDER BY RANDOM() LIMIT 6`),
    pvpSelf: db.prepare('UPDATE users SET pvp_rating = ?, pvp_wins = ?, pvp_losses = ?, pvp_day = ?, pvp_used = ?, last_pvp_at = ? WHERE id = ?'),
    pvpBuy: db.prepare('UPDATE users SET pvp_buy_day = ?, pvp_buys = ? WHERE id = ?'),
    pvpOpp: db.prepare('UPDATE users SET pvp_rating = ?, pvp_wins = ?, pvp_losses = ? WHERE id = ?'),
    logBattle: db.prepare(
      'INSERT INTO pvp_battles (attacker_id, defender_id, winner_id, created_at) VALUES (?, ?, ?, ?)'),
    pvpVsCount: db.prepare(
      `SELECT COUNT(*) AS n FROM pvp_battles
       WHERE attacker_id = ? AND defender_id = ? AND created_at > ?`),
    // 世界 BOSS
    bossOfDay: db.prepare('SELECT * FROM world_boss WHERE day = ?'),
    bossTop: db.prepare(
      'SELECT name, damage, hits FROM world_boss_hits WHERE day = ? ORDER BY damage DESC LIMIT 10'),
    myHits: db.prepare('SELECT damage, hits FROM world_boss_hits WHERE day = ? AND user_id = ?'),
    createBoss: db.prepare(
      `INSERT INTO world_boss (day, name, hp, max_hp, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day) DO NOTHING`),
    topPower: db.prepare('SELECT MAX(power_score) AS m FROM users'),
    // 装备查验（rank/inspect）：上榜用户公开信息 + 其云端存档的穿戴六件
    inspectUser: db.prepare(
      "SELECT id, COALESCE(NULLIF(display_name, ''), username) AS name, realm, power_score" +
      " FROM users WHERE id = ? AND status = 'active' AND power_score > 0"),
    inspectSave: db.prepare('SELECT data FROM game_saves WHERE user_id = ?'),
    hitBoss: db.prepare('UPDATE world_boss SET hp = MAX(0, hp - ?), killed_by = COALESCE(killed_by, ?), defeated_at = COALESCE(defeated_at, ?) WHERE day = ?'),
    upsertHit: db.prepare(
      `INSERT INTO world_boss_hits (day, user_id, name, damage, hits) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(day, user_id) DO UPDATE SET damage = damage + excluded.damage, hits = hits + 1, name = excluded.name`),
    // 仙盟
    myGuildRow: db.prepare(
      `SELECT g.id, g.name, g.notice, g.fund, g.leader_id, gm.role
       FROM guild_members gm JOIN guilds g ON g.id = gm.guild_id WHERE gm.user_id = ?`),
    // 同门互助：传功 / 赠礼记账（发起方记日期与目标，受赠方记来源，领取后清除）
    aidMe: db.prepare(
      `SELECT aid_day, aid_skill_to, aid_gift_to, aid_from_type, aid_from_name, aid_from_day
       FROM guild_members WHERE guild_id = ? AND user_id = ?`),
    aidSetGive: db.prepare(
      'UPDATE guild_members SET aid_day = ?, aid_skill_to = ?, aid_gift_to = ? WHERE guild_id = ? AND user_id = ?'),
    aidSetFrom: db.prepare(
      'UPDATE guild_members SET aid_from_type = ?, aid_from_name = ?, aid_from_day = ? WHERE guild_id = ? AND user_id = ?'),
    aidClearFrom: db.prepare(
      `UPDATE guild_members SET aid_from_type = '', aid_from_name = '', aid_from_day = ''
       WHERE guild_id = ? AND user_id = ?`),
    guildMembers: db.prepare(
      `SELECT gm.user_id, COALESCE(NULLIF(u.display_name, ''), u.username) AS name, u.power_score, gm.role, gm.joined_at, gm.contribution
       FROM guild_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.guild_id = ? ORDER BY u.power_score DESC`),
    memberCount: db.prepare('SELECT COUNT(*) AS n FROM guild_members WHERE guild_id = ?'),
    guildList: db.prepare(
      `SELECT g.id, g.name, g.fund, g.notice, COUNT(gm.user_id) AS members
       FROM guilds g LEFT JOIN guild_members gm ON gm.guild_id = g.id
       GROUP BY g.id ORDER BY g.fund DESC LIMIT 20`),
    guildByName: db.prepare('SELECT id FROM guilds WHERE name_lower = ?'),
    insertGuild: db.prepare(
      'INSERT INTO guilds (name, name_lower, leader_id, created_at) VALUES (?, ?, ?, ?)'),
    joinGuild: db.prepare(
      'INSERT INTO guild_members (guild_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'),
    leaveGuild: db.prepare('DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?'),
    setGuildLeader: db.prepare('UPDATE guilds SET leader_id = ? WHERE id = ?'),
    promoteMember: db.prepare("UPDATE guild_members SET role = 'leader' WHERE guild_id = ? AND user_id = ?"),
    setNotice: db.prepare('UPDATE guilds SET notice = ? WHERE id = ?'),
    addFund: db.prepare('UPDATE guilds SET fund = fund + ? WHERE id = ?'),
    earliestMember: db.prepare(
      'SELECT user_id FROM guild_members WHERE guild_id = ? ORDER BY joined_at LIMIT 1'),
    deleteGuild: db.prepare('DELETE FROM guilds WHERE id = ?'),
    donateRow: db.prepare('SELECT amount FROM guild_donations WHERE guild_id = ? AND user_id = ? AND day = ?'),
    donateUpsert: db.prepare(
      `INSERT INTO guild_donations (guild_id, user_id, day, amount) VALUES (?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id, day) DO UPDATE SET amount = amount + excluded.amount`),
    // 兑换码
    codeGet: db.prepare('SELECT * FROM redeem_codes WHERE code = ? AND deleted = 0'),
    codeUse: db.prepare('UPDATE redeem_codes SET used_count = used_count + 1 WHERE code = ?'),
    codeLog: db.prepare('INSERT INTO redeem_log (code, user_id, created_at) VALUES (?, ?, ?)'),
    codeLogGet: db.prepare('SELECT 1 FROM redeem_log WHERE code = ? AND user_id = ?'),
    redeemCountToday: db.prepare(
      `SELECT COUNT(*) AS n FROM redeem_log WHERE user_id = ? AND created_at > ?`),
    guildGet: db.prepare('SELECT id, name, notice, fund, leader_id FROM guilds WHERE id = ?'),
    guildMemberCount: db.prepare('SELECT COUNT(*) AS n FROM guild_members WHERE guild_id = ?'),
    guildExists: db.prepare('SELECT id FROM guilds WHERE id = ?'),
    // 仙盟玩法：贡献 / 盟任务 / 盟妖王 / 商店
    addContribution: db.prepare(
      'UPDATE guild_members SET contribution = contribution + ? WHERE guild_id = ? AND user_id = ?'),
    myContribution: db.prepare(
      'SELECT contribution FROM guild_members WHERE guild_id = ? AND user_id = ?'),
    donateSumToday: db.prepare(
      'SELECT COALESCE(SUM(amount), 0) AS n FROM guild_donations WHERE guild_id = ? AND day = ?'),
    taskClaimed: db.prepare(
      'SELECT 1 FROM guild_task_claims WHERE guild_id = ? AND user_id = ? AND day = ? AND task_id = ?'),
    taskClaim: db.prepare(
      'INSERT INTO guild_task_claims (guild_id, user_id, day, task_id) VALUES (?, ?, ?, ?)'),
    pvpBattleCount: db.prepare(
      `SELECT COUNT(*) AS n FROM pvp_battles b
       WHERE b.created_at > ? AND (
         b.attacker_id IN (SELECT user_id FROM guild_members WHERE guild_id = ?) OR
         b.defender_id IN (SELECT user_id FROM guild_members WHERE guild_id = ?))`),
    gbossOf: db.prepare('SELECT * FROM guild_boss WHERE guild_id = ?'),
    gbossTopPower: db.prepare(
      `SELECT MAX(u.power_score) AS m FROM guild_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.guild_id = ?`),
    gbossCreate: db.prepare(
      `INSERT INTO guild_boss (guild_id, day, name, hp, max_hp, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET day = excluded.day, name = excluded.name,
         hp = excluded.hp, max_hp = excluded.max_hp, killed_by = NULL, defeated_at = NULL,
         updated_at = excluded.updated_at
       WHERE guild_boss.day != excluded.day`),
    gbossHit: db.prepare(
      `UPDATE guild_boss SET hp = MAX(0, hp - ?), killed_by = COALESCE(killed_by, ?),
         defeated_at = COALESCE(defeated_at, ?), updated_at = ? WHERE guild_id = ?`),
    gbossMyHits: db.prepare(
      'SELECT damage, hits FROM guild_boss_hits WHERE guild_id = ? AND user_id = ? AND day = ?'),
    gbossHitUp: db.prepare(
      `INSERT INTO guild_boss_hits (guild_id, user_id, day, name, damage, hits) VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(guild_id, user_id, day) DO UPDATE SET damage = damage + excluded.damage,
         hits = hits + 1, name = excluded.name`),
    gbossTop: db.prepare(
      'SELECT name, damage, hits FROM guild_boss_hits WHERE guild_id = ? AND day = ? ORDER BY damage DESC LIMIT 5'),
    shopBought: db.prepare(
      'SELECT times FROM guild_shop_log WHERE guild_id = ? AND user_id = ? AND item_id = ? AND day = ?'),
    shopBuy: db.prepare(
      `INSERT INTO guild_shop_log (guild_id, user_id, item_id, day, times) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(guild_id, user_id, item_id, day) DO UPDATE SET times = times + 1`),
    spendContribution: db.prepare(
      `UPDATE guild_members SET contribution = contribution - ?
       WHERE guild_id = ? AND user_id = ? AND contribution >= ?`),
    gbossSumToday: db.prepare(
      'SELECT COALESCE(SUM(damage), 0) AS n FROM guild_boss_hits WHERE guild_id = ? AND day = ?'),
    // 假人 / 天梯
    nameExists: db.prepare('SELECT 1 FROM users WHERE username_lower = ?'),
    insertBot: db.prepare(
      `INSERT INTO users (username, username_lower, password_hash, status, power_score, realm,
         pvp_rating, pvp_snapshot, created_at)
       VALUES (?, ?, ?, 'bot', ?, ?, ?, ?, ?)`),
    ladderTop: db.prepare(
      `SELECT COALESCE(NULLIF(u.display_name, ''), u.username) AS name, u.realm, u.power_score, u.pvp_rating, u.pvp_wins, u.pvp_losses,
              u.status, g.name AS guild
       FROM users u
       LEFT JOIN guild_members gm ON gm.user_id = u.id
       LEFT JOIN guilds g ON g.id = gm.guild_id
       WHERE u.status = 'bot' OR (u.pvp_wins + u.pvp_losses) > 0
       ORDER BY u.pvp_rating DESC LIMIT 30`),
    ladderBetter: db.prepare(
      `SELECT COUNT(*) AS n FROM users
       WHERE (status = 'bot' OR pvp_wins + pvp_losses > 0) AND pvp_rating > ?`),
    // 灵石余额（增速账本，saves.js 随存档更新）：加购 / 立盟 / 捐献的服务端余额依据
    ledgerSpend: db.prepare('UPDATE save_ledger SET stones = stones - ? WHERE user_id = ? AND stones >= ?'),
    ledgerRefund: db.prepare('UPDATE save_ledger SET stones = stones + ? WHERE user_id = ?'),
    // 修为余额（同账本口径）：立盟双币消耗的修为侧原子扣款与退款
    ledgerSpendExp: db.prepare('UPDATE save_ledger SET exp = exp - ? WHERE user_id = ? AND exp >= ?'),
    ledgerRefundExp: db.prepare('UPDATE save_ledger SET exp = exp + ? WHERE user_id = ?'),
    // —— 2026-11-04 天下扩容：悬赏妖踪 / 天梯日俸 ——
    bountyGet: db.prepare(
      'SELECT win, damage, stones, dust FROM bounty_kills WHERE day = ? AND user_id = ? AND slot = ?'),
    bountyIns: db.prepare(
      `INSERT INTO bounty_kills (day, user_id, slot, win, damage, stones, dust, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, user_id, slot) DO NOTHING`),
    // 服务端直发的账本侧入账（悬赏赏格 / 天梯俸禄）：主计数列 + 授权流水双记，
    // checkVelocity 的 s.stones/s.dust 会把这批收益计入增速包络（防「余额跳变」误拒）
    ledgerRow: db.prepare('SELECT user_id FROM save_ledger WHERE user_id = ?'),
    ledgerAddStonesDust: db.prepare(
      'UPDATE save_ledger SET stones = stones + ?, total_stones = total_stones + ?, dust_total = dust_total + ? WHERE user_id = ?'),
    ledgerAddStones: db.prepare(
      'UPDATE save_ledger SET stones = stones + ?, total_stones = total_stones + ? WHERE user_id = ?'),
    logAction: db.prepare(
      'INSERT INTO action_log (user_id, day, kind, stones, dust, tickets, exp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    ladderPayDaySet: db.prepare('UPDATE users SET ladder_pay_day = ? WHERE id = ?'),
    memoryWeekSet: db.prepare('UPDATE users SET memory_week = ? WHERE id = ?'),
    // —— 2026-11-04 日常扩容：洞府访客 / 仙盟共修 ——
    visitorGet: db.prepare(
      'SELECT choice, win, stones, dust FROM visitor_acts WHERE day = ? AND user_id = ?'),
    visitorIns: db.prepare(
      `INSERT INTO visitor_acts (day, user_id, choice, win, stones, dust, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(day, user_id) DO NOTHING`),
    cultGet: db.prepare('SELECT stones, members FROM guild_cult WHERE day = ? AND guild_id = ?'),
    cultIns: db.prepare(
      `INSERT INTO guild_cult (day, guild_id, stones, members, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day, guild_id) DO UPDATE SET
         stones = stones + excluded.stones, members = excluded.members`),
    cultLogGet: db.prepare(
      'SELECT times FROM guild_cult_log WHERE day = ? AND guild_id = ? AND user_id = ?'),
    cultLogUp: db.prepare(
      `INSERT INTO guild_cult_log (day, guild_id, user_id, times, stones, created_at)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(day, guild_id, user_id) DO UPDATE SET
         times = times + 1, stones = stones + excluded.stones`),
    cultClaimGet: db.prepare(
      'SELECT 1 FROM guild_cult_claims WHERE day = ? AND guild_id = ? AND user_id = ? AND tier = ?'),
    cultClaimIns: db.prepare(
      'INSERT INTO guild_cult_claims (day, guild_id, user_id, tier, created_at) VALUES (?, ?, ?, ?, ?)'),
    cultMyTotal: db.prepare(
      'SELECT COALESCE(SUM(stones), 0) AS n FROM guild_cult_log WHERE guild_id = ? AND user_id = ? AND day = ?'),
  };

  // 账本灵石原子扣款（2026-10-31 复审升级）：严格足额才扣成功——查而不扣时同一笔账本
  // 灵石可在推送滞后窗口内重复消费（curl 连打加购 10 次零成本）。
  // 无账本行（刚注册还没传过档）按 0 计直接拒绝，客户端传档后（约 5 秒）自愈；
  // 服务端扣减后客户端存档侧同步扣款，下次推送 dStones 向下不触发跳变校验。
  function spendLedger(userId, cost) {
    return stmts.ledgerSpend.run(cost, userId, cost).changes > 0;
  }

  // 修为原子扣款/退款（与 spendLedger 同款防重复消费口径，2026-11-01 立盟双币消耗引入）
  function spendLedgerExp(userId, cost) {
    return stmts.ledgerSpendExp.run(cost, userId, cost).changes > 0;
  }
  function refundLedgerExp(userId, cost) {
    stmts.ledgerRefundExp.run(cost, userId);
  }

  // 服务启动时补齐假人名册（幂等：按道号查重）
  function ensureBots() {
    const now = Date.now();
    BOT_NAMES.forEach((name, i) => {
      if (stmts.nameExists.get(name.toLowerCase())) return;
      const power = Math.round(300 * Math.pow(1.55, i));
      const rating = 700 + i * 38 + ((i * 17) % 51);
      stmts.insertBot.run(name, name.toLowerCase(), BOT_PASSWORD_HASH,
        power, botRealmForPower(power), rating, JSON.stringify(buildBotSnapshot(power, i + 1)), now);
    });
  }
  ensureBots();

  // ---------------- 排行榜 ----------------

  function rank(req, res, ctx) {
    const top = stmts.top.all().map((r, i) => ({
      rank: i + 1,
      id: r.id,
      name: r.name,
      realm: r.realm,
      power: r.power_score,
      guild: r.guild || '',
    }));
    const me = stmts.byId.get(ctx.user.id);
    const mine = Math.max(0, me ? me.power_score : 0);
    const myRank = mine > 0 ? stmts.betterCount.get(mine).n + 1 : 0;
    return sendJSON(res, 200, { top, me: { rank: myRank, power: mine } });
  }

  // ---------------- 战力榜·装备查验 ----------------

  // 只回传穿戴六件的展示字段（名称/品质/星级/战力/五行/套装/词条），存档其余内容不出库。
  // 目标存档入库前已过深度校验，这里再钳一遍量级，双保险。
  function rankInspect(req, res, ctx) {
    const id = Math.floor(Number(ctx.body && ctx.body.id));
    if (!Number.isFinite(id) || id <= 0) return sendJSON(res, 400, { error: '参数无效' });
    const target = stmts.inspectUser.get(id);
    if (!target) return sendJSON(res, 404, { error: '玩家不存在或未上榜' });
    const clamp = (v, lo, hi, dflt) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
    };
    const equipped = {};
    try {
      const row = stmts.inspectSave.get(id);
      const data = row ? JSON.parse(row.data) : null;
      const raw = data && data.equipped && typeof data.equipped === 'object' ? data.equipped : {};
      for (const k of ['weapon', 'armor', 'helm', 'boots', 'artifact', 'talisman',
        'bracelet', 'ring', 'wrist', 'legs', 'band', 'wings']) {
        const it = raw[k];
        if (!it || typeof it !== 'object') continue;
        equipped[k] = {
          name: String(it.name || '').slice(0, 24),
          r: clamp(it.r, 0, 5, 0),
          star: clamp(it.star, 0, 5, 0),
          power: clamp(it.power, 1, 1e15, 1),
          el: String(it.el || '').slice(0, 8),
          setKey: typeof it.setKey === 'string' ? it.setKey.slice(0, 16) : '',
          affixes: (Array.isArray(it.affixes) ? it.affixes : []).slice(0, 3).map((a) => ({
            k: String((a && a.k) || '').slice(0, 8),
            v: clamp(a && a.v, 0, 1, 0),
          })),
        };
      }
    } catch (e) {
      // 存档解析失败按未穿戴展示，不向外泄露错误细节
    }
    return sendJSON(res, 200, {
      name: target.name, realm: target.realm, power: target.power_score, equipped,
    });
  }

  // ---------------- PvP 竞技场 ----------------

  // 今日可用场次上限 = 基础场次 + 灵石加购（加购计数服务端记账，隔日自动清零）
  const pvpCapOf = (me, today) => {
    const buys = me.pvp_buy_day === today ? Math.min(me.pvp_buys, PVP_BUY_MAX) : 0;
    return { cap: PVP_DAILY_CAP + buys, buys };
  };

  function pvpBuy(req, res, ctx) {
    const me = stmts.byId.get(ctx.user.id);
    if (!me) return sendJSON(res, 500, { error: '账号状态异常' });
    const today = dayStr();
    const buys = me.pvp_buy_day === today ? me.pvp_buys : 0;
    if (buys >= PVP_BUY_MAX) {
      return sendJSON(res, 429, { error: '今日加购已达上限（' + PVP_BUY_MAX + ' 次）' });
    }
    // 余额校验 + 原子扣款（2026-10-31）：账本灵石不足直接拒绝，堵改档白嫖场次
    if (!spendLedger(ctx.user.id, PVP_BUY_COST)) {
      return sendJSON(res, 400, { error: '灵石不足，无法加购' });
    }
    stmts.pvpBuy.run(today, buys + 1, me.id);
    return sendJSON(res, 200, {
      ok: true, buys: buys + 1, buyMax: PVP_BUY_MAX,
      cap: PVP_DAILY_CAP + buys + 1, cost: PVP_BUY_COST,
    });
  }

  function pvpState(req, res, ctx) {
    const me = stmts.byId.get(ctx.user.id);
    if (!me) return sendJSON(res, 500, { error: '账号状态异常' });
    const today = dayStr();
    const used = me.pvp_day === today ? me.pvp_used : 0;
    const { cap, buys } = pvpCapOf(me, today);
    // 匹配：真人按评分就近取 8 再洗牌取前 4；假人按战力就近补足到 5——
    // 空服也有得打，真人多时假人自然被挤出名单
    const shuffle = (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    };
    const seen = new Set([me.id]);
    const picked = [];
    for (const r of shuffle(stmts.candidates.all(me.id, me.pvp_rating))) {
      if (picked.length >= 4) break;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      picked.push(r);
    }
    if (picked.length < 5) {
      for (const r of shuffle(stmts.botCandidates.all(me.power_score))) {
        if (picked.length >= 5) break;
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        picked.push(r);
      }
    }
    const opponents = picked.map((r) => {
      let snap = null;
      try { snap = JSON.parse(r.pvp_snapshot); } catch (e) { /* 脏快照跳过 */ }
      return {
        id: r.id, name: r.name, realm: r.realm, bot: !!r.bot,
        power: r.power_score, rating: r.pvp_rating, snap,
      };
    }).filter((o) => o.snap);
    return sendJSON(res, 200, {
      rating: me.pvp_rating, wins: me.pvp_wins, losses: me.pvp_losses,
      used, cap, day: today, buys, buyMax: PVP_BUY_MAX, buyCost: PVP_BUY_COST, opponents,
    });
  }

  // ---------------- 天梯榜 ----------------

  function ladder(req, res, ctx) {
    const me = stmts.byId.get(ctx.user.id);
    const myRating = me ? me.pvp_rating : 0;
    const top = stmts.ladderTop.all().map((r, i) => ({
      rank: i + 1,
      name: r.name,
      realm: r.realm,
      rating: r.pvp_rating,
      wins: r.pvp_wins,
      losses: r.pvp_losses,
      guild: r.guild || '',
      bot: r.status === 'bot',
    }));
    const myRow = stmts.ladderBetter.get(myRating).n + 1;
    const myGames = me ? me.pvp_wins + me.pvp_losses : 0;
    // 天梯日俸状态（2026-11-04 天下扩容）：当日已领 / 可领档位与数额由服务端现算下发
    const today = dayStr();
    const tier = ladderPayTierOf(myRating);
    const claimed = !!me && me.ladder_pay_day === today;
    const pay = {
      claimed,
      games: myGames,
      tierName: tier.name,
      amount: tier.stones,
      can: !claimed && myGames > 0,
    };
    return sendJSON(res, 200, {
      top,
      me: { rank: myGames > 0 ? myRow : 0, rating: myRating, wins: me ? me.pvp_wins : 0, losses: me ? me.pvp_losses : 0 },
      pay,
    });
  }

  const ladderPayTierOf = (rating) =>
    LADDER_PAY_TIERS.find((t) => rating >= t.min) || LADDER_PAY_TIERS[LADDER_PAY_TIERS.length - 1];

  // 天梯日俸：职业生涯打过一场即可每日按当前段位领俸；服务端直发账本 + 授权流水，
  // ladder_pay_day 防重领。无账本行（刚注册未传档）走 409，客户端补推后自愈。
  function ladderPay(req, res, ctx) {
    const me = stmts.byId.get(ctx.user.id);
    if (!me) return sendJSON(res, 500, { error: '账号状态异常' });
    if (me.pvp_wins + me.pvp_losses <= 0) {
      return sendJSON(res, 400, { error: '先在竞技场打一场，俸禄才会记你名下' });
    }
    const today = dayStr();
    if (me.ladder_pay_day === today) return sendJSON(res, 429, { error: '今日俸禄已领，明日再来' });
    if (!stmts.ledgerRow.get(me.id)) return sendJSON(res, 409, { error: '存档同步中，稍后再领' });
    const tier = ladderPayTierOf(me.pvp_rating);
    db.exec('BEGIN');
    try {
      stmts.ledgerAddStones.run(tier.stones, tier.stones, me.id);
      stmts.logAction.run(me.id, today, 'ladder_pay', tier.stones, 0, 0, 0, Date.now());
      stmts.ladderPayDaySet.run(today, me.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return sendJSON(res, 200, { ok: true, stones: tier.stones, tierName: tier.name, rating: me.pvp_rating });
  }

  function eloDelta(ra, rb, win) {
    const expected = 1 / (1 + 10 ** ((rb - ra) / 400));
    return Math.round(ELO_K * ((win ? 1 : 0) - expected));
  }

  function pvpFight(req, res, ctx) {
    const body = ctx.body || {};
    const targetId = Math.floor(Number(body.targetId));
    const me = stmts.byId.get(ctx.user.id);
    if (!me) return sendJSON(res, 500, { error: '账号状态异常' });
    if (!targetId || targetId === me.id) return sendJSON(res, 400, { error: '对手不存在' });
    if (Date.now() - me.last_pvp_at < PVP_COOLDOWN_MS) {
      return sendJSON(res, 429, { error: '出手太急，稍候再战' });
    }
    const today = dayStr();
    const used = me.pvp_day === today ? me.pvp_used : 0;
    const { cap, buys } = pvpCapOf(me, today);
    if (used >= cap) {
      return sendJSON(res, 429, {
        error: '今日 ' + PVP_DAILY_CAP + ' 场已尽：可花 ' + (PVP_BUY_COST / 10000) +
          ' 万灵石加购（已购 ' + buys + '/' + PVP_BUY_MAX + '）',
      });
    }
    const opp = stmts.byId.get(targetId);
    if (!opp || !opp.pvp_snapshot) return sendJSON(res, 400, { error: '对手尚未立档，无从切磋' });
    // 对位日限：同一对手每日至多 3 场，堵双号互刷天梯分
    if (stmts.pvpVsCount.get(me.id, opp.id, dayStart()).n >= PVP_PER_TARGET_DAILY) {
      return sendJSON(res, 429, { error: '今日已与这位道号切磋 3 场，换个人过招吧' });
    }
    // 胜负由服务端复算（2026-10-31）：双方 PvP 快照进 battle.js 模拟，
    // 客户端上报的 win 不再采信——改快照/改内存刷天梯分从此无效。
    // 双方快照八项必须齐全可数值化：存量行快照列可能仍为 NULL（pvpSnap 字段名错位
    // 当日才修，要等下一次存档同步才回填），缺失/坏档走 409 且不扣次数与冷却
    // （次数/冷却写在下方才落库），客户端收到 409 会立即补推快照
    let mine = null;
    let theirs = null;
    try { mine = JSON.parse(me.pvp_snapshot); } catch (e) { /* 我的快照缺失/坏档 */ }
    try { theirs = JSON.parse(opp.pvp_snapshot); } catch (e) { /* 对手快照坏档 */ }
    if (!snapOk(mine) || !snapOk(theirs)) {
      return sendJSON(res, 409, { error: '战斗快照未就绪，已触发重新同步，几秒后再战' });
    }
    const win = simulateBattle(mine, theirs).win ? 1 : 0;

    const dMe = eloDelta(me.pvp_rating, opp.pvp_rating, win);
    const dOpp = eloDelta(opp.pvp_rating, me.pvp_rating, 1 - win);
    const myRating = Math.max(RATING_FLOOR, me.pvp_rating + dMe);
    const oppRating = Math.max(RATING_FLOOR, opp.pvp_rating + dOpp);
    stmts.pvpSelf.run(myRating, me.pvp_wins + (win ? 1 : 0), me.pvp_losses + (win ? 0 : 1),
      today, used + 1, Date.now(), me.id);
    stmts.pvpOpp.run(oppRating, opp.pvp_wins + (win ? 0 : 1), opp.pvp_losses + (win ? 1 : 0), opp.id);
    stmts.logBattle.run(me.id, opp.id, win ? me.id : opp.id, Date.now());
    return sendJSON(res, 200, {
      ok: true, win: !!win, delta: dMe, rating: myRating,
      wins: me.pvp_wins + (win ? 1 : 0), losses: me.pvp_losses + (win ? 0 : 1),
      used: used + 1, cap, oppDelta: dOpp, oppRating,
    });
  }

  // ---------------- 世界 BOSS ----------------

  // PvP 快照八项齐全校验（pvpFight / bossHit / guildBossHit 统一口径）：
  // 只查 atk/hp 两项的旧口径下，缺 def/crit/dr 等字段的脏行会让 simulateBattle
  // 算出 NaN，存库变 NULL 后触发 NOT NULL 约束——该账号此接口永久 500。
  const snapOk = (s) => !!s && typeof s === 'object' && !Array.isArray(s) &&
    ['atk', 'hp', 'def', 'crit', 'critMult', 'lifesteal', 'dr', 'pierce']
      .every((k) => Number.isFinite(Number(s[k])));

  function ensureBoss(today) {
    let boss = stmts.bossOfDay.get(today);
    if (boss) return boss;
    // 血量随全服最强战力伸缩：首日全空时用下限兜底
    const top = stmts.topPower.get().m || 0;
    const maxHp = Math.round(Math.min(BOSS_MAX_HP, Math.max(BOSS_MIN_HP, top * BOSS_HP_PER_POWER)));
    const seed = [...today].reduce((a, c) => a + c.charCodeAt(0), 0);
    const name = BOSS_NAMES[seed % BOSS_NAMES.length] + '妖王';
    stmts.createBoss.run(today, name, maxHp, maxHp, Date.now());
    return stmts.bossOfDay.get(today);
  }

  function bossState(req, res, ctx) {
    const today = dayStr();
    const boss = ensureBoss(today);
    const mine = stmts.myHits.get(today, ctx.user.id) || { damage: 0, hits: 0 };
    return sendJSON(res, 200, {
      day: today, name: boss.name, hp: boss.hp, maxHp: boss.max_hp,
      defeated: boss.hp <= 0, killer: boss.killed_by === ctx.user.id ? 'me' : (boss.killed_by ? 'other' : ''),
      myDamage: mine.damage, myHits: mine.hits, cap: BOSS_DAILY_HITS,
      top: stmts.bossTop.all(today),
    });
  }

  function bossHit(req, res, ctx) {
    const me = stmts.byId.get(ctx.user.id);
    if (!me) return sendJSON(res, 500, { error: '账号状态异常' });
    const today = dayStr();
    const mine = stmts.myHits.get(today, ctx.user.id) || { damage: 0, hits: 0 };
    if (mine.hits >= BOSS_DAILY_HITS) {
      return sendJSON(res, 429, { error: '今日妖王已打过 30 场，歇息吧' });
    }
    const boss = ensureBoss(today);
    // 妖王已被斩落后当日不再受理挑战：原实现不查 hp，击杀后剩余次数仍可对尸体
    // 输出伤害，全额计入世界榜排名（榜单灌水失真）
    if (boss.hp <= 0) {
      return sendJSON(res, 429, { error: '今日妖王已被斩落，明日再来' });
    }
    // 伤害由服务端复算（2026-10-31）：我的 PvP 快照 vs 妖王（血池随 maxHp 伸缩），
    // 客户端上报的 damage 不再采信——改快照/改内存刷伤害排名从此要过快照钳制
    let snap;
    try { snap = JSON.parse(me.pvp_snapshot); } catch (e) { snap = null; }
    if (!snapOk(snap) || !(Number(snap.atk) > 0) || !(Number(snap.hp) > 0)) {
      return sendJSON(res, 400, { error: '战档尚未同步，请稍后再战' });
    }
    const dealt = simulateBattle(snap, bossEnemyOf(boss.max_hp)).dealt;
    // 量级钳制兜底：单场伤害不超过战力 × 300（120 回合理论上限再留余量）；
    // 1e15 硬顶防超 2^53 的伤害值进 world_boss_hits（node:sqlite 读回会 RangeError 砖全服面板）
    const clamped = Math.min(dealt, 1e15, Math.max(1000, me.power_score * 300));
    stmts.hitBoss.run(clamped, boss.hp - clamped <= 0 ? ctx.user.id : null, boss.hp - clamped <= 0 ? Date.now() : null, today);
    stmts.upsertHit.run(today, ctx.user.id, me.display_name || me.username, clamped);
    const after = stmts.bossOfDay.get(today);
    const mineAfter = stmts.myHits.get(today, ctx.user.id);
    return sendJSON(res, 200, {
      ok: true, dealt: clamped, hp: after.hp, maxHp: after.max_hp,
      defeated: after.hp <= 0, myDamage: mineAfter.damage, myHits: mineAfter.hits,
      cap: BOSS_DAILY_HITS,
      killer: after.killed_by === ctx.user.id ? 'me' : (after.killed_by ? 'other' : ''),
    });
  }

  // ---------------- 仙盟 ----------------

  // 盟任务进度：全部从真实行为表聚合（捐献额 / 盟妖王伤害 / 盟员切磋场数），不信客户端自报
  function guildTaskProgress(guildId, today) {
    return {
      donate: stmts.donateSumToday.get(guildId, today).n,
      gboss: stmts.gbossSumToday.get(guildId, today).n,
      pvp: stmts.pvpBattleCount.get(dayStart(), guildId, guildId).n,
    };
  }

  // 盟主妖王：每盟每日一只，血量随成员最高战力与盟等级伸缩，换日重开
  function ensureGuildBoss(guildId, level, today) {
    const boss = stmts.gbossOf.get(guildId);
    if (boss && boss.day === today) return boss;
    const top = stmts.gbossTopPower.get(guildId).m || 0;
    const maxHp = Math.round(Math.min(GBOSS_MAX_HP,
      Math.max(GBOSS_MIN_HP, top * 400 * (1 + 0.25 * (level - 1)))));
    const seed = [...today].reduce((a, c) => a + c.charCodeAt(0), guildId * 7);
    const name = GBOSS_NAMES[seed % GBOSS_NAMES.length] + '凶兽';
    stmts.gbossCreate.run(guildId, today, name, maxHp, maxHp, Date.now());
    return stmts.gbossOf.get(guildId);
  }

  function guildPayload(guildId, userId) {
    const g = stmts.guildGet.get(guildId);
    if (!g) return null;
    const members = stmts.guildMembers.all(guildId).map((m) => ({
      id: m.user_id, name: m.name, power: m.power_score,
      role: m.role, joinedAt: m.joined_at, contribution: m.contribution || 0,
      me: m.user_id === userId,
    }));
    const today = dayStr();
    // 盟任务：进度 + 我今日是否已领
    const progress = guildTaskProgress(guildId, today);
    const tasks = GUILD_TASKS.map((t) => ({
      id: t.id, name: t.name, desc: t.desc,
      progress: progress[t.id] || 0, target: t.target,
      reward: TASK_CLAIM_REWARD,
      claimed: !!stmts.taskClaimed.get(guildId, userId, today, t.id),
    }));
    // 盟主妖王
    const boss = ensureGuildBoss(guildId, guildLevel(g.fund), today);
    const myBoss = stmts.gbossMyHits.get(guildId, userId, today) || { damage: 0, hits: 0 };
    // 贡献商店：今日已购次数
    const shop = GUILD_SHOP.map((it) => {
      const row = stmts.shopBought.get(guildId, userId, it.id, today);
      return { id: it.id, name: it.name, cost: it.cost, times: it.times, bought: row ? row.times : 0 };
    });
    const myContribRow = stmts.myContribution.get(guildId, userId);
    // 同门互助：我今日是否已传功/赠礼，及是否有待领的传功/赠礼
    const aidRow = stmts.aidMe.get(guildId, userId) || {};
    const aidToday = aidRow.aid_day === today;
    // 仙盟共修（2026-11-04）：当日盟池 + 档位 + 我今日捐了几次/各档是否已领
    const cultRow = stmts.cultGet.get(today, guildId);
    const cultStones = cultRow ? cultRow.stones : 0;
    const myCult = stmts.cultLogGet.get(today, guildId, userId);
    const cult = {
      day: today,
      stones: cultStones,
      myTimes: myCult ? myCult.times : 0,
      amount: CULT_AMOUNT,
      cap: CULT_DAILY_TIMES,
      tiers: CULT_TIERS.map((t, i) => ({
        tier: i + 1, name: t.name, need: t.need, stones: t.stones, dust: t.dust,
        reached: cultStones >= t.need,
        claimed: !!stmts.cultClaimGet.get(today, guildId, userId, i + 1),
      })),
    };
    return {
      id: g.id, name: g.name, notice: g.notice, fund: g.fund,
      level: guildLevel(g.fund), levelFund: GUILD_LEVEL_FUND, cap: GUILD_LEVEL_CAP,
      isLeader: g.leader_id === userId,
      myContribution: myContribRow ? myContribRow.contribution : 0,
      tasks, shop, cult,
      aid: {
        skillGiven: aidToday && !!aidRow.aid_skill_to,
        giftGiven: aidToday && !!aidRow.aid_gift_to,
        from: (aidRow.aid_from_day === today && aidRow.aid_from_type)
          ? { type: aidRow.aid_from_type, name: aidRow.aid_from_name }
          : null,
      },
      boss: {
        day: today, name: boss.name, hp: boss.hp, maxHp: boss.max_hp,
        defeated: boss.hp <= 0,
        killer: boss.killed_by === userId ? 'me' : (boss.killed_by ? 'other' : ''),
        myDamage: myBoss.damage, myHits: myBoss.hits, cap: GBOSS_DAILY_HITS,
        top: boss.day === today ? stmts.gbossTop.all(guildId, today) : [],
      },
      members, memberCap: GUILD_CAP,
    };
  }

  function guildState(req, res, ctx) {
    const row = stmts.myGuildRow.get(ctx.user.id);
    if (!row) return sendJSON(res, 200, { guild: null });
    return sendJSON(res, 200, { guild: guildPayload(row.id, ctx.user.id) });
  }

  function guildList(req, res, ctx) {
    return sendJSON(res, 200, {
      list: stmts.guildList.all().map((g) => ({
        id: g.id, name: g.name, fund: g.fund, level: guildLevel(g.fund),
        notice: g.notice, members: g.members, cap: GUILD_CAP,
      })),
    });
  }

  function guildCreate(req, res, ctx) {
    const name = typeof ctx.body?.name === 'string' ? ctx.body.name.trim() : '';
    if (!GUILD_NAME_RE.test(name)) {
      return sendJSON(res, 400, { error: '盟名需 2-8 位中文、英文或数字' });
    }
    // 屏蔽词校验（2026-11-04 用户指令）：盟名公共可见（名录/榜单），命中即拒
    const banned = findBannedWord(name);
    if (banned) {
      return sendJSON(res, 400, { error: '盟名不能含有屏蔽词「' + banned + '」，请更换' });
    }
    if (stmts.myGuildRow.get(ctx.user.id)) {
      return sendJSON(res, 409, { error: '你已在仙盟中，先退盟再创' });
    }
    if (stmts.guildByName.get(name.toLowerCase())) {
      return sendJSON(res, 409, { error: '此盟名已被占用' });
    }
    // 境界门槛（2026-11-01 用户指定）：须达化神（realm 4，users.realm 随存档同步）
    const me = stmts.byId.get(ctx.user.id);
    if (!me || Number(me.realm) < GUILD_CREATE_REALM) {
      return sendJSON(res, 400, { error: '立盟需境界「化神」' });
    }
    // 立盟双币消耗（2026-11-01）：1000 万灵石 + 2 万修为，均走账本原子扣款防重复消费；
    // 灵石不足时退还已扣修为，保证两币种要么都扣要么都不扣
    if (!spendLedgerExp(ctx.user.id, GUILD_CREATE_EXP_COST)) {
      return sendJSON(res, 400, { error: '立盟需 ' + GUILD_CREATE_EXP_COST + ' 修为' });
    }
    if (!spendLedger(ctx.user.id, GUILD_CREATE_COST)) {
      refundLedgerExp(ctx.user.id, GUILD_CREATE_EXP_COST);
      return sendJSON(res, 400, { error: '立盟需 ' + GUILD_CREATE_COST + ' 灵石' });
    }
    const now = Date.now();
    let guildId;
    try {
      guildId = Number(stmts.insertGuild.run(name, name.toLowerCase(), ctx.user.id, now).lastInsertRowid);
    } catch (e) {
      // 盟名冲突回滚双币扣款（非事务多语句，失败路径手工退回）
      refundLedgerExp(ctx.user.id, GUILD_CREATE_EXP_COST);
      stmts.ledgerRefund.run(GUILD_CREATE_COST, ctx.user.id);
      return sendJSON(res, 409, { error: '此盟名已被占用' });
    }
    stmts.joinGuild.run(guildId, ctx.user.id, 'leader', now);
    return sendJSON(res, 200, { ok: true, guild: guildPayload(guildId, ctx.user.id) });
  }

  function guildJoin(req, res, ctx) {
    const guildId = Math.floor(Number(ctx.body?.id));
    if (!guildId) return sendJSON(res, 400, { error: '仙盟不存在' });
    if (stmts.myGuildRow.get(ctx.user.id)) return sendJSON(res, 409, { error: '你已在仙盟中' });
    if (!stmts.guildExists.get(guildId)) {
      return sendJSON(res, 404, { error: '仙盟不存在或已解散' });
    }
    if (stmts.memberCount.get(guildId).n >= GUILD_CAP) {
      return sendJSON(res, 409, { error: '该仙盟已满员' });
    }
    stmts.joinGuild.run(guildId, ctx.user.id, 'member', Date.now());
    return sendJSON(res, 200, { ok: true, guild: guildPayload(guildId, ctx.user.id) });
  }

  function guildLeave(req, res, ctx) {
    const row = stmts.myGuildRow.get(ctx.user.id);
    if (!row) return sendJSON(res, 400, { error: '你尚未加入仙盟' });
    stmts.leaveGuild.run(row.id, ctx.user.id);
    // 盟主退位：转给最早入盟者；无人则解散
    const g = stmts.guildGet.get(row.id);
    if (g && g.leader_id === ctx.user.id) {
      const next = stmts.earliestMember.get(row.id);
      if (next) {
        stmts.setGuildLeader.run(next.user_id, row.id);
        stmts.promoteMember.run(row.id, next.user_id);
      } else {
        stmts.deleteGuild.run(row.id);
      }
    }
    return sendJSON(res, 200, { ok: true });
  }

  function guildKick(req, res, ctx) {
    const targetId = Math.floor(Number(ctx.body?.userId));
    const row = stmts.myGuildRow.get(ctx.user.id);
    if (!row) return sendJSON(res, 400, { error: '你尚未加入仙盟' });
    if (row.role !== 'leader') return sendJSON(res, 403, { error: '仅盟主可移出成员' });
    if (targetId === ctx.user.id) return sendJSON(res, 400, { error: '不能移出自己' });
    const target = stmts.myGuildRow.get(targetId);
    if (!target || target.id !== row.id) return sendJSON(res, 400, { error: '对方不在本盟' });
    stmts.leaveGuild.run(row.id, targetId);
    return sendJSON(res, 200, { ok: true, guild: guildPayload(row.id, ctx.user.id) });
  }

  function guildNotice(req, res, ctx) {
    const text = typeof ctx.body?.text === 'string' ? ctx.body.text : '';
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
    const row = stmts.myGuildRow.get(ctx.user.id);
    if (!row) return sendJSON(res, 400, { error: '你尚未加入仙盟' });
    if (row.role !== 'leader') return sendJSON(res, 403, { error: '仅盟主可改公告' });
    // 屏蔽词校验（2026-11-04 用户指令）：公告全盟可见，命中即拒
    const banned = findBannedWord(clean);
    if (banned) {
      return sendJSON(res, 400, { error: '公告不能含有屏蔽词「' + banned + '」，请修改' });
    }
    stmts.setNotice.run(clean, row.id);
    return sendJSON(res, 200, { ok: true, notice: clean });
  }

  function guildDonate(req, res, ctx) {
    const amount = Math.floor(Number(ctx.body?.amount));
    const row = stmts.myGuildRow.get(ctx.user.id);
    if (!row) return sendJSON(res, 400, { error: '你尚未加入仙盟' });
    if (!Number.isFinite(amount) || amount <= 0) return sendJSON(res, 400, { error: '捐献数额无效' });
    // 余额校验 + 原子扣款（2026-10-31）：堵「零灵石空手刷盟基金/贡献」——账本里没有的灵石捐不出去。
    // 扣款放在日限额裁剪之后：客户端扣的正是返回的 accepted，两边口径一致
    const today = dayStr();
    const cur = stmts.donateRow.get(row.id, ctx.user.id, today);
    const given = cur ? cur.amount : 0;
    if (given >= DONATE_DAILY_CAP) {
      return sendJSON(res, 429, { error: '今日捐献已到上限（10 万灵石）' });
    }
    const accepted = Math.min(amount, DONATE_DAILY_CAP - given);
    if (!spendLedger(ctx.user.id, accepted)) {
      return sendJSON(res, 400, { error: '灵石余额不足' });
    }
    stmts.donateUpsert.run(row.id, ctx.user.id, today, accepted);
    stmts.addFund.run(accepted, row.id);
    // 捐献产出贡献：每 2000 灵石 +1
    const contrib = Math.floor(accepted / DONATE_CONTRIB_PER);
    if (contrib > 0) stmts.addContribution.run(contrib, row.id, ctx.user.id);
    const after = stmts.myContribution.get(row.id, ctx.user.id);
    return sendJSON(res, 200, {
      ok: true, accepted, fund: row.fund + accepted, level: guildLevel(row.fund + accepted),
      todayTotal: given + accepted, cap: DONATE_DAILY_CAP,
      contribution: after ? after.contribution : 0,
    });
  }

  // 盟任务领取：任务完成（服务端聚合口径）且今日未领，发灵石 + 贡献
  function guildTaskClaim(req, res, ctx) {
    const taskId = typeof ctx.body?.taskId === 'string' ? ctx.body.taskId : '';
    const task = GUILD_TASKS.find((t) => t.id === taskId);
    const row = stmts.myGuildRow.get(ctx.user.id);
    if (!row) return sendJSON(res, 400, { error: '你尚未加入仙盟' });
    if (!task) return sendJSON(res, 400, { error: '没有这个盟任务' });
    const today = dayStr();
    const progress = guildTaskProgress(row.id, today)[task.id] || 0;
    if (progress < task.target) return sendJSON(res, 400, { error: '盟任务尚未完成' });
    if (stmts.taskClaimed.get(row.id, ctx.user.id, today, task.id)) {
      return sendJSON(res, 409, { error: '今日该任务已领取' });
    }
    stmts.taskClaim.run(row.id, ctx.user.id, today, task.id);
    stmts.addContribution.run(TASK_CLAIM_REWARD.contribution, row.id, ctx.user.id);
    const after = stmts.myContribution.get(row.id, ctx.user.id);
    return sendJSON(res, 200, {
      ok: true, taskId: task.id, stones: TASK_CLAIM_REWARD.stones,
      contribution: after ? after.contribution : 0,
    });
  }

  // 同门互助（2026-10-31）：每日可向 1 位盟友传功、赠礼各一次，双方受益。
  // 货币归存档管：服务端只记权益（发起记录 + 受赠来源），奖励由客户端结算发放。
  function guildAid(req, res, ctx) {
    const type = ctx.body?.type === 'gift' ? 'gift' : ctx.body?.type === 'skill' ? 'skill' : '';
    const targetId = Math.floor(Number(ctx.body?.targetId));
    const row = stmts.myGuildRow.get(ctx.user.id);
    if (!row) return sendJSON(res, 400, { error: '你尚未加入仙盟' });
    if (!type) return sendJSON(res, 400, { error: '互助类型无效' });
    if (!targetId || targetId === ctx.user.id) return sendJSON(res, 400, { error: '请选择一位同门' });
    const target = stmts.myGuildRow.get(targetId);
    if (!target || target.id !== row.id) return sendJSON(res, 400, { error: '对方不在本盟' });
    const me = stmts.byId.get(ctx.user.id);
    if (!me) return sendJSON(res, 500, { error: '账号状态异常' });
    const today = dayStr();
    const aidRow = stmts.aidMe.get(row.id, ctx.user.id) || {};
    const aidToday = aidRow.aid_day === today;
    const givenCol = type === 'skill' ? 'aid_skill_to' : 'aid_gift_to';
    if (aidToday && aidRow[givenCol]) {
      return sendJSON(res, 429, { error: type === 'skill' ? '今日已传过功' : '今日已赠过礼' });
    }
    // 记发起：aid_day 供两类共用（每次写入带上另一类当天已有值，避免互相覆盖清掉）
    const skillTo = type === 'skill' ? targetId : (aidToday ? aidRow.aid_skill_to : null);
    const giftTo = type === 'gift' ? targetId : (aidToday ? aidRow.aid_gift_to : null);
    stmts.aidSetGive.run(today, skillTo, giftTo, row.id, ctx.user.id);
    // 记受赠（对方今日来源以最后一次为准，领取即清）
    stmts.aidSetFrom.run(type, me.display_name || me.username, today, row.id, targetId);
    return sendJSON(res, 200, { ok: true, guild: guildPayload(row.id, ctx.user.id) });
  }

  function guildAidCollect(req, res, ctx) {
    const row = stmts.myGuildRow.get(ctx.user.id);
    if (!row) return sendJSON(res, 400, { error: '你尚未加入仙盟' });
    const today = dayStr();
    const aidRow = stmts.aidMe.get(row.id, ctx.user.id);
    if (!aidRow || aidRow.aid_from_day !== today || !aidRow.aid_from_type) {
      return sendJSON(res, 404, { error: '今日没有待领的互助' });
    }
    const type = aidRow.aid_from_type;
    const name = aidRow.aid_from_name;
    stmts.aidClearFrom.run(row.id, ctx.user.id);
    return sendJSON(res, 200, { ok: true, type, name });
  }

  // 盟主妖王：与世界妖王同款服务端复算伤害，额外产贡献
  function guildBossHit(req, res, ctx) {
    const row = stmts.myGuildRow.get(ctx.user.id);
    if (!row) return sendJSON(res, 400, { error: '你尚未加入仙盟' });
    const me = stmts.byId.get(ctx.user.id);
    if (!me) return sendJSON(res, 500, { error: '账号状态异常' });
    const today = dayStr();
    const mine = stmts.gbossMyHits.get(row.id, ctx.user.id, today) || { damage: 0, hits: 0 };
    if (mine.hits >= GBOSS_DAILY_HITS) {
      return sendJSON(res, 429, { error: '今日盟妖王已打过 5 场，歇息吧' });
    }
    const boss = ensureGuildBoss(row.id, guildLevel(row.fund), today);
    // 盟妖王同款亡者拦截：击杀后不再受理挑战，防伤害灌水进盟榜与贡献
    if (boss.hp <= 0) {
      return sendJSON(res, 429, { error: '盟妖王已被斩落，明日再来' });
    }
    // 伤害由服务端复算（2026-10-31），与世界妖王同口径（含 1e15 硬顶防砖库）
    let snap;
    try { snap = JSON.parse(me.pvp_snapshot); } catch (e) { snap = null; }
    if (!snapOk(snap) || !(Number(snap.atk) > 0) || !(Number(snap.hp) > 0)) {
      return sendJSON(res, 400, { error: '战档尚未同步，请稍后再战' });
    }
    const dealt = simulateBattle(snap, bossEnemyOf(boss.max_hp)).dealt;
    const clamped = Math.min(dealt, 1e15, Math.max(1000, me.power_score * 300));
    stmts.gbossHit.run(clamped, boss.hp - clamped <= 0 ? ctx.user.id : null,
      boss.hp - clamped <= 0 ? Date.now() : null, Date.now(), row.id);
    stmts.gbossHitUp.run(row.id, ctx.user.id, today, me.display_name || me.username, clamped);
    const contrib = Math.floor(clamped / GBOSS_CONTRIB_PER);
    if (contrib > 0) stmts.addContribution.run(contrib, row.id, ctx.user.id);
    const after = stmts.gbossOf.get(row.id);
    const mineAfter = stmts.gbossMyHits.get(row.id, ctx.user.id, today);
    const afterContrib = stmts.myContribution.get(row.id, ctx.user.id);
    return sendJSON(res, 200, {
      ok: true, dealt: clamped, hp: after.hp, maxHp: after.max_hp,
      defeated: after.hp <= 0, myDamage: mineAfter.damage, myHits: mineAfter.hits,
      cap: GBOSS_DAILY_HITS, contribution: afterContrib ? afterContrib.contribution : 0,
      killer: after.killed_by === ctx.user.id ? 'me' : (after.killed_by ? 'other' : ''),
    });
  }

  // 贡献商店：扣贡献（原子比较防超卖）+ 每日限购，奖励由客户端入包
  function guildShopBuy(req, res, ctx) {
    const itemId = typeof ctx.body?.itemId === 'string' ? ctx.body.itemId : '';
    const item = GUILD_SHOP.find((it) => it.id === itemId);
    const row = stmts.myGuildRow.get(ctx.user.id);
    if (!row) return sendJSON(res, 400, { error: '你尚未加入仙盟' });
    if (!item) return sendJSON(res, 400, { error: '商店没有这件货' });
    const today = dayStr();
    const bought = (stmts.shopBought.get(row.id, ctx.user.id, item.id, today) || { times: 0 }).times;
    if (bought >= item.times) {
      return sendJSON(res, 429, { error: `「${item.name}」今日已购满 ${item.times} 次` });
    }
    const out = stmts.spendContribution.run(item.cost, row.id, ctx.user.id, item.cost);
    if (!out.changes) return sendJSON(res, 400, { error: '贡献不足' });
    stmts.shopBuy.run(row.id, ctx.user.id, item.id, today);
    const after = stmts.myContribution.get(row.id, ctx.user.id);
    return sendJSON(res, 200, {
      ok: true, itemId: item.id, reward: item.reward,
      contribution: after ? after.contribution : 0,
      bought: bought + 1, times: item.times,
    });
  }

  // ---------------- 兑换码 ----------------

  function redeem(req, res, ctx) {
    const code = typeof ctx.body?.code === 'string' ? ctx.body.code.trim().toUpperCase() : '';
    if (!REDEEM_RE.test(code)) return sendJSON(res, 400, { error: '兑换码格式不对' });
    if (stmts.redeemCountToday.get(ctx.user.id, Date.now() - 24 * 3600 * 1000).n >= REDEEM_DAILY_CAP) {
      return sendJSON(res, 429, { error: '今日兑换次数已用完' });
    }
    const row = stmts.codeGet.get(code);
    if (!row) return sendJSON(res, 404, { error: '兑换码不存在' });
    if (row.expires_at && row.expires_at < Date.now()) return sendJSON(res, 410, { error: '兑换码已过期' });
    if (row.max_uses > 0 && row.used_count >= row.max_uses) return sendJSON(res, 410, { error: '兑换码已被领完' });
    if (stmts.codeLogGet.get(code, ctx.user.id)) return sendJSON(res, 409, { error: '该兑换码你已用过' });
    let reward;
    try { reward = JSON.parse(row.reward); } catch (e) { return sendJSON(res, 500, { error: '兑换码配置异常' }); }
    // 奖励面钳制：只认灵石 / 碎屑 / 招募券三项，量级封顶
    const out = {
      stones: Math.min(1e9, Math.max(0, Math.floor(Number(reward.stones) || 0))),
      dust: Math.min(1e6, Math.max(0, Math.floor(Number(reward.dust) || 0))),
      tickets: Math.min(1000, Math.max(0, Math.floor(Number(reward.tickets) || 0))),
    };
    if (out.stones + out.dust + out.tickets <= 0) return sendJSON(res, 500, { error: '兑换码配置异常' });
    db.exec('BEGIN');
    try {
      stmts.codeUse.run(code);
      stmts.codeLog.run(code, ctx.user.id, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return sendJSON(res, 200, { ok: true, reward: out, note: row.note });
  }

  // ---------------- 悬赏妖踪 ----------------

  // 敌人以玩家自己的 PvP 快照为基底缩放（快照已含装备词条；服务端权威公式，
  // game.js bountyEnemyOf 同源）。t1 大多数人可胜，t3 要 Builds 成型才有把握。
  function bountyEnemyOf(snap, mult) {
    return {
      atk: snap.atk * 0.55 * mult,
      hp: snap.hp * 3.2 * mult,
      def: snap.def * 0.8 * mult,
      crit: 0.05, critMult: 2, lifesteal: 0, dr: 0,
      pierce: Math.min(0.3, 0.05 * mult),
    };
  }

  // 当日三妖：名字由日期种子确定性推导（全服同榜）；赏格随个人战力成长、按倍率放大
  function bountyRewardOf(power, mult) {
    const p = Math.max(0, power);
    const stones = Math.round(Math.min(BOUNTY_STONE_CAP, BOUNTY_STONE_BASE + Math.floor(p * BOUNTY_STONE_PER_POWER)) * mult);
    const dust = Math.round(Math.min(BOUNTY_DUST_CAP, BOUNTY_DUST_BASE + Math.floor(p * BOUNTY_DUST_PER_POWER)) * mult);
    return { stones, dust };
  }

  function bountyState(req, res, ctx) {
    const me = stmts.byId.get(ctx.user.id);
    const power = me ? me.power_score : 0;
    const today = dayStr();
    const seed = [...today].reduce((a, c) => a + c.charCodeAt(0), 0);
    const elites = BOUNTY_TIERS.map((t, slot) => {
      const rec = stmts.bountyGet.get(today, ctx.user.id, slot);
      return {
        slot,
        name: ELITE_NAMES[(seed + slot * 3) % ELITE_NAMES.length],
        title: t.title,
        mult: t.mult,
        reward: bountyRewardOf(power, t.mult),
        done: !!rec,
        win: rec ? !!rec.win : false,
        stones: rec && rec.win ? rec.stones : 0,
        dust: rec && rec.win ? rec.dust : 0,
      };
    });
    return sendJSON(res, 200, { day: today, elites });
  }

  function bountyFight(req, res, ctx) {
    const slot = Math.floor(Number(ctx.body && ctx.body.slot));
    if (!(slot >= 0 && slot < BOUNTY_TIERS.length)) return sendJSON(res, 400, { error: '参数无效' });
    const me = stmts.byId.get(ctx.user.id);
    if (!me) return sendJSON(res, 500, { error: '账号状态异常' });
    const today = dayStr();
    if (stmts.bountyGet.get(today, me.id, slot)) {
      return sendJSON(res, 429, { error: '这只妖将今日已交过手，明日再来' });
    }
    // 胜负由服务端复算（同 PvP/妖王口径）：快照八项缺失走 409 且不占当日场次
    let snap = null;
    try { snap = JSON.parse(me.pvp_snapshot); } catch (e) { /* 快照缺失 */ }
    if (!snapOk(snap)) {
      return sendJSON(res, 409, { error: '战斗快照未就绪，已触发重新同步，几秒后再战' });
    }
    if (!stmts.ledgerRow.get(me.id)) return sendJSON(res, 409, { error: '存档同步中，稍后再战' });
    const tier = BOUNTY_TIERS[slot];
    const sim = simulateBattle(snap, bountyEnemyOf(snap, tier.mult));
    const win = sim.win ? 1 : 0;
    const rw = win ? bountyRewardOf(me.power_score, tier.mult) : { stones: 0, dust: 0 };
    db.exec('BEGIN');
    try {
      stmts.bountyIns.run(today, me.id, slot, win, sim.dealt || 0, rw.stones, rw.dust, Date.now());
      if (win) {
        stmts.ledgerAddStonesDust.run(rw.stones, rw.stones, rw.dust, me.id);
        stmts.logAction.run(me.id, today, 'bounty', rw.stones, rw.dust, 0, 0, Date.now());
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return sendJSON(res, 200, { ok: true, win: !!win, stones: rw.stones, dust: rw.dust, done: true });
  }

  // ---------------- 回忆之战（红尘再启） ----------------

  // 周键与客户端 weekKey / saves.js 同口径（年内第 N 周，非严格 ISO，两端一致即可）
  function memoryWeekKey(now = Date.now()) {
    const d = new Date(now);
    return d.getFullYear() + '-W' + Math.floor((d - new Date(d.getFullYear(), 0, 1)) / (7 * 86400000));
  }

  // 敌人以玩家自己的 PvP 快照为基底缩放（快照已含装备词条；服务端权威公式，
  // game.js memoryEnemyOf 同源）。比悬赏同倍率更肉：回忆里的旧敌都硬得很。
  function memoryEnemyOf(snap, mult) {
    return {
      atk: snap.atk * 0.6 * mult,
      hp: snap.hp * 4.5 * mult,
      def: snap.def * 0.9 * mult,
      crit: 0.05, critMult: 2, lifesteal: 0, dr: 0,
      pierce: Math.min(0.3, 0.06 * mult),
    };
  }

  function memoryRewardOf(power, mult) {
    const p = Math.max(0, power);
    return {
      stones: Math.round(Math.min(MEMORY_STONE_CAP, MEMORY_STONE_BASE + Math.floor(p * MEMORY_STONE_PER_POWER)) * mult),
      dust: Math.round(Math.min(MEMORY_DUST_CAP, MEMORY_DUST_BASE + Math.floor(p * MEMORY_DUST_PER_POWER)) * mult),
    };
  }

  function memoryState(req, res, ctx) {
    const me = stmts.byId.get(ctx.user.id);
    const power = me ? me.power_score : 0;
    const week = memoryWeekKey();
    const seed = [...week].reduce((a, c) => a + c.charCodeAt(0), 0);
    const boss = MEMORY_BOSSES[seed % MEMORY_BOSSES.length];
    const mult = 1.6 + 0.2 * (seed % 4); // 1.6 / 1.8 / 2.0 / 2.2 周轮换
    const done = !!me && me.memory_week === week;
    return sendJSON(res, 200, {
      week,
      boss: { name: boss.name, title: boss.title, desc: boss.desc, mult },
      reward: memoryRewardOf(power, mult),
      done,
      win: false, // 胜负在 fight 响应与账本里；state 只报「本周是否已出战」
    });
  }

  function memoryFight(req, res, ctx) {
    const me = stmts.byId.get(ctx.user.id);
    if (!me) return sendJSON(res, 500, { error: '账号状态异常' });
    const week = memoryWeekKey();
    if (me.memory_week === week) {
      return sendJSON(res, 429, { error: '回忆之战本周已交过手，下周再来' });
    }
    // 胜负由服务端复算（同悬赏口径）：快照八项缺失走 409 且不占本周场次
    let snap = null;
    try { snap = JSON.parse(me.pvp_snapshot); } catch (e) { /* 快照缺失 */ }
    if (!snapOk(snap)) {
      return sendJSON(res, 409, { error: '战斗快照未就绪，已触发重新同步，几秒后再战' });
    }
    if (!stmts.ledgerRow.get(me.id)) return sendJSON(res, 409, { error: '存档同步中，稍后再战' });
    const seed = [...week].reduce((a, c) => a + c.charCodeAt(0), 0);
    const boss = MEMORY_BOSSES[seed % MEMORY_BOSSES.length];
    const mult = 1.6 + 0.2 * (seed % 4);
    const sim = simulateBattle(snap, memoryEnemyOf(snap, mult));
    const win = sim.win ? 1 : 0;
    const rw = win ? memoryRewardOf(me.power_score, mult) : { stones: 0, dust: 0 };
    db.exec('BEGIN');
    try {
      stmts.memoryWeekSet.run(week, me.id); // 胜负都占周（防重打）
      if (win) {
        stmts.ledgerAddStonesDust.run(rw.stones, rw.stones, rw.dust, me.id);
        stmts.logAction.run(me.id, dayStr(), 'memory', rw.stones, rw.dust, 0, 0, Date.now());
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return sendJSON(res, 200, { ok: true, win: !!win, stones: rw.stones, dust: rw.dust, done: true });
  }

  // ---------------- 洞府访客 ----------------

  // 今日访客：名字与台词按（日期 + uid）种子确定性推导；服务端为文案与结果唯一权威
  function visitorState(req, res, ctx) {
    const me = stmts.byId.get(ctx.user.id);
    const power = me ? me.power_score : 0;
    const today = dayStr();
    const seed = [...today].reduce((a, c) => a + c.charCodeAt(0), 0) + ctx.user.id * 7;
    const v = VISITORS[seed % VISITORS.length];
    const say = v.say[(seed >> 3) % v.say.length];
    const rec = stmts.visitorGet.get(today, ctx.user.id);
    return sendJSON(res, 200, {
      day: today,
      visitor: {
        name: v.name, say,
        choices: [
          { id: 'duel', label: '切磋', desc: '与访客过上两招，胜得彩头', stones: visitorDuelReward(power).stones, dust: visitorDuelReward(power).dust },
          { id: 'gift', label: '赠礼', desc: '奉上 ' + fmtStones(VISITOR_GIFT_COST) + ' 灵石修好', dust: VISITOR_GIFT_REWARD.dust, bait: VISITOR_GIFT_REWARD.bait },
          { id: 'ask', label: '求教', desc: '听访客论道，得束脩', stones: visitorAskReward(power) },
        ],
      },
      acted: rec ? rec.choice : '',
      win: rec ? !!rec.win : false,
      stones: rec ? rec.stones : 0,
      dust: rec ? rec.dust : 0,
    });
  }

  const fmtStones = (n) => n >= 1e4 ? Math.round(n / 1e4) + ' 万' : String(n);

  function visitorDuelReward(power) {
    const p = Math.max(0, power);
    return {
      stones: Math.round(Math.min(VISITOR_DUEL_STONE_CAP, VISITOR_DUEL_STONE_BASE + Math.floor(p * VISITOR_DUEL_STONE_PER_POWER))),
      dust: Math.round(Math.min(VISITOR_DUEL_DUST_CAP, VISITOR_DUEL_DUST_BASE + Math.floor(p * VISITOR_DUEL_DUST_PER_POWER))),
    };
  }

  const visitorAskReward = (power) => Math.round(Math.min(
    VISITOR_ASK_STONE_CAP, VISITOR_ASK_STONE_BASE + Math.floor(Math.max(0, power) * VISITOR_ASK_STONE_PER_POWER)));

  function visitorAct(req, res, ctx) {
    const choice = typeof ctx.body?.choice === 'string' ? ctx.body.choice : '';
    if (!['duel', 'gift', 'ask'].includes(choice)) return sendJSON(res, 400, { error: '参数无效' });
    const me = stmts.byId.get(ctx.user.id);
    if (!me) return sendJSON(res, 500, { error: '账号状态异常' });
    const today = dayStr();
    const rec = stmts.visitorGet.get(today, me.id);
    if (rec) return sendJSON(res, 429, { error: '今日已接待过访客，明日再来' });
    if (!stmts.ledgerRow.get(me.id)) return sendJSON(res, 409, { error: '存档同步中，稍后再来' });

    let out = { stones: 0, dust: 0 };
    let win = 0;
    if (choice === 'duel') {
      // 胜负服务端复算（同悬赏口径）：快照八项缺失走 409 且不占当日场次
      let snap = null;
      try { snap = JSON.parse(me.pvp_snapshot); } catch (e) { /* 快照缺失 */ }
      if (!snapOk(snap)) {
        return sendJSON(res, 409, { error: '战斗快照未就绪，已触发重新同步，几秒后再试' });
      }
      const sim = simulateBattle(snap, {
        atk: snap.atk * VISITOR_DUEL_ENEMY.atk,
        hp: snap.hp * VISITOR_DUEL_ENEMY.hp,
        def: snap.def * VISITOR_DUEL_ENEMY.def,
        crit: 0.05, critMult: 2, lifesteal: 0, dr: 0,
        pierce: VISITOR_DUEL_ENEMY.pierce,
      });
      win = sim.win ? 1 : 0;
      if (win) out = visitorDuelReward(me.power_score);
    } else if (choice === 'gift') {
      // 余额校验 + 原子扣款（guildDonate 同口径）：扣款失败 400，不占当日
      if (!spendLedger(me.id, VISITOR_GIFT_COST)) {
        return sendJSON(res, 400, { error: '灵石余额不足' });
      }
      out = { stones: 0, dust: VISITOR_GIFT_REWARD.dust };
    } else {
      out = { stones: visitorAskReward(me.power_score), dust: 0 };
    }
    db.exec('BEGIN');
    try {
      stmts.visitorIns.run(today, me.id, choice, win, out.stones, out.dust, Date.now());
      if (out.stones > 0 || out.dust > 0) {
        stmts.ledgerAddStonesDust.run(out.stones, out.stones, out.dust, me.id);
        stmts.logAction.run(me.id, today, 'visitor_' + choice, out.stones, out.dust, 0, 0, Date.now());
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return sendJSON(res, 200, {
      ok: true, choice, win: !!win, stones: out.stones, dust: out.dust,
      bait: choice === 'gift' ? VISITOR_GIFT_REWARD.bait : 0,
      spent: choice === 'gift' ? VISITOR_GIFT_COST : 0,
    });
  }

  // ---------------- 仙盟共修 ----------------

  // 捐灵石入盟池（固定数额，账本原子扣款）；池满档全盟领奖
  function guildCultDonate(req, res, ctx) {
    const row = stmts.myGuildRow.get(ctx.user.id);
    if (!row) return sendJSON(res, 400, { error: '你尚未加入仙盟' });
    const today = dayStr();
    const cur = stmts.cultLogGet.get(today, row.id, ctx.user.id);
    const times = cur ? cur.times : 0;
    if (times >= CULT_DAILY_TIMES) {
      return sendJSON(res, 429, { error: '今日共修已到上限（' + CULT_DAILY_TIMES + ' 次）' });
    }
    if (!spendLedger(ctx.user.id, CULT_AMOUNT)) {
      return sendJSON(res, 400, { error: '灵石余额不足' });
    }
    const memberCount = stmts.guildMemberCount.get(row.id);
    db.exec('BEGIN');
    try {
      stmts.cultIns.run(today, row.id, CULT_AMOUNT, memberCount ? memberCount.n : 0, Date.now());
      stmts.cultLogUp.run(today, row.id, ctx.user.id, CULT_AMOUNT, Date.now());
      const after = stmts.cultGet.get(today, row.id);
      db.exec('COMMIT');
      return sendJSON(res, 200, {
        ok: true, stones: after ? after.stones : 0, myTimes: times + 1, cap: CULT_DAILY_TIMES,
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // 达档全盟领奖：达档即可领（无需自己捐过），每人每档一次/日；服务端直发账本 + 授权流水
  function guildCultClaim(req, res, ctx) {
    const tier = Math.floor(Number(ctx.body?.tier));
    const def = CULT_TIERS[tier - 1];
    const row = stmts.myGuildRow.get(ctx.user.id);
    if (!row) return sendJSON(res, 400, { error: '你尚未加入仙盟' });
    if (!def) return sendJSON(res, 400, { error: '没有这个共修档位' });
    const today = dayStr();
    const cultRow = stmts.cultGet.get(today, row.id);
    const stones = cultRow ? cultRow.stones : 0;
    if (stones < def.need) return sendJSON(res, 400, { error: '共修尚未达到「' + def.name + '」' });
    if (stmts.cultClaimGet.get(today, row.id, ctx.user.id, tier)) {
      return sendJSON(res, 429, { error: '今日该档位已领取' });
    }
    if (!stmts.ledgerRow.get(ctx.user.id)) return sendJSON(res, 409, { error: '存档同步中，稍后再领' });
    db.exec('BEGIN');
    try {
      stmts.cultClaimIns.run(today, row.id, ctx.user.id, tier, Date.now());
      stmts.ledgerAddStonesDust.run(def.stones, def.stones, def.dust, ctx.user.id);
      stmts.logAction.run(ctx.user.id, today, 'guild_cult', def.stones, def.dust, 0, 0, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return sendJSON(res, 200, { ok: true, tier, stones: def.stones, dust: def.dust });
  }

  // ---------------- 路由分发 ----------------

  // POST 统一走限流；GET 放行。返回 true 表示已处理。
  function handle(req, res, ctx) {
    const { method, pathname } = ctx;
    const write = method === 'POST';
    if (write && !writeWindow.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '操作太频繁，稍后再试' });
    }
    switch (pathname) {
      case '/api/rank':        return rank(req, res, ctx), true;
      case '/api/rank/inspect': return write ? (rankInspect(req, res, ctx), true) : false;
      case '/api/ladder':      return ladder(req, res, ctx), true;
      case '/api/pvp':         return pvpState(req, res, ctx), true;
      case '/api/pvp/buy':     return write ? (pvpBuy(req, res, ctx), true) : false;
      case '/api/pvp/fight':   return write ? (pvpFight(req, res, ctx), true) : false;
      case '/api/boss':        return bossState(req, res, ctx), true;
      case '/api/boss/hit':    return write ? (bossHit(req, res, ctx), true) : false;
      case '/api/guild':       return guildState(req, res, ctx), true;
      case '/api/guild/list':  return guildList(req, res, ctx), true;
      case '/api/guild/create': return write ? (guildCreate(req, res, ctx), true) : false;
      case '/api/guild/join':  return write ? (guildJoin(req, res, ctx), true) : false;
      case '/api/guild/leave': return write ? (guildLeave(req, res, ctx), true) : false;
      case '/api/guild/kick':  return write ? (guildKick(req, res, ctx), true) : false;
      case '/api/guild/notice': return write ? (guildNotice(req, res, ctx), true) : false;
      case '/api/guild/donate': return write ? (guildDonate(req, res, ctx), true) : false;
      case '/api/guild/task/claim': return write ? (guildTaskClaim(req, res, ctx), true) : false;
      case '/api/guild/boss/hit': return write ? (guildBossHit(req, res, ctx), true) : false;
      case '/api/guild/shop/buy': return write ? (guildShopBuy(req, res, ctx), true) : false;
      case '/api/guild/aid': return write ? (guildAid(req, res, ctx), true) : false;
      case '/api/guild/aid/collect': return write ? (guildAidCollect(req, res, ctx), true) : false;
      case '/api/bounty':      return bountyState(req, res, ctx), true;
      case '/api/bounty/fight': return write ? (bountyFight(req, res, ctx), true) : false;
      case '/api/memory':      return memoryState(req, res, ctx), true;
      case '/api/memory/fight': return write ? (memoryFight(req, res, ctx), true) : false;
      case '/api/ladder/pay':  return write ? (ladderPay(req, res, ctx), true) : false;
      // 洞府访客 / 仙盟共修（2026-11-04 日常扩容）
      case '/api/visitor':       return visitorState(req, res, ctx), true;
      case '/api/visitor/act':   return write ? (visitorAct(req, res, ctx), true) : false;
      case '/api/guild/cult':        return write ? (guildCultDonate(req, res, ctx), true) : false;
      case '/api/guild/cult/claim':  return write ? (guildCultClaim(req, res, ctx), true) : false;
      case '/api/redeem':      return write ? (redeem(req, res, ctx), true) : false;
      default:                 return false;
    }
  }

  return { handle };
}
