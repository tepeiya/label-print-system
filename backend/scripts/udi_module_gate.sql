-- =============================================================================
-- UDI 订阅闸门：udi.compliance 提升为独立加购模块（2026-11-24）
--
-- 背景：UDI（赋码/追溯/合规留痕）此前对所有租户免费开放，等价于把 2.8–4.8 万的
--   医疗套件白送给了 999 元档客户（报价口径见 docs/18 §5）。本次接闸：
--   · 模块 code udi.compliance 单独成行，is_core=FALSE；
--   · 不写入任何 plan_modules —— 任何套餐都不会自动带出，必须单独授权（签套件或试用）；
--   · 控制器（udi.controller / udi.trace.controller）已挂 @RequireModule('udi.compliance')；
--   · 菜单「医疗 UDI」整组的 module 已改为 udi.compliance。
--
-- 授权方式（运营后台或 SQL）：
--   签套件  INSERT INTO tenant_modules (tenant_id, module_code, status, source)
--           VALUES (<tid>, 'udi.compliance', 'active', 'purchase');
--   给试用  status='trial', source='trial'（到期日由运营侧记录，到期改 'expired' 即收回）
--
-- 演示租户 default 保留入口（trial/gift），避免演示环境失去 UDI 菜单。
-- 幂等：可重复执行。
-- =============================================================================

INSERT INTO modules (code, name, description, icon, sort_order, is_core) VALUES
  ('udi.compliance', '医疗 UDI 合规套件',
   'UDI 赋码（GS1 DataMatrix）、追溯单元/包装、合规留痕报表；医疗器械场景独立加购',
   '🩺', 85, FALSE)
ON CONFLICT (code) DO NOTHING;

-- 演示租户：保留 UDI（trial 状态，收回只需 status='expired'）
INSERT INTO tenant_modules (tenant_id, module_code, status, source)
SELECT t.id, 'udi.compliance', 'trial', 'gift'
  FROM tenants t
 WHERE t.code = 'default'
ON CONFLICT (tenant_id, module_code) DO NOTHING;
