# LabelFlow MCP 入口镜像（Streamable HTTP 模式）
# 用法：docker compose build mcp / docker compose up -d mcp
#
# 要点：
#  - 这个容器**不接数据库、不接 Redis**，只连后端 API（AGENT_API_BASE）。坏了重启即可，不涉数据。
#  - 容器里只跑 HTTP 传输（stdio 由客户端本机拉起，进不了容器）。
#  - 镜像不带 TLS：生产必须在前面套一层反代（nginx / Traefik）做 https 与 /mcp 转发。

# ---------- 依赖层（含 devDeps：要 typescript 才能 tsc） ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------- 构建层 ----------
FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && test -f dist/http.js && test -f dist/index.js

# ---------- 运行层（只留 dist + 生产依赖，非 root） ----------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3300 \
    HOST=0.0.0.0 \
    AGENT_API_BASE=http://api:3200/api/v1
RUN useradd -m -u 10002 mcp
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
USER mcp
EXPOSE 3300
# 健康检查用 node 自带 fetch，不额外装 curl（镜像更小、攻击面更少）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3300)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/http.js"]
