// 灵匣纪元服务端入口：静态托管 + 账号 / 会话 / 云存档 API（零依赖，node:sqlite）
// 启动：node server/index.js（PORT / DB_PATH 环境变量可覆盖，默认 8080 与 data/game.db）
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createAuthService } from './auth.js';
import { createSaveService } from './saves.js';
import { createSocialService } from './social.js';
import { createStaminaService } from './stamina.js';
import { createCombatService } from './combat.js';
import { sendJSON, readBody, getIp, isSecure, sameOrigin, acceptsGzip, gzipBody, GZIP_MIN_SIZE } from './http-util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'game.db');
// 回源鉴权（可选）：设置后非本机请求必须携带同值 x-origin-token 头，供 EdgeOne
// 免费版（无「源站防护」回源网段功能）锁源使用；EdgeOne 侧用规则引擎给回源请求加同名头。
const ORIGIN_TOKEN = process.env.ORIGIN_TOKEN || '';

const db = openDb(DB_PATH);
const auth = createAuthService(db);
const saves = createSaveService(db);
const social = createSocialService(db);
const stamina = createStaminaService(db);
const combat = createCombatService(db, stamina);

const SESSION_COOKIE = 'lx_session';
const AUTH_BODY_LIMIT = 32 * 1024;    // 登录 / 注册请求体上限
const SAVE_BODY_LIMIT = 512 * 1024;   // 存档请求体上限（与服务端校验一致）

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
};

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  // HTTPS 部署下强制后续走 TLS（HTTP 明文响应里按规范被浏览器忽略，无害）
  'Strict-Transport-Security': 'max-age=15552000',
};

// 登录页与游戏页同一份严格 CSP：两页均无内联脚本、无内联事件（game.js 生成的 HTML 亦然）
const PAGE_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...BASE_HEADERS });
  res.end();
}

// 页面文件内存缓存：按 mtime 失效，免去每请求 readFileSync；gz 惰性压缩并缓存（首遇 gzip 请求才算）
const htmlCache = new Map();
function sendHtml(req, res, file, headers = {}) {
  const full = path.join(ROOT, file);
  let entry = htmlCache.get(full);
  try {
    const mtime = fs.statSync(full).mtimeMs;
    if (!entry || entry.mtime !== mtime) {
      entry = { mtime, body: fs.readFileSync(full), gz: null };
      htmlCache.set(full, entry);
    }
  } catch (e) {
    return notFound(res);
  }
  const gz = acceptsGzip(req) && entry.body.length >= GZIP_MIN_SIZE;
  if (gz && !entry.gz) entry.gz = gzipBody(entry.body);
  res.writeHead(200, {
    'Content-Type': MIME['.html'],
    // 页面完全不缓存：杜绝 EdgeOne 等边缘节点留存旧版页面
    'Cache-Control': 'no-store',
    'Vary': 'Accept-Encoding',
    ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
    ...BASE_HEADERS,
    ...headers,
  });
  res.end(gz ? entry.gz : entry.body);
}

// gzip 压缩的文本扩展（jpg/png/webp/gif/mp3 等本已压缩格式一律流式透传不压）
const GZIP_TEXT = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt']);
// 静态文本压缩缓存：full -> { mtime, body, gz }（本项目文本静态仅个位数文件，防膨胀上限仅作纵深）
const staticTextCache = new Map();
const STATIC_TEXT_CACHE_MAX = 64;

// 静态文件：白名单根目录约束 + 扩展名 MIME，路径穿越直接 403
function serveStatic(req, res, urlPath) {
  // urlPath 在请求入口已 decodeURIComponent 一次；此处绝不再解——二次解码会让
  // %252e%252e（双重编码的 ..）穿透白名单读到 server/docs 等敏感文件
  const rel = urlPath;
  // 封死残余穿越面：任何 .. / . 路径段与空字节直接 403（不依赖 normalize 善后）
  if (rel.includes('\0') || /(^|\/)\.\.?(\/|$)/.test(rel)) return forbidden(res);
  // 文档 / 服务端源码 / 构建目录不对外：.md 在 MIME 表里会当文本发出，
  // docs/（交接文档与部署手册）、server/、docker/ 一律按不存在处理
  if (/^\/(docs|docker|server|data|\.claude|\.research|\.zcode|\.git)\//.test(rel)) return notFound(res);
  const full = path.normalize(path.join(ROOT, rel));
  if (!full.startsWith(ROOT + path.sep) && full !== ROOT) return forbidden(res);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch (e) {
    return notFound(res);
  }
  if (!stat.isFile()) return notFound(res);
  const ext = path.extname(full).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return forbidden(res); // 只发文本/图片/音频等已知类型，防误发任意文件
  if (ext === '.md') return notFound(res); // 文档一律不对外（.md 有 MIME 映射，防 assets 误放文档泄露）
  const cacheHeaders = {
    'Content-Type': mime,
    // html/js/css 三件套必须同版本且无版本号查询串：no-store 完全不缓存，
    // 杜绝 EdgeOne 等边缘节点留存旧版脚本/样式造成的前后端版本错配；
    // 图片类资源内容不变，允许边缘缓存 1 小时
    'Cache-Control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-store' : 'public, max-age=3600',
    ...BASE_HEADERS,
  };
  if (GZIP_TEXT.has(ext)) {
    // 文本静态：读全量进缓存 + gzip 惰性压缩（文本文件均 MB 级以下）
    let entry = staticTextCache.get(full);
    if (!entry || entry.mtime !== stat.mtimeMs) {
      if (staticTextCache.size >= STATIC_TEXT_CACHE_MAX) staticTextCache.clear();
      entry = { mtime: stat.mtimeMs, body: fs.readFileSync(full), gz: null };
      staticTextCache.set(full, entry);
    }
    const gz = acceptsGzip(req) && entry.body.length >= GZIP_MIN_SIZE;
    if (gz && !entry.gz) entry.gz = gzipBody(entry.body);
    res.writeHead(200, {
      ...cacheHeaders,
      'Vary': 'Accept-Encoding',
      ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
    });
    return res.end(gz ? entry.gz : entry.body);
  }
  res.writeHead(200, cacheHeaders);
  // 流错误必须自接：pipe 不处理源流 error，statSync 之后文件被替换/删除（部署竞态）、
  // EACCES/EIO 等错误事件会在异步回调里抛成 uncaughtException，整个进程退出。
  const stream = fs.createReadStream(full);
  stream.on('error', () => { res.destroy(); });
  stream.pipe(res);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...BASE_HEADERS });
  res.end('404 Not Found');
}

function forbidden(res) {
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...BASE_HEADERS });
  res.end('403 Forbidden');
}

function loggedIn(req) {
  return Boolean(auth.getSessionUser(req));
}

function isLoopback(req) {
  const addr = req.socket && req.socket.remoteAddress;
  if (!addr) return false;
  return addr === '::1' || addr === '127.0.0.1' || addr.startsWith('::ffff:127.');
}

// ORIGIN_TOKEN 校验：本机回环豁免（运维 curl / 宝塔探活），其余请求密钥必须匹配。
// timingSafeEqual 防计时逐位猜密钥；长度不等时提前 false 不会泄露信息（等长才比较）。
function checkOriginToken(req, res) {
  if (!ORIGIN_TOKEN || isLoopback(req)) return true;
  const given = req.headers['x-origin-token'];
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(ORIGIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let PKG_VERSION = null; // package.json 版本号，读一次常驻（页脚展示用）

async function handleApi(req, res, pathname) {
  const ip = getIp(req);
  const secure = isSecure(req);
  const method = req.method;

  if (pathname === '/api/version' && method === 'GET') {
    if (!PKG_VERSION) {
      try {
        PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
      } catch (e) {
        PKG_VERSION = 'dev';
      }
    }
    // time=服务器 epoch 毫秒，tzOffset=服务器时区偏移（getTimezoneOffset 口径，UTC+8 为 -480）；
    // 客户端页脚据此走针显示服务器时间，每日重置以此为准
    const now = Date.now();
    return sendJSON(res, 200, { version: PKG_VERSION, time: now, tzOffset: new Date(now).getTimezoneOffset() });
  }

  const needBodyJson = () => {
    const ctype = String(req.headers['content-type'] || '');
    return ctype.includes('application/json');
  };

  if (pathname === '/api/auth/register' && method === 'POST') {
    if (!sameOrigin(req) || !needBodyJson()) return sendJSON(res, 403, { error: '请求被拒绝' });
    const { tooLarge, text } = await readBody(req, AUTH_BODY_LIMIT);
    if (tooLarge) return sendJSON(res, 413, { error: '请求体过大' });
    let body = null;
    try { body = JSON.parse(text || '{}'); } catch (e) { body = null; }
    return auth.register(req, res, { ip, secure, ua: req.headers['user-agent'], body });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    if (!sameOrigin(req) || !needBodyJson()) return sendJSON(res, 403, { error: '请求被拒绝' });
    const { tooLarge, text } = await readBody(req, AUTH_BODY_LIMIT);
    if (tooLarge) return sendJSON(res, 413, { error: '请求体过大' });
    let body = null;
    try { body = JSON.parse(text || '{}'); } catch (e) { body = null; }
    return auth.login(req, res, { ip, secure, ua: req.headers['user-agent'], body });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    if (!sameOrigin(req)) return sendJSON(res, 403, { error: '请求被拒绝' });
    return auth.logout(req, res, { secure });
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    return auth.me(req, res, {});
  }

  if ((pathname === '/api/save' || pathname === '/api/save/beacon') && (method === 'POST' || method === 'GET')) {
    const user = auth.getSessionUser(req);
    if (!user) return sendJSON(res, 401, { error: '未登录' });
    if (!sameOrigin(req)) return sendJSON(res, 403, { error: '请求被拒绝' });
    if (method === 'GET') return saves.get(req, res, { user });
    // 关页 sendBeacon 可能不带 application/json，这里放行并按文本解析
    const { tooLarge, text } = await readBody(req, SAVE_BODY_LIMIT);
    if (tooLarge) return sendJSON(res, 413, { error: '存档过大' });
    return saves.store(req, res, { user, rawBody: text });
  }

  // 存档重置（2026-10-31 云端唯一存档）：清云端档 + 账本 + 排行档案，下次进游戏全新开局
  if (pathname === '/api/reset' && method === 'POST') {
    const user = auth.getSessionUser(req);
    if (!user) return sendJSON(res, 401, { error: '未登录' });
    if (!sameOrigin(req)) return sendJSON(res, 403, { error: '请求被拒绝' });
    return saves.reset(req, res, { user });
  }

  // 账号资料：改显示名（写接口同源 + JSON + 32KB 体）
  if (pathname === '/api/profile/name' && method === 'POST') {
    const user = auth.getSessionUser(req);
    if (!user) return sendJSON(res, 401, { error: '未登录' });
    if (!sameOrigin(req) || !needBodyJson()) return sendJSON(res, 403, { error: '请求被拒绝' });
    const { tooLarge, text } = await readBody(req, AUTH_BODY_LIMIT);
    if (tooLarge) return sendJSON(res, 413, { error: '请求体过大' });
    let body = null;
    try { body = JSON.parse(text || '{}'); } catch (e) { body = null; }
    return auth.setDisplayName(req, res, { body });
  }

  // 征战体力（2026-11-01，服务端裁定）：一场 1 点、每日 300、5 分钟回 1。
  // 客户端每场战斗前 POST spend 扣点，扣不动（429）就打不了；GET 供展示同步。
  if (pathname === '/api/stamina' && method === 'GET') {
    const user = auth.getSessionUser(req);
    if (!user) return sendJSON(res, 401, { error: '未登录' });
    return stamina.get(req, res, { user });
  }
  if (pathname === '/api/stamina/spend' && method === 'POST') {
    const user = auth.getSessionUser(req);
    if (!user) return sendJSON(res, 401, { error: '未登录' });
    if (!sameOrigin(req) || !needBodyJson()) return sendJSON(res, 403, { error: '请求被拒绝' });
    const { tooLarge, text } = await readBody(req, AUTH_BODY_LIMIT);
    if (tooLarge) return sendJSON(res, 413, { error: '请求体过大' });
    let body = null;
    try { body = JSON.parse(text || '{}'); } catch (e) { body = null; }
    return stamina.spend(req, res, { user, body });
  }

  // 征战战斗（2026-11-01 全量服务端校验迁移 P1）：胜负/奖励/进度/掉落全部服务端裁定，
  // 体力扣点内嵌在 fight 事务里；offline 服务端按上次结算时间复算离线收益
  if (pathname === '/api/combat/fight' && method === 'POST') {
    const user = auth.getSessionUser(req);
    if (!user) return sendJSON(res, 401, { error: '未登录' });
    if (!sameOrigin(req) || !needBodyJson()) return sendJSON(res, 403, { error: '请求被拒绝' });
    const { tooLarge, text } = await readBody(req, AUTH_BODY_LIMIT);
    if (tooLarge) return sendJSON(res, 413, { error: '请求体过大' });
    let body = null;
    try { body = JSON.parse(text || '{}'); } catch (e) { body = null; }
    return combat.fight(req, res, { user, body });
  }
  if (pathname === '/api/combat/offline' && method === 'POST') {
    const user = auth.getSessionUser(req);
    if (!user) return sendJSON(res, 401, { error: '未登录' });
    if (!sameOrigin(req) || !needBodyJson()) return sendJSON(res, 403, { error: '请求被拒绝' });
    const { tooLarge, text } = await readBody(req, AUTH_BODY_LIMIT);
    if (tooLarge) return sendJSON(res, 413, { error: '请求体过大' });
    let body = null;
    try { body = JSON.parse(text || '{}'); } catch (e) { body = null; }
    return combat.offline(req, res, { user, body });
  }

  // 天下玩法：排行 / 天梯 / PvP / 世界 BOSS / 仙盟 / 兑换码（social.js 内再按方法分发）
  if (/^\/api\/(rank|ladder|pvp|boss|guild|redeem)/.test(pathname)) {
    const user = auth.getSessionUser(req);
    if (!user) return sendJSON(res, 401, { error: '未登录' });
    let body = null;
    if (method === 'POST') {
      if (!sameOrigin(req) || !needBodyJson()) return sendJSON(res, 403, { error: '请求被拒绝' });
      const { tooLarge, text } = await readBody(req, AUTH_BODY_LIMIT);
      if (tooLarge) return sendJSON(res, 413, { error: '请求体过大' });
      try { body = JSON.parse(text || '{}'); } catch (e) { body = null; }
    }
    if (social.handle(req, res, { method, pathname, user, body })) return;
    return sendJSON(res, 404, { error: 'not found' });
  }

  return sendJSON(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch (e) {
    return notFound(res);
  }

  try {
    if (!checkOriginToken(req, res)) return forbidden(res);
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);

  if (pathname === '/' || pathname === '/index.html') {
    if (!loggedIn(req)) return redirect(res, '/login.html');
    return sendHtml(req, res, 'index.html', { 'Content-Security-Policy': PAGE_CSP });
  }

  if (pathname === '/login' || pathname === '/login.html') {
    if (loggedIn(req)) return redirect(res, '/');
    return sendHtml(req, res, 'login.html', { 'Content-Security-Policy': PAGE_CSP });
  }

    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
    if (pathname.startsWith('/assets/') || pathname === '/favicon.ico') {
      return serveStatic(req, res, pathname === '/favicon.ico' ? '/favicon.png' : pathname);
    }
    const PUBLIC_FILES = new Set(['/styles.css', '/game.js', '/login.js', '/theme-boot.js', '/favicon.svg', '/favicon.png', '/cover.png', '/cover.svg']);
    if (PUBLIC_FILES.has(pathname)) return serveStatic(req, res, pathname);

    return notFound(res);
  } catch (err) {
    console.error('[server]', req.method, pathname, err);
    if (!res.headersSent) sendJSON(res, 500, { error: '服务器内部错误' });
    else res.end();
  }
});

// 会话与登录流水的周期清理（每小时）
const cleanupTimer = setInterval(() => {
  try { auth.cleanup(); } catch (e) { console.error('[cleanup]', e); }
}, 3600 * 1000);
cleanupTimer.unref();

server.listen(PORT, () => {
  console.log(`灵匣纪元服务端已启动: http://127.0.0.1:${PORT}  (数据库: ${DB_PATH})`);
  if (ORIGIN_TOKEN && ORIGIN_TOKEN.length < 16) {
    console.warn('[警告] ORIGIN_TOKEN 短于 16 位，建议用 32 位以上随机串');
  }
});
