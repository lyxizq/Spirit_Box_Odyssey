// 本地版引导入口（esbuild 打包为 local/local-bundle.js，普通 <script> 加载）：
//   1. 初始化 sql.js（wasm 以 base64 内联在 vendor/sql-wasm-b64.js，双击 file:// 也能起）
//   2. 读 localStorage 历史档（损坏则隔离后全新开局）
//   3. 装配虚拟服务端（服务端模块原样跑）+ 传输层 shim
//   4. 页面生命周期落盘钩子 + 多标签页守卫 + 存档导出/导入 UI
//   5. 注入 ../game.js 正式开游戏（game.js 一字不改）
import { createLocalServer } from './server.js';
import { installShims } from './shim.js';
import * as persist from './persist.js';
import { installUI } from './ui.js';

const g = typeof globalThis !== 'undefined' ? globalThis : window;

// 浏览器 Buffer 兜底：服务端模块只用 Buffer.byteLength（UTF-8 字节数，存档体积记账），
// TextEncoder 同语义；必须在任何请求处理前就位
if (typeof g.Buffer === 'undefined') {
  g.Buffer = { byteLength: (s) => new TextEncoder().encode(String(s)).length };
}

async function boot() {
  // —— sql.js 就绪（wasm 内联，无需网络）——
  if (typeof initSqlJs !== 'function') throw new Error('sql-wasm.js 未加载');
  const wasmBytes = persistB64Decode(g.__LX_SQL_WASM_B64 || '');
  const SQL = await initSqlJs({ wasmBinary: wasmBytes });
  g.__LX_SQL = SQL;

  // —— 历史档恢复 ——
  let initialBytes = null;
  try {
    initialBytes = await persist.loadSavedBytes();
  } catch (e) {
    persist.quarantineCorrupt();
    console.error('[local] 存档损坏，已隔离为全新开局（原档保留在 localStorage ' + 'lx_local_db_v1.corrupt' + '）', e);
  }

  // —— 虚拟服务端 ——
  const server = createLocalServer({ version: __LX_LOCAL_VERSION__, initialBytes });

  let readyResolve = null;
  const ready = new Promise((r) => { readyResolve = r; });

  const handle = async (method, url, rawBody) => {
    const out = await server.handle(method, String(url).split('?')[0], rawBody);
    persist.scheduleSave(server.db); // 变更防抖落盘（体力触达等 GET 也会懒写，统一直接排程）
    return out;
  };

  installShims({ ready, handle });
  readyResolve();

  // —— 落盘生命周期钩子 ——
  window.addEventListener('pagehide', () => { persist.flushNow(server.db); });
  window.addEventListener('beforeunload', () => { persist.flushNow(server.db); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) persist.flushNow(server.db);
  });

  // —— 多标签页守卫 ——
  persist.tabGuard(() => {
    persist.showBanner('检测到另一个本地版标签页：两端会互相覆盖存档，请只保留一个标签页游玩。');
  });

  // —— 存档 UI ——
  installUI({ server, version: __LX_LOCAL_VERSION__ });

  // —— 注入游戏本体 ——
  // 两种布局一律写相对的 game.js：仓库布局 local/index.html 带 <base href="../">（URL 按
  // 仓库根解析），独立包 dist-local/index.html 无 base（按包根解析）——层级差已由 <base>
  // 吸收，这里绝不能再带 ../（2026-11-23 修复：原按有无 base 翻转成 ../game.js，叠成
  // 仓库根的上一级；http 下 .. 被服务器根目录截断才碰巧能跑，file:// 双击直接加载失败）
  const s = document.createElement('script');
  s.src = 'game.js';
  document.body.appendChild(s);
}

// wasm base64 → bytes（与 persist.js 的 b64 同实现；此处独立小份避免导出面扩大）
function persistB64Decode(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

boot().catch((e) => {
  console.error('[local] 启动失败', e);
  document.body.appendChild((() => {
    const mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:#101614;color:#e8e6df;font:15px/1.8 -apple-system,"PingFang SC",sans-serif;text-align:center;padding:24px;';
    mask.textContent = '本地版启动失败：' + (e && e.message ? e.message : e) + '（请重开页面；反复失败请清空浏览器存储）';
    return mask;
  })());
});
