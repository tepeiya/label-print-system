// B2.2 上线前加固单测：启动期配置强校验（fail-fast）
// 约束：纯函数，不连库、不启 Nest；严格模式通过参数注入，不篡改全局 process.env。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readConfigSnapshot, isStrict, auditConfig, assertProductionConfig, DEV_DEFAULTS,
  type ConfigSnapshot,
} from '../config.guard';

const GOOD: ConfigSnapshot = {
  nodeEnv: 'production',
  jwtSecret: 'J'.repeat(64),
  sqlSecretKey: 'S'.repeat(64),
  dbUser: 'labelflow_app',
  dbPassword: 'Str0ng!DbPass#2026',
  dbRlsUser: 'labelflow_app',
  dbRlsPassword: 'An0ther!RlsSecret',
  brandingDevVerify: '0',
};

const DEV: ConfigSnapshot = {
  nodeEnv: 'development',
  jwtSecret: DEV_DEFAULTS.jwt,
  sqlSecretKey: `${DEV_DEFAULTS.sqlKeyPrefix}-0123456789`,
  dbPassword: 'labelflow',
  dbRlsUser: 'labelflow_app',
  dbRlsPassword: 'labelflow_app',
  brandingDevVerify: '1',
};

test('readConfigSnapshot: 从传入 env 取快照，DB_PASS 优先于 DB_PASSWORD', () => {
  const s = readConfigSnapshot({
    NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), SQL_SECRET_KEY: 'y'.repeat(40),
    DB_USER: 'app', DB_PASS: 'p1', DB_PASSWORD: 'p2', DB_RLS_USER: 'rls',
    DB_RLS_PASSWORD: 'rp', BRANDING_DEV_VERIFY: '1',
  } as NodeJS.ProcessEnv);
  assert.equal(s.nodeEnv, 'production');
  assert.equal(s.jwtSecret, 'x'.repeat(40));
  assert.equal(s.dbPassword, 'p1');
  assert.equal(s.dbRlsPassword, 'rp');
  assert.equal(s.brandingDevVerify, '1');
});

test('isStrict: production 或 LABELFLOW_STRICT_CONFIG=1 才严格', () => {
  assert.equal(isStrict({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), true);
  assert.equal(isStrict({ NODE_ENV: 'PRODUCTION' } as NodeJS.ProcessEnv), true);
  assert.equal(isStrict({ NODE_ENV: 'development', LABELFLOW_STRICT_CONFIG: '1' } as NodeJS.ProcessEnv), true);
  assert.equal(isStrict({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), false);
  assert.equal(isStrict({} as NodeJS.ProcessEnv), false);
});

test('auditConfig: 合规生产配置零问题', () => {
  assert.deepEqual(auditConfig(GOOD, true), []);
});

test('auditConfig: dev 默认值逐项命中 block（JWT / SQL / DB / RLS）', () => {
  const issues = auditConfig(DEV, true);
  const keys = issues.map((i) => i.key);
  for (const k of ['JWT_SECRET', 'SQL_SECRET_KEY', 'DB_PASS', 'DB_RLS_PASSWORD', 'BRANDING_DEV_VERIFY']) {
    assert.ok(keys.includes(k), `应命中 ${k}`);
  }
  assert.ok(issues.every((i) => i.level === 'block'));
});

test('checkJwt: 长度不足只是 warn，dev 值才是 block', () => {
  const s = { ...GOOD, jwtSecret: 'short-but-custom' };
  const issues = auditConfig(s, true);
  assert.equal(issues.find((i) => i.key === 'JWT_SECRET')?.level, 'warn');
  assert.equal(issues.some((i) => i.level === 'block'), false);
});

test('checkDbPassword: RLS 口令与用户名相同 = 无口令，必须 block；大小写不敏感', () => {
  const s = { ...GOOD, dbRlsPassword: 'LABELFLOW_APP' };
  assert.equal(auditConfig(s, true).find((i) => i.key === 'DB_RLS_PASSWORD')?.level, 'block');
  const ok = { ...GOOD, dbRlsPassword: 'Different!Secret' };
  assert.equal(auditConfig(ok, true).some((i) => i.key === 'DB_RLS_PASSWORD'), false);
});

test('checkBranding: dev 逃生口只在严格模式被拦（旧实现恒为 block，此处回归）', () => {
  const on = { ...GOOD, brandingDevVerify: '1' };
  assert.equal(auditConfig(on, false).some((i) => i.key === 'BRANDING_DEV_VERIFY'), false);
  assert.equal(auditConfig(on, true).some((i) => i.key === 'BRANDING_DEV_VERIFY'), true);
  assert.equal(auditConfig({ ...on, brandingDevVerify: 'true' }, true).length, 1);
  assert.equal(auditConfig({ ...on, brandingDevVerify: '0' }, true).length, 0);
});

test('assertProductionConfig: 生产严格模式拒绝启动，错误里不含任何密钥明文', () => {
  assert.throws(
    () => assertProductionConfig(DEV, { strict: true }),
    (e: Error) => {
      assert.match(e.message, /CONFIG FAIL-FAST/);
      assert.match(e.message, /JWT_SECRET/);
      assert.ok(!e.message.includes('Str0ng'), '不得回显口令');
      assert.ok(!e.message.includes(DEV.sqlSecretKey), '不得回显 SQL 密钥');
      return true;
    },
  );
});

test('assertProductionConfig: dev 模式只返回问题清单，绝不抛错（不打断本地开发）', () => {
  const issues = assertProductionConfig(DEV, { strict: false });
  assert.ok(issues.length >= 4);
  assert.equal(issues.some((i) => i.level === 'block'), true);
});

test('assertProductionConfig: 合规生产配置正常返回空清单', () => {
  assert.deepEqual(assertProductionConfig(GOOD, { strict: true }), []);
});

test('assertProductionConfig: 严格模式可由 NODE_ENV 推导，无需显式注入', () => {
  assert.throws(() => assertProductionConfig({ ...DEV, nodeEnv: 'production' }), /CONFIG FAIL-FAST/);
  assert.doesNotThrow(() => assertProductionConfig({ ...DEV, nodeEnv: 'test' }));
});
