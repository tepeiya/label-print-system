-- =============================================================================
-- saas_p4_agent.sql —— P4 Agent/MCP（docs/11 §11.5.3 Agent 层 + §11.7 只读工具数据面）
--
-- 执行顺序：saas_p0.sql → saas_p0_roles.sql → saas_p2_platform.sql → saas_p3_billing.sql → 本文件
-- 执行方式：su postgres -c "psql -h /tmp -p 5433 -U labelflow -d labelflow -f backend/scripts/saas_p4_agent.sql"
--
-- 内容：
--   1. Agent 层四张表（§11.5.3 原样；agent_approvals / external_mcp_servers 建表不接线，流程在 P5）
--   2. 库存最小读模型（materials / warehouses / stock_batches / boms / bom_items）
--      —— P4 只服务 6 个只读工具与「无数据返回空数组+友好摘要」验收；完整 WMS（出入库单、
--      调拨流水、预警引擎）在 P5/P6 的 inventory 域补齐，届时以本模型为底扩展。
--   3. 权限字典补 3 个码 + 角色授权（§11.7.2 工具矩阵需要的落库权限点）
--
-- 与文档的偏离（记入 docs/10 §10.20）：
--   ① 同样落 public schema（dev 库未建 per-tenant schema，延续 P0–P3 偏离说明）；
--   ② 文档工具矩阵写模板权限点是 print:template:read/write，库内实际码是两段式
--      template:read / template:write（P0 已种），本文件不动典，Agent 工具用库内真实码。
-- =============================================================================

BEGIN;

-- 1. Agent 层（§11.5.3 原样） --------------------------------------------------

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
CREATE INDEX IF NOT EXISTS ix_agenttok_client ON agent_tokens (agent_client_id);
CREATE INDEX IF NOT EXISTS ix_agenttok_tenant ON agent_tokens (tenant_id);

-- P4 只建表：审批流（need_approval → 确认 → consumed）在 P5 接线
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

-- D10：反向接入外部 MCP，预留不实现
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

-- 2. 库存最小读模型 -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS warehouses (
    id         BIGSERIAL PRIMARY KEY,
    tenant_id  BIGINT NOT NULL,
    code       VARCHAR(40) NOT NULL,
    name       VARCHAR(80) NOT NULL,
    active     BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS ix_warehouses_tenant ON warehouses (tenant_id);

CREATE TABLE IF NOT EXISTS materials (
    id           BIGSERIAL PRIMARY KEY,
    tenant_id    BIGINT NOT NULL,
    code         VARCHAR(40) NOT NULL,
    name         VARCHAR(120) NOT NULL,
    spec         VARCHAR(120),
    unit         VARCHAR(20) NOT NULL DEFAULT '件',
    category     VARCHAR(60),
    safety_stock NUMERIC(14,3) NOT NULL DEFAULT 0,
    active       BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS ix_materials_tenant ON materials (tenant_id);
CREATE INDEX IF NOT EXISTS ix_materials_tenant_name ON materials (tenant_id, name);

CREATE TABLE IF NOT EXISTS stock_batches (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       BIGINT NOT NULL,
    material_id     BIGINT NOT NULL REFERENCES materials(id),
    warehouse_id    BIGINT NOT NULL REFERENCES warehouses(id),
    batch_no        VARCHAR(60) NOT NULL,
    qty             NUMERIC(14,3) NOT NULL DEFAULT 0,
    unit_cost_cents BIGINT,
    produced_at     DATE,
    expires_at      DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, material_id, warehouse_id, batch_no)
);
CREATE INDEX IF NOT EXISTS ix_stock_batches_tenant ON stock_batches (tenant_id);
CREATE INDEX IF NOT EXISTS ix_stock_batches_material ON stock_batches (material_id);
CREATE INDEX IF NOT EXISTS ix_stock_batches_expiry ON stock_batches (tenant_id, expires_at);

CREATE TABLE IF NOT EXISTS boms (
    id                  BIGSERIAL PRIMARY KEY,
    tenant_id           BIGINT NOT NULL,
    product_material_id BIGINT NOT NULL REFERENCES materials(id),
    version             VARCHAR(20) NOT NULL DEFAULT 'v1',
    status              VARCHAR(20) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('draft','active','inactive')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, product_material_id, version)
);
CREATE INDEX IF NOT EXISTS ix_boms_tenant ON boms (tenant_id);

CREATE TABLE IF NOT EXISTS bom_items (
    id          BIGSERIAL PRIMARY KEY,
    bom_id      BIGINT NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
    material_id BIGINT NOT NULL REFERENCES materials(id),
    qty_per     NUMERIC(14,6) NOT NULL CHECK (qty_per > 0),
    loss_rate   NUMERIC(6,4) NOT NULL DEFAULT 0 CHECK (loss_rate >= 0 AND loss_rate < 1)
);
CREATE INDEX IF NOT EXISTS ix_bom_items_bom ON bom_items (bom_id);
-- 演示/重导脚本 ON CONFLICT (bom_id, material_id) 依赖此唯一键
CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_items_bom_material ON bom_items (bom_id, material_id);

-- 3. 权限字典补充（§11.7.2 缺的码）与角色授权 ---------------------------------

INSERT INTO permissions (code, module_code, resource, action, description, name) VALUES
  ('bom:shortage:read',       'bom',       'shortage', 'read',     '查缺料明细（bom.explain_shortage）', '查缺料'),
  ('inventory:stock:transfer','inventory', 'stock',    'transfer', '库存调拨（inventory.transfer，高危）', '库存调拨'),
  ('alert:event:ack',         'alert',     'event',    'ack',      '处理预警（alerts.ack）', '处理预警')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  -- 超管两码对齐：新码同时给 legacy admin（库里 admin 只种了 4 个 sys 码，其余靠 SUPER_ROLES 兜底，
  -- 这里显式补齐，便于 Agent token「scope ⊆ 创建者权限」校验时拿到完整字典）
  ('admin','bom:shortage:read'), ('admin','inventory:stock:transfer'), ('admin','alert:event:ack'),
  ('tenant_admin','bom:shortage:read'), ('tenant_admin','inventory:stock:transfer'), ('tenant_admin','alert:event:ack'),
  -- 仓管：调拨/调整（§11.12.1 warehouse_keeper）
  ('warehouse_keeper','inventory:stock:transfer'),
  -- 主管：缺料可读（齐套/缺料是排产动作）
  ('manager','bom:shortage:read'),
  -- 只读角色：两个读码（齐套率已有 bom:kit:read，缺料明细补齐才能 explain_shortage）
  ('viewer','bom:shortage:read')
ON CONFLICT DO NOTHING;

-- 4. 配额基线说明：agent_calls 计量项（§11.3.5，20000/月硬限）
--    quotas 按租户配置，运营侧 /platform/tenants/:id/quotas 维护；
--    演示租户可在验收脚本里直接 INSERT（meter='agent_calls', period='month', hard=20000）。

COMMIT;
