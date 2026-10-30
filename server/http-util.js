// HTTP 小工具：JSON 响应、请求体读取、IP / Cookie / 同源判定（零依赖）
import crypto from 'node:crypto';

export function sendJSON(res, status, obj, extraHeaders = {}) {
  const text = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(text);
}

// 读取请求体，超过 limit 视为超大（返回 { tooLarge: true }），否则返回字符串
export function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        req.resume();
        resolve({ tooLarge: true, text: null });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve({ tooLarge: false, text: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', () => {
      if (done) return;
      done = true;
      resolve({ tooLarge: false, text: null });
    });
  });
}

// 取客户端 IP。直连（无代理头）用 socket 地址；经可信代理回源时按序取：
// 1. EO-Connecting-IP：EdgeOne 自行写入的建连客户端 IP，客户端伪造不了；
// 2. X-Forwarded-For 末位：Nginx / EdgeOne 等把直连对端追加在末位，取末位
//    可免疫客户端自带伪造 XFF（首段不可信）。
// 前提：源站端口只对可信代理开放（安全组放行 EdgeOne 回源网段），否则直连
// 伪造这两个头仍可绕过按 IP 限流。
export function getIp(req) {
  const eo = req.headers['eo-connecting-ip'];
  if (typeof eo === 'string' && eo.trim()) return eo.trim();
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    const parts = fwd.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

// 是否走了 HTTPS（反代或直连），决定会话 Cookie 是否加 Secure。
// EdgeOne 在客户端走 HTTP/3 时回源 Proto 记为 quic，同属安全连接。
export function isSecure(req) {
  if (req.socket && req.socket.encrypted) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto !== 'string') return false;
  return ['https', 'quic'].includes(proto.split(',')[0].trim());
}

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

// 写操作接口的同源校验：带 Origin 头时必须同源；跨站脚本拿不到自定义头也过不了 JSON 类型要求
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 同源 fetch/beacon 可能不带 Origin（GET / 旧浏览器），交由其他防线
  const host = req.headers.host;
  if (!host) return false;
  try {
    const url = new URL(origin);
    return url.host === host;
  } catch (e) {
    return false;
  }
}

export function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('base64');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
