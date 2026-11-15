// P8.5 RFID / EPC 数据层单测（纯函数，不需要读写器）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EPC_BANK, EPC_HEX_LEN, SGTIN_PARTITIONS, SGTIN96_HEADER,
  decodeSgtin96, encodeSgtin96, epcDedupeVerdict, normalizeEpcHex,
  rfidWriteJob, validGtin14, verifyEpcWrite,
} from '../epc.calc';
import { gtinCheckDigit } from '../../../core/checksum';

/** 由 13 位数据构造合法 GTIN-14，避免测试里硬编码可能算错的校验位 */
function gtin14(body13: string): string { return body13 + gtinCheckDigit(body13); }

test('分区表自洽：company+item 位宽恒 44、数字位数恒 13', () => {
  for (const p of SGTIN_PARTITIONS) {
    assert.equal(p.companyBits + p.itemBits, 44);
    assert.equal(p.companyDigits + p.itemDigits, 13);
  }
  assert.equal(SGTIN_PARTITIONS.length, 7);
  assert.equal(SGTIN96_HEADER, 0x30);
});

test('validGtin14：模 10 校验复用 checksum 真源', () => {
  const g = gtin14('1061414100041');
  assert.equal(validGtin14(g), true);
  assert.equal(validGtin14(g.slice(0, 13) + ((Number(g[13]) + 1) % 10)), false, '改校验位应失败');
  assert.equal(validGtin14('123'), false);
  assert.equal(validGtin14('abcdefghijklmn'), false);
});

test('encodeSgtin96：96 bit / 24 hex，分区位布局正确', () => {
  // 13 位 body = 指示符(1) + 公司前缀(7) + 项目参考(5)，对应 P=5
  const body = '1061414100041';
  const g = gtin14(body);
  const r = encodeSgtin96({ gtin: g, companyPrefixLen: 7, serial: 12345, filter: 1 });
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(r.epcHex?.length, EPC_HEX_LEN);
  assert.match(r.epcHex!, /^[0-9A-F]{24}$/);
  assert.equal(r.epcHex!.slice(0, 2), '30', 'SGTIN-96 header');
  assert.match(r.tagUri!, /^urn:epc:tag:sgtin-96:1\.0614141\.100041\.12345$/);
  // 前 14 bit = header(8) + filter(3) + partition(3) = 0x30<<6 | 1<<3 | 5
  const head = parseInt(r.epcHex!.slice(0, 4), 16) >> 2;
  assert.equal(head >> 6, 0x30);
  assert.equal((head >> 3) & 0b111, 1, 'filter=1');
  assert.equal(head & 0b111, 5, 'partition=5');
});

test('encodeSgtin96 / decodeSgtin96：往返一致，GTIN 校验位可重建', () => {
  for (const len of [6, 7, 8, 9, 10, 11, 12]) {
    const body = '1' + '123456789012'.slice(0, len) + '000000000000'.slice(0, 12 - len);
    const g = gtin14(body);
    const r = encodeSgtin96({ gtin: g, companyPrefixLen: len, serial: 2 ** 30, filter: 3 });
    assert.equal(r.ok, true, `len=${len}: ${r.errors.join('；')}`);
    const d = decodeSgtin96(r.epcHex!);
    assert.ok(d, `len=${len} 解码不应为 null`);
    assert.equal(d!.gtin, g);
    assert.equal(d!.serial, String(2 ** 30));
    assert.equal(d!.filter, 3);
    assert.equal(d!.partition, SGTIN_PARTITIONS.find((p) => p.companyDigits === len)!.p);
  }
});

test('encodeSgtin96：非法 GTIN / 分区 / 序列号超界全部拒绝，不静默截断', () => {
  const g = gtin14('1061414100041');
  assert.equal(encodeSgtin96({ gtin: '123', companyPrefixLen: 7, serial: 1 }).ok, false);
  assert.equal(encodeSgtin96({ gtin: g, companyPrefixLen: 13, serial: 1 }).ok, false);
  assert.equal(encodeSgtin96({ gtin: g, companyPrefixLen: 7, serial: 2n ** 38n } as any).ok, false);
  assert.equal(encodeSgtin96({ gtin: g, companyPrefixLen: 7, serial: -1 }).ok, false);
  assert.equal(encodeSgtin96({ gtin: g, companyPrefixLen: 7, serial: 'abc' }).ok, false);
  assert.equal(encodeSgtin96({ gtin: g, companyPrefixLen: 7, serial: 1, filter: 9 }).ok, false);
  assert.match(encodeSgtin96({ gtin: g, companyPrefixLen: 7, serial: -1 }).errors.join(' '), /超界/);
});

test('normalizeEpcHex：去空格/冒号/0x 前缀并统一大写，非法返回 null', () => {
  const raw = '30 74 25 7b f7 19 4e 40 00 00 1a 85'.replace(/ /g, '');
  assert.equal(normalizeEpcHex(raw.toLowerCase()), raw.toUpperCase());
  assert.equal(normalizeEpcHex('0x' + raw), raw.toUpperCase());
  assert.equal(normalizeEpcHex(raw.replace(/(..)/g, '$1:').replace(/:$/, '')), raw.toUpperCase());
  assert.equal(normalizeEpcHex('ZZ'), null);
  assert.equal(normalizeEpcHex(null), null);
});

test('verifyEpcWrite：写后读回一致才算 verified，脏值一律失败', () => {
  const g = gtin14('1061414100041');
  const epc = encodeSgtin96({ gtin: g, companyPrefixLen: 7, serial: 1 }).epcHex!;
  const ok = verifyEpcWrite(epc, ' ' + epc.toLowerCase().replace(/(..)/g, '$1 ').trim());
  assert.equal(ok.verified, true, '大小写/空格归一化后应一致');
  assert.equal(ok.normalizedReadBack, epc);
  assert.equal(verifyEpcWrite(epc, null).verified, false, '空读回不算成功');
  assert.equal(verifyEpcWrite(epc, 'ABC').verified, false);
  const other = (BigInt('0x' + epc) + 1n).toString(16).toUpperCase().padStart(24, '0');
  assert.equal(verifyEpcWrite(epc, other).verified, false, '写错一张必须被读回比对拦住');
  assert.match(verifyEpcWrite(epc, other).reason, /读回不一致/);
  assert.equal(verifyEpcWrite('bad', epc).ok, false);
});

test('rfidWriteJob：信封含 EPC bank / 读回期望 / 超时重试，jobKey 幂等', () => {
  const g = gtin14('1061414100041');
  const epc = encodeSgtin96({ gtin: g, companyPrefixLen: 7, serial: 1 }).epcHex!;
  const j = rfidWriteJob(7, 100, epc);
  assert.ok(j);
  assert.equal(j!.bank, EPC_BANK);
  assert.equal(j!.expectedReadBack, epc);
  assert.equal(j!.verifyReadBack, true);
  assert.equal(rfidWriteJob(7, 100, epc)!.jobKey, j!.jobKey);
  assert.notEqual(rfidWriteJob(8, 100, epc)!.jobKey, j!.jobKey, '跨租户 jobKey 不同');
  assert.equal(rfidWriteJob(7, 100, 'nope'), null);
});

test('epcDedupeVerdict：同一 EPC 重复写被识别，归一化后比较', () => {
  const a = '3074257BF7194E4000001A85';
  const v = epcDedupeVerdict(a, [a.toLowerCase()]);
  assert.equal(v.duplicate, true);
  assert.equal(v.key, a);
  assert.equal(epcDedupeVerdict(a, new Set([a])).duplicate, true);
  assert.equal(epcDedupeVerdict(a, []).duplicate, false);
});
