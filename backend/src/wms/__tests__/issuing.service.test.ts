// IssuingService 单测（内存仓库 + 假网关，不连库）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tenantStorage, TenantCtx } from '../../common/tenant.context';
import { IssuingService } from '../issuing/services/issuing.service';

const CTX: TenantCtx = {
  tenantId: 9, userId: 21, roles: ['warehouse_keeper'], modules: ['wms.issuing'], permissions: [],
  plan: 'PRO', features: {}, dataScopes: null, dataSourceKey: 'default',
};

class MemRepo {
  rows: any[] = [];
  private seq = 1;
  create(o: any) { return o; }
  async save(o: any) {
    if (o.id) {
      const i = this.rows.findIndex((r) => r.id === o.id);
      if (i >= 0) this.rows[i] = o; else this.rows.push(o);
    } else {
      o.id = this.seq++;
      this.rows.push(o);
    }
    return o;
  }
  async findOne({ where }: any) { return this.rows.find((r) => this.match(r, where)) ?? null; }
  async find({ where, order }: any = {}) {
    let list = this.rows.filter((r) => this.match(r, where));
    if (order?.lineNo) list = [...list].sort((a, b) => a.lineNo - b.lineNo);
    if (order?.id) list = [...list].sort((a, b) => a.id - b.id);
    return list;
  }
  async count({ where }: any) { return this.rows.filter((r) => this.match(r, where)).length; }
  async delete({ where }: any) {
    this.rows = this.rows.filter((r) => !this.match(r, where));
  }
  private match(r: any, where: any) {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => r[k] === v);
  }
}

const MATS: Record<string, any> = {
  '1': { id: 1, code: 'FG-001', name: '成品A', unit: '台' },
  '2': { id: 2, code: 'RM-001', name: '钢珠', unit: '个' },
  '3': { id: 3, code: 'RM-002', name: '弹簧', unit: '个' },
};
const WHS: Record<string, any> = { '5': { id: 5, code: 'WH-A', name: '主仓' } };

function build(opt: { batches?: any[]; failDecreaseOn?: string; udi?: any } = {}) {
  const wos = new MemRepo();
  const lines = new MemRepo();
  const issues = new MemRepo();
  const returns = new MemRepo();
  const auditRows: any[] = [];
  const calls = { decrease: [] as any[], increase: [] as any[], prints: [] as any[] };
  let stock: any[] = opt.batches ?? [
    { batchNo: 'B1', qty: 100, locationId: 11, expiresAt: '2027-01-01', createdAt: '2026-01-01', id: 1 },
    { batchNo: 'B2', qty: 50, locationId: 12, expiresAt: '2026-12-01', createdAt: '2026-06-01', id: 2 },
  ];

  const inventory: any = {
    resolveMaterial: async (_p: any) => {
      const key = String(_p.ref);
      if (MATS[key]) return MATS[key];
      const byCode = Object.values(MATS).find((m) => m.code === key);
      if (!byCode) throw new Error(`物料不存在：${key}`);
      return byCode;
    },
    resolveWarehouse: async (_p: any) => WHS[String(_p.ref)] ?? (() => { throw new Error('仓库不存在'); })(),
    expandBom: async (p: any) => (Number(p.productMaterialId) === 1
      ? {
        bomId: 8, version: 'v1',
        lines: [
          { materialId: 2, code: 'RM-001', name: '钢珠', unit: '个', qtyPer: 2, lossRate: 0.05 },
          { materialId: 3, code: 'RM-002', name: '弹簧', unit: '个', qtyPer: 1, lossRate: 0 },
        ],
      }
      : null),
    checkKit: async (p: any) => {
      const avail = new Map<number, number>();
      for (const s of stock) avail.set(Number(s.materialId ?? 0), (avail.get(0) ?? 0) + 0);
      // 按物料汇总可用
      const byMat = new Map<number, number>();
      for (const s of stock) byMat.set(s.materialId ?? 0, (byMat.get(s.materialId ?? 0) ?? 0) + Number(s.qty));
      const linesOut = [
        { materialId: 2, code: 'RM-001', name: '钢珠', unit: '个', qtyPer: 2, lossRate: 0.05 },
        { materialId: 3, code: 'RM-002', name: '弹簧', unit: '个', qtyPer: 1, lossRate: 0 },
      ].map((l) => {
        const unitNeed = l.qtyPer * (1 + l.lossRate);
        const needed = Math.round(unitNeed * Number(p.demand) * 1000) / 1000;
        const available = byMat.get(l.materialId) ?? 0;
        const max = Math.floor(available / unitNeed + 1e-9);
        return {
          ...l, needed, available, maxSets: max,
          shortage: Math.max(0, Math.round((needed - available) * 1000) / 1000),
          ok: needed <= available,
        };
      });
      const min = Math.min(...linesOut.map((l) => l.maxSets));
      const bounded = Math.min(min, Number(p.demand));
      return {
        product: MATS['1'], bom: { id: 8, version: 'v1' },
        kit: {
          demand: Number(p.demand), maxSets: bounded,
          kitRate: Math.floor((bounded / Number(p.demand)) * 10000) / 100,
          lines: linesOut, shortages: linesOut.filter((l) => l.shortage > 0),
        },
      };
    },
    queryBatches: async (_p: any) => stock.map((s) => ({
      batchNo: s.batchNo, qty: Number(s.qty), locationId: s.locationId ?? null,
      expiresAt: s.expiresAt ?? null, createdAt: s.createdAt ?? null, id: s.id,
    })),
    decreaseStock: async (p: any) => {
      calls.decrease.push(p);
      if (opt.failDecreaseOn && p.batchNo === opt.failDecreaseOn) throw new Error('库存不足（模拟）');
      const b = stock.find((s) => s.batchNo === p.batchNo);
      if (!b) throw new Error('批次不存在');
      if (Number(b.qty) < p.qty) throw new Error('库存不足（模拟）');
      b.qty = Number(b.qty) - p.qty;
      return { movementId: 'mv-out' };
    },
    increaseStock: async (p: any) => {
      calls.increase.push(p);
      const b = stock.find((s) => s.batchNo === p.batchNo);
      if (b) b.qty = Number(b.qty) + p.qty;
      return { movementId: 'mv-in' };
    },
  };
  const printGw: any = {
    createJob: async (req: any) => { calls.prints.push(req); return { jobId: 'J' + calls.prints.length, status: 'QUEUED' }; },
  };
  const audit: any = {
    write: async (...a: any[]) => { auditRows.push({ action: a[1], detail: a[2], targetId: a[5] }); },
    find: async (q: any) => auditRows.filter((r) => r.action === q.action).map((r) => ({ ...r, targetType: 'wms_work_order' })),
    exportRows: async () => [],
  };
  const svc = new IssuingService(wos as any, lines as any, issues as any, returns as any, inventory, printGw, audit, opt.udi);
  return { svc, wos, lines, issues, returns, calls, auditRows, stock, get stockRows() { return stock; }, inventory };
}

const run = <T>(fn: () => Promise<T>) => tenantStorage.run(CTX, fn);

test('建单：按 BOM 展开行，需求量含损耗率（2×1.05×10=21）', async () => {
  const { svc, lines } = build({ batches: [] });
  const wo = await run(() => svc.create({ woNo: 'WO-1', productMaterialId: 1, warehouseId: 5, demandQty: 10, expandBom: true }));
  assert.equal(wo.lines.length, 2);
  assert.equal(wo.lines[0].qtyRequired, 21);
  assert.equal(wo.lines[1].qtyRequired, 10);
  assert.equal(wo.status, 'CREATED');
  assert.equal(lines.rows.length, 2);
});

test('建单：单号重复 409；无 BOM 且未给行时报错', async () => {
  const { svc } = build();
  await run(() => svc.create({ woNo: 'WO-1', productMaterialId: 1, warehouseId: 5, demandQty: 5 }));
  await assert.rejects(() => run(() => svc.create({ woNo: 'WO-1', productMaterialId: 1, warehouseId: 5, demandQty: 5 })), /已存在/);

  const noBom = build();
  const inv = noBom.inventory;
  inv.expandBom = async () => null;
  await assert.rejects(() => run(() => noBom.svc.create({ woNo: 'WO-2', productMaterialId: 1, warehouseId: 5, demandQty: 5 })), /没有启用中的 BOM/);
});

test('齐套检查：回写行缺料与 shortage_flag，整体取 min', async () => {
  const { svc } = build({ batches: [
    { batchNo: 'B1', qty: 12, materialId: 2, locationId: 11, expiresAt: '2027-01-01', id: 1 },
    { batchNo: 'B2', qty: 100, materialId: 3, locationId: 12, expiresAt: '2027-01-01', id: 2 },
  ] });
  const wo = await run(() => svc.create({ woNo: 'WO-K', productMaterialId: 1, warehouseId: 5, demandQty: 10 }));
  const kit = await run(() => svc.kitCheck(wo.id));
  // 钢珠需 21 可用 12 → 缺 9；弹簧需 10 可用 100
  assert.equal(kit.lines[0].shortage, 9);
  assert.equal(kit.lines[1].shortage, 0);
  assert.equal(kit.shortageLines.length, 1);
  assert.equal(kit.overallKitRate, 50);
  assert.match(kit.summaryText, /缺/);
  const detail = await run(() => svc.detail(wo.id));
  assert.equal(detail.shortageFlag, true);
  assert.equal(detail.lines[0].qtyShortage, 9);
  assert.equal(detail.lines[0].status, 'SHORT');
  assert.equal(detail.lines[1].status, 'PENDING');
  assert.match(detail.lines[0].shortageReason!, /可用 12 < 需求 21/);
});

test('下发：必须做过齐套检查；做过即可下发（即使缺料）', async () => {
  const { svc } = build();
  const wo = await run(() => svc.create({ woNo: 'WO-R', productMaterialId: 1, warehouseId: 5, demandQty: 5 }));
  await assert.rejects(() => run(() => svc.release(wo.id)), /齐套检查/);
  await run(() => svc.kitCheck(wo.id));
  const released = await run(() => svc.release(wo.id));
  assert.equal(released.status, 'RELEASED');
});

test('发料过账：扣库存 + 发料记录 + 行 DONE；标签失败不阻塞', async () => {
  const { svc, issues, lines, calls, stock } = build();
  const wo = await run(() => svc.create({ woNo: 'WO-P', productMaterialId: 1, warehouseId: 5, demandQty: 10 }));
  await run(() => svc.kitCheck(wo.id));
  await run(() => svc.release(wo.id));
  await run(() => svc.issueStart(wo.id));
  const r = await run(() => svc.issuePost(wo.id));
  assert.equal(r.posted.length, 2);
  assert.equal(r.skipped.length, 0);
  // 钢珠 21 + 弹簧 10：B2 近效期（2026-12-01）先发，共扣 31；B1 不动
  assert.equal(issues.rows.length, 2);
  assert.equal(lines.rows[0].status, 'DONE');
  assert.equal(lines.rows[1].status, 'DONE');
  assert.equal(calls.prints.length, 2);
  const b1 = stock.find((s) => s.batchNo === 'B1');
  const b2 = stock.find((s) => s.batchNo === 'B2');
  assert.equal(Number(b1.qty), 100);
  assert.equal(Number(b2.qty), 19);
});

test('发料过账：部分可用按量发料；完全无库存 → 行 SHORT 且无记录（无脏数据）', async () => {
  const { svc, issues, lines } = build({ batches: [
    { batchNo: 'B1', qty: 10, locationId: 11, expiresAt: '2027-01-01', id: 1 },
  ] });
  const wo = await run(() => svc.create({ woNo: 'WO-S', productMaterialId: 1, warehouseId: 5, demandQty: 10 }));
  await run(() => svc.kitCheck(wo.id));
  await run(() => svc.release(wo.id));
  await run(() => svc.issueStart(wo.id));
  const r = await run(() => svc.issuePost(wo.id));
  // 唯一批次 B1 仅 10：钢珠（先发）按可用量发 10，剩余 11 记缺料；弹簧随后无库存 → SHORT
  assert.equal(r.posted.length, 1);
  assert.equal(issues.rows.length, 1);
  assert.equal(r.shortageFlag, true);
  const ball = lines.rows.find((l: any) => l.materialId === 2);
  assert.equal(ball.status, 'PARTIAL');
  assert.equal(Number(ball.qtyIssued), 10);
  assert.equal(Number(ball.qtyShortage), 11);
  assert.match(String(ball.shortageReason), /仍缺 11/);
  assert.ok(r.skipped.some((s: any) => s.partialIssued === 10));
  const spring = lines.rows.find((l: any) => l.materialId === 3);
  assert.equal(spring.status, 'SHORT');
  assert.equal(Number(spring.qtyIssued), 0);
  assert.equal(Number(spring.qtyShortage), 10);
});

test('发料过账：重跑幂等——已有发料记录行不二次扣减', async () => {
  const { svc, issues, calls } = build();
  const wo = await run(() => svc.create({ woNo: 'WO-I', productMaterialId: 1, warehouseId: 5, demandQty: 10 }));
  await run(() => svc.kitCheck(wo.id));
  await run(() => svc.release(wo.id));
  await run(() => svc.issueStart(wo.id));
  await run(() => svc.issuePost(wo.id));
  const dec = calls.decrease.length;
  const r2 = await run(() => svc.issuePost(wo.id));
  assert.equal(calls.decrease.length, dec);
  assert.equal(r2.posted.length, 0);
  assert.ok(r2.skipped.every((s: any) => /已发满|幂等/.test(String(s.reason ?? ''))));
  assert.equal(issues.rows.length, 2);
});

test('发料完成：未发满必须 force；force 后返回缺料清单并留审计', async () => {
  const { svc, auditRows } = build({ batches: [
    { batchNo: 'B1', qty: 10, locationId: 11, expiresAt: '2027-01-01', id: 1 },
  ] });
  const wo = await run(() => svc.create({ woNo: 'WO-D', productMaterialId: 1, warehouseId: 5, demandQty: 10 }));
  await run(() => svc.kitCheck(wo.id));
  await run(() => svc.release(wo.id));
  await run(() => svc.issueStart(wo.id));
  await run(() => svc.issuePost(wo.id));
  await assert.rejects(() => run(() => svc.issueDone(wo.id)), /force/);
  const done = await run(() => svc.issueDone(wo.id, { force: true }));
  assert.equal(done.status, 'ISSUED');
  assert.ok(done.shortages.length >= 1);
  assert.ok(auditRows.some((a) => a.action === 'wms.wo.issue_done.force'));
});

test('退料：回补库存、工单回到 ISSUING、行状态回退', async () => {
  const { svc, calls, lines } = build();
  const wo = await run(() => svc.create({ woNo: 'WO-T', productMaterialId: 1, warehouseId: 5, demandQty: 10 }));
  await run(() => svc.kitCheck(wo.id));
  await run(() => svc.release(wo.id));
  await run(() => svc.issueStart(wo.id));
  await run(() => svc.issuePost(wo.id));
  await run(() => svc.issueDone(wo.id));
  const detail = await run(() => svc.detail(wo.id));
  const line = detail.lines[0];
  const ret = await run(() => svc.createReturn(wo.id, {
    lineId: line.id, qty: 5, batchNo: line.batchNo ?? 'B1', reason: '现场多领退回',
  }));
  assert.equal(ret.status, 'ISSUING');
  assert.equal(calls.increase.length, 1);
  assert.equal(Number(lines.rows.find((l: any) => l.id === line.id).qtyIssued), 16);
});

test('退料守卫：未填原因 / 超过已发量都拒绝', async () => {
  const { svc } = build();
  const wo = await run(() => svc.create({ woNo: 'WO-T2', productMaterialId: 1, warehouseId: 5, demandQty: 10 }));
  await run(() => svc.kitCheck(wo.id));
  await run(() => svc.release(wo.id));
  await run(() => svc.issueStart(wo.id));
  await run(() => svc.issuePost(wo.id));
  await run(() => svc.issueDone(wo.id));
  const detail = await run(() => svc.detail(wo.id));
  await assert.rejects(() => run(() => svc.createReturn(wo.id, { lineId: detail.lines[0].id, qty: 1, reason: '' })), /原因/);
  await assert.rejects(() => run(() => svc.createReturn(wo.id, { lineId: detail.lines[0].id, qty: 999, reason: '多领' })), /超过已发量/);
});

test('关单：仅 ISSUED 可关，关后为终态', async () => {
  const { svc } = build();
  const wo = await run(() => svc.create({ woNo: 'WO-C', productMaterialId: 1, warehouseId: 5, demandQty: 10 }));
  await run(() => svc.kitCheck(wo.id));
  await run(() => svc.release(wo.id));
  await run(() => svc.issueStart(wo.id));
  await run(() => svc.issuePost(wo.id));
  const done = await run(() => svc.issueDone(wo.id));
  assert.equal(done.status, 'ISSUED');
  const closed = await run(() => svc.close(wo.id));
  assert.equal(closed.status, 'CLOSED');
  await assert.rejects(() => run(() => svc.close(wo.id)), /不允许/);
});

test('缺料清单：按行给缺口、可用批次与摘要', async () => {
  const { svc } = build({ batches: [
    { batchNo: 'B1', qty: 10, materialId: 2, locationId: 11, expiresAt: '2027-01-01', id: 1 },
    { batchNo: 'B2', qty: 100, materialId: 3, locationId: 12, expiresAt: '2027-01-01', id: 2 },
  ] });
  const wo = await run(() => svc.create({ woNo: 'WO-X', productMaterialId: 1, warehouseId: 5, demandQty: 10 }));
  await run(() => svc.kitCheck(wo.id));
  const s = await run(() => svc.shortages(wo.id));
  // 两行都未发（issued=0），都算缺口；带可用批次供计划员决策
  assert.equal(s.total, 2);
  assert.match(s.summary!, /缺料/);
  assert.equal(s.items[0].materialCode, 'RM-001');
  assert.equal(s.items[0].shortage, 21);
  assert.equal(s.items[0].batches.length, 2);
  assert.equal(s.items[1].materialCode, 'RM-002');
});


test('发料过账：UDI 码逐条记 ISSUE，单条失败不影响过账（U5）', async () => {
  const calls: any[] = [];
  const udi = {
    issueByScan: async (p: any) => {
      calls.push(p);
      if (p.code === 'BAD') throw new Error('该单元尚未收货');
      return { udiKey: p.code, gtin: '06901234567892', status: 'ISSUED', idempotent: false, eventId: calls.length };
    },
  };
  const { svc, issues } = build({ udi });
  const wo = await run(() => svc.create({ woNo: 'WO-U', productMaterialId: 1, warehouseId: 5, demandQty: 10 }));
  await run(() => svc.kitCheck(wo.id));
  await run(() => svc.release(wo.id));
  await run(() => svc.issueStart(wo.id));
  const r = await run(() => svc.issuePost(wo.id, {
    udiCodes: [{ code: 'K1', lineNo: 1 }, { code: 'BAD', lineNo: 2 }],
  }));
  // 库存照常过账成功；UDI 单向失败只回报
  assert.equal(r.posted.length, 2);
  assert.equal(issues.rows.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(r.udi.total, 2);
  assert.equal(r.udi.created, 1);
  assert.equal(r.udi.failed, 1);
  assert.match(r.udi.results[1].reason, /尚未收货/);
});

test('发料扫码：带 UDI 码时联动记 ISSUE，并随校验结果返回（U5）', async () => {
  const calls: any[] = [];
  const udi = { issueByScan: async (p: any) => { calls.push(p); return { udiKey: 'K1', gtin: 'G', status: 'ISSUED', idempotent: false, eventId: 1 }; } };
  const { svc } = build({ udi });
  const wo = await run(() => svc.create({ woNo: 'WO-U2', productMaterialId: 1, warehouseId: 5, demandQty: 10 }));
  await run(() => svc.kitCheck(wo.id));
  await run(() => svc.release(wo.id));
  await run(() => svc.issueStart(wo.id));
  const res = await run(() => svc.issueScan(wo.id, { lineNo: 1, udiCode: '(01)06901234567892(10)L1', materialCode: 'RM-001', batchNo: 'B2' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].woNo, 'WO-U2');
  assert.equal(calls[0].materialCode, 'RM-001');
  assert.equal(res.udi.udiKey, 'K1');
  assert.equal(res.lineNo, 1);
});
