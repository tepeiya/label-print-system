-- =============================================================================
-- 呆滞 / 效期预警（alert 模块，docs/11 §11.16）
-- 依赖：saas_p0.sql（permissions / role_permissions / modules）、
--       inventory_masterdata.sql + inventory_stock_moves.sql（materials / stock_batches / stock_moves）。
-- alert_rules：租户级预警规则（库龄阈值 / 严重阈值 / 最低数量 / 效期天数）。
-- alert_events：扫描落库的预警事件，fingerprint 做幂等去重。
-- 幂等，可重复执行；所有带 tenant_id 的表启用 RLS，与其余业务表同口径。
-- =============================================================================

CREATE TABLE IF NOT EXISTS alert_rules (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,
    name          VARCHAR(80) NOT NULL,
    type          VARCHAR(20) NOT NULL DEFAULT 'dead_stock'
                  CHECK (type IN ('dead_stock','expiring')),
    idle_days     INT NOT NULL DEFAULT 90,
    critical_days INT NOT NULL DEFAULT 180,
    expiry_days   INT NOT NULL DEFAULT 30,
    min_qty       NUMERIC(14,3) NOT NULL DEFAULT 0,
    category      VARCHAR(120),
    active        BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_alert_rules_tenant ON alert_rules (tenant_id, active);

CREATE TABLE IF NOT EXISTS alert_events (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,
    rule_id       BIGINT NOT NULL,
    type          VARCHAR(20) NOT NULL DEFAULT 'dead_stock',
    fingerprint   VARCHAR(240) NOT NULL,
    material_id   BIGINT NOT NULL,
    code          VARCHAR(40) NOT NULL,
    name          VARCHAR(120) NOT NULL,
    spec          VARCHAR(120),
    unit          VARCHAR(20) NOT NULL DEFAULT '件',
    warehouse_id  BIGINT NOT NULL,
    warehouse     VARCHAR(80),
    batch_no      VARCHAR(60) NOT NULL DEFAULT '',
    qty           NUMERIC(14,3) NOT NULL DEFAULT 0,
    age_days      INT NOT NULL DEFAULT 0,
    last_out_days INT NOT NULL DEFAULT 0,
    days_to_expire INT,
    severity      VARCHAR(16) NOT NULL DEFAULT 'warning'
                  CHECK (severity IN ('warning','critical')),
    status        VARCHAR(16) NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','ack','ignored')),
    ack_by        VARCHAR(80),
    ack_note      VARCHAR(300),
    ack_at        TIMESTAMP,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_alert_event_fp UNIQUE (tenant_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS ix_alert_events_tenant ON alert_events (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_alert_events_rule ON alert_events (tenant_id, rule_id);

-- RLS：与其余带 tenant_id 的业务表同口径
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'labelflow_app') THEN
        ALTER TABLE public.alert_rules ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation ON public.alert_rules;
        CREATE POLICY tenant_isolation ON public.alert_rules
            AS PERMISSIVE FOR ALL TO labelflow_app
            USING  (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
            WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

        ALTER TABLE public.alert_events ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation ON public.alert_events;
        CREATE POLICY tenant_isolation ON public.alert_events
            AS PERMISSIVE FOR ALL TO labelflow_app
            USING  (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
            WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
    END IF;
END
$$;

-- 权限点：docs/11 §11.4.2 已列 alert:event:ack，但 saas_p0_roles.sql 旧种子漏插，这里补齐
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM permissions WHERE code = 'alert:event:ack') THEN
        INSERT INTO permissions (code, module_code, resource, action, description, name, is_high_risk)
        VALUES ('alert:event:ack', 'alert', 'event', 'ack', '处理预警', '处理预警', FALSE);
    END IF;
END
$$;

-- 角色授权：管理员/主管全量；操作员、仓管可处理；采购/只读仅查看
DO $$
DECLARE
    role_code text;
    perm_code text;
BEGIN
    FOREACH role_code IN ARRAY ARRAY['tenant_admin','manager']::text[] LOOP
        FOREACH perm_code IN ARRAY ARRAY['alert:event:read','alert:event:ack','alert:rule:configure']::text[] LOOP
            IF NOT EXISTS (SELECT 1 FROM role_permissions WHERE role = role_code AND permission_code = perm_code) THEN
                INSERT INTO role_permissions (role, permission_code) VALUES (role_code, perm_code);
            END IF;
        END LOOP;
    END LOOP;

    FOREACH role_code IN ARRAY ARRAY['operator','warehouse_keeper']::text[] LOOP
        FOREACH perm_code IN ARRAY ARRAY['alert:event:read','alert:event:ack']::text[] LOOP
            IF NOT EXISTS (SELECT 1 FROM role_permissions WHERE role = role_code AND permission_code = perm_code) THEN
                INSERT INTO role_permissions (role, permission_code) VALUES (role_code, perm_code);
            END IF;
        END LOOP;
    END LOOP;

    FOREACH role_code IN ARRAY ARRAY['purchaser','viewer']::text[] LOOP
        IF NOT EXISTS (SELECT 1 FROM role_permissions WHERE role = role_code AND permission_code = 'alert:event:read') THEN
            INSERT INTO role_permissions (role, permission_code) VALUES (role_code, 'alert:event:read');
        END IF;
    END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- 上线提示：alert 是加购模块（modules.code='alert'，依赖 inventory，saas_p0_roles.sql 已种）。
-- 需给目标租户开通后，@RequireModule('alert') 才放行、菜单才出现：
--   INSERT INTO tenant_modules (tenant_id, module_code, status, source)
--   VALUES (<租户ID>, 'alert', 'active', 'manual')
--   ON CONFLICT (tenant_id, module_code) DO NOTHING;
-- 若要随套餐自动开通，可在 plan_modules 为 PRO 补一行（D1：当前为加购，默认不改套餐）。
-- -----------------------------------------------------------------------------
