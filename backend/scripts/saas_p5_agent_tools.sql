-- =============================================================================
-- P5 Agent 增强 DDL（docs/11 §11.7.4 / §11.7.6 / §11.7.7 / docs/10 §10.21）
--
-- 内容：
--   1. tool_idempotency —— 写工具幂等表（§11.7.4「写操作幂等」+ §11.7.7 护栏 4）
--   2. audit_logs.actor_type —— 审计列规范化（§11.7.6 审计字段 actor_type=agent；
--      P4 时该语义放在 detail JSON 里，本阶段落列，存量行默认 'user'）
--   3. agent_approvals 索引 —— 审批列表 / 过期扫描的两条热查询
--   4. 权限字典补 sys:agent:approve（§11.6.1「高危操作确认：sys:agent:manage 或业务权限」）
--
-- 与文档的偏离（记入 docs/10 §10.21）：
--   ① 同样落 public schema（dev 库未建 per-tenant schema，延续 P0–P4 说明）；
--   ② tool_idempotency 表文档未给 DDL，字段按 §11.7.4/§11.7.6 语义自拟；
--   ③ 限流阈值不进新表：复用 feature_flags（key=agent.rate_limit，rollout={"rpm":N}），
--      运营可即时调整且不需要重启服务；无行 = 默认 60 次/分（§11.7.7 护栏 5）。
-- =============================================================================

BEGIN;

-- 1. 幂等表 ------------------------------------------------------------------
-- 唯一键 (tenant_id, tool, idem_key)：同 key 重放直接返回首次结果（不重复扣库存/打印）。
-- args_hash 与审批同源（键排序稳定 JSON 的 sha256）：同 key 换参数视为冲突，拒 409。
CREATE TABLE IF NOT EXISTS tool_idempotency (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       BIGINT NOT NULL,
    agent_client_id BIGINT NOT NULL,
    tool            VARCHAR(60) NOT NULL,
    idem_key        VARCHAR(80) NOT NULL,
    args_hash       VARCHAR(64) NOT NULL,
    result          JSONB,                          -- 首次成功返回的信封 {summary,data,warnings,next_actions}
    approval_id     BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_idem ON tool_idempotency (tenant_id, tool, idem_key);
CREATE INDEX IF NOT EXISTS ix_tool_idem_tenant_created ON tool_idempotency (tenant_id, created_at DESC);

-- 2. 审计列规范化 -------------------------------------------------------------
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_type VARCHAR(16) NOT NULL DEFAULT 'user';

-- 3. 审批查询索引 -------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_agentappr_client_status ON agent_approvals (agent_client_id, status);
CREATE INDEX IF NOT EXISTS ix_agentappr_open ON agent_approvals (tenant_id, status, created_at DESC);

-- 4. 权限字典 -----------------------------------------------------------------
-- sys:* 系权限点的 module_code 沿用 P0 字典的 'users'（permissions 有 FK 到 modules.code）
INSERT INTO permissions (code, module_code, resource, action, description, name) VALUES
  ('sys:agent:approve', 'users', 'agent', 'approve', '确认/驳回 Agent 高危操作（§11.7.6 审批流）', 'Agent 审批')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('admin','sys:agent:approve'), ('tenant_admin','sys:agent:approve'),
  -- 主管与仓管是「谁该为这次扣库存/打印负责」的业务确认人（§11.12.1 角色语义）
  ('manager','sys:agent:approve'), ('warehouse_keeper','sys:agent:approve')
ON CONFLICT DO NOTHING;

COMMIT;
