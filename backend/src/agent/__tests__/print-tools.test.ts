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
