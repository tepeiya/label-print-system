# 11. SaaS 化与智能体接入架构

> 目标：把当前「单租户内部系统」升级为**可对外销售、按模块订阅、支持权限分级与 AI 智能体接入**的 SaaS 平台。
> **文档状态：v1.1 设计定稿（设计决策 D1–D12 已全部确认，见 §11.15），可直接作为编码依据。**
> 最后更新：2026-11-04

---

## 11.1 一页速览（已确认方案）

| 维度 | ✅ 已确认方案 | 理由 |
| --- | --- | --- |
| 部署形态 | **双形态**：公有云共享库 + 大客户独立库（`tenant.type`） | 代码同一套，靠 DataSource 路由区分；私有化不分支代码 |
| 租户隔离 | 应用层强制 `tenant_id` + **PostgreSQL RLS 兜底**（P6 落地） | 即使代码漏写 where 也查不到别家数据 |
| 商业模型 | **套餐为主 + 模块加购** | 客户容易理解；同时保留单模块售卖弹性 |
| 计费 | **订阅为主 + 用量超额**；V1 人工登记，V2 接支付 | 订阅保底收入，打印张数/AI 调用做超额计费 |
| 自助注册 | **不开放**，销售驱动 + 运营后台开通 + 发试用 | to B 客单价高，可控性优先 |
| 权限模型 | **四层**：平台级 / 租户角色 / 模块订阅 / 数据范围 | 模块是"门"，权限是"钥匙"，两者正交必须同过 |
| 权限点命名 | `module:resource:action`，收敛到 **20–40 个** | 防止权限点爆炸 |
| Agent 接入 | **MCP Server 独立进程 + 专用 Agent API** | 不持 DB 账号，复用现有守卫链，可信边界清晰 |
| MCP 传输 | 先 **stdio**（P4），后 **Streamable HTTP**（P5） | stdio 快速验证，HTTP 面向 SaaS 客户 |
| 高危操作 | **人工确认令牌**（approval token，5 分钟一次性） | 打印/扣库存会直接产生成本 |
| Agent 提交打印 | **默认禁止**，租户白名单 + 人工确认 | 误触发直接烧耗材 |
| 白标 | P6 落地，表结构 P0 预留 | 不阻塞主线 |

---

## 11.2 分层架构

```
┌────────────────────────────────────────────────────────────────────┐
│  Platform Console（平台运营后台，独立应用 / 独立登录）              │
│  租户管理 · 套餐与模块配置 · 开通停用 · 用量账单 · 发票 · 全局审计  │
└───────────────────────────────┬────────────────────────────────────┘
                                │ 只调 /platform/v1/*，禁止直读业务表
┌───────────────────────────────▼────────────────────────────────────┐
│  Tenant Console（租户后台 = 现有系统的演进）                        │
│  设计器 · 打印 · 模板 · 库存 · 齐套 · 预警 · AI · 订阅自助          │
└───────────────────────────────┬────────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────────┐
│  MCP Server（独立 Node 进程，仅持 Agent Token）                     │
│  tools · resources · prompts  →  调 /agent/v1/*                     │
└───────────────────────────────┬────────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────────┐
│  NestJS 守卫链（所有入口共用）                                       │
│  JwtAuth → TenantResolve → ModuleGuard → PermissionGuard → DataScope │
└───────────────────────────────┬────────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────────┐
│  领域模块：print / template / inventory / bom / alert / ai / agent   │
└───────────────────────────────┬────────────────────────────────────┘
                                │
        ┌───────────────────────┴────────────────────────┐
        ▼                                                ▼
   PostgreSQL（共享库 + RLS）                    Redis（队列/缓存/号段）
   dedicated 租户：独立 DataSource
```

**三条架构红线：**

1. 平台层**不得直接读业务表**，只能调平台 API（否则隔离被绕过、审计断链）。
2. Agent 层**不得持有数据库凭证**，只能调 `/agent/v1/*`。
3. 任何写操作必须在**同一条守卫链**上通过模块 + 权限 + 数据范围三重校验。

---

## 11.3 租户与订阅模型

### 11.3.1 租户类型

| type | 说明 | 数据存储 |
| --- | --- | --- |
| `shared` | 默认，公有云共享库 | 同一 PG 实例，`tenant_id` 行级隔离 + RLS |
| `dedicated` | 大客户 / 私有化 | 独立 DataSource（同实例不同库，或独立实例） |

`TenantContext` 需扩展 `dataSourceKey`，由 `TenantResolver` 根据 `tenant.type` 注入。

### 11.3.2 产品目录

- **modules**：可售能力单元（打印、库存、齐套、预警、AI、Agent）
- **plans**：套餐（BASIC / PRO / ENTERPRISE），套餐内含模块集合
- **tenant_modules**：租户实际开通项（来源可以是套餐、加购、试用、赠送）

### 11.3.3 订阅状态机

```
      开通试用
        │
        ▼
     ┌──────┐   付费    ┌────────┐  欠费   ┌──────────┐ 宽限期结束 ┌───────────┐
     │trial │ ────────► │ active │ ──────► │ past_due │ ─────────► │ suspended │
     └──────┘           └────────┘         └──────────┘            └───────────┘
        │                    ▲                   │                        │
  试用到期                    └────── 补缴 ────────┘                     │
        ▼                                                                 ▼
   降级 FREE                                                        手动续费 → active
                                                                    或 → canceled（软删）
```

各状态下系统行为（**必须写死，不能"看情况"**）：

| 状态 | 可登录 | 可读 | 可写 | 可导出 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `trial` | ✅ | ✅ | ✅ | ✅ | 全模块试用 |
| `active` | ✅ | ✅ | ✅ | ✅ | 正常 |
| `past_due` | ✅ | ✅ | ❌ | ✅ | 只读模式，页面顶部横幅提示 |
| `suspended` | ✅ | 仅订阅页 | ❌ | ✅ | 仅可续费与导出数据 |
| `canceled` | ❌ | ❌ | ❌ | 运营代导出 | 数据保留 90 天后硬删 |

### 11.3.4 模块依赖

`inventory` 依赖 `masterdata`（物料/仓库/供应商），`bom` 依赖 `inventory`。

- 开通时**自动补齐前置模块**
- 停用时检查被依赖情况，若被依赖则拒绝并提示"请先停用 BOM"

### 11.3.5 限额（Quota）

| 计量项 meter | 采集点 | 默认限额（PRO） | 超限策略 |
| --- | --- | --- | --- |
| `print_labels` | 每次 `print.submit_job` 累加张数 | 50000 / 月 | 超额按量计费或当月封顶 |
| `ai_generate` | 每次 `/ai-template/generate` | 500 / 月 | 超额停用，提示升级 |
| `agent_calls` | 每次 MCP 工具调用 | 20000 / 月 | 超额限流 |
| `storage_mb` | 模板资产 + 备份 | 5120 | 90% 预警，100% 拒绝上传 |
| `seats` | 已激活用户数 | 20 | 超出拒绝新增成员 |

---

## 11.4 权限分级（四层模型）

### 11.4.1 四层模型

| 层 | 名称 | 载体 | 校验时机 |
| --- | --- | --- | --- |
| **L0** | 平台级权限 | `platform_users.role` | 仅 `/platform/v1/*` |
| **L1** | 租户角色 | `roles` + `role_permissions` | 每个业务接口 |
| **L2** | 模块订阅 | `tenant_modules` | 每个业务接口（先于 L1） |
| **L3** | 数据范围 | `data_scopes` | 查询构造时 |

> **模块是门，权限是钥匙。** 租户订了库存 ≠ 仓管能改库存；没订库存，任何角色都进不去。

### 11.4.2 权限点字典（初版，后续按资源×动作扩展）

命名：`module:resource:action`

| code | 模块 | 说明 | 高危 |
| --- | --- | --- | --- |
| `print:template:read` | print | 查看模板 | |
| `print:template:write` | print | 新建/编辑/删除模板 | |
| `print:job:read` | print | 查看打印任务 | |
| `print:job:submit` | print | 提交打印 | ✅ |
| `print:job:cancel` | print | 取消/重打 | |
| `print:printer:manage` | print | 打印机增删改与校准 | |
| `print:audit:export` | print | 审计导出 | |
| `ai:template:generate` | ai | AI 生成模板 | |
| `ai:model:configure` | ai | 配置视觉模型 | ✅ |
| `inventory:stock:read` | inventory | 查库存 | |
| `inventory:stock:adjust` | inventory | 库存调整/盘点 | ✅ |
| `inventory:stock:transfer` | inventory | 调拨 | ✅ |
| `inventory:batch:read` | inventory | 查批次与效期 | |
| `bom:kit:read` | bom | 查齐套率 | |
| `bom:shortage:read` | bom | 查缺料明细 | |
| `bom:bom:write` | bom | 维护 BOM | ✅ |
| `alert:event:read` | alert | 查预警 | |
| `alert:event:ack` | alert | 处理预警 | |
| `alert:rule:configure` | alert | 配置预警规则 | ✅ |
| `masterdata:item:read` | masterdata | 查物料 | |
| `masterdata:item:write` | masterdata | 维护物料 | |
| `sys:user:manage` | sys | 成员与角色管理 | ✅ |
| `sys:agent:manage` | sys | Agent 与 Token 管理 | ✅ |
| `sys:subscription:read` | sys | 查看订阅 | |
| `sys:billing:read` | sys | 查看账单 | |

### 11.4.3 系统内置角色

| code | 名称 | 权限范围 |
| --- | --- | --- |
| `tenant_admin` | 租户管理员 | 全部（含 sys:*） |
| `manager` | 主管 | 业务读写 + 审批，不含 sys:user:manage |
| `operator` | 操作员 | 打印提交、库存只读、预警处理 |
| `warehouse_keeper` | 仓管 | 库存读写、批次、盘点 |
| `purchaser` | 采购 | 齐套/缺料查看、BOM 只读 |
| `viewer` | 只读 | 全部 `*:read` |

> 租户可在内置角色基础上**自定义角色**（`roles.tenant_id` 非空）。

### 11.4.4 守卫链实现

```ts
// 顺序（全局 → 控制器级）
JwtAuthGuard            // 解析 Bearer / ?token=，写 req.user
TenantResolveGuard      // 解析 tenant（JWT / 域名），写 AsyncLocalStorage
ModuleGuard             // @Module('inventory') → 校验 tenant_modules
PermissionGuard         // @RequirePermission('inventory:stock:adjust')
TenantGuard             // 现有：校验租户上下文

// 用法示例
@Module('inventory')
@RequirePermission('inventory:stock:adjust')
@Post('stock/adjust')
adjust(@Body() dto: AdjustDto) { ... }

// 宽松声明：任一满足
@RequireAnyPermission('print:template:read', 'print:template:write')
```

**匿名 / 公开路由**用现有 `@Public()`；平台路由用独立的 `@PlatformRoute()` + `PlatformJwtGuard`（另一套 secret 与 scope）。

### 11.4.5 数据范围（L3）

```ts
// 查询构造器统一入口
const scope = dataScopeOf(ctx);        // { type: 'all' | 'dept' | 'warehouse' | 'self', values[] }
qb.andWhere(scopeClause('warehouse_id', scope), scope.params);
```

字段级脱敏：`costPrice` / `supplierPrice` 等字段按 `permission` 或 `data_scope` 过滤，在序列化层统一处理（不在 SQL 里删列，避免破坏业务逻辑）。

### 11.4.6 前端配合

`GET /auth/me` 返回：

```jsonc
{
  "user": { "id": 7, "username": "zhangsan", "displayName": "张三" },
  "tenant": { "id": 12, "name": "某某食品", "type": "shared", "status": "active", "plan": "pro" },
  "modules": ["print", "ai", "inventory", "alert"],
  "permissions": ["print:template:read", "print:template:write", "inventory:stock:read"],
  "dataScopes": [{ "type": "warehouse", "values": ["3", "5"] }],
  "menus": [
    { "key": "inventory", "name": "库存", "icon": "box", "path": "/inventory",
      "children": [{ "key": "stock", "name": "库存查询", "path": "/inventory/stock" }] }
  ],
  "features": { "aiVision": true }
}
```

前端据此**动态生成路由与菜单**，禁止硬编码。按钮用 `v-permission` 指令。
⚠️ 前端隐藏仅是 UX，**后端必须独立拦截**。

---

## 11.5 数据库设计

> 现有 `docs/03-database.sql` 保持为「租户业务表」主体，本节的平台表可放在同一库的 `platform` schema，
> 也可独立库。推荐**同实例、独立 schema**，便于跨 schema 事务（开通租户要同时写两张表）。

### 11.5.1 平台层

```sql
CREATE SCHEMA IF NOT EXISTS platform;

-- 平台运营账号（与租户用户完全隔离）
CREATE TABLE platform.platform_users (
    id            BIGSERIAL PRIMARY KEY,
    username      VARCHAR(60) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    display_name  VARCHAR(80),
    role          VARCHAR(30) NOT NULL
                  CHECK (role IN ('super_admin','ops','support','finance')),
    status        SMALLINT NOT NULL DEFAULT 1,
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 模块目录
CREATE TABLE platform.modules (
    code          VARCHAR(40) PRIMARY KEY,
    name          VARCHAR(80) NOT NULL,
    description   VARCHAR(300),
    depends_on    TEXT[] NOT NULL DEFAULT '{}',
    is_core       BOOLEAN NOT NULL DEFAULT false,
    monthly_price NUMERIC(10,2) NOT NULL DEFAULT 0,
    trial_days    INTEGER NOT NULL DEFAULT 14,
    status        SMALLINT NOT NULL DEFAULT 1
);

-- 套餐
CREATE TABLE platform.plans (
    id            BIGSERIAL PRIMARY KEY,
    code          VARCHAR(40) NOT NULL UNIQUE,
    name          VARCHAR(80) NOT NULL,
    tier          SMALLINT NOT NULL DEFAULT 1,
    monthly_price NUMERIC(10,2) NOT NULL DEFAULT 0,
    yearly_price  NUMERIC(10,2) NOT NULL DEFAULT 0,
    seat_limit    INTEGER NOT NULL DEFAULT 5,
    trial_days    INTEGER NOT NULL DEFAULT 14,
    status        SMALLINT NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE platform.plan_modules (
    plan_id     BIGINT NOT NULL REFERENCES platform.plans(id) ON DELETE CASCADE,
    module_code VARCHAR(40) NOT NULL REFERENCES platform.modules(code),
    PRIMARY KEY (plan_id, module_code)
);

-- 订阅（一个租户同时只有一条 active/trial 记录）
CREATE TABLE platform.subscriptions (
    id           BIGSERIAL PRIMARY KEY,
    tenant_id    BIGINT NOT NULL,
    plan_id      BIGINT NOT NULL REFERENCES platform.plans(id),
    status       VARCHAR(20) NOT NULL
                 CHECK (status IN ('trial','active','past_due','suspended','canceled')),
    seats        INTEGER NOT NULL DEFAULT 5,
    period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
    period_end   TIMESTAMPTZ NOT NULL,
    auto_renew   BOOLEAN NOT NULL DEFAULT true,
    canceled_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_sub_tenant_status ON platform.subscriptions (tenant_id, status);

-- 租户实际开通的模块
CREATE TABLE platform.tenant_modules (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   BIGINT NOT NULL,
    module_code VARCHAR(40) NOT NULL REFERENCES platform.modules(code),
    status      VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('trial','active','expired','disabled')),
    source      VARCHAR(20) NOT NULL DEFAULT 'plan'
                CHECK (source IN ('plan','addon','trial','gift')),
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ,
    CONSTRAINT uq_tenant_module UNIQUE (tenant_id, module_code)
);
CREATE INDEX ix_tmod_tenant_status ON platform.tenant_modules (tenant_id, status);

-- 自定义域名 / 白标
CREATE TABLE platform.tenant_domains (
    id         BIGSERIAL PRIMARY KEY,
    tenant_id  BIGINT NOT NULL,
    domain     VARCHAR(200) NOT NULL UNIQUE,
    verified   BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 用量原始记录（先落原始，再日聚合，便于对账）
CREATE TABLE platform.usage_meters (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       BIGINT NOT NULL,
    meter           VARCHAR(40) NOT NULL,   -- print_labels / ai_generate / agent_calls / storage_mb
    module_code     VARCHAR(40),
    quantity        NUMERIC(14,2) NOT NULL,
    user_id         BIGINT,
    agent_client_id BIGINT,
    meta            JSONB NOT NULL DEFAULT '{}',
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_usage_tenant_meter_time ON platform.usage_meters (tenant_id, meter, occurred_at DESC);

CREATE TABLE platform.usage_daily (
    tenant_id BIGINT NOT NULL,
    meter     VARCHAR(40) NOT NULL,
    day       DATE NOT NULL,
    quantity  NUMERIC(14,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, meter, day)
);

CREATE TABLE platform.quotas (
    tenant_id  BIGINT NOT NULL,
    meter      VARCHAR(40) NOT NULL,
    soft_limit NUMERIC(14,2),
    hard_limit NUMERIC(14,2),
    period     VARCHAR(10) NOT NULL DEFAULT 'month',
    PRIMARY KEY (tenant_id, meter)
);

-- 账单与支付
CREATE TABLE platform.invoices (
    id           BIGSERIAL PRIMARY KEY,
    tenant_id    BIGINT NOT NULL,
    number       VARCHAR(40) NOT NULL UNIQUE,
    amount       NUMERIC(12,2) NOT NULL,
    currency     VARCHAR(8) NOT NULL DEFAULT 'CNY',
    status       VARCHAR(20) NOT NULL
                 CHECK (status IN ('draft','issued','paid','void','overdue')),
    period_start DATE,
    period_end   DATE,
    due_at       TIMESTAMPTZ,
    paid_at      TIMESTAMPTZ,
    detail       JSONB NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE platform.payments (
    id           BIGSERIAL PRIMARY KEY,
    invoice_id   BIGINT NOT NULL REFERENCES platform.invoices(id),
    tenant_id    BIGINT NOT NULL,
    provider     VARCHAR(20) NOT NULL
                 CHECK (provider IN ('manual','wechat','alipay','stripe','bank')),
    provider_ref VARCHAR(200),
    amount       NUMERIC(12,2) NOT NULL,
    paid_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 平台操作审计（谁在何时对哪个租户做了什么）
CREATE TABLE platform.platform_audit_logs (
    id          BIGSERIAL PRIMARY KEY,
    actor_id    BIGINT,
    action      VARCHAR(60) NOT NULL,
    tenant_id   BIGINT,
    detail      JSONB,
    ip          VARCHAR(45),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_plataudit_tenant_time ON platform.platform_audit_logs (tenant_id, created_at DESC);
```

### 11.5.2 租户层扩展（在现有库执行）

```sql
-- 租户主表扩展
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'shared'
      CHECK (type IN ('shared','dedicated'));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_id BIGINT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'
      CHECK (status IN ('trial','active','past_due','suspended','canceled'));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS seat_limit INTEGER NOT NULL DEFAULT 5;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS branding JSONB NOT NULL DEFAULT '{}';
-- D12：canceled 后 90 天硬删，删除任务依赖此字段
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS ix_tenants_canceled ON tenants (canceled_at) WHERE canceled_at IS NOT NULL;

-- 权限点字典（平台维护，全局共享）
CREATE TABLE IF NOT EXISTS permissions (
    code         VARCHAR(60) PRIMARY KEY,       -- inventory:stock:adjust
    module_code  VARCHAR(40) NOT NULL,
    resource     VARCHAR(40) NOT NULL,
    action       VARCHAR(30) NOT NULL,
    name         VARCHAR(80) NOT NULL,
    is_high_risk BOOLEAN NOT NULL DEFAULT false
);

-- 角色（tenant_id IS NULL 表示系统内置模板角色）
CREATE TABLE IF NOT EXISTS roles (
    id         BIGSERIAL PRIMARY KEY,
    tenant_id  BIGINT,
    code       VARCHAR(40) NOT NULL,
    name       VARCHAR(60) NOT NULL,
    is_system  BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_role_tenant_code UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id         BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_code VARCHAR(60) NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_code)
);

-- user_roles 升级：从 role 字符串到 role_id（两步迁移，见 §11.12.2）
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS role_id BIGINT;
CREATE INDEX IF NOT EXISTS ix_user_roles_role ON user_roles (role_id);

-- 数据范围
CREATE TABLE IF NOT EXISTS data_scopes (
    id           BIGSERIAL PRIMARY KEY,
    tenant_id    BIGINT NOT NULL,
    subject_type VARCHAR(10) NOT NULL CHECK (subject_type IN ('user','role','agent')),
    subject_id   BIGINT NOT NULL,
    scope_type   VARCHAR(20) NOT NULL CHECK (scope_type IN ('all','dept','warehouse','self')),
    scope_value  VARCHAR(60),
    CONSTRAINT uq_datascope UNIQUE (tenant_id, subject_type, subject_id, scope_type, scope_value)
);

-- 部门
CREATE TABLE IF NOT EXISTS departments (
    id         BIGSERIAL PRIMARY KEY,
    tenant_id  BIGINT NOT NULL,
    parent_id  BIGINT,
    name       VARCHAR(80) NOT NULL,
    path       VARCHAR(300) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 功能开关（灰度）
CREATE TABLE IF NOT EXISTS feature_flags (
    tenant_id BIGINT NOT NULL,
    key       VARCHAR(60) NOT NULL,
    enabled   BOOLEAN NOT NULL DEFAULT false,
    rollout   JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (tenant_id, key)
);
```

### 11.5.3 Agent 层

```sql
CREATE TABLE IF NOT EXISTS agent_clients (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   BIGINT NOT NULL,
    name        VARCHAR(80) NOT NULL,
    description VARCHAR(300),
    kind        VARCHAR(20) NOT NULL DEFAULT 'mcp_stdio'
                CHECK (kind IN ('mcp_stdio','mcp_http','internal')),
    status      VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','disabled')),
    created_by  BIGINT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_agent_tenant ON agent_clients (tenant_id);

CREATE TABLE IF NOT EXISTS agent_tokens (
    id              BIGSERIAL PRIMARY KEY,
    agent_client_id BIGINT NOT NULL REFERENCES agent_clients(id) ON DELETE CASCADE,
    tenant_id       BIGINT NOT NULL,
    token_hash      VARCHAR(100) NOT NULL UNIQUE,
    scopes          TEXT[] NOT NULL DEFAULT '{}',   -- permission_code 子集
    expires_at      TIMESTAMPTZ,
    revoked         BOOLEAN NOT NULL DEFAULT false,
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_approvals (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       BIGINT NOT NULL,
    agent_client_id BIGINT NOT NULL,
    tool            VARCHAR(60) NOT NULL,
    args_hash       VARCHAR(64) NOT NULL,
    args_preview    JSONB NOT NULL DEFAULT '{}',
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','expired','consumed')),
    expires_at      TIMESTAMPTZ NOT NULL,
    approved_by     BIGINT,
    approved_at     TIMESTAMPTZ,
    consumed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_agentappr_tenant_status ON agent_approvals (tenant_id, status);

-- P4：反向接入外部 MCP（系统内 AI 调用客户自己的服务）
CREATE TABLE IF NOT EXISTS external_mcp_servers (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,
    name          VARCHAR(80) NOT NULL,
    endpoint      TEXT NOT NULL,
    auth_type     VARCHAR(20) NOT NULL DEFAULT 'none',
    auth_secret   TEXT,                       -- AES-256-GCM 加密，复用 sql-crypto.ts
    allowed_tools TEXT[] NOT NULL DEFAULT '{}',
    status        SMALLINT NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 11.5.4 多租户 RLS（第二道防线）

```sql
-- 对每张业务表执行（以 templates 为例）
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates FORCE ROW LEVEL SECURITY;

CREATE POLICY p_templates_tenant ON templates
    USING (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- 连接池获取连接后立即执行
--   SET app.tenant_id = '<tenantId>';
-- 平台运营跨租户查询使用独立账号 labelflow_platform（BYPASSRLS）
```

> 注意：`FORCE ROW LEVEL SECURITY` 会让表属主也受约束；平台后台必须用**单独的高权限账号**，否则会查不到数据。

---

## 11.6 API 契约

### 11.6.1 租户侧（现有 `/api/v1` 扩展）

| 方法 | 路径 | 说明 | 权限 |
| --- | --- | --- | --- |
| GET | `/auth/me` | 返回 user + tenant + modules + permissions + menus + dataScopes | 登录 |
| GET | `/subscription` | 当前订阅、套餐、到期时间、模块清单、用量 | `sys:subscription:read` |
| GET | `/subscription/usage?meter=print_labels&from=&to=` | 用量曲线 | `sys:subscription:read` |
| POST | `/subscription/upgrade` | 升级套餐（走支付或生成待支付单） | `sys:subscription:read` + 租户管理员 |
| GET | `/billing/invoices` | 账单列表 | `sys:billing:read` |
| GET | `/members` / `/members/invite` | 成员管理与邀请 | `sys:user:manage` |
| GET | `/roles` / `POST /roles` / `PUT /roles/:id/permissions` | 角色与权限配置 | `sys:user:manage` |
| GET | `/agents` / `POST /agents` / `POST /agents/:id/tokens` | Agent 与 Token 管理 | `sys:agent:manage` |
| POST | `/agents/approvals/:id/approve` | 高危操作确认 | `sys:agent:manage` 或业务权限 |

### 11.6.2 平台侧（新前缀 `/platform/v1`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/platform/auth/login` | 平台运营登录（独立 JWT，scope=platform） |
| GET | `/platform/tenants` | 租户列表（含订阅状态、用量、到期） |
| POST | `/platform/tenants` | 开通租户（建 tenant + admin + 订阅 + 模块） |
| PUT | `/platform/tenants/:id` | 修改租户信息 / 类型 / 白标 |
| POST | `/platform/tenants/:id/suspend` \| `/resume` | 停用 / 恢复 |
| POST | `/platform/tenants/:id/modules` | 加购 / 停用模块 |
| GET | `/platform/plans` / `POST /platform/plans` | 套餐配置 |
| GET | `/platform/modules` | 模块目录 |
| GET | `/platform/usage` | 全局用量看板 |
| GET | `/platform/invoices` / `POST /platform/invoices` | 账单 |
| GET | `/platform/audit` | 平台审计 |
| POST | `/platform/impersonate/:tenantId` | **模拟登录**（必留痕，只读优先，限时 30 分钟） |

### 11.6.3 Agent API（新前缀 `/agent/v1`）

鉴权：`Authorization: Bearer <agent_token>`；`TenantResolveGuard` 从 token 直接取 `tenantId`，**禁止请求体传 tenant**。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/agent/v1/whoami` | 返回 agent 身份、scope、可访问模块 |
| POST | `/agent/v1/tools/:tool` | 统一工具调用入口（body = 工具入参） |
| GET | `/agent/v1/resources/:kind/:id` | 只读资源（模板 JSON、库存快照） |
| POST | `/agent/v1/approvals` | 创建审批请求（返回 approval_id） |
| GET | `/agent/v1/approvals/:id` | 查询审批状态 |

统一返回：

```jsonc
{
  "code": 0,
  "message": "ok",
  "data": {
    "summary": "上海仓有机苹果可用 320 件，低于安全库存 500",
    "data": { },
    "warnings": [],
    "next_actions": ["inventory.query_stock", "bom.check_kit_rate"]
  }
}
```

`summary` 是给模型读的自然语言摘要，`data` 是结构化数据，`next_actions` 引导多步推理。

---

## 11.7 MCP 服务设计

### 11.7.1 进程与部署

```
apps/mcp-server/
├── src/
│   ├── index.ts              # stdio 入口（默认）
│   ├── http.ts               # Streamable HTTP 入口（SaaS）
│   ├── client/agent-api.ts   # 调 /agent/v1 的瘦客户端
│   ├── tools/                # 每个工具一个文件
│   ├── resources/
│   └── prompts/
└── package.json              # @modelcontextprotocol/sdk
```

- **只持 Agent Token**（环境变量或 header 透传），不持数据库账号。
- stdio 模式单租户；HTTP 模式多租户，会话建立时绑定 tenant。

### 11.7.2 工具目录

| 工具 | 类型 | 权限点 | 说明 |
| --- | --- | --- | --- |
| `whoami` | 读 | — | 返回租户、模块、scope |
| `list_modules` | 读 | — | 当前订阅了哪些模块 |
| `describe_capabilities` | 读 | — | 返回可用工具清单与用途（供模型自举） |
| `templates.search` | 读 | `print:template:read` | 按名称/分类/标签搜模板 |
| `templates.get` | 读 | `print:template:read` | 取模板 JSON |
| `templates.create` | 写 | `print:template:write` | 创建模板 |
| `templates.update` | 写 | `print:template:write` | 更新模板 |
| `print.estimate` | 读 | `print:job:read` | 预估张数与耗材 |
| `print.submit_job` | **高危** | `print:job:submit` | 提交打印（**D7：默认关闭**，需 `feature_flags['agent.print.submit']=true` + approval） |
| `print.get_status` | 读 | `print:job:read` | 查询任务进度 |
| `print.wait_for_job` | 读 | `print:job:read` | 内部轮询直到完成或超时 |
| `print.cancel_job` | 写 | `print:job:cancel` | 取消任务 |
| `ai.generate_template_from_image` | 写（计费） | `ai:template:generate` | 图片 → 模板 |
| `ai.parse_label_image` | 读 | `ai:template:read` | 只解析，不落库 |
| `inventory.query_stock` | 读 | `inventory:stock:read` | 多维度查库存 |
| `inventory.list_low_stock` | 读 | `inventory:stock:read` | 低于安全库存 |
| `inventory.list_batches` | 读 | `inventory:batch:read` | 批次列表 |
| `inventory.list_expiring` | 读 | `inventory:batch:read` | 临期批次 |
| `inventory.adjust` | **高危** | `inventory:stock:adjust` | 库存调整 |
| `inventory.transfer` | **高危** | `inventory:stock:transfer` | 调拨 |
| `bom.check_kit_rate` | 读 | `bom:kit:read` | 齐套率 |
| `bom.explain_shortage` | 读 | `bom:shortage:read` | 缺料明细 |
| `alerts.list` | 读 | `alert:event:read` | 预警列表 |
| `alerts.ack` | 写 | `alert:event:ack` | 处理预警 |

**工具设计原则**（详见 §11.7.4）。

### 11.7.3 输入 schema 示例

```jsonc
// inventory.query_stock
{
  "type": "object",
  "properties": {
    "keyword":   { "type": "string", "description": "物料名称/编码模糊匹配" },
    "warehouse": { "type": "string", "description": "仓库名称或 ID，缺省=全部可见仓库" },
    "group_by":  { "type": "string", "enum": ["sku", "batch", "warehouse"], "default": "sku" },
    "below_safety": { "type": "boolean", "description": "只看低于安全库存的" },
    "expiring_days": { "type": "integer", "minimum": 1, "maximum": 365,
                       "description": "只看 N 天内到期的批次" },
    "limit":     { "type": "integer", "default": 20, "maximum": 100 },
    "cursor":    { "type": "string" }
  },
  "required": []
}

// inventory.adjust（高危）
{
  "type": "object",
  "properties": {
    "sku":            { "type": "string" },
    "warehouse":      { "type": "string" },
    "batch_no":       { "type": "string" },
    "delta":          { "type": "number", "description": "正数入库，负数出库" },
    "reason":         { "type": "string", "minLength": 2 },
    "idempotency_key":{ "type": "string", "description": "幂等键，重试安全" },
    "approval_id":    { "type": "string", "description": "高危操作确认令牌" },
    "dry_run":        { "type": "boolean", "default": false }
  },
  "required": ["sku", "warehouse", "delta", "reason", "idempotency_key"]
}
```

### 11.7.4 工具设计七原则

| 原则 | 反例 | 正例 |
| --- | --- | --- |
| 面向任务而非表 | 20 个 `get_xxx_by_id` | `inventory.query_stock({keyword, warehouse, group_by})` |
| 低基数 | 50 个 CRUD 工具 | 20 个左右覆盖 90% 意图 |
| 参数用业务标识 | `template_id: 137` | 同时接受 `template_name` |
| 返回带摘要 | 只有 JSON | `{summary, data, next_actions}` |
| 分页统一 | 各自造 | `limit` + `cursor`，上限 100 |
| 写操作幂等 | 重试重复下单 | 强制 `idempotency_key` |
| 高危可预演 | 直接扣库存 | `dry_run: true` 返回影响预览 |

### 11.7.5 Resources 与 Prompts

| 类型 | URI / 名称 | 用途 |
| --- | --- | --- |
| Resource | `labelflow://templates/{id}` | 模板完整 JSON |
| Resource | `labelflow://inventory/stock?warehouse={code}` | 库存快照 |
| Resource | `labelflow://alerts/open` | 未处理预警 |
| Prompt | `inventory.health_check` | "巡检库存健康度，输出呆滞与临期清单" |
| Prompt | `bom.daily_kit_report` | "输出今日齐套率与缺料 Top10" |
| Prompt | `print.label_from_description` | "根据商品描述生成标签并预览，确认后提交" |

Prompt 是差异化卖点：客户开箱即用，无需自己写提示词。

### 11.7.6 审计与审批流

```
Agent 调用 print.submit_job
   ├─ 有有效 approval_id → 校验 args_hash 一致 → 执行 → 置 consumed
   └─ 无 → 创建 agent_approvals(pending) 返回 { need_approval, approval_id, preview }
                 │
                 ▼
        员工在租户后台「待确认」列表看到：谁（哪个 Agent）要做什么（参数摘要）
                 │ 点击确认
                 ▼
        status=approved（5 分钟有效，一次性）
                 │ Agent 用 approval_id 重试
                 ▼
              执行并审计
```

审计字段：`actor_type=agent`、`agent_client_id`、`on_behalf_of`（Agent 创建者）、`tool`、`args_hash`、`approval_id`、耗时、结果码。

### 11.7.7 安全护栏清单

1. token scope ⊆ 创建者权限（创建时校验）
2. 新建 Agent 默认只读
3. 高危工具需 approval（5 分钟、一次性、args_hash 绑定）
4. 写工具强制 `idempotency_key`
5. 限流：Agent 维度 60 次/分 + 租户维度 + 单次批量 ≤ 500
6. 全量审计（含被拒绝的调用）
7. 字段脱敏按 `data_scope`
8. 提示词注入防护：工具返回的用户数据标记 `untrusted`；AI 生成的模板 JSON 必须过 `validateAiTemplate()`
9. 订阅 suspended 时仅保留 `whoami` 与导出类工具

---

## 11.8 计费与用量

| 阶段 | 做法 |
| --- | --- |
| V1（**已确认，P3 落地**） | 合同签订 → 运营后台手动开通 N 个月 → 到期前 30/7/1 天提醒（站内信+邮件+飞书） → 逾期转 `past_due` |
| V2 | 接微信支付 / 支付宝（企业付款）+ 后台开票 + 自助续费 |
| V3 | 接 Stripe（出海）+ 自助升降级 + 优惠码 + 按量账单 |

**计量规则**：
- 先写 `usage_meters` 原始记录，再由定时任务聚合到 `usage_daily`
- 配额检查读 `usage_daily` 当日/当月累计，避免每次扫原始表
- 超额行为：`soft_limit` 只告警；`hard_limit` 拒绝并返回明确的升级引导

---

## 11.9 租户隔离与安全

| 项 | 措施 |
| --- | --- |
| 应用层 | 所有业务查询强制 `tenantId: useTenantId()`（现有约定，保持） |
| 数据库层 | RLS + `SET app.tenant_id`；平台后台用独立高权限账号 |
| 独立库租户 | `tenant.type='dedicated'` → `TenantContext.dataSourceKey` 路由 |
| 越权防护 | 详情接口命中为空返回 **404**（不暴露存在性），延续现有 `findOwnedOr404` |
| 平台模拟登录 | 必留痕、默认只读、30 分钟过期、需二次确认 |
| 租户离场 | 一键导出（JSON + 附件）→ 软删 → 90 天硬删；删除需双人确认 |
| 密钥 | SQL 连接串 / AI Key / 外部 MCP Secret 统一用 `sql-crypto.ts` 的 AES-256-GCM |
| 备份 | 支持单租户粒度恢复（`tenant_backups` 已有表，需补实现） |

---

## 11.10 前端架构（配合 SaaS）

| 项 | 做法 |
| --- | --- |
| 技术栈 | Vue 3 + TS + Vite + Element Plus + ECharts + Pinia（详见交接文档待办） |
| 应用拆分 | `apps/console`（租户后台）/ `apps/platform`（平台后台）/ `apps/designer`（现有画布，iframe 嵌入） |
| 动态路由 | 由 `/auth/me` 的 `menus` 生成，路由守卫校验 `modules` 与 `permissions` |
| 模块未订阅 | 菜单不渲染 + 直达 URL 显示「未订阅」页 + 引导升级；后端 403 兜底 |
| 权限指令 | `v-permission="'inventory:stock:adjust'"`；仅控制展示 |
| 订阅页 | 套餐对比、当前用量、升级入口、账单列表、到期提醒横幅 |
| 平台后台 | 独立登录、独立构建产物、独立域名（`admin.xxx.com`） |

---

## 11.11 实施路线

> 排期依据 §11.15 已锁定的 D1–D12。P0 只需 4–5 天即可跑通「模块订阅 + 权限点」底座。

| 阶段 | 内容 | 交付物 | 估算 |
| --- | --- | --- | --- |
| **P0 权限与订阅底座** ✅ 已完成（2026-11-04） | 平台/租户/模块/套餐/订阅表；`permissions` 字典；`role_permissions`；`user_roles.role_id` 迁移（含 `sql → manager`）；`ModuleGuard` + `PermissionGuard`；`TenantCtx.dataSourceKey`；连接池 `SET app.tenant_id`；`feature_flags` 表；`tenants.canceled_at`；`/auth/me` 扩展 | 后端可校验模块与权限点；现有 4 角色平滑映射 | 4–5 天 |
| **P1 前端动态化** ✅ 已完成（2026-11-04） | 动态菜单/路由/按钮权限；模块未订阅页；订阅信息页（只读） | 前端不再硬编码菜单：`apps/console` 菜单与路由守卫改为消费 `/auth/me.menus`；新增 `v-permission` / `v-module` 指令、`/blocked` 落地页、`/subscription` 到期横幅、数据源/审计/AI 三个页面；零构建的 `web/` 同步改为「权限点优先 + 角色兜底」+ 按订阅模块裁剪页签（细节见 docs/10 §10.16） | 3–4 天 |
| **P2 平台运营后台**（2026-11-05 后端+前端落地，细节 docs/10 §10.18） | 租户开通/停用/加购；套餐配置；用量看板；到期提醒任务 | 可人工售卖与开通 | 1.5–2 周 |
| **P3 计费闭环**（2026-11-05 落地，细节 docs/10 §10.19） | 用量采集 + 配额 + 账单 + 支付（先手动登记）+ 发票 | 可出账、可对账（实测：p0-acceptance.sh K 段 19 项；发票开具与自动扣款未做，见 §10.19.5） | 2–3 周 |
| **P4 Agent / MCP**（2026-11-05 落地，细节 docs/10 §10.20） | agent 表 + `/agent/v1` + stdio MCP + 只读工具 | Claude Desktop 可查库存/齐套（实测：6 个业务只读工具 + 3 元工具 + apps/mcp-server stdio；写工具/审批流/HTTP 传输属 P5） | 4–5 天 |
| **P5 Agent 增强**（2026-11-05 落地，细节 docs/10 §10.21） | 写工具 + 幂等 + 限流 + 审计 + 审批流 + Streamable HTTP | SaaS 客户可接入自有 Agent（实测：p0-acceptance.sh M 段 31 项 + 验收 146/0；写工具 5 个全部有执行器、Streamable HTTP 一 token 一会话；**审批的 console 前端页与 Prompts 库产品化未做**，见 §10.21.8） | 1.5–2 周 |
| **P6 加固** | RLS、独立库租户、租户导出/删除、白标、Prompts 库 | 可对外规模化 | 1–2 周 |

> P0+P1（约 1.5 周）即可跑通「按模块订阅 + 权限分级」的最小闭环；
> P4（4–5 天）即可做出可演示的 Agent 能力。

### 11.11.1 验收标准（P0）

> ✅ **2026-11-04 全部通过**，可重跑验证：`cd backend && T_CODE=p0a1 T2_CODE=p0a2 bash scripts/p0-acceptance.sh`
> （62 项断言 = 下面 6 条 + 旧 4 角色回归）。实现落点与偏差记录见 `docs/10-dev-handover.md` §10.15。

- [x] 创建租户时自动写入 `subscriptions` + `tenant_modules`（按套餐展开）
- [x] 未订阅模块的接口返回 `403 { code: 4031, message: '模块未订阅' }`
- [x] 无权限点的接口返回 `403 { code: 4032, message: '权限不足' }`
- [x] `tenant_admin` 可访问全部模块；`viewer` 只有 `*:read`
      （偏差：`viewer` 另有 `template:favorite`，沿用 P0 初始种子，见 docs/10 §10.15.5 第 7 条）
- [x] `/auth/me` 返回 modules / permissions / menus，前端菜单据此渲染
      （后端裁剪逻辑见 `src/saas/menu.catalog.ts`；**前端已于 P1 接入**，
      `apps/console` 顶栏与路由守卫只读 `me.menus`，见 docs/10 §10.16）
- [x] 现有 `admin/operator/sql/viewer` 映射后行为不变（回归测试 16 项 + 手工 8 项）
      （实测：单测 180 条 + 验收脚本 146 项（A–M 段）；`sql` 登录后双码回显 `["sql","manager"]`）

### 11.11.2 验收标准（P4）

> ✅ **2026-11-05 五条全部通过**（p0-acceptance.sh L 段 L.1–L.20 + M 段 M.1–M.22，实现与偏差见 docs/10 §10.20 / §10.21）：
> inspector CLI 实测 `--cli node dist/index.js --method tools/list` 列出 11 个（P5 后目录共 17 个 = 3 元 + 9 只读 + 5 写/高危，写工具全部有执行器）；
> 第五条原归 P5 的 approval 流已于本轮落地（M.4 起）。

- [x] `npx @modelcontextprotocol/inspector` 能列出全部工具（验收 L.14 stdio 自测 + inspector CLI 实测）
- [x] `whoami` 返回正确租户与 scope（L.6）
- [x] `inventory.query_stock` 在无库存数据时返回空数组 + 友好摘要（L.9）
- [x] 用只读 token 调 `inventory.adjust` 返回 403 且写入审计（L.12，403/4032 + audit `denied_scope`）
- [x] 高危工具无 approval_id 时返回 `need_approval` 且不产生副作用（**P5 已落**：M.4 实测 HTTP 202 + `data.need_approval` + `approval_id`，库存行数与总量零变化；M.6/M.9/M.10/M.11/M.12 覆盖 pending 拦下、确认后执行、一次性、hash 篡改、驳回；细节 docs/10 §10.21）

---

## 11.12 迁移方案

### 11.12.1 现有 4 角色映射

| 现有 role | 映射到新角色 | 说明 |
| --- | --- | --- |
| `admin` | `tenant_admin` | 全权限 |
| `operator` | `operator` | 打印 + 业务只读 |
| `sql` | `manager`（附 `inventory:stock:read`） | 原 SQL 数据源能力并入 manager |
| `viewer` | `viewer` | 只读 |

> **D11 已确认**：`sql` 角色废弃，其权限并入 `manager`。迁移脚本把 `sql → manager`，
> `RolesGuard` 兼容期保留一个版本后移除；SQL 数据源访问改由业务权限点控制。

### 11.12.2 `user_roles` 两步迁移

```sql
-- 第 1 步：写入内置角色模板（tenant_id IS NULL）
INSERT INTO roles (tenant_id, code, name, is_system) VALUES
  (NULL,'tenant_admin','租户管理员',true),
  (NULL,'manager','主管',true),
  (NULL,'operator','操作员',true),
  (NULL,'warehouse_keeper','仓管',true),
  (NULL,'purchaser','采购',true),
  (NULL,'viewer','只读',true);

-- 第 2 步：为每个租户复制一份角色（便于后续自定义）
INSERT INTO roles (tenant_id, code, name, is_system)
SELECT t.id, r.code, r.name, true FROM tenants t CROSS JOIN roles r WHERE r.tenant_id IS NULL;

-- 第 3 步：回填 user_roles.role_id
UPDATE user_roles ur SET role_id = r.id
FROM roles r
WHERE r.tenant_id = ur.tenant_id AND r.code = CASE ur.role
    WHEN 'admin' THEN 'tenant_admin'
    WHEN 'operator' THEN 'operator'
    WHEN 'sql' THEN 'manager'
    WHEN 'viewer' THEN 'viewer'
  END;

-- 第 4 步：校验无 NULL，然后保留 role 列一个版本周期再删
SELECT COUNT(*) FROM user_roles WHERE role_id IS NULL;  -- 期望 0
```

### 11.12.3 兼容期

- `RolesGuard` 保留一个版本，新旧并行：优先读 `role_id`，回退读 `role` 字符串
- 前端 `applyRoleConstraints()` 改为读 `permissions`，保留角色判断作为降级

---

## 11.13 风险清单

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 权限点爆炸 | 半年后 300 个没人搞得清 | 按资源×动作收敛到 20–40 个，新增需评审 |
| 只在前端隐藏 | 改 URL 即可越权 | 后端 `PermissionGuard` 独立拦截 + 回归用例 |
| 订阅变更缓存未失效 | 开通/停用后需等 TTL | `tenant_modules` 变更时主动 `del cache` |
| 降级策略未定义 | 客户投诉数据"消失" | §11.3.3 写死状态矩阵，并在产品页公示 |
| 平台账号混入租户 | 跨租户越权 | 两套身份表 + 两套 JWT scope，禁止共用 |
| RLS 与表属主冲突 | 平台查询查不到数据 | 平台用 `BYPASSRLS` 独立账号 |
| Agent 误触发打印 | 直接耗材成本 | 默认关闭 + approval + dry_run |
| AI 生成非法模板 | 打印异常/数据脏 | 强制 `validateAiTemplate()` |
| 多 schema 事务 | 开通租户部分成功 | 单事务跨 schema，失败回滚 |

---

## 11.14 与现有代码的对照改造点

| 现有位置 | 改造内容 |
| --- | --- |
| `backend/src/common/roles.guard.ts` | 保留；新增 `module.guard.ts` / `permission.guard.ts` |
| `backend/src/common/tenant.context.ts` | 扩展 `TenantCtx`：`plan`、`modules[]`、`permissions[]`、`dataScopes[]`、`dataSourceKey` |
| `backend/src/common/tenant-context.interceptor.ts` | 注入上述上下文（带 Redis 缓存） |
| `backend/src/auth/auth.controller.ts` | `/auth/me` 返回扩展结构 |
| `backend/src/app.module.ts` | 增加 `PlatformModule`、`AgentModule`、`SubscriptionModule` |
| `backend/src/entities/tenant.entity.ts` | `tenants` 加 type/plan_id/status/seat_limit/branding |
| `backend/src/user/user.module.ts` | 角色分配改为 `role_id`，支持自定义角色与权限矩阵 |
| `web/js/app.js#applyRoleConstraints` | 改为基于 `permissions` 动态判断 |
| `web/index.html` | 菜单改为动态渲染（或保留静态骨架 + 运行时隐藏） |
| `docs/03-database.sql` | 追加 §11.5 的 DDL |
| `docs/10-dev-handover.md` | 增加 SaaS/Agent 章节索引与新增模块说明 |

---

## 11.15 决策记录（D1–D12 已锁定）

> **状态：全部已确认，可作为编码依据。** 确认日期：2026-11-04。
> 后续如需变更，请在本节追加"变更记录"（日期 + 变更项 + 原因），不要直接改结论。

| # | 决策 | ✅ 结论（已锁定） | 落地要求 | 影响阶段 |
| --- | --- | --- | --- | --- |
| **D1** | 商业包装 | **套餐为主 + 模块加购** | 必须实现 `plans` / `plan_modules`；同时允许 `tenant_modules.source='addon'` 单独加购 | P0 建表，P2 运营后台 |
| **D2** | 私有化部署 | **支持** | `tenants.type` 保留 `dedicated`；`TenantCtx` 增加 `dataSourceKey`；**P0 就要把字段和路由钩子留好**，P6 再真正接独立库 | P0 预留，P6 落地 |
| **D3** | 首批客户规模 | **按 <50 租户启动**（阶段假设）；RLS 放 P6 | P0 只做应用层隔离，但**必须**在连接池执行 `SET app.tenant_id`（为 RLS 预留）；P6 补策略。若实际 >50，RLS 提前到 P2 | P0 预留，P6 完成 |
| **D4** | 自助注册与试用 | **暂不开放** | 不做注册页/验证码；试用由运营在平台后台创建（`tenants.status='trial'` + `trial_ends_at`） | 全阶段 |
| **D5** | 支付渠道 | **先人工登记**，V2 接微信/支付宝 | P3 只做账单 + 手工标记已付（`payments.provider='manual'`）；不做支付回调 | P3 |
| **D6** | 白标 | **P6 做，表结构现在预留** | `tenant_domains` + `tenants.branding` 进 P0 DDL；P6 实现域名校验与主题注入 | P0 预留，P6 落地 |
| **D7** | Agent 提交打印 | **默认禁止** | `print.submit_job` 需要 `tenant.feature_flags['agent.print.submit']=true` 且带 `approval_id`；默认关闭 | P4/P5 |
| **D8** | MCP 对外售卖 | **是，作为 PRO 套餐卖点** | `agent` 列入 PRO 套餐；Prompts 库需要产品化（至少 3 个开箱即用场景） | P4/P5 |
| **D9** | MCP 传输优先级 | **先 stdio，后 Streamable HTTP** | P4 只做 stdio；P5 再上 HTTP + 多租户 session | P4 → P5 |
| **D10** | 反向 MCP | **P6 之后再做** | `external_mcp_servers` 进 P0 DDL 但**不实现**；仅预留表 | P0 预留 |
| **D11** | 现有 `sql` 角色 | **废弃，并入 `manager`** | 迁移脚本把 `sql` → `manager`；`RolesGuard` 兼容期保留一个版本；`backend/src/common/roles.guard.ts` 的 `RoleName` 同步移除 `sql` | P0 |
| **D12** | 数据保留期 | **canceled 后 90 天** | 平台后台删除任务：`canceled_at + 90d` 触发硬删；删除前 7 天发提醒；写进合同模板 | P6 |

### 11.15.1 决策对实现的硬性约束（编码时必须遵守）

1. **D2 + D3**：`TenantCtx` 现在就要包含 `dataSourceKey`；即使 P0 只有共享库，所有 Repository 取连接也必须经过
   `TenantDataSourceManager.get(ctx)`，不要在 P0 里直接 `getRepository()` —— 否则 P6 接独立库要全量返工。
2. **D1**：`tenant_modules` 必须支持 `source='addon'`，即"套餐外的单模块开通"；`ModuleGuard` 只判断
   `status IN ('active','trial')` 且未过期，**不关心来源**。
3. **D4**：不写注册接口；但 `POST /platform/tenants` 必须能一次完成
   「建租户 + 建租户管理员 + 建试用订阅 + 展开套餐模块」，且在同一事务内。
4. **D7**：`feature_flags` 表必须在 P0 建好（key=`agent.print.submit`），否则 P4 无法灰度。
5. **D11**：迁移后 `roles.guard.ts` 的 `RoleName` 类型要收敛，禁止再出现 `'sql'`；
   `docs/10-dev-handover.md` §10.5.4 的角色列表同步更新。
6. **D12**：`tenants` 需要 `canceled_at` 字段（P0 加），删除任务读取它。

### 11.15.2 变更记录

| 日期 | 变更 | 原因 |
| --- | --- | --- |
| 2026-11-04 | D1–D12 全部按推荐值锁定 | 产品负责人确认 |
| 2026-11-04 | **P0 落地并通过 §11.11.1 验收**（`backend/scripts/p0-acceptance.sh` 62 项断言；细节见 docs/10 §10.15） | 按 §11.11 排期执行 |
| 2026-11-04 | §11.15.1 第 5 条「`RoleName` 禁止再出现 `sql`」**延后一个版本执行**：兼容期保留 `LegacyRoleName` + `RoleAlias` 双向别名 | 现网只有 `admin/operator/sql/viewer` 四个账号，直接删会让 `@Roles('sql')` 路由当场 403。D11 结论不变，只是收口时间挪到 §11.12.3 兼容期结束 |
| 2026-11-04 | §11.5.2 的 `tenants.status VARCHAR` 未采用，保持 `SMALLINT(1/0)`；`role_permissions` 主键仍是 `role` 字符串 + 可空 `role_id` | 前者要推翻 `auth.service` 的 `status !== 1` 判定且无收益（生命周期已由 `subscriptions.status` + `canceled_at` 表达，D12 满足）；后者属 §11.12.2 第 4 步之后的切换 |
| 2026-11-04 | §11.16 的套餐模块集合**暂不套用**：BASIC 仍含 `templates/ai/serial/users`，`inventory/masterdata/bom/alert` 不进套餐（只走 D1 加购） | P0 的硬约束是「现有租户零回归」，default 租户在 BASIC；按 §11.16 重排会让它当场失去模板/AI/用户管理权限。价格口径需产品重新确认后再改 seed |
| 2026-11-04 | §11.15.1 第 1 条「所有取连接必须经 `TenantDataSourceManager.get(ctx)`」**部分落地**：P0 只在 `provision.service` 事务内使用（含 `applyTenantScope`），普通查询链路仍直接 `@InjectRepository` | 钩子、类型、`dataSourceKey` 已就位；全量替换集中在 P6 接独立库/RLS 时做，避免 P0 铺开无收益的改动面 |
| 2026-11-04 | **P1 前端动态化落地**（`apps/console` + `web/`；细节见 docs/10 §10.16），§11.11 P1 行标记完成 | 按 §11.11 排期执行 |
| 2026-11-04 | §11.10「动态路由 \| 由 `/auth/me` 的 `menus` 生成」实现为**静态路由表 + 守卫按 `menus`/`modules`/`permissions` 校验**，没有用 `router.addRoute()` 动态注册 | 路由必须有组件映射，路由表本身就是前端源码的一部分，动态注册只是把同一份表换个写法；真正要后端说了算的是「可见性、排序、入口裁剪」，这三项已完全由 `me.menus` 决定（菜单不再硬编码）。新增页面仍需在前端加一条路由 + `menu.catalog.ts` 一条目录项 |
| 2026-11-04 | `serial` 模块已订阅（BASIC 内含）但**不进菜单**：`serial-sequences` 只实现了 `segment-preview`，没有列表/CRUD 接口 | 避免前端出现点进去就 404/空白的入口；P2 补 CRUD 时再加目录项 |
| 2026-11-05 | **全局入参校验底座落地**（docs/10 §10.17）：全局 `ValidationPipe` + 9 个 DTO 文件覆盖 40/45 个 `@Body()`；缺 `content` 建模板由 500 变 400 + 中文明细；`class-validator` 挪进 dependencies；验收脚本 62→65 项 | P1 遗留的「根因还留着」（缺字段 → TypeORM 23502 → 500），P2 平台后台会新增一批写接口，先把门装上 |
| 2026-11-05 | 修复 console `apiResetUserPassword` 字段名 bug：一直发 `{ password }`，后端收 `newPassword`，**console 重置密码必失败** | 单测 + curl 复核过；`web/js/api.js` 本来就是对的 |
| 2026-11-05 | **ESLint 基线落地**（backend + apps/console，flat config 0 error；24 文件 29 处死代码清理） | docs/10 §10.9 #12；只立门禁不搞洁癖，存量 any 不治理 |
| 2026-11-05 | **P2 平台运营落地**：platform_users 独立身份（scope=platform），P0 时代「租户 admin JWT 直调 /platform 写接口」的口子关闭；目录查询改混合守卫（平台运营或租户 admin 可读） | §11.6.2 的设计如此；租户身份进运营接口本来就是 P0 的临时放行 |
| 2026-11-05 | 到期提醒任务按「启动+每 24h 扫描打 WARN + 看板 expiringSoon」实现，未接消息推送 | P3 做计费时一并接通知通道 |
| 2026-11-05 | **P3 计费闭环落地**（docs/10 §10.19）：usage_meters/usage_daily/quotas/invoices/payments 五表 + plans.price_cents（分）；print_labels/ai_generate 两个真实计量事件；4033 硬上限带升级引导；账单 draft→issued→paid/overdue/void + D5 手动收款。偏差：①表放 public schema（同 P0/P2，未建 platform. schema）；②聚合为「写路径即时累加 + 每小时幂等重算」而非纯定时任务；③**续费/到期提醒仍未接消息通道**（通知基建缺失，console.warn 保留）；④发票（税务）未做 | §11.11 P3 排期；D5 决议如此 |
| 2026-11-05 | `GET /platform/plans` 响应补 `priceCents`；platform-admin 的同名 GET 被目录版路由遮蔽（注册顺序），前端价格数据源实际在 PlatformController 版 | 出账基准要在运营端可见；遮蔽是 P2 遗留，行为无害，已注释在 modules.service |
| 2026-11-05 | **P4 Agent/MCP 落地**（docs/10 §10.20）：agent_clients/agent_tokens/agent_approvals/external_mcp_servers 四表（§11.5.3 原样，后两张建表不接线）；`/agent/v1`（whoami/tools/tools/:tool/resources，AgentTokenGuard：sha256 存储 + scope/模块/配额三级检查）；`lfagent_` token 签发与租户侧 `/agents` 管理（scope ⊆ 创建者权限、默认只读）；stdio MCP server（apps/mcp-server，@modelcontextprotocol/sdk 低层 API，启动即从后端拉工具清单注册）；`agent_calls` 计量 + 4033 配额复用 P3 底座。偏差：①为满足 §11.11.2「无库存数据」验收，**新建库存最小读模型**（materials/warehouses/stock_batches/boms/bom_items，只读，无租户 REST/WMS 写路径）；②§11.7.2 模板权限点 `print:template:*` 按库内真实码 `template:read/write` 执行；③写工具（templates.create/update、inventory.adjust/transfer、print.submit_job）**只注册目录无执行器**（400 占位），approval 流、限流、Streamable HTTP、MCP resources/prompts 声明均留 P5；④approvals REST 端点为明确 400 占位 | §11.11 P4 排期；D7/D9/D10 决议如此 |
| 2026-11-05 | 权限字典补 `bom:shortage:read`、`inventory:stock:transfer`、`alert:event:ack`；legacy `admin` 角色显式补授新码 | §11.7.2 工具矩阵需要而 P0 未种；admin 此前只种 4 个 sys 码靠 SUPER_ROLES 兜底，Agent scope 校验需要完整字典 |
| 2026-11-05 | **P5 Agent 增强落地**（docs/10 §10.21）：5 个写/高危工具接执行器（templates.create/update、inventory.adjust/transfer、print.submit_job）+ 新增 `print.get_status`；`tool_idempotency` 表 + claim/finish/release 幂等（同键同参重放原结果、异参 409/4036）；`agent_approvals` 接线成完整审批流（pending→approved→consumed / rejected / expired，批准后 5 分钟一次性，args_hash 剔除 `approval_id` 后取指纹）；Agent 维度限流（Redis 固定窗口 + feature_flags `rollout.rpm`，Redis 故障退进程内）；`audit_logs.actor_type` 新列 + agent 调用结构化审计；租户侧 `/agents/approvals` 三件套 + 新权限码 `sys:agent:approve`；apps/mcp-server 增 **Streamable HTTP**（一 token 一会话）+ resources/prompts 声明。偏差：①`tool_idempotency` DDL 文档未给，自拟；②限流阈值复用 `feature_flags` 而非新表/环境变量；③`need_approval` 用 **HTTP 202 + 正常信封**承载（不是 4xx）；④写工具**强制** `idempotency_key`（§11.7.4 只建议）；⑤`print.estimate/wait_for_job/cancel_job`、`ai.*`、`alerts.*` 仍未注册；⑥审批只做后端 REST，console 前端「待确认」页留后续 | §11.11 P5 排期；D7/D8/D9 决议如此 |
| 2026-11-04 | `GET /subscription` 响应新增 `moduleDetails`（名称/图标/说明/`isCore`），原 `modules`（code 数组）保持不变 | 设计稿没定义该字段；只回 code 的话订阅页只能把英文码当模块名显示。加字段而非改形状，验收脚本 E/F 段断言不受影响 |
| 2026-11-04 | 修 `DELETE /backups/:id`：后端 `remove()` 原来标的是 `@Post(':id')`，与 docs/10 §10.3 的约定和前端调用都不一致 | 前端「删除备份」一直 404；顺带补 `@RequirePermission('backup:write')`（原先只有 `@Roles('admin')`，缺 L1 权限点判定） |
| 2026-11-04 | `web/`（零构建原生前端，§11.10 未覆盖）同步改为权限点优先 + 角色兜底，并按订阅模块裁剪主标签页；**`features`（D7 灰度）在该前端无处挂载**，未接入 | 现网仍有用户直接用 `web/`；它读同一个 `/auth/me`，不做裁剪就会出现「前端能点、后端 403」。`web/index.html` 的 AI 视图没有透视矫正按钮，`ai.vision` 开关没有可挂的 UI，未做猜测性映射 |

---

## 11.16 附录：模块清单（已确认）

| module_code | 名称 | 依赖 | 核心 | 售卖方式（已确认） |
| --- | --- | --- | --- | --- |
| `print` | 标签设计打印 | — | ✅ | 所有套餐必含 |
| `ai` | AI 生成模板 | `print` | | PRO 起，按次限额 |
| `inventory` | 库存管理 | `masterdata` | | 加购模块 |
| `bom` | 齐套率 | `inventory` | | 加购模块 |
| `alert` | 呆滞/效期预警 | `inventory` | | 加购或 PRO 含 |
| `masterdata` | 基础资料（物料/仓库/供应商） | — | ✅ | 随库存自动开通 |
| `agent` | 智能体接入（MCP） | `print` | | **PRO 起（D8 已确认对外售卖）** |

套餐（已确认）：

| 套餐 | 含模块 | 座位 | 打印额度 | 定位 |
| --- | --- | --- | --- | --- |
| BASIC | `print` `masterdata` | 5 | 1 万张/月 | 小作坊、单店 |
| PRO | `print` `masterdata` `ai` `alert` `agent` | 20 | 5 万张/月 | 中型工厂 |
| ENTERPRISE | 全部 + 私有化可选 | 不限 | 定制 | 大客户 |
