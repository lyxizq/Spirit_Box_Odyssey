# 本地单机版（纯本地网页 · 零服务端）

`local/` 目录是游戏的**纯本地单机版**：不需要 Node 服务端、不需要账号、不需要网络——整个服务端玩法层（战斗复算 / 灵宠 / 云来坊市 / 修炼 / 天下玩法 / 增速账本）打包进浏览器，在内存 SQLite（sql.js wasm）里运行，进度存 `localStorage`。**服务端版完全不受影响**，两版互不干扰。

## 怎么玩

**双击即玩**，两个入口任选，都不需要服务器：

- `dist/spirit-box-odyssey-local/index.html` —— 独立分发包（自己玩 / 发给别人）：`node scripts/pack-local.mjs` 生成 `dist/spirit-box-odyssey-local/`（自包含目录）与同名 `.zip`——GitHub Releases 上的本地版资产即此包；
- `local/index.html` —— 仓库内入口，直接复用仓库根的 game.js / styles.css / assets。

习惯用 http 调试也可以走静态服务器：仓库根 `python3 -m http.server 8080`，打开 `http://127.0.0.1:8080/local/index.html`。

注意：直接双击**仓库根**的 `index.html` 仍然是**服务端版**（无后端会拦下提示）。

## 架构（改代码前必读）

```
local/
  index.html            ← 由 scripts/build-local.mjs 从根 index.html 机械变换生成（勿手改！）
  login.html            ← 登出/断服导航的落地跳板（返回 index.html）
  local.css             ← 存档面板/横幅/遮罩样式（不碰游戏 DOM）
  local-bundle.js       ← 构建产物：boot/shim/persist/ui + server/*.js 服务端模块原样
  vendor/sql-wasm.js    ← sql.js 1.13.0 原样 vendor（MIT）
  vendor/LICENSE.sql-js.txt ← sql.js 的 MIT 许可文本（公开仓与分发包都必须随附）
  vendor/sql-wasm-b64.js← 构建产物：wasm base64 内联（file:// 双击免网络）
  src/                  ← 本地版源码（build 后打进 bundle）
    boot.js             ← 入口：Buffer 兜底 → sql.js 初始化 → 装配虚拟服务端 → 注入 ../game.js
    shim.js             ← fetch/sendBeacon 劫持 /api/*；WebSocket(/api/ws) 构造即抛（客户端自动走 HTTP 轮询回退）
    server.js           ← 路由（server/index.js 同面，去鉴权）+ 本地用户引导 + 显示名移植 + 整库导入
    node-stubs.js       ← node:sqlite(fs/path/url) 浏览器替身：DatabaseSync over sql.js（薄门面，export 后自动重编译）；fs 替身把内联词库交给 moderation.js
    http-util-shim.js   ← sendJSON 假 res 捕获 + SlidingWindow 原文复制
    persist.js          ← 整库 gzip→base64→localStorage；45 天流水裁剪；配额兜底；BroadcastChannel 多标签页守卫
    ui.js               ← 存档导出/导入面板 + 登出导航拦截（Navigation API，老浏览器自然降级跳走）
scripts/
  build-local.mjs       ← esbuild 打包 + wasm 内联 + 词库内联 + index.html 生成 + Node 测试入口
  test-local.mjs        ← E2E（--parity 加真实服务端形态对照）
  pack-local.mjs        ← 独立打包 dist/spirit-box-odyssey-local/ + 同名 zip（与部署包并排、同口径：产物名不带版本号、zip 内不套主目录）
```

关键设计约束：

- **服务端模块零改写**：`server/{saves,combat,pets,shop,cultivation,social,stamina,economy,battle,items,moderation,db}.js` 原样打包。浏览器侧只替换三个边界——db.js 的 node 内置依赖（插件改道 node-stubs）、http-util（sendJSON 捕获到假 res）、index.js 路由（本地重写）。**服务端玩法逻辑改动会自动同步到本地版**（重跑 build 即可），这是选 sql.js 而不是手写本地逻辑的根本原因。
- **屏蔽词库同一份**：`moderation.js` 启动时读 `server/lexicon/Vocabulary/*.txt`（按它自身所在目录解析）。浏览器没有文件系统，`build-local.mjs` 在构建期把这 10 个词库文件原文内联进 bundle，fs 替身按路径原样交出——两端启动同为 8115 词，显示名 / 盟名 / 盟公告的校验与真实服务端一致；词库目录缺失会让构建直接失败，不允许静默退回手写兜底词。改词库后重跑 build 即同步。
- **假人系统即多人本地化**：social.js 创建时 `ensureBots()` 播 24 个剑影（天梯常驻/PVP 就近补位），世界妖王血量按全服最高战力缩放，仙盟任务按单人可完成设计——单机「江湖感」零额外代码。
- **防作弊账本照常生效**：增速包络/单调回滚/灵宠 uid 水位/法宝账本真值在本地同样拒收（E2E 验证）。导入旧档回滚会被拒——**所以备份导出的是整库字节而非存档文本**（连账本一起迁走）。
- **客户端 game.js / styles.css 一字不动**：版本升级同步 = 直接复用仓库三件套，重跑 build-local 即可。

## 持久化与备份

- 进度 = `localStorage['lx_local_db_v1']`（`gz1:` 前缀 + gzip + base64 的整库字节），每次请求后防抖 1s 落盘 + pagehide/切后台强推。
- 游戏内左下角「存档」面板：导出备份文件 / 复制备份 / 导入备份（覆盖当前进度并重开）/ 清空本地数据。
- 备份 JSON 格式：`{type:'lx-local-backup', v:1, app, exportedAt, db:<base64 整库字节>}`；导入在 `DatabaseSync.importBytes` 里做文件头卫兵 + 结构一致性校验 + 事务内逐表搬移（临时关 FK），失败不影响当前库。
- 损坏档自动隔离到 `lx_local_db_v1.corrupt` 后全新开局（原档保留可人工抢救）。
- 多标签页同开会互相覆盖存档：BroadcastChannel 心跳侦测，第二个标签页会触发顶部横幅提示。

## 验证口径（改本地版代码后必跑）

```bash
node scripts/build-local.mjs          # 重新构建（产物入库）
node scripts/test-local.mjs           # A：虚拟服务端全端点扫（92 项）
node scripts/test-local.mjs --parity  # B：+ 真实服务端形态对照（spawn node server/index.js 临时库）
```

浏览器冒烟（重要改动时）：`python3 -m http.server` 后真机点验开箱/征战/天下/存档面板/刷新恢复/登出拦截。

**双击（file://）路径单独冒烟**：http 冒烟全绿不代表双击能开——URL 解析在两种协议下不同（如 `/../x` 在 http 下被根目录截断、file:// 下会真跳到上一级）。ZCode 内置浏览器打不开 file://，用无头 Edge/Chrome 实跑：临时 `--user-data-dir` + `--virtual-time-budget=15000 --dump-dom`，检查 DOM 里有存档按钮、`版本 v…`、服务器走针、显示名；同一个 profile 连开两次（中间改一次显示名）可验 localStorage 持久化。

## 已知边界

- 时区：`/api/version` 返回本机时区 → 「服务器时间」即本机时间，每日重置按设备本地日。
- 登出会 `location.replace('/login.html')`（绝对路径）：支持 Navigation API 的浏览器被拦截弹「继续修行」遮罩，页面不跳走；老浏览器会真实跳走——静态托管在域名根时落到包内 login.html 跳板自动返回，file:// 双击或托管在子目录时落到不存在的页面，重新打开 index.html 即可（进度不受影响）。
- file:// 下两个入口共享同一份 localStorage（浏览器把所有 file:// 页面算作同一个源）：仓库入口和分发包入口读到的是同一个存档。
- `sendBeacon` 关页兜底帧走异步 Blob 读取，极端情况下可能赶不上落盘——5 秒节流的常规推送兜底，无实际损失。
- 整库字节省内存（约 256KB 起，长期游玩裁剪后 << 1MB），localStorage 5MB 配额余量充足。
