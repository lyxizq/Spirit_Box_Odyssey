// WebSocket 长连接服务（2026-11-04 用户指定「开始 2、3，使用 HTTP/1.1 的 WebSocket」）：
// 零依赖 RFC6455 服务端——握手（node:crypto SHA-1）/ 分帧解析（客户端帧必带掩码）/ 心跳
// ping-pong / 单会话单连接（新连接踢旧连接）。通道语义：
//   上行 { t:'save', body:<完整存档 JSON 文本> } → 原样走 applyStore 管线（校验/账本/包络
//   与 HTTP POST /api/save 完全同一条），回 { t:'saveAck', status, ...body }；
//   下行 { t:'time', version, time, tzOffset, stamina }（60s 心跳tick顺带推）；
//   下行 { t:'bounty', ...悬赏快照 }（连接时 + 服务端日期翻转时推）。
// 传输层只换通道：防砖三道防线（单调性/增速包络/cli_sync）在 applyStore 内一行业务未动。
// 依赖注入：auth（会话）、applyStore（存档管线）、snapshotOf（连接时首帧快照）、version。
import crypto from 'node:crypto';
import { sameOrigin } from './http-util.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PING_EVERY_MS = 30 * 1000;      // 协议级 ping 保活（WS 帧不产生对域名的 HTTP 请求）
const PONG_TIMEOUT_MS = 12 * 1000;    // 两轮 ping 无 pong 视为死链，直接 terminate
const MAX_FRAME = 512 * 1024;         // 与 SAVE_BODY_LIMIT 同界，超长帧直接断开
const MAX_BUFFER = 1024 * 1024;

export function createWsService({ auth, applyStore, snapshotOf, version }) {
  const clients = new Map(); // userId -> conn（单会话单连接：新连踢旧）

  // —— 帧编码（服务端下行不掩码）——
  function encodeFrame(opcode, payload = Buffer.alloc(0)) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
  }

  // —— 帧解析：返回 { frames: [{opcode, payload}], rest }；客户端帧必带掩码，校验失败抛错断链 ——
  function parseFrames(buf) {
    const frames = [];
    let off = 0;
    while (off + 2 <= buf.length) {
      const b0 = buf[off];
      const b1 = buf[off + 1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off2 = off + 2;
      if (len === 126) {
        if (off2 + 2 > buf.length) break;
        len = buf.readUInt16BE(off2);
        off2 += 2;
      } else if (len === 127) {
        if (off2 + 8 > buf.length) break;
        const big = buf.readBigUInt64BE(off2);
        if (big > BigInt(MAX_FRAME)) throw new Error('frame too large');
        len = Number(big);
        off2 += 8;
      }
      if (len > MAX_FRAME) throw new Error('frame too large');
      // RFC6455 §5.1：客户端→服务端帧必带掩码，服务端须对无掩码帧断链——浏览器恒掩码，
      // 此分支只拦裸 socket 伪造帧（2026-11-06 加固），对合法客户端零影响
      if (!masked) throw new Error('unmasked client frame');
      if (off2 + (masked ? 4 : 0) + len > buf.length) break;
      let payload = buf.subarray(off2 + (masked ? 4 : 0), off2 + (masked ? 4 : 0) + len);
      if (masked) {
        const mask = buf.subarray(off2, off2 + 4);
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      frames.push({ fin, opcode, payload });
      off = off2 + (masked ? 4 : 0) + len;
    }
    return { frames, rest: buf.subarray(off) };
  }

  function sendObj(conn, obj) {
    try {
      if (conn.socket.destroyed) return;
      conn.socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(obj))));
    } catch (e) { /* 写失败交给 close/terminate 兜底 */ }
  }

  // 单条完整消息（分片已组装）：与 HTTP POST /api/save 同一条 applyStore 管线
  function handleMessage(conn, text) {
    if (text.length > MAX_FRAME) return;
    let msg = null;
    try { msg = JSON.parse(text.toString('utf8')); } catch (e) { return; }
    if (!msg || msg.t !== 'save') return;
    const rawBody = typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body ?? null);
    // 管线异常兜底（2026-11-06 修复）：applyStore 内 DB 失败走 ROLLBACK 后 rethrow，
    // 而本函数挂在同步 socket 'data' 回调上——无兜底的 throw 会变 uncaughtException
    // 直接崩掉整个服务进程（HTTP 侧 handleApi 有顶层 try，WS 侧此前是裸奔）。
    // 回 500 saveAck，客户端按临时故障既定路径回退 HTTP 重试
    let r;
    try {
      r = applyStore(conn.user.id, rawBody, conn.user);
    } catch (e) {
      console.error('[ws] applyStore 异常 user=' + conn.user.id + '：' + (e && e.message));
      r = { status: 500, body: { error: '存档管线异常' } };
    }
    sendObj(conn, Object.assign({ t: 'saveAck', status: r.status }, r.body));
  }
  const sendTo = (userId, obj) => {
    const c = clients.get(userId);
    if (c) sendObj(c, obj);
  };

  // —— 握手 + 注册（返回 true=已按 WS 处理）——
  function handleUpgrade(req, socket, head) {
    let pathname = '';
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) {}
    if (pathname !== '/api/ws') return false;
    const finish = (code, reason) => {
      socket.write('HTTP/1.1 ' + code + ' ' + reason + '\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    };
    // 同源校验（浏览器 WS 握手必带 Origin；与 HTTP API 的 CSRF 口径一致）+ 会话鉴权
    if (!sameOrigin(req)) return finish('403 Forbidden', 'origin');
    const user = auth.getSessionUser(req);
    if (!user) return finish('401 Unauthorized', 'auth');
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      return finish('400 Bad Request', 'handshake');
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    if (head && head.length) socket.unshift(head);

    // 单会话单连接：旧连接礼貌关闭（1000 正常关闭），新连接接管
    const prev = clients.get(user.id);
    if (prev) { try { prev.socket.write(encodeFrame(0x8, Buffer.from([0x03, 0xe8]))); prev.socket.destroy(); } catch (e) {} }

    const conn = { user, socket, buffer: Buffer.alloc(0), frag: null, alive: true, day: '' };
    clients.set(user.id, conn);

    socket.on('data', (chunk) => {
      conn.buffer = Buffer.concat([conn.buffer, chunk]);
      if (conn.buffer.length > MAX_BUFFER) { socket.destroy(); clients.delete(user.id); return; }
      let frames;
      try {
        frames = parseFrames(conn.buffer);
      } catch (e) {
        socket.write(encodeFrame(0x8, Buffer.from([0x03, 0xe8]))); // 1001 帧越界
        socket.destroy();
        clients.delete(user.id);
        return;
      }
      conn.buffer = frames.rest;
      for (const fr of frames.frames) {
        if (fr.opcode === 0x8) { // close：回关闭帧并断开
          try { socket.write(encodeFrame(0x8, fr.payload)); } catch (e) {}
          socket.destroy();
          clients.delete(user.id);
          return;
        }
        if (fr.opcode === 0x9) { socket.write(encodeFrame(0xA, fr.payload)); continue; } // ping→pong
        if (fr.opcode === 0xA) { conn.alive = true; continue; }                          // pong
        // 分片消息（2026-11-05 生产修复）：浏览器对大消息必然分片（大档存档帧 100KB+ 拆
        // 多帧：首帧 opcode 0x1 fin=0 → 若干 0x0 续帧 → 末帧 fin=1）。此前续帧无分支整段
        // 丢弃、frag 永不组装 → 存档帧不落管线、无 saveAck → 客户端 10s 超时回退直连。
        if (fr.opcode === 0x0 || fr.opcode === 0x1 || fr.opcode === 0x2) {
          if (fr.opcode === 0x0 && !conn.frag) { socket.destroy(); clients.delete(user.id); return; } // 无头续帧
          if (fr.opcode !== 0x0 && conn.frag) { socket.destroy(); clients.delete(user.id); return; }  // 未收完又起新头
          conn.frag = conn.frag ? Buffer.concat([conn.frag, fr.payload]) : fr.payload;
          if (conn.frag.length > MAX_FRAME) { // 组装总量同上限（单帧合规、拼起来超长也断）
            socket.write(encodeFrame(0x8, Buffer.from([0x03, 0xe8])));
            socket.destroy();
            clients.delete(user.id);
            return;
          }
          if (!fr.fin) continue;
          const text = conn.frag;
          conn.frag = null;
          handleMessage(conn, text);
        }
      }
    });
    const drop = () => {
      // 仅当 clients 中仍是当前连接时才移除，避免单会话踢旧连接时旧连接的 close 事件误删新连接
      if (clients.get(user.id) === conn) {
        clients.delete(user.id);
      }
    };
    socket.on('close', drop);
    socket.on('error', drop);

    // 连接时首帧快照（版本 / 服务器时间 / 体力 / 悬赏妖踪快照，2026-11-04 二期推送）。
    // time 帧必须带 tzOffset（2026-11-06 修复）：与 /api/version 同口径（getTimezoneOffset，
    // UTC+8 为 -480）——此前缺失，客户端页脚「服务器时间」按 UTC 直写，CST 差 8 小时
    if (snapshotOf) sendObj(conn, Object.assign(
      { t: 'hello', version, time: Date.now(), tzOffset: new Date().getTimezoneOffset() },
      snapshotOf(user.id, conn)));
    return true;
  }

  // 60s 心跳 tick（index.js setInterval 调用）：协议级 ping 保活 + 时间帧 + 日期翻转重推悬赏
  function tick(now = Date.now()) {
    const timeFrame = { t: 'time', version, time: now, tzOffset: new Date(now).getTimezoneOffset() };
    for (const [userId, conn] of clients) {
      if (!conn.alive) { // 上一轮 ping 至今无 pong：死链
        try { conn.socket.destroy(); } catch (e) {}
        clients.delete(userId);
        continue;
      }
      conn.alive = false;
      try { conn.socket.write(encodeFrame(0x9, Buffer.alloc(0))); } catch (e) { continue; }
      const d = new Date(now);
      const p = (n) => String(n).padStart(2, '0');
      const today = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      const snap = snapshotOf ? snapshotOf(userId, conn, today) : {};
      sendObj(conn, Object.assign({ t: 'time' }, timeFrame, snap));
      if (conn.day !== today) { // 跨天重推悬赏快照（每日 0 点换榜）
        conn.day = today;
        if (snap.bounty) sendObj(conn, Object.assign({ t: 'bounty' }, snap.bounty));
      }
    }
  }

  return { handleUpgrade, tick, sendTo, count: () => clients.size };
}
