# 灵匣纪元 · 零依赖 Node 服务端镜像
# 构建与运行：见 docs/DEPLOY.md「方式三 · Docker 部署」
FROM node:22-alpine

# node:sqlite 需要 Node ≥ 22.5（node:22 官方镜像均满足）
ENV NODE_ENV=production

# alpine 镜像不带时区库：compose 设 TZ=Asia/Shanghai 必须有它才生效，否则进程退回 UTC
RUN apk add --no-cache tzdata

WORKDIR /app

# 运行时文件：服务端 + 页面 + 静态资源（文档与测试目录不进镜像）
COPY package.json ./
COPY server ./server
COPY index.html styles.css game.js login.html login.js ./
COPY assets ./assets
COPY favicon.png favicon.svg cover.png cover.svg ./

# 数据目录挂卷持久化；以非 root 运行
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]

EXPOSE 8080

# 健康检查：版本接口（Node 22 自带 fetch）
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/version').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
