// 天下玩法服务：战力排行 / PvP 竞技场 / 世界 BOSS / 仙盟 / 兑换码（零依赖）
// 原则：天梯分、血条、盟务、兑换状态以本服务为准。2026-10-31 起战斗结算也服务端化：
// PvP 胜负、妖王伤害由服务端用双方 PvP 快照复算（battle.js），客户端上报不采信；
// 灵石类花费（加购/立盟/捐献）凭增速账本余额（save_ledger，saves.js 维护）校验。
import { sendJSON, SlidingWindow } from './http-util.js';
import { simulateBattle, bossEnemyOf } from './battle.js';

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
    byId: db.prepare('SELECT id, username, display_name, realm, power_score, guild_id, pvp_rating, pvp_wins, pvp_losses, pvp_snapshot, pvp_day, pvp_used, pvp_buys, pvp_buy_day, last_pvp_at FROM users WHERE id = ?'),
    // PvP（真人候选池不含假人；假人由 botCandidates 按战力就近补位）
    candidates: db.prepare(
      `SELECT id, COALESCE(NULLIF(display_name, ''), username) AS name, realm, power_score, pvp_rating, pvp_snapshot, 0 AS bot
       FROM users WHERE id != ? AND status = 'active' AND pvp_snapshot IS NOT NULL
       ORDER BY ABS(pvp_rating - ?) LIMIT 8`),
    botCandidates: db.prepare(
      `SELECT id, COALESCE(NULLIF(display_name, ''), username) AS name, realm, power_score, pvp_rating, pvp_snapshot, 1 AS bot
       FROM users WHERE status = 'bot' AND pvp_snapshot IS NOT NULL
       ORDER BY ABS(power_score - ?) LIMIT 6`),
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
    clearUserGuild: db.prepare('UPDATE users SET guild_id = NULL WHERE id = ?'),
    donateRow: db.prepare('SELECT amount FROM guild_donations WHERE guild_id = ? AND user_id = ? AND day = ?'),
    donateUpsert: db.prepare(
      `INSERT INTO guild_donations (guild_id, user_id, day, amount) VALUES (?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id, day) DO UPDATE SET amount = amount + excluded.amount`),
    setUsersGuild: db.prepare('UPDATE users SET guild_id = ? WHERE id = ?'),
    // 兑换码
    codeGet: db.prepare('SELECT * FROM redeem_codes WHERE code = ? AND deleted = 0'),
    codeUse: db.prepare('UPDATE redeem_codes SET used_count = used_count + 1 WHERE code = ?'),
    codeLog: db.prepare('INSERT INTO redeem_log (code, user_id, created_at) VALUES (?, ?, ?)'),
    codeLogGet: db.prepare('SELECT 1 FROM redeem_log WHERE code = ? AND user_id = ?'),
    redeemCountToday: db.prepare(
      `SELECT COUNT(*) AS n FROM redeem_log WHERE user_id = ? AND created_at > ?`),
    guildGet: db.prepare('SELECT id, name, notice, fund, leader_id FROM guilds WHERE id = ?'),
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
    return sendJSON(res, 200, {
      top,
      me: { rank: myGames > 0 ? myRow : 0, rating: myRating, wins: me ? me.pvp_wins : 0, losses: me ? me.pvp_losses : 0 },
    });
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
    return {
      id: g.id, name: g.name, notice: g.notice, fund: g.fund,
      level: guildLevel(g.fund), levelFund: GUILD_LEVEL_FUND, cap: GUILD_LEVEL_CAP,
      isLeader: g.leader_id === userId,
      myContribution: myContribRow ? myContribRow.contribution : 0,
      tasks, shop,
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
    stmts.setUsersGuild.run(guildId, ctx.user.id);
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
    stmts.setUsersGuild.run(guildId, ctx.user.id);
    return sendJSON(res, 200, { ok: true, guild: guildPayload(guildId, ctx.user.id) });
  }

  function guildLeave(req, res, ctx) {
    const row = stmts.myGuildRow.get(ctx.user.id);
    if (!row) return sendJSON(res, 400, { error: '你尚未加入仙盟' });
    stmts.leaveGuild.run(row.id, ctx.user.id);
    stmts.clearUserGuild.run(ctx.user.id);
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
    stmts.clearUserGuild.run(targetId);
    return sendJSON(res, 200, { ok: true, guild: guildPayload(row.id, ctx.user.id) });
  }

  function guildNotice(req, res, ctx) {
    const text = typeof ctx.body?.text === 'string' ? ctx.body.text : '';
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
    const row = stmts.myGuildRow.get(ctx.user.id);
    if (!row) return sendJSON(res, 400, { error: '你尚未加入仙盟' });
    if (row.role !== 'leader') return sendJSON(res, 403, { error: '仅盟主可改公告' });
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
      case '/api/redeem':      return write ? (redeem(req, res, ctx), true) : false;
      default:                 return false;
    }
  }

  return { handle };
}
