-- ===== 种子数据 =====
-- tenants.status: 1=active
-- users.status: 1=active
-- user_roles.role: admin | operator | sql | viewer

INSERT INTO tenants (id, name, code, status, settings)
VALUES (1, 'Default Tenant', 'default', 1, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- admin / admin123
INSERT INTO users (id, tenant_id, username, password_hash, display_name, email, status)
VALUES (1, 1, 'admin', '$2a$10$buv9sEnjnabrRRQEfGIV.OpTRQgpDVIpW9O5dAbVb/V/hJFnsk0GC', 'Admin', 'admin@labelflow.local', 1)
ON CONFLICT DO NOTHING;
INSERT INTO user_roles (tenant_id, user_id, role) VALUES (1, 1, 'admin') ON CONFLICT DO NOTHING;

-- operator / op123
INSERT INTO users (id, tenant_id, username, password_hash, display_name, email, status)
VALUES (2, 1, 'operator', '$2a$10$JnFrB7qYs0jb23lvPwjzKuJzOmr7w.s5ZVM1.rnRe4iEb8.MzGvYa', 'Operator', 'op@labelflow.local', 1)
ON CONFLICT DO NOTHING;
INSERT INTO user_roles (tenant_id, user_id, role) VALUES (1, 2, 'operator') ON CONFLICT DO NOTHING;
