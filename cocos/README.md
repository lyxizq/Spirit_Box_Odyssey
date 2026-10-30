# cocos · 表现层脚手架（TODO 71）

承接后续微信 / 抖音小游戏适配的 Cocos Creator 3.8 项目骨架。**H5 正式版仍以仓库根的
`game.js`（单 IIFE）为准**；本目录只做表现层与接入层脚手架，不含玩法数值——数值逻辑
（战斗模拟、存档口径）从 `game.js` 同源移植，改数值以 H5 版为唯一上游。

## 用 Cocos Creator 3.8 打开

1. Dashboard → 导入本 `cocos/` 目录（首次打开 Creator 自动补 `.meta` 与
   `temp/tsconfig.cocos.json`，脚手架未预置 meta 属正常）；
2. `assets/scripts/` 下四个组件即为接入点：

| 文件 | 职责 |
|---|---|
| `GameApi.ts` | 服务端接入：登录/注册/会话、云存档读写、排行/竞技场/妖王/仙盟/兑换码，`credentials` 会话 Cookie 同 H5 |
| `SaveAdapter.ts` | 存档适配：本地 localStorage ↔ 云端按 `lastSeen` 取新合并，口径与 H5 `queueCloud` 一致 |
| `BattleSim.ts` | 战斗模拟：`simulateBattle` 的 TS 同源移植（回合制、暴击/吸血/破甲/减伤同公式） |
| `Main.ts` | 启动装配：探针 `/api/version` → 存档恢复 → 场景初始化的最小闭环示例 |

3. 小游戏端注意：微信/抖音环境无 `document.cookie`，`GameApi` 已把会话令牌做成
   可注入头（`sessionToken`），接各家 `request` 适配器时把登录返回的令牌带上即可。

## 服务端

零依赖 Node 服务端（仓库根 `server/`）原样复用，接口清单见 `docs/DEPLOY.md` 与
`server/index.js` 路由表；本地调试 `npm start` 后 `GameApi` 的 `baseUrl` 填
`http://127.0.0.1:8080`。
