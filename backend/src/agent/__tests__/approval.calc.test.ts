// P5 纯函数单测：approval.calc（§11.7.6 审批流 / §11.7.7 护栏 3）
// 约束：不 import 实体类（tsx 无装饰器元数据），只测纯逻辑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_MESSAGES, PENDING_TTL_MS, USE_WINDOW_MS, approvalArgsHash, approvedExpiryAt,
  compactPreview, isDryRun, isStale, pendingExpiryAt, shouldConsume, stripApprovalId,
} from '../approval.calc';
import { approvalVerdict } from '../approval.calc';
import { argsHash } from '../agent.calc';

const NOW = new Date('2026-11-05T08:00:00.000Z');
const H = (args: Record<string, any>) => approvalArgsHash(args);

// ---------------------------------------------------------------- 参数指纹

test('stripApprovalId: 只摘 approval_id，dry_run 等业务参数保留', () => {
  assert.deepEqual(stripApprovalId({ approval_id: 7, qty: -3, dry_run: true }), { qty: -3, dry_run: true });
  assert.deepEqual(stripApprovalId(null), {});
  assert.equal(stripApprovalId({ approval_id: 7, qty: 1 }).approval_id, undefined);
});

test('approvalArgsHash: 带上/不带 approval_id 指纹一致（重试必须对得上）', () => {
  const base = { sku: 'A-01', warehouse: 3, qty: -5 };
  assert.equal(H({ ...base, approval_id: 12 }), H(base));
  assert.notEqual(H({ ...base, approval_id: 12 }), H({ ...base, qty: -6 }));
});

test('approvalArgsHash: 与 agent.calc.argsHash 同源（键顺序无关）', () => {
  assert.equal(H({ b: 2, a: 1 }), argsHash({ a: 1, b: 2 }));
  assert.match(H({ a: 1 }), /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------- TTL

test('pendingExpiryAt / approvedExpiryAt: 30 分钟待确认、批准后 5 分钟可用', () => {
  assert.equal(pendingExpiryAt(NOW).getTime() - NOW.getTime(), PENDING_TTL_MS);
  assert.equal(approvedExpiryAt(NOW).getTime() - NOW.getTime(), USE_WINDOW_MS);
  assert.equal(PENDING_TTL_MS, 30 * 60 * 1000);
  assert.equal(USE_WINDOW_MS, 5 * 60 * 1000);
});

// ---------------------------------------------------------------- 状态机判定

const row = (over: Partial<{ status: string; expiresAt: Date | string | null; argsHash: string }> = {}) => ({
  status: 'approved',
  expiresAt: new Date(NOW.getTime() + 60_000),
  argsHash: H({ sku: 'A-01', qty: -5 }),
  ...over,
});
const GOOD = H({ sku: 'A-01', qty: -5 });

test('approvalVerdict: 批准且在窗口内、参数一致 → ok', () => {
  assert.equal(approvalVerdict(row(), GOOD, NOW), 'ok');
});

test('approvalVerdict: 五种状态各自语义，提示语都是中文非空', () => {
  const cases: [any, string][] = [
    [null, 'not_found'],
    [row({ status: 'pending' }), 'pending'],
    [row({ status: 'rejected' }), 'rejected'],
    [row({ status: 'consumed' }), 'consumed'],
    [row({ status: 'expired' }), 'expired'],
    [row({ status: 'weird' }), 'not_found'],
  ];
  for (const [r, want] of cases) {
    assert.equal(approvalVerdict(r, GOOD, NOW), want);
    assert.ok(APPROVAL_MESSAGES[want as any].length > 3);
  }
});

test('approvalVerdict: 参数被改过 → hash_mismatch（护栏 3，禁止执行）', () => {
  assert.equal(approvalVerdict(row(), H({ sku: 'A-01', qty: -99 }), NOW), 'hash_mismatch');
});

test('approvalVerdict: approved 超 5 分钟窗口 → expired；expiresAt 为字符串/空也能判', () => {
  const past = new Date(NOW.getTime() - 1);           // 到期时刻已过
  assert.equal(approvalVerdict(row({ expiresAt: past }), GOOD, NOW), 'expired');
  assert.equal(approvalVerdict(row({ expiresAt: past.toISOString() }), GOOD, NOW), 'expired');
  // 恰好等于到期时刻 → 视为已过
  assert.equal(approvalVerdict(row({ expiresAt: NOW }), GOOD, NOW), 'expired');
  // null / 脏值 无到期约束
  assert.equal(approvalVerdict(row({ expiresAt: null }), GOOD, NOW), 'ok');
  assert.equal(approvalVerdict(row({ expiresAt: 'not-a-date' as any }), GOOD, NOW), 'ok');
});

test('approvalVerdict: pending/consumed 优先于到期判定（不因超时谎报 expired）', () => {
  const past = new Date(NOW.getTime() - 1000);
  assert.equal(approvalVerdict(row({ status: 'pending', expiresAt: past }), GOOD, NOW), 'pending');
  assert.equal(approvalVerdict(row({ status: 'consumed', expiresAt: past }), GOOD, NOW), 'consumed');
});

test('shouldConsume: 只有 ok 才一次性置 consumed', () => {
  assert.equal(shouldConsume('ok'), true);
  for (const r of ['pending', 'expired', 'consumed', 'rejected', 'hash_mismatch', 'not_found'] as const) {
    assert.equal(shouldConsume(r), false);
  }
});

test('isStale: 仅 pending/approved 参与过期扫描，consumed/rejected 不算脏', () => {
  const past = new Date(NOW.getTime() - 1);
  const future = new Date(NOW.getTime() + 60_000);
  assert.equal(isStale(row({ expiresAt: past }), NOW), true);
  assert.equal(isStale(row({ status: 'pending', expiresAt: past }), NOW), true);
  assert.equal(isStale(row({ expiresAt: future }), NOW), false);
  assert.equal(isStale(row({ status: 'consumed', expiresAt: past }), NOW), false);
  assert.equal(isStale(row({ status: 'rejected', expiresAt: past }), NOW), false);
  assert.equal(isStale(row({ status: 'pending', expiresAt: null }), NOW), false);
});

// ---------------------------------------------------------------- 预览 / dry_run

test('compactPreview: 长字符串折行、数组折叠计数、大对象只留 keys，且不带 approval_id', () => {
  const p = compactPreview({
    approval_id: 9,
    name: 'x'.repeat(300),
    rows: [{ a: 1 }, { a: 2 }, { a: 3 }],
    content: { elements: new Array(60).fill(0).map((_, i) => ({ id: i, type: 'text', x: i, y: i, w: i, h: i, text: `t${i}` })) },
    qty: -3,
  }, 120);
  assert.equal((p as any).approval_id, undefined);
  assert.equal(p.qty, -3);
  assert.ok(String(p.name).includes('共 300 字符'));
  assert.deepEqual((p.rows as any).sample.length, 2);
  assert.equal((p.rows as any).__array, 3);
  assert.ok((p.content as any).__json);
  assert.ok(Array.isArray((p.content as any).keys));
});

test('compactPreview: 短对象原样保留，便于审批人在后台看清改了什么', () => {
  const p = compactPreview({ sku: 'A-01', wh: 3 });
  assert.deepEqual(p, { sku: 'A-01', wh: 3 });
  assert.deepEqual(compactPreview(null), {});
});

test('isDryRun: 只有 dry_run===true 才免审批（字符串 true 不算，防误放行）', () => {
  assert.equal(isDryRun({ dry_run: true }), true);
  assert.equal(isDryRun({ dry_run: 'true' }), false);
  assert.equal(isDryRun({}), false);
  assert.equal(isDryRun(null), false);
});
