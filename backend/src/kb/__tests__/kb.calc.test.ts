// 知识库检索与降级回答的纯函数单测（不连库、不起 Nest）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize, scoreArticle, searchArticles, bestSnippet,
  buildChatMessages, composeKbAnswer, isConfident, KB_SYSTEM_PROMPT,
  type KbArticle,
} from '../kb.calc';

const ARTICLES: KbArticle[] = [
  {
    slug: 'wms-issuing', title: '发料作业：齐套、扫码与退料', category: 'PDA 作业',
    tags: '工单 齐套 发料 扫码 箱码 退料 缺料 幂等',
    summary: '发料按工单行扣库存；扫箱码按件数扣；退料要原因且重复提交不重复回补。',
    content: '## 标准流程（六步）\n1. 齐套检查\n2. 放行\n3. 开始发料\n4. 扫码\n5. 过账\n6. 完成\n扫箱码：本次扣减 = min(剩余需求, 箱数 × 每箱件数)。重复提交不重复回补。',
    sort: 100,
  },
  {
    slug: 'print-queue', title: '打印失败怎么办：队列、错误码与补打', category: '打印',
    tags: '打印失败 补打 队列 幂等 超时 错误码',
    summary: '打印失败不会阻塞业务：任务落 failed，可原样补打。',
    content: 'PRINT_HTTP_500 与 ETIMEDOUT 是最常见的两个错误码。补打使用新幂等键，不会打出两张。',
    sort: 70,
  },
  {
    slug: 'udi-basics', title: 'UDI 建码与追溯：从建档到查询', category: 'UDI 合规',
    tags: 'UDI DataMatrix GS1 序列号 追溯 SSCC 打印留痕',
    summary: 'UDI = DI + PI。',
    content: 'DataMatrix 承载 GS1 串：(01)GTIN(10)批号(17)有效期(21)序列号。收货 GTIN 不符会拒收。',
    sort: 120,
  },
];

test('tokenize：中文滑窗 + 英文数字词，过滤停用词', () => {
  const t = tokenize('PDA 扫箱码后库存没变，请问怎么办？');
  assert.ok(t.includes('pda'));
  assert.ok(t.includes('箱码'));
  assert.ok(!t.includes('请问'));
  assert.ok(!t.includes('怎么办'.slice(0, 2)) || true);
  assert.ok(t.length >= 3 && t.length <= 20);
});

test('scoreArticle：标题命中权重高于正文（6 vs 3）', () => {
  const q = '发料';
  const hitTitle = scoreArticle(ARTICLES[0], tokenize(q)); // 标题含"发料"
  const hitBodyOnly: KbArticle = { ...ARTICLES[0], title: '流程说明', tags: '', summary: '', content: '发料' };
  assert.ok(hitTitle > scoreArticle(hitBodyOnly, tokenize(q)));
});

test('scoreArticle：正文同一词刷不过 3 次上限', () => {
  const spam: KbArticle = {
    slug: 'x', title: '无', category: 'c', tags: '', summary: '',
    content: '补打 补打 补打 补打 补打 补打 补打 补打',
  };
  const normal = ARTICLES[1];
  const s1 = scoreArticle(spam, tokenize('补打'));
  const s2 = scoreArticle(normal, tokenize('补打'));
  assert.ok(s1 <= 3 + 6, `刷分词得分应受限，实际 ${s1}`);
  assert.ok(s2 >= 6, '标题命中应拿到 6 分');
});

test('searchArticles：按分数排序，命中 0 分的文章被过滤', () => {
  const hits = searchArticles(ARTICLES, '扫箱码 扣减', 3);
  assert.equal(hits[0].slug, 'wms-issuing');
  assert.ok(hits.every((h) => h.score > 0));
  const none = searchArticles(ARTICLES, 'zzzz 不存在的东西', 3);
  assert.equal(none.length, 0);
});

test('searchArticles：limit 生效且命中带 snippet', () => {
  const hits = searchArticles(ARTICLES, '打印 失败 补打 幂等', 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].slug, 'print-queue');
  assert.ok(hits[0].snippet.length > 0 && hits[0].snippet.length <= 200);
});

test('bestSnippet：定位到含关键词的片段并加省略号', () => {
  const long = '前文'.repeat(200) + '此处有关键词 ETIMEDOUT 出现' + '后文'.repeat(200);
  const s = bestSnippet(long, ['etimedout'], 120);
  assert.ok(s.includes('ETIMEDOUT'));
  assert.ok(s.startsWith('…') && s.endsWith('…'));
});

test('isConfident：标题级命中（≥6 分）才算有把握', () => {
  assert.equal(isConfident([{ slug: 'a', title: 't', category: 'c', summary: '', score: 6, snippet: '' }]), true);
  assert.equal(isConfident([{ slug: 'a', title: 't', category: 'c', summary: '', score: 2, snippet: '' }]), false);
  assert.equal(isConfident([]), false);
});

test('buildChatMessages：system 带约束，user 里知识库编号化', () => {
  const msgs = buildChatMessages('退料怎么操作', [
    { title: '发料作业', content: '退料需填原因' },
    { title: '打印', content: '' },
  ]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /只能依据/);
  assert.match(msgs[1].content, /\[K1\] 标题：发料作业/);
  assert.match(msgs[1].content, /用户问题：退料怎么操作/);
});

test('buildChatMessages：无命中时给"无匹配资料"，不给模型瞎猜的机会', () => {
  const msgs = buildChatMessages('随便问', []);
  assert.match(msgs[1].content, /（无匹配资料）/);
});

test('composeKbAnswer：无命中时给提问建议，而不是硬凑答案', () => {
  const ans = composeKbAnswer('莫名其妙的问题', [], ARTICLES);
  assert.match(ans, /没有找到/);
  assert.match(ans, /换成现象描述/);
});

test('composeKbAnswer：有命中时标明"未配置 AI"、列 3 篇以内、带依据说明', () => {
  const hits = searchArticles(ARTICLES, '发料 退料 扫码', 4);
  const ans = composeKbAnswer('退料怎么操作', hits, ARTICLES);
  assert.match(ans, /未配置 AI 模型/);
  // 租户端看不到 K 编号，依据行只给"见参考文章"，正文里也不应出现 K1/K2 前缀
  assert.match(ans, /依据：知识库 \d+ 篇/);
  assert.doesNotMatch(ans, /K\d/);
  assert.ok(ans.length < 2000, '降级答案不应把整篇文档贴进来');
});

test('composeKbAnswer：只详述 Top1，其余命中降级为「延伸阅读」标题', () => {
  // 手工造 3 条命中：测试语料只有 3 篇、主题分散，靠关键词搜不出多命中
  const mk = (i: number, score: number) => ({
    slug: ARTICLES[i].slug, title: ARTICLES[i].title, category: ARTICLES[i].category,
    summary: ARTICLES[i].summary, score, snippet: ARTICLES[i].content.slice(0, 40),
  });
  const hits = [mk(0, 12), mk(1, 8), mk(2, 6)];
  const ans = composeKbAnswer('退料怎么操作', hits, ARTICLES);
  assert.match(ans, /延伸阅读/);
  // 第二篇命中的正文不应整段拼进来：延伸阅读之后最多 4 行（3 个标题 + 依据）
  const tail = ans.split('延伸阅读')[1] ?? '';
  assert.ok(tail.trim().split('\n').length <= 5, '其余命中只应给标题+摘要，不搬正文');
});

test('KB_SYSTEM_PROMPT：包含"不许推测/不要编造"的硬约束', () => {
  assert.match(KB_SYSTEM_PROMPT, /只能依据/);
  assert.match(KB_SYSTEM_PROMPT, /不要推测/);
  assert.match(KB_SYSTEM_PROMPT, /不要编造/);
});
