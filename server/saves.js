// 云存档服务：游戏进度 JSON 的读取与入库，带体积与频次限制。
// 2026-10-31 起入库前追加增速账本校验（economy.js）：单调性 + 增速包络，
// 违规整档 400 拒收——绕过前台按钮/改档刷出的收益在服务端落不了库。
import { sendJSON, SlidingWindow } from './http-util.js';
import { checkVelocity, ledgerOf, equipPowerOf } from './economy.js';

const MAX_SAVE = 512 * 1024;        // 单份存档上限（当前满配存档约几十 KB，留足余量）
const SAVE_PER_MIN = 30;            // 每用户每分钟最多推送次数（游戏自动存档约每 10 秒一次）

// 连点器判定（2026-10-31 服务端裁定）：客户端随档上报累计手动点击数（clickCount），
// 30s 滑窗内累计 ≥200（≈6.7 次/秒持续，沿用原客户端判定速率）即判定点击器，
// 封点击 5 分钟（click_ban_until 持久化在账本，重启不丢）。判定与封禁时长全部
// 由服务端裁定，客户端仅按响应里的 clickBanUntil 阻止开箱点击。
const CLICK_WINDOW_MS = 30 * 1000;
const CLICK_BURST_MAX = 200;
const CLICK_BAN_MS = 5 * 60 * 1000;

// 种子校验生效边界：账本功能上线时间（2026-10-31）之后注册的账号，无账本行首推
// 一律过种子校验；早于它的老号首推免查（存量玩家平滑迁移，不回溯）。
const SEED_CHECK_SINCE = Date.UTC(2026, 9, 31);

export function createSaveService(db) {
  const saveWindow = new SlidingWindow(60 * 1000, SAVE_PER_MIN);
  const resetWindow = new SlidingWindow(3600 * 1000, 3); // 重置：每账号每小时最多 3 次
  const clickWindows = new Map(); // userId -> [{t, n}] 手动点击增量滑窗（内存即可，封禁时间落库）
  const stmts = {
    getSave: db.prepare('SELECT data, updated_at FROM game_saves WHERE user_id = ?'),
    upsert: db.prepare(
      `INSERT INTO game_saves (user_id, data, size, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, size = excluded.size, updated_at = excluded.updated_at`),
    setPower: db.prepare('UPDATE users SET power_score = ? WHERE id = ?'),
    setProfile: db.prepare('UPDATE users SET power_score = ?, realm = ?, pvp_snapshot = ? WHERE id = ?'),
    // 快照无效时只更新战力/境界，保留旧快照（防 NULL 毒化可战档案，见 syncPowerScore）
    setProfileMeta: db.prepare('UPDATE users SET power_score = ?, realm = ? WHERE id = ?'),
    // 存档重置（2026-10-31 云端唯一存档）：清档 + 清档案；账本不删行而是归零保留——
    // 删行会让重置后的首推走「无账本行种基线」零校验分支，等于把增速防线整条
    // 拆掉（老号可 reset 后直推贴天花板满档合法入库）。归零保留 = 首推走正常
    // 增速校验，基线 0 + 真实经过时间，合法重玩能过、伪造跳变被拒。
    delSave: db.prepare('DELETE FROM game_saves WHERE user_id = ?'),
    resetLedger: db.prepare(
      `INSERT INTO save_ledger (user_id, grants, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         stones = 0, total_stones = 0, dust_total = 0, opens = 0, exp = 0,
         pet_tickets = 0, ascensions = 0, immortal = 0, power = 0,
         tower_cleared = 0, stage_cleared = 0, endless_best = 0, wild_max = 0,
         grants = 1, clicks = 0, click_ban_until = 0, updated_at = excluded.updated_at`),
    clearProfile: db.prepare("UPDATE users SET power_score = 0, realm = '', pvp_snapshot = NULL WHERE id = ?"),
    // 增速账本：上次入库计数器快照 + 窗口内兑换码授权收益
    getLedger: db.prepare('SELECT * FROM save_ledger WHERE user_id = ?'),
    upsertLedger: db.prepare(
      `INSERT INTO save_ledger (user_id, stones, total_stones, dust_total, opens, exp, pet_tickets,
         ascensions, immortal, power, tower_cleared, stage_cleared, endless_best, wild_max, grants,
         clicks, click_ban_until, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET stones = excluded.stones, total_stones = excluded.total_stones,
         dust_total = excluded.dust_total, opens = excluded.opens, exp = excluded.exp,
         pet_tickets = excluded.pet_tickets, ascensions = excluded.ascensions, immortal = excluded.immortal,
         power = excluded.power, tower_cleared = excluded.tower_cleared, stage_cleared = excluded.stage_cleared,
         endless_best = excluded.endless_best, wild_max = excluded.wild_max, grants = excluded.grants,
         clicks = excluded.clicks, click_ban_until = excluded.click_ban_until,
         updated_at = excluded.updated_at`),
    redeemSince: db.prepare(
      `SELECT c.reward AS reward FROM redeem_log l LEFT JOIN redeem_codes c ON c.code = l.code
       WHERE l.user_id = ? AND l.created_at > ?`),
    // 动作授权日志（2026-11-01 全量服务端校验迁移）：combat/social 等服务端端点
    // 发放的每一笔收益，随存档校验一并计入授权，不触发「余额跳变」误拒
    actionSince: db.prepare(
      `SELECT kind, stones, dust, tickets, exp FROM action_log
       WHERE user_id = ? AND created_at > ?`),
  };

  // 窗口内服务端授权收益（兑换码 + 动作端点；精确计入增速包络，奖励面发放时已钳制）
  function sanctionedSince(userId, since) {
    const out = { stones: 0, dust: 0, tickets: 0 };
    for (const row of stmts.redeemSince.all(userId, since)) {
      try {
        const r = JSON.parse(row.reward);
        out.stones += Math.max(0, Math.floor(Number(r.stones) || 0));
        out.dust += Math.max(0, Math.floor(Number(r.dust) || 0));
        out.tickets += Math.max(0, Math.floor(Number(r.tickets) || 0));
      } catch (e) { /* 脏奖励数据跳过 */ }
    }
    for (const row of stmts.actionSince.all(userId, since)) {
      out.stones += Math.max(0, Math.floor(Number(row.stones) || 0));
      out.dust += Math.max(0, Math.floor(Number(row.dust) || 0));
      out.tickets += Math.max(0, Math.floor(Number(row.tickets) || 0));
    }
    return out;
  }

  function get(req, res, ctx) {
    const row = stmts.getSave.get(ctx.user.id);
    const ban = stmts.getLedger.get(ctx.user.id);
    if (!row) return sendJSON(res, 200, { found: false, text: null, updatedAt: null, clickBanUntil: 0 });
    return sendJSON(res, 200, {
      found: true, text: row.data, updatedAt: row.updated_at,
      clickBanUntil: (ban && ban.click_ban_until) || 0,
    });
  }

  // 核心数值字段的类型与量级校验：真实客户端总是整份 state 序列化上传，缺字段、
  // 非数字（含数字字符串）或超出量级天花板的一律拒绝。上限与客户端 load() 钳制同口径。
  // 只锁「量级」不锁「增速」：放置游戏数值随时长无界增长，静态上限取远超正常游玩的防火墙值。
  const SAVE_NUM_FIELDS = [
    // 灵石下限 -1e12：赌狗签到可倒扣负债（客户端 load() 软钳同口径），仍不得超历史总收益
    ['stones', -1e12, 1e18],
    ['totalStones', 0, 1e18],
    ['dust', 0, 1e15],
    ['dustTotal', 0, 1e15],
    ['opens', 0, 1e15],
    ['exp', 0, 1e15],
  ];

  function validateSave(text) {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_SAVE) return null;
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      for (const [key, lo, hi] of SAVE_NUM_FIELDS) {
        const v = data[key];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) return null;
      }
      // 十境 0–9 整数
      if (typeof data.realm !== 'number' || !Number.isInteger(data.realm) ||
        data.realm < 0 || data.realm > 9) return null;
      // 现有灵石不可能超过历史总收益（客户端同款自洽约束）
      if (data.stones > data.totalStones) return null;
      // 自报战力交给深度校验做「仙位感知」上限（1.25^仙位 会合法放大量级，
      // 静态天花板会误拒高仙位真玩家），此处不再检查
      return data;
    } catch (e) {
      return null;
    }
  }

  // —— 深度校验：与客户端 load()/fixItem 钳制同口径的结构与量级检查 ——
  // 客户端 persist 的是 load() 软钳后的 state，正常玩家永远满足以下口径；
  // 越界说明存档被手改（或前后端版本严重错配），直接 400 拒收——作弊档进不了库，
  // 也就进不了 users.power_score / 榜单 / PvP 快照。
  // 仙位感知上界：套装件与秘境要求的生成值乘 1.25^仙位，合法量级随仙位水涨船高，
  // 上界必须同步放宽，否则高仙位真玩家会被误拒。
  const DEEP = {
    SLOT_KEYS: new Set(['weapon', 'armor', 'helm', 'boots', 'artifact', 'talisman',
      'bracelet', 'ring', 'wrist', 'legs', 'band', 'wings']),
    ELEMENT_KEYS: new Set(['jin', 'mu', 'shui', 'huo', 'tu']),
    AFFIX_KEYS: new Set(['atk', 'hp', 'def', 'crit', 'ls', 'pierce']),
    SET_KEYS: new Set(['tower', 'stage', 'wild']),
    BASE_POWER: [3, 10, 30, 90, 280, 900],
    AFFIX_COUNT: [0, 0, 0, 1, 2, 3],   // 各品质词条条数
    ENHANCE_MAX: 200, STAR_MAX: 5, PROGRESS_MAX: 200,
    GEM_SLOTS_MAX: 6,                  // 部位宝石孔上限（2 + 飞升数，封顶 6）
    BAG_MAX: 300, PETS_MAX: 64,
    SPECIAL_POWER_BASE: 1e9,           // 套装件战力基准（合法顶配 ~1e8 量级 ×10 余量）
    POWER_BASE: 4e14,                  // 自报总战力基准（六件 theoretical ~3.3e14 ×余量）
    IMMORTAL_STEP: 1.25,               // 仙位倍率：1.25^immortal
    POWER_GROWTH_ALLOWANCE: 25,        // 实际战力成长余量：装备分 × 实战乘区（词条/宝石/灵宠/套装等综合放大）
  };

  const deepErrs = [];
  const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const bad = (msg) => deepErrs.push(msg);
  // 战力类上界的统一封顶：超过 MAX_SAFE_INTEGER（2^53）的数写入 users 列后，
  // 读取阶段 node:sqlite 转 Number 会抛 RangeError，把该账号所有请求打挂
  const safeCap = (v) => Math.min(Math.round(v), Number.MAX_SAFE_INTEGER);
  const immortalMult = (data) =>
    Math.pow(DEEP.IMMORTAL_STEP, isInt(data.immortal, 0, 999) ? data.immortal : 0);
  // 轮回攻击乘区（与客户端 playerCombatStats 的 1 + 0.08·轮回 同源）：实际战力口径下
  // 自报战力含此放大，上界必须同步放宽
  const ascensionMult = (data) =>
    1 + 0.08 * (isInt(data.ascensions, 0, 1e6) ? data.ascensions : 0);

  function validateItem(it, where, immortal) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return bad(where + ' 非对象');
    if (!isInt(it.id, 1, 1e9)) return bad(where + ' id 越界');
    if (!DEEP.SLOT_KEYS.has(it.slot)) return bad(where + ' 部位非法');
    if (!isInt(it.r, 0, 5)) return bad(where + ' 品质非法');
    if (!DEEP.ELEMENT_KEYS.has(it.el)) return bad(where + ' 五行非法');
    if (typeof it.name !== 'string' || it.name.length > 40) return bad(where + ' 名称非法');
    const special = !!it.special;
    if (special) {
      if (it.r !== 5) return bad(where + ' 套装件品质必为仙品');
      if (!DEEP.SET_KEYS.has(it.setKey)) return bad(where + ' 套装件缺合法套装键');
    } else if (it.setKey !== undefined && !DEEP.SET_KEYS.has(it.setKey)) {
      return bad(where + ' setKey 非法');
    }
    // 战力上界：普通件=品质基准×1.3（客户端 fixItem 同款）；套装件随仙位放宽
    const powerCap = special
      ? safeCap(DEEP.SPECIAL_POWER_BASE * immortalMult({ immortal }))
      : Math.round(DEEP.BASE_POWER[it.r] * 1.3);
    if (typeof it.power !== 'number' || !Number.isFinite(it.power) || it.power < 1 || it.power > powerCap) {
      return bad(where + ' 战力越界（上限 ' + powerCap + '）');
    }
    // 词条：数量 ≤ 品质条数，键白名单，值 0..0.6，不重复
    // 可选字段缺失按客户端语义放行（it.star || 0、空数组）——新获得的装备在
    // 当前会话内可能没有 star / gems 字段，JSON 序列化时会被丢弃
    const lv = it.lv === undefined ? 0 : it.lv;
    const star = it.star === undefined ? 0 : it.star;
    if (!isInt(lv, 0, DEEP.ENHANCE_MAX)) return bad(where + ' 强化越界');
    if (!isInt(star, 0, DEEP.STAR_MAX)) return bad(where + ' 升星越界');
    const count = DEEP.AFFIX_COUNT[it.r];
    if (it.affixes !== undefined && !Array.isArray(it.affixes)) return bad(where + ' 词条类型非法');
    const affixes = it.affixes || [];
    if (affixes.length > count) return bad(where + ' 词条数越界');
    const seen = new Set();
    for (const a of affixes) {
      if (!a || typeof a !== 'object' || !DEEP.AFFIX_KEYS.has(a.k)) return bad(where + ' 词条键非法');
      if (typeof a.v !== 'number' || !Number.isFinite(a.v) || a.v < 0 || a.v > 0.6) return bad(where + ' 词条值越界');
      if (seen.has(a.k)) return bad(where + ' 词条重复');
      seen.add(a.k);
      if (a.lock !== undefined && typeof a.lock !== 'boolean') return bad(where + ' 词条锁类型非法');
    }
    // 宝石：孔位 ≤2（仙品 2 / 其余 1），等级 1..3
    const sockets = it.r >= 5 ? 2 : 1;
    if (it.gems !== undefined && !Array.isArray(it.gems)) return bad(where + ' 宝石类型非法');
    const gems = it.gems || [];
    if (gems.length > sockets) return bad(where + ' 宝石孔数越界');
    for (const g of gems) {
      if (g === null) continue;
      if (!g || typeof g !== 'object' || !DEEP.AFFIX_KEYS.has(g.k)) return bad(where + ' 宝石键非法');
      if (!isInt(g.t, 1, 3)) return bad(where + ' 宝石等级越界');
    }
    return null;
  }

  // 返回 null = 通过；字符串 = 第一个违规原因。只做「拒收判定」，不改写数据。
  function validateDeep(data) {
    deepErrs.length = 0;
    if (!isInt(data.immortal, 0, 999)) bad('仙位越界');
    if (!isInt(data.ascensions, 0, 1e6)) bad('轮回越界');
    // 境界水位（2026-11-01）：解锁回锁豁免的水印字段，客户端 featureOpen/剧情按 max(realm, 水位) 判定
    if (data.realmPeak !== undefined && !isInt(data.realmPeak, 0, 9)) bad('境界水位越界');
    if (data.clickCount !== undefined && !isInt(data.clickCount, 0, 1e12)) bad('点击计数越界');
    for (const k of ['trainAtk', 'trainHp', 'trainPierce']) {
      if (!isInt(data[k], 0, DEEP.PROGRESS_MAX)) bad(k + ' 越界');
    }
    if (!isInt(data.towerCleared, 0, DEEP.PROGRESS_MAX)) bad('爬塔进度越界');
    if (!isInt(data.stageCleared, 0, DEEP.PROGRESS_MAX)) bad('闯关进度越界');
    // 野外已探区列表：只收 0..200 的整型元素（与 wildMaxOf 的钳制同口径）。
    // 不校验会有自锁口：推 wildCleared:[1e300] 种下巨大 wild_max 基线，
    // 之后任何真实进度都触发「野外探区出现回退」被永久拒收。
    if (data.wildCleared !== undefined) {
      if (!Array.isArray(data.wildCleared) || data.wildCleared.length > DEEP.PROGRESS_MAX) {
        bad('野外探区表非法');
      } else {
        for (const z of data.wildCleared) {
          if (!isInt(z, 0, DEEP.PROGRESS_MAX)) { bad('野外探区越界'); break; }
        }
      }
    }
    if (data.gongfa && typeof data.gongfa === 'object' && !Array.isArray(data.gongfa)) {
      for (const k of ['atk', 'hp', 'hui']) {
        if (!isInt(data.gongfa[k], 0, DEEP.PROGRESS_MAX)) bad('功法 ' + k + ' 越界');
      }
    }
    if (data.cave && typeof data.cave === 'object' && !Array.isArray(data.cave)) {
      for (const k of ['array', 'garden', 'library']) {
        if (!isInt(data.cave[k], 0, DEEP.PROGRESS_MAX)) bad('洞府 ' + k + ' 越界');
      }
    }
    // 部位强化 / 部位宝石（2026-10-31 部位化：强化与宝石改绑槽位，键 ⊆ 六槽位）
    if (data.enh !== undefined) {
      if (!data.enh || typeof data.enh !== 'object' || Array.isArray(data.enh)) bad('部位强化表非法');
      else {
        const keys = Object.keys(data.enh);
        if (keys.length > DEEP.SLOT_KEYS.size) bad('部位强化键数越界');
        for (const k of keys) {
          if (!DEEP.SLOT_KEYS.has(k)) bad('部位强化键非法');
          else if (!isInt(data.enh[k], 0, DEEP.ENHANCE_MAX)) bad('部位强化等级越界');
        }
      }
    }
    if (data.slotGems !== undefined) {
      if (!data.slotGems || typeof data.slotGems !== 'object' || Array.isArray(data.slotGems)) bad('部位宝石表非法');
      else {
        const keys = Object.keys(data.slotGems);
        if (keys.length > DEEP.SLOT_KEYS.size) bad('部位宝石键数越界');
        for (const k of keys) {
          if (!DEEP.SLOT_KEYS.has(k)) { bad('部位宝石键非法'); continue; }
          const arr = data.slotGems[k];
          if (!Array.isArray(arr) || arr.length > DEEP.GEM_SLOTS_MAX) { bad('部位宝石孔数越界'); continue; }
          for (const g of arr) {
            if (g === null) continue;
            if (!g || typeof g !== 'object' || Array.isArray(g) || !DEEP.AFFIX_KEYS.has(g.k)) { bad('部位宝石类型非法'); break; }
            if (!isInt(g.t, 1, 3)) { bad('部位宝石等级越界'); break; }
          }
        }
      }
    }
    if (data.pets !== undefined) {
      if (!data.pets || typeof data.pets !== 'object' || Array.isArray(data.pets)) {
        bad('灵宠表非法');
      } else {
        const keys = Object.keys(data.pets);
        if (keys.length > DEEP.PETS_MAX) bad('灵宠数越界');
        for (const k of keys) {
          if (!isInt(data.pets[k], 0, DEEP.PROGRESS_MAX)) bad('灵宠等级越界');
        }
      }
    }
    // 外围资源：与客户端 load() 钳制同口径（器魂/兽骨/券/符）
    if (data.souls !== undefined && !isInt(data.souls, 0, 1e9)) bad('器魂越界');
    if (data.beastBones !== undefined && !isInt(data.beastBones, 0, 1e9)) bad('兽骨越界');
    if (data.petTickets !== undefined && !isInt(data.petTickets, 0, 1e9)) bad('招募券越界');
    if (data.rerollCoupon !== undefined && !isInt(data.rerollCoupon, 0, 99)) bad('洗练券越界');
    if (data.talismans !== undefined && !isInt(data.talismans, 0, 99)) bad('护体符越界');
    // 第七批玩法字段：与客户端 load() 钳制同口径（只锁量级；时间戳类不校验——
    // 客户端时钟可能有偏差，且 until/last 等超前只损玩家自身、无收益）
    if (data.wander !== undefined) {
      if (!data.wander || typeof data.wander !== 'object' || Array.isArray(data.wander)) bad('奇遇字段非法');
      else {
        if (!isInt(data.wander.karma, -10, 10)) bad('果报越界');
        if (data.wander.done !== undefined && !isInt(data.wander.done, 0, 1e9)) bad('奇遇计数越界');
      }
    }
    if (data.treasure !== undefined) {
      if (!data.treasure || typeof data.treasure !== 'object' || Array.isArray(data.treasure)) bad('藏宝图字段非法');
      else {
        if (!isInt(data.treasure.frags, 0, 1e6)) bad('残片越界');
        if (!isInt(data.treasure.maps, 0, 99)) bad('藏宝图数量越界');
        if (!isInt(data.treasure.at, -1, 95)) bad('宝点越界');
        if (!isInt(data.treasure.digs, 0, 1e6)) bad('挖宝计数越界');
      }
    }
    if (data.fishing !== undefined) {
      if (!data.fishing || typeof data.fishing !== 'object' || Array.isArray(data.fishing)) bad('钓鱼字段非法');
      else {
        if (!isInt(data.fishing.bait, 0, 99)) bad('鱼饵越界');
        if (!isInt(data.fishing.casts, 0, 1e9)) bad('垂钓计数越界');
        if (!isInt(data.fishing.bestT, -1, 4)) bad('鱼档越界');
      }
    }
    if (data.petCores !== undefined) {
      if (!data.petCores || typeof data.petCores !== 'object' || Array.isArray(data.petCores)) bad('内丹表非法');
      else {
        const keys = Object.keys(data.petCores);
        if (keys.length > DEEP.PETS_MAX) bad('内丹数越界');
        for (const k of keys) {
          if (!isInt(data.petCores[k], 0, 10)) bad('内丹等级越界');
        }
      }
    }
    if (data.gather !== undefined) {
      if (!data.gather || typeof data.gather !== 'object' || Array.isArray(data.gather) ||
        !data.gather.nodes || typeof data.gather.nodes !== 'object' || Array.isArray(data.gather.nodes)) {
        bad('灵圃字段非法');
      } else {
        if (!isInt(data.gather.ore, 0, 1e6)) bad('矿石越界');
        if (!isInt(data.gather.herb, 0, 1e6)) bad('灵药越界');
        const keys = Object.keys(data.gather.nodes);
        if (keys.length > 4) bad('灵圃节点越界');
        for (const k of keys) {
          const n = data.gather.nodes[k];
          if (!n || typeof n !== 'object' || Array.isArray(n)) { bad('灵圃节点非法'); break; }
          if (!isInt(n.lv, 0, 60)) bad('灵圃等级越界');
        }
      }
    }
    const immortal = isInt(data.immortal, 0, 999) ? data.immortal : 0;
    // 背包：数量与逐件口径
    if (data.bag !== undefined) {
      if (!Array.isArray(data.bag) || data.bag.length > DEEP.BAG_MAX) {
        bad('背包数量越界');
      } else {
        data.bag.forEach((it, i) => validateItem(it, '背包[' + i + ']', immortal));
      }
    }
    // 已穿戴六件：深度校验（战力直接驱动 totalPower 与榜单）
    if (data.equipped !== undefined) {
      if (!data.equipped || typeof data.equipped !== 'object' || Array.isArray(data.equipped)) {
        bad('穿戴表非法');
      } else {
        for (const slot of DEEP.SLOT_KEYS) {
          const it = data.equipped[slot];
          if (it === null || it === undefined) continue;
          validateItem(it, '穿戴[' + slot + ']', immortal);
        }
      }
    }
    // 自报总战力（实际战力口径：装备分 × 实战乘区）：与仙位、轮回相关的理论上界，
    // 再乘成长余量放行词条/宝石/灵宠/套装等综合放大；9e15 封顶见 safeCap 注释——
    // 超 MAX_SAFE_INTEGER 的战力入列会砖掉账号读取
    const powerCap = safeCap(
      DEEP.POWER_BASE * immortalMult({ immortal }) * ascensionMult(data) * DEEP.POWER_GROWTH_ALLOWANCE
    );
    if (data.power !== undefined &&
      (typeof data.power !== 'number' || !Number.isFinite(data.power) || data.power < 0 || data.power > powerCap)) {
      bad('自报战力越界（上限 ' + powerCap.toExponential() + '）');
    }
    return deepErrs.length ? deepErrs[0] : null;
  }

  function store(req, res, ctx) {
    if (!saveWindow.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '保存过于频繁，请稍后再试' }, { 'Retry-After': '30' });
    }
    const data = validateSave(ctx.rawBody);
    if (!data) {
      return sendJSON(res, 400, { error: '存档校验失败' });
    }
    const deepFail = validateDeep(data);
    if (deepFail) {
      console.error('[saves] 深度校验拒收 user=' + ctx.user.id + '：' + deepFail);
      return sendJSON(res, 400, { error: '存档校验失败' });
    }
    const now = Date.now();
    const led = ledgerOf(data, now);
    // —— 增速账本校验：无账本行以当档种入基线；有则做单调性 + 增速校验 ——
    const prevRow = stmts.getLedger.get(ctx.user.id);
    if (prevRow) {
      const prev = {
        stones: prevRow.stones,
        totalStones: prevRow.total_stones,
        dustTotal: prevRow.dust_total,
        opens: prevRow.opens,
        exp: prevRow.exp,
        petTickets: prevRow.pet_tickets,
        ascensions: prevRow.ascensions,
        immortal: prevRow.immortal,
        power: prevRow.power,
        towerCleared: prevRow.tower_cleared,
        stageCleared: prevRow.stage_cleared,
        endlessBest: prevRow.endless_best,
        wildMax: prevRow.wild_max,
        grants: prevRow.grants,
      };
      const fail = checkVelocity(prev, data, now - prevRow.updated_at, sanctionedSince(ctx.user.id, prevRow.updated_at));
      if (fail) {
        console.error('[saves] 增速校验拒收 user=' + ctx.user.id + '：' + fail);
        return sendJSON(res, 400, { error: '存档增速异常，已保留上次云端进度' });
      }
    } else if (ctx.user.createdAt && ctx.user.createdAt >= SEED_CHECK_SINCE) {
      // —— 新号首推种子校验（复审补，2026-11-01 二修）：账本功能上线后注册的账号，
      // 无账本行首推一律过种子校验。原「注册 1 小时内」口径有绕过口：注册后等满
      // 1 小时再首推，既不走增速校验也不走种子校验，可一次种入 immortal=999 满档
      // 基线（防线整体失效）。改为以功能上线时间为界：早于它的存量账号免校验
      // （不回溯迁移），之后注册的无论账龄、首推必查。堵两条线：
      // ① 手写 localStorage / 直调 API 一次推满档（种基线零校验 = 全部防线失效）；
      // ② 登出不清本地档，同浏览器新号继承旧大号存档。
      const seedFails = [];
      if (Number(data.totalStones) > 5e7) seedFails.push('累计灵石超新号上限');
      if (Number(data.opens) > 2e5) seedFails.push('开箱次数超新号上限');
      if (Number(data.dustTotal) > 2e6) seedFails.push('累计碎屑超新号上限');
      if (Number(data.petTickets) > 1000) seedFails.push('招募券超新号上限');
      if (Number(data.immortal) > 0 || Number(data.ascensions) > 0) seedFails.push('仙位/轮回超新号上限');
      if (equipPowerOf(data) > 2e5) seedFails.push('装备战力超新号上限');
      if (seedFails.length) {
        console.error('[saves] 新号种子校验拒收 user=' + ctx.user.id + '：' + seedFails[0]);
        return sendJSON(res, 400, { error: '新账号存档异常，请从零开始修行' });
      }
    }
    // —— 连点器判定（服务端裁定）：30s 滑窗累计手动点击增量 ——
    let clickBanUntil = prevRow ? (prevRow.click_ban_until || 0) : 0;
    // clicks 不做 |0：32 位截断下每次恰好 +2^32（validateDeep 上限 1e12 内合法）会让
    // 增量恒为 0，连点判定永不触发；clampInt 已保证整数
    const dClicks = Math.max(0, Math.floor(led.clicks) - (prevRow ? Math.floor(prevRow.clicks || 0) : 0));
    const clickArr = clickWindows.get(ctx.user.id) || [];
    const clickCutoff = now - CLICK_WINDOW_MS;
    while (clickArr.length && clickArr[0].t <= clickCutoff) clickArr.shift();
    clickArr.push({ t: now, n: dClicks });
    clickWindows.set(ctx.user.id, clickArr);
    const windowClicks = clickArr.reduce((a, x) => a + x.n, 0);
    if (windowClicks >= CLICK_BURST_MAX && now >= clickBanUntil) {
      clickBanUntil = now + CLICK_BAN_MS;
      console.error('[saves] 连点器判定 user=' + ctx.user.id + '：30s 内手动点击 ' +
        windowClicks + ' 次，封点击 5 分钟');
    }

    db.exec('BEGIN');
    try {
      stmts.upsert.run(ctx.user.id, ctx.rawBody, Buffer.byteLength(ctx.rawBody), now);
      syncPowerScore(ctx.user.id, data);
      stmts.upsertLedger.run(
        ctx.user.id, led.stones, led.totalStones, led.dustTotal, led.opens, led.exp,
        led.petTickets, led.ascensions, led.immortal, led.power,
        led.towerCleared, led.stageCleared, led.endlessBest, led.wildMax,
        prevRow ? 0 : 1, led.clicks, clickBanUntil, now);   // 校验通过即清离线豁免；种基线发 1 次
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return sendJSON(res, 200, { ok: true, updatedAt: now, clickBanUntil });
  }

  // 存档同步顺带落战力档案：power / realm / PvP 快照（客户端 persist 时打包）。
  // 快照做边界钳制，防存档被改出天际数值直接进天梯与排行。
  // 注意：客户端 persist() 打包的字段名是 pvpSnap（2026-10-31 实测发现服务端一直读的
  // data.pvp 对不上号，真客户端快照从未入库——两处字段名都接受，修存量口径漂移）。
  function syncPowerScore(userId, data) {
    const power = Number(data && data.power);
    const realm = Number(data && data.realm);
    if (!Number.isFinite(power) || power < 0) return;
    const snap = sanitizeSnapshot((data.pvpSnap && typeof data.pvpSnap === 'object')
      ? data.pvpSnap : data.pvp, power);
    // 榜单战力天花板与深度校验的自报战力上界同口径（深度校验已拒越界档，此处兜底），
    // 9e15 封顶保证入库值始终在 JS 安全整数内（见 safeCap 注释）
    const cap = safeCap(
      DEEP.POWER_BASE * immortalMult({ immortal: data.immortal }) *
      ascensionMult(data) * DEEP.POWER_GROWTH_ALLOWANCE
    );
    const p = Math.min(Math.floor(power), cap);
    const r = Number.isFinite(realm) && realm >= 0 && realm <= 9 ? String(Math.floor(realm)) : '0';
    if (snap) stmts.setProfile.run(p, r, JSON.stringify(snap), userId);
    else stmts.setProfileMeta.run(p, r, userId);
  }

  // PvP 快照：{atk, hp, def, crit, critMult, lifesteal, dr, pierce}，与 power 量级挂钩钳制
  function sanitizeSnapshot(raw, power) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const num = (v, lo, hi) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      return Math.min(hi, Math.max(lo, n));
    };
    const p = Math.max(1, power);
    const atk = num(raw.atk, 1, p * 100);
    const hp = num(raw.hp, 1, p * 1000);
    const def = num(raw.def, 0, p * 50);
    if (atk === null || hp === null || def === null) return null;
    return {
      atk: Math.round(atk * 100) / 100,
      hp: Math.round(hp * 100) / 100,
      def: Math.round(def * 100) / 100,
      crit: num(raw.crit, 0, 0.6) ?? 0.1,
      critMult: num(raw.critMult, 1, 10) ?? 2,
      lifesteal: num(raw.lifesteal, 0, 0.5) ?? 0,
      dr: num(raw.dr, 0, 0.6) ?? 0,
      pierce: num(raw.pierce, 0, 1) ?? 0,
    };
  }

  // 重置存档：删云端档与增速账本、清排行档案（power_score / realm / pvp_snapshot）。
  // 账本一并清空——下次首推按「无账本行首档种基线」走，等价于全新账号开局。
  // 仙盟 / 竞技场天梯等社交数据不在重置范围（与旧本地重置口径一致）。
  function reset(req, res, ctx) {
    if (!resetWindow.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '重置过于频繁，请一小时后再试' }, { 'Retry-After': '3600' });
    }
    try {
      db.exec('BEGIN');
      try {
        stmts.delSave.run(ctx.user.id);
        stmts.resetLedger.run(ctx.user.id, Date.now());
        stmts.clearProfile.run(ctx.user.id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return sendJSON(res, 200, { ok: true });
    } catch (err) {
      console.error('[saves] reset user=' + ctx.user.id, err);
      return sendJSON(res, 500, { error: '重置失败，请稍后再试' });
    }
  }

  return { get, store, reset };
}
