# D0 验收记录：装得上

> 阶段：D0（`docs/24-delivery-plan.md` 第 2 节）
> 日期：2026-11-23
> 环境：Linux 容器，**无 docker daemon**；本地 PG 14.24 + Redis 6.0 做实库实证

---

## 1. 交付内容

| 文件 | 作用 |
|---|---|
| `backend/Dockerfile` | 多阶段构建（deps → tsc build → prod 运行层），非 root 用户，产物 `dist/src/main.js` / `dist/worker.js` |
| `deploy/frontend.Dockerfile` | console / platform / pda 共用模板，`--build-arg APP=console\|platform\|pda` |
| `deploy/nginx/frontend.conf` | 静态资源 + history 路由回落 + `/api` 反代到 `api:3200` |
| `apps/mcp-server/Dockerfile`、`.dockerignore` | MCP 入口镜像（多阶段，非 root，只留 dist + 生产依赖 29MB） |
| `deploy/nginx/mcp.conf` | MCP 反代片段：`/mcp` 透传 Authorization、`proxy_buffering off`（SSE）、读超时 3600s |
| `docker-compose.yml` | 重写：`db-init` 一次性建库 → `api`/`worker` → 三个前端；老 web 收进 `profiles: legacy`；2026-11-25 增 `mcp`（只依赖 api，3300） |
| `backend/.dockerignore`、`.dockerignore` | 排除 node_modules / dist / web vendor |
| `backend/scripts/db-manifest.txt` | **建库顺序唯一真源**（32 步） |
| `backend/scripts/db-init.sh` | 按清单执行；`--seed-demo` / `--dry-run` / `--verify-only` |
| `backend/scripts/db-verify.sh` | 缺表自检（对账 87 张表） |
| `backend/scripts/db-expected-tables.txt` | 期望表清单（从 DDL 抽取） |
| `backend/package.json` | `build` 改为 `tsc -p tsconfig.json`；新增 `start:prod` / `worker:prod` / `clean` |
| `README.md` §4 / §5 / §6 | 部署章重写，建库机制说明，进度表更新 |

---

## 2. 验收门结果

| # | 门 | 结果 | 证据 |
|---|---|---|---|
| 1 | 全新机器 `docker compose up -d` 5 分钟内可登录 | **未实证（无 docker daemon）** | 本环境无 docker/podman；镜像与编排为静态产出 |
| 2 | `down -v` 后重建仍通过 | **等价实证** | 本地 `DROP DATABASE` + 重建后 `db-init.sh` 从零跑通 32 步、87 表全命中（5s） |
| 3 | console `:5173` / platform `:5181` 能登录进菜单 | **等价实证（静态+反代）** | 独立 nginx 实例加载 `deploy/nginx/frontend.conf`：`/` 200、`/templates` 200（history 回落）、`POST /api/v1/auth/login` 201 取到 token |
| 4 | `pnpm build` 零报错产出 `dist`，`node dist/src/main.js` 能起服务 | **实证** | `tsc` 产出 256 个 js / 256 文件；`node dist/src/main.js` 监听 3200，`POST /auth/login` 返回 201 + `accessToken` |
| 5 | 建库顺序固化在 manifest、幂等、缺表检测返回 0 | **实证** | 连续 3 次重跑全绿；`--verify-only` 输出 `PASS: 期望 87 张表，实际 91 张（87 张业务表 + 4 张框架表），全部命中` |
| 6 | MCP 入口镜像可构建可运行（2026-11-25 补） | **等价实证（无 docker daemon）** | 按 `apps/mcp-server/Dockerfile` 三层分别执行：`npm ci` 98 包 2s；`tsc` 产出 `dist/http.js`/`dist/index.js`；`npm ci --omit=dev` 仅 29MB，`node dist/http.js` 起服务，`/health` 200，真实 `initialize`+`tools/list` = 29 工具 |

> **未实证部分须在真 docker 环境补验**（一条命令）：`docker compose up -d --build && curl -s -X POST localhost:3200/api/v1/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}'`
> 属于 `BLOCKED(缺 docker daemon)`，不是"已验证"。

---

## 3. 建库过程中真实暴露并修掉的 4 个缺陷

这 4 个都是**照文件头注释手工排顺序必然踩到**的坑，说明此前"按顺序执行"只是纸面约定：

| # | 现象 | 根因 | 处置 |
|---|---|---|---|
| 1 | `saas_p6_prompt_versions.sql` 报 `role "labelflow_app" does not exist` | 该脚本 `GRANT ... TO labelflow_app`，但角色由 `saas_p6_rls.sql` 创建，而 RLS 被排在最后 | `saas_p6_rls.sql` 跑两遍：建角色（第 10 步）+ 补挂新表策略（第 31 步） |
| 2 | `inventory_masterdata.sql` 报 `relation "stock_moves" does not exist` | 它给 `stock_moves` 加 `location_id` 列，但 `inventory_stock_moves.sql` 排在它后面 | 两脚本对调，`stock_moves` 在前 |
| 3 | 重跑建库报 `relation "tenants" already exists` | `docs/03-database.sql` 的 19 张表**没有** `IF NOT EXISTS`，本就不幂等 | `db-init.sh` 检测 `public.tenants` 存在则跳过 `@base`，并在日志明示"基础 DDL 仅首次执行" |
| 4 | `seed-inventory-demo.sql` 报 `syntax error at or near ":"` | 该脚本是 psql 变量模板，需要 `-v tid=1` | `db-init.sh` 对 `@demo` 行自动补 `-v tid=${DEMO_TENANT_ID:-1}` |

---

## 4. 顺带记录的两个事实

1. **冷启动 45–70 秒**：`NestFactory.create` 前就要加载完 app.module 整条依赖链（`jwt-auth.guard` 单模块实测 11.7s、`module.guard` 7.9s）。compose 的 `start_period` 因此设为 120s。D2 里评估懒加载优化，但当前不改（避免动主链路）。
2. **RLS 角色已存在但未启用**：`saas_p6_rls.sql` 建了 `labelflow_app`（NOBYPASSRLS），但应用仍用超管连接（`docs/10 §10.22.4` 自认"主链路没切"）。D2 处理。

---

## 5. 回归

- `pnpm test`：860 例 / 853 通过 / 0 失败 / 7 跳过（与 D0 前一致）
- `pnpm typecheck`：零错误
- `pnpm build`：通过（改脚本后首次可用）
- 三个前端 `vue-tsc + vite build`：通过

## 6. 本阶段未做（留给后续阶段）

- `/health` 端点（D2）——当前 compose 用 TCP 探活
- 镜像真实 build / 推送（需 docker 环境）；含 `api` / 前端 / **`mcp`** 三个镜像
- `deploy/nginx/mcp.conf` **已在本机 nginx 1.18 真加载并跑通**（自签证书 + 反代到 3399：`/mcp-health` 200、
  `initialize` 200 text/event-stream 拿到会话号、`tools/list` 29 个、无 token 401）；仍未做的只是「生产域名 + 真证书」那层
- 前端镜像的 `.dockerignore` 实测（未跑过 build）
