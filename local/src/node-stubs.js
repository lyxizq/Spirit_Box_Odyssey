// node:sqlite / node:fs / node:path 的浏览器替身：让 server/db.js **一字不改**
// 在浏览器里跑起来（esbuild 插件把三个内置模块 import 改道到此文件）。
//
// DatabaseSync 以 sql.js（SQLite 的 wasm 编译，vendor/sql-wasm.js）为引擎，
// 内存库 + 由 persist.js 负责把 db.export() 字节落 localStorage。
// 语义对齐 node:sqlite（StatementSync）：
//   - prepare(sql).get/all/run(...)   位置参数绑定
//   - run() 返回 { changes, lastInsertRowid }
//   - exec(sql)  多语句执行（SCHEMA / BEGIN…COMMIT / PRAGMA）
// 已知的可接受差异：journal_mode=wal 在内存库里退化为 memory（无并发语义差异，
// 本地单连接）；整数超过 2^53 与 node:sqlite 同样按 double 读取（服务端大数值列
// 本就建为 REAL，见 db.js SCHEMA 注释，口径一致）。

// 屏蔽词库原文（build-local.mjs 构建期注入的虚拟模块，见下方 fsStub）
import { LEXICON } from 'lx-local:lexicon';

const g = typeof globalThis !== 'undefined' ? globalThis : window;

function sqlJs() {
  const SQL = g.__LX_SQL; // boot.js 初始化后挂到全局
  if (!SQL) throw new Error('sql.js 尚未初始化（boot 顺序错误）');
  return SQL;
}

// —— node:sqlite StatementSync 同形包装 ——
// 薄门面：语句实例不长期持有，按 SQL 文本从 DatabaseSync 的存活缓存里现取——
// sql.js 的 export() 内部会 close 再 reopen 底层句柄（落盘/导出备份必经之路），
// 缓存里的已编译语句随之全部作废；门面在每次执行时向存活缓存要语句，导出后
// 由 DatabaseSync 清缓存重编译，服务端模块持有的语句引用因此始终有效。
class StatementSync {
  constructor(dbSync, sql) {
    this._dbs = dbSync;
    this._sql = sql;
  }
  _live() {
    return this._dbs._live(this._sql);
  }
  get(...params) {
    const s = this._live();
    s.reset();
    if (params.length) s.bind(params);
    try {
      return s.step() ? s.getAsObject() : undefined;
    } finally {
      s.reset();
    }
  }
  all(...params) {
    const s = this._live();
    s.reset();
    if (params.length) s.bind(params);
    const rows = [];
    try {
      while (s.step()) rows.push(s.getAsObject());
    } finally {
      s.reset();
    }
    return rows;
  }
  run(...params) {
    const s = this._live();
    s.reset();
    if (params.length) s.bind(params);
    try {
      s.step();
    } finally {
      s.reset();
    }
    const changes = this._dbs._db.getRowsModified();
    const rid = this._dbs._db.exec('SELECT last_insert_rowid() AS id');
    const lastInsertRowid = rid.length && rid[0].values.length ? Number(rid[0].values[0][0]) : 0;
    return { changes, lastInsertRowid };
  }
}

export class DatabaseSync {
  constructor(_path /* 内存库：路径仅兼容签名，忽略 */) {
    const SQL = sqlJs();
    this._db = new SQL.Database();
    this._stmts = new Map();
  }
  prepare(sql) {
    return new StatementSync(this, sql);
  }
  // 存活的 sql.js 语句（export/导入后由本类负责清缓存重编译）
  _live(sql) {
    let s = this._stmts.get(sql);
    if (!s) {
      s = this._db.prepare(sql);
      this._stmts.set(sql, s);
    }
    return s;
  }
  exec(sql) {
    this._db.exec(sql);
  }
  close() {
    try { this._db.close(); } catch (e) { /* 幂等 */ }
  }
  // —— 本地版扩展（仅本地基础设施使用，服务端模块不调用）——
  // 导出整库字节（persist.js 落盘 / 导出备份用）。
  // sql.js export() 会 close+reopen 底层句柄：之后所有已编译语句作废，必须清缓存。
  exportBytes() {
    const bytes = this._db.export();
    this._stmts.clear();
    return bytes;
  }

  // 整库导入：连接与已 prepare 的语句全部保留（服务端模块的语句缓存不失效），
  // 逐表把备份库的行搬进当前连接（DELETE + 批量 INSERT，同一事务）。
  // 校验：必须是本游戏的库（users 表存在且恰好一个 active 用户 = 本机单账号）。
  // 返回搬入的行数统计；不合法抛 Error（由调用方提示，不影响当前库）。
  importBytes(bytes) {
    const SQL = sqlJs();
    // 文件头卫兵：非 SQLite 字节（含纯垃圾）绝不喂给 wasm 引擎（喂了会 abort 整个模块）
    const magic = 'SQLite format 3\0';
    if (bytes.length < 100 || Array.from({ length: magic.length }, (_, i) => String.fromCharCode(bytes[i])).join('') !== magic) {
      throw new Error('备份文件不是有效的 SQLite 数据库');
    }
    let src;
    try {
      src = new SQL.Database(bytes);
    } catch (e) {
      throw new Error('备份文件无法解析为数据库：' + (e && e.message ? e.message : e));
    }
    try {
      const tables = src.exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name");
      if (!tables.length) throw new Error('备份文件不是有效的游戏数据库');
      const names = tables[0].values.map((r) => r[0]);
      if (!names.includes('users')) throw new Error('备份文件缺少用户表，不是本游戏的存档');
      const active = src.exec("SELECT COUNT(*) FROM users WHERE status = 'active'");
      const n = Number(active[0].values[0][0]);
      if (n !== 1) throw new Error('备份存档账号数异常（' + n + ' 个 active 账号），已拒绝导入');
      // 表结构须与当前连接一致（版本错配防御）：列集不同即拒绝
      for (const t of names) {
        const a = this._columnsOf(t);
        const b = src.exec('PRAGMA table_info(\'' + t.replace(/'/g, "''") + '\')');
        const bCols = b[0] ? b[0].values.map((r) => r[1]) : [];
        if (a.join(',') !== bCols.join(',')) {
          throw new Error('备份表结构与当前版本不一致（' + t + '），请升级游戏后重试');
        }
      }
      // 表间引用顺序不可控（字母序会让 game_saves 先于 users），导入期临时关 FK：
      // SQLite 的 foreign_keys 是连接级开关（事务外可切），导完即恢复
      this._db.exec('PRAGMA foreign_keys = OFF');
      this._db.exec('BEGIN IMMEDIATE');
      try {
        let rows = 0;
        for (const t of names) {
          const cols = this._columnsOf(t);
          const collist = cols.map((c) => '"' + c.replace(/"/g, '""') + '"').join(',');
          this._db.exec('DELETE FROM "' + t.replace(/"/g, '""') + '"');
          const ins = this._db.prepare(
            'INSERT INTO "' + t.replace(/"/g, '""') + '" (' + collist + ') VALUES (' + cols.map(() => '?').join(',') + ')');
          const sel = src.prepare('SELECT ' + collist + ' FROM "' + t.replace(/"/g, '""') + '"');
          try {
            while (sel.step()) {
              const row = sel.get();
              ins.run(cols.map((_, i) => row[i]));
              rows++;
            }
          } finally {
            sel.free();
          }
        }
        // AUTOINCREMENT 水位随备份走（users.id 等续号不冲突）
        const seq = src.exec("SELECT name FROM sqlite_master WHERE type='table' AND name = 'sqlite_sequence'");
        if (seq.length && seq[0].values.length) {
          this._db.exec('DELETE FROM sqlite_sequence');
          const srows = src.exec('SELECT name, seq FROM sqlite_sequence');
          if (srows.length) {
            const ins = this._db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)');
            for (const r of srows[0].values) ins.run([r[0], r[1]]);
          }
        }
        this._db.exec('COMMIT');
        this._db.exec('PRAGMA foreign_keys = ON');
        return rows;
      } catch (e) {
        this._db.exec('ROLLBACK');
        this._db.exec('PRAGMA foreign_keys = ON');
        throw e;
      }
    } finally {
      try { src.close(); } catch (e) { /* 幂等 */ }
    }
  }

  _columnsOf(table) {
    const r = this._db.exec('PRAGMA table_info(\'' + table.replace(/'/g, "''") + '\')');
    return r[0] ? r[0].values.map((row) => row[1]) : [];
  }
}

// —— node:fs / node:path 最小替身：db.js 只用到 mkdirSync / dirname / join ——
// esbuild 插件把 node:fs / node:path / node:sqlite 三个内置模块改为虚拟模块，
// 分别从这里转出（fs/path 默认导出、sqlite 具名导出 DatabaseSync）
//
// moderation.js 启动时按「自身所在目录/lexicon/Vocabulary」读词库 txt（= server/lexicon，
// 真实服务端 8000+ 屏蔽词的来源）。浏览器没有 fs：build-local.mjs 在构建期把
// server/lexicon/Vocabulary/*.txt 原文打进 lx-local:lexicon 虚拟模块，这里按路径后缀原样
// 交出，屏蔽词校验与真实服务端同一份词库。（2026-11-23 修复：此前对任何路径都返回
// 空列表，moderation.js 静默退回 53 个手写兜底词，本地版的显示名 / 盟名校验形同虚设）
const LEX_DIR_RE = /(^|\/)lexicon\/Vocabulary\/?$/;
const lexFileOf = (p) => {
  if (typeof p !== 'string') return null;
  const m = /(^|\/)lexicon\/Vocabulary\/([^/]+)$/.exec(p);
  return m && Object.prototype.hasOwnProperty.call(LEXICON, m[2]) ? m[2] : null;
};
export const fsStub = {
  mkdirSync() { /* 内存库无需建目录 */ },
  readdirSync(p) { return LEX_DIR_RE.test(String(p)) ? Object.keys(LEXICON) : []; },
  readFileSync(p) {
    const f = lexFileOf(p);
    if (f) return LEXICON[f];
    throw new Error('local edition: no fs');
  },
};

export const urlStub = {
  fileURLToPath() { return '.'; },
};
export function fileURLToPath() { return '.'; }

export const pathStub = {
  dirname() { return '.'; },
  join(...parts) { return parts.join('/'); },
  resolve(...parts) { return parts.join('/'); },
};
