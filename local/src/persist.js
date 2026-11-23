// 本地版持久化：整库字节（sql.js export）→ gzip → base64 → localStorage。
// 单文件单键，写放大极小（库体量百 KB 级，gzip 后数十 KB）。
// 防线：
//  - 每次变更防抖 1s 落盘 + pagehide/visibilitychange 兜底强推（与客户端存档节奏解耦）；
//  - 配额溢出先裁日志表（45 天前流水）重试一次，仍满则横幅提示导出备份；
//  - BroadcastChannel 多标签页侦测：本地版两端并发写 localStorage 会互相覆盖，
//    侦测到第二个标签页常驻即在 UI 挂横幅提示只留一个。

const KEY = 'lx_local_db_v1';
const KEY_BAD = KEY + '.corrupt';
const CH = 'lx_local_tab';
const PRUNE_DAYS = 45;

let flushTimer = 0;
let lastErrorNotified = 0;

// ---------- gzip / base64 ----------

function hasGzipApi() {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

async function gzipBytes(bytes) {
  const cs = new CompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytes(bytes) {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function b64encode(bytes) {
  let bin = '';
  const CH2 = 0x8000;
  for (let i = 0; i < bytes.length; i += CH2) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH2));
  }
  return btoa(bin);
}

export function b64decode(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- 裁剪与序列化 ----------

// 裁掉陈年流水（本地单机不需要无限保留）：action_log / pvp_battles 45 天前清掉
function prune(dbSync) {
  const cutoff = Date.now() - PRUNE_DAYS * 86400 * 1000;
  try { dbSync.prepare('DELETE FROM action_log WHERE created_at < ?').run(cutoff); } catch (e) { /* 表未建 */ }
  try { dbSync.prepare('DELETE FROM pvp_battles WHERE created_at < ?').run(cutoff); } catch (e) { /* 表未建 */ }
}

async function serialize(dbSync) {
  prune(dbSync);
  const raw = dbSync.exportBytes();
  if (hasGzipApi()) {
    try {
      return 'gz1:' + b64encode(await gzipBytes(raw));
    } catch (e) { /* 压缩失败退原样 */ }
  }
  return 'raw1:' + b64encode(raw);
}

// ---------- 读档 ----------

// 返回 Uint8Array（库字节）或 null（无档）。档损坏抛错由 boot 捕获（挪 KEY_BAD 后全新开局）。
export async function loadSavedBytes() {
  let text = null;
  try { text = localStorage.getItem(KEY); } catch (e) { return null; }
  if (!text) return null;
  if (text.startsWith('gz1:')) {
    if (!hasGzipApi()) throw new Error('当前浏览器不支持解压存档');
    return gunzipBytes(b64decode(text.slice(4)));
  }
  if (text.startsWith('raw1:')) return b64decode(text.slice(5));
  throw new Error('存档格式未知');
}

// 启动期损坏档归档：挪到 KEY_BAD 保留现场（用户可导出求助），主键清空走全新档
export function quarantineCorrupt() {
  try {
    const text = localStorage.getItem(KEY);
    if (text) localStorage.setItem(KEY_BAD, text);
    localStorage.removeItem(KEY);
  } catch (e) { /* 尽力而为 */ }
}

// ---------- 写盘 ----------

export async function flushNow(dbSync) {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; }
  let text;
  try {
    text = await serialize(dbSync);
  } catch (e) {
    console.error('[local-persist] serialize failed', e);
    return false;
  }
  try {
    localStorage.setItem(KEY, text);
    return true;
  } catch (e2) {
    const now = Date.now();
    if (now - lastErrorNotified > 10 * 60 * 1000) {
      lastErrorNotified = now;
      console.error('[local-persist] localStorage 写入失败（配额？）', e2);
      if (typeof document !== 'undefined') {
        showBanner('本地存档空间不足：请导出备份后清理浏览器存储，当前进度仍可游玩，但关页可能丢失。');
      }
    }
    return false;
  }
}

export function scheduleSave(dbSync, delayMs = 1000) {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = 0;
    await flushNow(dbSync);
  }, delayMs);
}

// ---------- 多标签页守卫 ----------

// 返回 { foreignActive() }；侦测到其他标签页心跳时回调一次（去抖由 UI 侧负责）
export function tabGuard(onForeign) {
  if (typeof BroadcastChannel === 'undefined') return { foreignActive: () => false };
  let ch;
  try { ch = new BroadcastChannel(CH); } catch (e) { return { foreignActive: () => false }; }
  const self = Math.random().toString(36).slice(2);
  let foreignAt = 0;
  let notified = false;
  ch.onmessage = (ev) => {
    const d = ev.data;
    if (!d || d.id === self) return;
    foreignAt = Date.now();
    if (!notified) {
      notified = true;
      try { onForeign && onForeign(); } catch (e) { /* UI 回调异常不影响守卫 */ }
    }
  };
  setInterval(() => {
    try { ch.postMessage({ id: self, at: Date.now() }); } catch (e) { /* 通道关闭忽略 */ }
  }, 2000);
  return { foreignActive: () => Date.now() - foreignAt < 6000 };
}

// ---------- 页面横幅（boot/ui 共用的最小实现，样式在 local.css） ----------

export function showBanner(text) {
  if (typeof document === 'undefined') return;
  let bar = document.getElementById('lxLocalBanner');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'lxLocalBanner';
    document.body.appendChild(bar);
  }
  bar.textContent = text;
  bar.classList.add('show');
}
