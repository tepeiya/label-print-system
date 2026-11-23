# LabelFlow 后端镜像（API + Worker 共用同一个镜像，靠 command 区分）
# 用法：docker compose build api
#
# 为什么不是 `nest build`：@nestjs/cli 的 build 依赖 @nestjs/schematics，
# 本项目未安装该包，`nest build` 会直接抛 CollectionCannotBeResolvedException。
# 构建走 `tsc -p tsconfig.json`（rootDir=. → 产物在 dist/src/main.js、dist/worker.js）。

# ---------- 依赖层 ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
# 原生依赖（@bwip-js/node 等）可能需要编译工具链；仅在需要时使用
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---------- 构建层 ----------
FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
COPY core ./core
COPY printer ./printer
COPY worker.ts ./
RUN pnpm build && test -f dist/src/main.js && test -f dist/worker.js

# ---------- 运行层 ----------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate \
    && apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 10001 labelflow
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod && pnpm store prune
COPY --from=build /app/dist ./dist
USER labelflow
EXPOSE 3200
# 默认跑 API；worker 服务在 compose 里用 command 覆盖
CMD ["node", "dist/src/main.js"]
