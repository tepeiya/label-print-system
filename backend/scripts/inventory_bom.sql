-- =============================================================================
-- BOM 齐套率模块 —— 角色授权补丁 + 上线提示（docs/11 §11.7 / §11.16）
-- BOM 权限点与模块目录已由 saas_p0_roles.sql 种下：
--   modules: bom（依赖 {inventory}，加购模块）
--   permissions: bom:kit:read / bom:shortage:read / bom:bom:write
-- 本脚本只补一处历史遗漏 + 给出租户开通说明，可重复执行（幂等）。
-- 说明：项目 synchronize=false，BOM 表结构（boms / bom_items）由既有初始化脚本
--       建立，本脚本不负责建表。
-- =============================================================================

-- 采购角色文档定义为「齐套 / 缺料查看」，p0 脚本仅种了 bom:kit:read，
-- 这里补齐缺料明细读权限，使 bom.explain_shortage / GET /inventory/bom/shortages 可用。
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM role_permissions
        WHERE role = 'purchaser' AND permission_code = 'bom:shortage:read'
    ) THEN
        INSERT INTO role_permissions (role, permission_code)
        VALUES ('purchaser', 'bom:shortage:read');
    END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 上线提示：bom 是加购模块（modules.code='bom'，依赖 inventory）。
-- 需给目标租户开通后，@RequireModule('bom') 才放行、菜单才出现：
--   INSERT INTO tenant_modules (tenant_id, module_code, status, source)
--   VALUES (<租户ID>, 'bom', 'active', 'manual')
--   ON CONFLICT (tenant_id, module_code) DO NOTHING;
-- 开通后模块依赖展开会自动带上 inventory（见 saas_p0_roles.sql 的 {inventory}）。
-- -----------------------------------------------------------------------------
