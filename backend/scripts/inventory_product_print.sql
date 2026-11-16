-- =============================================================================
-- 产品绑定标签模板：一键打印条码/标签
-- 依赖：saas_p4_agent.sql（materials）、docs/03-database.sql（templates）
-- 幂等，可重复执行。
-- =============================================================================

ALTER TABLE materials ADD COLUMN IF NOT EXISTS template_id BIGINT REFERENCES templates(id);
CREATE INDEX IF NOT EXISTS ix_materials_template ON materials (tenant_id, template_id);
