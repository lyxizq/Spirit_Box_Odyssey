// 本地版 http-util 浏览器替身：服务端模块 import { sendJSON, SlidingWindow } from './http-util.js'
// 时由 esbuild 插件改道到此文件。sendJSON 不再写 HTTP 流，而是把结果挂在假 res 上，
// 由本地路由（server.js）取出后包成真 Response 交还 fetch shim。
// SlidingWindow 与 server/http-util.js 原文一致（纯 JS，零依赖）——限流语义保持同源。

// 假 res 约定：{ __status, __json }。extraHeaders 仅保留 Retry-After（限流响应客户端要读）。
export function sendJSON(res, status, obj, extraHeaders = {}) {
  res.__status = status;
  res.__json = obj;
  if (extraHeaders && extraHeaders['Retry-After'] != null) {
    res.__retryAfter = extraHeaders['Retry-After'];
  }
}

// —— 以下与 server/http-util.js 的 SlidingWindow 逐字同源（改动须双侧同步）——

// 内存滑动窗口限流（重启清零）。maxKeys 封顶防海量伪造 IP 撑爆内存，超限时随机丢一半旧键
export class SlidingWindow {
  constructor(ms, max, maxKeys = 20000) {
    this.ms = ms;
    this.max = max;
    this.maxKeys = maxKeys;
    this.hits = new Map();
  }
  hit(key, now = Date.now()) {
    const cutoff = now - this.ms;
    let arr = this.hits.get(key);
    if (!arr) {
      if (this.hits.size >= this.maxKeys) {
        let drop = this.hits.size >> 1;
        for (const k of this.hits.keys()) {
          this.hits.delete(k);
          if (--drop <= 0) break;
        }
      }
      arr = [];
      this.hits.set(key, arr);
    }
    while (arr.length && arr[0] <= cutoff) arr.shift();
    if (arr.length >= this.max) return false;
    arr.push(now);
    return true;
  }
}
