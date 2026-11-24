import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidVersion, isSafeArchiveName, parseReleaseManifest,
  planAgentPrinters, renderSetupScript, sanitizeBaseUrl,
} from '../agent-release.calc';

const good = {
  version: '1.0',
  fileName: 'labelflow-print-agent-win64-1.0.zip',
  sizeBytes: 30_000_000,
  sha256: 'a'.repeat(64),
  builtAt: '2026-11-24T03:57:00Z',
};

test('正常清单 → available，大小以磁盘为准', () => {
  const r = parseReleaseManifest(JSON.stringify(good), 29_999_999);
  assert.equal(r.available, true);
  assert.equal(r.version, '1.0');
  assert.equal(r.sizeBytes, 29_999_999);
  assert.equal(r.sha256, 'a'.repeat(64));
});

test('清单缺失 / zip 丢失 → available:false 且带原因', () => {
  assert.equal(parseReleaseManifest(null, 100).available, false);
  assert.match(parseReleaseManifest(null, 100).reason!, /未就位/);
  const missingZip = parseReleaseManifest(JSON.stringify(good), null);
  assert.equal(missingZip.available, false);
  assert.match(missingZip.reason!, /不存在/);
});

test('清单损坏 → 降级而不是抛错', () => {
  assert.equal(parseReleaseManifest('{not json', 100).available, false);
  assert.equal(parseReleaseManifest('[]', 100).available, false);
});

test('文件名穿越或非 zip 一律拒绝', () => {
  for (const bad of ['../../etc/passwd.zip', 'a/b.zip', 'x.exe', '..zip', '']) {
    assert.equal(isSafeArchiveName(bad), false, bad);
    const r = parseReleaseManifest(JSON.stringify({ ...good, fileName: bad }), 100);
    assert.equal(r.available, false, bad);
  }
});

test('sha256 必须是 64 位小写 hex；版本号必须是数字点段', () => {
  assert.equal(parseReleaseManifest(JSON.stringify({ ...good, sha256: 'xyz' }), 100).available, false);
  assert.equal(parseReleaseManifest(JSON.stringify({ ...good, sha256: 'A'.repeat(64) }), 100).available, false);
  assert.equal(parseReleaseManifest(JSON.stringify({ ...good, version: 'v1' }), 100).available, false);
  assert.equal(isValidVersion('1.2.3'), true);
  assert.equal(isValidVersion('1.0-beta'), true);
  assert.equal(isValidVersion('latest'), false);
});

test('安装脚本的服务器地址只允许 http(s)://主机[:端口]，其余回退', () => {
  const fb = 'https://fallback.example.com';
  assert.equal(sanitizeBaseUrl('https://labelflow.example.com', fb), 'https://labelflow.example.com');
  assert.equal(sanitizeBaseUrl('http://127.0.0.1:3200/', fb), 'http://127.0.0.1:3200');
  for (const bad of [
    "https://evil.com'; Write-Host pwned; '", 'https://a.com\nWrite-Host x', 'ftp://a.com',
    'javascript:alert(1)', '//a.com', 'https://a.com/../x', '', null, undefined,
  ]) {
    assert.equal(sanitizeBaseUrl(bad as any, fb), fb, String(bad));
  }
});

test('渲染引导脚本：占位符全部替换且不引入引号/换行', () => {
  const tpl = "param([string]$Tenant='')\n$Base = '__BASE_URL__'\n";
  const out = renderSetupScript(tpl, "https://a.com'; rm -rf /; '", 'https://safe.example.com');
  assert.equal(out.includes('__BASE_URL__'), false);
  assert.ok(out.includes("$Base = 'https://safe.example.com'"));
  assert.equal(out.includes('rm -rf'), false);
});

test('注册后补建打印机：按 driverName 去重，第一台给默认', () => {
  const plan = planAgentPrinters([], ['ZDesigner ZD421', 'TSC TE244']);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].isDefault, true);
  assert.equal(plan[1].isDefault, false);
  assert.deepEqual(plan[0].connection, { driverName: 'ZDesigner ZD421' });
  assert.match(plan[0].name, /本地代理/);

  // 已存在同一 driverName（大小写不同）→ 不重复建，且不再抢默认
  const again = planAgentPrinters([{ connection: { driverName: 'zdesigner zd421' } }, { connection: { driverName: 'other' } }], ['ZDesigner ZD421']);
  assert.deepEqual(again, []);
});

test('补建打印机跳过空 driverName，名称截断到 120', () => {
  const plan = planAgentPrinters([], ['', '   ', 'X'.repeat(200)]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].name.length, 120);
});
