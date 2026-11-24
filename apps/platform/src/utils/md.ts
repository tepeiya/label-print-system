/**
 * 极简 Markdown 渲染器（平台端没有引入 markdown-it / marked）。
 *
 * 只覆盖知识库文章实际用到的语法：`##` / `###` 标题、`| 表格 |`、`1.` / `-` 列表、
 * `>` 引用、`**加粗**`、`` `代码` ``、句子内换行。
 * 输入先整体做 HTML 转义，再替换标记 —— 文章内容是我们自己种进库的，但仍然不允许
 * 出现任何可执行标签（避免以后开放编辑后变成 XSS 入口）。
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 行内标记：先代码（免得里面的星号被当加粗），再加粗 */
function inline(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isTableSep = (line: string) => /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes('-');

function splitCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

export function renderMarkdown(md: string): string {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  /** 收一段连续的行（用于列表 / 引用 / 段落） */
  const collect = (pred: (l: string) => boolean): string[] => {
    const buf: string[] = [];
    while (i < lines.length && pred(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    return buf;
  };

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 表格：当前行 + 下一行是分隔行
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitCells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        body.push(splitCells(lines[i]));
        i += 1;
      }
      out.push('<table class="md-table"><thead><tr>' + head.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>');
      for (const row of body) {
        out.push('<tr>' + row.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
      }
      out.push('</tbody></table>');
      continue;
    }

    // 标题
    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) {
      out.push(`<h4 class="md-h4">${inline(h3[1])}</h4>`);
      i += 1;
      continue;
    }
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      out.push(`<h3 class="md-h3">${inline(h2[1])}</h3>`);
      i += 1;
      continue;
    }
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) {
      out.push(`<h2 class="md-h2">${inline(h1[1])}</h2>`);
      i += 1;
      continue;
    }

    // 无序列表（支持两格缩进的子项）
    if (/^\s*[-*]\s+/.test(line)) {
      const items = collect((l) => /^\s*[-*]\s+/.test(l) || /^\s{2,}\S/.test(l));
      const html: string[] = ['<ul class="md-ul">'];
      for (const it of items) {
        const m = it.match(/^(\s*)[-*]\s+(.*)$/);
        if (m) html.push(`<li${m[1].length >= 2 ? ' class="md-li-sub"' : ''}>${inline(m[2])}</li>`);
        else html.push(`<li class="md-li-sub">${inline(it.trim())}</li>`);
      }
      html.push('</ul>');
      out.push(html.join(''));
      continue;
    }

    // 有序列表（连续编号行 + 其后的缩进续行算同一项）
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = collect((l) => /^\s*\d+[.)]\s+/.test(l) || /^\s{2,}\S/.test(l));
      const html: string[] = ['<ol class="md-ol">'];
      for (const it of items) {
        const m = it.match(/^\s*\d+[.)]\s+(.*)$/);
        if (m) html.push(`<li>${inline(m[1])}</li>`);
        else if (html.length > 1) {
          // 续行并入上一项
          html[html.length - 1] = html[html.length - 1].replace(/<\/li>$/, `<br>${inline(it.trim())}</li>`);
        }
      }
      html.push('</ol>');
      out.push(html.join(''));
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const q = collect((l) => /^\s*>\s?/.test(l)).map((l) => l.replace(/^\s*>\s?/, ''));
      out.push(`<div class="md-quote">${inline(q.join(' '))}</div>`);
      continue;
    }

    // 段落：连续普通行合并，单换行保留成 <br>
    const para = collect((l) => !!l.trim() && !/^\s*(#{1,4}\s|[-*]\s|\d+[.)]\s|>|\|)/.test(l));
    out.push(`<p class="md-p">${para.map((l) => inline(l.trim())).join('<br>')}</p>`);
  }

  return out.join('\n');
}

/** 纯文本摘要用：去掉 markdown 标记，压成一行 */
export function plainText(md: string, max = 120): string {
  const s = String(md ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/^\s*\|.*$/gm, ' ')
    .replace(/[#>*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
