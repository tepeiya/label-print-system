// 迁移数据的离线校验规则：不连服务端也能查出 90% 的错（编码、GTIN 校验位、必填、重复、跨表引用）。
import { norm } from './text.mjs';

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(norm(v)) && !Number.isNaN(new Date(norm(v)).getTime());
const isNum = (v) => {
  const s = norm(v).replace(/,/g, '');
  return s !== '' && Number.isFinite(Number(s));
};
const num = (v) => Number(norm(v).replace(/,/g, ''));

/** GS1 GTIN 校验位（对前 N-1 位，自右向左权重 3,1,…） */
export function gtinCheckOk(raw) {
  const s = norm(raw);
  if (!/^\d{8,14}$/.test(s)) return false;
  const body = s.slice(0, -1).split('').reverse();
  let sum = 0;
  body.forEach((d, i) => { sum += Number(d) * (i % 2 === 0 ? 3 : 1); });
  const check = (10 - (sum % 10)) % 10;
  return check === Number(s.slice(-1));
}

export class Issues {
  constructor() { this.list = []; }
  add(sheet, row, field, level, message) { this.list.push({ sheet, row, field, level, message }); }
  error(sheet, row, field, message) { this.add(sheet, row, field, '错误', message); }
  warn(sheet, row, field, message) { this.add(sheet, row, field, '警告', message); }
  get errors() { return this.list.filter((i) => i.level === '错误'); }
  get warns() { return this.list.filter((i) => i.level === '警告'); }
}

export const SHEETS = {
  material: '01_物料',
  stock: '02_期初库存',
  wo: '03_工单',
  woLine: '05_工单明细',
  receipt: '04_收货单',
};

const F = {
  material: {
    code: '物料编码', name: '物料名称', spec: '规格', unit: '单位', category: '类别',
    safetyStock: '安全库存', udi: '是否UDI', autoPrint: '自动打印',
    gtinUnit: '单件GTIN', gtinCarton: '箱GTIN', cartonQty: '每箱数量',
    gtinPallet: '托GTIN', palletQty: '每托数量',
    wh: '默认仓库编码', loc: '默认库位编码',
  },
  stock: { sku: '物料编码', wh: '仓库编码', loc: '库位编码', batch: '批号', qty: '数量', note: '备注' },
  wo: { woNo: '工单号', product: '产品编码', demand: '需求数量', wh: '仓库编码', priority: '优先级', start: '计划开工', expandBom: '按BOM展开', remark: '备注' },
  receipt: { receiptNo: '收货单号', wh: '仓库编码', sku: '物料编码', qty: '预计数量', batch: '批号' },
  woLine: { woNo: '工单号', sku: '物料编码', qty: '需求数量', batch: '批号' },
};

const yes = (v) => ['是', 'Y', 'y', 'YES', 'true', '1', 'TRUE', 'True'].includes(norm(v));
const blank = (v) => norm(v) === '';

/** 校验全部 sheet，返回 {issues, data}（data 为清洗后的结构，供 apply 使用） */
export function validate(wb, readSheet) {
  const iss = new Issues();
  const data = { materials: [], stocks: [], wos: [], woLines: [], receipts: [] };

  // ---------- 01 物料 ----------
  const m = readSheet(wb, SHEETS.material);
  if (!m) {
    iss.warn(SHEETS.material, 0, '', '本工作表不存在，跳过物料（只补期初/工单时可忽略）');
  } else {
    const codes = new Map();
    const gtins = new Map(); // gtin -> 'sheet!row' 用于查同表重复
    m.rows.forEach((r) => {
      const row = r.__row;
      const code = norm(r[F.material.code]);
      const name = norm(r[F.material.name]);
      if (!code) iss.error(SHEETS.material, row, F.material.code, '物料编码必填');
      else if (code.length > 40) iss.error(SHEETS.material, row, F.material.code, `物料编码超长（${code.length}>40）`);
      if (code) {
        if (codes.has(code)) iss.error(SHEETS.material, row, F.material.code, `物料编码重复（第 ${codes.get(code)} 行已有 ${code}）`);
        else codes.set(code, row);
      }
      if (!name) iss.error(SHEETS.material, row, F.material.name, '物料名称必填');
      else if (name.length > 120) iss.error(SHEETS.material, row, F.material.name, `物料名称超长（${name.length}>120）`);

      const ss = r[F.material.safetyStock];
      if (!blank(ss)) {
        if (!isNum(ss) || num(ss) < 0) iss.error(SHEETS.material, row, F.material.safetyStock, '安全库存必须是非负数字');
      }

      const gtinRows = [
        ['UNIT', r[F.material.gtinUnit], 1],
        ['CARTON', r[F.material.gtinCarton], r[F.material.cartonQty]],
        ['PALLET', r[F.material.gtinPallet], r[F.material.palletQty]],
      ];
      for (const [level, g, qty] of gtinRows) {
        if (blank(g)) {
          if (level !== 'UNIT' && !blank(qty)) iss.warn(SHEETS.material, row, level === 'CARTON' ? F.material.cartonQty : F.material.palletQty, `填了数量但没有 ${level} GTIN，该档不会导入`);
          continue;
        }
        const gs = norm(g);
        if (!/^\d{8,14}$/.test(gs)) { iss.error(SHEETS.material, row, level === 'CARTON' ? F.material.gtinCarton : level === 'PALLET' ? F.material.gtinPallet : F.material.gtinUnit, `${level} GTIN 必须是 8~14 位数字：${gs}`); continue; }
        if (!gtinCheckOk(gs)) iss.error(SHEETS.material, row, level === 'CARTON' ? F.material.gtinCarton : level === 'PALLET' ? F.material.gtinPallet : F.material.gtinUnit, `${level} GTIN 校验位不对：${gs}（请核对，不要手改末位凑数）`);
        if (gtins.has(gs)) iss.error(SHEETS.material, row, 'GTIN', `GTIN 重复：${gs} 已在第 ${gtins.get(gs)} 行使用（同一物料不同档位也不能用同一个码）`);
        else gtins.set(gs, row);
        if (level !== 'UNIT') {
          if (blank(qty)) iss.error(SHEETS.material, row, level === 'CARTON' ? F.material.cartonQty : F.material.palletQty, `有 ${level} GTIN 就必须填每${level === 'CARTON' ? '箱' : '托'}数量`);
          else if (!isNum(qty) || num(qty) <= 0) iss.error(SHEETS.material, row, level === 'CARTON' ? F.material.cartonQty : F.material.palletQty, `每${level === 'CARTON' ? '箱' : '托'}数量必须 > 0`);
        }
      }

      const wh = norm(r[F.material.wh]);
      const loc = norm(r[F.material.loc]);
      if (loc && !wh) iss.warn(SHEETS.material, row, F.material.loc, '填了默认库位但没填默认仓库，库位会被忽略');

      data.materials.push({
        row, code, name,
        spec: norm(r[F.material.spec]) || undefined,
        unit: norm(r[F.material.unit]) || '件',
        category: norm(r[F.material.category]) || undefined,
        safetyStock: blank(ss) ? undefined : num(ss),
        udiRequired: yes(r[F.material.udi]),
        autoPrint: yes(r[F.material.autoPrint]),
        gtins: gtinRows.filter(([, g]) => !blank(g)).map(([level, g, qty]) => ({
          gtin: norm(g), packLevel: level, packQty: level === 'UNIT' ? 1 : num(qty),
        })),
        warehouseCode: wh || undefined,
        locationCode: loc || undefined,
      });
    });
  }

  // ---------- 02 期初库存 ----------
  const s = readSheet(wb, SHEETS.stock);
  if (!s) iss.warn(SHEETS.stock, 0, '', '本工作表不存在，跳过期初库存');
  else {
    s.rows.forEach((r) => {
      const row = r.__row;
      const sku = norm(r[F.stock.sku]);
      const wh = norm(r[F.stock.wh]);
      const qty = r[F.stock.qty];
      if (!sku) iss.error(SHEETS.stock, row, F.stock.sku, '物料编码必填');
      else if (!codes_has(m, sku)) iss.warn(SHEETS.stock, row, F.stock.sku, `物料 ${sku} 不在 01_物料 表里，需系统中已存在`);
      if (!wh) iss.error(SHEETS.stock, row, F.stock.wh, '仓库编码必填');
      if (blank(qty)) iss.error(SHEETS.stock, row, F.stock.qty, '数量必填');
      else if (!isNum(qty) || num(qty) <= 0) iss.error(SHEETS.stock, row, F.stock.qty, '期初数量必须 > 0（负数请走盘点，不在这里）');
      if (blank(r[F.stock.batch])) iss.warn(SHEETS.stock, row, F.stock.batch, '没填批号：UDI 追溯需要批号，建议补齐');
      data.stocks.push({
        row, sku, warehouseCode: wh, locationCode: norm(r[F.stock.loc]) || undefined,
        batchNo: norm(r[F.stock.batch]) || undefined, qty: num(qty), note: norm(r[F.stock.note]) || undefined,
      });
    });
  }

  // ---------- 03 工单 ----------
  const w = readSheet(wb, SHEETS.wo);
  if (!w) iss.warn(SHEETS.wo, 0, '', '本工作表不存在，跳过工单');
  else {
    const seen = new Set();
    w.rows.forEach((r) => {
      const row = r.__row;
      const woNo = norm(r[F.wo.woNo]);
      const product = norm(r[F.wo.product]);
      const demand = r[F.wo.demand];
      const wh = norm(r[F.wo.wh]);
      if (woNo) {
        if (seen.has(woNo)) iss.error(SHEETS.wo, row, F.wo.woNo, `工单号重复：${woNo}`);
        seen.add(woNo);
      }
      if (!product) iss.error(SHEETS.wo, row, F.wo.product, '产品编码必填');
      if (blank(demand)) iss.error(SHEETS.wo, row, F.wo.demand, '需求数量必填');
      else if (!isNum(demand) || num(demand) <= 0) iss.error(SHEETS.wo, row, F.wo.demand, '需求数量必须 > 0');
      if (!wh) iss.error(SHEETS.wo, row, F.wo.wh, '仓库编码必填');
      const start = r[F.wo.start];
      if (!blank(start) && !isDate(start)) iss.warn(SHEETS.wo, row, F.wo.start, `计划开工日期格式建议 YYYY-MM-DD：${norm(start)}`);
      if (!blank(r[F.wo.priority]) && (!isNum(r[F.wo.priority]) || num(r[F.wo.priority]) < 0)) iss.error(SHEETS.wo, row, F.wo.priority, '优先级必须是非负数字');
      data.wos.push({
        row, woNo: woNo || undefined, productCode: product, demandQty: num(demand),
        warehouseCode: wh, priority: blank(r[F.wo.priority]) ? 0 : num(r[F.wo.priority]),
        plannedStartAt: blank(start) ? undefined : norm(start),
        expandBom: yes(r[F.wo.expandBom]),
        remark: norm(r[F.wo.remark]) || undefined,
      });
    });
  }

  // ---------- 05 工单明细 ----------
  const wl = readSheet(wb, SHEETS.woLine);
  if (!wl) {
    iss.warn(SHEETS.woLine, 0, '', '缺少该工作表：工单将没有配料明细（客户现场无法直接发料）。不需要明细（按 BOM 展开）可忽略此警告');
  } else {
    const woNos = new Set(data.wos.filter((x) => x.woNo).map((x) => x.woNo));
    const seen = new Set();
    wl.rows.forEach((r) => {
      const row = r.__row;
      const woNo = norm(r[F.woLine.woNo]);
      const sku = norm(r[F.woLine.sku]);
      const qty = r[F.woLine.qty];
      if (!woNo) iss.error(SHEETS.woLine, row, F.woLine.woNo, '工单号必填（明细靠工单号挂到 03_工单 的行）');
      else if (!woNos.has(woNo)) iss.error(SHEETS.woLine, row, F.woLine.woNo, `工单号 ${woNo} 不在 03_工单 里（03 表该行工单号不能留空）`);
      if (!sku) iss.error(SHEETS.woLine, row, F.woLine.sku, '物料编码必填');
      if (blank(qty)) iss.error(SHEETS.woLine, row, F.woLine.qty, '需求数量必填');
      else if (!isNum(qty) || num(qty) <= 0) iss.error(SHEETS.woLine, row, F.woLine.qty, '需求数量必须 > 0');
      const key = `${woNo}|${sku}`;
      if (seen.has(key)) iss.warn(SHEETS.woLine, row, F.woLine.sku, `同一工单同一物料重复行（${woNo}/${sku}），服务端会合并需求量`);
      seen.add(key);
      data.woLines.push({ row, woNo, sku, qtyRequired: num(qty), batchNo: norm(r[F.woLine.batch]) || undefined });
    });
  }

  // ---------- 04 收货单 ----------
  const rc = readSheet(wb, SHEETS.receipt);
  if (!rc) iss.warn(SHEETS.receipt, 0, '', '本工作表不存在，跳过收货单');
  else {
    const byNo = new Map();
    rc.rows.forEach((r) => {
      const row = r.__row;
      const no = norm(r[F.receipt.receiptNo]);
      const wh = norm(r[F.receipt.wh]);
      const sku = norm(r[F.receipt.sku]);
      const qty = r[F.receipt.qty];
      if (!no) iss.error(SHEETS.receipt, row, F.receipt.receiptNo, '收货单号必填');
      if (!wh) iss.error(SHEETS.receipt, row, F.receipt.wh, '仓库编码必填');
      if (!sku) iss.error(SHEETS.receipt, row, F.receipt.sku, '物料编码必填');
      else if (!codes_has(m, sku)) iss.warn(SHEETS.receipt, row, F.receipt.sku, `物料 ${sku} 不在 01_物料 表里，需系统中已存在`);
      if (blank(qty)) iss.error(SHEETS.receipt, row, F.receipt.qty, '预计数量必填');
      else if (!isNum(qty) || num(qty) < 0) iss.error(SHEETS.receipt, row, F.receipt.qty, '预计数量必须 ≥ 0');
      if (!no) return;
      if (!byNo.has(no)) byNo.set(no, { receiptNo: no, warehouseCode: wh, rows: [] });
      const g = byNo.get(no);
      if (g.warehouseCode !== wh) iss.error(SHEETS.receipt, row, F.receipt.wh, `同一收货单（${no}）的仓库编码必须一致：第 1 行为 ${g.warehouseCode}，本行为 ${wh || '空'}`);
      g.rows.push({ row, sku, batchNo: norm(r[F.receipt.batch]) || undefined, qtyExpected: num(qty) });
    });
    data.receipts = [...byNo.values()];
  }

  return { issues: iss, data };
}

function codes_has(mSheet, code) {
  if (!mSheet) return false;
  return mSheet.rows.some((r) => norm(r[F.material.code]) === code);
}

export { F };
