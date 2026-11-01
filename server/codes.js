// 兑换码管理 CLI（服务端本机执行）：
//   node server/codes.js add WELCOME2026 --stones 50000 --dust 200 --tickets 2 [--max 100] [--days 7] [--note "开服礼包"]
//   node server/codes.js list
//   node server/codes.js rm WELCOME2026
// 码面为 4-32 位大写字母 / 数字；--max 0 或省略 = 不限次数；--days 省略 = 永久。
import { openDb } from './db.js';

const db = openDb(process.env.DB_PATH || new URL('../data/game.db', import.meta.url).pathname);

function argNum(args, key) {
  const i = args.indexOf(key);
  if (i < 0) return null;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : null;
}

function add(args) {
  const code = (args[0] || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,32}$/.test(code)) {
    console.error('码需为 4-32 位字母 / 数字');
    process.exit(1);
  }
  const stones = Math.min(1e9, Math.max(0, argNum(args, '--stones') || 0));
  const dust = Math.min(1e6, Math.max(0, argNum(args, '--dust') || 0));
  const tickets = Math.min(1000, Math.max(0, argNum(args, '--tickets') || 0));
  if (stones + dust + tickets <= 0) {
    console.error('至少要给一项奖励：--stones / --dust / --tickets');
    process.exit(1);
  }
  const rawMax = argNum(args, '--max');
  if (rawMax !== null && (!Number.isFinite(rawMax) || rawMax < 0)) {
    console.error('--max 需为非负整数（0 = 不限次）');
    process.exit(1);
  }
  const maxUses = Math.max(0, rawMax || 0);
  const days = argNum(args, '--days');
  const expiresAt = days && days > 0 ? Date.now() + days * 24 * 3600 * 1000 : null;
  const noteIdx = args.indexOf('--note');
  const note = noteIdx >= 0 ? String(args[noteIdx + 1] || '').slice(0, 60) : '';
  db.prepare(
    `INSERT INTO redeem_codes (code, reward, max_uses, used_count, expires_at, note, created_at)
     VALUES (?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET reward = excluded.reward, max_uses = excluded.max_uses,
       expires_at = excluded.expires_at, note = excluded.note`)
    .run(code, JSON.stringify({ stones, dust, tickets }), maxUses, expiresAt, note, Date.now());
  console.log(`已写入 ${code}：灵石 ${stones} · 碎屑 ${dust} · 招募券 ${tickets}` +
    (maxUses ? ` · 限 ${maxUses} 次` : ' · 不限次') +
    (expiresAt ? ` · ${days} 天后过期` : ' · 永久'));
}

function list() {
  const rows = db.prepare(
    'SELECT code, reward, max_uses, used_count, expires_at, note, deleted FROM redeem_codes ORDER BY created_at DESC').all();
  if (!rows.length) return console.log('（还没有兑换码）');
  for (const r of rows) {
    const expired = r.expires_at && r.expires_at < Date.now();
    console.log(
      `${r.code}  ${r.reward}  已用 ${r.used_count}${r.max_uses ? '/' + r.max_uses : ''}` +
      (r.expires_at ? (expired ? '  [已过期]' : `  至 ${new Date(r.expires_at).toISOString().slice(0, 10)}`) : '') +
      (r.deleted ? '  [已删除]' : '') +
      (r.note ? `  # ${r.note}` : ''));
  }
}

function rm(args) {
  const code = (args[0] || '').trim().toUpperCase();
  // 软删：保留 reward 供 redeemSince 补结授权收益；删除后不可再兑（codeGet 过滤 deleted=0）
  const info = db.prepare('UPDATE redeem_codes SET deleted = 1 WHERE code = ?').run(code);
  console.log(info.changes ? `已删除 ${code}` : `没有 ${code} 这个码`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'add') add(rest);
else if (cmd === 'list') list();
else if (cmd === 'rm') rm(rest);
else {
  console.log('用法：node server/codes.js add <CODE> [--stones N] [--dust N] [--tickets N] [--max N] [--days N] [--note "..."]');
  console.log('      node server/codes.js list');
  console.log('      node server/codes.js rm <CODE>');
  process.exit(1);
}
