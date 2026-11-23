// 传输层 shim：把客户端（game.js）发出的 /api/* 网络请求就地劫持到本地虚拟服务端。
// 覆盖三条通道：
//   fetch('/api/...')          → server.handle() → 合成 Response
//   navigator.sendBeacon('/api/save/beacon', blob) → 同管线（关页兜底帧）
//   new WebSocket('/api/ws')   → 构造即抛错：客户端 3 次失败后本会话禁用 WS，
//                                恒走 HTTP 轮询回退（时间/体力/悬赏均有 HTTP 路径）
// 非 /api 路径一律透传原生 fetch（本游戏无其他网络调用，仅作保险）。

export function installShims({ ready, handle }) {
  const realFetch = typeof fetch === 'function' ? fetch.bind(window) : null;

  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!url.startsWith('/api/')) return realFetch(input, init);
    await ready; // 极早期调用排队等虚拟服务端就绪（正常路径：服务端先就绪再注入 game.js）
    const method = ((init && init.method) || 'GET').toUpperCase();
    const rawBody = init && typeof init.body === 'string' ? init.body : null;
    const out = await handle(method, url, rawBody);
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    if (out.retryAfter != null) headers['Retry-After'] = String(out.retryAfter);
    return new Response(JSON.stringify(out.json == null ? {} : out.json), {
      status: out.status,
      headers,
    });
  };

  // 关页兜底：sendBeacon 的 Blob 异步读取后走同管线，并立即强推落盘（页可能随即关闭）
  if (navigator.sendBeacon) {
    const realBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (typeof url === 'string' && url.startsWith('/api/')) {
        Promise.resolve()
          .then(async () => {
            const text = data && typeof data.text === 'function' ? await data.text()
              : typeof data === 'string' ? data : null;
            await ready;
            await handle('POST', url, text);
          })
          .catch(() => {});
        return true;
      }
      return realBeacon(url, data);
    };
  }

  // WS 通道直接判死：构造即抛（客户端 catch 后 return，后续重试同样抛，快速稳定走 HTTP 回退）。
  // 仅拦 /api/ws；本游戏无其他 WS 用途，但保持通用性按 URL 判断。
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const u = String(url || '');
    if (u.includes('/api/ws')) {
      throw new Error('local edition: WebSocket disabled, HTTP polling only');
    }
    return new RealWS(url, protocols);
  };
  window.WebSocket.prototype = RealWS.prototype;
}
