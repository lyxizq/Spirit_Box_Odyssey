# HANDOFF · 交接与路线图

> 面向下一个开发工具 / 下一位开发的交接文档。读完本文应能继续开发而不需要重新通读全部代码。
> 最后更新：2026-10-28（第四批「融合/符文/心魔/悬赏/时辰/天劫/道侣/战功碑」完成时点）。

---

## 1. 项目概览

- **名称**：灵匣纪元 · Spirit Box Odyssey（早期叫「灵匣挂机 · 开箱修仙」，README 与标题已改名）
- **形态**：纯静态前端放置游戏。无后端、无数据库、无第三方素材，全部原创文案。
- **文件**（项目根目录 `默认项目/`）：
  | 文件 | 内容 |
  |---|---|
  | `index.html` | 全部 DOM：主面板、背包、图鉴、秘境面板、战斗弹窗、离线弹窗 |
  | `styles.css` | 样式 + 战斗动画 + 响应式（约 1690 行） |
  | `game.js` | 全部玩法逻辑与数值（约 2000 行，单个 IIFE，`'use strict'`） |
  | `README.md` | 面向玩家的说明（运行、玩法、部署） |
  | `docs/HANDOFF.md` | 本文档（`docs/` 另含 DEPLOY.md 部署手册） |
- **运行**：`python3 -m http.server 8099` 后打开 `http://127.0.0.1:8099/`。测试通常用 8099 端口。
- **存档防清除备份**（2026-10-28）：`persist()` 成功后把存档串镜像写入 **OPFS**（`navigator.storage.getDirectory()`；门户 `clearEnvironment()` 只清 localStorage/sessionStorage/IDB 数据库，OPFS 幸存）；启动时 `recoverSaveIfNeeded()`：主键缺失或 OPFS 的 lastSeen 更新则采纳备份（含自动离线结算）。`bootSettled` 门闩防止启动恢复完成前备份被空档覆盖。**门户侧 bug 已定位且游戏侧已免疫（线上实测）**：web.xawan.top 门户 `clearEnvironment()`（登录/登出/切换游戏时调用）`localStorage.clear()` + 删全部 IDB，游戏存档被抹——原样复现该清理后，OPFS 备份幸存、重开游戏自愈恢复成功，**游戏无需门户任何改动即兼容**；门户白名单补 `lingxia_idle_v1`/`lingxia_idle_v1_tab` 属可选优化。
- **存档导出 / 导入**（2026-10-30 加密改版）：页脚按钮。导出 = `SAVE_KEY` 原文经 **AES-256-GCM 加密**（PBKDF2 310k 派生，内嵌 pepper XOR 落码 + 每次导出随机盐/IV）下载为 `lingxia_save_日期.lxsave`（`LXS1.<base64(salt|iv|ct)>` 纯文本）；导入 = 文件选择器 → 先解密（失败提示「文件已损坏或被修改」，明文 JSON 旧档拒收）→ JSON.parse + 基础校验 → confirm（明示覆盖本地与云存档）→ `setItem` + `opfsWrite` → reload。安全边界：pepper 随 JS 下发，防记事本改档、伪档需逆向抠钥匙；真正防伪造需服务端签字（备选）。IAB 自动化测试注意：成功分支会立即 reload，验证须在 dispatch 后 ~10ms 内读 localStorage。
- **main 布局**（2026-10-28 二改）：顶部 `.top-tabs` 吸顶标签（修炼/征战/闲趣）切三个 `.tab-page`，每个 tab 内是 `1fr 1fr` 网格 + `.col` 子列，`.panel-wide` 通栏。分组：修炼=开匣/淬炼/道童/境界；征战=秘境征战/试炼/装备/秘境图/背包/日志；闲趣=洞府/日常/图鉴/灵宠/黑市/成就。切换函数 `setTopTab(name)`。**新增面板写进对应 tab 的某个 .col**（或加 panel-wide 通栏）；切换只用 display 切换，渲染不受隐藏影响。
- **没有 git 仓库**，所有改动都是直接编辑文件。
- **存档 key**：`lingxia_idle_v1`（浏览器 localStorage）。**不要改成别的 key**，现有玩家档都在上面。

## 2. 当前实现状态（截至本文）

全部已完成并经浏览器实测（无 console 报错）：

**开箱侧**：自动/手动/连开十次开箱，6 品质（凡/灵/玄/地/天/仙），6 部位（武器/衣袍/冠冕/云靴/法宝/灵符），60 格背包，战力加成灵石收益，强化 +20，三条升级线（开箱速度/灵石收益/气运），10 境界突破，飞升（仙缘），开箱暴击 5%×10，聚气丹 30 秒双倍，离线收益（4 小时上限、50% 效率、只结算灵石修为），图鉴与最高品质记录，localStorage 自动存档 + 手动重置 + 音效开关，响应式布局。

**秘境征战**（本项目最近完成的大系统）：

- 闯关 30 关（默认开放）、爬塔 60 层（通关闯关第 5 关解锁）、野外 12 区（通关闯关第 3 关解锁）。
- 逐层指数递增难度；塔每 10 层、关每 5 关、野外每 4 区 + 第 12 区出首领。
- 战利品体系：塔印 / 战功 / 兽骨 → 战技（战意+攻、体魄+血、破甲+无视防御）。
- 专属 6 件套：镇塔（爬塔）/ 征伐（闯关）/ 荒狩（野外），只能从秘境掉落，开匣不出。
- 逐回合模拟战斗：暴击、吸血、减伤、破甲，120 回合上限。
- 战斗弹窗：血条、突进/受击动画、伤害飘字、逐回合日志、跳过、回看、遮罩关闭。
- 野外自动巡猎：每 3 秒结算一场、不弹窗；手动挑战即停巡猎。
- 各玩法独立保留最近一场战报（内存，刷新清空）。

**装备词条 · 洗练 · 宝石**（2026-10-27 完成）：

- 地 / 天 / 仙品装备分别带 1 / 2 / 3 条随机词条，词条池：攻击 / 生命 / 防御 / 暴击 / 吸血 / 破甲（同件不重复）。
- 「工坊」只对**已穿戴**装备开放（与强化同口径）：灵石洗练（可锁 1 条，费用 ×1.3/次）、碎屑合成宝石即镶即用。
- 宝石三档（下 / 中 / 上品），六种类型同词条池；仙品 2 孔、其余 1 孔（按品质推导，不存档）；卸下返还一半碎屑。
- 分解装备得碎屑（`dust`）：普通件按品质 0/1/2/4/8/16，专属件按战力折算（约 20 + 战力×12%）。
- 词条与宝石属性在 `playerCombatStats` 并算：atk/hp/def 为百分比乘区，crit/ls/pierce 直加后走既有上限（0.6/0.5/0.6）。**不计入战力**（`itemScore` 也不吃词条）。

**QoL 插队包**（2026-10-27 完成）：

- 背包排序（战力 / 品质 / 部位）与部位筛选（内存态 `bagSort` / `bagFilter`，不入档）；条目带与已穿戴同部位的战力对比箭头 ▲ / ▼ / ＝（`itemPower` 口径）。
- 「扫荡 ×10」：`doBattle(mode, {auto, sweep})` 免弹窗连打 10 场、遇败即停；sweep 跳过 450ms 冷却、抑制逐场日志与音效、返回战报记录。
- 「连续挑战」：原「自动巡猎」（按钮改 id `autoBtn`）推广到三处秘境，主循环每 3 秒 auto 结算当前页签，战败自动关。
- 战斗倍速 `battleSpeed ∈ {1,2,4}`（存档），乘在弹窗动画的 delay 上；倍速按钮标签在启动与开战时同步。

**收集留存包**（2026-10-27 完成，TODO 1–5）：

- 成就：`ACHIEVEMENTS` 20 条里程碑（开箱 / 灵石 / 品质 / 境界 / 秘境 / 套装图鉴 / 强化 / 飞升 / 无尽），达成后手动领灵石（部分带碎屑），`state.achievements` 记已领。
- 日常：`ensureDaily()` 按本地自然日重置 `state.daily`（opens/wins/forge 计数 + claimed）；签到 `SIGN_REWARDS` 7 日循环（`signInDays % 7`），三项任务全领另有 `DAILY_ALL_BONUS`。任务计数挂点：openBox→opens、doBattle 胜→wins、工坊洗练/镶嵌→forge。
- 套装图鉴：`state.setCollection` 按「曾获得」收录（grantSpecial 写入 + load() 追溯扫描身上/包内专属件，分解也算）；收集加成 `collectionBonus()`：2 件收益 +10%、4 件攻血 +8%、6 件收益再 +25%，与战斗内套装效果独立成乘区。
- 离线巡猎：awardOffline() 里若 `autoHunt` 开且野外已解锁，按 3 秒/场 ×50% 估算 hunts，胜率按战力比（≥1.3→95%、≥1→80%、≥0.75→50%、否则 20%），发灵石/修为/兽骨并推进 `wildKills`（每 12 杀保底离线也结算，掉落上限到背包满）；不出首通里程碑。
- 音效：`beep()` 吃 `state.volume`（0–1，页脚滑条）；`chime([freqs])` 琶音用于套装掉落 / 首领击败 / 领奖 / 签到。

**灵宠与洞府**（2026-10-27 完成）：

- 招募券：开箱 `PET_CHANCE`(0.4%) 掉 `petTickets`；4 只灵宠（`PETS`：雷灵狐攻 / 铁甲龟血 / 灵瞳鼠暴击 / 招财貔貅收益），招募花券，喂养灵石升亲密度（上限 10，费用 `petFeedCost`），单只出战（`activePet`）。
- 加成并入：`petBonus(stat)` 在 playerCombatStats（atk/hp/crit）与 baseGain（gain）生效。
- 洞府 `state.cave`：聚灵阵（灵石收益 +8%/级，进 baseGain）、药园（开箱暴击 +0.4%/级 → `critChance()`，上限 50%）、藏经阁（修为 +10%/级 → `expMult()`，作用于开箱 / 战斗 / 离线修为）。

**无尽秘境**（2026-10-27 完成）：

- 第 4 个页签，`unlockedMode`：`towerCleared >= 60`；`currentLevel = endlessBest + 1`，胜利推进 `endlessBest`，失败无损。
- `MODES.endless`：沿用爬塔成长曲线（reqBase 60 ×1.16^层），灵石系数 7 / 修为 0.8 / 塔印步长 5，每 10 层首领。
- 词缀 `ENCHANTS` 按 `(层-1) % 3` 轮换：坚壁（敌防 ×1.6）/ 狂暴（敌攻 ×1.35）/ 厚血（敌血 ×1.5），在 `enemyFor` 里乘入并写进 kicker / `enemy.affix`。
- 奖励：每胜 8% 概率掉镇塔套装件（`grantSpecial('tower', level, …)`，战力随层数走）；不出里程碑。`TROPHIES.endless` 复用塔印字段，战利品面板按 tower/stage/wild 去重渲染。

**第二批扩展（试炼 / 养成 / 调味，2026-10-27 完成，TODO 10–24）**：

- **秘境探幽**（Roguelike）：试炼面板开局，需闯关第 10 关；连闯 8 层，敌人需求 = max(80, 战力×0.65)×1.22^(层-1)×仙位倍率，每 3 层与第 8 层首领；每层胜后 3 选 1 神物（`ROGUE_BUFFS`，含一次性「不灭」复活），战败整局结束；每层发灵石+塔印，通关额外 ×3 + 150 碎屑；`state.rogue = {best, run}`，run 随档走（刷新不丢局）。
- **首领连战**：连打已通关的闯关首领（5/10/15/20/25/30 中 ≤stageCleared 的），按平均回合评级 S/A/B/C 发奖，每日一次（`state.bossRush` 按日重置）。
- **条件试炼**：三项（速杀 ≤5 回合打野外 / 禁吸血打塔层 / 承伤 ≤30% 最大生命打闯关），各每日一次发 8000 灵石 + 40 碎屑，全通额外 60 碎屑；`state.trials` 按日重置。
- **五行克制**：装备与敌人都带五行（`ELEMENTS`/`ELEMENT_BEATS` 金→木→土→水→火→金）；我方每件克敌装备 +3% 攻、被克 -2%、下限 ×0.9（`elementBonus`，在 doBattle 与各特殊战斗里乘入）；敌人卡与装备条目都有五行标色；旧装备 load 时补随机五行。
- **周末双倍**：`isWeekend()` 时秘境灵石 ×2（doBattle 内），日常面板有提示。
- **词条继承**：工坊内「词条继承」区，消耗材料装备 + 200 碎屑，材料第一条词条覆盖目标第一条**未锁定**词条；锁定词条不可被覆盖。
- **炼丹房**（洞府内）：`ELIXIRS` 三种丹（攻 15% / 防 20% / 收益 30%，5 分钟），炼制耗时（主循环检测完成），库存服用，同时间只生效一颗（`elixirOn`）。
- **功法树**（境界面板）：修为点三系各 5 层（攻 2% / 血 2% / 修为 5% 每层），费用 (lv+1)×3000。
- **灵宠扩展**：双宠位（5 券解锁，`petSlots`/`activePets` 数组）、信物（碎屑 30×(lv+1)/级，上限 10，出战宠每级 +0.5% 主属性）、放生（返还 ceil(券/2)，亲密度与信物清零）。
- **仙界轮回**：飞升后境界面板「入仙界」，费用 1e8×5^仙位，每位收益 +50% 且 `contentReq` ×1.25（敌人与产出同步放大，`immortalMult`）。
- **奇遇**：手动单开 2% 概率（5 分钟冷却、有弹窗时不触发），拾宝 / 强敌（胜得 80 碎屑入怪图）/ 游商（1800 灵石买 100 碎屑）三选一，`adventureModal`。
- **黑市**：每日三件限购（按日期确定性轮换 `MARKET_POOL`），碎屑包 / 大包 / 招募券 / 洗练半价券；`state.market` 按日重置。
- **称号**：标杆成就带 `title`，已领即解锁，佩戴 +2% 收益，页头徽章展示；`state.title`。
- **怪物图鉴**：胜利击杀按 `enemy.base` 计数（`state.bestiary`），每 5 物种攻血 +0.5%；collection 面板展示。
- **周气运**：按年初周数 %4 轮换（碎屑+50% / 灵石+20% / 券率×2 / 洗练-30%），在 `addStones` / `addDust` / openBox / 洗练费用处生效；日常面板展示。

**耐玩度 / 反作弊 / 界面优化**（2026-10-27 完成，TODO 25–28）：

- **周常**：`WEEKLY_TASKS` 三项（开箱 1500 / 秘境胜 80 / 探幽 12 层），奖励 3–5 万灵石 + 碎屑，全领额外 2 万 + 100 碎屑；`ensureWeekly()` 按 `weekKey()`（年-周号）重置 `state.weekly`；计数挂点 openBox / doBattle 胜 / rogueFight 胜。
- **成就二梯队**：ACHIEVEMENTS 扩到 30 条（+开匣传奇/碎屑成山/灵宠系/功法/仙位/探幽/试炼/连战 S）。**注意 TDZ**：数组字面量里 `target:` 是急切求值，不能引用后面才声明的常量（曾因此启动即死，改字面量 10）。
- **签到里程碑**：`SIGN_MILESTONES` 30/100/365/1000 天大奖（含招募券），signIn() 里检查并只发一次（`state.signMilestones`）。
- **反作弊**：①连点器 `botCheck`——2026-10-28 放宽：只有 60 秒窗口内累计 ≥400 次点击（≈6.7 次/秒不间断持续满 1 分钟）才认定连点器，触发递进锁定 3/15/60 秒；旧的「1.5 秒 5 连快击 / ≥10 次」短窗判定因误伤真人手点已移除。锁定期间 manualOpen 直接 return；只拦手动开箱，自动循环与存档不受影响。②存档软校验（load 内）：`stones ≤ totalStones`、图鉴计数总和超 opens 按比例收敛、普通装备战力上界 `BASE_POWER[r]×1.3`（超出截断）、非法数值字段 fixInt 兜底。②'（2026-10-28 补强）load() 钳制补齐逃网字段：exp≤最高突破门槛×100、speedLv/gainLv/luckLv≤200、ascensions≤1e6、buffUntil/丹药与炉火/灵田时间戳≤now+单份最长时长、adventure.lastAt 不得在未来、totalStones≤1e18、秘境图 looted⊆rev；导入文件与服务端 /api/save 同口径逐字段量级校验（缺字段/数字字符串/stones>totalStones 直接拒），服务端静态缓存 js/css 改 no-cache（max-age=3600 会让部署后拿旧脚本配新页面）。③`window.LX` 调试钩子只在 `127.0.0.1/localhost/[::1]` 本机挂载（2026-10-28 移除 `?debug=1` 远程开关——线上任何人都能借此改状态刷云端战力）。游戏页与登录页同上严格 CSP：`__errors` 内联收集器已删，game.js 生成立绘的内联 `onerror` 已改为 document 捕获委托。
- **可读性 / 手机布局**：styles.css 末尾两段——全局字号放大 pass（几乎每个文字类选择器 +1~2px）；540px 断点下触控目标加大（mini 按钮 min-height 30px、弹窗按钮 38px）、灵宠/试炼行动按钮改 2 列网格、间距加宽；430px 再降一档。

**第三批「构筑与探索」**（2026-10-28 完成，TODO 29–39）：

- **词条共鸣**：`resonanceInfo()` 统计已穿戴同词条条数，3 条 → 攻/血/防 +5%（暴/吸/破 +2%），5 条翻倍；在 playerCombatStats 并算；装备面板顶部展示激活情况。
- **道童**（新面板）：`state.steward = {autoWear, autoSalvage(0/1/2), autoEnhance(0/5/10/15/20), autoMarket[]}`；主循环 5 秒一跳 `stewardTick()`：自动穿戴走 `autoEquip(true)` 静默、自动强化静默扣钱升到上限、黑市代购调 `buyMarket`；自动分解在 `addItem` 入口拦截（套装件除外）。tick 末尾顺带做镜像周检。
- **套装升星**：套装件 `star 0..5`（fixItem 钳制），`itemPower` 每星 ×(1+10%)；工坊内对专属件展示「吞噬同套同部位重复件」列表（背包克隆件即可喂）。
- **炼器**：专属件分解得器魂（3/件，探幽通关 +5），30 器魂 + 5 万灵石定向打造指定部位天品（名带「器」后缀，2 词条）。
- **赌石**（黑市面板）：2000 灵石/次，GAMBLE_TABLE 加权：40% 回 200 / 33% 碎屑 20-60 / 15% 灵石 3000-6000 / 10% 碎屑 150-260 / 2% 天品装备。
- **斗法·昨日之我**（试炼面板）：stewardTick 每周生成 `mirror.snap{power,atk,hp,def}`，敌人 hp×7.5 用同公式；胜领 max(2000, 战力×3) 灵石 + 50 碎屑，每周一次。**守卫**：快照仅当 `st.power > 1` 才写入，旧坏快照（power≤1）自愈重建——早期测试档曾因空装备态快照 power=0 进档，已根治。
- **秘境图**（新面板）：12×8，`seed` 确定性哈希出矿/尘/妖/窟；每日 +6 行动力（上限 12），只能走相邻格（含探雾），妖物按离心距离缩放、战败不扣行动力不移动；`state.map = {seed, px, py, rev[], looted[], ap, date}`。
- **挑战修行**（境界面板）：三项限制（凡衣不穿专属 / 无匠不洗练不继承 / 苦行不吃丹），破戒即时标 dirty（挂在 equipItem / forgeReroll / doInherit / takeElixir），飞升时未破戒则 `ordealDone` 记永久乘区（收益 +10% / 攻血 +6% / 攻 +6%）。
- **陈列室**（图鉴面板）：6 部位展位封存背包更强件（旧展品回包），每件收益 +1%、专属/仙品 +2%。
- **灵田**（洞府面板）：3 块田 × 3 种籽（30 分钟/2 小时/8 小时 → 20/60/200 碎屑），主循环不需轮询、面板渲染按 15 秒桶刷新。
- **天道录**（境界面板）：十卷按境界解锁，参悟领 2000×(卷+1) 灵石。

**多标签页保存锁**（2026-10-28 新增，根治当日测试中真实发生的存档覆盖事故）：`lingxia_idle_v1_tab` 心跳锁（6 秒过期），主循环 2 秒续锁；`persist()` 发现锁被其他标签页持有时**跳过写入**并在页脚警示「检测到另一个标签页」。后台标签页 loop 早退、锁自然过期。多开仍不建议，但不会再静默互相覆盖。

**第四批「深度咬合」**（2026-10-28 完成，TODO 41–50）：

- **宝石三合一**：`gemCounts()` 全身（穿+包）计数，同档同型 ×3 在工坊融成高一档一颗（落入当前工坊装备空孔）；`takeGems` 跨装备抽取。
- **符文组词**：`RUNEWORDS` 六个词（2/3 颗定序），`runewordOf(it)` 按孔位顺序精确匹配（拆一颗即失效）；加成在 playerCombatStats 并算（攻血防百分比、暴吸破/减伤直加）。工坊实时显示成词与词库。
- **灵宠真灵融合**：`fuseTruePet(keepId)`——消耗另一只满亲密度灵宠 + 200 碎屑，保留方向真灵 `per ×1.75`。
- **五行灵脉**：秘境图 tile 带五行（`tileHash(idx+977)`），身上有克制装备时产出 ×1.5（`veinBonus`）。
- **心魔劫**：`breakthrough()` 时 `spawnDemon()` 快照玩家属性 ×1.2，试炼面板随时挑战；每胜一形 demon ×1.15 递增、奖大额修为（当前境界突破修为 ×0.6）。
- **悬赏令**：每日两张（`BOUNTY_POOL` 随机不重复），钩子自动计数（击杀带五行 / 探幽 / 工坊 / 分解 / 开箱 / 胜场），`bountyProgress(metric, n)` 统一入口；每日一次 2000 灵石刷新单张。
- **时辰系统**：`shichenNow()` = 本地小时 +1 后折半，12 时辰各带微 buff（碎屑/攻/收益/开箱暴击/灵石/破甲/券率/防），挂进 addDust/addStones/baseGain/critChance/playerCombatStats/openBox；页头徽章展示。
- **天劫防御战**：每三日 `tribulationDue()`，试炼面板按钮 + 自动弹窗（每轮只弹一次 `tribPrompted`）；敌人 hp=攻×5+200、atk=血×4.5%+50；护体符（80 碎屑/张，单场最多 3 张各 -15% 承伤）；胜得灵石+300 碎屑+2 券，败可无限再战。
- **道侣**：三 NPC（青璇收益+8% / 白芷攻+5% / 石坚血+6%），三种赠礼（灵石+2/碎屑+5/券+10 情谊），满 100 结为道侣得常驻加成（`daoBonus`）与专属往事文本。
- **战功碑**：`state.battleStats`（dmg/taken/wins）在 doBattle 累加，图鉴面板碑文页展示。

**实测进度参考**（当时测试用档）：闯关第 14 关、爬塔 21 层、野外 1–4 区清完、境界 4（元婴）、穿镇塔·玄鳞甲 +3 与凤凰羽扇。（当时测试用档）：闯关第 14 关、爬塔 21 层、野外 1–4 区清完、境界 4（元婴）、穿镇塔·玄鳞甲 +3 与凤凰羽扇。

## 3. game.js 代码地图

单文件 IIFE。按区块阅读：

| 区块（大致行号） | 内容 |
|---|---|
| 顶部常量 `SAVE_KEY`…`MAX_TRAIN`（≈10–39） | 全局数值旋钮 |
| `MODES` / `MILESTONES` / `SETS` / `TRAININGS` / `TROPHIES`（≈22–96） | 秘境征战配置表 |
| 怪物与区名 `TOWER_MONSTERS`…（≈100–166） | 塔怪/塔主、章节、野外区 |
| `RARITIES` / `SLOTS` / `ITEM_NAMES` / `BASE_POWER`（≈168–255） | 掉落与装备基础 |
| `AFFIXES` / `GEM_TIERS` / `GEM_VALUES` / `DUST_BY_RARITY`（BASE_POWER 之后） | 词条与宝石配置 |
| `REALMS` / `REALM_COSTS` / `UPGRADES`（≈256–287） | 境界与升级线 |
| 工具函数 `$` / `emptyEquipped` / `defaults` / `persist` / `load`（≈288–490） | 存档 |
| 开箱与装备 `openBox` / `addItem` / `manualOpen` / 强化（≈600–960） | |
| 战斗区 `contentReq` / `isBoss` / `enemyFor` / `playerCombatStats` / `specialPower` / `makeSpecialItem` / `trophyGain`（≈410–600） | |
| 战斗结算 `currentLevel` / `simulateBattle` / `doBattle` / `upgradeTraining`（≈1035–1220） | |
| 工坊 `openForge` / `renderForge` / `forge*` / `socketGem` / `unsocketGem`（upgradeTraining 之后） | 词条洗练 / 宝石镶嵌弹窗 |
| 日常 / 成就 / 灵宠 / 洞府交互 `signIn` / `claimTask` / `claimAchievement` / `recruitPet` 等（forgeUnsocket 之后） | 阶段三 / 四玩法动作 |
| 新面板渲染 `renderSetCollect` / `renderPets` / `renderCave` / `renderDaily` / `renderAchv`（renderCollection 之后） | 签名缓存（`panelSigs`），内容没变不重绘 |
| 试炼 / 养成 / 调味 `rogue*` / `runBossRush` / `runTrial` / `craftElixir` / `enterImmortal` / `buyMarket` / `maybeAdventure` 等（洞府交互之后） | 第二批扩展玩法动作 |
| 第二批渲染 `renderGongfa` / `renderElixir` / `renderTrials` / `renderMarket` / `renderBestiary`（renderAchv 附近） | 同样走 `panelSigs` 签名缓存 |
| 突破 / 飞升 / 离线（≈966–1035） | |
| 战斗弹窗 `openBattleModal` 等（≈1380 起） | |
| 主循环 `loop` / 渲染节流 / 事件 `bind`（≈1900–2009） | |

技巧要点：

- **脏标志渲染**：`bagDirty / equipDirty / logDirty / combatDirty` + `render()` 100ms 节流；背包容器用 `paintBag()` 独立重绘。
- `state.log` 只保留最近 14 条，随存档走。
- 音效用 WebAudio 即时合成（`beep()`），无音频文件。
- 主循环每 tick 帧累积开箱（单 tick 上限 50 次），3 秒存一次档，`uiMode` 记录当前面板。
- 战斗冷却：`battleCooldownUntil = now + 450ms`；**只拦住自动巡猎**，手动战斗不看冷却、看弹窗是否开着（开着就拒绝再次触发）。

## 4. 数值与公式速查

### 4.1 全局常量

```
SAVE_KEY 'lingxia_idle_v1'   OFFLINE_CAP 4*3600   OFFLINE_EFF 0.5
CRIT_CHANCE 0.05  CRIT_MULT 10   ← 开箱收益暴击，与战斗暴击无关
BUFF_CHANCE 0.008  BUFF_MS 30000 ← 聚气丹（30 秒收益 ×2）
BAG_CAP 60   MAX_ENHANCE 20   MAX_TRAIN 10
TOWER_MAX 60   STAGE_MAX 30   WILD_MAX 12
```

### 4.2 开箱经济

```js
interval()            = max(0.25, 2 * 0.94^speedLv)                  // 开箱间隔秒
baseGain()            = (3 + 0.9*gainLv) * 1.7^realm * (1+0.25*ascensions) * (1+totalPower/400) * buff
itemPower(it)         = power * (1 + 0.18*lv)                        // 强化每级 +18%
enhanceCost(it)       = 专属件: (power*2.2+30) * 1.42^lv
                        普通件: RARITIES[r].stone * 10 * 1.55^lv
salvageValue(it)      = 专属件: (power*2+20) * (1+0.35*lv)
                        普通件: RARITIES[r].stone * 2 * (1+0.4*lv) * (1+0.2*gainLv)
```

品质权重 `RARITIES[i].weight * (1 + 0.1*luckLv)^i`：凡 1000 / 灵 350 / 玄 100 / 地 25 / 天 5 / 仙 1。
`BASE_POWER = [3, 10, 30, 90, 280, 900]` 为普通装各品质战力基准。

### 4.3 秘境征战常量表（MODES）

| 玩法 | max | reqBase | reqGrowth | 敌 HP× | ATK× | DEF× | 首领 HP/ATK | 灵石系数 stone | 修为系数 exp | 战利品步长 |
|---|---|---|---|---|---|---|---|---|---|---|
| 爬塔 tower | 60 | 60 | 1.16 | 7.5 | 0.75 | 0.22 | 1.45 / 1.2 | 6 | 0.7 | 10 |
| 闯关 stage | 30 | 15 | 1.38 | 7.2 | 0.72 | 0.20 | 1.4 / 1.18 | 5 | 0.8 | 5 |
| 野外 wild | 12 | 30 | 1.90 | 6.8 | 0.68 | 0.18 | 1.3 / 1.12 | 3.5 | 0.45 | 3 |

首领判定 `isBoss`：塔 `level%10==0`；关 `level%5==0`；野外 `level%4==0 || level==12`。首领防御统一再 ×1.12。

`MILESTONES`（首通必掉指定部位）：塔 10/20/30/40/50/60 → 武器/衣袍/冠冕/云靴/法宝/灵符；关 5/10/15/20/25/30 同序；野外 1/3/5/7/9/11 同序。

### 4.4 玩家属性（playerCombatStats）

```js
power = Σ itemPower(equipped)
atk = (16 + power*0.9) * (1+0.12*realm) * (1+0.08*ascensions) * 套装Atk * (1+0.03*trainAtk)
hp  = (120 + power*5.5) * (1+0.15*realm) * (1+0.08*ascensions) * 套装Hp * (1+0.03*trainHp)
def = (3 + power*0.28) * (1+0.10*realm) * 套装Def
crit = 0.10 + 套装 → 上限 0.6；critMult = 2（战斗固定）
pierce = min(0.6, 0.015 * trainPierce)
dr（减伤）/ lifesteal（吸血）只来自套装，上限 0.6 / 0.5
```

### 4.5 敌人与战斗（enemyFor / simulateBattle）

```js
contentReq(mode, level) = reqBase * reqGrowth^(level-1)          // 敌人基准值
recommendedPower        = ceil(contentReq * (boss ? 1.35 : 1))    // 界面参考值
enemy.hp  = round(req * cfg.hp  * (boss?cfg.bossHp:1))，min 1
enemy.atk = round(req * cfg.atk * (boss?cfg.bossAtk:1))，min 1
enemy.def = round(req * cfg.def * (boss?1.12:1))，min 0
```

模拟：玩家先手，每回合玩家→敌；`dmg = max(1, player.atk − enemy.def*(1−pierce)) * U(0.9~1.1) * (暴击?2:1)`；吸血按伤害百分比回血（上限满血）；敌反击 `max(1, enemy.atk − player.def) * (1−dr)`；120 回合双方都活 → 判负（timeout，不耗资源不损进度）。

### 4.6 奖励结算（doBattle）

- 灵石 `floor(contentReq * stone * (boss?1.8:1) * (首通?1.5:1) * (再战?0.5:1))`，修为同式换 `exp` 系数。
- 战利品 `1 + floor(level/trophyStep) + (boss?2:0) + (首通?2:0)`。
- 再战（replay）= 已通关满层后重复挑战，奖励减半、进度不动、8% 概率掉专属件。
- 野外套装掉落：首通里程碑（MILESTONES.wild）必掉指定部位；每区第 12 击杀必掉随机部位；胜利后另有 6% 随机掉落；首通第 12 区必掉随机部位。
- 塔首通最终层（60）必掉随机部位。
- 专属件战力 `specialPower = round((20 + contentReq*mult) * U(0.9~1.1))`，mult：塔 0.4 / 关 0.42 / 野外 0.45；品质恒为仙品（r=5）。

### 4.7 套装（SETS）

| 套装 | 来源 | 2 件 | 4 件 | 6 件 |
|---|---|---|---|---|
| 镇塔 | 爬塔 | 防御 +30% | 生命 +30% | 受伤 −15%（dr +0.15） |
| 征伐 | 闯关 | 攻击 +20% | 暴击率 +8% | 攻击 +35% |
| 荒狩 | 野外 | 生命 +20% | 攻击 +15% | 攻击吸血 12% |

部件名在 `SETS[mode].pieces`（武器/衣袍…），CSS 类 `set-tower / set-stage / set-wild`。

### 4.8 战技（TRAININGS）

| 战技 | 效果 | 消耗货币 | 升级费用 |
|---|---|---|---|
| 战意 | 攻击 +3%/级 | 塔印 towerMarks | 当前等级 +1 |
| 体魄 | 生命 +3%/级 | 战功 warMerits | 当前等级 +1 |
| 破甲 | 无视敌防 +1.5%/级 | 兽骨 beastBones | 当前等级 +1 |

上限均为 `MAX_TRAIN = 10`。（表中攻击/生命加成实际在 4.4 公式里体现。）

### 4.9 境界与升级线

```js
REALMS：炼气 筑基 金丹 元婴 化神 炼虚 合体 大乘 渡劫 仙人
REALM_COSTS：0 60 400 2500 15000 80000 4e5 2e6 1e7 4e7   // 突破消耗修为
UPGRADES：speed (50, ×1.55, 40级) / gain (40, ×1.6, 100级) / luck (150, ×1.7, 50级)
飞升：恒需 1e8 灵石；仙缘 = floor(sqrt(灵石/1e8))，永续 ×25%收益/点，+8%攻血/点；
      重置灵石/修为/境界/三条升级线，保留装备、背包、图鉴、战利品、秘境进度。
```

### 4.10 词条与宝石（2026-10-27 新增）

```js
// 词条（atk/hp/def 为最终属性百分比；crit/ls/pierce 直加战斗数值后走既有上限）
AFFIXES      攻击 3–8% / 生命 4–12% / 防御 4–10% / 暴击 1–3% / 吸血 1–3% / 破甲 1–3%
AFFIX_COUNT  [0, 0, 0, 1, 2, 3]      // 凡灵玄无词条；地1 / 天2 / 仙3
AFFIX_QMULT  [0.5 … 1.35]            // roll 值 = U(min,max) × 品质系数，保留 3 位小数
rerollCost   = RARITIES[r].stone * 12 * 1.3^rerolls   // 洗练费用，可锁 1 条
MAX_LOCK = 1

// 宝石（合成即镶嵌到空孔；卸下返还 50% 造价）
GEM_TIERS    下品 20 / 中品 60 / 上品 150 碎屑
GEM_VALUES   atk 2/4/7% · hp 3/6/10% · def 3/5/8% · crit 0.8/1.5/2.5% · ls 0.8/1.5/2.5% · pierce 1/2/3.5%
socketSlots  仙品(r=5) 2 孔，其余 1 孔（品质推导，不入档）
dustValue    专属件 max(10, 20 + 战力×12%)；普通件 DUST_BY_RARITY [0,1,2,4,8,16]

// playerCombatStats 并算（位置：境界/仙缘乘区之后、套装之前）
agg.atk/hp/def → atk/hp/def ×= (1+agg)；agg.crit/ls/pierce → 直加；上限沿用 0.6/0.5/0.6
```

### 4.11 收集留存 / 养成 / 无尽（2026-10-27 新增）

```js
// 灵宠
PET_CHANCE 0.004        PET_MAX_LV 10
PETS   雷灵狐 攻2%/级(1券) · 铁甲龟 血2.5%/级(1券) · 灵瞳鼠 暴击0.4%/级(2券) · 招财貔貅 收益3%/级(2券)
petFeedCost = 200 × 1.6^lv          // 喂养；单只出战（activePet）

// 洞府（cave）
聚灵阵 500×1.7^lv  灵石收益 +8%/级（进 baseGain）
药园   800×1.75^lv 开箱暴击 +0.4%/级（critChance()，上限 50%）
藏经阁 1200×1.8^lv 修为 +10%/级（expMult()，开箱/战斗/离线修为全吃）

// 日常与签到
DAILY_TASKS 开箱200(3000灵石) · 秘境胜15(3000灵石+20碎屑) · 工坊5次(3000灵石+30碎屑)
DAILY_ALL_BONUS 全领 6000 灵石 + 50 碎屑
SIGN_REWARDS 7 日循环 1000/2000/30碎/4000/6000/60碎/12000+100碎

// 成就：ACHIEVEMENTS 20 条，达成领灵石（500 ~ 20万）；maxItemLv / collectCount 为派生指标

// 套装图鉴收集（collectionBonus）
2 件 收益+10% · 4 件 攻血+8% · 6 件 收益+25%（每套独立判定，全局乘区）

// 无尽秘境（MODES.endless）
reqBase 60 ×1.16^层 · 灵石×7 修为×0.8 塔印步长5 · 每10层首领
ENCHANTS 轮换：坚壁 防×1.6 / 狂暴 攻×1.35 / 厚血 血×1.5
胜利 → endlessBest=层数；8% 掉镇塔件；离线巡猎胜率 95/80/50/20% 按战力比分档
```

### 4.12 第二批扩展（2026-10-27 新增）

```js
// 五行
ELEMENTS 金木水火土 · ELEMENT_BEATS 金→木→土→水→火→金
elementBonus：每件克敌装备 +3% 攻 / 被克 -2%，下限 ×0.9（doBattle 内乘入）

// 秘境探幽（rogue）
ROGUE_FLOORS 8 · 敌 req = max(80, 战力×0.65) ×1.22^(层-1) ×1.25^仙位
ROGUE_BUFFS 8 种（攻/血/防/吸血/暴击/破甲/减伤 + 不灭·复活一次）
每层奖励 max(800, 战力×2×(1+0.1×层)) 灵石 + (2+层) 塔印；通关 ×3 + 150 碎屑

// 首领连战：平均回合 ≤4=S(2万+100碎) ≤7=A(1.2万+60) ≤12=B(6千+40) 其余 C(3千+20)，每日一次
// 条件试炼：速杀≤5回合 / 禁吸血 / 承伤≤30%maxHP，各 8000 灵石+40 碎屑，全通 +60 碎屑

// 炼丹房（elixir）：狂战丹 3000 / 金刚丹 3000 / 聚财丹 6000，炼制 5 分钟，药效 5 分钟，同时一颗
// 功法（gongfa）：锋锐/玄功/慧心 各 5 层，(lv+1)×3000 修为，攻血 2%·修为 5% 每层
// 仙界轮回：1e8×5^n 灵石/位，收益 +50%/位，contentReq ×1.25/位（immortalMult）

// 灵宠扩展：双宠位 5 券 · 信物 30×(lv+1) 碎屑/级 上限10（出战宠 +0.5%/级）· 放生返还 ceil(券/2)
// 黑市：MARKET_POOL 按天轮换 3 件限购（碎屑包 2500 / 大包 7000 / 券 6000 / 半价券 1500）
// 奇遇：手动单开 2%、冷却 5 分钟；拾宝 baseGain×240 / 强敌 80 碎屑 / 游商 1800 灵石=100 碎屑
// 周气运：年初周数 %4 → 碎屑+50% / 灵石+20% / 券率×2 / 洗练-30%（addStones/addDust 内生效）
// 词条继承：材料装备 + 200 碎屑 → 材料第 1 条词条覆盖目标第 1 条未锁词条
```

## 5. 存档 Schema

`persist()` 直接 `JSON.stringify(state)` 存进 `lingxia_idle_v1`；`load()` 用 `Object.assign(defaults(), data)` 兜底，并逐项校验（详见 `load()`，结构错误字段会被重置修好 → **新增字段只要加进 `defaults()` 就自动兼容旧档**）。

```js
// defaults()
{
  stones, totalStones, exp, opens: Number
  dust: Number                   // 碎屑（词条宝石系统货币）
  realm, ascensions, speedLv, gainLv, luckLv: Number
  counts: Number[6]              // 六品质图鉴计数
  best: -1..5                    // 最高品质
  buffUntil, lastSeen: 时间戳     // 丹药、离线结算
  muted: Boolean
  battleSpeed: 1|2|4             // 战斗弹窗倍速
  volume: 0..1                   // 音量（页脚滑条）
  achievements: { [id]: true }   // 已领取成就
  signInDays: Number             // 累计签到天数
  lastSignIn: 'YYYY-MM-DD'       // 本地自然日
  daily: { date, opens, wins, forge, claimed: [taskId] }  // 跨天由 ensureDaily() 重置
  weekly: { week, opens, wins, rogue, claimed: [taskId] } // 跨周由 ensureWeekly() 重置
  dustTotal, trialWins, rushS: Number  // 二梯队成就的累计指标
  signMilestones: [天数]               // 已领的签到里程碑
  setCollection: { tower|stage|wild: [slotKey] }          // 套装图鉴「曾获得」
  petTickets: Number
  pets: { [petId]: 亲密度 }      // 0..PET_MAX_LV，>0 才算已拥有
  activePet: petId | ''
  cave: { array, garden, library }
  elixir: { owned: {id:n}, until, id, crafting: {id, doneAt}|null }   // 炼丹
  gongfa: { atk, hp, hui }       // 功法 0..5
  immortal: Number               // 仙位数
  petSlots: 1|2                  // 出战位
  activePets: [petId]            // 出战中（旧单数 activePet 已迁移）
  petTokens: { [petId]: lv }     // 信物 0..10
  rogue: { best, run: {floor, buffs[], reviveUsed}|null }  // 探幽
  bestiary: { [怪名]: 击杀数 }
  title: '' | 称号名
  market: { date, sold: [id] }   // 黑市，按日重置
  trials: { date, done: [id] }   // 条件试炼，按日重置
  bossRush: { date, grade }      // 首领连战，按日重置
  adventure: { lastAt }          // 奇遇冷却
  rerollCoupon: Number           // 洗练半价券
  endlessBest: Number            // 无尽最高层（0=未开）
  steward: { autoWear, autoSalvage, autoEnhance, autoMarket[] }  // 道童策略
  souls: Number                  // 器魂
  mirror: { week, snap: {power,atk,hp,def}|null, claimed }
  map: { seed, px, py, rev[], looted[], ap, date } | null  // 秘境图
  ordeal: { active, dirty }      // 挑战修行进行态
  ordealDone: [id]               // 已功成的修行（永久乘区）
  museum: { weapon…talisman: Item|null }   // 陈列室展位
  farm: { plots: [{id, doneAt}|null ×3] }  // 灵田
  chapters: [卷号]               // 天道录已参悟
  innerDemon: {atk,hp,def,kills}|null  // 心魔（突破生成，×1.15/胜形）
  bounty: { date, slots:[{id,prog,claimed}], rerolled }  // 悬赏令，按日重置
  talismans: Number              // 护体符（天劫减伤消耗品）
  tribulation: { last, done }    // 天劫，三日一临
  daoLv: { aff:{npcId:n}, married }  // 道侣情谊（上限 100）与已婚
  battleStats: { dmg, taken, wins }  // 战功碑累计
  // Item 另有 el（五行）、star（套装件升星 0–5）
  log: [{text, cls}] ≤14         // 玩家可见日志，随档走
  bag: [Item]                    // ≤ BAG_CAP
  equipped: { weapon|armor|helm|boots|artifact|talisman: Item|null }
  itemSeq: Number                // 物品自增 id
  bagWarned: Boolean
  // —— 秘境征战 ——
  towerCleared, stageCleared: Number        // 最高已通层数（0=未通）
  wildZone: Number             // 当前选中的野外区（1..12）
  wildCleared: Number[]        // 已首通的区域列表
  wildKills: { [区号]: 击杀数 }  // 用于每 12 杀必掉
  towerMarks, warMerits, beastBones: Number // 三种战利品
  trainAtk, trainHp, trainPierce: Number // 战技等级 0..10
  autoHunt: Boolean            // 连续挑战 / 自动巡猎开关（三处秘境通用）
}

// Item（背包与已穿通用）
{
  id, r: 0..5, slot: 'weapon'…'talisman', name, power, lv: 0..20,
  affixes: [{ k, v, lock?: true }],   // 词条，条数 = AFFIX_COUNT[r]
  gems: [ { k, t: 1..3 } | null ],    // 宝石孔，长度 = socketCount(r)，null 为空孔
  rerolls?: Number,                   // 洗练次数（首次洗练才写入）
  special?: true, setKey?: 'tower'|'stage'|'wild',
  source?: 同上, sourceLevel?: Number   // 掉落来源（专属件）
}
```

兼容要点（`load()` 内已实现）：旧档补齐缺失字段；包内/穿上的非法物品被剔除；专属件强制 r=5；`itemSeq` 取最大 id+1；`wildCleared` 去重排序；**缺词条/宝石孔的旧装备由 `sanitizeAffixes` / `sanitizeGems` 按品质补齐或清洗**（非法词条键剔除后重 roll 补足）；新面板字段（achievements/daily/setCollection/pets/cave 等）逐项校验兜底，**身上的专属件会追溯并入 `setCollection`**。**不要**在这一层做破坏性迁移；新增字段一定要先加 `defaults()`。

**注意**：多标签页会互覆盖同一个 key（README 已提示玩家）；最近战报 `lastBattles` 仅在内存。

## 6. 战斗弹窗与 UI 事件

- `index.html` 关键节点：`#battleReport`（面板内战报）、`#battleModal`（弹窗）→ 内含 `#battleKicker/#battleRound/#battleArena/#battleLog/#battleResult/#battleActions` 等 id，`styles.css` 按 `.battle-*` 前缀组织。
- 手动挑战：调 `doBattle(uiMode)` → 若弹窗已开则直接 return → 模拟 → 结算 → `openBattleModal(战报)`。
- 弹窗动画按事件逐帧播放；「跳过动画」直接跳到结算页；关闭走按钮或点遮罩。
- 回看战报用 `lastBattles[uiMode]`（内存）。重开弹窗时会清掉残留 `.battle-damage` 元素；飘字水平位置带 ±10px 随机偏移减少遮挡。
- 连续挑战 / 自动巡猎（`state.autoHunt`，三处秘境通用）：主循环里 `state.autoHunt && unlockedMode(uiMode)` 每 3 秒调 `doBattle(uiMode, {auto:true})`，受 450ms 冷却约束；**战斗失败自动关掉 `autoHunt`**。扫荡走 `doBattle(mode, {auto:true, sweep:true})`，不受冷却约束。
- 手动挑战会强制关闭 `autoHunt`（`if(!auto) state.autoHunt=false`）。

## 7. 测试情况

- 浏览器（Chrome 系）实测：三模式战斗、首通/再战、首领战、套装掉落与穿戴、战技升级、弹窗动画/跳过/回看/遮罩关闭、自动巡猎启停、连续手动战斗、离线弹窗。
- 词条系统实测（2026-10-27）：旧档（无 affixes/gems/dust）载入自动补齐、非法词条清洗；工坊锁定/洗练（锁定保留、费用 ×1.3、rerolls 计数）；宝石镶嵌/卸下（碎屑扣返、孔满收起选择器、碎屑不足禁用按钮）；属性并算（+7% 攻击石实测精确生效）；战斗链路无报错；重载后词条/锁/宝石/碎屑持久化；桌面与 390px 窄屏排版截图检查。
- QoL 实测（2026-10-27）：排序（品质/部位分组正确）、筛选（只列对应部位）、对比箭头（▲/▼ 数值口径正确）；扫荡 ×10 连胜不弹窗、进度 1→11、遇败中止；连续挑战每 3 秒自动结算、战败自停；倍速 ×2 下弹窗结算明显加快、battleSpeed 重载持久化；无 console 报错。
- 阶段三/四/五实测（2026-10-27）：老档迁移（新字段兜底、专属件追溯入图鉴）；成就 6 条就绪可领、领取加钱并标记；签到 +1000、按钮转已签；日常推满计数后三项可领；灵宠招募/喂养（+4% 攻精确）/出战；洞府升级；无尽解锁→词缀 kicker→首胜 endlessBest 推进→塔印入账；离线巡猎 2h 结算 1140 胜 / 11.97 万灵石 / 1140 兽骨 / 16 件掉落并入图鉴（modal 文案含巡猎段）；音量滑条持久化；重载全字段留存；桌面排版截图检查。注意：**手动回拨 lastSeen 测离线会被 beforeunload 的 save() 覆盖**，用 `LX.offline()` 调试钩子直接触发 awardOffline。
- 第二批扩展实测（2026-10-27）：探幽开局→首胜→3 选 1 神物→收手保奖（best=1）；首领连战 S 级 +2 万灵石、当日锁；迅捷试炼通过入 done；功法参悟扣修为；入仙界扣 1e8、immortal=1；炼丹→主循环自动出炉→服用生效；黑市购大包 +300 碎屑限购一次；成就发称号、佩戴后页头徽章 +2% 收益；双宠位解锁、双宠同时出战；信物碎屑升级；奇遇强触发（打桩 Math.random）拾宝 +8071；词条继承 200 碎屑转移、锁定词条保留；重载全字段持久化。**实测抓到并修复两个 bug**：①新招募 0 级灵宠被 load() 的 `lv>0` 判定误删（改按字段存在判拥有）；②工坊事件分发漏了 `inherit` 分支导致继承点击无效。另：放生返还从 floor 改 ceil（1 券宠返还 0 张太荒谬）。
- 耐玩度/反作弊/界面实测（2026-10-27）：周常三项推满领取精确到账（+13 万灵石 +750 碎屑含全领奖励）；成就总数 30、二梯队可领（碎屑成山 +2 万）；签到里程碑 30 天精确 +2.2 万灵石；连点 12 次触发「手速异常」锁 3 秒、锁定期内点击无效；手机 390px 截图（背包/灵宠）确认字号与 2 列按钮网格；全程无 console 报错。**又抓到并修复一个启动即死的 TDZ bug**：成就二梯队 `target: PET_MAX_LV/TOKEN_MAX` 在常量声明前急切求值（改字面量 10）；另修周常任务 id 与计数器字段命名不一致导致进度永远读不到（wOpens→opens）。
- 第四批实测（2026-10-28）：宝石三合一（3 颗跨装备消耗→高一档入空孔、宿主清空）；符文组词「生生诀」成词/拆词即失效；心魔突破生成、挑战结算（低配号战败属数值预期）；悬赏推满领取 +16500、刷新一次；时辰徽章「午时 · 灵石 +10%」；天劫开战→战败可再战（done 不置位）；道侣送礼 99→100、结缘青璇、专属往事入日志；战功碑数字随战斗累计。**又抓到并修复一个真 bug**：`sanitizeGems` 给旧装备建的是空数组（0 孔）而非对应数量空孔——旧装备永远无法镶嵌宝石，已改为按孔数重建；另补上融合功能的 UI 按钮（逻辑早有、渲染漏了）。**测试注意**：用户标签页与自动化页共用 localStorage，多标签保存锁会拦截测试页写入——测试一律内存态完成（不 reload、不依赖落盘），后台标签 render 暂停时用 `LX.refresh()` 强刷。
- 第三批实测（2026-10-28）：迁移全字段兜底、96 格地图生成（行动力 6）；道童自动强化六件全 +10、自动分解入包拦截、黑市代购；炼器出「天罡剑（器）」；赌石三种结果命中文案；地图移动扣行动力拾尘 +12；镜像快照 1149、挑战结算；共鸣按真实穿戴词条显示（吸血×3 / 攻击×3）；陈列室封存回包逻辑；天道录参悟 +8000；升星吞噬 star 0→1；修行无匠飞升功成 +6% 攻血。**当日上午真实发生一次多标签页存档覆盖事故**（后台旧标签页带新鲜内存态覆盖磁盘测试档），当日新增保存锁根治；镜像 power=0 坏快照一并加守卫自愈。
- 响应式在多个宽度下检查过战斗面板与弹窗排版。
- 控制台无报错；`node --check game.js` 通过为基准。

## 8. 已知问题与代码陷阱

1. **多标签页同写 `lingxia_idle_v1`**：后 flush 的覆盖先 flush 的。如做后端，把 `persist/load` 换接口即可（玩法代码不需要动）。
2. `CRIT_CHANCE/CRIT_MULT` 是**开箱收益**暴击；战斗暴击另有常量（0.10/×2，硬编码在 `playerCombatStats`）。别混用。
3. `simulateBattle` 的随机波动意味着手动挑战同一层可能偶发胜负变化；回放数据只在内存（`lastBattles`）。
4. 弹窗打开时手动挑战被拒绝（直接 return），关掉才能再打；自动巡猎不受弹窗状态影响但吃 450ms 冷却。
5. `bagWarned` 只是背包满提示标记；只有背包满时新掉落才会与最弱饰品比较自动分解（README 有写）。
6. 伤害飘字 DOM 在弹窗重开时手动清扫，改弹窗逻辑时留意别让残留元素越积越多。
7. `styles.css` 中战斗弹窗的规则顺序影响最终尺寸/排版，调整时先看现有顺序（当初排过一次序）。

## 9. 后续路线图（2026-10-28 更新：多人玩法落地）

已全部完成：**P1 词条/洗练/宝石、QoL 插队包、收集留存包（TODO 1–5）、P2 灵宠+洞府、P3 无尽秘境与探幽 Roguelike、第二批扩展（TODO 10–24）、第三/四批（构筑探索 / 深度咬合，TODO 29–50）、故事模式「红尘录」（TODO 52）、后端账号 + 云存档（TODO 59–63/65）、天下多人玩法（TODO 66–70：排行 / 竞技场 / 世界妖王 / 仙盟，见 §10）**。

### P1 装备词条 · 洗练 · 宝石（✅ 已完成 2026-10-27）

已按以下设计上线，落地细节见 §2 与 §4.10：
- 品质越高词条越多（地 1 / 天 2 / 仙 3 条）；词条池含攻击/生命/防御/暴击/吸血/破甲。
- `affixes`（Item 的新字段），`playerCombatStats` 里并入计算 → 玩家属性入口只有这一个函数，改起来很集中。
- 「洗练」用灵石重随机，可锁定 1 条；宝石镶嵌槽（仙品 2 孔、其余 1 孔）+ 分解得碎屑。
- 旧存档的 `affixes` 缺失由 `load()` 里 `sanitizeAffixes` 按品质随机补齐。

### P2 灵宠 + 洞府（✅ 已完成 2026-10-27）

按原设想落地：招募券开箱掉落、亲密度喂养、单只出战接进 `playerCombatStats`；洞府三建筑全局加成。落地细节见 §2 与 §4.11。

### P3 无尽秘境（✅ 已完成 2026-10-27）/ Roguelike（待做）

- 无尽层爬塔已上线：`MODES.endless` + `endlessBest` + 词缀轮换，见 §2 与 §4.11。
- 限时 Roguelike 小副本（战斗间 3 选 1 神物 buff）仍未做，是剩余玩法里最大的一块。

### QoL（✅ 排序/筛选/箭头/扫荡/连打/倍速已完成 2026-10-27；余项待做）

- ~~背包排序 / 部位筛选 / 战力对比箭头；秘境「扫荡」；「连续挑战」；战斗倍速按钮~~ 已上线（见 §2）。

### 收集与留存系统（✅ 已完成 2026-10-27，对应 TODO 1–5）

原设想全部落地：

- **成就系统**：里程碑式成就（累计开箱 N 次 / 通关塔 / 集齐套装 / 最高品质等），达成发灵石、战利品或图鉴奖励；存档加 `achievements: { [id]: 1 }`，照 §5 的 defaults + load 套路补。
- **日常任务与签到**：按自然日重置（存 `lastDailyDate` 时间戳判断跨天），任务链给开箱/秘境日常目标，签到给递进奖励；注意与离线结算的 `lastSeen` 是两回事，别混用。
- **套装图鉴收集奖励**：按套装统计**曾获得**部件（分解也算，需要新增「曾获得」记录，现有 `state.counts` 只按品质计数），集齐 2/4/6 件给全局百分比加成；全局加成与战斗内套装效果（§4.7）是两条独立乘区，别互相顶替。
- **离线巡猎**：离线结算（OFFLINE_CAP 4h / 50% 效率）时若 `autoHunt` 开启，按时长与当前区胜率估算战利品与击杀数，复用 `wildKills` 的每 12 杀必掉逻辑；防刷上限同 OFFLINE_CAP。
- **音效扩展**：音量滑条（存 `volume` 字段）+ 突破、套装掉落、首领击败等关键事件音效，仍走 WebAudio `beep()` 合成，不引音频文件。

### 开发排期（2026-10-27 定）

1. **阶段一 · P1 装备词条 / 洗练 / 宝石** ✅（2026-10-27 完成）
2. **阶段二 · QoL 插队包** ✅（2026-10-27 完成：排序/筛选/箭头/扫荡/连续挑战/倍速）
3. **阶段三 · 收集留存包** ✅（2026-10-27 完成：成就、日常签到、套装图鉴奖励、离线巡猎、音效扩展）
4. **阶段四 · P2 灵宠 + 洞府** ✅（2026-10-27 完成）
5. **阶段五 · P3 无尽秘境** ✅（2026-10-27 完成；Roguelike 副本待做）

PvP / 竞技场 / 排行 / 世界 BOSS 维持接后端前不做（§10）。

## 10. 后端 / 多人玩法约定

PvP、竞技场、排行榜、世界 BOSS 等需要后端。原则：
- 先把存档换成接口（`persist/load`），同步保留 `localStorage` 作离线缓存；✅ 已落地（2026-10-28，见下）
- 服务端校验战斗与掉落（防改数值），前端保留表现层；
- 合规提醒沿用 README：商用自担合规与内容审核。

### 后端现状（2026-10-28 接入：账号 + 云存档）

Node 零依赖服务端（`node:sqlite` + `node:crypto`，无 npm 依赖，Node ≥ 22.5），`node server/index.js` 启动，默认 8080：

- `server/index.js` 路由 + 静态托管；`server/db.js` 建表；`server/auth.js` 账号 / 会话 / 防爆破；`server/saves.js` 云存档；`server/http-util.js` 小工具。
- 接口：`POST /api/auth/register|login|logout`、`GET /api/auth/me`、`GET/POST /api/save`、`POST /api/save/beacon`（关页兜底，允许任意 Content-Type）。
- 表：`users`（含 `power_score`、`guild_id` 预留列 + 战力索引）、`sessions`（token 只存 sha256）、`login_attempts`（登录流水，IP/账号限流数据源）、`game_saves`（每用户一行 JSON 正本）；预留空表 `guilds`、`guild_members`、`pvp_seasons`、`pvp_battles`。
- 防爆破 / 防刷：连错 5 次锁号（15 分钟起步指数退避，封顶 24h，存 DB 重启不失效）；登录每 IP 20 次/10 分钟（内存滑窗）、同账号全网失败 30 次/15 分钟（查 `login_attempts`）；注册每 IP 5 个/小时（内存）+ 10 个/24 小时（查库）；存档每用户 30 次/分钟、单份 ≤ 512KB（服务端校验 stones/realm 同客户端导入口径）；登录 / 注册固定随机延迟 + 无用户也跑假 scrypt（防计时枚举）；写接口校验 Origin + JSON Content-Type；会话 Cookie HttpOnly / SameSite=Lax / HTTPS 下 Secure，7 天滑动续期。
- 前端接入点（game.js，都在「云存档」小节）：`authGate()`（启动门禁，未登录 / 无后端拦下）→ `cloudRestore()`（按 `lastSeen` 取本地 / 云端较新；`sessionStorage.lx_force_push` 标记导入档强制覆盖云端）→ `persist()` 尾部 `queueCloud()`（5 秒节流推送）→ `cloudFlushNow()`（pagehide 兜底）。玩法代码零改动。
- 多人玩法开工时的约定：战斗与掉落结算迁到服务端（`game_saves` 只当结果），战力快照写 `users.power_score`（服务端 `syncPowerScore` 已备好钩子，存档 JSON 带 `power` 字段即生效），排行直接查 `idx_users_power` 索引。

### 天下玩法现状（2026-10-28 接入，TODO 66–70）

`server/social.js`（零依赖，同 HTTP 入口分发），客户端在 game.js「天下玩法」小节 + index.html `data-page="world"` 标签页 + styles.css「天下」段：

- **接口**：`GET /api/rank`；`GET /api/pvp`、`POST /api/pvp/fight`；`GET /api/boss`、`POST /api/boss/hit`；`GET /api/guild[|/list]`、`POST /api/guild/create|join|leave|kick|notice|donate`。全部要会话；写接口统一过同源 + JSON 校验与每用户 60 次/分滑窗。
- **战力档案落库**：客户端 `persist()` 打包 `state.power` 与 `state.pvpSnap`（atk/hp/def/crit/critMult/lifesteal/dr/pierce），服务端存档入库时写 `users.power_score / realm / pvp_snapshot`，快照按 power 量级钳制（atk ≤ ×100、hp ≤ ×1000、def ≤ ×50，超界字段弃用）。
- **竞技场**：匹配真人按天梯分距就近取 8 洗牌取 2，不足 3 人时由假人按战力就近补位；每日 10 场 + 3 秒冷却 + 同一对手每日 3 场（`users.pvp_day/pvp_used/last_pvp_at`）。**2026-10-31 起胜负由服务端复算**（双方 `pvp_snapshot` 进 `server/battle.js` 模拟，响应带 `win`），客户端上报的 `win` 不再采信；本地 `simulateBattle` 只做战斗动画，日志 / 浮层 / 音效改用响应的 `out.win`。
- **假人「剑影」（2026-10-28，TODO 77）**：24 名内置 bot，users 表 `status='bot'`（口令哈希非法格式 + 非 active 状态，登录/注册道号均被挡）；战力 300×1.55^i 分档（约 300→700 万）、境界按战力阈值映射、快照与真人同量级口径、天梯分 700+38i 梯度。`ensureBots()` 服务启动时幂等补齐。假人参与 Elo 与对位日限（被打掉分后会自然轮出匹配名单）；**不进战力榜**（`/api/rank` 过滤 `status='active'`）。
- **天梯榜（TODO 78）**：`GET /api/ladder` 按 `pvp_rating` 取 30 名，假人常驻、真人打满一场（wins+losses>0）即入榜；返回我的名次/评分/战绩。客户端切磋成功后即调 `ladderLoad()` 刷新（别只改本地 rating，榜会滞后）。
- **世界妖王**：`world_boss` 按日一行（day 主键），血量 = 建BOSS 时全服最高战力 ×800（下限 2000 万，上限 1e12）；**2026-10-31 起伤害由服务端复算**（我的 `pvp_snapshot` vs `bossEnemyOf(maxHp)` 进 `server/battle.js`，客户端上报的 `damage` 不采信），仍按 `power×300` 量级钳制兜底；每人每日 30 场（`world_boss_hits` 聚合）。讨平后有战功者客户端发参与奖（8 千 + 伤害/50 灵石、20 + 伤害/5000 碎屑，结击者翻倍），`state.boss.claimed` 防重复领——奖励数值本身仍客户端自发，但伤害源已服务端化，可刷幅度大幅收窄。
- **仙盟**：立盟 5 万灵石（客户端扣款，**2026-10-31 起服务端凭账本余额校验**，不足 400 拒绝）；人数上限 30；捐献每人每日 10 万进 `guilds.fund`（`guild_donations` 按日累计限额，**同日起凭账本余额校验**，零灵石空手刷基金/贡献被堵）；等级 = 1 + fund/20 万（封顶 10），每级全局收益 +2%（`baseGain()` 里 `guildBuffLevel()`）；盟主退盟转最早入盟者，无人则解散。
- **盟玩法（2026-10-28 追加，TODO 73–75）**：贡献挂 `guild_members.contribution`（**退盟即清零**，重进从 0 起）。
  - **盟任务**：`GUILD_TASKS` 三项（捐献 10 万 / 盟妖王伤害 300 万 / 切磋 15 场），进度全部由服务端从 `guild_donations` / `guild_boss_hits` / `pvp_battles` 当日数据聚合（不信客户端自报）；每人每日每任务领一次（`guild_task_claims`），发 2 万灵石 + 25 贡献。改任务目标/口径只动 `GUILD_TASKS` 与聚合函数。
  - **盟主妖王**：`guild_boss` 每盟一行，血量 = 建BOSS 时成员最高战力 ×400 ×(1 + 0.25×(盟等级-1))（下限 200 万，上限 5e10），每日 5 场 / 人，伤害按 `power×300` 钳制；每 5000 伤害 +1 贡献。讨平奖客户端自发（4 千 + 伤害/40 灵石、10 + 伤害/4000 碎屑，结击 ×2，`state.guildBoss.claimed` 防重）。
  - **贡献商店**：`GUILD_SHOP` 五项（灵石俸禄 20×5 / 碎屑包 30×3 / 洗练券 40 / 护体符 60 / 招募券 50×2，每日限购），`spendContribution` 原子扣减防负余额，限购记 `guild_shop_log`；奖励客户端入包。
  - **贡献产出**：捐献每 2000 灵石 +1、盟妖王每 5000 伤害 +1、盟任务每项 +25；客户端各操作成功后调 `guildLoad()` 重拉 `/api/guild`（载荷含 tasks/boss/shop/myContribution），别在本地手补任务进度（会像当初一样漏刷）。
- 已知取舍（2026-10-31 更新）：PvP 胜负与妖王伤害已服务端复算；**个人资产（灵石/装备/掉落）仍客户端权威**，由存档增速账本做包络拦截（见下节）；妖王对低战玩家是 120 回合伤害竞速、战力不足时单场只 1 点伤害属设计内；`pvp_seasons` 表仍预留未用（当前天梯分连续不清零）。
- **战斗弹层与头像体系（2026-10-28，TODO 79）**：12 处静默战斗（PvP / 世界 / 盟妖王 / 昨日之我 / 心魔劫 / 天劫 / 探幽 / 首领连战 / 试炼 / 奇遇 / 秘境图 / 故事）统一经 `showBattlePopup(enemy, result, { title, playerHp, playerGray })` 进既有战斗弹窗；结果照旧即时结算，弹窗只做表现。约定：**弹窗对象必须带 `win`（finish 文案用）与 `specialBattle: true`（battleResultHtml 走独立文案分支）**——`b.special` 已被专属件掉落占用，别混用；首领连战只弹最终一战。头像：主人公 = `storyPortrait('xiaofan','battle')`（AI 图 / 内置 SVG，**懒加载**——SP_CFG 声明在头像块之后，脚本期立即调用会 TDZ）；敌人依次查 `ENEMY_CAST_MAP`（心魔→xinmo、修罗→xiuluo、独眼豹→baofeng 立绘）→ `MONSTER_MATCH` 名字关键词 → 17 枚 `MONSTER_ART` SVG 徽记（剑影/妖王/蛇/禽/蛛/猿/熊/狼/虎豹/草木/卫将/妖僧/虚空/幽魂/兽王/雷神/火焰/修士）→ 兜底 mo；昨日之我用主人公立绘加灰。battle-modal z-index 60，压过故事 / 天劫弹窗。
- **显示名收口（同日补）**：三处漏网修复——pvpState 对手映射、guildPayload 同门映射（SQL 别名已改 `name`，映射还在读 `r.username/m.username` 会显示空名）、盟妖王战功流水写入名（改取 `display_name || username` 快照）。原则：**服务端任何返回玩家名的查询统一 `COALESCE(NULLIF(display_name,''), username) AS name`，客户端映射一律读 `.name`**；妖王战功按写入时快照展示，历史记录不追溯改名。
- **实名与显示名（2026-10-28，TODO 90/91）**：
  - **先实名**：当日实现后按用户要求整体移除——注册不再收集姓名 / 证件号，`/api/profile/verify`、`showRealnameGate()`、`validIdCard` / `adultFromId` 与 users 表三列（verified/adult/realname_hash）的读写全部摘除；已建库里残留的这三列为无害孤儿列（SQLite 老版本删列麻烦，留着不动）。
  - **显示名**：`users.display_name`（唯一索引；老账号启动回填=道号），设置页「显示名」面板改（`POST /api/profile/name`，唯一 + 24h 一次 + `display_name_at` 记账）；`/api/auth/me` 返回 displayName，顶部 chip 与排行 / 天梯 / 候选 / 同门名单全部读 `COALESCE(NULLIF(display_name,''), username)`。妖王伤害流水的名字写入时取显示名快照。登录道号本身不变。
  - **Docker 部署（2026-10-29，TODO 92）**：`docker/Dockerfile`（node:22-alpine、非 root、`/app/data` 卷、`/api/version` 健康检查）+ 根目录 `.dockerignore`（文档 / 数据不进镜像；必须留在构建上下文根）+ `docker/docker-compose.yml`（8080 映射、`../data` 挂卷、build context 指仓库根、ORIGIN_TOKEN 环境位）。docs/DEPLOY.md 增「方式三 · Docker 部署」。注意：本机无 Docker，**镜像构建与容器冒烟未实际执行**，首次在目标机构建时若遇 COPY 路径问题按实际仓库布局微调。- **兑换入口下架（2026-10-28，TODO 89）**：相关面板 / 绑定 / 函数已摘除，客户端不再调用。
- **背包扩容（2026-10-28，TODO 88）**：`bagCap()` = 100 + `state.bagExtra`（每张「乾坤扩容符」+20，`BAG_EXTRA_MAX` 200 封顶即 300 格）。道具计数 `state.bagTokens`（≤99）；掉落钩子 `rollBagToken(kind)` 挂开箱 / 战斗胜利 / 探幽过层三处，概率常量集中在 `BAG_TOKEN_CHANCE`（1/15000、1/3500、1/2000，调概率只动它）。使用入口在背包标题按钮（`bagExpandBtn`，paintBag 刷可见态；上限 / 无符时点击会被拒绝并强制刷新按钮）。注意：容量收缩（测试改档）时已有物品不强制分解，只是无法再拾新装备。：header 两枚 `realm-badge` 同款徽章——战力 / 灵石；`paintResources()` 挂在 render 尾部（100ms 节流），灵石走 sig 缓存只在变化时重绘，战力每帧 `totalPower()` 直刷。要加回其他货币：index.html 照抄一枚 realm-badge div + paintResources 加一行。
- **日常标签（2026-10-28，TODO 84）**：顶部第 1 个标签「日常」（`data-page="richang"`，默认落地页）——签到 / 日常 / 周常 + 自闲趣迁入的黑市（含赌石）与成就（panel-wide 垫底）；闲趣只剩洞府 / 图鉴 / 灵宠 / 道侣。面板 id 与渲染函数零改动，纯 DOM 迁移。
- **设置标签页（2026-10-28，TODO 83）**：顶部第 6 个标签「设置」（`data-page="set"`）收拢音效（muteBtn/volumeSlider）、存档管理（导出/导入/重置）；新增**游戏字号**（`state.fontScale` 0.85–1.25 步进 0.05，`document.body.style.zoom` 全页缩放，A±/重置）与**明暗主题**（`state.theme`，暗=默认；明=羊皮纸风，`body.theme-light` 类 + CSS 变量覆盖 + 关键硬编码面色覆盖：panel/modal/top-tabs/bar/行卡/头像/输入框）。两设置随存档持久化，`start()` 启动即应用。明色主题走的是「变量 + 重点面」覆盖，深色硬编码的边角（如图鉴小签、部分渐变文字）可能仍有低对比处，验收以实际页面为准。
- **页脚版本号（2026-10-28，TODO 82）**：`GET /api/version`（公开、读 package.json 一次常驻内存），页脚 `#gameVersion` 启动时拉取显示「版本 v1.0.0」；版本单一来源是 package.json，升版改它即可。
- **顶部用户区（2026-10-28，TODO 81）**：道号 chip 与退出登录按钮从页脚移到 header 右侧（`.user-area`，flex `margin-left:auto`，窄屏整行右对齐）；元素 id 未变，`paintUserChip` / logoutBtn 监听零改动。
- **故事模式跨卷解锁（2026-10-28，TODO 80）**：`storyStateOf` 收紧——卷内仍按关顺序解锁，跨卷首关需**上一卷全部关卡通关**（原规则只看境界）；锁定文案区分「先通过上一关」（卷内）与「通关上一卷全部关卡」（跨卷）。renderStory 的锁定原因分支与 storyStateOf 规则要同步改。
- **体检记录（2026-10-28，TODO 76）**：修了 4 处——① 盟妖王 `guild_boss` 主键是 guild_id、建行用 `ON CONFLICT DO NOTHING`，换日后旧行永驻（永远「已伏诛」），已改为带 `WHERE day != excluded.day` 的 upsert 换日重置；② PvP 加对位日限：同一对手每日 ≤3 场（`pvpVsCount`），堵双号互刷天梯分；③ `pvpFight` 里 byId(targetId) 重复查询合并；④ 客户端 `worldActivate` 加 15 秒 TTL（反复切页不再 5 连发请求）、盟任务日志的贡献数改读任务配置不再硬编码。复核结论：social.js 全同步无 await，单进程内查-判-写序列无竞态；写接口全部预编译语句无注入；客户端新面板所有用户名/盟名/公告/错误提示都走 esc()/textContent，无 XSS 路径；js/css 静态缓存已是 no-cache（TODO 72）。性能：persist 由 3 秒节流兜底，快照计算开销可忽略；`/api/pvp` 候选匹配 `ABS(rating)` 全表扫在用户量大后是首个优化点。

### 服务端校验强化（2026-10-31：增速账本 + 战斗复算 + 余额校验）

目标：绕过前台按钮 / 改内存 / 改存档刷出的非法收益与非法结果，在服务端被拦截。三道防线：

- **增速账本（`server/economy.js` + `save_ledger` 表）**：`saves.js` 每次收档，与上次入库快照（账本行：stones / totalStones / dustTotal / opens / exp / petTickets / ascensions / immortal / power / towerCleared / stageCleared / endlessBest / wildMax / updated_at）比对：
  1. **单调性**：累计计数器与进度字段不得回退（防「洗基线」；exp / stones 除外——突破 / 飞升 / 花费合法向下）；
  2. **开箱增速**：Δopens ≤ elapsed×20×1.2 + 2000（`interval()` 下限 0.05s）；
  3. **灵石收益包络**：单开上界（按存档自身字段推最坏：gainLv / realm / asc / immortal / 穿戴六件重算战力 / 图鉴 / 灵宠 / 聚灵阵，杂乘区常量 250 兜底）×Δopens + 战斗项（≈1000×战力×1.25^仙位×elapsed×3 场/s）+ 5e7/天杂项 + 兑换码授权收益（`redeem_log` 窗口内精确计入）；
  4. **余额跳变**：Δstones ≤ ΔtotalStones + 杂项（防「只顶余额不改累计」；花费 / 负债向下不受限）；
  5. **仙位 / 轮回限速**：与可支配灵石挂钩（入仙界逐级 ×5 灵石、飞升得点 = √(灵石/1e8)），刷不出灵石就快不了；
  6. 碎屑 / 招募券 / 修为宽松包络兜底。
  违规整档 **400 拒收**（`{error:'存档增速异常，已保留上次云端进度'}`），云端停在最后合法档；无账本行（首档 / 存量玩家迁移）以当档种入基线不回溯。**推论：导入旧档回滚会被拒收**（防重领一次性奖励），属设计内。前端 `flushCloud` 对 400 丢弃本份待推档并 10 分钟节流提示一次，不再 5 秒死循环重试。
- **战斗复算（`server/battle.js`）**：`simulateBattle` / `bossEnemyOf` 与 game.js 同源移植（**客户端公式改动必须同步此文件**）。`/api/pvp/fight` 胜负、`/api/boss/hit` 与 `/api/guild/boss/hit` 伤害一律服务端复算，客户端上报的 `win` / `damage` 不采信；PvP 响应新增 `win` 字段。同批修复存量口径漂移：客户端 `persist()` 打包的字段名是 `pvpSnap`，服务端 `syncPowerScore` 一直在读 `data.pvp`——真客户端快照从未入库过（`saves.js` 现两处字段名都接受）；存量账号快照为 NULL 时打 PvP 会 400「战斗快照异常」，随下次存档上传（约 5 秒）自愈。
- **灵石余额校验（`save_ledger.stones`）**：`/api/pvp/buy`（1 万）、`/api/guild/create`（5 万）、`/api/guild/donate`（金额）严格足额才放行（无账本行按 0 计，**刻意不留余量**——实测 1500 灵石 + 10 万余量会放行 5 万立盟；账本约 5 秒一档的滞后只会让「刚赚就花」偶发被拒，客户端不预扣、可重试）。

局限（明示）：个人资产仍是客户端权威，增速包络在中后期（战力 / 仙位放大下）会放宽到接近存档量级天花板——账本拦的是「与自身进度完全脱节的注入」与洗基线，不承诺拦截贴着自身能力包络内的小幅作弊；包络口径调整只动 `server/economy.js` 顶部常量。

### 复审加固（2026-10-31 当日第二轮：审计发现修复）

全量复审（两个审计方向 + 19 场景单测 + curl 链路 + 浏览器冒烟）后修复，均已回归验证：

- **砖号级**：`save_ledger` 大数值列（stones / total_stones / dust_total / opens / power）改 **REAL**——node:sqlite 读 INTEGER 列 >2^53 直接 RangeError，一次满档推送就能把云存档与所有消费接口打成永久 500（实测复现）。`openDb` 带**自动迁移**（旧 INTEGER 表在 SQL 内 CAST 重建，孤儿行丢弃防外键炸启动，迁移必须排在 SCHEMA 之后——账本外键引用 users）。妖王伤害在 `power×300` 钳制外再加 **1e15 硬顶**，防伤害值超 2^53 砖全服 BOSS 面板；快照校验补 hp 字段。
- **首推种子校验**：注册 1 小时内且无账本行的首推，`totalStones>5e7 / opens>2e5 / immortal>0 / ascensions>0 / 装备战力>2e5` 等 any 越界直接 400——堵「手写 localStorage / 登出不清档继承旧大号 / 直调 API 一次推满档」三条种基线洗白线（冒烟实测复现串号拒收）。老号迁移（created_at 早）不受影响。
- **离线额度改 elapsed 口径**：离线开箱额度 = `elapsed×12 + 豁免`，**整份 4h 额度（OFFLINE_OPENS）只发给种基线后的第一次校验推**（`save_ledger.grants` 列，用后即清）——客户端调钟伪造离线（真实 10s 报 4h）被堵；豁免是一次性设计，残口 = 新号首小时内一次性 +1.4e7 石（记录接受）。asc/immortal 删除与灵石无关的每推保底（原 3 分钟 curl 可拉满），改精确配额：飞升 `2√(pot/1e8)`、入仙界 `⌊log5(4·pot/1e8+1)⌋`。
- **自报战力一致性**：`state.power ≤ max(5000, 装备重算分×2500×(1+0.08×asc))`——空装直写 9e15 战力刷榜单 / PvP 快照 / 妖王钳制基数的路线封死（realPower 是乘法结构，服务端按装备分锚定）。战斗包络基数另加 `min(包络战力, 账本战力×10 + 5e9)` 帽，防单推用合法顶配装备把包络从零顶爆。
- **余额校验改原子扣款**：`spendLedger()`（`UPDATE ... WHERE stones >= ?`）替代只查不扣——原样同一笔账本灵石可在推送滞后窗内重复消费（curl 连打加购 10 次零成本）。客户端扣的 donate `accepted` 与服务端扣减口径一致，推送 `dStones` 向下不触发跳变。
- **客户端奖励口径统一**：openBox / 世界与盟妖王讨平奖 / 盟任务 / 贡献商店 / 红尘录 / 拆宝石等 8 处改走 `addStones()/addDust()`——原先只加 `stones` 不加 `totalStones` 的路径既丢周/时辰增益、又触发云端「余额跳变」误拒（跳变规则另加 2e6 绝对底兼容旧客户端）；openBox 改 addStones 顺带修复「灵石周 +20% 对主收益路径无效」的平衡 bug。
- **登出清本地档**：登出置 `authSignedOut` 标志停掉 persist / 关页兜底（导航触发 hidden 会把清掉的档写回——实测踩过），清 SAVE_KEY / TAB 锁 / OPFS 备份，堵同浏览器换账号串号。OPFS 恢复分支改「补结算差额」防同一次冷启动双份离线收益。
- **杂项**：flushCloud 对 429/5xx 保留 pending 重试（只有校验类 400/422 丢弃）、空错误体也给通用提示；`redeemSince` 改 LEFT JOIN（删码后已兑奖励仍计入授权）；store 三步写包事务；立绘 aria-label 补 esc（昵称白名单本就挡死注入，消灭 latent）；导出文案改 .lxsave。

## 11. 给下一个开发工具的工作约定

- 中文文案；原创素材；不动 `lingxia_idle_v1` 兼容性（新增字段先 `defaults()`，校验进 `load()`）。
- **主角名展示（2026-10-31 用户指定）**：凡展示「林小凡/小凡」的地方（故事对白/说话人/人物志/卷简介/心魔敌名/战斗弹窗玩家名）一律走 `withPlayerName()` 替换为玩家昵称（`playerName()` = 服务端显示名，未改昵称即登录道号，兜底「林小凡」）。**故事数据原文（STORY 数据、STORY_CAST、foe.name）保持原名不动，只在渲染点替换**；`paintPlayerName()` 负责红尘录简介、战斗弹窗与人物志的刷新（人物志要清 `panelSigs.story` 强制重绘），改名 handler 与 `start()` 各调一次。
- 控制台调试钩子：`LX.state()`（当前状态）、`LX.stats()`（玩家战斗属性）、`LX.open(n)`（批量开箱）、`LX.offline()`（手动触发离线结算，测离线巡猎用），便于浏览器实测。
- 改完跑 `node --check game.js`，再用浏览器刷新 `http://127.0.0.1:8099/` 看控制台。
- 测试时**不要**清 `localStorage`——里面带着能进中后期内容的测试档。
- 优先改数值表（§4 那些常量），玩法逻辑尽量只动集中点（`playerCombatStats` 出口等）。
- 本文档与 README.md 需要随大改同步更新；README 是玩家向（运行/玩法/部署），本文件是开发者向（数值/schema/路线图）。
