// prompt.calc 单测（P6.5 Prompt 库的纯函数部分）
// 只 import 纯函数：单测跑 tsx + node:test，不加载 TypeORM（docs/10 §10.15.6）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CONTENT, PROMPT_NAME_RE, enabledPrompts, extractPlaceholders, mergePromptList,
  normalizeArguments, renderPromptContent, resolveArgs, validatePromptInput,
} from '../prompt.calc';
import { SYSTEM_PROMPTS, SYSTEM_PROMPT_NAMES } from '../prompt.defaults';

test('系统默认提示词：3 条开箱即用场景，名字合法且正文可用', () => {
  assert.equal(SYSTEM_PROMPTS.length, 3);
  assert.deepEqual(SYSTEM_PROMPT_NAMES, [
    'inventory.health_check', 'bom.daily_kit_report', 'print.label_from_description',
  ]);
  for (const p of SYSTEM_PROMPTS) {
    assert.match(p.name, PROMPT_NAME_RE);
    assert.ok(p.content.length >= 200, `${p.name} 正文应足够具体`);
    // 正文里的占位符必须都在参数里声明
    const declared = new Set(p.arguments.map((a) => a.name));
    for (const used of extractPlaceholders(p.content)) assert.ok(declared.has(used), `${p.name} 缺少参数 ${used}`);
  }
});

test('validatePromptInput: 名字/标题/正文格式', () => {
  const base = { title: '库存巡检', content: '请检查 {{warehouse}} 的库存健康度', arguments: [{ name: 'warehouse' }] };
  assert.equal(validatePromptInput('inventory.health_check', base).ok, true);
  for (const bad of ['', 'A.b', '1abc', 'ab', 'x'.repeat(65), '中文.名字', 'a b c']) {
    assert.equal(validatePromptInput(bad, base).ok, false, `应拒绝名字 ${bad}`);
  }
  assert.equal(validatePromptInput('abc', { ...base, title: '' }).ok, false);
  assert.equal(validatePromptInput('abc', { ...base, content: '短' }).ok, false);
  assert.equal(validatePromptInput('abc', { ...base, content: 'x'.repeat(MAX_CONTENT + 1) }).ok, false);
});

test('validatePromptInput: 正文占位符必须在 arguments 里声明（拼错直接 400）', () => {
  const r = validatePromptInput('inventory.health_check', {
    title: '库存巡检',
    content: '检查 {{warehouse}} 里 {{dayz}} 天内到期的物料',
    arguments: [{ name: 'warehouse' }],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('；'), /dayz/);

  // 声明未使用只提示、不拦
  const r2 = validatePromptInput('abc.def', {
    title: '测试', content: '这一段只用到 {{a}} 参数', arguments: [{ name: 'a' }, { name: 'b' }],
  });
  assert.equal(r2.ok, true);
  assert.deepEqual((r2.value as any).unusedArgs, ['b']);
});

test('normalizeArguments: 坏名字/重复名报错，未知字段丢弃，默认参数上限', () => {
  const { args, errors } = normalizeArguments([
    { name: 'ok', title: '标题', extra: 'dropme' },
    { name: '1bad' },
    { name: 'ok' },
  ]);
  assert.equal(args.length, 1);
  assert.equal(args[0].name, 'ok');
  assert.equal((args[0] as any).extra, undefined);
  assert.equal(errors.length, 2);
  assert.equal(normalizeArguments('not-array').args.length, 0);
  const many = Array.from({ length: 13 }, (_, i) => ({ name: `a${i}` }));
  assert.ok(normalizeArguments(many).errors.some((e) => /最多 12/.test(e)));
});

test('extractPlaceholders: 去重并保持出现顺序，容忍空格', () => {
  assert.deepEqual(extractPlaceholders('{{a}} {{ b }} {{a}} {{c_1}}'), ['a', 'b', 'c_1']);
  assert.deepEqual(extractPlaceholders('没有占位符'), []);
  assert.deepEqual(extractPlaceholders('{{1bad}}'), []);
});

test('resolveArgs / renderPromptContent: 默认值、必填、未传即空串', () => {
  const defs = [
    { name: 'warehouse', default: '全部可见仓库' },
    { name: 'days', default: '30' },
    { name: 'description', required: true },
  ];
  const ok = resolveArgs(defs, { description: '320g 苹果' });
  assert.deepEqual(ok.values, { warehouse: '全部可见仓库', days: '30', description: '320g 苹果' });
  assert.deepEqual(ok.missing, []);

  const bad = resolveArgs(defs, {});
  assert.deepEqual(bad.missing, ['description']);

  const r = renderPromptContent('仓库「{{warehouse}}」，{{days}} 天内，{{ description }}。', defs, { description: '苹果' });
  assert.equal(r.ok, true);
  assert.equal(r.text, '仓库「全部可见仓库」，30 天内，苹果。');

  const fail = renderPromptContent('{{description}}', defs, {});
  assert.equal(fail.ok, false);
  assert.match(fail.reason!, /description/);
});

test('mergePromptList: 同名覆盖保留系统位置，自定义追加，enabled 透传', () => {
  const system = [
    { name: 'a.one', title: 'A', description: '', content: 'sys a', arguments: [], sortOrder: 10 },
    { name: 'b.two', title: 'B', description: '', content: 'sys b', arguments: [], sortOrder: 20 },
  ];
  const tenant = [
    { name: 'b.two', title: 'B2', description: '改', content: 'custom b', arguments: [{ name: 'x' }], enabled: false },
    { name: 'c.mine', title: 'C', description: '', content: 'my c', arguments: [], sortOrder: 5 },
  ];
  const merged = mergePromptList(system, tenant);
  assert.deepEqual(merged.map((m) => m.name), ['a.one', 'b.two', 'c.mine']);
  const b = merged[1];
  assert.equal(b.source, 'custom');
  assert.equal(b.overridden, true);
  assert.equal(b.content, 'custom b');
  assert.equal(b.enabled, false);
  assert.equal(b.sortOrder, 20);            // 覆盖不抢系统排序位
  const c = merged[2];
  assert.equal(c.source, 'custom');
  assert.equal(c.overridden, false);
  assert.equal(c.sortOrder, 5);

  // Agent 侧只给启用项
  assert.deepEqual(enabledPrompts(merged).map((m) => m.name), ['a.one', 'c.mine']);
});

test('mergePromptList: 纯系统列表各项 source=system、默认启用', () => {
  const merged = mergePromptList(SYSTEM_PROMPTS, []);
  assert.equal(merged.length, 3);
  assert.ok(merged.every((m) => m.source === 'system' && m.overridden === false && m.enabled));
  assert.deepEqual(merged.map((m) => m.sortOrder), [10, 20, 30]);
});
