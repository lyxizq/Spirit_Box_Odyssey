# HANDOFF · 交接与路线图

> 面向下一个开发工具 / 下一位开发的交接文档。读完本文应能继续开发而不需要重新通读全部代码。
> 最后更新：2026-10-27（三套秘境征战 + 战斗弹窗完成时点；同日扩充路线图：新增收集与留存系统、开发排期）。

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
  | `HANDOFF.md` | 本文档 |
- **运行**：`python3 -m http.server 8099` 后打开 `http://127.0.0.1:8099/`。测试通常用 8099 端口。
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

**实测进度参考**（当时测试用档）：闯关第 14 关、爬塔 21 层、野外 1–4 区清完、境界 4（元婴）、穿镇塔·玄鳞甲 +3 与凤凰羽扇。

## 3. game.js 代码地图

单文件 IIFE。按区块阅读：

| 区块（大致行号） | 内容 |
|---|---|
| 顶部常量 `SAVE_KEY`…`MAX_TRAIN`（≈10–39） | 全局数值旋钮 |
| `MODES` / `MILESTONES` / `SETS` / `TRAININGS` / `TROPHIES`（≈22–96） | 秘境征战配置表 |
| 怪物与区名 `TOWER_MONSTERS`…（≈100–166） | 塔怪/塔主、章节、野外区 |
| `RARITIES` / `SLOTS` / `ITEM_NAMES` / `BASE_POWER`（≈168–255） | 掉落与装备基础 |
| `REALMS` / `REALM_COSTS` / `UPGRADES`（≈256–287） | 境界与升级线 |
| 工具函数 `$` / `emptyEquipped` / `defaults` / `persist` / `load`（≈288–490） | 存档 |
| 开箱与装备 `openBox` / `addItem` / `manualOpen` / 强化（≈600–960） | |
| 战斗区 `contentReq` / `isBoss` / `enemyFor` / `playerCombatStats` / `specialPower` / `makeSpecialItem` / `trophyGain`（≈410–600） | |
| 战斗结算 `currentLevel` / `simulateBattle` / `doBattle` / `upgradeTraining`（≈1035–1220） | |
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

## 5. 存档 Schema

`persist()` 直接 `JSON.stringify(state)` 存进 `lingxia_idle_v1`；`load()` 用 `Object.assign(defaults(), data)` 兜底，并逐项校验（详见 `load()`，结构错误字段会被重置修好 → **新增字段只要加进 `defaults()` 就自动兼容旧档**）。

```js
// defaults()
{
  stones, totalStones, exp, opens: Number
  realm, ascensions, speedLv, gainLv, luckLv: Number
  counts: Number[6]              // 六品质图鉴计数
  best: -1..5                    // 最高品质
  buffUntil, lastSeen: 时间戳     // 丹药、离线结算
  muted: Boolean
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
  autoHunt: Boolean            // 自动巡猎开关
}

// Item（背包与已穿通用）
{
  id, r: 0..5, slot: 'weapon'…'talisman', name, power, lv: 0..20,
  special?: true, setKey?: 'tower'|'stage'|'wild',
  source?: 同上, sourceLevel?: Number   // 掉落来源（专属件）
}
```

兼容要点（`load()` 内已实现）：旧档补齐缺失字段；包内/穿上的非法物品被剔除；专属件强制 r=5；`itemSeq` 取最大 id+1；`wildCleared` 去重排序。**不要**在这一层做破坏性迁移；新增字段一定要先加 `defaults()`。

**注意**：多标签页会互覆盖同一个 key（README 已提示玩家）；最近战报 `lastBattles` 仅在内存。

## 6. 战斗弹窗与 UI 事件

- `index.html` 关键节点：`#battleReport`（面板内战报）、`#battleModal`（弹窗）→ 内含 `#battleKicker/#battleRound/#battleArena/#battleLog/#battleResult/#battleActions` 等 id，`styles.css` 按 `.battle-*` 前缀组织。
- 手动挑战：调 `doBattle(uiMode)` → 若弹窗已开则直接 return → 模拟 → 结算 → `openBattleModal(战报)`。
- 弹窗动画按事件逐帧播放；「跳过动画」直接跳到结算页；关闭走按钮或点遮罩。
- 回看战报用 `lastBattles[uiMode]`（内存）。重开弹窗时会清掉残留 `.battle-damage` 元素；飘字水平位置带 ±10px 随机偏移减少遮挡。
- 自动巡猎：主循环里 `uiMode==='wild' && state.autoHunt && unlockedMode('wild')` 每 3 秒调 `doBattle('wild', {auto:true})`，受 450ms 冷却约束，减益：**战斗失败自动关掉 `autoHunt`**。
- 手动挑战会强制关闭 `autoHunt`（`if(!auto) state.autoHunt=false`）。

## 7. 测试情况

- 浏览器（Chrome 系）实测：三模式战斗、首通/再战、首领战、套装掉落与穿戴、战技升级、弹窗动画/跳过/回看/遮罩关闭、自动巡猎启停、连续手动战斗、离线弹窗。
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

## 9. 后续路线图（优先级已与「我」定好）

优先级顺序：**P1 词条/洗练 + 宝石 → P2 灵宠 + 洞府 → P3 无尽秘境 / Roguelike**。竞技场、世界 BOSS、排行等强社交玩法在接后端前不做（详见 §10）。

### P1 装备词条 · 洗练 · 宝石

设想：品质越高词条越多（天品 2 条、仙品 3 条）；词条池含攻击/生命/防御/暴击/吸血/破甲。
- 新增 `affixes`（Item 的新字段），`playerCombatStats` 里并入计算 → 玩家属性入口只有这一个函数，改起来很集中。
- 「洗练」用灵石重随机，可锁定 1 条；宝石开镶嵌槽（每件 1–2 孔）+ 分解得碎屑。
- 注意：旧存档没有 `affixes` —— 在 `load()` 里给缺词条的旧装备按品质随机补一次，否则属性不齐。
- README 的「后续可以加」里提到过袋子排序/部位筛选/对比箭头，可以趁手感顺一并做。

### P2 灵宠 + 洞府

- 灵宠：开箱概率掉「灵宠招募券」，养到一定亲密度参战（提供攻/血/被动）；先做 1–2 只就能接进 `playerCombatStats`。
- 洞府（崖居）：灵石池挂机升级（聚灵阵/药园/藏经阁），给全局百分比加成或离线效率提示。
- 存档侧需加字段（`pets`, `petIds…`, `caveXXX` 等），建议结构如 `state.pets = [{id, kind, lv}]`，照 §5 的 defaults + load 校验套路写。

### P3 无尽秘境 / Roguelike

- 无尽层爬塔模式（第 60 层后另起 `endless` 计数与乘区，随机词缀地层）；或限时 Roguelike 小副本（战斗间 3 选 1 神物 buff）。
- 数据/UI 都已在三模式框架外面（`MODES` 表可扩一个 `endless` 键），扩展成本不高。

### QoL（随时可以插队做）

- 背包排序 / 部位筛选 / 战力对比箭头；秘境「扫荡」与 `autoHunt` 同款免弹窗结算；「连续挑战」；战斗倍速按钮（播放倍率乘在动画 delay 上即可）。
- 微信/抖音小游戏适配、Cocos 表现层。

### 收集与留存系统（2026-10-27 新增，对应 TODO 1–5）

已入项目 TODO.md，排在 P1 之后、P2 之前做：

- **成就系统**：里程碑式成就（累计开箱 N 次 / 通关塔 / 集齐套装 / 最高品质等），达成发灵石、战利品或图鉴奖励；存档加 `achievements: { [id]: 1 }`，照 §5 的 defaults + load 套路补。
- **日常任务与签到**：按自然日重置（存 `lastDailyDate` 时间戳判断跨天），任务链给开箱/秘境日常目标，签到给递进奖励；注意与离线结算的 `lastSeen` 是两回事，别混用。
- **套装图鉴收集奖励**：按套装统计**曾获得**部件（分解也算，需要新增「曾获得」记录，现有 `state.counts` 只按品质计数），集齐 2/4/6 件给全局百分比加成；全局加成与战斗内套装效果（§4.7）是两条独立乘区，别互相顶替。
- **离线巡猎**：离线结算（OFFLINE_CAP 4h / 50% 效率）时若 `autoHunt` 开启，按时长与当前区胜率估算战利品与击杀数，复用 `wildKills` 的每 12 杀必掉逻辑；防刷上限同 OFFLINE_CAP。
- **音效扩展**：音量滑条（存 `volume` 字段）+ 突破、套装掉落、首领击败等关键事件音效，仍走 WebAudio `beep()` 合成，不引音频文件。

### 开发排期（2026-10-27 定）

1. **阶段一 · P1 装备词条 / 洗练 / 宝石**（本节 P1；改动集中在 `playerCombatStats` 出口与 `load()` 补词条）
2. **阶段二 · QoL 插队包**：背包排序/筛选/对比箭头、战斗倍速、扫荡、连续挑战（与词条系统同吃背包 UI 手感，紧随其后做）
3. **阶段三 · 收集留存包**：TODO 1–5（成就、日常签到、套装图鉴奖励、离线巡猎、音效扩展）
4. **阶段四 · P2 灵宠 + 洞府**（本节 P2）
5. **阶段五 · P3 无尽秘境 / Roguelike**（本节 P3）

PvP / 竞技场 / 排行 / 世界 BOSS 维持接后端前不做（§10）。

## 10. 后端 / 多人玩法约定

PvP、竞技场、排行榜、世界 BOSS、兑换码等需要后端。原则：
- 先把存档换成接口（`persist/load`），同步保留 `localStorage` 作离线缓存；
- 服务端校验战斗与掉落（防改数值），前端保留表现层；
- 合规提醒沿用 README：商用自担合规与内容审核。

## 11. 给下一个开发工具的工作约定

- 中文文案；原创素材；不动 `lingxia_idle_v1` 兼容性（新增字段先 `defaults()`，校验进 `load()`）。
- 改完跑 `node --check game.js`，再用浏览器刷新 `http://127.0.0.1:8099/` 看控制台。
- 测试时**不要**清 `localStorage`——里面带着能进中后期内容的测试档。
- 优先改数值表（§4 那些常量），玩法逻辑尽量只动集中点（`playerCombatStats` 出口等）。
- 本文档与 README.md 需要随大改同步更新；README 是玩家向（运行/玩法/部署），本文件是开发者向（数值/schema/路线图）。
