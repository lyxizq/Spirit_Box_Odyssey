// SQLite 连接与建表（node:sqlite，零依赖）。数据库文件放 data/，已被 .gitignore 排除。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL,
  username_lower TEXT    NOT NULL UNIQUE,
  password_hash  TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'active',
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   INTEGER NOT NULL DEFAULT 0,
  power_score    INTEGER NOT NULL DEFAULT 0,
  guild_id       INTEGER,
  created_at     INTEGER NOT NULL,
  created_ip     TEXT,
  last_login_at  INTEGER,
  last_login_ip  TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_power      ON users(power_score DESC);
CREATE INDEX IF NOT EXISTS idx_users_guild      ON users(guild_id);
CREATE INDEX IF NOT EXISTS idx_users_created_ip ON users(created_ip, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT,
  ip         TEXT,
  ok         INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_ip   ON login_attempts(ip, created_at);
CREATE INDEX IF NOT EXISTS idx_attempts_name ON login_attempts(username, created_at);

CREATE TABLE IF NOT EXISTS game_saves (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT    NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  size       INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 仙盟（fund 为捐献基金，等级由基金换算，等级本身不落库）
CREATE TABLE IF NOT EXISTS guilds (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  name_lower TEXT    NOT NULL UNIQUE,
  leader_id  INTEGER NOT NULL REFERENCES users(id),
  notice     TEXT    NOT NULL DEFAULT '',
  level      INTEGER NOT NULL DEFAULT 1,
  fund       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guild_members (
  guild_id  INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT    NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_guild_members_guild ON guild_members(guild_id);
-- 捐献流水：按人按日限额的依据
CREATE TABLE IF NOT EXISTS guild_donations (
  guild_id  INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day       TEXT    NOT NULL,
  amount    INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, day)
);
-- 盟任务领取：每盟每人每日每任务一次
CREATE TABLE IF NOT EXISTS guild_task_claims (
  guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      TEXT    NOT NULL,
  task_id  TEXT    NOT NULL,
  PRIMARY KEY (guild_id, user_id, day, task_id)
);
-- 盟主妖王：每盟一行共享血条（day 为当日），伤害按人按日聚合
CREATE TABLE IF NOT EXISTS guild_boss (
  guild_id    INTEGER PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  day         TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  hp          INTEGER NOT NULL,
  max_hp      INTEGER NOT NULL,
  killed_by   INTEGER,
  defeated_at INTEGER,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guild_boss_hits (
  guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      TEXT    NOT NULL,
  name     TEXT    NOT NULL,
  damage   INTEGER NOT NULL DEFAULT 0,
  hits     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_guild_boss_hits ON guild_boss_hits(guild_id, day, damage DESC);
-- 贡献商店限购：按人按物按日计数
CREATE TABLE IF NOT EXISTS guild_shop_log (
  guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id  TEXT    NOT NULL,
  day      TEXT    NOT NULL,
  times    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, item_id, day)
);
-- PvP 天梯分直接挂 users 列（pvp_rating / pvp_wins / pvp_losses），对局入流水表
CREATE TABLE IF NOT EXISTS pvp_seasons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  starts_at  INTEGER NOT NULL,
  ends_at    INTEGER NOT NULL,
  settled    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pvp_battles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id   INTEGER REFERENCES pvp_seasons(id),
  attacker_id INTEGER NOT NULL,
  defender_id INTEGER NOT NULL,
  winner_id   INTEGER,
  replay      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pvp_attacker ON pvp_battles(attacker_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pvp_defender ON pvp_battles(defender_id, created_at);
-- 世界 BOSS：按日一行共享血条（day 为 YYYY-MM-DD），伤害流水按人按日聚合
CREATE TABLE IF NOT EXISTS world_boss (
  day         TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  hp          INTEGER NOT NULL,
  max_hp      INTEGER NOT NULL,
  killed_by   INTEGER,
  defeated_at INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS world_boss_hits (
  day     TEXT    NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name    TEXT    NOT NULL,
  damage  INTEGER NOT NULL DEFAULT 0,
  hits    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id)
);
CREATE INDEX IF NOT EXISTS idx_boss_hits_day ON world_boss_hits(day, damage DESC);
-- 兑换码：reward 为 JSON {stones, dust, tickets}；max_uses 0 = 不限次
CREATE TABLE IF NOT EXISTS redeem_codes (
  code       TEXT    PRIMARY KEY,
  reward     TEXT    NOT NULL,
  max_uses   INTEGER NOT NULL DEFAULT 0,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  note       TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS redeem_log (
  code       TEXT    NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (code, user_id)
);
-- 存档增速账本（2026-10-31）：上次入库存档的关键计数器快照。
-- saves.js 每次收档做单调性 + 增速校验（economy.js），social.js 借它做灵石余额校验。
-- 无该行的账号首次上传存档时以当档种入基线（存量玩家平滑迁移，不做回溯追溯）。
-- 大数值列一律 REAL：node:sqlite 读 INTEGER 列 > 2^53 会抛 RangeError 砖号（实测），
-- REAL 读回 1e18 精确表示（5^18<2^53），误差只往宽松方向，不破坏单调/增速判定。
CREATE TABLE IF NOT EXISTS save_ledger (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stones       REAL    NOT NULL DEFAULT 0,   -- 当前灵石余额（可负债）
  total_stones REAL    NOT NULL DEFAULT 0,   -- 历史累计灵石收益
  dust_total   REAL    NOT NULL DEFAULT 0,   -- 历史累计碎屑收益
  opens        REAL    NOT NULL DEFAULT 0,   -- 历史累计开箱次数
  exp          REAL    NOT NULL DEFAULT 0,   -- 当前修为（突破/飞升会消耗，不做单调校验）
  pet_tickets  INTEGER NOT NULL DEFAULT 0,   -- 招募券余额
  ascensions   INTEGER NOT NULL DEFAULT 0,   -- 轮回次数（放大战力天花板，增速限死）
  immortal     INTEGER NOT NULL DEFAULT 0,   -- 仙位（放大战力天花板，增速限死）
  power        REAL    NOT NULL DEFAULT 0,   -- 穿戴六件重算的装备战力（收益包络基准）
  tower_cleared INTEGER NOT NULL DEFAULT 0,  -- 爬塔/闯关/无尽/野外最深进度（只进不退，单调校验）
  stage_cleared INTEGER NOT NULL DEFAULT 0,
  endless_best INTEGER NOT NULL DEFAULT 0,
  wild_max     INTEGER NOT NULL DEFAULT 0,
  grants       INTEGER NOT NULL DEFAULT 1,   -- 离线补结豁免次数（种子=1，用掉即清；防调钟每窗刷离线额度）
  updated_at   INTEGER NOT NULL
);
-- 动作授权日志（2026-11-01 全量服务端校验迁移）：服务端动作端点发放的每一笔收益
-- （征战奖励/离线结算/兑换码…）都记一行，checkVelocity 的授权收益统计从「只认
-- 兑换码」扩为「读本表」——服务端发的收益不再触发客户端存档的「余额跳变」误拒。
CREATE TABLE IF NOT EXISTS action_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  stones     REAL    NOT NULL DEFAULT 0,
  dust       REAL    NOT NULL DEFAULT 0,
  tickets    REAL    NOT NULL DEFAULT 0,
  exp        REAL    NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_log_user_time ON action_log(user_id, created_at);
`;

// 老库补列：SCHEMA 里的 CREATE IF NOT EXISTS 不会给已存在的表加新列，这里按需 ALTER。
// 列已存在时 ALTER 报错，吞掉即可（幂等）。
function ensureColumn(db, table, col, ddl) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  } catch (e) { /* 列已存在 */ }
}

const USER_COLUMNS = [
  ['display_name',    'TEXT'],
  ['display_name_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['realm',        "TEXT    NOT NULL DEFAULT ''"],
  ['pvp_rating',   'INTEGER NOT NULL DEFAULT 1000'],
  ['pvp_wins',     'INTEGER NOT NULL DEFAULT 0'],
  ['pvp_losses',   'INTEGER NOT NULL DEFAULT 0'],
  ['pvp_snapshot', 'TEXT'],
  ['pvp_day',      "TEXT    NOT NULL DEFAULT ''"],
  ['pvp_used',     'INTEGER NOT NULL DEFAULT 0'],
  ['pvp_buys',     'INTEGER NOT NULL DEFAULT 0'],
  ['pvp_buy_day',  "TEXT    NOT NULL DEFAULT ''"],
  ['last_pvp_at',  'INTEGER NOT NULL DEFAULT 0'],
  // 征战体力（2026-11-01 用户指令，服务端裁定）：一场 1 点、每日 300 点、5 分钟回 1 点。
  // 数值只存服务端，客户端仅持有最近一次同步的展示快照；stamina_day 为上次每日回满的本地日
  ['stamina',      'INTEGER NOT NULL DEFAULT 300'],
  ['stamina_ts',   'INTEGER NOT NULL DEFAULT 0'],
  ['stamina_day',  "TEXT    NOT NULL DEFAULT ''"],
];

// 账本权威进度/计数列（2026-11-01 全量服务端校验迁移）：征战进度与每日计数以服务端
// 为准（JSON 列存野外已探区列表 / 每区击杀数 / 扫荡每日计数），存档镜像仅作展示。
export const LEDGER_COLUMNS = [
  ['wild_cleared',   "TEXT    NOT NULL DEFAULT '[]'"],
  ['wild_kills',     "TEXT    NOT NULL DEFAULT '{}'"],
  ['wild_repeat_day', "TEXT   NOT NULL DEFAULT ''"],
  ['wild_repeat_used', 'INTEGER NOT NULL DEFAULT 0'],
  ['sweep_day',      "TEXT    NOT NULL DEFAULT ''"],
  ['sweep_used',     "TEXT    NOT NULL DEFAULT '{}'"],
  ['sweep_bought',   "TEXT    NOT NULL DEFAULT '{}'"],
  // 条件试炼（2026-11-01 上收服务端）：通关标记以服务端当日 done 表为准，防改档/回滚重复领奖
  ['trial_day',      "TEXT    NOT NULL DEFAULT ''"],
  ['trial_done',     "TEXT    NOT NULL DEFAULT '[]'"],
  ['offline_at',     'INTEGER NOT NULL DEFAULT 0'],
];

// 账本表迁移（2026-10-31 复审）：早版把 stones 等建成 INTEGER，node:sqlite 读 >2^53 的
// 行直接 RangeError（砖掉云存档与消费接口）。检测到旧列型就在 SQL 引擎内 CAST 成 REAL
// 重建（CAST 不经过 JS 读取，不会触发 RangeError）；账本本身可由存档重种，重建零风险。
function migrateLedger(db) {
  const cols = db.prepare("PRAGMA table_info('save_ledger')").all();
  if (!cols.length) return; // 表还不存在，交给 SCHEMA 新建
  const stones = cols.find((c) => c.name === 'stones');
  if (!stones || stones.type.toUpperCase() === 'REAL') return;
  db.exec('ALTER TABLE save_ledger RENAME TO save_ledger_old;');
  db.exec(`CREATE TABLE save_ledger (
    user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    stones       REAL    NOT NULL DEFAULT 0,
    total_stones REAL    NOT NULL DEFAULT 0,
    dust_total   REAL    NOT NULL DEFAULT 0,
    opens        REAL    NOT NULL DEFAULT 0,
    exp          REAL    NOT NULL DEFAULT 0,
    pet_tickets  INTEGER NOT NULL DEFAULT 0,
    ascensions   INTEGER NOT NULL DEFAULT 0,
    immortal     INTEGER NOT NULL DEFAULT 0,
    power        REAL    NOT NULL DEFAULT 0,
    tower_cleared INTEGER NOT NULL DEFAULT 0,
    stage_cleared INTEGER NOT NULL DEFAULT 0,
    endless_best INTEGER NOT NULL DEFAULT 0,
    wild_max     INTEGER NOT NULL DEFAULT 0,
    grants       INTEGER NOT NULL DEFAULT 1,
    updated_at   INTEGER NOT NULL
  );`);
  db.exec(`INSERT INTO save_ledger (user_id, stones, total_stones, dust_total, opens, exp,
      pet_tickets, ascensions, immortal, power, tower_cleared, stage_cleared, endless_best,
      wild_max, grants, updated_at)
    SELECT user_id, CAST(stones AS REAL), CAST(total_stones AS REAL), CAST(dust_total AS REAL),
      CAST(opens AS REAL), CAST(exp AS REAL), pet_tickets, ascensions, immortal,
      CAST(power AS REAL), tower_cleared, stage_cleared, endless_best, wild_max,
      1, updated_at
    FROM save_ledger_old
    WHERE user_id IN (SELECT id FROM users);`); // 孤儿行（无对应用户）直接丢弃，防外键约束炸启动
  db.exec('DROP TABLE save_ledger_old;');
}

// journal 模式可调：默认 WAL（读写并发好）；但 WAL 依赖 -wal/-shm 共享内存 mmap，
// 在老内核（CentOS 7 的 3.10）、SELinux 或特殊挂载上会报 disk I/O error（778 FSTAT），
// 此时设 DB_JOURNAL=delete 退回回滚日志。本服务单进程单连接，牺牲并发无实际影响。
const JOURNAL_MODES = new Set(['wal', 'delete', 'truncate', 'persist', 'memory', 'off']);
const DB_JOURNAL = JOURNAL_MODES.has((process.env.DB_JOURNAL || '').toLowerCase())
  ? process.env.DB_JOURNAL.toLowerCase()
  : 'wal';

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = ${DB_JOURNAL};`);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  // 写锁等待：codes.js 等 CLI 与常驻服务共用同一个库文件，不设 busy_timeout
  // 时撞上服务端写入会直接抛 SQLITE_BUSY 使命令失败
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrateLedger(db); // 必须在 SCHEMA 之后：账本表外键引用 users，users 先建好迁移才不炸
  for (const [col, ddl] of USER_COLUMNS) ensureColumn(db, 'users', col, ddl);
  ensureColumn(db, 'guilds', 'fund', 'INTEGER NOT NULL DEFAULT 0');
  // 兑换码软删（2026-10-31）：rm 不再物理删行——redeemSince 统计授权收益靠 LEFT JOIN
  // reward，硬删会让已兑换玩家后续存档被增速校验误拒多日
  ensureColumn(db, 'redeem_codes', 'deleted', 'INTEGER NOT NULL DEFAULT 0');
  // 连点器检测（2026-10-31 服务端判定）：累计手动点击数 + 点击封禁截止时间
  ensureColumn(db, 'save_ledger', 'clicks', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'save_ledger', 'click_ban_until', 'INTEGER NOT NULL DEFAULT 0');
  // 权威进度/计数列（2026-11-01 全量服务端校验迁移）：必须排在 migrateLedger 之后
  // ——旧 INTEGER 表重建后新列才不会丢
  for (const [col, ddl] of LEDGER_COLUMNS) ensureColumn(db, 'save_ledger', col, ddl);
  // 客户端已确认基线（2026-11-01 防砖修复）：combat/social 服务端结算只加主计数列而
  // 不改存档体，客户端没吸收（结算后刷新/多开/断线）时单调性对比主列会判「回退」，
  // 把账号永久拒收（线上实测：零增量回推都 400）。cli_sync 存最近一次成功推送的
  // 计数快照（JSON），单调性对比它；NULL 回退主列（旧行兼容），reset 时一并清空
  ensureColumn(db, 'save_ledger', 'cli_sync', 'TEXT');
  ensureColumn(db, 'guild_members', 'contribution', 'INTEGER NOT NULL DEFAULT 0');
  // 同门互助（2026-10-31）：传功 / 赠礼记账——发起方记日期，受赠方记来源（领取后清除）
  ensureColumn(db, 'guild_members', 'aid_day',        "TEXT    NOT NULL DEFAULT ''");
  ensureColumn(db, 'guild_members', 'aid_skill_to',   'INTEGER');
  ensureColumn(db, 'guild_members', 'aid_gift_to',    'INTEGER');
  ensureColumn(db, 'guild_members', 'aid_from_type',  "TEXT    NOT NULL DEFAULT ''");
  ensureColumn(db, 'guild_members', 'aid_from_name',  "TEXT    NOT NULL DEFAULT ''");
  ensureColumn(db, 'guild_members', 'aid_from_day',   "TEXT    NOT NULL DEFAULT ''");
  // 显示名唯一（可空）；老账号回填 display_name = username，只跑一次由 NULL 判定自然幂等。
  // 回填兜底 try/catch：历史库若已有 display_name 恰等于某 NULL 行 username 的组合，
  // 回填会撞唯一索引抛错把 openDb 打崩（服务起不来）；撞了记日志跳过，留给人工对账
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_display ON users(display_name) WHERE display_name IS NOT NULL');
  try {
    db.prepare("UPDATE users SET display_name = username WHERE display_name IS NULL").run();
  } catch (e) {
    console.error('[db] display_name 回填撞唯一索引（历史数据冲突，跳过）：' + e.message);
  }
  return db;
}
