// 存档增速模型（2026-10-31）：对上传存档的累计计数器做单调性 + 增速校验。
// 设计前提：游戏是客户端权威——绕过前台按钮/改内存刷来的任何收益，最终都必须
// 落进存档计数器（totalStones / dustTotal / opens / ascensions / immortal …）；
// 服务端按「上次入库存档快照 + 经过时长」对计数器做增速包络，超包络整档拒收。
// 口径与 game.js 同源（括号标注上游位置），全部取「最坏情况 × 余量」的宽松包络，
// 宁可放过小作弊也不误伤真玩家；硬保证是单调性、开箱速率与仙位/轮回限速。
// 上游数值若改动，本文件的包络口径需同步复核。

// —— 开箱：interval() 下限 2026-11-01 起为 0.2s（2.5s×0.95^50，game.js interval()）→
// 5 次/秒实际封顶；OPEN_RATE_PER_S 保留 20 作包络上界（客户端变慢只松不紧，
// 服务端校验无需收紧，避免未来回调节奏时误拒真玩家） ——
const OPEN_RATE_PER_S = 20;
// —— 战斗：自动战斗 2026-11-01 起每场间隔 1 分钟 + 体力一场 1 点（每日 300）双闸，
// 实际远低于本包络；OPEN/BATTLE 速率只松不紧，保留历史宽松值防未来回调节奏误拒真玩家 ——
const BATTLE_RATE_PER_S = 3;
// —— 离线结算（game.js:14-15 awardOffline）：4 小时 × 50% 效率 ——
// 离线收益相对「服务端账本时长」是凭空跳变（离线发生在上次入库之前）。常规窗口的离线
// 额度按 elapsed 折算（elapsed × 12 ≈ 包络 20 次/秒 × 效率 0.5 × 1.2 余量；实际客户端 5 次/秒，包络只松不紧）；整份 4h 额度
// （OFFLINE_OPENS）只作为 grants 豁免发给种基线后的第一次校验推，防调钟每窗重刷。
const OFFLINE_OPENS = Math.floor(4 * 3600 * OPEN_RATE_PER_S * 0.5);      // ≤ 144000 次

// 图鉴实际收益加成（game.js collectionBonus）：每套 ≥2 件 +10%、≥6 件再 +25%，三套封顶 1.05
function collectionGainOf(d) {
  const c = d && d.setCollection && typeof d.setCollection === 'object' && !Array.isArray(d.setCollection)
    ? d.setCollection : {};
  let g = 0;
  for (const k of Object.keys(c)) {
    const n = Array.isArray(c[k]) ? c[k].length : 0;
    if (n >= 2) g += 0.10;
    if (n >= 6) g += 0.25;
  }
  return Math.min(g, 1.05);
}

// 灵宠收益加成（petBonus('gain') 最坏口径）：满级宠 0.03×200 封顶 7 + 信物 0.005×200 封顶 1。
// 服务端不持有 PETS 表（哪些宠吃收益加成），把全部宠物按收益口径计并封顶 7——只松不紧。
function petGainOf(d) {
  const pets = d && d.pets && typeof d.pets === 'object' && !Array.isArray(d.pets) ? d.pets : {};
  const tokens = d && d.petTokens && typeof d.petTokens === 'object' && !Array.isArray(d.petTokens)
    ? d.petTokens : {};
  let sum = 0;
  let tok = 0;
  for (const k of Object.keys(pets)) sum += 0.03 * clampInt(pets[k], 0, 200);
  for (const k of Object.keys(tokens)) tok += clampInt(tokens[k], 0, 200);
  return Math.min(7, sum) + Math.min(1, 0.005 * Math.min(tok, 200));
}

// 单次开箱灵石收益上界。用存档自身字段推：
//   baseGain（game.js:2270）= (3+0.9×gainLv) × 1.7^realm × (1+0.25×asc) × powerMult
//     × (1+图鉴+灵宠+聚灵阵) × (1+0.5×immortal) × 称号/陈列/时辰/天象/仙盟/丹药…
// critFactor/miscFactor 两种口径：
//   在线窗口逐次最坏（10 / 250）：短窗口可能全程暴击 + 全增益叠加；
//   离线期望结算（5.5 / 6）：awardOffline 按 n×e.stone 期望入账（crit 期望 1+0.5×9=5.5），
//   逐次最坏 × 离线 opens 会把底线包络放大到百亿级，必须分开。
function perOpenCap(d, powerEq, critFactor, miscFactor) {
  const gainLv = clampInt(d.gainLv, 0, 60);          // UPGRADES.gain.max（game.js:1059）
  const realm = clampInt(d.realm, 0, 9);
  const asc = Math.max(0, Math.floor(Number(d.ascensions) || 0));
  const immortal = clampInt(d.immortal, 0, 999);
  const array = clampInt(d.cave && d.cave.array, 0, 200);
  const small = 1 + collectionGainOf(d) + petGainOf(d) + 0.08 * array;
  return (3 + 0.9 * gainLv)
    * Math.pow(1.7, realm)
    * (1 + 0.05 * asc)      // prestigeMult（2026-11-01 改 +5%/次，原 +25% 未同步至此）
    * (1 + 0.1 * immortal)  // 仙位收益（2026-11-01 改 +10%/位，原 +50% 未同步至此）
    * (1 + Math.sqrt(Math.max(1, powerEq)) / 20)   // powerMult（game.js:2209）
    * small
    * critFactor
    * miscFactor;
}
const PER_OPEN_WORST_CRIT = 10;      // CRIT_MULT 最坏（game.js:17，逐次全暴击）
const PER_OPEN_WORST_MISC = 250;     // 称号×1.02 · 陈列×1.12 · 时辰/天象/灵潮×~16 · 仙盟×1.05（2026-11-01 每级 0.5%） · 丹药×1.3×2 等杂乘区兜底
const PER_OPEN_EXPECTED_CRIT = 5.5;  // 离线期望：1 + 暴击率上限0.5×(10-1)
const PER_OPEN_EXPECTED_MISC = 6;    // 离线期望：增益类平均叠加远达不到逐次最坏
function perOpenGainCap(d, powerEq) {
  return perOpenCap(d, powerEq, PER_OPEN_WORST_CRIT, PER_OPEN_WORST_MISC);
}
function perOpenExpectedCap(d, powerEq) {
  return perOpenCap(d, powerEq, PER_OPEN_EXPECTED_CRIT, PER_OPEN_EXPECTED_MISC);
}

// 单场战斗灵石收益上界（game.js:3689）：contentReq(mode, level) × stone × 首通/复战
// × 周末 × 灵潮。能打赢的关卡其敌人数值 ≈ 玩家战力量级，故包络直接挂装备战力
//（由穿戴六件重算，逐件已被深度校验钳制），不再解析各模式难度表。
function perBattleGainCap(immortal, powerEq) {
  const stone = 7;            // MODES 各模式 stone 最大值
  const first = 1.5, weekend = 2, boss = 1.8;
  const dayProd = 4;          // 灵潮 ×2 × 占卜 ×2 兜底
  const misc = 12;            // 时辰/天象等余量
  return stone * first * weekend * boss * dayProd * misc
    * Math.pow(1.05, immortal)  // immortalMult（2026-11-01 改 ×1.05/位，原 1.25 未同步至此）
    * Math.max(1, powerEq);
}

// 套装保底常量（与 battle.js/game.js 同源；economy 保持零依赖不引 battle.js）
const WILD_SET_PITY = 50;      // 每胜 N 场保底 1 件
const WILD_SET_PITY_DAILY = 2; // 每玩法每日保底上限

/**
 * 套装保底状态机（2026-11-01 二改，combat.js rollSpecialDrop 的纯函数内核）：
 * 四模式统一每胜 WILD_SET_PITY(50) 场保底 1 件（滚动计数，pityMap 由调用方持久化），
 * 每日每玩法保底最多 WILD_SET_PITY_DAILY(2) 件（当日配额用尽则计数挂起不清零，
 * 跨日自动重置配额）；随机掉落由调用方另行 roll，不受保底配额限制。
 * @param pityMap 保底计数表 {mode:[胜场,日,当日已保底数]}（就地更新并返回）
 * @param win 本场是否胜利（败场只做跨日配额重置，不计数）
 * @param dropOne(mode) 服务端发件回调（返回套装件对象）
 * @returns {{pityItems:array, pityMap:object}} 本场保底掉落（0/1 件）
 */
export function rollSetPity(pityMap, mode, win, today, dropOne) {
  const pityItems = [];
  const st = Array.isArray(pityMap[mode]) ? pityMap[mode] : [0, '', 0];
  let wins = st[0] | 0;
  let day = String(st[1] || '');
  let pityN = st[2] | 0;
  if (day !== today) { day = today; pityN = 0; } // 跨日：保底配额重置
  if (win) {
    wins++;
    if (wins >= WILD_SET_PITY) {
      if (pityN < WILD_SET_PITY_DAILY) {
        pityItems.push(dropOne(mode));
        wins -= WILD_SET_PITY;
        pityN++;
      }
      // 当日配额用尽：计数挂起不清零，次日配额恢复后下一胜即掉
    }
  }
  pityMap[mode] = [wins, day, pityN];
  return { pityItems, pityMap };
}

// 穿戴十二件重算战力（itemPower×部位强化乘区，game.js totalPower 同源）：
// 装备自身 power×(1+0.1star)，再乘部位强化 (1+0.18×enh[槽])——2026-10-31 部位化，
// 强化等级从装备 lv 移到 state.enh[槽]（0..200，深度校验已钳），旧档无 enh 按 0 计。
// 2026-11-01 槽位扩容：加入手镯/戒指/护腕/护腿/发箍/翅膀，与客户端 SLOTS 同步。
export function equipPowerOf(data) {
  const eq = data && data.equipped && typeof data.equipped === 'object' ? data.equipped : {};
  const enh = data && data.enh && typeof data.enh === 'object' && !Array.isArray(data.enh) ? data.enh : {};
  let p = 0;
  for (const k of ['weapon', 'armor', 'helm', 'boots', 'artifact', 'talisman',
    'bracelet', 'ring', 'wrist', 'legs', 'band', 'wings']) {
    const it = eq[k];
    if (!it || typeof it !== 'object') continue;
    const pw = Number(it.power);
    if (!Number.isFinite(pw) || pw <= 0) continue;
    const lv = Number(enh[k]);
    const enhMult = 1 + 0.18 * (Number.isFinite(lv) ? Math.max(0, Math.min(200, lv)) : 0);
    p += pw * (1 + 0.1 * (Number(it.star) || 0)) * enhMult;
  }
  return Math.floor(Math.max(0, p));
}

// 野外已探最深区（wildCleared 只增不减，取最大值做单调观测；game.js:2691 wildMaxUnlocked）
// 元素钳到 0..200（与 saves.js validateDeep 的 wildCleared 校验同口径）：不钳的话
// 一份 [1e300] 的档会把 wild_max 基线种到天文数字，此后真实进度全被「回退」误拒。
function wildMaxOf(data) {
  const arr = data && Array.isArray(data.wildCleared) ? data.wildCleared : [];
  let m = 0;
  for (const v of arr) {
    const n = Math.floor(Number(v));
    if (Number.isFinite(n) && n > m) m = Math.min(n, 200);
  }
  return m;
}

const clampInt = (v, lo, hi) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};
const daysOf = (ms) => Math.max(ms, 60000) / 86400000; // 时长至少按 1 分钟计，防 0 除与瞬时窗口过紧

/**
 * 增速校验：返回 null = 通过；字符串 = 违规原因（直接作为 400 拒收依据写日志）。
 * @param prev  上次账本快照 {stones,totalStones,dustTotal,opens,exp,petTickets,ascensions,immortal,power,towerCleared,stageCleared,endlessBest,wildMax,grants}
 * @param next  本次上传的存档 JSON（已过 validateSave/validateDeep）
 * @param elapsedMs 距上次成功入库的毫秒数（服务端时钟，含离线时长）
 * @param sanctioned 窗口内服务端授权收益 {stones,dust,tickets}（兑换码等，精确计入）
 * @param srv 窗口内「已入主列、尚未被 cli_sync 吸收」的服务端发放 {stones,opens}
 *   （2026-11-02 离线砖修复：combat/offline 把离线开箱/灵石直接加进账本主列，而客户端
 *   启动后几秒内就推档——elapsed 只有几秒，离线开箱额度（elapsed×12/grant）全都套不住，
 *   +10390 开箱被「增速异常」连续拒收 ~9 分钟，期间刷新还会把离线灵石从本地状态冲掉。
 *   主列只由服务端结算增加、推送成功即被 cli_sync 对齐，所以「主列 − cli 基线」就是
 *   未吸收的服务端发放额，计入包络；方向安全，客户端无法伪造）
 */
export function checkVelocity(prev, next, elapsedMs, sanctioned, srv) {
  const elapsedS = Math.max(0, elapsedMs) / 1000;
  const days = daysOf(elapsedMs);
  const s = sanctioned || { stones: 0, dust: 0, tickets: 0 };
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const sv = srv && typeof srv === 'object' ? srv : {};
  const srvStones = Math.max(0, num(sv.stones));
  const srvOpens = Math.max(0, num(sv.opens));
  // 离线补结豁免：只有种基线/迁移后的第一次校验推带整份 4h 离线额度（grants=1，用后即清）。
  // 其余窗口离线额度一律按服务端 elapsed 折算——客户端调钟伪造「离线 4h」时服务端
  // elapsed 只有几秒，额度自动收缩，调钟刷离线路线被堵死（2026-10-31 复审）。
  const grant = prev.grants > 0 ? OFFLINE_OPENS : 0;

  // —— 1) 单调性：累计/进度型计数器不得回退（防「洗基线」后重新注入）——
  // exp 除外：突破/飞升会消耗；stones 除外：花费与赌狗签到负债都合法向下。
  const mono = [
    ['累计灵石', num(next.totalStones), prev.totalStones],
    ['累计碎屑', num(next.dustTotal), prev.dustTotal],
    ['开箱次数', num(next.opens), prev.opens],
    ['轮回次数', num(next.ascensions), prev.ascensions],
    ['仙位', num(next.immortal), prev.immortal],
    ['爬塔进度', num(next.towerCleared), prev.towerCleared],
    ['闯关进度', num(next.stageCleared), prev.stageCleared],
    ['无尽进度', num(next.endlessBest), prev.endlessBest],
    ['野外探区', wildMaxOf(next), prev.wildMax],
  ];
  for (const [name, cur, old] of mono) {
    if (cur < old) return name + '出现回退（账内 ' + old + ' / 推送 ' + cur + '）';
  }

  const dOpens = num(next.opens) - prev.opens;
  const dTotal = num(next.totalStones) - prev.totalStones;
  const dDust = num(next.dustTotal) - prev.dustTotal;
  const dTickets = num(next.petTickets) - prev.petTickets;
  const asc = Math.max(0, num(next.ascensions));
  const immortal = Math.max(0, num(next.immortal));
  // 收益包络的「能力」字段取两档较大值：玩家中途换装/突破会使当档能力低于期间实际值。
  // 战斗包络基数另加封顶（账本战力 ×10 + 5e9）：防止一次推送用「合法顶配装备」把
  // 包络基数从零直接顶到 3e11（装备获取本身服务端不追踪，靠此帽兜住）
  const equipP = equipPowerOf(next);
  const powerEq = Math.max(prev.power, equipP);
  const battlePower = Math.min(powerEq, prev.power * 10 + 5e9);
  const ascCap = Math.max(prev.ascensions, asc);
  const immCap = Math.max(prev.immortal, immortal);

  // —— 1.5) 自报战力一致性：persist 上报的 power（realPower = 装备分 × 实战乘区）
  // 必须与穿戴六件重算分挂钩，防「空装备直写 9e15 战力」刷榜单/PvP 快照/妖王钳制基数。
  // 真实乘区上界（境界/词条/宝石/灵宠/功法/内丹等全开）约 ×1400，取 2500 余量；
  // 2026-11-02 灵宠个体化放宽到 3400：出战灵宠新增个体词条（2 只 × 仙品 3 条满卷
  // × lv100 成长，atk 聚合再 +~0.32 → 攻击乘区最多再 ×1.35，照旧只松不紧）；
  // 空装起步由 5000 底兜住（realPower 乘法结构下空装 = 0，不会误拒）。
  if (next.power !== undefined && num(next.power) > Math.max(5000, equipP * 3400 * (1 + 0.08 * ascCap))) {
    return '自报战力与装备不符（' + num(next.power).toExponential(2) + ' / 装备 ' + equipP.toExponential(2) + '）';
  }

  // —— 2) 开箱增速：interval 下限 2026-11-01 起 0.2s（实际 5 次/秒），包络沿用 20 次/秒上界，×1.2 余量容忍节流合批；
  // 离线部分只给豁免额度（见 grant），服务端离线结算的未吸收发放按实额计入（srvOpens）——
  if (dOpens > elapsedS * OPEN_RATE_PER_S * 1.2 + grant + 2000 + srvOpens) {
    return '开箱次数增速异常（+' + dOpens + ' / ' + Math.round(elapsedS) + 's）';
  }

  // —— 3) 灵石收益包络：在线开箱（逐次最坏）+ 离线补结（期望口径，额度=elapsed×12，
  // 即 20 次/秒 × 离线效率 0.5 × 1.2 余量）+ 战斗 + 按天杂项 + 兑换码 + 服务端发放 ——
  // srvStones 与 action_log 授权流水（s.stones）内容重叠（combat/offline 两处都记），
  // 重复计入只松不紧且都是服务端实额；留着防边界（如同毫秒 created_at 不满足
  // sanctionedSince 的 created_at > updated_at 严格比较时授权流水漏计）
  const battlesAllow = elapsedS * BATTLE_RATE_PER_S + 200;
  const onlineOpens = Math.min(Math.max(0, dOpens), elapsedS * OPEN_RATE_PER_S * 1.2 + 2000);
  const offlineOpens = Math.min(
    Math.max(0, dOpens - onlineOpens),
    elapsedS * 12 + grant,
  );
  const incomeAllow = perOpenGainCap(next, battlePower) * onlineOpens
    + perOpenExpectedCap(next, battlePower) * offlineOpens
    + perBattleGainCap(immCap, battlePower) * battlesAllow
    + 5e7 * days
    + Math.max(0, s.stones)
    + srvStones;
  if (dTotal > incomeAllow * 1.5) {
    return '灵石收益增速异常（+' + dTotal.toExponential(2) + '，包络 ' + incomeAllow.toExponential(2) + '）';
  }

  // —— 4) 余额跳变：当前灵石最多花光 + 新收益 + 杂项；向下（花费/负债）不受限 ——
  // 防「stones 直接顶到 totalStones」这类只改余额不改累计的注入。
  // 2e6 绝对底：兼容旧版客户端把盟任务/商店/妖王奖励只加 stones 不加 totalStones 的口径
  const dStones = num(next.stones) - prev.stones;
  if (dStones > dTotal + 2e6 + 5e7 * days + Math.max(0, s.stones)) {
    return '灵石余额跳变异常（+' + dStones.toExponential(2) + '，同期收益 ' + dTotal.toExponential(2) + '）';
  }

  // —— 5) 放大字段限速：仙位/轮回直接放宽战力天花板（量级校验对它们放行），
  // 增速与「可支配灵石」挂钩且不做与灵石无关的每推保底（复审：3 分钟 curl 可拉满）。
  // 飞升门槛递增式（2026-11-04 用户指定，game.js ascendStonesOf 同源）：
  // 第 n 次飞升门槛 = 1e11×n；窗口内从 prev+1 飞到 asc 的累计门槛 = 1e11×Σ(k, prev+1..asc)
  // = 1e11×(asc(asc+1)−prev(prev+1))/2。校验 pot ≥ 累计门槛×0.5（余量只防推送滞后误拒：
  // 合法飞升瞬间 pot ≥ 当次门槛 ≥ need×1，0.5 不会放水到「攒一半门槛就飞」以下）。
  // 入仙界逐级 ×5 灵石（累计 (5^k-1)/4×1e8 ≤ pot ⟺ k ≤ log5(4·pot/1e8+1)），无保底。
  const pot = Math.max(0, prev.stones) + Math.max(0, dTotal) + 5e7 * days + Math.max(0, s.stones);
  const ascNeed = ((asc * (asc + 1)) - (prev.ascensions * (prev.ascensions + 1))) / 2;
  if (asc > prev.ascensions && pot < ascNeed * 0.5e11) {
    return '轮回次数增速异常（累计门槛 ' + Math.round(ascNeed * 1e11).toExponential(2) +
      '，可支配 ' + pot.toExponential(2) + '）';
  }
  const immAllow = Math.floor(Math.log(4 * pot / 1e8 + 1) / Math.log(5));
  if (immortal - prev.immortal > immAllow) {
    return '仙位增速异常（+' + (immortal - prev.immortal) + '，配额 ' + immAllow + '）';
  }

  // —— 6) 碎屑 / 招募券 / 修为增速（价值低，宽松包络兜底）——
  // 碎屑/招募券是随机掉落 + 一次性奖励（妖王/商店/成就），短窗口小样本下期望口径趋近 0，
  // 必须给绝对下限（券 3 张 / 尘 200 万每窗口），否则「刚开 1 箱掉 1 券」都会被拒（实测踩过）。
  // 2026-11-04 线上砖修复：生产环境跑过「碎屑 ×100」的中间版本（已回滚），存量档 dustTotal
  // 里躺着 ×100 口径的合法积累，收紧回原值后旧档推送被「碎屑收益增速异常」永久拒收
  // （cli_sync 只在成功推送时前进，pending 增量永不吸收）——尘窗口四项系数维持放大档
  // （250000 尘/开箱、2e8×天、绝对底 2e8、灵石消耗折算 ×15）消化存量；碎屑是最低价值
  // 货币、贴包络的小幅作弊本就不承诺拦截，防砖优先。
  // 璞玉赌石：20 万灵石/次纯客户端消耗，包络按「窗口内客户端灵石消耗 ×15」计入。
  const spentStones = Math.max(0, -dStones);
  if (dDust > Math.max(0, dOpens) * 250000 + 2e8 * days + 2e8 + spentStones * 15 + Math.max(0, s.dust)) {
    return '碎屑收益增速异常（+' + dDust.toExponential(2) + '）';
  }
  if (dTickets > Math.max(0, dOpens) * 0.01 + 50 * days + 3 + Math.max(0, s.tickets)) {
    return '招募券增速异常（+' + dTickets + '）';
  }
  const dExp = num(next.exp) - prev.exp;
  if (dExp > Math.max(0, dOpens) * 1e5 * (1 + 0.5 * ascCap)
    + battlesAllow * 300 * Math.pow(1.25, immCap) * Math.max(1, battlePower) * (1 + 0.5 * ascCap)
    + 1e8 * days) {
    return '修为增速异常（+' + dExp.toExponential(2) + '）';
  }

  return null;
}

/** 由存档 JSON 提取账本快照（首次入库种基线 / 校验通过后更新账本共用） */
export function ledgerOf(data, now) {
  return {
    stones: Math.floor(Math.max(-1e12, Math.min(1e18, Number(data.stones) || 0))),
    totalStones: Math.floor(Math.max(0, Math.min(1e18, Number(data.totalStones) || 0))),
    dustTotal: Math.floor(Math.max(0, Math.min(1e15, Number(data.dustTotal) || 0))),
    opens: Math.floor(Math.max(0, Math.min(1e15, Number(data.opens) || 0))),
    exp: Math.max(0, Math.min(1e15, Number(data.exp) || 0)),
    petTickets: Math.floor(Math.max(0, Math.min(1e9, Number(data.petTickets) || 0))),
    ascensions: clampInt(data.ascensions, 0, 1e6),
    immortal: clampInt(data.immortal, 0, 999),
    power: equipPowerOf(data),
    towerCleared: clampInt(data.towerCleared, 0, 200),
    stageCleared: clampInt(data.stageCleared, 0, 200),
    // 无尽进度上界 2000 = 天道录 endless 梯最高档（saves.js TIDE，2026-11-09 复审：
    // 原钳 200 比奖励梯低一个数量级，进度过 200 的档 endless_best 基线被压回 200）
    endlessBest: clampInt(data.endlessBest, 0, 2000),
    wildMax: wildMaxOf(data),
    clicks: clampInt(data.clickCount, 0, 1e12),
    updatedAt: now,
  };
}
