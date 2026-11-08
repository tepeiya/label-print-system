// =============================================================================
// engines.test.ts —— 核心引擎单元测试（node:test + tsx，零业务依赖可跑）
// 运行：node --import tsx --test backend/core/__tests__/engines.test.ts
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { safeEval, detectCircularDeps, tokenize, extractVars } from '../formula-engine';
import { gtinCheckDigit, code39CheckChar, code128CheckValue } from '../checksum';
import { SerialNumberService, type DbManager, type SerialRow } from '../serial-number.service';
import { mmToDots } from '../zpl-generator';
import { mmToDots as mmToDotsT } from '../tspl-generator';
import { generateZpl } from '../zpl-generator';
import { buildJob as buildTspl } from '../tspl-generator';
import { renderBarcodeToPng, validateBarcode } from '../barcode-renderer';

// ----------------------------- 1. 公式引擎 -----------------------------
test('公式-四则/括号/字符串拼接', () => {
  assert.equal(safeEval('1 + 2 * 3', {}).value, 7);
  assert.equal(safeEval('(1 + 2) * 3', {}).value, 9);
  assert.equal(safeEval('CONCAT("A", "B", "C")', {}).value, 'ABC');
  assert.equal(safeEval('"a" + "b"', {}).value, 'ab'); // 字符串+字符串→拼接
});

test('公式-变量与 IF/CHECKSUM', () => {
  const r = safeEval('IF(LEN({{sku}}) > 3, "长", "短")', { sku: '12345' });
  assert.equal(r.value, '长');
  // CHECKSUM 复用校验位算法：EAN13 对 12 位数据的校验位
  const cd = safeEval('CHECKSUM("EAN13", "690123456789")', {}).value;
  assert.equal(cd, '2');
  assert.equal(gtinCheckDigit('690123456789'), '2');
});

test('公式-除零/未定义变量不阻断（ok:false）', () => {
  assert.equal(safeEval('1 / 0', {}).ok, false);
  assert.equal(safeEval('{{nope}}', {}).ok, false);
});

test('公式-禁止代码注入（无 eval/process）', () => {
  // 表达式中的 process 不是白名单标识符，求值时抛错，绝不执行
  const r = safeEval('process.exit(1)', {});
  assert.equal(r.ok, false);
  assert.match(r.error!, /未知|未定义|标识符|字符|识别|无法/);
});

test('公式-循环依赖检测', () => {
  const cycle = detectCircularDeps({ a: '{{b}} + 1', b: '{{a}} + 1' });
  assert.ok(cycle.length >= 2);
  // 无环
  assert.deepEqual(detectCircularDeps({ a: '{{b}}', b: '2' }), []);
});

test('公式-词法抽取变量', () => {
  assert.deepEqual(extractVars('A{{x}}B{{ y }}C').sort(), ['x', 'y']);
});

// ----------------------------- 2. 校验位算法 -----------------------------
test('校验位-EAN13/Code39/Code128', () => {
  // EAN13 对 12 位数据的校验位（内部一致：690123456789 → 校验位 2）
  assert.equal(gtinCheckDigit('690123456789'), '2');
  assert.equal(code39CheckChar('ABC'), 'X');
  assert.ok(Number.isInteger(code128CheckValue('ABC123')));
  assert.ok(code128CheckValue('ABC123') >= 0 && code128CheckValue('ABC123') < 103);
});

// ----------------------------- 3. 流水号并发安全（行锁+号段预分配） -----------------------------
class MemDb implements DbManager {
  private rows = new Map<number, SerialRow>();
  private next = 1;
  private usage: any[] = [];
  seed(row: Omit<SerialRow, 'id'>) { const id = this.next++; this.rows.set(id, { ...row, id }); return id; }
  transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> { return fn(this); } // 单线程天然串行=行锁
  async queryOneForUpdate(_tx: any, _sql: string, p: any[]): Promise<SerialRow | undefined> {
    const [tenantId, ref] = p;
    for (const r of this.rows.values())
      if (r.tenant_id === tenantId && (r.name === ref || `${r.scope}:${r.group_key ?? ''}` === ref))
        return { ...r };
    return undefined;
  }
  async updateCurrent(_tx: any, _sql: string, p: any[]): Promise<void> {
    const [next, , id, tenantId] = p;
    const r = this.rows.get(id)!;
    assert.equal(r.tenant_id, tenantId);
    r.current_value = next; r.version++;
  }
  async insertUsage(_tx: any, _sql: string, p: any[]): Promise<void> {
    const [, , value, formatted] = p;
    this.usage.push({ value, formatted });
  }
  usageCount() { return this.usage.length; }
}

test('流水号-号段预分配不重号/不重叠', async () => {
  const db = new MemDb();
  const id = db.seed({
    tenant_id: 7, name: 'SN', scope: 'template', group_key: null,
    start_value: 1, step: 1, current_value: 1, digits: 5, prefix: 'NO', suffix: '',
    radix: 10, reset_cycle: 'never', reset_at: null, custom_cycle_days: null,
    allow_manual_reset: true, consume_mode: 'per_copy', rollback_policy: 'consume', version: 0,
  });
  const svc = new SerialNumberService(db as any);
  const a = await svc.allocate(7, 'SN', 100);
  const b = await svc.allocate(7, 'SN', 100);
  // 无重叠
  assert.equal(a.endValue <= b.startValue, true);
  // 全部唯一
  const all = [...a.values, ...b.values];
  assert.equal(new Set(all).size, all.length);
  // 前缀+补零格式
  assert.match(a.values[0], /^NO\d{5}$/);
  assert.equal(db.usageCount(), 200);
});

// ----------------------------- 4. DPI 换算 -----------------------------
test('DPI-毫米转点阵', () => {
  assert.equal(mmToDots(1, 203), 8);                 // 203dpi → 8 dots/mm
  assert.equal(mmToDots(25.4, 203), 203);            // 25.4mm=1英寸 → 精确 203 dots
  assert.equal(Math.round(mmToDots(1, 300)), 12);   // 11.81→12
  assert.equal(Math.round(mmToDots(1, 600)), 24);   // 23.62→24
  assert.equal(mmToDotsT(25.4, 203), 203);
});

// ----------------------------- 5. ZPL / TSPL 指令生成 -----------------------------
test('ZPL-生成含头尾与内容', () => {
  const { text: zpl, warnings: zplWarn } = generateZpl([{
    type: 'text', xMm: 2, yMm: 2, text: 'Hello', fontHeightMm: 4,
  }, {
    type: 'barcode', xMm: 4, yMm: 10,
    barcode: { sym: 'CODE128', content: 'ABC123', moduleWidthMm: 0.25, wideRatio: 2.5, heightMm: 10, showText: true, textPosition: 'bottom', checksum: true },
  }], 300);
  assert.equal(zplWarn.length, 0);
  assert.match(zpl, /\^XA/); assert.match(zpl, /\^XZ/);
  assert.match(zpl, /Hello/); assert.match(zpl, /ABC123/);
});

test('ZPL-不支持码制出 warning 不静默降级（P7.1）', () => {
  const { text: zpl, warnings } = generateZpl([{
    type: 'barcode', xMm: 4, yMm: 10,
    // CODE16K 不在 SUPPORTED_ZPL_BARCODES 里
    barcode: { sym: 'CODE16K', content: 'ABC123', moduleWidthMm: 0.25, wideRatio: 2.5, heightMm: 10, showText: true, textPosition: 'bottom', checksum: true },
  }], 300);
  assert.ok(warnings.length >= 1);
  assert.match(warnings[0], /CODE16K|不支持/);
  // 关键：不支持的码制**不应**再出 Code128 fallback 指令
  assert.doesNotMatch(zpl, /\^BC/);
});

test('TSPL-生成 SIZE/PRINT', () => {
  const { buffer, warnings: tsplWarn } = buildTspl([{ type: 'text', xMm: 2, yMm: 2, text: 'Hi', fontHeightMm: 4 }], 203, { widthMm: 60, heightMm: 40, gapMm: 2, copies: 1 });
  assert.equal(tsplWarn.length, 0);
  const s = buffer.toString('ascii');
  assert.match(s, /SIZE/); assert.match(s, /PRINT/); assert.match(s, /Hi/);
});

test('TSPL-不支持码制出 warning 不静默降级（P7.1）', () => {
  const { buffer, warnings } = buildTspl([{
    type: 'barcode', xMm: 4, yMm: 10,
    // CODE16K 不在 SUPPORTED_TSPL_BARCODES 里
    barcode: { sym: 'CODE16K', content: 'ABC123', moduleWidthMm: 0.25, wideRatio: 2.5, heightMm: 10, showText: true, textPosition: 'bottom', checksum: true },
  }], 203, { widthMm: 60, heightMm: 40, gapMm: 2, copies: 1 });
  assert.ok(warnings.length >= 1);
  assert.match(warnings[0], /CODE16K|不支持/);
  const s = buffer.toString('ascii');
  // 关键：不支持的码制**不应**再回落 '128'
  assert.doesNotMatch(s, /BARCODE.*128/);
});

// ----------------------------- 6. 条码出图（真实 PNG） -----------------------------
test('条码-Code128 输出有效 PNG', async () => {
  const png = await renderBarcodeToPng(
    { sym: 'CODE128', content: 'ABC123', moduleWidthMm: 0.3, wideRatio: 2.5, heightMm: 12, showText: false, textPosition: 'bottom' },
    300,
  );
  // PNG 文件签名
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.ok(png.length > 100);
});

test('条码-非法内容被拒', async () => {
  assert.equal(validateBarcode('EAN13', '12A4').ok, false);
  await assert.rejects(() => renderBarcodeToPng({ sym: 'EAN13', content: '12A4', moduleWidthMm: 0.3, wideRatio: 2.5, heightMm: 12, showText: false, textPosition: 'bottom' }, 300));
});
