// MCP 打印工具补全集结测试：三个新工具的注册/权限/风险/模块/写工具幂等判定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findTool, visibleTools, isWriteTool, needsApproval, AGENT_TOOLS,
} from '../tool.catalog';
import { batchOverLimit } from '../rate.calc';

const EXPECTED: Array<{
  name: string; risk: 'read' | 'write' | 'high'; permission: string; modules: string[];
}> = [
  { name: 'print.estimate', risk: 'read', permission: 'print:job:read', modules: ['print'] },
  { name: 'print.wait_for_job', risk: 'read', permission: 'print:job:read', modules: ['print'] },
  { name: 'print.cancel_job', risk: 'write', permission: 'print:job:write', modules: ['print'] },
];

test('三个打印工具已注册且 implemented=true，权限/风险/模块正确', () => {
  for (const e of EXPECTED) {
    const t = findTool(e.name);
    assert.ok(t, `${e.name} 应已注册`);
    assert.equal(t!.implemented, true, `${e.name} 应有执行器`);
    assert.equal(t!.risk, e.risk);
    assert.equal(t!.permission, e.permission);
    assert.deepEqual(t!.modules, e.modules);
  }
});

test('print.cancel_job 是写工具（强制幂等键），但不是高危（无需审批）', () => {
  const cancel = findTool('print.cancel_job')!;
  assert.equal(isWriteTool(cancel), true, '取消是写操作，须带 idempotency_key');
  assert.equal(needsApproval(cancel), false, '取消非高危，不需审批单');
  const estimate = findTool('print.estimate')!;
  const wait = findTool('print.wait_for_job')!;
  assert.equal(isWriteTool(estimate), false);
  assert.equal(isWriteTool(wait), false);
});

test('工具可见性：有 print:job:read 能看到 estimate/wait，cancel 需 print:job:write', () => {
  const read = visibleTools(['print:job:read'], ['print']).map((t) => t.name);
  assert.ok(read.includes('print.estimate'));
  assert.ok(read.includes('print.wait_for_job'));
  assert.ok(!read.includes('print.cancel_job'));
  const all = visibleTools(['print:job:read', 'print:job:write'], ['print']).map((t) => t.name);
  assert.ok(all.includes('print.cancel_job'));
  const noModule = visibleTools(['print:job:read', 'print:job:write'], ['inventory']).map((t) => t.name);
  assert.ok(!noModule.some((n) => n.startsWith('print.')));
});

test('工具目录无重名，且新工具 inputSchema 必填项合理', () => {
  const names = AGENT_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, '工具名不得重复');
  assert.deepEqual(findTool('print.wait_for_job')!.inputSchema.required, ['job_id']);
  assert.deepEqual(findTool('print.cancel_job')!.inputSchema.required, ['job_id', 'idempotency_key']);
  assert.deepEqual(findTool('print.estimate')!.inputSchema.required, []);
});

test('批量护栏仍生效（estimate 复用同一口径）', () => {
  assert.equal(batchOverLimit(3, [{}, {}], 500), null);
  assert.ok(batchOverLimit(501, undefined, 500));
  assert.ok(batchOverLimit(1, Array.from({ length: 501 }, () => ({})) as any, 500));
});

// ---------------------------------------------------------------------------
// 2026-11-21 补齐的 7 个工具（§10.37）
// ---------------------------------------------------------------------------
const NEW_EXPECTED: Array<{
  name: string; risk: 'read' | 'write'; permission: string; modules: string[]; required: string[];
}> = [
  { name: 'print.list_jobs', risk: 'read', permission: 'print:job:read', modules: ['print'], required: [] },
  { name: 'print.retry_job', risk: 'write', permission: 'print:job:write', modules: ['print'], required: ['job_id', 'idempotency_key'] },
  { name: 'print.preview', risk: 'read', permission: 'print:job:read', modules: ['print'], required: ['template'] },
  { name: 'print.commands', risk: 'read', permission: 'print:job:read', modules: ['print'], required: ['template'] },
  { name: 'printers.list', risk: 'read', permission: 'print:job:read', modules: ['print'], required: [] },
  { name: 'printers.status', risk: 'read', permission: 'print:job:read', modules: ['print'], required: ['id'] },
  { name: 'datasource.refresh', risk: 'write', permission: 'datasource:write', modules: ['datasource'], required: ['id', 'idempotency_key'] },
];

test('补齐全量工具已注册 implemented=true，权限/风险/模块/必填项正确', () => {
  for (const e of NEW_EXPECTED) {
    const t = findTool(e.name);
    assert.ok(t, `${e.name} 应已注册`);
    assert.equal(t!.implemented, true, `${e.name} 应有执行器`);
    assert.equal(t!.risk, e.risk);
    assert.equal(t!.permission, e.permission);
    assert.deepEqual(t!.modules, e.modules);
    assert.deepEqual((t!.inputSchema as any).required, e.required, `${e.name} 必填项`);
  }
});

test('新写工具强制幂等键、非高危；只读工具不要求幂等', () => {
  for (const e of NEW_EXPECTED) {
    const t = findTool(e.name)!;
    if (e.risk === 'write') {
      assert.equal(isWriteTool(t), true, `${e.name} 是写工具`);
      assert.equal(needsApproval(t), false, `${e.name} 非高危无需审批`);
    } else {
      assert.equal(isWriteTool(t), false, `${e.name} 是只读工具`);
    }
  }
});

test('新工具可见性：print 工具需 print 模块；datasource.refresh 需 datasource 模块与 datasource:write', () => {
  const read = visibleTools(['print:job:read'], ['print']).map((t) => t.name);
  for (const n of ['print.list_jobs', 'print.preview', 'print.commands', 'printers.list', 'printers.status']) {
    assert.ok(read.includes(n), `${n} 应对 print:job:read 可见`);
  }
  assert.ok(!read.includes('print.retry_job'), 'retry_job 需 print:job:write');
  const allPrint = visibleTools(['print:job:read', 'print:job:write'], ['print']).map((t) => t.name);
  assert.ok(allPrint.includes('print.retry_job'));
  assert.ok(!allPrint.includes('datasource.refresh'), '无 datasource 模块不可见');
  const ds = visibleTools(['datasource:write'], ['datasource']).map((t) => t.name);
  assert.ok(ds.includes('datasource.refresh'));
  assert.ok(!visibleTools(['datasource:read'], ['datasource']).map((t) => t.name).includes('datasource.refresh'), '只读 scope 看不到写工具');
});

test('工具目录仍无重名（含 7 个新工具）', () => {
  const names = AGENT_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, '工具名不得重复');
  assert.ok(names.length >= 29, `工具总数应 ≥ 29，实际 ${names.length}`);
});
