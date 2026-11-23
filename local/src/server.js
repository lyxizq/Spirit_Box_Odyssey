// 本地版虚拟服务端：把服务端玩法层（server/*.js 原样打包）装进浏览器内存 SQLite，
// 对 fetch shim 暴露与 server/index.js 相同语义的 HTTP 端点面。差异只有三处（均为
// 单机化必然）：① 无账号体系——固定单用户 + /api/auth/* 就地应答；② sendJSON 走
// 假 res 捕获（http-util-shim.js）；③ 版本号由构建脚本注入 __LX_LOCAL_VERSION__。
// 服务端模块（saves/combat/pets/shop/cultivation/social/stamina/economy/battle/
// items/moderation/db）一律原样复用，改服务端逻辑时本地版自动同步。
import { openDb } from '../../server/db.js';
import { createSaveService } from '../../server/saves.js';
import { createSocialService } from '../../server/social.js';
import { createStaminaService } from '../../server/stamina.js';
import { createCombatService } from '../../server/combat.js';
import { createPetsService } from '../../server/pets.js';
import { createShopService } from '../../server/shop.js';
import { createCultivationService } from '../../server/cultivation.js';
import { findBannedWord } from '../../server/moderation.js';
import { sendJSON as send } from './http-util-shim.js';

const DISPLAY_NAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{2,16}$/;
const LOCAL_USERNAME = 'local';
const LOCAL_DISPLAY = '无名道友';

export function createLocalServer({ version, initialBytes } = {}) {
  const db = openDb(); // db.js 原样执行：SCHEMA / 迁移 / 补列（node 内置模块已由插件替身接管）

  // 备份/历史档整库导入：必须先于本地用户引导与服务创建——
  // users 行随备份走（引导成为幂等空操作），ensureBots 按道号查重天然幂等
  if (initialBytes) {
    db.importBytes(initialBytes);
  }

  // 本地用户引导（幂等）：单机单账号，status='active' 进战力榜/天梯/排行，与真人一致
  const findUser = db.prepare('SELECT * FROM users WHERE username_lower = ?');
  const insertUser = db.prepare(
    'INSERT INTO users (username, username_lower, password_hash, status, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  let user = findUser.get(LOCAL_USERNAME);
  if (!user) {
    insertUser.run(LOCAL_USERNAME, LOCAL_USERNAME, 'local$no$login', 'active', LOCAL_DISPLAY, Date.now());
    user = findUser.get(LOCAL_USERNAME);
  }

  const saves = createSaveService(db);
  const social = createSocialService(db); // 创建时自动补齐 24 个剑影假人（天梯/PVP 对手池）
  const stamina = createStaminaService(db);
  const combat = createCombatService(db, stamina);
  const pets = createPetsService(db, stamina);
  const shop = createShopService(db);
  const cultivation = createCultivationService(db);

  // —— 显示名修改（server/auth.js setDisplayName 的本地移植：不依赖会话与 node:crypto）——
  const byId = db.prepare('SELECT id, username, display_name, display_name_at FROM users WHERE id = ?');
  const displayNameExists = db.prepare('SELECT 1 FROM users WHERE display_name = ? AND id != ?');
  const setDisplayNameStmt = db.prepare('UPDATE users SET display_name = ?, display_name_at = ? WHERE id = ?');
  function setDisplayName(res, ctx) {
    const name = typeof (ctx.body && ctx.body.name) === 'string' ? ctx.body.name.trim() : '';
    if (!DISPLAY_NAME_RE.test(name)) {
      return send(res, 400, { error: '显示名需为 2-16 位中文、英文、数字或下划线' });
    }
    const banned = findBannedWord(name);
    if (banned) {
      return send(res, 400, { error: '显示名不能含有屏蔽词「' + banned + '」，请修改' });
    }
    const row = byId.get(user.id);
    if (!row) return send(res, 500, { error: '账号状态异常' });
    if (name === row.display_name) return send(res, 200, { ok: true, displayName: name });
    if (Date.now() - (row.display_name_at || 0) < 24 * 3600 * 1000) {
      return send(res, 429, { error: '显示名 24 小时只能改一次' });
    }
    if (displayNameExists.get(name, user.id)) {
      return send(res, 409, { error: '该显示名已被使用' });
    }
    try {
      setDisplayNameStmt.run(name, Date.now(), user.id);
    } catch (e) {
      return send(res, 409, { error: '该显示名已被使用' });
    }
    return send(res, 200, { ok: true, displayName: name });
  }

  // —— 路由：与 server/index.js handleApi 同面（去除鉴权/静态/回源令牌）——
  async function route(method, pathname, body, rawBody, res) {
    const ctx = { user, body, rawBody, ip: 'local', secure: false };
    const POST = method === 'POST';

    if (pathname === '/api/version' && method === 'GET') {
      return send(res, 200, { version, time: Date.now(), tzOffset: new Date().getTimezoneOffset() });
    }
    if (pathname === '/api/auth/me' && method === 'GET') {
      const row = byId.get(user.id);
      return send(res, 200, {
        username: LOCAL_USERNAME,
        displayName: (row && row.display_name) || LOCAL_DISPLAY,
        status: 'active',
      });
    }
    if (pathname === '/api/auth/logout' || pathname === '/api/auth/login' || pathname === '/api/auth/register') {
      return send(res, 200, { ok: true });
    }
    if ((pathname === '/api/save' || pathname === '/api/save/beacon') && (POST || method === 'GET')) {
      if (method === 'GET') return saves.get(null, res, ctx);
      return saves.store(null, res, ctx);
    }
    if (pathname === '/api/reset' && POST) return saves.reset(null, res, ctx);
    if (pathname === '/api/claim' && POST) return saves.claim(null, res, ctx);
    if (pathname === '/api/profile/name' && POST) return setDisplayName(res, ctx);
    if (pathname === '/api/stamina' && method === 'GET') return stamina.get(null, res, ctx);
    if (pathname === '/api/stamina/spend' && POST) return stamina.spend(null, res, ctx);
    if (pathname === '/api/combat/fight' && POST) return combat.fight(null, res, ctx);
    if (pathname === '/api/trial/run' && POST) return combat.trial(null, res, ctx);
    if (pathname === '/api/combat/offline' && POST) return combat.offline(null, res, ctx);
    if (/^\/api\/pet\//.test(pathname)) {
      if (pets.handle(null, res, { method, pathname, user, body })) return;
      return send(res, 404, { error: 'not found' });
    }
    if (/^\/api\/shop(\/|$)/.test(pathname)) {
      if (shop.handle(null, res, { method, pathname, user, body })) return;
      return send(res, 404, { error: 'not found' });
    }
    if (/^\/api\/cult(\/|$)/.test(pathname)) {
      if (cultivation.handle(null, res, { method, pathname, user, body })) return;
      return send(res, 404, { error: 'not found' });
    }
    if (/^\/api\/(rank|ladder|pvp|boss|guild|bounty|memory|visitor|redeem)/.test(pathname)) {
      if (social.handle(null, res, { method, pathname, user, body })) return;
      return send(res, 404, { error: 'not found' });
    }
    return send(res, 404, { error: 'not found' });
  }

  // 对外入口：method/path/body(raw 文本) → { status, json, retryAfter }
  async function handle(method, pathname, rawBody) {
    const res = {};
    let body = null;
    if (rawBody != null && rawBody !== '') {
      try { body = JSON.parse(rawBody); } catch (e) { body = null; }
    }
    try {
      await route(method, pathname, body, rawBody, res);
    } catch (err) {
      logError('[local-server]', method, pathname, err);
      return { status: 500, json: { error: '服务器内部错误' } };
    }
    return {
      status: res.__status != null ? res.__status : 500,
      json: res.__json != null ? res.__json : { error: 'no response' },
      retryAfter: res.__retryAfter,
    };
  }

  return { handle, db, user: () => findUser.get(LOCAL_USERNAME) };
}

// 错误日志：浏览器 console；Node 测试环境走 stderr
function logError(...args) {
  const g = typeof console !== 'undefined' ? console : null;
  if (g && g.error) g.error(...args);
}
