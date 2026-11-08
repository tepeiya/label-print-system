// =============================================================================
// golden/update.ts —— P7.8 golden 快照的**生成 / 校验**入口
//
// 用法：
//   npx tsx core/__tests__/golden/update.ts --update   # 有意重写快照（改实现/改用例后）
//   npx tsx core/__tests__/golden/update.ts            # 只校验：不匹配就打印 diff 并 exit 1
//
// ⚠️ CI / 验收脚本（scripts/p7-acceptance.sh 的 B 段）**只允许跑默认模式**：
//   快照的存在意义就是「指令格式被人顺手改动时立刻暴露」，能顺手 --update 掉就等于没有。
//   要更新快照必须先看懂 diff、确认改动是想要的，再跑 --update 并把 diff 贴进 PR。
//
// 快照内容由 cases.ts 的纯函数产生（不碰 bwip/sharp/网络），因此可重复：
//   连跑两次默认模式必然全绿，且第二次不写任何文件。
// =============================================================================
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fileNameFor, goldenCases, makeSnapshot, renderSnapshot } from './cases';

const HERE = __dirname;
const OUT_DIR = HERE;                       // 快照与脚本同目录：core/__tests__/golden/*.txt
const UPDATE = process.argv.includes('--update');

/**
 * 极简行级 diff（不做 LCS：快照本来就应该「一行不差」，
 * 出现增删行时把两侧都摊开给人看比算最小 edit 更有用）。
 */
function diff(expected: string, actual: string): string {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const out: string[] = [];
  const n = Math.max(a.length, b.length);
  let shown = 0;
  for (let i = 0; i < n && shown < 12; i++) {
    if (a[i] === b[i]) continue;
    out.push(`  L${i + 1}`);
    if (a[i] !== undefined) out.push(`    - ${a[i]}`);
    if (b[i] !== undefined) out.push(`    + ${b[i]}`);
    shown++;
  }
  if (shown >= 12) out.push('  …（差异过多已截断，跑 --update 后用 git diff 看全量）');
  return out.join('\n');
}

function main(): number {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const cases = goldenCases();
  const expected = new Set(cases.map(fileNameFor));
  let written = 0, changed = 0, missing = 0;
  const bad: string[] = [];

  for (const c of cases) {
    const file = join(OUT_DIR, fileNameFor(c));
    const text = renderSnapshot(makeSnapshot(c));
    if (UPDATE) {
      const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (prev !== text) { writeFileSync(file, text, 'utf8'); changed++; }
      written++;
      continue;
    }
    if (!existsSync(file)) { missing++; bad.push(`${c.key} @ ${c.protocol.toUpperCase()}: 缺快照文件 ${fileNameFor(c)}（跑 npx tsx core/__tests__/golden/update.ts --update 生成）`); continue; }
    const prev = readFileSync(file, 'utf8');
    if (prev !== text) {
      bad.push(`${c.key} @ ${c.protocol.toUpperCase()} —— 快照与当前实现不一致\n${diff(prev, text)}`);
    }
  }

  // 孤儿文件：用例删掉后遗留的快照会让「覆盖了 21 个码制」变成假象
  if (!UPDATE) {
    for (const f of readdirSync(OUT_DIR)) {
      if (!f.endsWith('.txt')) continue;
      if (!expected.has(f)) bad.push(`孤儿快照 ${f}：cases.ts 里已没有这条用例，请删掉文件或补回用例`);
    }
    if (bad.length) {
      console.error(`\n✗ golden 快照校验失败：${bad.length} 项\n`);
      for (const b of bad) console.error(b + '\n');
      console.error(`（确认差异符合预期后：npx tsx core/__tests__/golden/update.ts --update）`);
      return 1;
    }
    console.log(`✓ golden 快照校验通过：${cases.length} 份（未写盘）`);
    return 0;
  }

  console.log(`golden 快照已更新：${written} 份用例，${changed} 份内容有变化`);
  return 0;
}

process.exit(main());
