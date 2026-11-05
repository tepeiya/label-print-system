# apps/platform — LabelFlow 平台运营后台（SaaS P2 + P3 计费运营）

Vue 3 + Vite + TypeScript + Element Plus，工程结构与 `apps/console` 一致（同一套 tsconfig / eslint 基线）。
面向平台运营身份（`platform_users`，JWT `scope=platform`），与租户 Console 是两套独立登录态。

## 启动

```bash
pnpm install
pnpm dev        # http://localhost:5181
pnpm build      # vue-tsc -b && vite build
pnpm lint       # eslint src
```

dev server 把 `/api` 代理到 `http://127.0.0.1:3200`（backend），需要后端 + PG(5433) + Redis(6380) 已起。

## 页面

| 路由 | 说明 | 主要接口 |
| --- | --- | --- |
| `/login` | 平台运营登录 | `POST /platform/auth/login` |
| `/tenants` | 租户列表 / 开通 / 停用恢复 / 退订 / 加购模块 / 租户详情抽屉（已开模块 + 配额与计量） | `GET\|POST /platform/tenants*`、`GET\|PUT\|DELETE /platform/tenants/:id/quotas*`、`GET /platform/tenants/:id/meters` |
| `/plans` | 套餐基本信息、月费（priceCents）与模块组成编辑 | `GET /platform/plans`、`PUT /platform/plans/:code` |
| `/billing` | 账单列表与筛选 / 出账（套餐·固定金额·行项）/ 发出 / 作废 / 登记收款 / 详情抽屉对账 | `GET\|POST /platform/invoices*`、`POST /platform/invoices/:id/(issue\|void\|payments)` |
| `/usage` | 全局用量看板 + 到期提醒 | `GET /platform/usage` |
| `/audit` | 平台侧操作审计（最近 200 条） | `GET /platform/audit` |

## 约定

- 登录态：`localStorage.labelflow_platform_token`（+ `labelflow_platform_user` 存展示用身份摘要）。
  平台侧没有 refresh token，access token 2h 过期，401 由 axios 拦截器统一清 token 回 `/login`。
- 响应信封 `{ code, message, data }` 在 `src/api/index.ts` 里一次性拆开，view 直接拿 `data`；
  失败统一 `ElMessage.error(message)`（需要静默的请求传 `silent: true`）。
- 菜单是静态的（5 个页面，见 `src/router/index.ts` 的 `PLATFORM_MENUS`），不复用 console 的后端驱动菜单。
- 金额字段一律「分」（`amountCents` / `priceCents`），页面内只在 `money()` / `centsOf()` 两处换算，展示为「元」保留两位。
