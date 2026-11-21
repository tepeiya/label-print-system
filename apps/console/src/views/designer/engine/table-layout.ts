// =============================================================================
// table-layout.ts —— 表格合并单元格布局单一真源（第四层 · 设计器交互精度）
//   纯函数、零依赖。前端 print.ts / 画布与后端各渲染器共用同一语义，
//   前后端 parity 副本一致（backend/core/table-layout.ts），由 table-layout.test.ts 锁定。
//
//   数据契约沿用 P8 AI 表格识别已定义的 mergedCells: [{row,col,rowSpan,colSpan}]，
//   行/列 0 基，rowSpan/colSpan ≥ 1。越界/重叠在 normalizeMerges 里钳制与去冲突。
// =============================================================================

export interface MergeRect {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

export interface TableLayout {
  rows: number;
  cols: number;
  /** 规范化后的合并矩形（去重/去重叠/钳制边界） */
  merges: MergeRect[];
  /** 被合并覆盖、不应单独绘制的格子索引集合（字符串 "r,c"） */
  skipped: string[];
  /** 每个主格的实际跨度：key "r,c" → {rowSpan,colSpan}；非主格无条目 */
  spans: Record<string, { rowSpan: number; colSpan: number }>;
}

/** 规范化合并：钳制到网格内、丢弃 1×1、按起点去重、剔除与主格重叠的次级合并 */
export function normalizeMerges(
  rows: number,
  cols: number,
  input: unknown,
): MergeRect[] {
  const R = Math.max(1, Math.floor(rows));
  const C = Math.max(1, Math.floor(cols));
  if (!Array.isArray(input)) return [];
  const seenStart = new Set<string>();
  const out: MergeRect[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;
    const row = Math.max(0, Math.min(R - 1, Math.floor(Number(m.row ?? m.r ?? 0) || 0)));
    const col = Math.max(0, Math.min(C - 1, Math.floor(Number(m.col ?? m.c ?? 0) || 0)));
    const rowSpan = Math.max(1, Math.min(R - row, Math.floor(Number(m.rowSpan ?? m.rs ?? 1) || 1)));
    const colSpan = Math.max(1, Math.min(C - col, Math.floor(Number(m.colSpan ?? m.cs ?? 1) || 1)));
    if (rowSpan === 1 && colSpan === 1) continue;
    const key = `${row},${col}`;
    if (seenStart.has(key)) continue;
    seenStart.add(key);
    out.push({ row, col, rowSpan, colSpan });
  }
  // 去重叠：若两个合并矩形覆盖同一格，保留先出现的（面积大的优先更稳，这里按出现顺序保证确定性）
  const occupied = new Set<string>();
  const kept: MergeRect[] = [];
  for (const m of out) {
    let overlap = false;
    for (let r = m.row; r < m.row + m.rowSpan && !overlap; r++) {
      for (let c = m.col; c < m.col + m.colSpan; c++) {
        if (occupied.has(`${r},${c}`)) { overlap = true; break; }
      }
    }
    if (overlap) continue;
    for (let r = m.row; r < m.row + m.rowSpan; r++) {
      for (let c = m.col; c < m.col + m.colSpan; c++) occupied.add(`${r},${c}`);
    }
    kept.push(m);
  }
  return kept;
}

/** 构建表格布局：给渲染器一次性算出 skip/spans */
export function buildTableLayout(rows: number, cols: number, mergedCells: unknown): TableLayout {
  const R = Math.max(1, Math.floor(rows));
  const C = Math.max(1, Math.floor(cols));
  const merges = normalizeMerges(R, C, mergedCells);
  const skipped: string[] = [];
  const spans: Record<string, { rowSpan: number; colSpan: number }> = {};
  for (const m of merges) {
    spans[`${m.row},${m.col}`] = { rowSpan: m.rowSpan, colSpan: m.colSpan };
    for (let r = m.row; r < m.row + m.rowSpan; r++) {
      for (let c = m.col; c < m.col + m.colSpan; c++) {
        if (r !== m.row || c !== m.col) skipped.push(`${r},${c}`);
      }
    }
  }
  return { rows: R, cols: C, merges, skipped, spans };
}

/** 主格取值：合并区域的内容取左上角主格 cells[row*cols+col]；被合并格通常为空 */
export function cellIndexOf(row: number, col: number, cols: number): number {
  return row * cols + col;
}
