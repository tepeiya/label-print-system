// P8.3 企业治理判定层单测（纯函数，零 Nest / DB 依赖）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_POLICY, GOVERNANCE_ACTIONS, TEMPLATE_STATUSES, TRANSITIONS,
  dedupeVerdict, editVerdict, escapeXml, expandWatermarkText, normalizePolicy,
  printFingerprint, printVerdict, quotaVerdict, transitionVerdict,
  watermarkHtmlLayer, watermarkPlacements, watermarkSvgLayer,
} from '../governance.calc';

const ADMIN = ['admin'];
const OP = ['operator'];
const VIEWER = ['viewer'];

// ------------------------------ 状态机 ------------------------------
test('状态机表自洽：所有 to 都是合法状态、roles 非空、auditAction 唯一', () => {
  for (const a of GOVERNANCE_ACTIONS) {
    const t = TRANSITIONS[a];
    assert.ok(t.from.length > 0, `${a} 必须有来源状态`);
    assert.ok(t.from.every((s) => TEMPLATE_STATUSES.includes(s)), `${a} 来源状态合法`);
    assert.ok(TEMPLATE_STATUSES.includes(t.to), `${a} 目标状态合法`);
    assert.ok(t.roles.length > 0, `${a} 必须限定角色`);
    assert.ok(t.auditAction.startsWith('template.review.'), `${a} 审计 action 前缀`);
  }
  assert.equal(new Set(GOVERNANCE_ACTIONS.map((a) => TRANSITIONS[a].auditAction)).size, GOVERNANCE_ACTIONS.length);
});

test('合法主链路：draft → in_review → published → request_change → draft', () => {
  assert.equal(transitionVerdict('draft', 'submit', OP).to, 'in_review');
  assert.equal(transitionVerdict('in_review', 'approve', ADMIN).to, 'published');
  assert.equal(transitionVerdict('published', 'request_change', OP).to, 'draft');
  assert.equal(transitionVerdict('in_review', 'reject', ADMIN, '条码尺寸不合规').to, 'rejected');
  assert.equal(transitionVerdict('rejected', 'request_change', OP).to, 'draft');
});

test('非法迁移 / 未知动作 / 空状态按 draft 兜底', () => {
  assert.equal(transitionVerdict('published', 'approve', ADMIN).allowed, false);
  assert.equal(transitionVerdict('archived', 'submit', ADMIN).allowed, false);
  assert.equal(transitionVerdict('draft', 'approve', ADMIN).allowed, false);
  assert.equal(transitionVerdict('draft', 'delete_everything', ADMIN).allowed, false);
  assert.equal(transitionVerdict(null, 'submit', OP).allowed, true, '存量无治理记录视为 draft');
});

test('越权拦截：operator 不能审批，viewer 不能提交', () => {
  assert.match(transitionVerdict('in_review', 'approve', OP).reason, /无权限/);
  assert.match(transitionVerdict('draft', 'submit', VIEWER).reason, /无权限/);
  assert.equal(transitionVerdict('in_review', 'approve', ADMIN).allowed, true);
});

test('驳回与应急直发必须写理由（审计留痕）', () => {
  assert.match(transitionVerdict('in_review', 'reject', ADMIN, '  ').reason, /必须填写理由/);
  assert.equal(transitionVerdict('in_review', 'reject', ADMIN, '不合规').allowed, true);
  assert.match(transitionVerdict('draft', 'publish', ADMIN, '').reason, /必须填写理由/);
  assert.equal(transitionVerdict('draft', 'publish', ADMIN, '客户现场应急').allowed, true);
  assert.equal(transitionVerdict('draft', 'submit', OP).auditAction, 'template.review.submit');
});

test('发布锁定：strict 下 published/in_review/archived 禁止直接编辑', () => {
  assert.equal(editVerdict('published', true).allowed, false);
  assert.equal(editVerdict('in_review', true).allowed, false);
  assert.equal(editVerdict('draft', true).allowed, true);
  assert.equal(editVerdict('rejected', true).allowed, true);
  assert.equal(editVerdict('published', false).allowed, true, '默认宽松不破坏存量');
  assert.equal(editVerdict(null, true).allowed, true, '存量模板无治理记录放行');
  assert.match(editVerdict('published', true).reason, /request_change/);
});

test('打印准入：strict 下仅 published 可打印，未发布明确拒绝', () => {
  assert.equal(printVerdict('published', true).allowed, true);
  assert.equal(printVerdict('draft', true).allowed, false);
  assert.equal(printVerdict('rejected', true).allowed, false);
  assert.equal(printVerdict('draft', false).allowed, true);
  assert.equal(printVerdict(null, true).allowed, true);
  assert.match(printVerdict('draft', true).reason, /已发布/);
});

// ------------------------------ 防重打印 ------------------------------
test('printFingerprint：键顺序无关、行内键顺序无关、copies 不参与', () => {
  const a = printFingerprint(7, 12, [{ sku: 'A', qty: 2 }, { qty: 3, sku: 'B' }]);
  const b = printFingerprint(7, 12, [{ qty: 2, sku: 'A' }, { sku: 'B', qty: 3 }]);
  assert.equal(a, b);
  assert.equal(a.length, 32);
  assert.notEqual(a, printFingerprint(7, 12, [{ sku: 'A', qty: 9 }]), '内容不同指纹不同');
});

test('printFingerprint：跨租户隔离、scope=tenant 跨模板同指纹', () => {
  const rows = [{ sku: 'A' }];
  assert.notEqual(printFingerprint(7, 12, rows), printFingerprint(8, 12, rows), 'tenantId 必须参与指纹');
  assert.notEqual(printFingerprint(7, 12, rows, 'template'), printFingerprint(7, 13, rows, 'template'));
  assert.equal(printFingerprint(7, 12, rows, 'tenant'), printFingerprint(7, 13, rows, 'tenant'));
});

const POL = normalizePolicy({ dedupe: { enabled: true, windowSec: 3600, onDuplicate: 'block', scope: 'template' } });

test('dedupeVerdict：未开启 / 首次打印一律放行', () => {
  assert.equal(dedupeVerdict({ firstPrintedAt: 1, lastPrintedAt: 1, count: 3, jobId: 9 }, DEFAULT_POLICY.dedupe, 2).decision, 'allow');
  assert.equal(dedupeVerdict(null, POL.dedupe, 1000).decision, 'allow');
});

test('dedupeVerdict：窗口内按 onDuplicate 给 block / warn / allow', () => {
  const rec = { firstPrintedAt: 1000, lastPrintedAt: 5000, count: 2, jobId: 42 };
  assert.equal(dedupeVerdict(rec, POL.dedupe, 6000).decision, 'block');
  assert.equal(dedupeVerdict(rec, { ...POL.dedupe, onDuplicate: 'warn' }, 6000).decision, 'warn');
  assert.equal(dedupeVerdict(rec, { ...POL.dedupe, onDuplicate: 'allow' }, 6000).decision, 'allow');
  const v = dedupeVerdict(rec, POL.dedupe, 6000);
  assert.equal(v.previousJobId, 42);
  assert.equal(v.windowEndsAt, 5000 + 3600 * 1000);
  assert.match(v.reason, /#42/);
});

test('dedupeVerdict：超过窗口视为新批次（边界=窗口末端即过期）', () => {
  const rec = { firstPrintedAt: 1000, lastPrintedAt: 5000, count: 2, jobId: 42 };
  const ends = 5000 + 3600 * 1000;
  assert.equal(dedupeVerdict(rec, POL.dedupe, ends).decision, 'allow');
  assert.equal(dedupeVerdict(rec, POL.dedupe, ends - 1).decision, 'block');
});

// ------------------------------ 数量策略 ------------------------------
const QP = normalizePolicy({
  quota: { enabled: true, maxPerJob: 100, maxPerDay: 1000, maxPerTemplatePerDay: 300 },
}).quota;

test('quotaVerdict：未开启 / 配额内放行', () => {
  assert.equal(quotaVerdict(99999, DEFAULT_POLICY.quota, { day: 0 }).allowed, true);
  assert.equal(quotaVerdict(50, QP, { day: 10, templateDay: 5 }).allowed, true);
});

test('quotaVerdict：三种上限分别拦截并回报 remaining', () => {
  assert.equal(quotaVerdict(101, QP, { day: 0 }).limit, 'maxPerJob');
  assert.equal(quotaVerdict(50, QP, { day: 980, templateDay: 0 }).limit, 'maxPerDay');
  assert.equal(quotaVerdict(50, QP, { day: 0, templateDay: 280 }).limit, 'maxPerTemplatePerDay');
  const v = quotaVerdict(50, QP, { day: 980, templateDay: 0 });
  assert.equal(v.allowed, false);
  assert.equal(v.remaining, 20);
  assert.match(v.reason, /租户每日/);
});

test('quotaVerdict：max=0 表示不限；count 非法值夹到 1', () => {
  const p = { enabled: true, maxPerJob: 0, maxPerDay: 0, maxPerTemplatePerDay: 0 };
  assert.equal(quotaVerdict(1e9, p, {}).allowed, true);
  assert.equal(quotaVerdict(0, { ...p, maxPerJob: 1 }, {}).allowed, true);
});

// ------------------------------ 水印 ------------------------------
test('escapeXml：五类字符全部转义，防 SVG/HTML 注入', () => {
  assert.equal(escapeXml(`<script>&"'</script>`), '&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;');
});

test('expandWatermarkText：合法占位符展开、非法变量名不回显、未给值留空', () => {
  assert.equal(
    expandWatermarkText('{{printUser}} {{printDate}} {{jobId}}', { printUser: '张三', printDate: '2026-11-14', jobId: 8 }),
    '张三 2026-11-14 8',
  );
  assert.equal(expandWatermarkText('{{unknown}}{{printUser}}', { printUser: 'A' }), 'A');
  assert.equal(expandWatermarkText('{{printUser}}', {}), '');
  assert.equal(expandWatermarkText('x'.repeat(300), {}).length, 200);
});

const PAGE = { widthMm: 40, heightMm: 30 };
const WM = normalizePolicy({
  watermark: { enabled: true, text: '{{printUser}} {{printDate}}', mode: 'diagonal', opacity: 0.2, fontSizeMm: 4, color: '#ff0000', rotationDeg: -30 },
}).watermark;

test('watermarkPlacements：三种模式的位置与数量', () => {
  assert.equal(watermarkPlacements({ ...WM, mode: 'center' }, PAGE).length, 1);
  assert.equal(watermarkPlacements({ ...WM, mode: 'center' }, PAGE)[0].rotationDeg, 0);
  assert.equal(watermarkPlacements({ ...WM, mode: 'diagonal' }, PAGE)[0].xMm, 20);
  assert.equal(watermarkPlacements({ ...WM, mode: 'diagonal' }, PAGE)[0].yMm, 15);
  assert.equal(watermarkPlacements({ ...WM, mode: 'tiled' }, PAGE).length, 9);
  assert.equal(watermarkPlacements({ ...WM, enabled: false }, PAGE).length, 0);
  assert.equal(watermarkPlacements({ ...WM, text: '   ' }, PAGE).length, 0, '空文本不画水印');
});

test('watermarkPlacements：脏配置夹取（透明度/字号/颜色/页尺寸）', () => {
  const p = watermarkPlacements({ ...WM, opacity: -5, fontSizeMm: 999, color: 'red;url(javascript:...)' }, PAGE)[0];
  assert.equal(p.opacity, 0.02);
  assert.equal(p.fontSizeMm, 40);
  assert.equal(p.color, '#888888');
  const q = watermarkPlacements({ ...WM, mode: 'tiled' }, { widthMm: -1, heightMm: 0 })[0];
  assert.ok(q.xMm > 0 && q.yMm > 0);
});

test('watermarkSvgLayer / HtmlLayer：文本已转义、含占位展开、禁用返回空串', () => {
  const dirty = { ...WM, text: '<b>{{printUser}}</b>' };
  const svg = watermarkSvgLayer(dirty, PAGE, { printUser: 'A&B' });
  assert.match(svg, /data-layer="watermark"/);
  assert.match(svg, /&lt;b&gt;A&amp;B&lt;\/b&gt;/);
  assert.ok(!svg.includes('<b>'), '不能出现未转义标签');
  assert.match(watermarkHtmlLayer(dirty, PAGE, { printUser: 'A&B' }), /lf-watermark/);
  assert.equal(watermarkSvgLayer({ ...WM, enabled: false }, PAGE), '');
  assert.equal(watermarkHtmlLayer({ ...WM, enabled: false }, PAGE), '');
});

// ------------------------------ 策略归一化 ------------------------------
test('normalizePolicy：空输入得到默认全宽松策略', () => {
  const p = normalizePolicy(null);
  assert.equal(p.strictPublish, false);
  assert.equal(p.dedupe.enabled, false);
  assert.equal(p.quota.enabled, false);
  assert.equal(p.watermark.enabled, false);
  assert.deepEqual(p, DEFAULT_POLICY);
});

test('normalizePolicy：合法配置保留，越界/错误类型收敛', () => {
  const p = normalizePolicy({
    strictPublish: 'yes',      // 非 true → false（fail-closed 到宽松，不误开严格模式）
    dedupe: { enabled: true, windowSec: -1, onDuplicate: 'DROP', scope: 'tenant' },
    quota: { enabled: true, maxPerJob: 99999999, maxPerDay: 'abc', maxPerTemplatePerDay: 50 },
    watermark: { enabled: true, mode: 'random', color: 'javascript:alert(1)' },
  });
  assert.equal(p.strictPublish, false);
  assert.equal(p.dedupe.windowSec, 1);
  assert.equal(p.dedupe.onDuplicate, 'warn');
  assert.equal(p.dedupe.scope, 'tenant');
  assert.equal(p.quota.maxPerJob, 1_000_000);
  assert.equal(p.quota.maxPerDay, 0);
  assert.equal(p.quota.maxPerTemplatePerDay, 50);
  assert.equal(p.watermark.mode, 'diagonal');
  assert.equal(p.watermark.color, '#888888');
  assert.equal(normalizePolicy({ strictPublish: true }).strictPublish, true);
});
