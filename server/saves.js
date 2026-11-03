// 云存档服务：游戏进度 JSON 的读取与入库，带体积与频次限制。
// 2026-10-31 起入库前追加增速账本校验（economy.js）：单调性 + 增速包络，
// 违规整档 400 拒收——绕过前台按钮/改档刷出的收益在服务端落不了库。
import { sendJSON, SlidingWindow } from './http-util.js';
import { checkVelocity, ledgerOf, equipPowerOf } from './economy.js';
import { PET_SPECIES, PET_LV_MAX, PET_INST_MAX } from './pets.js';

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
    // 云来坊市（2026-11-02 模拟经营）：建筑/库存/商誉同样是进度，重置一并清零
    delShop: db.prepare('DELETE FROM shop_state WHERE user_id = ?'),
    // 重置归零清单必须覆盖全部进度/计数列：wild_cleared、trial_done、sweep_used、
    // offline_at、set_pity 等原本残留——重置号会继承旧野外进度/试炼当日已做/扫荡
    // 已用等状态，与「等价于全新账号开局」矛盾（复审 P2：set_pity 是 JSON 列同样要清）
    resetLedger: db.prepare(
      `INSERT INTO save_ledger (user_id, grants, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         stones = 0, total_stones = 0, dust_total = 0, opens = 0, exp = 0,
         pet_tickets = 0, ascensions = 0, immortal = 0, power = 0,
         tower_cleared = 0, stage_cleared = 0, endless_best = 0, wild_max = 0,
         wild_cleared = '[]', wild_kills = '{}', wild_repeat_day = '', wild_repeat_used = 0,
         sweep_day = '', sweep_used = '{}', sweep_bought = '{}',
         trial_day = '', trial_done = '[]', offline_at = 0, set_pity = NULL,
         pet_hunt = NULL,
         cli_sync = NULL,
         /* claim_days 保留（2026-11-03）：天道录无 gate 梯子只靠 claim_days 做「终身一次」，
            清空会让 reset×tide 变成可重复领取（3 次/时）；重置清进度但不清领取史 */
         claim_days = claim_days,
         grants = 1, clicks = 0, click_ban_until = 0, updated_at = excluded.updated_at`),
    // 领奖日锁（乐观锁 CAS：并发双标签页领取只有一个能改写成功）
    setClaimDays: db.prepare(
      'UPDATE save_ledger SET claim_days = ? WHERE user_id = ? AND claim_days IS ?'),
    // 领奖授权入流水：action_log 由 sanctionedSince 计入收益增速包络（防「领奖后包络击穿」）
    logClaim: db.prepare(
      'INSERT INTO action_log (user_id, day, kind, stones, dust, tickets, exp, created_at) VALUES (?, ?, ?, ?, 0, 0, 0, ?)'),
    clearProfile: db.prepare("UPDATE users SET power_score = 0, realm = '', pvp_snapshot = NULL WHERE id = ?"),
    // 在线心跳（2026-11-02 用户指令「玩的时间要排除在离线结算外」）：每次存档推送成功
    // 都把离线结算起点戳到服务器当前时刻——在线游玩时客户端每 ~5 秒推一次档、切后台/
    // 关页有 beacon 立推，offline_at 恒等于「最近一次在线时刻」，刷新时 elapsed 只剩
    // 几秒（<60 直接 settled:false），在线时长不再被当成离线时长双发。
    // 只在 POST /api/save（store）戳：GET /api/save（启动拉档）不戳，否则启动时的
    // 离线结算 elapsed 恒为 0，真离线收益会整个消失
    setOfflineAt: db.prepare('UPDATE save_ledger SET offline_at = ? WHERE user_id = ?'),
    // 增速账本：上次入库计数器快照 + 窗口内兑换码授权收益
    getLedger: db.prepare('SELECT * FROM save_ledger WHERE user_id = ?'),
    upsertLedger: db.prepare(
      `INSERT INTO save_ledger (user_id, stones, total_stones, dust_total, opens, exp, pet_tickets,
         ascensions, immortal, power, tower_cleared, stage_cleared, endless_best, wild_max, grants,
         clicks, click_ban_until, cli_sync, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET stones = excluded.stones, total_stones = excluded.total_stones,
         dust_total = excluded.dust_total, opens = excluded.opens, exp = excluded.exp,
         pet_tickets = excluded.pet_tickets, ascensions = excluded.ascensions, immortal = excluded.immortal,
         power = excluded.power, grants = excluded.grants,
         clicks = excluded.clicks, click_ban_until = excluded.click_ban_until,
         cli_sync = excluded.cli_sync,
         /* 进度列只进不退：cli_sync 基线下允许客户端推更低的镜像过单调校验，若照抄
            excluded 值会让服务端进度回退——下一场又按 first=1.5× 首通结算（复刷首通
            奖励 3 倍差的口子）。MAX 钳制后客户端展示镜像不变，防砖语义保留 */
         tower_cleared = MAX(tower_cleared, excluded.tower_cleared),
         stage_cleared = MAX(stage_cleared, excluded.stage_cleared),
         endless_best = MAX(endless_best, excluded.endless_best),
         wild_max = MAX(wild_max, excluded.wild_max),
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
    SPECIAL_POWER_BASE: 1e9,           // 套装件战力基准（合法顶配 ~1e8 量级 ×10 余量；套装件不入装备等级体系）
    POWER_BASE: 4e14,                  // 自报总战力基准（六件 theoretical ~3.3e14 ×余量）
    EQUIP_LV_MAX: 10,                  // 装备等级上限（未飞升仙人 = 境界下标+1；飞升后归 0 重爬；仅普通件）
    EQUIP_LV_STEP_MAX: 2.16,           // 装备等级每级战力复利上界（客户端掷 [2.0,2.16]，Lv.1 基线共 lv-1 步）
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

  function validateItem(it, where, immortal, maxRealm) {
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
    // 装备等级（2026-11-01，仅普通件；套装件维持现状不带 lv）：掉落时随境界定死
    //（未飞升 = 境界下标+1，飞升后归 0），0..10 白名单；缺失按迁移基线 1 计
    const elv = it.lv === undefined ? 1 : it.lv;
    if (!isInt(elv, 0, DEEP.EQUIP_LV_MAX)) return bad(where + ' 装备等级越界');
    // 等级-境界耦合（2026-11-03 补校验）：掉落定级 = min(当前水位+1, 10)（未飞升 realm+1 /
    // 飞升 realm，realm 单调不降、realmPeak 是历史水位）→ elv ≤ maxRealm+1 恒成立；
    // 此前只查 0..10 白名单，新号可直推 6 件 Lv.10 仙品过校验打穿尾段内容
    if (!isInt(elv, 0, (isInt(maxRealm, 0, 9) ? maxRealm : 0) + 1)) {
      return bad(where + ' 装备等级超出当前境界定级（≤' + ((isInt(maxRealm, 0, 9) ? maxRealm : 0) + 1) + '）');
    }
    // 战力上界：普通件=品质基准×1.2×2.16^(lv-1)（客户端 fixItem 同款，Lv.1 基线 ×1，
    // 仙品 Lv.10 理论上界 ≈ 1.1e6）；套装件不入等级体系，仍按 1e9 基准 × 仙位放宽
    const powerCap = special
      ? safeCap(DEEP.SPECIAL_POWER_BASE * immortalMult({ immortal }))
      : Math.round(DEEP.BASE_POWER[it.r] * 1.2 *
        Math.pow(DEEP.EQUIP_LV_STEP_MAX, Math.max(0, elv - 1)));
    if (typeof it.power !== 'number' || !Number.isFinite(it.power) || it.power < 1 || it.power > powerCap) {
      return bad(where + ' 战力越界（上限 ' + powerCap + '）');
    }
    // 词条：数量 ≤ 品质条数，键白名单，值 0..0.6，不重复
    // 可选字段缺失按客户端语义放行（it.star || 0、空数组）——新获得的装备在
    // 当前会话内可能没有 star / gems 字段，JSON 序列化时会被丢弃
    const star = it.star === undefined ? 0 : it.star;
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
      // fang（2026-11-03 补校验）：云坊等级喂 battle.js fangMult（攻血防 ×(1+0.002×级)），
      // 原先只查三键时改档 fang:5e9 可把面板放大 ×1e7 过战斗复算。
      // 可选键模式（同 gainLv/activePets）：云坊上线前的旧客户端推档不带 fang，
      // undefined 必须放行按 0 计（fangMult num(undefined)=0），只拒「带了但非法」——
      // 写成必填曾把旧客户端推档永久拒死（2026-11-03 正式环境 user26 事故）
      if (data.cave.fang !== undefined && !isInt(data.cave.fang, 0, DEEP.PROGRESS_MAX)) {
        bad('洞府 fang 越界');
      }
    }
    // 升级等级（2026-11-03 补校验）：gainLv 喂 baseGainOf 离线结算（0.9/级灵石）、
    // speedLv 喂开箱 interval——客户端 UPGRADES.gain.max=60 / speed.max=50，越界即改档
    if (data.gainLv !== undefined && !isInt(data.gainLv, 0, 60)) bad('gainLv 越界');
    if (data.speedLv !== undefined && !isInt(data.speedLv, 0, 50)) bad('speedLv 越界');
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
    // —— 方格牧场（2026-11-02 灵田改 12×12 方格）：解锁格白名单、作物键值钳制、
    // 种子/洗炼石库存钳量级。农场产出只有碎屑（单格 ≤800，全图爆收 11.5 万 < 碎屑包络
    // 绝对底 ≈13.9 万），不新增增速面；洗炼石/种子是新资源类型，只锁量级 ——
    const FARM_SEED_IDS = ['cao', 'hua', 'guo', 'sui', 'lian', 'tong', 'xing']; // 与 game.js FARM_SEEDS 同源
    if (data.farm !== undefined) {
      if (!data.farm || typeof data.farm !== 'object' || Array.isArray(data.farm)) {
        bad('牧场字段非法');
      } else {
        if (data.farm.unlocked !== undefined) {
          if (!Array.isArray(data.farm.unlocked) || data.farm.unlocked.length > 144) {
            bad('牧场解锁格非法');
          } else if (data.farm.unlocked.some((n) => !isInt(n, 0, 143))) {
            bad('牧场解锁格越界');
          } else if (new Set(data.farm.unlocked).size !== data.farm.unlocked.length) {
            bad('牧场解锁格重复');
          }
        }
        if (data.farm.plots !== undefined) {
          const plots = data.farm.plots;
          if (Array.isArray(plots)) {
            // 老灵田数组形状：至多 3 格
            if (plots.length > 3) bad('牧场作物越界');
          } else if (!plots || typeof plots !== 'object') {
            bad('牧场作物非法');
          } else {
            const keys = Object.keys(plots);
            if (keys.length > 144) {
              bad('牧场作物越界');
            } else {
              for (const k of keys) {
                const n = Number(k);
                const p = plots[k];
                if (!Number.isInteger(n) || n < 0 || n > 143) { bad('牧场作物格越界'); break; }
                if (!p || typeof p !== 'object' || Array.isArray(p) ||
                  typeof p.id !== 'string' || !FARM_SEED_IDS.includes(p.id) ||
                  typeof p.doneAt !== 'number' || !Number.isFinite(p.doneAt)) {
                  bad('牧场作物数据非法'); break;
                }
              }
            }
          }
        }
      }
    }
    if (data.farmSeeds !== undefined) {
      if (!data.farmSeeds || typeof data.farmSeeds !== 'object' || Array.isArray(data.farmSeeds) ||
        Object.keys(data.farmSeeds).length > 8) {
        bad('种子库存非法');
      } else {
        for (const k of Object.keys(data.farmSeeds)) {
          if (!FARM_SEED_IDS.includes(k) || !isInt(data.farmSeeds[k], 0, 1e6)) { bad('种子库存越界'); break; }
        }
      }
    }
    if (data.rerollStones !== undefined) {
      if (!data.rerollStones || typeof data.rerollStones !== 'object' || Array.isArray(data.rerollStones) ||
        Object.keys(data.rerollStones).length > 6) {
        bad('洗炼石库存非法');
      } else {
        for (const k of Object.keys(data.rerollStones)) {
          if (!DEEP.AFFIX_KEYS.has(k) || !isInt(data.rerollStones[k], 0, 1e6)) { bad('洗炼石库存越界'); break; }
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
        for (const k of Object.keys(data.petCores)) {
          if (!isInt(data.petCores[k], 0, 10)) bad('内丹等级越界');
        }
      }
    }
    // —— 灵宠个体（2026-11-02 灵宠个体化）：与 server/pets.js rollPetInst 生成器同界 ——
    // 物种白名单 / uid 唯一 / 品质在物种带内 / 等级 1..100 / 词条数=品质条数 /
    // 值 0..0.6 / 键不重复。捕捉/合成/洗髓全服务端掷，伪造个体只能落在合法结构内。
    const PET_SP_MAP = {};
    for (const s of PET_SPECIES) PET_SP_MAP[s.id] = s;
    // 灵宠背包扩容次数（2026-11-02 容量化：基础 50 格，扩容 0..5 次至多 100）
    if (data.petBagLv !== undefined && !isInt(data.petBagLv, 0, 5)) bad('灵宠背包扩容越界');
    if (data.petInsts !== undefined) {
      if (!Array.isArray(data.petInsts) || data.petInsts.length > PET_INST_MAX) {
        bad('灵宠个体表非法');
      } else {
        const uids = new Set();
        data.petInsts.forEach((p, i) => {
          if (!p || typeof p !== 'object' || Array.isArray(p)) { bad('灵宠个体[' + i + ']非法'); return; }
          const spDef = PET_SP_MAP[p.sp];
          if (!spDef) { bad('灵宠个体物种非法'); return; }
          if (!isInt(p.uid, 1, 1e9) || uids.has(p.uid)) { bad('灵宠个体 uid 非法'); return; }
          uids.add(p.uid);
          // 品质上界按物种带封顶（可铸词条条数上限随之封顶）；下界放宽到 0：老档融合
          // 迁移（game.js petMigrated）给已招募物种赠的是凡品 r=0，而旧四宠物种带
          // band[0]≥1（狐[1,3]/龟[1,2]/鼠[1,2]/貔[2,4]），按带下界拒收会把全部老玩家
          // 永久拒死（2026-11-03 正式环境 user25 事故）。低于带只是「弱于合法下限」：
          // 战斗加成只看词条、词条条数按实际 r 封顶（AFFIX_COUNT[0]=0 最弱），无放大面
          if (!isInt(p.r, 0, spDef.band[1])) { bad('灵宠个体品质越界'); return; }
          if (!isInt(p.lv, 1, PET_LV_MAX)) { bad('灵宠个体等级越界'); return; }
          if (p.rerolls !== undefined && !isInt(p.rerolls, 0, 1e6)) { bad('灵宠洗髓计数越界'); return; }
          const count = DEEP.AFFIX_COUNT[p.r];
          if (p.affixes !== undefined && !Array.isArray(p.affixes)) { bad('灵宠个体词条类型非法'); return; }
          const affixes = p.affixes || [];
          if (affixes.length > count) { bad('灵宠个体词条数越界'); return; }
          const seen = new Set();
          for (const a of affixes) {
            if (!a || typeof a !== 'object' || !DEEP.AFFIX_KEYS.has(a.k)) { bad('灵宠个体词条键非法'); return; }
            if (typeof a.v !== 'number' || !Number.isFinite(a.v) || a.v < 0 || a.v > 0.6) { bad('灵宠个体词条值越界'); return; }
            if (seen.has(a.k)) { bad('灵宠个体词条重复'); return; }
            seen.add(a.k);
            if (a.lock !== undefined && typeof a.lock !== 'boolean') { bad('灵宠个体词条锁类型非法'); return; }
          }
        });
      }
    }
    if (data.petSeq !== undefined && !isInt(data.petSeq, 0, 1e9)) bad('灵宠序号越界');
    // 出战位（2026-11-03 补校验）：activePets 直接喂 battle.js petAggOf/内丹/stoneBuff，
    // 原先零校验——重复 uid 或超长数组会把天赋/词条/内丹加成 ×N 复读并放大服务端
    // 结算发放。口径：数组 ≤5（客户端 PET_SLOT_MAX）、元素为合法 uid 或旧档物种 id、
    // 全局去重、数字 uid 必须存在于 petInsts（旧档物种字符串按 battle.js 双读兼容放行）
    if (data.activePets !== undefined) {
      if (!Array.isArray(data.activePets) || data.activePets.length > 5) {
        bad('出战灵宠表非法');
      } else {
        const instUids = new Set((Array.isArray(data.petInsts) ? data.petInsts : [])
          .map((p) => (p && typeof p === 'object') ? Math.floor(Number(p.uid) || 0) : 0));
        const seen = new Set();
        for (const uid of data.activePets) {
          if (typeof uid === 'string') {
            if (!PET_SP_MAP[uid]) { bad('出战灵宠物种非法'); break; }
          } else if (!isInt(uid, 1, 1e9)) {
            bad('出战灵宠 uid 非法'); break;
          } else if (!instUids.has(uid)) {
            bad('出战灵宠不存在于个体表'); break;
          }
          if (seen.has(uid)) { bad('出战灵宠重复'); break; }
          seen.add(uid);
        }
      }
    }
    if (data.petDex !== undefined) {
      if (!data.petDex || typeof data.petDex !== 'object' || Array.isArray(data.petDex) ||
        Object.keys(data.petDex).length > PET_SPECIES.length) {
        bad('灵宠图鉴非法');
      } else {
        for (const k of Object.keys(data.petDex)) {
          const d = data.petDex[k];
          if (!PET_SP_MAP[k] || !d || typeof d !== 'object' || Array.isArray(d) ||
            !isInt(d.met, 0, 1e9) || !isInt(d.got, 0, 1e9) || !isInt(d.bestR, -1, 5)) {
            bad('灵宠图鉴数据非法'); break;
          }
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
    // 装备定级水位（validateItem 等级-境界耦合用）：realm 单调不降，realmPeak 是飞升回锁
    // 的历史水位——两者取大即「该号掉落定级的合法上界」
    const maxRealm = Math.max(
      isInt(data.realm, 0, 9) ? data.realm : 0,
      isInt(data.realmPeak, 0, 9) ? data.realmPeak : 0);
    // 背包：数量与逐件口径
    if (data.bag !== undefined) {
      if (!Array.isArray(data.bag) || data.bag.length > DEEP.BAG_MAX) {
        bad('背包数量越界');
      } else {
        data.bag.forEach((it, i) => validateItem(it, '背包[' + i + ']', immortal, maxRealm));
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
          validateItem(it, '穿戴[' + slot + ']', immortal, maxRealm);
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
      // 单调性基线取「客户端已确认值」（cli_sync，2026-11-01 防砖修复）：combat/social
      // 服务端结算只加主计数列而不改存档体，客户端若没吸收（结算后刷新/多开/断线），
      // 对主列比单调性会判「回退」并把账号永久拒收（线上实测踩过：零增量回推都 400）。
      // cli_sync = 最近一次成功推送的计数快照，天然代表客户端自己的历史最高；NULL（旧行）
      // 回退主列保持旧口径。余额/收益包络同口径用 cli 基线（量的是客户端自身增速）。
      let cli = null;
      try { cli = prevRow.cli_sync ? JSON.parse(prevRow.cli_sync) : null; } catch (e) { cli = null; }
      if (!cli || typeof cli !== 'object') cli = {};
      const numOr = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);
      const prev = {
        stones: numOr(cli.stones, prevRow.stones),
        totalStones: numOr(cli.totalStones, prevRow.total_stones),
        dustTotal: numOr(cli.dustTotal, prevRow.dust_total),
        opens: numOr(cli.opens, prevRow.opens),
        exp: prevRow.exp,
        petTickets: numOr(cli.petTickets, prevRow.pet_tickets),
        ascensions: prevRow.ascensions,
        immortal: prevRow.immortal,
        power: prevRow.power,
        towerCleared: numOr(cli.towerCleared, prevRow.tower_cleared),
        stageCleared: numOr(cli.stageCleared, prevRow.stage_cleared),
        endlessBest: numOr(cli.endlessBest, prevRow.endless_best),
        wildMax: numOr(cli.wildMax, prevRow.wild_max),
        grants: prevRow.grants,
      };
      const fail = checkVelocity(prev, data, now - prevRow.updated_at,
        sanctionedSince(ctx.user.id, prevRow.updated_at), {
          // 窗口内「已入主列、尚未被 cli_sync 吸收」的服务端发放（2026-11-02 离线砖修复）：
          // combat/offline 等结算把灵石/开箱直接加进主列，客户端几秒后推档时 elapsed
          // 只有几秒，包络的离线额度套不住——主列只由服务端结算增加、推送成功即与
          // cli_sync 对齐，差额就是发放实额（负值由 checkVelocity 钳 0，防脏数据）
          stones: Math.floor(prevRow.total_stones) - prev.totalStones,
          opens: Math.floor(prevRow.opens) - prev.opens,
        });
      if (fail) {
        console.error('[saves] 增速校验拒收 user=' + ctx.user.id + '：' + fail);
        return sendJSON(res, 400, { error: '存档增速异常，已保留上次云端进度' });
      }
    } else if (ctx.user.createdAt && ctx.user.createdAt >= SEED_CHECK_SINCE) {
      // —— 新号首推种子校验（2026-11-01 三修：阈值时长感知）——
      // 账本上线（2026-10-31）后注册的账号，无账本行首推一律过种子校验（堵「等窗口
      // 过后零校验种满档」的洞）。但阈值不能按「全新号」拍死：上线初期注册的玩家
      // 已有两天正常进度（12 件强化装备 equipPower 轻松破 50 万、累计灵石破亿），
      // 固定阈值会把真玩家永久拒收（线上实测：登录即 400）。改为按账龄线性放宽，
      // 每存续一天放行「一天足量余量」的进度；仙位/轮回仍为 0（两天内不可能合法
      // 达成，硬指标保留）。作弊面评估：等 N 天再注入 = 基线仍被钳在
      // totalStones ≤ 5e7 + N×5e9、装备战力 ≤ 2e5×(1+N)——战力天花板被
      // 自报战力一致性校验（装备分×2500）与 immortal=0 双重锁死，远小于原洞。
      const ageDays = Math.max(0, (now - ctx.user.createdAt) / 86400000);
      const capTotalStones = 5e7 + ageDays * 5e9;
      const capOpens = 2e5 + ageDays * 2e5;
      const capDust = 2e6 + ageDays * 5e6;
      const capTickets = 1000 + ageDays * 500;
      const capEquipPower = 2e5 * (1 + ageDays);
      const seedFails = [];
      if (Number(data.totalStones) > capTotalStones) seedFails.push('累计灵石超新号上限');
      if (Number(data.opens) > capOpens) seedFails.push('开箱次数超新号上限');
      if (Number(data.dustTotal) > capDust) seedFails.push('累计碎屑超新号上限');
      if (Number(data.petTickets) > capTickets) seedFails.push('招募券超新号上限');
      if (Number(data.immortal) > 0 || Number(data.ascensions) > 0) seedFails.push('仙位/轮回超新号上限');
      if (equipPowerOf(data) > capEquipPower) seedFails.push('装备战力超新号上限');
      if (seedFails.length) {
        console.error('[saves] 新号种子校验拒收 user=' + ctx.user.id + '（账龄 ' +
          ageDays.toFixed(2) + ' 天）：' + seedFails[0]);
        return sendJSON(res, 400, { error: '新账号存档异常，请从零开始修行' });
      }
    }
    // —— 灵宠 uid 水位（2026-11-03 伪面收窄）：个体 uid 一律由服务端发放（pets.js
    // nextPetUid，捕捉/合成响应带真实 uid，客户端不再本地发号）。推送档里出现
    // uid > pet_seq 的个体 = 凭空捏造（改档免捕捉/合成直接拿满配宠），整档拒收。
    // pet_seq NULL（旧行未初始化）先从「旧镜像最大 uid」种入——语义同账本种基线，
    // 客户端发号时代的历史个体照常放行；镜像损坏时 fail-open 1e9（宁可放行也不砖号）。
    // 上界语义：未吸收窗口里客户端推旧镜像（少宠物）不会误拒，与 cli_sync 防砖同哲学
    if (Array.isArray(data.petInsts) && data.petInsts.length) {
      let wm = 0;
      if (prevRow) {
        wm = prevRow.pet_seq;
        if (wm === null || wm === undefined) {
          wm = 0;
          try {
            const old = JSON.parse(stmts.getSave.get(ctx.user.id).data);
            if (old && Array.isArray(old.petInsts)) {
              for (const p of old.petInsts) {
                const u = Math.floor(Number(p && p.uid) || 0);
                if (u > wm) wm = u;
              }
            }
          } catch (e) { wm = 1e9; }
          // 旧镜像可能早于灵宠个体化（无 petInsts 可种——品质校验 2026-11-02 上线起，
          // 迁移档从未成功落库，镜像停在纯物种时代）：老玩家的迁移赠品/客户端时代
          // 捕捉全是本地发号，序列埋在档内 petSeq（客户端保证 petSeq > 全部 uid，
          // 且与镜像发号同序）。pet_seq 为 NULL = 服务端从未给该账号发过号，以档内
          // petSeq 接续水位不扩大伪造面（新账号 pet_seq 非 NULL 不走此分支；个体表
          // 长度另有 validateDeep PET_INST_MAX 封顶）。缺此步会把全部老玩家在水位层
          // 二次拒死（2026-11-03 正式环境 user25 事故）
          if (wm !== 1e9 && isInt(data.petSeq, 1, 1e9) && data.petSeq > wm) wm = data.petSeq;
        }
      }
      const forged = data.petInsts.find((p) => p && Math.floor(Number(p.uid) || 0) > wm);
      if (forged) {
        console.error('[saves] 灵宠 uid 超发放水位拒收 user=' + ctx.user.id +
          '：uid=' + forged.uid + ' > pet_seq=' + wm);
        return sendJSON(res, 400, { error: '存档校验失败' });
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
        prevRow ? 0 : 1, led.clicks, clickBanUntil,
        // cli_sync：客户端已确认基线快照（单调性对比用，见上方 prev 构建处注释）
        JSON.stringify({
          stones: led.stones, totalStones: led.totalStones, dustTotal: led.dustTotal,
          opens: led.opens, petTickets: led.petTickets, towerCleared: led.towerCleared,
          stageCleared: led.stageCleared, endlessBest: led.endlessBest, wildMax: led.wildMax,
        }), now);   // 校验通过即清离线豁免；种基线发 1 次
      // 在线心跳：推送成功即证明玩家此刻在线，推进离线结算起点（见 stmts.setOfflineAt 注）
      stmts.setOfflineAt.run(now, ctx.user.id);
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

  // —— 客户端大额领奖授权（2026-11-01 收益包络防砖）——
  // 签到/赌狗/每日任务/求签/灵气等奖励在客户端入账且不走服务端结算，数额不在
  // action_log 授权流水里；刚重置/新建的账号「5e7×days」项≈0，一笔领奖就能击穿
  // 收益包络，推送被「灵石收益增速异常」拒收（线上实测：+1e6 vs 包络 4.7e5）。
  // /api/claim 在发放前记入 action_log（sanctionedSince 计入包络）并做当日次数锁；
  // 数额由客户端按增益链预估上报，服务端只钳「单笔上限 × 当日次数」，上限含增益余量。
  // 赌石暂未接入（概率玩法，P3 迁移时随上收一并处理；其头奖砖窗约 1~2 小时可自愈）。
  const CLAIM_RULES = {
    sign:           { cap: 1.5e8, perDay: 1 },  // 签到+赌狗（day7 1200万 × 赌狗×5 × 增益余量）
    sign_milestone: { cap: 2.5e10, perDay: 1 }, // 签到里程碑（day1000 = 100 亿）
    task_opens:     { cap: 7.5e6, perDay: 1 },
    task_wins:      { cap: 7.5e6, perDay: 1 },
    task_forge:     { cap: 7.5e6, perDay: 1 },
    task_all:       { cap: 1.5e7, perDay: 1 },  // 日常全勤
    fortune:        { cap: 7.5e6, perDay: 1 },  // 每日占卜领签
    vigor:          { cap: 5e6, perDay: 6 },    // 灵气格（每格 200 万 × 当日格数）
    lingchao:       { cap: 1e7, perDay: 2 },    // 灵潮符（400 万/符 × 每日两窗，含增益余量）
    wtask_opens:    { cap: 7.5e6, perWeek: 1 }, // 周常（300 万 × 增益余量）
    wtask_wins:     { cap: 7.5e6, perWeek: 1 },
    wtask_rogue:    { cap: 1.25e7, perWeek: 1 }, // 500 万
    wtask_all:      { cap: 5e6, perWeek: 1 },   // 周常全勤（200 万）
    bounty:         { cap: 3e7, perDay: 4 },    // 悬赏（紫单 1200 万 × 余量；每日四单）
    bounty_all:     { cap: 1.25e7, perDay: 1 }, // 悬赏四单全清（500 万 × 余量）
    quiz_per:       { cap: 1.5e6, perDay: 10 }, // 仙道问答（60 万/题 × 10 题）
    quiz_all:       { cap: 3.75e6, perDay: 1 }, // 问答全对（150 万）
    bossrush:       { cap: 5e7, perDay: 1 },    // 首领连战 S 级（2000 万 × 余量）
    anomaly:        { cap: 6e7, perDay: 2 },    // 异象平定（1500 万 × 血月 ×1.5 × 余量）
    aid_skill:      { cap: 7.5e6, perDay: 2 },  // 同门传功（300 万 × 余量）
    boss_daily:     { cap: 1e6, perDay: 1 },    // 妖王讨伐伤害奖励（40 万封顶 × 余量）
    gboss_daily:    { cap: 4e5, perDay: 1 },    // 盟妖王伤害奖励（16 万封顶 × 余量）
    // 战力动态上限类：数额随玩家战力成长（power = 账本装备分），dyn 系数按
    // 「客户端公式上界 × realPower ≤ 装备分×2500 × 2.5 余量」反推，见各领取点注释
    tribulation:    { cap: 1e6, perDay: 1, dyn: 6.5e4 },  // 天劫：realPower×10
    wander_gift:    { cap: 1e6, perDay: 5, dyn: 1.3e5 },  // 奇遇盘缠：realPower×20
    rogue_fight:    { cap: 1e6, perDay: 300, dyn: 4.2e2 }, // 探幽：装备分×2×(1+0.1层)×灵潮 ≈ ×168
    map_loot:       { cap: 1e6, perDay: 8, dyn: 3.5e2 },  // 秘境图收获：装备分×45×灵脉 ≈ ×135
  };
  // 领奖授权是全部领取共用的窗：探幽逐层/Rush 连打/天道录连档/灵气多格会在一分钟内
  // 连发十几笔，30/分钟会把额度吃光导致后续正常领取 429（2026-11-03 用户反馈）——
  // 放宽到 120/分钟（与体力接口同口径），滥用面由各类 perDay 上限 + 账本复核钳制
  const claimWindow = new SlidingWindow(60 * 1000, 120);
  const dayKey = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  // 周键与客户端 weekKey 同口径（game.js 周常以 ISO 周重置）
  const weekKey = () => {
    const d = new Date();
    return d.getFullYear() + '-W' + Math.floor((d - new Date(d.getFullYear(), 0, 1)) / (7 * 86400000));
  };

  // —— 天道录阶梯（game.js ACHV_LADDERS 同源）：tier=达成阈值，奖励=round(base×ratio^档位)。
  // gate 列非空的梯子用账本进度复核（阈值未达 → 409）；gate 为 null 的梯子进度计数在
  // 客户端（战斗统计/图鉴/玩法进度），服务端无法复核，靠「每档终身一次 + 奖励几何收敛于
  // 顶档」把伪造面压到一次性顶档值。奖励由服务端按表自算，客户端上报数额不采信。
  const TIDE_LADDERS = {
    open:     { tiers: [2e5, 5e5, 1e6, 5e6, 1e7, 5e7, 1e8, 5e8, 1e9, 5e9], base: 3e5, ratio: 3, gate: 'opens' },
    stone:    { tiers: [1e6, 1e7, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16], base: 3e5, ratio: 3, gate: 'total_stones' },
    dust:     { tiers: [5000, 2e4, 1e5, 5e5, 2e6, 1e7, 5e7], base: 2e5, ratio: 2.5, gate: 'dust_total' },
    realm:    { tiers: [1, 2, 4, 5, 6, 7, 8], base: 2e5, ratio: 3 },
    stage:    { tiers: [50, 80, 120, 160, 200], base: 5e5, ratio: 3, gate: 'stage_cleared' },
    tower:    { tiers: [90, 120, 150, 180, 200], base: 5e5, ratio: 3, gate: 'tower_cleared' },
    wild:     { tiers: [30, 60, 100, 150, 200], base: 4e5, ratio: 3, gate: 'wild_max' },
    endless:  { tiers: [30, 60, 100, 150, 200, 300, 500, 800, 1000, 2000], base: 2e5, ratio: 2.5, gate: 'endless_best' },
    rogue:    { tiers: [20, 40, 60, 80, 100, 130, 160, 200], base: 3e5, ratio: 3 },
    bestiary: { tiers: [5, 10, 20, 30, 50, 80, 120, 160, 200, 260, 320], base: 1e5, ratio: 2.2 },
    wins:     { tiers: [100, 500, 2000, 1e4, 5e4, 2e5, 1e6, 5e6, 1e7, 1e8], base: 2e5, ratio: 2.6 },
    dmg:      { tiers: [1e6, 1e8, 1e10, 1e12, 1e14, 1e16], base: 3e5, ratio: 2.8 },
    taken:    { tiers: [1e6, 1e8, 1e10, 1e12, 1e14, 1e16], base: 3e5, ratio: 2.8 },
    trial:    { tiers: [100, 300, 1000, 3000, 1e4, 3e4], base: 2e5, ratio: 2.5 },
    rush:     { tiers: [10, 30, 100, 300], base: 1e5, ratio: 3 },
    setall:   { tiers: [12, 18], base: 5e5, ratio: 2.5 },
    immortal: { tiers: [10, 25, 50, 100, 200, 400], base: 1e6, ratio: 2.5, gate: 'immortal' },
    ascend:   { tiers: [2, 5, 10, 25, 50, 100], base: 5e5, ratio: 2.5, gate: 'ascensions' },
    sign:     { tiers: [7, 30, 100, 365, 1000, 2000, 3650], base: 1e5, ratio: 2.5 },
    museum:   { tiers: [3, 6], base: 2e5, ratio: 2 },
    merit:    { tiers: [1e3, 1e4, 1e5, 1e6], base: 3e5, ratio: 3 },
    mark:     { tiers: [500, 5000, 5e4, 5e5], base: 3e5, ratio: 3 },
    bone:     { tiers: [500, 5000, 5e4, 5e5], base: 3e5, ratio: 3 },
    gongfa:   { tiers: [10, 15], base: 3e5, ratio: 2 },
    hunt:     { tiers: [1e3, 1e4, 1e5, 1e6], base: 2e5, ratio: 2.8 },
    elixir:   { tiers: [10, 50, 200], base: 1e5, ratio: 2.5 },
    chapter:  { tiers: [3, 6, 10], base: 2e5, ratio: 2.5 },
    ordeal:   { tiers: [1, 2, 3], base: 5e5, ratio: 2.5 },
    cave:     { tiers: [3, 6, 9, 12], base: 2e5, ratio: 2.5 },
    forge:    { tiers: [3, 6], base: 5e5, ratio: 2 },
    map:      { tiers: [10, 30, 64, 96], base: 1.5e5, ratio: 2.5 },
  };

  function claim(req, res, ctx) {
    if (!claimWindow.hit(ctx.user.id)) {
      return sendJSON(res, 429, { error: '领取过于频繁，请稍后再试' });
    }
    const kind = ctx.body && ctx.body.kind;
    const prevRow = stmts.getLedger.get(ctx.user.id);
    if (!prevRow) return sendJSON(res, 409, { error: '请先进入游戏后再领取' });
    let map = {};
    try { map = prevRow.claim_days ? JSON.parse(prevRow.claim_days) : {}; } catch (e) { map = {}; }
    if (!map || typeof map !== 'object' || Array.isArray(map)) map = {};

    // 两类领取：periodic（日/周锁次数）与 tide（天道录档位，终身一次 + 账本进度门槛）
    let amount = 0;
    let onceEver = null;
    if (kind === 'tide') {
      const ladder = ctx.body && ctx.body.ladder;
      const lad = TIDE_LADDERS[ladder];
      const tier = Math.round(Number(ctx.body && ctx.body.tier));
      if (!lad) return sendJSON(res, 400, { error: '未知天道录梯子' });
      const idx = lad.tiers.indexOf(tier);
      if (idx < 0) return sendJSON(res, 400, { error: '未知天道录档位' });
      if (lad.gate && !(Number(prevRow[lad.gate]) >= tier)) {
        return sendJSON(res, 409, { error: '天道录进度未达档位' });
      }
      onceEver = ladder + ':' + tier;
      const claimed = Array.isArray(map.tide) ? map.tide : [];
      if (claimed.includes(onceEver)) return sendJSON(res, 429, { error: '该档位已领取' });
      amount = Math.round(lad.base * Math.pow(lad.ratio, idx));
    } else {
      const rule = CLAIM_RULES[kind];
      if (!rule) return sendJSON(res, 400, { error: '未知领奖类型' });
      amount = Math.round(Number(ctx.body && ctx.body.amount));
      // 战力动态上限：cap = cap + dyn×装备分（账本 power 列，覆盖成长期大额领取）
      const cap = rule.cap + (rule.dyn ? rule.dyn * Number(prevRow.power || 0) : 0);
      if (!Number.isInteger(amount) || amount <= 0 || amount > cap) {
        return sendJSON(res, 400, { error: '领奖数额越界（上限 ' + Math.round(cap) + '）' });
      }
      const periodKey = rule.perWeek ? weekKey() : dayKey();
      const perMax = rule.perWeek || rule.perDay;
      const cur = Array.isArray(map[kind]) ? map[kind] : [];
      const next = cur[0] === periodKey ? [periodKey, (cur[1] | 0) + 1] : [periodKey, 1];
      if (next[1] > perMax) {
        return sendJSON(res, 429, { error: rule.perWeek ? '该奖励本周已领取' : '该奖励今日已领取' });
      }
      map[kind] = next;
    }

    const nextJson = JSON.stringify((() => {
      if (!onceEver) return map;
      const claimed = Array.isArray(map.tide) ? map.tide.slice() : [];
      claimed.push(onceEver);
      return Object.assign({}, map, { tide: claimed });
    })());
    db.exec('BEGIN');
    try {
      // 乐观锁：双标签页并发领取只有一个能改写 claim_days 成功
      const cas = stmts.setClaimDays.run(nextJson, ctx.user.id, prevRow.claim_days ?? null);
      if (cas.changes === 0) throw new Error('claim-cas');
      stmts.logClaim.run(ctx.user.id, dayKey(), 'claim:' + kind, amount, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      if (e.message === 'claim-cas') return sendJSON(res, 409, { error: '领取冲突，请重试' });
      throw e;
    }
    return sendJSON(res, 200, { ok: true, stones: amount });
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
        stmts.delShop.run(ctx.user.id);
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

  return { get, store, reset, claim };
}
