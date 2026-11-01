// 征战体力服务（2026-11-01 用户指令）：闯关/爬塔/野外/无尽一场 1 点，
// 计算与消耗全部服务端裁定——客户端只在每次战斗前请求扣点，扣不动就打不了。
// 口径：每日 300 点（本地日首次触碰时回满），每 5 分钟恢复 1 点，上限即 300。
// 数值唯一权威在 users 表三列（stamina / stamina_ts / stamina_day），
// 客户端仅持有最近一次同步的展示快照（响应里带 stamina/cap/nextAt 自行插值显示）。
// 2026-11-01 全量服务端校验迁移：computeStamina 纯函数抽出，combat.js 的 fight
// 事务内复用同一折算（体力扣点并入战斗端点），口径不分叉。
import { sendJSON, SlidingWindow } from './http-util.js';

export const STAMINA_CAP = 300;
export const STAMINA_REGEN_MS = 5 * 60 * 1000;
const SPEND_PER_MIN = 120; // 反垃圾：自动巡猎最快约 2 场/秒，120/分钟留足余量

function dayStr(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 折算当前体力：跨本地日先回满 300；未满时按 5 分钟/点补恢复（恢复进度留在 stamina_ts）。
// 纯函数：service 与 combat.js 共用同一实现。
export function computeStamina(row, now) {
  const today = dayStr(now);
  let v = Math.min(STAMINA_CAP, Math.max(0, Math.floor(Number(row.stamina) || 0)));
  let ts = Number(row.stamina_ts) || now;
  const day = row.stamina_day || '';
  if (day !== today) return { v: STAMINA_CAP, ts: now, day: today, changed: true };
  if (v < STAMINA_CAP) {
    const gained = Math.floor(Math.max(0, now - ts) / STAMINA_REGEN_MS);
    if (gained > 0) {
      v = Math.min(STAMINA_CAP, v + gained);
      ts = v >= STAMINA_CAP ? now : ts + gained * STAMINA_REGEN_MS;
      return { v, ts, day, changed: true };
    }
  }
  return { v, ts, day, changed: false };
}

export const staminaView = (cur) => ({
  stamina: cur.v,
  cap: STAMINA_CAP,
  nextAt: cur.v >= STAMINA_CAP ? 0 : cur.ts + STAMINA_REGEN_MS,
});

export function createStaminaService(db) {
  const spendWindow = new SlidingWindow(60 * 1000, SPEND_PER_MIN);
  const stmts = {
    byId: db.prepare('SELECT id, stamina, stamina_ts, stamina_day FROM users WHERE id = ?'),
    // 扣点原子性：WHERE stamina >= ? 兜底复验（node:sqlite 同步单进程，事务内已先算好）
    spend: db.prepare('UPDATE users SET stamina = stamina - ?, stamina_ts = ?, stamina_day = ? WHERE id = ? AND stamina >= ?'),
    setAll: db.prepare('UPDATE users SET stamina = ?, stamina_ts = ?, stamina_day = ? WHERE id = ?'),
  };

  function get(req, res, ctx) {
    const row = stmts.byId.get(ctx.user.id);
    if (!row) return sendJSON(res, 500, { error: '账号状态异常' });
    const cur = computeStamina(row, Date.now());
    if (cur.changed) stmts.setAll.run(cur.v, cur.ts, cur.day, ctx.user.id);
    return sendJSON(res, 200, staminaView(cur));
  }

  // POST /api/stamina/spend {n}：扣 n 点。不足 429 拒绝并带当前库存——
  // 客户端收到即停战（自动巡猎自动关闭）。
  function spend(req, res, ctx) {
    if (!spendWindow.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '操作过于频繁，请稍后再试' }, { 'Retry-After': '10' });
    }
    const n = Math.floor(Number(ctx.body && ctx.body.n));
    if (!Number.isFinite(n) || n < 1 || n > STAMINA_CAP) {
      return sendJSON(res, 400, { error: '体力扣点数非法' });
    }
    const now = Date.now();
    db.exec('BEGIN');
    try {
      const row = stmts.byId.get(ctx.user.id);
      if (!row) {
        db.exec('ROLLBACK');
        return sendJSON(res, 500, { error: '账号状态异常' });
      }
      const cur = computeStamina(row, now);
      if (cur.changed) stmts.setAll.run(cur.v, cur.ts, cur.day, ctx.user.id);
      if (cur.v < n) {
        db.exec('ROLLBACK');
        return sendJSON(res, 429, {
          error: '体力不足，每 5 分钟恢复 1 点（每日 300 点）',
          ...staminaView(cur),
        });
      }
      // 满池扣点时把恢复计时重置到当前时刻：ts 若还是旧值，下一点会瞬间回上
      // （旧 ts 距今早已超过 5 分钟）；未满池时 ts 是恢复基线，保持不动
      const tsAfter = cur.v >= STAMINA_CAP ? now : cur.ts;
      stmts.spend.run(n, tsAfter, cur.day, ctx.user.id, n);
      const after = Math.floor(cur.v - n);
      db.exec('COMMIT');
      return sendJSON(res, 200, {
        ok: true, spent: n, stamina: after, cap: STAMINA_CAP,
        nextAt: after >= STAMINA_CAP ? 0 : tsAfter + STAMINA_REGEN_MS,
      });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // 供 combat.js 在自己的事务内复用（同一 db 连接、同一套语句与折算）
  return {
    get, spend,
    core: {
      rowById: (id) => stmts.byId.get(id),
      persist: (id, cur) => stmts.setAll.run(cur.v, cur.ts, cur.day, id),
      spendStmt: stmts.spend,
      compute: computeStamina,
      view: staminaView,
      cap: STAMINA_CAP,
      regenMs: STAMINA_REGEN_MS,
    },
  };
}
