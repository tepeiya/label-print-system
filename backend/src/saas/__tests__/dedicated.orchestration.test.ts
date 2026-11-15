// P6.2 阶段 B 单测：开通编排状态机（纯函数，重点验证「校验不过绝不切 key」红线）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STEP_ORDER, STEP_LABELS, nextStep, stateTransition, canSwitchKey,
  rollbackPlan, verifyRowCounts, orchestrationSummary,
} from '../platform-admin/dedicated.orchestration.calc';

test('STEP_ORDER: 注册在 DDL 之后，switch_key 永远最后一步', () => {
  assert.equal(STEP_ORDER[0], 'create_database');
  assert.equal(STEP_ORDER[STEP_ORDER.length - 1], 'switch_key');
  assert.ok(STEP_ORDER.indexOf('verify_counts') < STEP_ORDER.indexOf('switch_key'));
  assert.ok(STEP_ORDER.indexOf('run_ddl') < STEP_ORDER.indexOf('register_datasource'),
    'registerFromUrl 会自检库结构，必须先跑 DDL');
  assert.equal(STEP_ORDER.length, new Set(STEP_ORDER).size);
  assert.ok(STEP_ORDER.every((s) => STEP_LABELS[s]));
});

test('nextStep: 顺序推进，末端返回 null，未知步骤不越界', () => {
  assert.equal(nextStep(null), 'create_database');
  assert.equal(nextStep('create_database'), 'run_ddl');
  assert.equal(nextStep('register_datasource'), 'switch_key');
  assert.equal(nextStep('switch_key'), null);
  assert.equal(nextStep('bogus' as any), null);
});

test('stateTransition: 正常路径 idle→running→verifying→switching→succeeded', () => {
  assert.equal(stateTransition('idle', 'start'), 'running');
  assert.equal(stateTransition('running', 'verify_ok'), 'verifying');
  assert.equal(stateTransition('verifying', 'step_ok'), 'switching');
  assert.equal(stateTransition('switching', 'switch_ok'), 'succeeded');
  assert.equal(stateTransition('succeeded', 'start'), 'succeeded', '终态不可回退');
});

test('stateTransition: 任一步失败进 rolling_back，最终 failed', () => {
  assert.equal(stateTransition('running', 'step_failed'), 'rolling_back');
  assert.equal(stateTransition('verifying', 'verify_failed'), 'rolling_back');
  assert.equal(stateTransition('switching', 'step_failed'), 'rolling_back');
  assert.equal(stateTransition('rolling_back', 'step_ok'), 'rolling_back', '回滚中不接受成功事件');
  assert.equal(stateTransition('rolling_back', 'rollback_done'), 'failed');
  assert.equal(stateTransition('failed', 'start'), 'failed');
});

test('canSwitchKey: 必须完成全部前置步骤 + 校验通过 + 处于验证/切换态', () => {
  const all = STEP_ORDER.slice(0, -1);
  assert.equal(canSwitchKey(all, true, 'verifying'), true);
  assert.equal(canSwitchKey(all, true, 'switching'), true);
  assert.equal(canSwitchKey(all, false, 'verifying'), false, '校验没过绝不切');
  assert.equal(canSwitchKey(all, true, 'running'), false, '状态不对也不切');
  assert.equal(canSwitchKey(all.filter((s) => s !== 'verify_counts'), true, 'verifying'), false);
  assert.equal(canSwitchKey([], true, 'switching'), false);
});

test('rollbackPlan: 逆序回滚，切 key 优先切回，删库不自动执行', () => {
  const plan = rollbackPlan(STEP_ORDER);
  assert.deepEqual(plan.map((a) => a.step), [...STEP_ORDER].reverse());
  assert.equal(plan[0].step, 'switch_key');
  assert.equal(plan[0].auto, true);
  assert.equal(plan.find((a) => a.step === 'create_database')?.auto, false, 'DROP DATABASE 留人工');
  assert.equal(rollbackPlan([]).length, 0);
});

test('verifyRowCounts: 逐表比对，空表也要求两边一致，不能「没表也算过」', () => {
  assert.equal(verifyRowCounts({ templates: 3, users: 2 }, { templates: 3, users: 2 }).ok, true);
  const bad = verifyRowCounts({ templates: 3, users: 2 }, { templates: 3, users: 1 });
  assert.equal(bad.ok, false);
  assert.ok(bad.mismatches.some((m) => m.includes('users')));
  assert.equal(verifyRowCounts({}, {}).ok, false, '一张表都没校验不算通过');
  assert.equal(verifyRowCounts({ templates: 0 }, {}).ok, true, '两边都 0 合法');
  assert.equal(verifyRowCounts({ templates: 1 }, { templates: 1, extra: 5 }).ok, false, '目标库莫名多表也要报');
});

test('orchestrationSummary: 可打印且不含任何 DSN/凭据', () => {
  const s = orchestrationSummary('acme-prod', 42);
  assert.equal(s.tenantId, 42);
  assert.equal(s.dataSourceKey, 'acme-prod');
  assert.equal(s.steps.length, STEP_ORDER.length);
  assert.equal(s.steps[0].order, 1);
  assert.match(s.gate, /verify_counts/);
  assert.ok(!JSON.stringify(s).includes('postgres://'));
  assert.ok(!JSON.stringify(s).includes('password'));
});
