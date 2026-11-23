// UdiTraceService 单测（内存仓库替身，不连库）：建档幂等 / 状态机拦截 / 事件幂等 / 追溯查询
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenantStorage, TenantCtx } from '../../common/tenant.context';
import { UdiTraceService } from '../udi.trace.service';
import { validateSscc } from '../udi.trace.calc';

const CTX: TenantCtx = {
  tenantId: 7, userId: 11, roles: ['operator'], modules: ['udi.compliance'], permissions: [],
  plan: 'PRO', features: {}, dataScopes: null, dataSourceKey: 'default',
};

class MemRepo {
  rows: any[] = [];
  private seq = 1;
  async findOne({ where }: any) {
    return this.rows.find((r) => this.match(r, where)) ?? null;
  }
  create(obj: any) { return obj; }
  async save(obj: any) {
    if (obj.id) {
      const i = this.rows.findIndex((r) => r.id === obj.id);
      if (i >= 0) this.rows[i] = obj;
    } else {
      obj.id = this.seq++;
      obj.createdAt = obj.createdAt ?? new Date();
      this.rows.push(obj);
    }
    return obj;
  }
  async find({ where, order, take }: any = {}) {
    let list = this.rows.filter((r) => this.match(r, where));
    if (order?.occurredAt || order?.createdAt) {
      const k = order.occurredAt ? 'occurredAt' : 'createdAt';
      const dir = (order.occurredAt ?? order.createdAt) === 'ASC' ? 1 : -1;
      list = [...list].sort((a, b) => (new Date(a[k]).getTime() - new Date(b[k]).getTime()) * dir);
    }
    return take ? list.slice(0, take) : list;
    order; take;
  }
  async findAndCount(args: any = {}) {
    const list = await this.find(args);
    return [list, list.length];
  }
  private match(r: any, where: any): boolean {
    if (!where) return true;
    const flat = Array.isArray(where) ? where : [where];
    return flat.some((w) => Object.entries(w).every(([k, v]: any) => {
      if (v && typeof v === 'object' && '_type' in v && v._type === 'between') {
        const t = new Date(r[k]).getTime();
        return t >= v.min.getTime() && t <= v.max.getTime();
      }
      return r[k] === v;
    }));
  }
}

function build() {
  const units = new MemRepo();
  const packages = new MemRepo();
  const events = new MemRepo();
  const auditCalls: any[] = [];
  const svc = new UdiTraceService(units as any, packages as any, events as any, { write: (...a: any[]) => { auditCalls.push(a); return Promise.resolve(); } } as any);
  return { svc, units, packages, events, auditCalls };
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run(CTX, fn);
}

const HRI = '(01)06901234567892(17)271231(10)LOT202611(21)SN0001';

test('建档：写入单元 + BUILD 事件，状态 REGISTERED', async () => {
  const { svc, units, events } = build();
  const r = await run(() => svc.registerUnits([{ code: HRI }]));
  assert.equal(r.created, 1);
  assert.equal(r.failed, 0);
  assert.equal(units.rows.length, 1);
  assert.equal(units.rows[0].gtin, '06901234567892');
  assert.equal(units.rows[0].lot, 'LOT202611');
  assert.equal(units.rows[0].serial, 'SN0001');
  assert.equal(units.rows[0].expiryDate, '2027-12-31');
  assert.equal(units.rows[0].status, 'REGISTERED');
  assert.equal(events.rows[0].eventType, 'BUILD');
});

test('建档：同一码重复提交按"已存在"返回，不重复建', async () => {
  const { svc, units } = build();
  await run(() => svc.registerUnits([{ code: HRI }]));
  const r = await run(() => svc.registerUnits([{ code: HRI }]));
  assert.equal(r.created, 0);
  assert.equal(r.existed, 1);
  assert.equal(units.rows.length, 1);
});

test('建档：部分成功——坏行进 errors，好行照建', async () => {
  const { svc, units } = build();
  const r = await run(() => svc.registerUnits([
    { gtin: '6901234567892', lot: 'L1', serial: 'S1' },   // 合法
    { gtin: '6901234567890', lot: 'L2', serial: 'S2' },   // 校验位错
    { gtin: '6901234567892' },                            // 批号序列号都缺
  ]));
  assert.equal(r.created, 1);
  assert.equal(r.failed, 2);
  assert.equal(units.rows.length, 1);
  assert.match(r.errors.map((e) => e.message).join('|'), /校验位|至少填一个/);
});

test('建档：超过 5000 行直接拒绝（保护接口）', async () => {
  const { svc } = build();
  await assert.rejects(
    () => run(() => svc.registerUnits(Array.from({ length: 5001 }, () => ({ gtin: '6901234567892', lot: 'L' })))),
    /5000/,
  );
});

test('事件：PRINT 推进到 PRINTED，并写 printedAt / 状态前后值', async () => {
  const { svc, units, events } = build();
  const reg = await run(() => svc.registerUnits([{ code: HRI }]));
  const key = reg.units[0].udiKey;
  const r = await run(() => svc.recordEvent({ udiKey: key, eventType: 'PRINT', refType: 'PRINT_JOB', refNo: 'JOB-1' }));
  assert.equal(r.status, 'PRINTED');
  assert.equal(units.rows[0].status, 'PRINTED');
  assert.ok(units.rows[0].printedAt);
  const last = events.rows[events.rows.length - 1];
  assert.equal(last.statusBefore, 'REGISTERED');
  assert.equal(last.statusAfter, 'PRINTED');
});

test('事件：未收货就发料 → 409 冲突（状态机拦截）', async () => {
  const { svc } = build();
  const reg = await run(() => svc.registerUnits([{ code: HRI }]));
  await assert.rejects(
    () => run(() => svc.recordEvent({ udiKey: reg.units[0].udiKey, eventType: 'ISSUE' })),
    (e: any) => e.status === 409 || /RECEIVE/.test(e.message),
  );
});

test('事件：幂等键重复提交回放，不产生第二条', async () => {
  const { svc, events } = build();
  const reg = await run(() => svc.registerUnits([{ code: HRI }]));
  const args = {
    udiKey: reg.units[0].udiKey, eventType: 'RECEIVE', refType: 'RECEIPT', refNo: 'RC-1', idemKey: 'rc-1:unit',
  };
  const a = await run(() => svc.recordEvent(args));
  const b = await run(() => svc.recordEvent(args));
  assert.equal(a.idempotent, false);
  assert.equal(b.idempotent, true);
  assert.equal(events.rows.filter((e) => e.eventType === 'RECEIVE').length, 1);
});

test('事件：作废后不可再收货', async () => {
  const { svc } = build();
  const reg = await run(() => svc.registerUnits([{ code: HRI }]));
  await run(() => svc.recordEvent({ udiKey: reg.units[0].udiKey, eventType: 'VOID' }));
  await assert.rejects(
    () => run(() => svc.recordEvent({ udiKey: reg.units[0].udiKey, eventType: 'RECEIVE' })),
    /作废/,
  );
});

test('事件：扫原始码（元素串）也能定位到单元', async () => {
  const { svc } = build();
  const reg = await run(() => svc.registerUnits([{ code: HRI }]));
  await run(() => svc.recordEvent({ udiKey: reg.units[0].udiKey, eventType: 'PRINT' }));
  const r = await run(() => svc.recordEvent({ code: HRI, eventType: 'RECEIVE', refType: 'RECEIPT', refNo: 'RC-2' }));
  assert.equal(r.status, 'RECEIVED');
});

test('追溯：单品挂包装后，按 SSCC 能查到包内单元与祖先链', async () => {
  const { svc } = build();
  // 造一个合法 SSCC（前 17 位任取，末位算校验位）
  const body = '10614141123456789';
  const sscc = body + '0';
  const fixed = (() => {
    for (let d = 0; d <= 9; d++) if (validateSscc(body + String(d)).ok) return body + String(d);
    return sscc;
  })();
  await run(() => svc.upsertPackages([{ sscc: fixed, level: 'CARTON', qty: 10 }]));
  await run(() => svc.registerUnits([{ code: HRI, packageSscc: fixed }]));

  // 键里的有效期是 GS1 6 位（271231），与 encode 产出的 unitKey 一字不差
  const byKey = await run(() => svc.trace(['06901234567892', 'LOT202611', 'SN0001', '271231'].join('|')));
  assert.equal(byKey.found, 'unit');
  assert.equal(byKey.unit!.serial, 'SN0001');
  assert.ok(byKey.timeline.length >= 1);
  assert.equal(byKey.unit!.packageSscc, fixed);

  const bySscc = await run(() => svc.trace(fixed));
  assert.equal(bySscc.found, 'package');
  assert.equal(bySscc.hierarchy!.unitsInPackage.length, 1);
  assert.deepEqual(bySscc.hierarchy!.path, [fixed]);
});

test('追溯：未建档的码给出明确 404', async () => {
  const { svc } = build();
  await assert.rejects(() => run(() => svc.trace('(01)06901234567892(10)LOTX')), /未建档|未找到/);
});

test('包装：SSCC 校验位不对直接拒绝', async () => {
  const { svc } = build();
  await assert.rejects(
    () => run(() => svc.upsertPackages([{ sscc: '106141411234567890' }])),
    /校验位|18 位/,
  );
});

test('查询：单元列表按状态过滤', async () => {
  const { svc } = build();
  await run(() => svc.registerUnits([{ code: HRI }]));
  const printed = await run(() => svc.listUnits({ status: 'PRINTED' }));
  assert.equal(printed.total, 0);
  const all = await run(() => svc.listUnits({}));
  assert.equal(all.total, 1);
  assert.equal(all.items[0].status, 'REGISTERED');
});

// ---------------------------------------------------------------- U5：WMS 联动
test('联动收货：扫码自动建档并记 RECEIVE，状态 RECEIVED', async () => {
  const { svc, units, events } = build();
  const r = await run(() => svc.receiveByScan({ code: HRI, receiptNo: 'GRN-1', lineNo: 1, skuCode: 'FG-001', qty: 3 }));
  assert.equal(r.created, true);
  assert.equal(r.idempotent, false);
  assert.equal(r.udiKey, '06901234567892|LOT202611|SN0001|271231');
  assert.equal(r.status, 'RECEIVED');
  assert.equal(units.rows[0].status, 'RECEIVED');
  const receiveEvents = events.rows.filter((e: any) => e.eventType === 'RECEIVE');
  assert.equal(receiveEvents.length, 1);
  assert.equal(receiveEvents[0].refType, 'wms_receipt');
  assert.equal(receiveEvents[0].refNo, 'GRN-1');
  assert.equal(receiveEvents[0].detail.lineNo, 1);
});

test('联动收货：同一单重复扫 → 事件幂等回放，不重复写事件', async () => {
  const { svc, events } = build();
  await run(() => svc.receiveByScan({ code: HRI, receiptNo: 'GRN-1', skuCode: 'FG-001', qty: 1 }));
  const r2 = await run(() => svc.receiveByScan({ code: HRI, receiptNo: 'GRN-1', skuCode: 'FG-001', qty: 1 }));
  assert.equal(r2.idempotent, true);
  assert.equal(events.rows.filter((e: any) => e.eventType === 'RECEIVE').length, 1);
  assert.equal(r2.status, 'RECEIVED');
});

test('联动收货：换一张收货单重复收同一码 → 409（一码不可多收）', async () => {
  const { svc } = build();
  await run(() => svc.receiveByScan({ code: HRI, receiptNo: 'GRN-1' }));
  await assert.rejects(() => run(() => svc.receiveByScan({ code: HRI, receiptNo: 'GRN-2' })), /已收货/);
});

test('联动发料：未收货的单元拒绝发料', async () => {
  const { svc } = build();
  await run(() => svc.registerUnits([{ code: HRI }]));
  await assert.rejects(
    () => run(() => svc.issueByScan({ code: HRI, woNo: 'WO20261123', lineNo: 1 })),
    /尚未收货/,
  );
});

test('联动发料：收货后可发料，重复提交幂等', async () => {
  const { svc, units, events } = build();
  await run(() => svc.receiveByScan({ code: HRI, receiptNo: 'GRN-1' }));
  const r = await run(() => svc.issueByScan({ code: HRI, woNo: 'WO20261123', lineNo: 2, materialCode: 'RM-001' }));
  assert.equal(r.status, 'ISSUED');
  assert.equal(r.idempotent, false);
  assert.equal(units.rows[0].status, 'ISSUED');
  const issueEv = events.rows.find((e: any) => e.eventType === 'ISSUE');
  assert.equal(issueEv.refType, 'wms_work_order');
  assert.equal(issueEv.refNo, 'WO20261123');
  assert.equal(issueEv.detail.lineNo, 2);

  const r2 = await run(() => svc.issueByScan({ code: HRI, woNo: 'WO20261123', lineNo: 2, materialCode: 'RM-001' }));
  assert.equal(r2.idempotent, true);
  assert.equal(events.rows.filter((e: any) => e.eventType === 'ISSUE').length, 1);
});

test('联动发料：已发料后换个工单再发 → 409', async () => {
  const { svc } = build();
  await run(() => svc.receiveByScan({ code: HRI, receiptNo: 'GRN-1' }));
  await run(() => svc.issueByScan({ code: HRI, woNo: 'WO-A', lineNo: 1 }));
  await assert.rejects(() => run(() => svc.issueByScan({ code: HRI, woNo: 'WO-B', lineNo: 1 })), /已发料/);
});

test('联动发料：未建档的码 → 404（必须先收货）', async () => {
  const { svc } = build();
  await assert.rejects(() => run(() => svc.issueByScan({ code: HRI, woNo: 'WO-A', lineNo: 1 })), /未建档/);
});

test('联动：已发料单元不可再收货', async () => {
  const { svc } = build();
  await run(() => svc.receiveByScan({ code: HRI, receiptNo: 'GRN-1' }));
  await run(() => svc.issueByScan({ code: HRI, woNo: 'WO-A', lineNo: 1 }));
  await assert.rejects(() => run(() => svc.receiveByScan({ code: HRI, receiptNo: 'GRN-2' })), /已发料/);
});
