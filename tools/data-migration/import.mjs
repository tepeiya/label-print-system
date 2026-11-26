#!/usr/bin/env node
// =============================================================================
// LabelFlow 客户数据迁移工具
//
//   node import.mjs --template ./migration                 生成 Excel 模板
//   node import.mjs --check ./migration/客户数据.xlsx      离线校验，出报告
//   node import.mjs --apply ./migration/客户数据.xlsx \
//        --base http://127.0.0.1:3200/api/v1 \
//        --user admin --pass ****** --tenant default       校验通过后写入
//
// 设计原则：
//   1. 校验和写入分开。--check 不碰服务器，客户可以先自助改数据。
//   2. 有错误默认拒绝写入（--force 才强行继续），不做"部分脏数据悄悄入库"。
//   3. 每类数据一个失败清单，失败不中断后续（除物料建不出来这种前置失败）。
//   4. 期初库存走库存调整单（GAIN）+ 过账，天然带审计与操作人，不直写库存表。
//   5. 重复执行有防护：物料按编码匹配；期初按"文件指纹"识别同批次已过账则跳过。
//
// 退出码：0 成功/无错误；1 参数错误；2 有错误或写入失败
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Api, ApiError } from './lib/api.mjs';
import { loadXlsx, readSheet, writeTemplate, writeCsv } from './lib/excel.mjs';
import { validate, SHEETS, F, gtinCheckOk } from './lib/validate.mjs';
import { norm, safeName } from './lib/text.mjs';

const VERSION = '1.0.0';
const TPL_NAME = 'labelflow-迁移模板.xlsx';

// ---------------------------------------------------------------- 参数解析
function parseArgs(argv) {
  const a = {
    cmd: '', file: '', outDir: '', base: 'http://127.0.0.1:3200/api/v1',
    user: 'admin', pass: 'admin123', tenant: 'default', token: '',
    update: false, force: false, dryRun: false, forceStock: false, verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    switch (v) {
      case '--template': a.cmd = 'template'; a.outDir = argv[++i] || '.'; break;
      case '--check': a.cmd = 'check'; a.file = argv[++i] || ''; break;
      case '--apply': a.cmd = 'apply'; a.file = argv[++i] || ''; break;
      case '--base': a.base = argv[++i]; break;
      case '--user': a.user = argv[++i]; break;
      case '--pass': a.pass = argv[++i]; break;
      case '--tenant': a.tenant = argv[++i]; break;
      case '--token': a.token = argv[++i]; break;
      case '--out': a.outDir = argv[++i]; break;
      case '--update': a.update = true; break;
      case '--force': a.force = true; break;
      case '--dry-run': a.dryRun = true; break;
      case '--force-stock': a.forceStock = true; break;
      case '--verbose': a.verbose = true; break;
      case '-h': case '--help': a.cmd = 'help'; break;
      case '-v': case '--version': a.cmd = 'version'; break;
      default:
        if (v.startsWith('-')) throw new Error(`未知参数：${v}`);
        if (!a.file) a.file = v;
        else throw new Error(`多余的参数：${v}`);
    }
  }
  return a;
}

const HELP = `
LabelFlow 客户数据迁移工具 v${VERSION}

用法：
  node import.mjs --template [目录]                     生成迁移模板（默认 ./migration）
  node import.mjs --check <xlsx> [--out 目录]            离线校验并生成报告
  node import.mjs --apply <xlsx> [选项]                  校验后导入

连接选项（--apply 用，也可用环境变量）：
  --base     API 根地址        默认 http://127.0.0.1:3200/api/v1
  --user     登录账号          默认 admin
  --pass     登录密码          默认 admin123（客户现场务必改）
  --tenant   租户编码          默认 default
  --token    直接给 accessToken（免登录）

行为选项：
  --update         物料已存在时用 PUT 更新（默认跳过已存在）
  --force          校验有错误也继续写入（不建议）
  --dry-run        只做连接与前置检查，不写任何数据
  --force-stock    跳过"同批次期初已过账"的幂等检查（会导致库存翻倍，慎用）

环境变量：LABELFLOW_BASE / LABELFLOW_USER / LABELFLOW_PASS / LABELFLOW_TENANT / LABELFLOW_TOKEN

数据表说明见模板里的 00_说明 工作表，或 docs/39-customer-data-migration.md。
`;

// ---------------------------------------------------------------- 模板
function genTemplate(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, TPL_NAME);
  const note = [
    ['LabelFlow 迁移模板使用说明'],
    [''],
    ['1) 只填有数据的 sheet；空 sheet 会被跳过。整行以 # 开头视为说明行，导入时自动忽略。'],
    ['2) 列名不要改。表头行不要删。多出来的空列会被忽略。'],
    ['3) GTIN 必须是纯数字，末位是校验位，工具会校验；不确定就用现成的 UDI 码，别手编。'],
    ['4) 箱/托档必须同时填 GTIN 和数量；单件档数量固定为 1。'],
    ['5) 期初库存会用"库存调整单(GAIN)"过账，因此在库存流水里可查、有操作人，不是直写数据库。'],
    ['6) 日期格式 YYYY-MM-DD。数量支持小数（如 kg 物料）。'],
    ['7) 先跑 --check 出报告改干净，再 --apply；有错误时工具默认拒绝写入。'],
    ['8) 物料编码/仓库编码/库位编码必须与系统里一致；仓库和库位需要先在系统里建好（或用 seeds 建）。'],
    ['9) 工单的配料明细填在 05_工单明细（按工单号挂）；若产品已有启用中的 BOM，可把 03 表的"按BOM展开"填"是"而不填明细。'],
    [''],
    ['导入顺序：物料 → 期初库存 → 工单 → 收货单（工具自动按此顺序执行）'],
  ];
  writeTemplate(file, [
    {
      name: '01_物料',
      header: [F.material.code, F.material.name, F.material.spec, F.material.unit, F.material.category,
        F.material.safetyStock, F.material.udi, F.material.autoPrint,
        F.material.gtinUnit, F.material.gtinCarton, F.material.cartonQty, F.material.gtinPallet, F.material.palletQty,
        F.material.wh, F.material.loc],
      widths: [18, 28, 22, 8, 14, 10, 10, 10, 18, 18, 10, 18, 10, 14, 14],
      rows: [
        ['# 示例：真空采血管 5ml', '真空采血管 5ml（EDTA）', '5ml 紫色', '支', '采血耗材', 500, '是', '是',
          '06901234500172', '06901234501056', 100, '', '', 'WH-DEMO', 'A-01-01'],
      ],
    },
    {
      name: '02_期初库存',
      header: [F.stock.sku, F.stock.wh, F.stock.loc, F.stock.batch, F.stock.qty, F.stock.note],
      widths: [18, 14, 14, 16, 10, 24],
      rows: [['# 示例：批号 LOT-2026A 数量 200', 'MD-VAC-5', 'WH-DEMO', 'A-01-01', 'LOT-2026A', 200, '客户期初']],
    },
    {
      name: '03_工单',
      header: [F.wo.woNo, F.wo.product, F.wo.demand, F.wo.wh, F.wo.priority, F.wo.start, F.wo.expandBom, F.wo.remark],
      widths: [18, 18, 10, 14, 8, 14, 12, 24],
      rows: [['# 示例：不填工单号则系统自动生成', 'WO-CUST-001', 'MD-SYR-05', 100, 'WH-DEMO', 5, '2026-12-01', '否', '客户首批订单']],
    },
    {
      name: '04_收货单',
      header: [F.receipt.receiptNo, F.receipt.wh, F.receipt.sku, F.receipt.qty, F.receipt.batch],
      widths: [18, 14, 18, 12, 16],
      rows: [['# 示例：同一单号多行=一张单多条明细', 'GRN-CUST-001', 'WH-DEMO', 'MD-VAC-5', 200, 'LOT-2026A']],
    },
    {
      name: '05_工单明细',
      header: [F.woLine.woNo, F.woLine.sku, F.woLine.qty, F.woLine.batch],
      widths: [18, 18, 12, 16],
      rows: [['# 示例：工单号必须与 03_工单 一致；不填批号则发料时再指定', 'WO-CUST-001', 'MD-VAC-5', 200, 'LOT-2026A']],
    },
    { name: '00_说明', header: ['说明'], widths: [120], rows: note },
  ]);
  console.log(`模板已生成：${file}`);
  console.log(`下一步：把客户数据填进 01~04 表，然后 node import.mjs --check ${file}`);
}

// ---------------------------------------------------------------- 校验
function runCheck(file, outDir) {
  if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
  if (!/\.(xlsx|xlsm)$/i.test(file)) throw new Error('只支持 .xlsx（Excel 2007+）。.xls 请另存为 .xlsx');
  const wb = loadXlsx().readFile(file);
  const { issues, data } = validate(wb, readSheet);

  const base = path.basename(file, path.extname(file));
  const dir = outDir || path.join(path.dirname(file), 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const tag = `${safeName(base)}-${ts}`;

  reportConsole(file, data, issues);

  const csvFile = path.join(dir, `校验报告-${tag}.csv`);
  writeCsv(csvFile, ['工作表', '行号', '字段', '级别', '说明'],
    issues.list.map((i) => [i.sheet, i.row || '-', i.field || '-', i.level, i.message]));
  const jsonFile = path.join(dir, `校验报告-${tag}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify({
    file, checkedAt: new Date().toISOString(),
    counts: countOf(data),
    errors: issues.errors.length, warnings: issues.warns.length,
    issues: issues.list,
  }, null, 2), 'utf8');

  console.log(`\n报告：${csvFile}`);
  console.log(`      ${jsonFile}`);
  if (issues.errors.length) {
    console.log(`\n有 ${issues.errors.length} 个错误，需修正后才能导入（前 10 条）：`);
    issues.errors.slice(0, 10).forEach((e) => console.log(`  · ${e.sheet} 第${e.row}行 ${e.field}：${e.message}`));
    return 2;
  }
  console.log('\n校验通过，可以执行 --apply。');
  return { code: 0, data, issues, jsonFile };
}

function countOf(data) {
  return {
    物料: data.materials.length,
    期初库存行: data.stocks.length,
    工单: data.wos.length,
    工单明细行: data.woLines.length,
    收货单: data.receipts.length,
    收货单行: data.receipts.reduce((n, g) => n + g.rows.length, 0),
  };
}

function reportConsole(file, data, issues) {
  console.log(`== 校验 ${path.basename(file)} ==`);
  Object.entries(countOf(data)).forEach(([k, v]) => console.log(`  ${k}：${v}`));
  const errs = issues.errors.length;
  const warns = issues.warns.length;
  console.log(`  错误 ${errs} 条，警告 ${warns} 条`);
  const bySheet = new Map();
  issues.list.forEach((i) => {
    const k = `${i.sheet}`;
    const c = bySheet.get(k) || { e: 0, w: 0 };
    if (i.level === '错误') c.e += 1; else c.w += 1;
    bySheet.set(k, c);
  });
  [...bySheet.entries()].forEach(([k, c]) => console.log(`    - ${k}：错误 ${c.e}，警告 ${c.w}`));
  if (warns) {
    console.log('  警告（不阻塞导入，但建议处理）：');
    issues.warns.slice(0, 8).forEach((w) => console.log(`  · ${w.sheet} 第${w.row}行 ${w.field}：${w.message}`));
    if (warns > 8) console.log(`  · …另有 ${warns - 8} 条见报告`);
  }
}

// ---------------------------------------------------------------- 导入
async function runApply(a) {
  const chk = runCheck(a.file, a.outDir);
  if (chk === 2) {
    if (!a.force) {
      console.error('\n校验有错误，已停止（如确要强行写入加 --force，不建议）。');
      return 2;
    }
    console.warn('\n--force：忽略校验错误继续写入（可能产生脏数据）');
  }
  const { data } = chk;

  const api = new Api(a.base, { token: a.token });
  console.log(`\n== 连接 ${a.base} ==`);
  try {
    await api.health();
  } catch (e) {
    console.error(`无法访问后端：${e.message}`);
    console.error('  排查：后端是否已启动？地址是否带 /api/v1？');
    return 2;
  }
  if (!api.token) {
    await api.login({ username: a.user, password: a.pass, tenantCode: a.tenant });
    console.log(`  登录成功：${a.user}@${a.tenant}`);
  } else {
    console.log('  使用传入的 token');
  }

  // 仓库 / 库位
  const whs = await api.get('/inventory/masterdata/warehouses');
  const whByCode = new Map(whs.map((w) => [norm(w.code), w]));
  const locs = await api.get('/inventory/masterdata/locations');
  const locByKey = new Map(locs.map((l) => [`${l.warehouseId}|${norm(l.code)}`, l]));
  console.log(`  仓库 ${whs.length} 个，库位 ${locs.length} 个`);

  const result = { materials: [], stocks: [], wos: [], receipts: [], fatal: [] };
  const missingWh = new Set();
  const checkWh = (code, where) => {
    const w = whByCode.get(norm(code));
    if (!w) { missingWh.add(code); result.fatal.push(`${where}：仓库编码不存在 ${code}`); }
    return w;
  };
  const locIdOf = (whId, code, where) => {
    if (!code) return undefined;
    const l = locByKey.get(`${whId}|${norm(code)}`);
    if (!l) { result.fatal.push(`${where}：库位编码不存在 ${code}（仓库 ${whs.find((w) => w.id === whId)?.code}）`); return undefined; }
    return l.id;
  };

  // 前置预检：所有引用的仓库/库位必须存在，避免建了一半才发现编码错
  for (const it of data.materials) {
    if (!it.warehouseCode) continue;
    const w = checkWh(it.warehouseCode, `01_物料 第${it.row}行`);
    if (w && it.locationCode) locIdOf(w.id, it.locationCode, `01_物料 第${it.row}行`);
  }
  for (const s of data.stocks) {
    const w = checkWh(s.warehouseCode, `02_期初库存 第${s.row}行`);
    if (w && s.locationCode) locIdOf(w.id, s.locationCode, `02_期初库存 第${s.row}行`);
  }
  data.wos.forEach((w) => checkWh(w.warehouseCode, `03_工单 第${w.row}行`));
  data.receipts.forEach((g) => checkWh(g.warehouseCode, `04_收货单 ${g.receiptNo}`));
  if (result.fatal.length && !a.force) {
    console.error('\n前置检查未通过，未写入任何数据：');
    result.fatal.slice(0, 15).forEach((f) => console.error(`  · ${f}`));
    if (result.fatal.length > 15) console.error(`  · …另有 ${result.fatal.length - 15} 条`);
    console.error('  请先在系统里建好仓库/库位，或修正模板里的编码（确要强行继续加 --force）');
    return 2;
  }
  if (result.fatal.length) console.warn(`  前置问题 ${result.fatal.length} 条，--force 继续（相关行会失败）`);

  // 1) 物料
  console.log('\n-- 1/4 物料 --');
  let mOk = 0; let mSkip = 0; let mFail = 0;
  for (const it of data.materials) {
    const where = `01_物料 第${it.row}行`;
    try {
      const exist = await findMaterial(api, it.code);
      if (exist) {
        if (!a.update) { mSkip += 1; result.materials.push({ row: it.row, code: it.code, status: '跳过', message: '已存在（需要更新加 --update）' }); continue; }
        await api.put(`/inventory/masterdata/materials/${exist.id}`, buildMaterialBody(it, checkWh, locIdOf, where));
        mOk += 1; result.materials.push({ row: it.row, code: it.code, status: '更新' });
        continue;
      }
      if (a.dryRun) { mOk += 1; result.materials.push({ row: it.row, code: it.code, status: '可创建(演练)' }); continue; }
      await api.post('/inventory/masterdata/materials', buildMaterialBody(it, checkWh, locIdOf, where));
      mOk += 1; result.materials.push({ row: it.row, code: it.code, status: '新建' });
    } catch (e) {
      mFail += 1;
      result.materials.push({ row: it.row, code: it.code, status: '失败', message: errText(e) });
      console.log(`  ✗ ${it.code}：${errText(e)}`);
    }
  }
  console.log(`  物料：成功 ${mOk}，跳过 ${mSkip}，失败 ${mFail}`);

  // 2) 期初库存（分批：每单 ≤50 行，按仓库分）
  console.log('\n-- 2/4 期初库存 --');
  const fp = fingerprints(a.file);
  const batches = [];
  for (const [whCode, rows] of groupBy(data.stocks, (r) => norm(r.warehouseCode))) {
    for (let i = 0; i < rows.length; i += 50) batches.push({ whCode, rows: rows.slice(i, i + 50), part: Math.floor(i / 50) + 1 });
  }
  let sOk = 0; let sFail = 0; let sLines = 0; let sSkipBal = 0;
  for (const b of batches) {
    const wh = checkWh(b.whCode, `02_期初库存 第${b.rows[0].row}行`);
    if (!wh) { sFail += b.rows.length; continue; }
    const reason = `期初导入 ${fp.tag}#${b.part}`;
    try {
      if (!a.forceStock) {
        const dup = await alreadyPosted(api, reason);
        if (dup) {
          console.log(`  ~ 仓库 ${b.whCode} 批次 ${b.part} 已过账（${dup.adjustNo}），跳过（防重复入库）`);
          sOk += b.rows.length; result.stocks.push({ warehouseCode: b.whCode, part: b.part, status: '跳过(已过账)', adjustNo: dup.adjustNo });
          continue;
        }
      }
      const lines = [];
      const skipped = [];
      for (const r of b.rows) {
        const locId = locIdOf(wh.id, r.locationCode, `02_期初库存 第${r.row}行`);
        if (r.locationCode && !locId) { skipped.push({ row: r.row, message: '库位不存在' }); continue; }
        if (!a.forceStock) {
          const bal = await balanceOf(api, r.sku, wh.id, r.batchNo);
          if (bal > 0) {
            sSkipBal += 1;
            result.stocks.push({ row: r.row, sku: r.sku, status: '跳过(已有余额)', message: `该物料在该仓库/批号已有余额 ${bal}，为防重复入库跳过` });
            console.log(`  ~ 第${r.row}行 ${r.sku}/批号 ${r.batchNo || '-'}：已有余额 ${bal}，跳过`);
            continue;
          }
        }
        lines.push({ sku: r.sku, batchNo: r.batchNo || null, locationId: locId ?? null, qtyDelta: r.qty, note: r.note || `迁移 ${fp.tag}` });
      }
      if (!lines.length) { sFail += skipped.length; result.stocks.push({ warehouseCode: b.whCode, part: b.part, status: '失败', message: '全部行库位不存在' }); continue; }
      if (a.dryRun) {
        sOk += lines.length;
        result.stocks.push({ warehouseCode: b.whCode, part: b.part, status: `可过账(演练) ${lines.length} 行` });
        continue;
      }
      const doc = await api.post('/inventory/adjustments', {
        adjustType: 'GAIN', warehouseId: wh.id, reason,
        remark: `客户数据迁移 ${path.basename(a.file)} 第 ${b.rows[0].row}-${b.rows[b.rows.length - 1].row} 行`,
        lines,
      });
      const id = doc?.id ?? doc?.adjustmentId ?? doc?.adjust?.id;
      if (!id) throw new Error('调整单已创建但没拿到 id，无法过账（检查接口返回）');
      if (a.dryRun) {
        sOk += lines.length;
        result.stocks.push({ warehouseCode: b.whCode, part: b.part, status: `可过账(演练) ${lines.length} 行` });
        continue;
      }
      await api.post(`/inventory/adjustments/${id}/post`);
      sOk += lines.length; sLines += lines.length;
      result.stocks.push({ warehouseCode: b.whCode, part: b.part, status: '已过账', adjustNo: doc.adjustNo || String(id), lines: lines.length });
      console.log(`  ✓ ${b.whCode} 批次 ${b.part}：${lines.length} 行已过账（${doc.adjustNo || id}）`);
      skipped.forEach((s) => { sFail += 1; result.stocks.push({ ...s, status: '失败' }); });
    } catch (e) {
      sFail += b.rows.length;
      result.stocks.push({ warehouseCode: b.whCode, part: b.part, status: '失败', message: errText(e) });
      console.log(`  ✗ ${b.whCode} 批次 ${b.part}：${errText(e)}`);
    }
  }
  console.log(`  期初：过账 ${sLines} 行，跳过(已有余额) ${sSkipBal} 行，失败 ${sFail} 行`);

  // 3) 工单
  console.log('\n-- 3/4 工单 --');
  let wOk = 0; let wFail = 0; let wSkip = 0;
  if (data.wos.length) {
    // 后端上限 200 行/批，行内失败有 rowNo 回传
    for (let i = 0; i < data.wos.length; i += 200) {
      const chunk = data.wos.slice(i, i + 200);
      try {
        const rows = chunk.map((w) => {
          const wh = checkWh(w.warehouseCode, `03_工单 第${w.row}行`);
          const lines = data.woLines
            .filter((l) => w.woNo && l.woNo === w.woNo)
            .map((l) => ({ materialCode: l.sku, qtyRequired: l.qtyRequired, batchNo: l.batchNo }));
          return {
            woNo: w.woNo, productCode: w.productCode, demandQty: w.demandQty,
            warehouseId: wh?.id, priority: w.priority || 0,
            plannedStartAt: w.plannedStartAt || undefined,
            expandBom: w.expandBom === true && !lines.length,
            lines: lines.length ? lines : undefined,
            remark: w.remark || undefined, rowNo: w.row,
          };
        });
        const r = await api.post('/wms/work-orders/import', { rows });
        wOk += Number(r?.created ?? 0);
        wFail += (r?.errors || []).filter((e) => !/已存在/.test(String(e.message))).length;
        (r?.errors || []).forEach((e) => {
          if (/已存在/.test(String(e.message))) {
            wSkip += 1;
            result.wos.push({ row: e.rowNo, status: '跳过(工单号已存在)', message: e.message });
          } else {
            result.wos.push({ row: e.rowNo, status: '失败', message: e.message });
          }
        });
        console.log(`  ${Number(r?.created ?? 0)} 张成功，${(r?.errors || []).filter((e) => !/已存在/.test(String(e.message))).length} 张失败，${wSkip} 张已存在跳过`);
      } catch (e) {
        wFail += chunk.length;
        result.wos.push({ status: '失败', message: errText(e) });
        console.log(`  ✗ 本批失败：${errText(e)}`);
      }
    }
  } else console.log('  无工单数据，跳过');

  // 4) 收货单
  console.log('\n-- 4/4 收货单 --');
  let rOk = 0; let rFail = 0;
  for (const g of data.receipts) {
    const wh = checkWh(g.warehouseCode, `04_收货单 ${g.receiptNo}`);
    if (!wh) { rFail += 1; continue; }
    try {
      const r = await api.post('/wms/receipts/import', {
        receiptNo: g.receiptNo, warehouseId: wh.id,
        sourceNo: `MIG-${fp.sha8}`, rows: g.rows.map((x) => ({ sku: x.sku, batchNo: x.batchNo, qtyExpected: x.qtyExpected })),
      });
      const created = Number(r?.created ?? r?.rows ?? g.rows.length);
      const errs = Number(r?.errors?.length ?? 0);
      rOk += created; rFail += errs;
      if (errs) (r.errors || []).forEach((e) => result.receipts.push({ receiptNo: g.receiptNo, row: e.row, status: '行失败', message: e.error }));
      console.log(`  ${errs ? '~' : '✓'} ${g.receiptNo}：${created} 行${errs ? `，${errs} 行失败` : ''}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // 单号已存在：不是数据错误，是重复执行。提示人工核对明细行数，不计入失败
        result.receipts.push({ receiptNo: g.receiptNo, status: '跳过(单号已存在)', message: '如上次导入中断导致该单明细不全，请在系统里删单后重导' });
        console.log(`  ~ ${g.receiptNo}：单号已存在，跳过（明细不全会导致后续收不上货，请核对）`);
        continue;
      }
      rFail += g.rows.length;
      result.receipts.push({ receiptNo: g.receiptNo, status: '失败', message: errText(e) });
      console.log(`  ✗ ${g.receiptNo}：${errText(e)}`);
    }
  }
  if (!data.receipts.length) console.log('  无收货单数据，跳过');

  // 汇总
  const failCount = mFail + sFail + wFail + rFail + result.fatal.length;
  const summary = {
    file: path.resolve(a.file), appliedAt: new Date().toISOString(), dryRun: a.dryRun,
    materials: { ok: mOk, skipped: mSkip, failed: mFail },
    stocks: { postedLines: sLines, skippedByBalance: sSkipBal, failed: sFail },
    workOrders: { ok: wOk, skippedExisting: wSkip, failed: wFail },
    receipts: { okLines: rOk, failed: rFail },
    fatal: result.fatal,
    details: result,
    fingerprint: fp.tag,
  };
  const dir = a.outDir || path.join(path.dirname(a.file), 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `导入结果-${fp.tag}.json`);
  fs.writeFileSync(out, JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n== 汇总 ==');
  console.log(`  物料 成功${mOk} 跳过${mSkip} 失败${mFail}`);
  console.log(`  期初 过账${sLines}行 跳过${sSkipBal}行 失败${sFail}`);
  console.log(`  工单 成功${wOk} 跳过${wSkip} 失败${wFail}`);
  console.log(`  收货 成功${rOk}行 失败${rFail}`);
  if (result.fatal.length) {
    console.log(`  前置问题 ${result.fatal.length} 条：`);
    result.fatal.slice(0, 8).forEach((f) => console.log(`   · ${f}`));
  }
  console.log(`  结果文件：${out}`);
  if (a.dryRun) console.log('  这是演练（--dry-run），没有写入任何数据');

  return failCount ? 2 : 0;
}

function buildMaterialBody(it, checkWh, locIdOf, where) {
  const body = {
    code: it.code, name: it.name, spec: it.spec, unit: it.unit, category: it.category,
    safetyStock: it.safetyStock, udiRequired: it.udiRequired, autoPrint: it.autoPrint,
    gtins: it.gtins,
  };
  if (it.warehouseCode) {
    const wh = checkWh(it.warehouseCode, where);
    body.defaultWarehouseId = wh?.id;
    if (it.locationCode && wh) body.defaultLocationId = locIdOf(wh.id, it.locationCode, where);
  }
  return body;
}

async function findMaterial(api, code) {
  const rows = await api.get(`/inventory/masterdata/materials?limit=10&keyword=${encodeURIComponent(code)}`);
  const arr = Array.isArray(rows) ? rows : (rows?.rows || []);
  return arr.find((r) => norm(r.code) === code) || null;
}

const _balCache = new Map();
async function balanceOf(api, sku, warehouseId, batchNo) {
  const key = `${sku}|${warehouseId}|${batchNo || ''}`;
  if (_balCache.has(key)) return _balCache.get(key);
  const r = await api.get(`/inventory/stock?groupBy=batch&limit=100&keyword=${encodeURIComponent(sku)}`);
  let sum = 0;
  for (const it of (r?.items || [])) {
    if (norm(it.code) !== sku) continue;
    if (Number(it.warehouseId) !== Number(warehouseId)) continue;
    if (norm(it.batchNo) !== norm(batchNo)) continue;
    sum += Number(it.qty) || 0;
  }
  _balCache.set(key, sum);
  return sum;
}

async function alreadyPosted(api, reason) {
  // 不区分状态：只要是同指纹的调整单（草稿或已过账）都视为该批次已处理过，避免重复入库
  const r = await api.get(`/inventory/adjustments?pageSize=100&keyword=${encodeURIComponent(reason)}`);
  const arr = Array.isArray(r) ? r : (r?.rows || r?.items || []);
  return arr.find((x) => norm(x.reason) === norm(reason)) || null;
}

function fingerprints(file) {
  const buf = fs.readFileSync(file);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return { sha256, sha8: sha256.slice(0, 8), tag: `MIG-${sha256.slice(0, 8)}` };
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function errText(e) {
  if (e instanceof ApiError) return e.status ? `[${e.status}] ${e.message}` : e.message;
  return e?.message || String(e);
}

// ---------------------------------------------------------------- main
(async () => {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); console.error(HELP); process.exit(1); }

  const env = {
    base: process.env.LABELFLOW_BASE, user: process.env.LABELFLOW_USER,
    pass: process.env.LABELFLOW_PASS, tenant: process.env.LABELFLOW_TENANT, token: process.env.LABELFLOW_TOKEN,
  };
  ['base', 'user', 'pass', 'tenant', 'token'].forEach((k) => { if (env[k]) args[k] = env[k]; });

  try {
    switch (args.cmd) {
      case 'help': console.log(HELP); process.exit(0);
      case 'version': console.log(VERSION); process.exit(0);
      case 'template': genTemplate(args.outDir || './migration'); process.exit(0);
      case 'check': {
        const r = runCheck(args.file, args.outDir);
        process.exit(r === 2 ? 2 : 0);
      }
      case 'apply': {
        const code = await runApply(args);
        process.exit(code || 0);
      }
      default:
        console.log(HELP); process.exit(1);
    }
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    if (args?.verbose) console.error(e.stack);
    process.exit(args?.cmd === 'apply' ? 2 : 1);
  }
})();
