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
];

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
  db.exec(SCHEMA);
  for (const [col, ddl] of USER_COLUMNS) ensureColumn(db, 'users', col, ddl);
  ensureColumn(db, 'guilds', 'fund', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'guild_members', 'contribution', 'INTEGER NOT NULL DEFAULT 0');
  // 显示名唯一（可空）；老账号回填 display_name = username，只跑一次由 NULL 判定自然幂等
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_display ON users(display_name) WHERE display_name IS NOT NULL');
  db.prepare("UPDATE users SET display_name = username WHERE display_name IS NULL").run();
  return db;
}
