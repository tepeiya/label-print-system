// UdiComplianceService 单测（内存仓库替身，不连库）：
// DI 台账 upsert / 包装层级树 / 提交前校验规则 / 召回影响面 / 申报状态流转
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UdiComplianceService } from '../udi.compliance.service';

/** GS1 校验位（14 位：前 13 位给出，返回含校验位的完整码） */
function gtin14(base13: string) {
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(base13[12 - i]) * (i % 2 === 0 ? 3 : 1);
  return base13 + ((10 - (sum % 10)) % 10);
}
const UNIT_DI = gtin14('1000000000000');
const CARTON_DI = gtin14('2000000000000');
const PALLET_DI = gtin14('3000000000000');

/** 极简内存仓库：支持 where(等值 / In / gte / lte)、order、take、findAndCount */
class MemRepo {
  rows: any[] = [];
  private seq = 1;

  constructor(private name = 'repo') {}

  private cond(v: any, c: any): boolean {
    if (c === undefined) return true;
    if (c && typeof c === 'object' && c._type) {
      if (c._type === 'in') return (c._value as any[]).includes(v);
      if (c._type === 'gte') return v != null && new Date(v) >= new Date(c._value);
      if (c._type === 'lte') return v != null && new Date(v) <= new Date(c._value);
      return false;
    }
    return v === c;
  }

  private match(row: any, where: any = {}) {
    return Object.entries(where).every(([k, c]) => {
      if (c && typeof c === 'object' && !c._type && k in row && typeof (row as any)[k] === 'object' && c.gte !== undefined) {
        return this.cond((row as any)[k], { _type: 'gte', _value: c.gte } as any)
          && (c.lte === undefined || this.cond((row as any)[k], { _type: 'lte', _value: c.lte } as any));
      }
      return this.cond(row[k], c);
    });
  }

  private sort(rows: any[], order?: any) {
    if (!order) return rows;
    const [k, dir] = Object.entries(order)[0] as [string, any];
    return [...rows].sort((a, b) => ((a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (dir === 'DESC' ? -1 : 1)));
  }

  async find({ where, order, take }: any = {}) {
    let rows = this.rows.filter((r) => this.match(r, where));
    rows = this.sort(rows, order);
    return (take ? rows.slice(0, take) : rows).map((r) => ({ ...r }));
  }

  async findOne({ where }: any = {}) {
    const row = this.rows.find((r) => this.match(r, where));
    return row ? { ...row } : null;
  }

  async findAndCount({ where, order, take }: any = {}) {
    const all = this.rows.filter((r) => this.match(r, where));
    const rows = this.sort(all, order);
    return [(take ? rows.slice(0, take) : rows).map((r) => ({ ...r })), all.length];
  }

  create(obj: any) { return { ...obj }; }

  async save(obj: any) {
    if (obj.id) {
      const i = this.rows.findIndex((r) => r.id === obj.id);
      if (i >= 0) { this.rows[i] = { ...obj }; return this.rows[i]; }
    }
    const row = { ...obj, id: this.seq++, createdAt: obj.createdAt ?? new Date() };
    this.rows.push(row);
    return { ...row };
  }

  async count({ where }: any = {}) { return this.rows.filter((r) => this.match(r, where)).length; }

  /** TypeORM 的 Repository.delete 直接收 criteria（不是 { where }） */
  async delete(criteria: any = {}) {
    const keep = this.rows.filter((r) => !this.match(r, criteria));
    const removed = this.rows.length - keep.length;
    this.rows = keep;
    return { affected: removed };
  }
}

function makeService(opts: { submit?: (p: any) => any } = {}) {
  const diRepo = new MemRepo('di');
  const subRepo = new MemRepo('sub');
  const unitRepo = new MemRepo('unit');
  const pkgRepo = new MemRepo('pkg');
  const eventRepo = new MemRepo('event');
  const nmpa = {
    submitIdentifiers: async (p: any) => (opts.submit ? opts.submit(p) : { ok: true, code: '0', message: 'ok' }),
    probe: async () => ({ ok: true, code: '0', message: 'ok', baseUrl: 'x', configured: false }),
  } as any;
  const svc = new UdiComplianceService(diRepo as any, subRepo as any, unitRepo as any, pkgRepo as any, eventRepo as any, nmpa);
  return { svc, diRepo, subRepo, unitRepo, pkgRepo, eventRepo };
}

const FULL = {
  name: '一次性使用无菌注射器', spec: '5ml', model: '5ml-A',
  registrationNo: '国械注准20223140001', catalogCode: '14-01-02', issuingAgency: 'GS1',
};

test('saveDi：校验位不通过的逐行拒绝，合法的 upsert 成 updated', async () => {
  const { svc } = makeService();
  const r1 = await svc.saveDi(1, null, [{ di: UNIT_DI, ...FULL }, { di: '1000000000001', ...FULL }]);
  assert.equal(r1.created, 1);
  assert.equal(r1.rejected.length, 1);
  assert.match(r1.rejected[0].message, /校验位/);

  const r2 = await svc.saveDi(1, null, [{ di: UNIT_DI, ...FULL, name: '改名后' }]);
  assert.equal(r2.items[0].action, 'updated');
  assert.equal((await svc.listDi(1)).items[0].name, '改名后');
});

test('saveDi：缺产品名称直接拒绝', async () => {
  const { svc } = makeService();
  const r = await svc.saveDi(1, null, [{ di: UNIT_DI, name: '' } as any]);
  assert.equal(r.saved, 0);
  assert.equal(r.rejected[0].message, '产品名称必填');
});

test('diTree：PALLET → CARTON → UNIT 三层挂起来', async () => {
  const { svc } = makeService();
  await svc.saveDi(1, null, [
    { di: UNIT_DI, ...FULL, packageLevel: 'UNIT' },
    { di: CARTON_DI, ...FULL, packageLevel: 'CARTON', parentDi: PALLET_DI, qtyInPackage: 10 },
    { di: PALLET_DI, ...FULL, packageLevel: 'PALLET', qtyInPackage: 20 },
  ]);
  const t = await svc.diTree(1);
  assert.equal(t.total, 3);
  const root = t.tree[0];
  // 根按 DI 升序，最小的是 UNIT，但它没有父→也是根；CARTON 的父存在→不是根
  const pallet = t.tree.find((n: any) => n.di === PALLET_DI);
  assert.equal(pallet.children.length, 1);
  assert.equal(pallet.children[0].di, CARTON_DI);
  assert.equal(root.depth, 0);
});

test('removeDi：还有子级包装时拒绝删除', async () => {
  const { svc } = makeService();
  await svc.saveDi(1, null, [
    { di: PALLET_DI, ...FULL, packageLevel: 'PALLET' },
    { di: CARTON_DI, ...FULL, packageLevel: 'CARTON', parentDi: PALLET_DI, qtyInPackage: 10 },
  ]);
  await assert.rejects(() => svc.removeDi(1, PALLET_DI), /挂在它下面/);
  await svc.removeDi(1, CARTON_DI);
  assert.equal((await svc.listDi(1)).total, 1);
});

test('validate：缺注册证 / 分类目录格式 / 层级倒挂 / 挂父必填数量 都报 error', async () => {
  const { svc } = makeService();
  await svc.saveDi(1, null, [
    { di: UNIT_DI, name: 'A', spec: 'x', catalogCode: '14-01-02', issuingAgency: 'GS1', packageLevel: 'UNIT' }, // 缺注册证
    { di: CARTON_DI, ...FULL, catalogCode: '1401', packageLevel: 'CARTON', parentDi: UNIT_DI, qtyInPackage: 10 } // 格式错
    ,
    { di: PALLET_DI, ...FULL, packageLevel: 'PALLET', parentDi: CARTON_DI }, // 层级倒挂 + 缺数量
  ]);
  const r = await svc.validate(1, []);
  assert.equal(r.ok, false);
  assert.equal(r.checked, 3);
  const fields = r.issues.map((i) => `${i.di}:${i.field}`);
  assert.ok(fields.includes(`${UNIT_DI}:registrationNo`));
  assert.ok(fields.includes(`${CARTON_DI}:catalogCode`));
  assert.ok(fields.includes(`${PALLET_DI}:parentDi`));
  assert.ok(fields.includes(`${PALLET_DI}:qtyInPackage`));
});

test('validate：台账里没有的 DI 直接报错', async () => {
  const { svc } = makeService();
  const r = await svc.validate(1, ['99999999999999']);
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].message, '台账里没有这个 DI');
});

test('validate：合规台账全绿', async () => {
  const { svc } = makeService();
  await svc.saveDi(1, null, [{ di: UNIT_DI, ...FULL, packageLevel: 'UNIT' }]);
  const r = await svc.validate(1, []);
  assert.equal(r.ok, true);
  assert.equal(r.issues.length, 0);
});

test('recallScope：按批号命中，聚合出已发料/已发运单据', async () => {
  const { svc, unitRepo, eventRepo, pkgRepo } = makeService();
  const t0 = new Date('2026-11-01T00:00:00Z');
  await unitRepo.save({ id: 1, tenantId: 1, udiKey: `k1`, gtin: UNIT_DI, lot: 'L1', serial: 'S1', status: 'SHIPPED', packageSscc: 'SSCC1', workOrderNo: 'WO1' });
  await unitRepo.save({ id: 2, tenantId: 1, udiKey: `k2`, gtin: UNIT_DI, lot: 'L1', serial: 'S2', status: 'IN_STOCK', packageSscc: null });
  await unitRepo.save({ id: 3, tenantId: 1, udiKey: `k3`, gtin: UNIT_DI, lot: 'L2', serial: 'S3', status: 'ISSUED' });
  pkgRepo.rows.push({ id: 1, tenantId: 1, sscc: 'SSCC1', level: 'CARTON', qty: 10 });
  eventRepo.rows.push(
    { id: 1, tenantId: 1, unitId: 1, refType: 'ISSUE', refNo: 'ISS-1', occurredAt: t0 },
    { id: 2, tenantId: 1, unitId: 1, refType: 'SHIPMENT', refNo: 'SHP-1', occurredAt: new Date('2026-11-02T00:00:00Z') },
    { id: 3, tenantId: 1, unitId: 2, refType: 'wms_work_order', refNo: 'WO-9', occurredAt: t0 },
    { id: 4, tenantId: 1, unitId: 1, refType: 'PRINT', refNo: null, occurredAt: t0 },
  );

  const scope = await svc.recallScope(1, { lot: 'L1' });
  assert.equal(scope.summary.units, 2);
  assert.equal(scope.summary.packages, 1);
  // UDI 侧 'ISSUE' 与 WMS 侧 'wms_work_order' 都要认，且按单号聚合
  assert.equal(scope.summary.issuedRefs, 2);
  assert.equal(scope.summary.shippedRefs, 1);
  const shp = scope.downstream.find((d: any) => d.refNo === 'SHP-1');
  assert.equal(shp.units, 1);

  const csv = await svc.recallCsv(1, { lot: 'L1' });
  assert.match(csv.filename, /^udi-recall-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.match(csv.content, /^UDI,GTIN,批号/);
  assert.equal(csv.content.split('\n').length, 3); // 表头 + 2 件
});

test('recallScope：一个条件都不给直接报错', async () => {
  const { svc } = makeService();
  await assert.rejects(() => svc.recallScope(1, {}), /至少给一个条件/);
});

test('createSubmission：validate 模式落 validated，并带上本地校验结果', async () => {
  const { svc } = makeService();
  await svc.saveDi(1, null, [{ di: UNIT_DI, ...FULL }]);
  const s = await svc.createSubmission(1, 9, { channel: 'NMPA', mode: 'validate' });
  assert.equal(s.status, 'validated');
  assert.equal(s.dis.length, 1);
});

test('createSubmission：本地校验不过时，file/api 都不能放行', async () => {
  const { svc } = makeService();
  await svc.saveDi(1, null, [{ di: UNIT_DI, name: 'A', spec: 'x', packageLevel: 'UNIT' }]); // 缺注册证/分类目录
  const s = await svc.createSubmission(1, null, { channel: 'NMPA', mode: 'file' });
  assert.equal(s.status, 'failed');
  assert.equal(s.remoteCode, 'LOCAL_VALIDATION');
});

test('createSubmission：非 NMPA 渠道走 api 模式直接失败，绝不假成功', async () => {
  const { svc } = makeService();
  await svc.saveDi(1, null, [{ di: UNIT_DI, ...FULL }]);
  const s = await svc.createSubmission(1, null, { channel: 'EUDAMED', mode: 'api' });
  assert.equal(s.status, 'failed');
  assert.equal(s.remoteCode, 'NO_API');
  assert.match(s.remoteMsg, /file 模式/);
});

test('createSubmission：file 模式按渠道生成报文', async () => {
  const { svc } = makeService();
  await svc.saveDi(1, null, [{ di: UNIT_DI, ...FULL }]);
  const eudamed = await svc.createSubmission(1, null, { channel: 'EUDAMED', mode: 'file' });
  assert.equal(eudamed.status, 'generated');
  assert.match(String(eudamed.payload?.content ?? ''), /<UDI/);
  const gudid = await svc.createSubmission(1, null, { channel: 'GUDID', mode: 'file' });
  assert.equal(gudid.status, 'generated');
  assert.match(String(gudid.payload?.content ?? ''), /<SPL/);
});

test('createSubmission：NMPA api 模式透传远端结果', async () => {
  const { svc } = makeService({ submit: async () => ({ ok: false, code: 'NOT_CONFIGURED', message: '未配置凭据' }) });
  await svc.saveDi(1, null, [{ di: UNIT_DI, ...FULL }]);
  const s = await svc.createSubmission(1, null, { channel: 'NMPA', mode: 'api' });
  assert.equal(s.status, 'failed');
  assert.equal(s.remoteCode, 'NOT_CONFIGURED');
  assert.equal(s.attempts, 1);
});

test('createSubmission：非法 channel / mode 被拒', async () => {
  const { svc } = makeService();
  await assert.rejects(() => svc.createSubmission(1, null, { channel: 'XX' as any }), /channel/);
  await assert.rejects(() => svc.createSubmission(1, null, { channel: 'NMPA', mode: 'zzz' }), /mode/);
});

test('listSubmissions：按渠道过滤并按 id 倒序', async () => {
  const { svc } = makeService();
  await svc.saveDi(1, null, [{ di: UNIT_DI, ...FULL }]);
  await svc.createSubmission(1, null, { channel: 'NMPA', mode: 'validate' });
  await svc.createSubmission(1, null, { channel: 'EUDAMED', mode: 'file' });
  const all = await svc.listSubmissions(1, {});
  assert.equal(all.total, 2);
  assert.equal(all.items[0].channel, 'EUDAMED');
  const nmpaOnly = await svc.listSubmissions(1, { channel: 'nmpa' });
  assert.equal(nmpaOnly.total, 1);
});
