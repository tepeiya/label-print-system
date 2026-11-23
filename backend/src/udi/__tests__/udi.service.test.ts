// UDI 服务层单测：扫码复核判定 + 模板包自洽性（不连库、不起 HTTP）
import test from 'node:test';
import assert from 'node:assert/strict';
import { gtinCheckDigit } from '../../../core/checksum';
import { UdiService } from '../udi.service';
import { UDI_TEMPLATES } from '../udi.templates';

const body = '0690123456789';
const gtin14 = body + gtinCheckDigit(body);
const svc = new UdiService();

const code = `(01)${gtin14}(17)271231(10)LOT01(21)SN0001`;

test('扫码复核：完全一致 → match', () => {
  const r = svc.scanVerify({ code, expect: { gtin: gtin14, expiry: '2027-12-31', lot: 'LOT01', serial: 'SN0001' } });
  assert.equal(r.ok, true);
  assert.equal(r.mismatches.length, 0);
  assert.match(r.message, /复核通过/);
});

test('扫码复核：批号不符 → 明确指到字段', () => {
  const r = svc.scanVerify({ code, expect: { lot: 'LOT99' } });
  assert.equal(r.ok, false);
  assert.equal(r.mismatches[0].field, 'lot');
  assert.match(r.message, /lot/);
});

test('扫码复核：期望日期格式不同但语义相同，不应误报', () => {
  const r = svc.scanVerify({ code, expect: { expiry: '2027-12-31' } });
  assert.equal(r.match, true);
});

test('扫码复核：strict 模式下缺字段算不符（发货整单校验用）', () => {
  const shortCode = `(01)${gtin14}(10)LOT01`;
  const r = svc.scanVerify({ code: shortCode, expect: { serial: 'SN0001' }, strict: true });
  assert.equal(r.ok, false);
  assert.equal(r.mismatches.some((m) => m.field === 'serial' && m.actual === null), true);
});

test('扫码复核：码本身不合规时直接判失败', () => {
  const r = svc.scanVerify({ code: 'NOT-A-GS1-CODE', expect: {} });
  assert.equal(r.ok, false);
  assert.equal(r.codeOk, false);
  assert.match(r.message, /不合规/);
});

test('批量构造：部分成功口径 + 行号回填', () => {
  const r = svc.batchEncode({
    rows: [
      { gtin: gtin14, lot: 'L1', expiry: '2027-12-31' },
      { gtin: gtin14, lot: 'A'.repeat(21) },
    ],
  });
  assert.equal(r.total, 2);
  assert.equal(r.created, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.results[0].rowNo, 1);
  assert.equal(r.results[1].ok, false);
});

test('模板包：3 个规格，且都能按 code 取到完整 JSON', () => {
  const list = svc.templates();
  assert.equal(list.items.length, 3);
  for (const item of list.items) {
    const payload = svc.templatePayload(item.code);
    assert.equal(payload.code, item.code);
    assert.ok(payload.template.elements.length > 0);
  }
});

test('模板包：UDI 码元素必须 gs1=true 且内容含 01 占位', () => {
  for (const t of UDI_TEMPLATES) {
    const dm = (t.template.elements as any[]).filter((e) => e.type === 'qrcode');
    assert.ok(dm.length >= 1, `${t.code} 缺 DataMatrix 元素`);
    for (const e of dm) {
      assert.equal(e.qrcode.gs1, true, `${t.code} 的码元素未开启 gs1`);
      assert.equal(String(e.qrcode.content).includes('(01)'), true, `${t.code} 的码内容缺 AI 01`);
      assert.equal(e.qrcode.sym, 'DATAMATRIX');
    }
  }
});

test('模板包：元素坐标不越界（页面尺寸内）', () => {
  for (const t of UDI_TEMPLATES) {
    const page = t.template.page;
    for (const e of t.template.elements as any[]) {
      assert.ok(e.x >= 0 && e.y >= 0, `${t.code}/${e.id} 坐标越界`);
      assert.ok(e.x + e.w <= page.widthMm + 0.01, `${t.code}/${e.id} 右边界越界`);
      assert.ok(e.y + e.h <= page.heightMm + 0.01, `${t.code}/${e.id} 下边界越界`);
    }
  }
});

test('模板包：占位变量都已声明', () => {
  for (const t of UDI_TEMPLATES) {
    const declared = new Set((t.template.variables as any[]).map((v) => v.name));
    const used = JSON.stringify(t.template.elements).match(/\{\{(\w+)\}\}/g) ?? [];
    for (const u of used) {
      const name = u.replace(/[{}]/g, '');
      assert.equal(declared.has(name), true, `${t.code} 使用了未声明变量 ${name}`);
    }
  }
});
