// =============================================================================
// caps-sync.test.ts —— 能力矩阵「单一真源」防漂移守卫（P7.5 / P7.7 / P7.4 收尾）
//
// 为什么单独一套：这次 P7 的硬伤全都长在同一处——同一个结论被写了三四遍
// （后端矩阵、前端展示副本、生成器实现、文档），改一处忘一处就出问题：
//   · ^B2/^BI 用反、PDF417 当 ^B2、MicroQR 谎称原生（P7.2 被推翻重做的直接原因）；
//   · EPL 一列先是被保守地标成一堆 bitmap，按手册 Table 2-1 复核后 native 有 11 种；
//   · GS1 二维在位图通道里只开 parsefnc，实测打出的是带字面括号的普通符号（错码）。
// 这三类都不是「算法写错」，是「口径没对齐」，所以这里只锁对齐关系，不重复测功能。
//
// 纯测试约束（仓库硬规则）：只 import core/** 的纯模块与前端那份**无依赖**的
// TS 副本；不碰 Nest/TypeORM，也不碰 barcode-renderer.ts（它会拉起 bwip/sharp）。
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAP_MATRIX, CAP_MATRIX_VERSION, planChannel, statusFor, type PrintProtocol,
} from '../barcode-caps';
import { EPL_BARCODE_TYPES, EPL_SYM_STATUS } from '../epl-generator';
import { aiLength, BWIP_GS1_2D_BCIDS, gs1BwipText, gs1ToBwipFnc1, parseGs1 } from '../gs1';
// 前端展示副本：apps/console 与 backend 是两个独立 TS 工程，这份内容必须等价。
// 它不 import 任何 Vue/Element 依赖，所以可以直接在 node 里加载做结构比对。
import {
  CAP_MATRIX as FE_CAPS, CAP_MATRIX_VERSION as FE_VERSION,
} from '../../../apps/console/src/views/designer/barcode-caps';

const SYMS = Object.keys(CAP_MATRIX);
const PROTOCOLS: PrintProtocol[] = ['zpl', 'tspl', 'epl'];

// ── 1. 前后端矩阵逐字段等价 ────────────────────────────────────────────────

test('矩阵同步-前后端 CAP_MATRIX_VERSION 字面量必须一致', () => {
  assert.equal(FE_VERSION, CAP_MATRIX_VERSION,
    `前端 ${FE_VERSION} ≠ 后端 ${CAP_MATRIX_VERSION}：改矩阵必须两边同步`);
});

test('矩阵同步-前后端码制清单（键与顺序）完全一致', () => {
  assert.deepEqual(Object.keys(FE_CAPS), SYMS,
    '前后端 CAP_MATRIX 的码制集合或顺序不一致，前端 tooltip 会与后端 warnings 错位');
});

test('矩阵同步-每个码制的 zpl/tspl/epl/twoD/note 逐字段一致', () => {
  for (const sym of SYMS) {
    const be = CAP_MATRIX[sym] as Record<string, unknown>;
    const fe = FE_CAPS[sym] as unknown as Record<string, unknown>;
    for (const k of ['zpl', 'tspl', 'epl', 'twoD', 'note']) {
      assert.deepEqual(fe[k], be[k], `${sym}.${k} 前后端不一致：后端=${JSON.stringify(be[k])} 前端=${JSON.stringify(fe[k])}`);
    }
    assert.deepEqual(Object.keys(fe).sort(), Object.keys(be).sort(), `${sym} 的字段集合前后端不同`);
  }
});

test('矩阵同步-矩阵版本号必须是 p7- 前缀且带日期（防止漏 bump 就发布）', () => {
  assert.match(CAP_MATRIX_VERSION, /^p7-\d{4}-\d{2}-\d{2}\.\d+$/,
    `CAP_MATRIX_VERSION=${CAP_MATRIX_VERSION} 不符合 p7-YYYY-MM-DD.N 约定`);
});

// ── 2. 矩阵 epl 列 ↔ EPL 生成器实现 ────────────────────────────────────────

test('EPL 守卫-EPL_SYM_STATUS 与 CAP_MATRIX 的码制集合完全一致', () => {
  assert.deepEqual(Object.keys(EPL_SYM_STATUS).sort(), [...SYMS].sort(),
    'EPL 审计表与能力矩阵的码制清单不同：任何一边加/删码制都要同步另一边');
});

test('EPL 守卫-epl 列必须由 EPL_SYM_STATUS 推导（含 ITF14 的 degraded 例外）', () => {
  // 映射口径写死在这里：native→native、bitmap→bitmap、previewOnly/no-evidence→previewOnly；
  // ITF14 是唯一的手工例外——EPL 用交叉二五码 '2' 承载 GTIN-14，编码链一致但没有
  // ITF-14 边框/承载标记，所以矩阵必须是 degraded（会伴随 warning），不能算 native。
  const expect = (sym: string): string => {
    const st = EPL_SYM_STATUS[sym] as { status: string };
    if (sym === 'ITF14') return 'degraded';
    if (st.status === 'native') return 'native';
    if (st.status === 'bitmap') return 'bitmap';
    return 'previewOnly';
  };
  for (const sym of SYMS) {
    assert.equal(CAP_MATRIX[sym].epl, expect(sym),
      `${sym} 的 epl 列与 EPL 生成器审计表不一致（生成器结论=${EPL_SYM_STATUS[sym].status}，矩阵=${CAP_MATRIX[sym].epl}）`);
  }
});

test('EPL 守卫-EPL_BARCODE_TYPES 只能包含矩阵判定为 native/degraded 的码制', () => {
  for (const sym of Object.keys(EPL_BARCODE_TYPES)) {
    const st = CAP_MATRIX[sym]?.epl;
    assert.ok(st === 'native' || st === 'degraded',
      `${sym} 有 EPL 类型码但矩阵 epl 列是 ${st}：类型码表与结论表漂移了`);
  }
  // 反向：标了 native 的一维码制必须真的有类型码，否则生成时会静默跳过
  for (const sym of SYMS) {
    if (CAP_MATRIX[sym].twoD) continue;
    if (CAP_MATRIX[sym].epl !== 'native') continue;
    assert.ok((EPL_BARCODE_TYPES as Record<string, unknown>)[sym],
      `${sym} 的 epl=native 但 EPL_BARCODE_TYPES 里没有类型码 —— 生成器打不出东西还谎称原生`);
  }
});

// ── 3. 通道派单（planChannel）的口径 ────────────────────────────────────────

test('planChannel-原生指令码制在原生协议下就是 native', () => {
  assert.deepEqual(planChannel('CODE128', 'zpl', 'ABC123'), { channel: 'native' });
  assert.equal(planChannel('EAN13', 'epl', '123456789012').channel, 'native');
});

test('planChannel-degraded 仍走原生但必须带差异说明（不允许被当成 native 静默放行）', () => {
  const p = planChannel('ITF14', 'epl', '1234567890123');
  assert.equal(p.channel, 'native');
  assert.ok(p.why && p.why.includes('ITF-14'), `ITF14@EPL 的降级说明缺失：${p.why}`);
});

test('planChannel-二维 + GS1 (AI) 一律改派位图（协议侧 FNC1 转义写法没有可引用出处）', () => {
  for (const proto of ['zpl', 'tspl', 'epl'] as PrintProtocol[]) {
    const p = planChannel('DATAMATRIX', proto, '(01)04251234567890(10)AB789');
    assert.equal(p.channel, 'bitmap', `DATAMATRIX@${proto} 装 GS1 AI 时不许走原生指令`);
  }
  // 同一码制不带 AI 时仍按矩阵判定（ZPL 是原生 ^BX）
  assert.equal(planChannel('DATAMATRIX', 'zpl', 'PLAIN-TEXT').channel, 'native');
});

test('planChannel-一维码制永不走位图（bwip 一维缩放与打印点不成整数倍，栅格化会破坏条空比例）', () => {
  for (const sym of SYMS) {
    if (CAP_MATRIX[sym].twoD) continue;
    for (const proto of PROTOCOLS) {
      assert.notEqual(planChannel(sym, proto, '0123456789').channel, 'bitmap',
        `${sym}@${proto} 是一维码制，位图通道会把条空比例打糊，必须 native/degraded/none`);
    }
  }
});

test('planChannel-previewOnly 与未知码制都派到 none，并给出可读原因', () => {
  const g = planChannel('GS1_128', 'epl', '(01)04251234567890');
  assert.equal(g.channel, 'none');
  assert.ok(g.why && g.why.length > 8, 'GS1_128@EPL 必须说明为什么不打（FNC1 写法未查证）');
  const u = planChannel('NOT_A_SYM' as never, 'zpl', 'x');
  assert.equal(u.channel, 'none');
  assert.match(u.why ?? '', /不在码制能力矩阵内/);
});

test('planChannel-statusFor 对矩阵外码制返回 undefined（不得猜成 native）', () => {
  assert.equal(statusFor('NOT_A_SYM' as never, 'zpl'), undefined);
});

// ── 4. GS1 二维位图通道的 FNC1 转写（P7.4 错码回归锁） ─────────────────────

const GS1_2D_BCIDS = ['datamatrix', 'datamatrixrectangular', 'qrcode', 'microqrcode', 'azteccode'];

test('GS1 位图-括号 AI 必须转写成 ^FNC1 链（只开 parsefnc 打出来是带字面括号的普通符号）', () => {
  // 01 是定长 AI → 其后不插分隔符；10 是最后一个字段 → 末尾不插（插入就变成尾随 GS 脏数据）
  assert.equal(gs1BwipText('datamatrix', '(01)04251234567890(10)AB789'),
    '^FNC1010425123456789010AB789');
  assert.equal(gs1BwipText('qrcode', '(01)04251234567890(10)AB789'),
    '^FNC1010425123456789010AB789');
});

test('GS1 位图-定长 AI 之后不插分隔符，变长 AI 且后面还有 AI 才插，末尾永不插', () => {
  // 01 定长 14 → 后面不插；10 变长 → 后面还有 31xx 才插；3140 定长 6 → 不插
  assert.equal(gs1BwipText('datamatrix', '(01)04251234567890(10)AB789(3140)000123'),
    '^FNC1010425123456789010AB789^FNC13140000123');
  // 只有一个定长 AI 时，除起始 FNC1 外不应再有任何 ^FNC1
  assert.equal(gs1BwipText('datamatrix', '(01)04251234567890'), '^FNC10104251234567890');
});

test('GS1 位图-数据里的字面 ^ 必须转义成 ^^（实测未转义会 bwipp.truncatedFNC）', () => {
  assert.equal(gs1BwipText('datamatrix', '(10)A^B'), '^FNC110A^^B');
  assert.equal(gs1ToBwipFnc1([{ ai: '21', data: 'a^^b', fixed: false, length: null }]), '^FNC121a^^^^b');
});

test('GS1 位图-gs1-128 与 pdf417 不转写：前者 bwip 自己解析括号 AI，后者是 Composite 语义', () => {
  assert.equal(gs1BwipText('gs1-128', '(01)04251234567890'), undefined,
    'gs1-128 由 bwip 解析括号 AI（实测 ]C1），转写反而会让它按字面量编码');
  assert.equal(gs1BwipText('pdf417', '(01)04251234567890'), undefined,
    'PDF417 的 GS1 AI 走 Composite 链接语义，不能套用「起始 FNC1 + GS 分隔」');
  assert.equal(gs1BwipText('code128', '(01)04251234567890'), undefined);
});

test('GS1 位图-名单内 bcid 齐全（新增二维码制必须显式决定转不转写）', () => {
  assert.deepEqual(GS1_2D_BCIDS, BWIP_GS1_2D_BCIDS,
    '这份测试里的期望名单与 gs1.ts 的 BWIP_GS1_2D_BCIDS 不同步了：新增 bcid 时必须逐条决定转不转写');
  for (const bcid of GS1_2D_BCIDS) {
    if (bcid === 'microqrcode') {
      // 名单里唯一「该支持但本实现出不了图」的一档：必须**显式抛错**给可读原因，
      // 不许悄悄返回 undefined（那会退回「带括号的普通 Micro QR」= 错码）。
      assert.throws(() => gs1BwipText(bcid, '(01)04251234567890'), /Micro QR/,
        `${bcid} 的 GS1 拒绝口径漂了：应抛「Micro QR 没有可实现的 GS1 变体」`);
      continue;
    }
    assert.equal(gs1BwipText(bcid, '(01)04251234567890'), '^FNC10104251234567890',
      `${bcid} 在 GS1 二维名单里但没被转写，位图通道会打出带括号的错码`);
  }
});

test('GS1 位图-AI 结构解析失败必须抛错（宁可不打，不打错码），不得退回字面括号', () => {
  // 抛错的是「括号 AI 结构本身读不通」：尾随垃圾 / 空 AI / AI 前有多余字符。
  // 注意 (01)0425 这种「长度不够」不在此列——parseGs1 只解析结构，长度校验属于码制侧
  // （bwip 自己会拒），这里不许拿它当回归样例。
  assert.throws(() => gs1BwipText('datamatrix', '(01)04251234567890 junk('));
  assert.throws(() => gs1BwipText('datamatrix', '((01)x'));
  assert.throws(() => gs1BwipText('datamatrix', 'x(01)123'));
  assert.equal(gs1BwipText('datamatrix', 'NO-AI-HERE'), undefined, '非 GS1 内容原样交给 bwip');
});

test('GS1 位图-转写结果与 gs1ToRawStream 的 AI 链同构（只换分隔符写法，不换数据）', () => {
  const content = '(01)04251234567890(37)260315(10)AB789';
  const comps = parseGs1(content);
  const fnc = gs1ToBwipFnc1(comps).replace(/\^FNC1/g, '\u001d').replace(/\^\^/g, '^');
  const raw = comps.map((c, i) => c.ai + c.data + ((!c.fixed && i < comps.length - 1) ? '\u001d' : '')).join('');
  assert.equal(fnc.slice(1), raw, '起始 FNC1 之外的字段顺序/分隔位置必须与裸 GS1 流一致');
});

// ── 5. Console 预览侧那份 gs1 副本（apps/console/.../engine/gs1.ts）────────────
//
// 为什么必须锁：预览画布/打印 HTML/模板缩略图全都吃这份副本。它和后端一旦漂了，
// 用户看到的就是一张「能扫、但结构不对」的图，而打印出来是另一种符号 —— 这正是 P7.4
// 那个缺陷能活一整轮的机制（后端改了、前端没改）。console 没有测试框架（scripts 只有
// dev/build/lint/preview），所以这道守卫只能放在后端这边，直接 import 那份无依赖的纯函数副本。
// 报错**文案**允许不同（前端要给用户看短一点的），但「抛不抛、抛出什么值」必须逐条一致。

test('GS1 副本-前后端 gs1ToBwipFnc1 / gs1BwipText 对同一批语料必须逐条一致', async () => {
  const fe = await import('../../../apps/console/src/views/designer/engine/gs1');
  assert.deepEqual(fe.BWIP_GS1_2D_BCIDS, BWIP_GS1_2D_BCIDS,
    '两份转写名单不一致：新增二维 bcid 时必须两边同时决定转不转写');

  const corpus = [
    '(01)04251234567890(10)AB789',                       // 定长 + 变长末段
    '(01)04251234567890(10)AB789(3140)000123',           // 中间变长段 → 必须插分隔符
    '(01)04251234567890',                                // 只有一个定长 AI
    '(10)A^B', '(21)a^^b(10)c',                          // 字面 ^ / ^^ 转义
    '(37)260315(4100)1234567890123(10)AB',               // 4 位 AI 在定长表外 → 保守按变长
    '(01)04251234567890(4212)ABCD(21)S',                  // 42xx=变长地址族：曾被误判定长 6 ⇒ 漏插分隔符
    '(3103)001234(21)S',                                  // 31xx=计量定长 6 ⇒ 后面不插分隔符
    '(13)260101', '(02)123456789012(37)5',
    'NO-AI-HERE', 'PLAIN',                                // 非 GS1 → undefined
    '(01)04251234567890 junk(', '((01)x', 'x(01)123',     // 结构读不通 → 抛错
  ];
  const bcids = [...BWIP_GS1_2D_BCIDS, 'gs1-128', 'pdf417', 'code128'];
  const run = (fn: (b: string, c: string) => string | undefined, b: string, c: string) => {
    try { return { ok: true, v: fn(b, c) }; } catch { return { ok: false, v: 'THROW' }; }
  };
  let cases = 0, throws = 0;
  for (const bcid of bcids) {
    for (const content of corpus) {
      cases++;
      const a = run(gs1BwipText, bcid, content);
      const b = run(fe.gs1BwipText as any, bcid, content);
      assert.deepEqual(b, a, `bwip GS1 副本不一致：bcid=${bcid} content=${JSON.stringify(content)} 后端=${JSON.stringify(a)} 前端=${JSON.stringify(b)}`);
      if (!a.ok) throws++;
    }
  }
  assert.equal(cases, bcids.length * corpus.length);
  assert.ok(throws >= bcids.length, '语料里必须包含会抛错的输入，否则「抛不抛」这一维没比到');

  // 纯转写函数也要逐条一致（含 ^^ 与分隔符位置）。两侧**分别**捕获：
  // 「两边都抛」是合规结果（语料里那条 '(01)…junk(' 结构就读不通，两边都该抛），
  // 绝不能因为后端先抛就误报成「副本漂移」。
  const runChain = (parse: (c: string) => any, toFnc1: (comps: any) => string, c: string) => {
    try { return { ok: true, v: toFnc1(parse(c)) }; } catch { return { ok: false, v: 'THROW' }; }
  };
  let chain = 0;
  for (const content of corpus.filter((c) => /^\(\d{2,4}\)/.test(c))) {
    chain++;
    const be = runChain(parseGs1, gs1ToBwipFnc1, content);
    const fr = runChain(fe.parseGs1 as any, fe.gs1ToBwipFnc1 as any, content);
    assert.deepEqual(fr, be, `gs1ToBwipFnc1∘parseGs1 副本漂移：${JSON.stringify(content)} 后端=${JSON.stringify(be)} 前端=${JSON.stringify(fr)}`);
  }
  assert.ok(chain >= 8, `纯转写语料过少（${chain}），分隔符/转义这一维没比到`);
});

test('GS1 副本-定长/变长判定必须逐 AI 一致（measureAiLen 收窄后最容易单边漂移的一处）', async () => {
  // aiLength 决定「这个 AI 之后插不插分隔符」，两边各写一份时最容易只改一边：
  // P7.8 那次 `/^[34][1-6]\d{2}$/` → `/^3[1-6]\d{2}$/` 就是同时改了后端与 Console 副本，
  // 少改一边不会让上面那条语料测试变红（语料里只有部分档位），所以这里逐档比。
  const fe = await import('../../../apps/console/src/views/designer/engine/gs1');
  const ais = [
    '00', '01', '02', '11', '12', '13', '15', '16', '17', '20', '21', '22', '30', '37',
    '3100', '3103', '3202', '3699', '3923', '402', '410', '415', '4100', '4103', '4109',
    '4200', '4201', '4210', '4212', '4221', '4279', '4500', '4699', '8003', '8020', '8026', '99',
  ];
  for (const ai of ais) {
    assert.deepEqual(fe.aiLength(ai) as any, aiLength(ai), `AI ${ai} 的定长判定在两份实现里不一致`);
  }
  // 关键边界单独钉一次，防止哪天有人把 4xxx 又并回计量正则
  assert.deepEqual(aiLength('4212'), { fixed: false, length: null }, '42xx 是变长地址族，判定长 ⇒ 漏插分隔符');
  assert.deepEqual(aiLength('3103'), { fixed: true, length: 6 }, '31xx 是计量的「前缀 + 6 位数字」定长');
  assert.deepEqual(aiLength('3923'), { fixed: false, length: null }, '39xx 位数随小数位变化，不能并进 6 位定长');
});
