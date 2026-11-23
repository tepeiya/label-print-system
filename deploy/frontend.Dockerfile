# 前端镜像模板（console / platform / pda 共用，靠 APP 参数选目录）
# 用法：docker build -f deploy/frontend.Dockerfile --build-arg APP=console .
#
# 为什么需要它：三个前端此前只能 `vite dev` 跑（baseURL 写死 /api/v1，靠 vite proxy），
# 生产没有任何入口。这里构建静态产物 + nginx 反代 /api 到 api:3200。

ARG APP=console
FROM node:22-bookworm-slim AS build
ARG APP
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo/apps/${APP}
COPY apps/${APP}/package.json apps/${APP}/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/${APP}/ ./
RUN pnpm build

FROM nginx:1.27-alpine AS serve
ARG APP=console
COPY deploy/nginx/frontend.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/${APP}/dist /usr/share/nginx/html
EXPOSE 80
