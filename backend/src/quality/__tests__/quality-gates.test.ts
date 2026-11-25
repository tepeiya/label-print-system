// 质量闸门纯计算单测（不 import 带装饰器的实体，避免 tsx 反射报错——见 docs/10 §10.39 约定）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkItemsForPass, checkItemsForFail, qcStatusFromResult, normalizeItems, canEditInspection, nextDocNo } from '../iqc.calc';
import { checkBeforeRelease, targetBatchStatus, checkOpinion, stalePending } from '../release.calc';
import { summarizeSteps, checkBeforeSubmit, checkBeforeApprove, nextSeq } from '../batch-record.calc';

// ---------------------------------------------------------------- IQC

test('检验判定：全项 PASS 才能判合格', () => {
  assert.equal(checkItemsForPass([]).ok, false);
  assert.equal(checkItemsForPass([{ itemName: '外观', verdict: 'PASS' }]).ok, true);
  const bad = checkItemsForPass([
    { itemName: '外观', verdict: 'PASS' },
    { itemName: '尺寸', verdict: 'FAIL' },
  ]);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /尺寸/);
});

test('检验判定：全 NA 视为没检，不能判合格', () => {
  const r = checkItemsForPass([{ itemName: '密封性', verdict: 'NA' }]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /NA/);
});

test('检验判定：判不合格必须至少有一条 FAIL（不能凭感觉判死）', () => {
  assert.equal(checkItemsForFail([{ itemName: '外观', verdict: 'PASS' }]).ok, false);
  assert.equal(checkItemsForFail([{ itemName: '外观', verdict: 'FAIL' }]).ok, true);
});

test('检验结论 → 库存质量状态', () => {
  assert.equal(qcStatusFromResult('PASS'), 'RELEASED');
  assert.equal(qcStatusFromResult('FAIL'), 'REJECTED');
});

test('检验项归一：丢空名、序号连续', () => {
  const out = normalizeItems([
    { itemName: '外观', verdict: 'PASS', seq: 7 },
    { itemName: '  ', verdict: 'PASS' },
    { itemName: '无菌', verdict: 'NA' },
  ] as any);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((i) => i.seq), [1, 2]);
  assert.equal(out[1].itemName, '无菌');
});

test('已判定的检验单不可回改', () => {
  assert.equal(canEditInspection('DRAFT').ok, true);
  assert.equal(canEditInspection('PASS').ok, false);
  assert.equal(canEditInspection('FAIL').ok, false);
  assert.equal(canEditInspection('CANCELLED').ok, false);
});

test('单号：QC-YYYYMMDD-NNNN 递增补零', () => {
  const d = new Date(2026, 10, 25);
  assert.equal(nextDocNo('QC', d, 0), 'QC-20261125-0001');
  assert.equal(nextDocNo('QC', d, 41), 'QC-20261125-0042');
});

// ---------------------------------------------------------------- 放行

test('放行闸门：只有 PENDING 的放行单能签', () => {
  const r = checkBeforeRelease({ releaseStatus: 'RELEASED', batchStatus: 'PENDING', qcRequired: false });
  assert.equal(r.ok, false);
});

test('放行闸门：批次已合格时拒绝重复放行', () => {
  const r = checkBeforeRelease({ releaseStatus: 'PENDING', batchStatus: 'RELEASED', qcRequired: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /重复/);
});

test('放行闸门：冻结批次不能直接放行', () => {
  const r = checkBeforeRelease({ releaseStatus: 'PENDING', batchStatus: 'FROZEN', qcRequired: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /冻结/);
});

test('放行闸门：要求检验的物料必须挂 PASS 的检验单', () => {
  const noInsp = checkBeforeRelease({ releaseStatus: 'PENDING', batchStatus: 'PENDING', qcRequired: true });
  assert.equal(noInsp.ok, false);
  assert.match(noInsp.reason, /未关联检验单/);

  const draft = checkBeforeRelease({
    releaseStatus: 'PENDING', batchStatus: 'PENDING', qcRequired: true, inspectionStatus: 'DRAFT',
  });
  assert.equal(draft.ok, false);

  const pass = checkBeforeRelease({
    releaseStatus: 'PENDING', batchStatus: 'PENDING', qcRequired: true, inspectionStatus: 'PASS',
  });
  assert.equal(pass.ok, true);
});

test('放行决定 → 批次状态', () => {
  assert.equal(targetBatchStatus('APPROVE'), 'RELEASED');
  assert.equal(targetBatchStatus('REJECT'), 'REJECTED');
});

test('驳回必须填原因', () => {
  assert.equal(checkOpinion('REJECT', '').ok, false);
  assert.equal(checkOpinion('REJECT', '标签打印错位').ok, true);
  assert.equal(checkOpinion('APPROVE', '').ok, true);
});

test('超期未签批：只算 PENDING 且超过 N 天', () => {
  const now = new Date('2026-11-25T10:00:00Z');
  const rows = [
    { status: 'PENDING', submittedAt: '2026-11-20T00:00:00Z' },
    { status: 'PENDING', submittedAt: '2026-11-24T20:00:00Z' },
    { status: 'RELEASED', submittedAt: '2026-11-10T00:00:00Z' },
  ];
  assert.equal(stalePending(rows, 3, now).length, 1);
});

// ---------------------------------------------------------------- 批记录

const step = (over: Partial<any> = {}) => ({
  seq: 1, stepName: '配料', operator: '张三', result: 'PASS' as const, ...over,
});

test('批记录：工序缺操作人不能提交', () => {
  const r = checkBeforeSubmit([step({ operator: '' })]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /操作人/);
});

test('批记录：没有任何工序不能提交', () => {
  assert.equal(checkBeforeSubmit([]).ok, false);
});

test('批记录：FAIL 工序必须写备注，写了只告警不阻塞', () => {
  const noRemark = checkBeforeSubmit([step({ result: 'FAIL' })]);
  assert.equal(noRemark.ok, false);

  const withRemark = checkBeforeSubmit([step({ result: 'FAIL', remark: '初包装封口温度偏低，已返工' })]);
  assert.equal(withRemark.ok, true);
  assert.equal(withRemark.warnings.length, 1);
});

test('批记录：时间倒挂拦截', () => {
  const r = checkBeforeSubmit([step({
    startedAt: '2026-11-25T10:00:00Z', endedAt: '2026-11-25T09:00:00Z',
  })]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /结束时间/);
});

test('批记录汇总：PASS/FAIL/NA 计数与缺项定位', () => {
  const sum = summarizeSteps([
    step({ seq: 1 }),
    step({ seq: 2, result: 'FAIL' }),
    step({ seq: 3, result: 'NA', equipment: null }),
    step({ seq: 4, operator: '' }),
  ]);
  assert.equal(sum.total, 4);
  assert.equal(sum.pass, 2);
  assert.equal(sum.fail, 1);
  assert.equal(sum.na, 1);
  assert.deepEqual(sum.incomplete, [4]);
});

test('批记录批准：只有已提交的可批', () => {
  assert.equal(checkBeforeApprove('SUBMITTED').ok, true);
  assert.equal(checkBeforeApprove('OPEN').ok, false);
  assert.equal(checkBeforeApprove('APPROVED').ok, false);
  assert.equal(checkBeforeApprove('REJECTED').ok, false);
});

test('工序号自动递增', () => {
  assert.equal(nextSeq([]), 1);
  assert.equal(nextSeq([{ seq: 1 }, { seq: 3 }]), 4);
});
