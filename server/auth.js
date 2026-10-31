// 账号服务：scrypt 口令哈希、会话、注册 / 登录 / 登出，含防爆破与防刷
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { sendJSON, randomToken, sha256, sleep, SlidingWindow } from './http-util.js';

const scrypt = promisify(crypto.scrypt);

const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEY_LEN = 32;
const SESSION_TTL = 7 * 24 * 3600 * 1000;      // 会话 7 天
const SESSION_RENEW = 3 * 24 * 3600 * 1000;    // 剩余不足 3 天时滑动续期
const MAX_FAILS = 5;                            // 连续失败 5 次锁定
const LOCK_BASE_MS = 15 * 60 * 1000;           // 首次锁 15 分钟，之后翻倍
const LOCK_CAP_MS = 24 * 3600 * 1000;          // 锁定上限 24 小时
const LOGIN_IP_WINDOW = { ms: 10 * 60 * 1000, max: 20 };   // 每 IP 10 分钟最多 20 次登录尝试
const LOGIN_NAME_WINDOW = { ms: 15 * 60 * 1000, max: 30 }; // 同一账号 15 分钟内全网最多 30 次失败
const REG_IP_WINDOW = { ms: 3600 * 1000, max: 5 };          // 每 IP 每小时最多注册 5 个
const REG_IP_DAILY = 10;                                    // 每 IP 24 小时最多注册 10 个（查库，重启不失效）
const AUTH_DELAY = [200, 400];                              // 登录 / 注册响应随机延迟，抬高爆破成本
const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{2,16}$/;
const DISPLAY_NAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{2,16}$/;

const RESERVED = new Set([
  'admin', 'administrator', 'root', 'system', 'gm', 'mod', 'moderator', 'owner',
  'staff', 'official', 'api', 'null', 'undefined', '官方', '管理员', '系统', '客服',
]);

const DUMMY_HASH = hashPasswordSync(crypto.randomBytes(18).toString('base64url'));

function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [tag, n, r, p, saltB64, keyB64] = String(stored).split('$');
    // 参数钉死为当前常量：库里的哈希全部由本服务写入，异参数即脏数据，直接拒绝，
    // 防止被篡改的超大 N 让 scrypt 分配巨量内存拖垮服务
    if (tag !== 'scrypt' || +n !== SCRYPT_N || +r !== SCRYPT_R || +p !== SCRYPT_P) return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expect = Buffer.from(keyB64, 'base64');
    const key = await scrypt(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    return key.length === expect.length && crypto.timingSafeEqual(key, expect);
  } catch (e) {
    return false;
  }
}

function cookieHeader(token, secure, maxAge) {
  let head = `lx_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  if (secure) head += '; Secure';
  return head;
}

function logAttempt(db, username, ip, ok) {
  db.prepare('INSERT INTO login_attempts (username, ip, ok, created_at) VALUES (?, ?, ?, ?)')
    .run(username || null, ip, ok ? 1 : 0, Date.now());
}

// 锁定时长：随失败次数指数退避（15 分钟起步，翻倍，封顶 24 小时）
function lockDuration(failedLogins) {
  const step = Math.max(1, Math.floor(failedLogins / MAX_FAILS));
  return Math.min(LOCK_BASE_MS * 2 ** (step - 1), LOCK_CAP_MS);
}

export function createAuthService(db) {
  const loginIpWindow = new SlidingWindow(LOGIN_IP_WINDOW.ms, LOGIN_IP_WINDOW.max);
  const regIpWindow = new SlidingWindow(REG_IP_WINDOW.ms, REG_IP_WINDOW.max);
  const stmts = {
    byName: db.prepare('SELECT * FROM users WHERE username_lower = ?'),
    byId: db.prepare('SELECT id, username, display_name, status, power_score, created_at, guild_id, display_name_at FROM users WHERE id = ?'),
    setDisplayName: db.prepare('UPDATE users SET display_name = ?, display_name_at = ? WHERE id = ?'),
    displayNameExists: db.prepare('SELECT 1 FROM users WHERE display_name = ? AND id != ?'),
    insertUser: db.prepare(
      'INSERT INTO users (username, username_lower, password_hash, created_at, created_ip, last_login_at, last_login_ip, display_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    insertSession: db.prepare(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)'),
    sessionByHash: db.prepare(
      `SELECT s.token_hash, s.expires_at, s.user_id, u.username, u.status, u.power_score, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`),
    renewSession: db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?'),
    delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    // 单会话互踢：新登录删除该用户全部旧会话，仅保留最后登录的设备/窗口
    delUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    delExpired: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    resetFails: db.prepare('UPDATE users SET failed_logins = 0, locked_until = 0, last_login_at = ?, last_login_ip = ? WHERE id = ?'),
    addFail: db.prepare('UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ?'),
    setLock: db.prepare('UPDATE users SET locked_until = ? WHERE id = ?'),
    failCount: db.prepare(
      'SELECT COUNT(*) AS n FROM login_attempts WHERE username = ? AND ok = 0 AND created_at > ?'),
    regCountIp: db.prepare('SELECT COUNT(*) AS n FROM users WHERE created_ip = ? AND created_at > ?'),
    delOldAttempts: db.prepare('DELETE FROM login_attempts WHERE created_at < ?'),
  };

  function createSession(userId, ip, ua, secure) {
    const token = randomToken();
    const now = Date.now();
    stmts.insertSession.run(sha256(token), userId, now, now + SESSION_TTL, ip, ua || null);
    return { token, cookie: cookieHeader(token, secure, SESSION_TTL / 1000) };
  }

  // 从请求解析会话；顺带滑动续期。返回用户基本信息或 null。
  function getSessionUser(req) {
    const cookies = parseCookieHeader(req.headers.cookie);
    const token = cookies.lx_session;
    if (!token) return null;
    const row = stmts.sessionByHash.get(sha256(token));
    if (!row) return null;
    const now = Date.now();
    if (row.expires_at <= now) {
      stmts.delSession.run(row.token_hash);
      return null;
    }
    if (row.status !== 'active') return null;
    if (row.expires_at - now < SESSION_RENEW) {
      stmts.renewSession.run(now + SESSION_TTL, row.token_hash);
    }
    return { id: row.user_id, username: row.username, powerScore: row.power_score, createdAt: row.created_at };
  }

  function parseCookieHeader(header) {
    const out = {};
    if (typeof header !== 'string' || !header) return out;
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx < 0) continue;
      out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return out;
  }

  function clearCookie(secure) {
    return cookieHeader('', secure, 0);
  }

  // ---------------- 路由处理器（ctx: { ip, secure, body, ua }） ----------------

  async function register(req, res, ctx) {
    const { ip, secure, body } = ctx;
    // 限流前置：被限的请求不做随机延迟，尽早甩掉连接
    if (!regIpWindow.hit(ip)) {
      return sendJSON(res, 429, { error: '注册过于频繁，请一小时后再试' }, { 'Retry-After': '3600' });
    }
    await sleep(AUTH_DELAY[0] + Math.random() * (AUTH_DELAY[1] - AUTH_DELAY[0]));
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    if (stmts.regCountIp.get(ip, dayAgo).n >= REG_IP_DAILY) {
      return sendJSON(res, 429, { error: '该网络注册账号数已达上限，请明天再试' }, { 'Retry-After': '86400' });
    }
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!USERNAME_RE.test(username) || RESERVED.has(username.toLowerCase())) {
      return sendJSON(res, 400, { error: '道号需为 2-16 位中文、英文、数字或下划线，且不与保留名冲突' });
    }
    if (password.length < 8 || password.length > 64 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      return sendJSON(res, 400, { error: '口令需 8-64 位，且同时包含字母与数字' });
    }
    const lower = username.toLowerCase();
    if (stmts.byName.get(lower)) {
      return sendJSON(res, 409, { error: '该道号已被占用' });
    }
    const hash = await hashPassword(password);
    const now = Date.now();
    let userId;
    try {
      userId = Number(stmts.insertUser.run(username, lower, hash, now, ip, now, ip, username).lastInsertRowid);
    } catch (e) {
      return sendJSON(res, 409, { error: '该道号已被占用' });
    }
    // 单会话互踢（新号无旧会话，防御性保持口径一致）
    stmts.delUserSessions.run(userId);
    logAttempt(db, lower, ip, true);
    const sess = createSession(userId, ip, ctx.ua, secure);
    return sendJSON(res, 200, { ok: true, username }, { 'Set-Cookie': sess.cookie });
  }

  async function login(req, res, ctx) {
    const { ip, secure, body } = ctx;
    // 限流前置：同上，被限的 IP 不占随机延迟
    if (!loginIpWindow.hit(ip)) {
      return sendJSON(res, 429, { error: '尝试过于频繁，请稍后再试' }, { 'Retry-After': '600' });
    }
    await sleep(AUTH_DELAY[0] + Math.random() * (AUTH_DELAY[1] - AUTH_DELAY[0]));
    const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const user = username ? stmts.byName.get(username) : null;

    // 账号锁定：不区分「被锁」与「限流」，避免向爆破方泄露账号状态
    if (user && user.locked_until > Date.now()) {
      logAttempt(db, username, ip, false);
      return sendJSON(res, 429, { error: '尝试过于频繁，请稍后再试' }, { 'Retry-After': '600' });
    }
    const qStart = Date.now();
    if (username && stmts.failCount.get(username, qStart - LOGIN_NAME_WINDOW.ms).n >= LOGIN_NAME_WINDOW.max) {
      return sendJSON(res, 429, { error: '尝试过于频繁，请稍后再试' }, { 'Retry-After': '900' });
    }

    // 无此用户也跑一遍哈希，抹平响应时间差，防用户枚举
    const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      logAttempt(db, username, ip, false);
      if (user) {
        stmts.addFail.run(user.id);
        const failed = user.failed_logins + 1;
        if (failed >= MAX_FAILS) stmts.setLock.run(Date.now() + lockDuration(failed), user.id);
      }
      return sendJSON(res, 401, { error: '道号或口令错误' });
    }

    stmts.resetFails.run(Date.now(), ip, user.id);
    logAttempt(db, username, ip, true);
    // 单会话互踢：清掉该账号全部旧会话，旧设备/旧窗口的下一个请求即 401 下线
    stmts.delUserSessions.run(user.id);
    const sess = createSession(user.id, ip, ctx.ua, secure);
    return sendJSON(res, 200, { ok: true, username: user.username }, { 'Set-Cookie': sess.cookie });
  }

  function logout(req, res, ctx) {
    const cookies = parseCookieHeader(req.headers.cookie);
    if (cookies.lx_session) stmts.delSession.run(sha256(cookies.lx_session));
    return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(ctx.secure) });
  }

  function me(req, res, ctx) {
    const user = getSessionUser(req);
    if (!user) return sendJSON(res, 401, { error: '未登录' });
    const row = stmts.byId.get(user.id);
    if (!row) return sendJSON(res, 500, { error: '账号状态异常' });
    return sendJSON(res, 200, {
      username: user.username,
      displayName: row.display_name || user.username,
      powerScore: user.powerScore,
    });
  }

  // 改显示名：唯一 + 24 小时一次；道号（登录名）不变
  function setDisplayName(req, res, ctx) {
    const user = getSessionUser(req);
    if (!user) return sendJSON(res, 401, { error: '未登录' });
    const name = typeof ctx.body?.name === 'string' ? ctx.body.name.trim() : '';
    if (!DISPLAY_NAME_RE.test(name)) {
      return sendJSON(res, 400, { error: '显示名需为 2-16 位中文、英文、数字或下划线' });
    }
    const row = stmts.byId.get(user.id);
    if (!row) return sendJSON(res, 500, { error: '账号状态异常' });
    if (name === row.display_name) return sendJSON(res, 200, { ok: true, displayName: name });
    if (Date.now() - row.display_name_at < 24 * 3600 * 1000) {
      return sendJSON(res, 429, { error: '显示名 24 小时只能改一次' });
    }
    if (stmts.displayNameExists.get(name, user.id)) {
      return sendJSON(res, 409, { error: '该显示名已被使用' });
    }
    try {
      stmts.setDisplayName.run(name, Date.now(), user.id);
    } catch (e) {
      return sendJSON(res, 409, { error: '该显示名已被使用' });
    }
    return sendJSON(res, 200, { ok: true, displayName: name });
  }

  // 周期清理：过期会话与 30 天前的登录流水
  function cleanup() {
    const now = Date.now();
    stmts.delExpired.run(now);
    stmts.delOldAttempts.run(now - 30 * 24 * 3600 * 1000);
  }

  return {
    register, login, logout, me, setDisplayName,
    getSessionUser, cleanup, byId: (id) => stmts.byId.get(id),
  };
}
