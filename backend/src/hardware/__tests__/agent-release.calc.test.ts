import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidVersion, isSafeArchiveName, parseReleaseManifest } from '../agent-release.calc';

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
