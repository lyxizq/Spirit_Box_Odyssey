# DEPLOY · 宝塔 + 腾讯 EdgeOne 部署指南

目标架构：**玩家 → EdgeOne 边缘（HTTPS）→ 源站服务器（Node 服务端，端口 8080）→ SQLite（`data/game.db`）**。源站可用宝塔直装（阶段 A）或 Docker 容器（方式三）任选其一。

关键原则：
- 游戏端口**不对公网开放**，云安全组只放行 EdgeOne 的回源 IP 网段（防直连、防伪造代理头绕过限流）；
- 服务端监听所有网卡（`0.0.0.0`），来源控制完全交给安全组，不要指望绑 127.0.0.1；
- 服务端已自动识别 EdgeOne 的 `EO-Connecting-IP` 头（取不到再取 XFF 末位），IP 限流在 EdgeOne 架构下开箱即用。

---

## 阶段 A · 宝塔侧安装游戏

### A1. 安装 Node 运行时

1. 宝塔面板 → 软件商店 → 搜索「**Node.js版本管理器**」→ 安装；
2. 打开版本管理器 → 安装 **v24.x**（v22.13+ 也可以；**不要用 22.5–22.12**，那区间需要额外加 `--experimental-sqlite` 参数；< 22.5 直接跑不起来，`node:sqlite` 不存在）；
3. 如有「设为默认版本」，切到它。

### A2. 上传代码

任选其一：

```bash
# 方式一：git 拉取（推荐，更新方便）
cd /www/wwwroot
git clone <你在阿里云 Codeup 的仓库地址> lingxia
# 私有仓库按提示输 Codeup 账号密码，或在 Codeup 配部署密钥
```

方式二：本地打包 zip → 宝塔「文件」上传到 `/www/wwwroot` → 解压为 `lingxia`。

注意：
- **不需要** `npm install`（服务端零第三方依赖）；
- **不需要** 上传 `data/` 目录——数据库首次启动自动生成，且它本来就在 .gitignore 里。

### A3. 创建 Node 项目

宝塔 → 网站 → **Node项目** → 添加Node项目：

| 配置项 | 填写 |
|---|---|
| 项目目录 | `/www/wwwroot/lingxia` |
| 启动方式 | 运行脚本 `start`（package.json 已配好 `node server/index.js`）；老界面则启动文件选 `server/index.js` |
| Node 版本 | v24.x |
| 端口 | `8080` |
| 运行用户 | `www` |
| 开机启动 / 进程守护 | 勾选 |

想改端口（比如 3000）：在项目的**环境变量**里加 `PORT=3000`，同时把上面「端口」字段改成同一个值（面板的端口字段只用于展示与外网映射，服务端实际监听由 `PORT` 决定）。数据库路径同理可加 `DB_PATH=/your/path/game.db` 覆盖。

老版本宝塔没有「Node项目」功能时，用 **PM2管理器** 替代：添加项目 → 启动文件 `/www/wwwroot/lingxia/server/index.js` → 项目名 `lingxia` → 端口 `8080`。

### A4. 本机验证

宝塔终端：

```bash
curl -I http://127.0.0.1:8080/
# 期望：HTTP/1.1 302，Location: /login.html —— 未登录被门禁拦下即正常
ls /www/wwwroot/lingxia/data/
# 期望：出现 game.db（及 -wal / -shm）
```

日志在 Node项目面板的「日志」里看，服务端错误带 `[server]` 前缀。

### A5. 此时的安全组状态

**先什么都不要放行**——8080 保持公网不可达，等阶段 B 拿到 EdgeOne 回源网段后按网段放行。

---

## 方式三 · Docker 部署（可选，替代阶段 A）

不想在宝塔装 Node、或想用容器统一管理时，用 Docker 跑源站（仓库已带 `docker/Dockerfile` / `docker/docker-compose.yml` / 根目录 `.dockerignore`——它必须留在构建上下文根，Docker 只认那一处）。EdgeOne 侧配置（阶段 B）不变，回源仍指向本机 8080。

### D1. 安装 Docker

宝塔 → Docker（新版宝塔自带）；或官方脚本：

```bash
curl -fsSL https://get.docker.com | bash
systemctl enable --now docker
```

### D2. 构建并启动

```bash
cd /www/wwwroot/lingxia        # 项目目录（git clone / git pull 到的最新代码）
docker compose -f docker/docker-compose.yml up -d --build   # 首次构建 + 启动；以后更新代码后重跑即滚动升级
docker compose -f docker/docker-compose.yml logs -f         # 看启动日志
```

不用 Compose 的等价手动命令：

```bash
docker build -f docker/Dockerfile -t lingxia:latest .
docker run -d --name lingxia --restart unless-stopped \
  -p 8080:8080 \
  -v /www/wwwroot/lingxia/data:/app/data \
  lingxia:latest
```

### D3. 要点

- **数据持久化**：SQLite 落在宿主机 `data/`（Compose 已挂卷 `../data`），容器删除 / 升级不丢数据；备份照旧打包 `data/` 目录（见「日常运维」）；
- **环境变量**：`PORT` / `DB_PATH` / `ORIGIN_TOKEN` 写在 Compose 的 `environment`（`ORIGIN_TOKEN` 用于 EdgeOne 锁源，改了记得 EdgeOne 规则引擎同步）；
- **时区**：Compose 已设 `TZ=Asia/Shanghai`，页脚服务器时间与每日重置（签到/日常/竞技场/妖王）都按这个时区；镜像已装 `tzdata`（alpine 基础镜像不带，不装则 TZ 不生效退回 UTC）。改 TZ 后 `docker compose -f docker/docker-compose.yml up -d` 自动重建容器即生效（无需 --build）；
- **非 root 运行**：容器内以 node 用户跑，镜像基于 `node:22-alpine`（`node:sqlite` 内置，无需 npm install）；
- **健康检查**：内置 `HEALTHCHECK` 打 `/api/version`，`docker ps` 的 STATUS 列可见 healthy；
- **升级**：`git pull && docker compose -f docker/docker-compose.yml up -d --build`，秒级重建，数据在卷里不受影响；
- 首次构建需要能访问 Docker Hub（或为 node:22-alpine 配镜像加速）。

### D4. 验证

```bash
curl -I http://127.0.0.1:8080/          # 期望 302 → /login.html
curl http://127.0.0.1:8080/api/version  # 期望 {"version":"1.0.0"}
ls data/                                # 期望出现 game.db（容器写入宿主机卷）
```

## 阶段 B · EdgeOne 配置

> 前提：域名已完成 ICP 备案（用中国大陆加速节点必须有备案；只选「全球可用区（不含中国大陆）」可不备案）。个人项目可以用 EdgeOne 免费版套餐。控制台 UI 迭代较快，个别入口名称以实际界面为准，官方接入文档：<https://edgeone.ai/zh/document/54765>。

### B1. 接入站点

1. 腾讯云控制台 → **EdgeOne** → 开通（选套餐）→ 添加站点，填你的主域名（如 `example.com`）；
2. 接入方式二选一：
   - **NS 接入**（推荐，全托管）：到域名注册商处把 DNS 服务器改成 EdgeOne 分配的两个 NS 地址，之后解析记录直接在 EdgeOne 里管；
   - **CNAME 接入**：保留原 DNS，稍后给 `game` 子域加一条 CNAME 指向 EdgeOne 分配的地址即可。

### B2. 创建游戏加速域名

站点内 → 域名服务 → 域名管理 → 添加域名（如 `game.example.com`）：

| 配置项 | 填写 | 说明 |
|---|---|---|
| 源站类型 | IP 源站 | 填服务器公网 IP |
| 源站端口 / 回源端口 | `8080` | EdgeOne 支持自定义回源端口（默认 HTTP 80 / HTTPS 443），必须与游戏端口一致 |
| 回源协议 | HTTP | 证书终结在边缘，边缘到源站走内网直连 HTTP 即可 |
| 回源 HOST | `game.example.com` | 保持默认即可 |
| 加速区域 | 按备案情况 | 中国大陆 / 全球 |
| IPv6 访问 | 按需 | 开了也不影响源站 |

保存后 EdgeOne 分配一个 CNAME 值。

### B3. 解析生效

- NS 接入：在 EdgeOne 的 DNS 记录里加 `game` → CNAME → 分配的 CNAME 值；
- CNAME 接入：去原 DNS 服务商加同一条记录；
- 验证：`nslookup game.example.com`（或 `dig`）返回 EdgeOne 节点即生效；控制台域名状态变「已生效」。

### B4. HTTPS

1. 域名管理 → `game.example.com` → **HTTPS 配置**；
2. 申请免费证书（EdgeOne 提供免费证书一键申请）或上传自有证书；
3. 开启「**强制 HTTPS**」；
4. 客户端走 HTTP/3 时 EdgeOne 回源 Proto 记为 `quic`，服务端已按安全连接处理，Cookie 会正确加 `Secure`。

### B5. 缓存与防护

- **缓存**：默认「遵循源站」即可，不用配规则。服务端已带好头：API 全部 `no-store`，HTML / `game.js` / `styles.css` 全部 `no-store`（完全不缓存——页面、脚本与样式必须同版本，边缘留存任何一份旧文件都会版本错配直接报错），图片类资源 1 小时。若曾在 EdgeOne 配过自定义缓存规则，请务必排除这三类文件或改为「遵循源站」；
- **Web 防护（可选加强）**：EdgeOne 的 Web 保护 / Bot 管理里可加全站限频（如单 IP QPS 阈值），与服务端自身限流形成两层防线；
- 无需为客户端真实 IP 做任何配置：EdgeOne 回源默认携带 `X-Forwarded-For` 与 `EO-Connecting-IP`，服务端自动识别。

### B6. 锁定源站（必做，安全关键）

不锁源的后果：按 IP 的防爆破 / 防刷可被伪造请求头绕过，源站绕过 EdgeOne 防护直接暴露挨打。二选一，或两者都做：

**路线一：EdgeOne「源站防护」（付费套餐）**

1. EdgeOne 控制台 → 站点详情 → **安全防护 → 源站防护** → 开启，页面展示回源 IP 网段（IPv4/IPv6）；
2. 云服务器安全组入站规则：放行 TCP 8080，来源 = 这些网段 CIDR（逐条加），**不要**放行 0.0.0.0/0；宝塔系统防火墙若启用同步放行；
3. 网段不定期变更（约 3–6 个月一次），EdgeOne 提前 14/7/3/1 天发通知，收到后 14 天内更新安全组；
4. 免费版套餐**没有**这个入口，走路线二。

**路线二：回源密钥鉴权（免费版可用，服务端已内置支持）**

1. 自己生成一个 32 位以上随机串，例如终端执行 `openssl rand -base64 32`；
2. 宝塔 Node 项目 → 环境变量添加：`ORIGIN_TOKEN=<刚生成的串>` → 重启项目；
3. EdgeOne 控制台 → 规则引擎 → 添加规则：匹配条件选域名等于 `game.example.com`（或所有请求），执行动作选「**修改 HTTP 请求头**」→ **回源请求头**新增 `X-Origin-Token` = 同一个串 → 保存发布；
4. 效果：服务端对所有非本机请求校验该头（`timingSafeEqual` 防计时猜解），对不上直接 403；攻击者不知道密钥就无法直连源站伪造流量。本机 `curl 127.0.0.1:8080` 豁免校验，运维不受影响；
5. 若规则引擎里找不到「修改 HTTP 请求头」动作（套餐能力差异），升级套餐或提工单咨询；密钥头方案与安全组网段放行可以叠加，双保险更稳。

---

## 阶段 C · 验收清单

1. 浏览器打开 `https://game.example.com` → 自动跳到登录页（登录页样式正常、无白屏）；
2. 注册账号 → 进入游戏 → 开几箱让灵石变化；
3. **刷新页面** → 灵石数保留、顶栏道号还在（云存档恢复生效）；
4. 退出登录 → 重新登录 → 进度无损；
5. 换个浏览器 / 手机登录同一账号 → 进度自动同步（证明走的是云端正本）；
6. 切到「天下」页 → 战力榜能看到自己的道号，妖王/仙盟面板加载无报错；
7. 页脚显示版本号（读源站 `package.json`）；EdgeOne 控制台看实时访问日志有回源记录，宝塔 Node项目日志无 `[server]` 报错。

---

## 日常运维

- **更新代码**：宝塔终端 `cd /www/wwwroot/lingxia && git pull` → Node项目点「重启」。零构建、秒级生效；
- **数据库备份**：宝塔 → 计划任务 → Shell 脚本（每日）：

  ```bash
  tar czf /www/backup/lingxia_db_$(date +%F).tar.gz -C /www/wwwroot/lingxia data
  find /www/backup -name 'lingxia_db_*' -mtime +14 -delete
  ```

  （WAL 模式下 `-wal`/`-shm` 一并打包更稳；恢复时停服解压回 `data/` 再启动。）
- **看日志**：Node项目面板「日志」；EdgeOne 控制台「日志服务」可查全量访问与攻击拦截记录。

## 常见问题

| 现象 | 排查 |
|---|---|
| EdgeOne 报 502/522 | 先在宝塔终端 `curl -I http://127.0.0.1:8080/` 确认服务活着；再查安全组是否对 EdgeOne 网段放行了 8080；再查回源端口是否 8080 |
| Node项目启动失败，日志见 `node:sqlite` 相关报错 | Node 版本过低，换 v24 |
| Docker 启动即崩，日志 `disk I/O error`（errcode 778） | SQLite 的 WAL 在老内核 / SELinux / 特殊挂载上建 `-wal`/`-shm` 失败。两步修：① 挂载加 `:z` 重跑（SELinux 自动打标签）；② 环境变量加 `-e DB_JOURNAL=delete` 退回回滚日志（单进程服务无并发损失）。详见下方「CentOS 7 + Docker」 |
| 所有玩家都提示「尝试过于频繁」 | 说明 IP 识别异常：检查是否在 EdgeOne 前又加了一层代理（架构变了取值逻辑要复核） |
| 登录后刷新又掉线 | 确认访问的是 HTTPS 且强制跳转已开（`Secure` Cookie 只在 HTTPS 下发送） |
| 控制台「调试钩子」想在线上用 | 调试钩子仅在本机（127.0.0.1 / localhost）挂载，线上无入口——这是有意设计，防止任何人开控制台改状态刷云端数值 |

## CentOS 7 老系统部署（内核 3.10 / glibc 2.17）

CentOS 7 的 glibc 是 2.17，Node 官方二进制 v18+ 要求 glibc ≥ 2.28，宝塔版本管理器会直接拒绝安装。三条路，**优先考虑重装系统**（CentOS 7 已于 2024-06 EOL 无安全补丁，游戏要存账号口令，不建议长期跑）：

1. **重装系统（推荐）**：云控制台 → 重装系统 → OpenCloudOS 9 / Rocky 9 / Ubuntu 22.04+ → 重装宝塔，按本文档原样走，零改动；
2. **Docker 跑官方镜像**（不动系统）：CentOS 7 可装 docker-ce，数据库仍在宿主目录可备份。注意两点：`-p` 发布端口走 iptables DOCKER 链**会绕过宝塔防火墙**，锁源务必做在云安全组；老内核上 WAL 可能报 disk I/O error（见上方常见问题），挂载加 `:z` 并设 `DB_JOURNAL=delete`：

   ```bash
   docker run -d --name lingxia --restart unless-stopped \
     -p 8080:8080 \
     -v /www/wwwroot/lingxia:/app:z \
     -w /app \
     -e ORIGIN_TOKEN=<回源密钥> -e DB_JOURNAL=delete \
     node:24-alpine node server/index.js
   ```

3. **社区 glibc-217 构建（应急过渡）**：[unofficial-builds](https://github.com/nodejs/unofficial-builds)（Node.js Build 工作组维护）提供 `linux-x64-glibc-217` 变体（v24.x / v22.13+ 可用，`node:sqlite` 免参数）：

   ```bash
   cd /usr/local/src
   wget https://unofficial-builds.nodejs.org/download/release/v24.22.1/node-v24.22.1-linux-x64-glibc-217.tar.xz
   tar -xf node-v24.22.1-linux-x64-glibc-217.tar.xz
   ln -sf /usr/local/src/node-v24.22.1-linux-x64-glibc-217/bin/{node,npm,corepack} /usr/local/bin/
   node -v && node -e "require('node:sqlite'); console.log('node:sqlite OK')"
   ```

   宝塔版本管理器管不到手动装的 Node，守护改用宝塔「进程守护管理器（Supervisor）」，命令填绝对路径。

