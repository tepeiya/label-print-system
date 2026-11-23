// 工单状态机单测：合法/非法流转全组合 + 守卫
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransit, isFinalStatus, WO_STATUS, WO_ACTION } from '../issuing/services/wo-transit';

const baseCtx = { lineCount: 1, kitChecked: true, allDone: false, force: false, openReturns: 0 };

test('正常主链路 CREATED→RELEASED→ISSUING→ISSUED→CLOSED', () => {
  let s = 'CREATED';
  for (const [a, want] of [['RELEASE', 'RELEASED'], ['ISSUE_START', 'ISSUING'], ['ISSUE_POST', 'ISSUING'], ['ISSUE_DONE', 'ISSUED'], ['CLOSE', 'CLOSED']] as const) {
    const r = canTransit(s, a, { ...baseCtx, allDone: a === 'ISSUE_DONE' });
    assert.equal(r.ok, true, `${s}+${a} 应通过`);
    assert.equal(r.to, want);
    s = r.to!;
  }
});

test('取消：仅 CREATED / RELEASED', () => {
  assert.equal(canTransit('CREATED', 'CANCEL').ok, true);
  assert.equal(canTransit('RELEASED', 'CANCEL').ok, true);
  for (const s of ['ISSUING', 'ISSUED', 'CLOSED', 'CANCELLED']) {
    assert.equal(canTransit(s, 'CANCEL').ok, false, `${s} 不应可取消`);
  }
});

test('改行：仅 CREATED', () => {
  assert.equal(canTransit('CREATED', 'EDIT').ok, true);
  for (const s of ['RELEASED', 'ISSUING', 'ISSUED']) assert.equal(canTransit(s, 'EDIT').ok, false);
});

test('下发守卫：无行 / 未做齐套检查都拒绝', () => {
  assert.match(canTransit('CREATED', 'RELEASE', { lineCount: 0, kitChecked: true }).reason!, /没有明细行/);
  assert.match(canTransit('CREATED', 'RELEASE', { lineCount: 2, kitChecked: false }).reason!, /齐套检查/);
});

test('发料完成：未发满且无 force 拒绝；force 放行并标 forced', () => {
  const no = canTransit('ISSUING', 'ISSUE_DONE', { allDone: false });
  assert.equal(no.ok, false);
  assert.match(no.reason!, /force/);
  const forced = canTransit('ISSUING', 'ISSUE_DONE', { allDone: false, force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.forced, true);
  assert.equal(canTransit('ISSUING', 'ISSUE_DONE', { allDone: true }).forced, undefined);
});

test('退料：仅 ISSUED，且回到 ISSUING', () => {
  const r = canTransit('ISSUED', 'RETURN');
  assert.equal(r.ok, true);
  assert.equal(r.to, 'ISSUING');
  assert.equal(canTransit('ISSUING', 'RETURN').ok, false);
});

test('关单守卫：有未结退料不能关', () => {
  assert.match(canTransit('ISSUED', 'CLOSE', { openReturns: 2 }).reason!, /2 笔未结退料/);
  assert.equal(canTransit('ISSUED', 'CLOSE', { openReturns: 0 }).ok, true);
});

test('终态不可流转', () => {
  for (const a of WO_ACTION) {
    assert.equal(canTransit('CLOSED', a).ok, false, `CLOSED+${a} 应拒绝`);
    assert.equal(canTransit('CANCELLED', a).ok, false, `CANCELLED+${a} 应拒绝`);
  }
  assert.equal(isFinalStatus('CLOSED'), true);
  assert.equal(isFinalStatus('CANCELLED'), true);
  assert.equal(isFinalStatus('ISSUING'), false);
});

test('未知状态 / 未知动作给出明确原因', () => {
  assert.match(canTransit('BOGUS', 'RELEASE').reason!, /未知工单状态/);
  assert.match(canTransit('CREATED', 'TELEPORT').reason!, /未知动作/);
});

test('全组合扫描：除白名单外一律非法（防止误加流转）', () => {
  const legal: Array<[string, string]> = [
    ['CREATED', 'RELEASE'], ['CREATED', 'CANCEL'], ['CREATED', 'EDIT'],
    ['RELEASED', 'ISSUE_START'], ['RELEASED', 'CANCEL'],
    ['ISSUING', 'ISSUE_POST'], ['ISSUING', 'ISSUE_DONE'],
    ['ISSUED', 'RETURN'], ['ISSUED', 'CLOSE'],
  ];
  for (const s of WO_STATUS) {
    for (const a of WO_ACTION) {
      const allowed = legal.some(([ls, la]) => ls === s && la === a);
      // 用宽松 ctx（避免守卫误判）
      const r = canTransit(s, a, { lineCount: 1, kitChecked: true, allDone: true, force: true, openReturns: 0 });
      assert.equal(r.ok, allowed, `${s}+${a} 期望 ${allowed ? '通过' : '拒绝'}`);
    }
  }
});
