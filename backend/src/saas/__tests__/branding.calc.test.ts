// 白标（D6）纯函数单测：normalizeHost / 域名登记校验 / TXT 令牌比对 / 品牌清洗 / Host 解析
// ⚠️ 只 import branding.calc（纯函数），不碰 TypeORM 实体 —— 见 docs/10 §10.15.6 的 ⚠️ 条
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRANDING_KEYS, MAX_BRANDING_BYTES, cssVarsToObject, hostFromHeaders, isRegistrableDomain,
  matchVerifyToken, normalizeHost, resolveTenantByHost, sanitizeBranding, verifyRecordName,
} from '../branding/branding.calc';

test('normalizeHost: 去端口 / 转小写 / 去尾部点（FQDN 与裸域名必须等价）', () => {
  assert.equal(normalizeHost('Login.Customer.COM:3200'), 'login.customer.com');
  assert.equal(normalizeHost('  customer.com.  '), 'customer.com');
  assert.equal(normalizeHost('A.B.c'), 'a.b.c');
});

test('normalizeHost: 非法输入一律收敛成空串（不能靠它兜底放行）', () => {
  assert.equal(normalizeHost(undefined), '');
  assert.equal(normalizeHost(''), '');
  assert.equal(normalizeHost('[::1]:3200'), '');            // IPv6 字面量不是租户域名
  assert.equal(normalizeHost('bad host name'), '');          // 空格
  assert.equal(normalizeHost('x'.repeat(250) + '.com'), ''); // 超长
  assert.equal(normalizeHost('-leading.com'), '');
});

test('isRegistrableDomain: localhost / IP / 单标签主机名不许登记', () => {
  assert.equal(isRegistrableDomain('localhost').ok, false);
  assert.equal(isRegistrableDomain('app.localhost').ok, false);
  assert.equal(isRegistrableDomain('192.168.1.10').ok, false);
  assert.equal(isRegistrableDomain('intranet').ok, false);
  assert.equal(isRegistrableDomain('label.customer.com').ok, true);
  assert.equal(isRegistrableDomain('').ok, false);
});

test('hostFromHeaders: 默认只认 Host，显式信任才看 X-Forwarded-Host', () => {
  const h = { host: 'internal.local:3200', 'x-forwarded-host': 'login.customer.com' };
  assert.equal(hostFromHeaders(h, false), 'internal.local');
  assert.equal(hostFromHeaders(h, true), 'login.customer.com');
  // 多级代理链取第一跳；数组形态（某些客户端重复带头）也不能崩
  assert.equal(hostFromHeaders({ 'x-forwarded-host': 'a.customer.com, b.internal' }, true), 'a.customer.com');
  assert.equal(hostFromHeaders({ 'x-forwarded-host': ['c.customer.com', 'x'] }, true), 'c.customer.com');
  assert.equal(hostFromHeaders(null, true), '');
});

test('verifyRecordName: TXT 记录名固定前缀，写进接入文档的就是它', () => {
  assert.equal(verifyRecordName('login.customer.com'), '_labelflow-verify.login.customer.com');
});

test('matchVerifyToken: 标准写法、裸令牌、以及 TXT 被拆成多段都要认', () => {
  const t = 'AB12CD34';
  assert.equal(matchVerifyToken([['labelflow-verify=AB12CD34']], 'login.customer.com', t), true);
  assert.equal(matchVerifyToken([['AB12CD34']], 'login.customer.com', t), true);
  // RFC 1035 允许一条 TXT 里多个 char-string，DNS 库常见拆成 ['labelflow-verify=', 'AB12CD34']
  assert.equal(matchVerifyToken([['labelflow-verify=', 'AB12CD34']], 'login.customer.com', t), true);
  assert.equal(matchVerifyToken([['_labelflow-verify.login.customer.com=AB12CD34']], 'login.customer.com', t), true);
  assert.equal(matchVerifyToken([['labelflow-verify=OTHER']], 'login.customer.com', t), false);
  assert.equal(matchVerifyToken([], 'login.customer.com', t), false);
});

test('sanitizeBranding: 只收白名单键，多余的键回报 dropped（不静默吞）', () => {
  const r = sanitizeBranding({ appName: '客户标签台', evil: 'x', css: 'body{}' } as any);
  assert.equal(r.branding.appName, '客户标签台');
  assert.ok(r.dropped.includes('evil'), JSON.stringify(r.dropped));
  assert.deepEqual(r.errors, []);
  for (const k of Object.keys(r.branding)) {
    assert.ok((BRANDING_KEYS as readonly string[]).includes(k), `不该落库的键：${k}`);
  }
});

test('sanitizeBranding: 颜色与 URL 严格校验，data:/javascript: 一律拒', () => {
  assert.deepEqual(sanitizeBranding({ primaryColor: 'red' }).errors, ['primaryColor 必须是 #RGB 或 #RRGGBB']);
  assert.equal(sanitizeBranding({ primaryColor: '#0A66C2' }).branding.primaryColor, '#0a66c2');
  assert.ok(sanitizeBranding({ logoUrl: 'data:image/png;base64,AAAA' }).errors.length > 0);
  assert.ok(sanitizeBranding({ logoUrl: 'http://cdn.customer.com/l.png' }).errors.length > 0, '必须 https');
  assert.equal(sanitizeBranding({ logoUrl: 'https://cdn.customer.com/l.png' }).branding.logoUrl,
    'https://cdn.customer.com/l.png');
});

test('sanitizeBranding: 自由 CSS 是红线 —— 只准 --变量，值里不许 url(/引号/大括号', () => {
  assert.equal(sanitizeBranding({ customCssVars: '--brand-soft: #f4f6fb' }).branding.customCssVars,
    '--brand-soft: #f4f6fb');
  assert.ok(sanitizeBranding({ customCssVars: 'body{position:fixed;top:0}' }).errors.length > 0);
  assert.ok(sanitizeBranding({ customCssVars: '--x: url(http://evil.com/a)' }).errors.length > 0);
  assert.ok(sanitizeBranding({ customCssVars: '--Bad: v' }).errors.length > 0, '变量名必须小写 --');
});

test('sanitizeBranding: appName/loginNotice 去控制符与尖括号（前端仍按文本渲染，双保险）', () => {
  const r = sanitizeBranding({ appName: '<script>alert(1)</script>标签台' });
  assert.ok(!r.branding.appName.includes('<'), r.branding.appName);
  assert.ok(r.branding.appName.endsWith('标签台'));
});

test('sanitizeBranding: 每键限长 200，总量受控（MAX_BRANDING_BYTES 只是兜底护栏）', () => {
  const huge = 'x'.repeat(MAX_BRANDING_BYTES + 10);
  const r = sanitizeBranding({ appName: huge, loginNotice: huge });
  assert.equal(r.branding.appName.length, 200);
  assert.equal(r.branding.loginNotice.length, 200);
  assert.deepEqual(r.errors, []);
  assert.ok(Buffer.byteLength(JSON.stringify(r.branding), 'utf-8') < MAX_BRANDING_BYTES);
});

test('cssVarsToObject: 只摊合法变量，脏输入静默忽略（渲染侧不能再抛错）', () => {
  assert.deepEqual(cssVarsToObject('--a: #fff; --b-c: blue'), { '--a': '#fff', '--b-c': 'blue' });
  assert.deepEqual(cssVarsToObject('color:red; --ok: 1; bad'), { '--ok': '1' });
  assert.deepEqual(cssVarsToObject(null), {});
  assert.deepEqual(cssVarsToObject(''), {});
});

test('resolveTenantByHost: 只认已校验域名，未校验的一律忽略（抢注防护的唯一屏障）', () => {
  const rows = [
    { tenantId: 7, domain: 'login.customer.com', verified: true },
    { tenantId: 8, domain: 'steal.customer.com', verified: false },
  ];
  assert.equal(resolveTenantByHost(rows, 'login.customer.com'), 7);
  assert.equal(resolveTenantByHost(rows, 'Login.Customer.COM:443'), 7);   // 大小写/端口不敏感
  assert.equal(resolveTenantByHost(rows, 'steal.customer.com'), null, '未校验域名不许解析出租户');
  assert.equal(resolveTenantByHost(rows, 'unknown.customer.com'), null);
  assert.equal(resolveTenantByHost(rows, ''), null);
  assert.equal(resolveTenantByHost([], 'login.customer.com'), null);
});
