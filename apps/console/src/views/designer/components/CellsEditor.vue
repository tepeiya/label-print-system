<template>
  <FGroup :title="`单元格（${rows} × ${cols}）`">
    <div v-for="r in rows" :key="r" class="cell-row">
      <input
        v-for="c in cols"
        :key="c"
        class="f-input cell-input"
        :class="{ 'cell-anchor': isAnchor(r - 1, c - 1), 'cell-covered': isCovered(r - 1, c - 1) }"
        type="text"
        :value="cellAt(r - 1, c - 1)"
        :placeholder="`R${r}C${c}`"
        @focus="commit.begin(); selectCell(r - 1, c - 1)"
        @input="onInput(r - 1, c - 1, $event)"
        @change="endCommit"
        @blur="endCommit"
      >
    </div>

    <!-- 第四层：合并单元格操作 -->
    <div class="merge-box">
      <FLabel text="合并（选中格为起点）" />
      <div class="merge-row">
        <FLabel text="行跨" />
        <FNum :model-value="rowSpan" :step="1" :min="1" :max="rows - sel.r" @update:model-value="rowSpan = Math.max(1, Math.round($event))" />
        <FLabel text="列跨" />
        <FNum :model-value="colSpan" :step="1" :min="1" :max="cols - sel.c" @update:model-value="colSpan = Math.max(1, Math.round($event))" />
      </div>
      <div class="merge-row">
        <FBtn :disabled="rowSpan === 1 && colSpan === 1" @click="applyMerge">合并</FBtn>
        <FBtn :disabled="!mergeAtSel" @click="removeMerge">取消合并</FBtn>
      </div>
      <span v-if="merged.length" class="f-hint">已合并 {{ merged.length }} 处</span>
    </div>
    <FRow>
      <FCheck text="自动换行" :model-value="el.cellWrap !== false" @update:model-value="setWrap" />
    </FRow>
  </FGroup>
</template>

<script setup lang="ts">
// 单元格编辑 + 第四层合并单元格：改一个格子时整格数组重建，
// 行列增减后旧值按索引对齐（与原生版同一写法）。合并走 table-layout 单一真源。
import { computed, inject, ref, watch } from 'vue';
import { useDesignerStore } from '../store';
import { COMMIT_KEY, NO_COMMIT } from '../useCommit';
import { buildTableLayout, type MergeRect } from '../engine/table-layout';
import type { ElementData } from '../types';
import FBtn from './fields/FBtn.vue';
import FCheck from './fields/FCheck.vue';
import FGroup from './fields/FGroup.vue';
import FLabel from './fields/FLabel.vue';
import FNum from './fields/FNum.vue';
import FRow from './fields/FRow.vue';

const props = defineProps<{ el: ElementData }>();

const store = useDesignerStore();
const commit = inject(COMMIT_KEY, NO_COMMIT);

const rows = computed(() => Math.max(1, props.el.rows || 1));
const cols = computed(() => Math.max(1, props.el.cols || 1));
const merged = computed<MergeRect[]>(() => buildTableLayout(rows.value, cols.value, props.el.mergedCells).merges);
const layout = computed(() => buildTableLayout(rows.value, cols.value, props.el.mergedCells));

const sel = ref({ r: 0, c: 0 });
const rowSpan = ref(1);
const colSpan = ref(1);

watch([rows, cols], () => { rowSpan.value = 1; colSpan.value = 1; });

function cellAt(r: number, c: number): string {
  return String(props.el.cells?.[r * cols.value + c] ?? '');
}

function onInput(r: number, c: number, e: Event) {
  const idx = r * cols.value + c;
  const cells = Array.from({ length: rows.value * cols.value }, (_, i) => props.el.cells?.[i] ?? '');
  cells[idx] = (e.target as HTMLInputElement).value;
  store.updateElement(props.el.id, { cells });
}

function endCommit() {
  commit.end();
}

function selectCell(r: number, c: number) {
  sel.value = { r, c };
  const m = mergeAt(r, c);
  if (m) { rowSpan.value = m.rowSpan; colSpan.value = m.colSpan; }
  else { rowSpan.value = 1; colSpan.value = 1; }
}

function isAnchor(r: number, c: number) { return sel.value.r === r && sel.value.c === c; }
function isCovered(r: number, c: number) { return layout.value.skipped.includes(`${r},${c}`); }
function mergeAt(r: number, c: number): MergeRect | undefined {
  return merged.value.find((m) => m.row === r && m.col === c);
}
const mergeAtSel = computed(() => mergeAt(sel.value.r, sel.value.c));

function applyMerge() {
  const rs = Math.max(1, Math.min(rowSpan.value, rows.value - sel.value.r));
  const cs = Math.max(1, Math.min(colSpan.value, cols.value - sel.value.c));
  if (rs === 1 && cs === 1) return;
  const next = merged.value.filter((m) => !(m.row === sel.value.r && m.col === sel.value.c));
  next.push({ row: sel.value.r, col: sel.value.c, rowSpan: rs, colSpan: cs });
  // 用布局真源再规范化一次，剔除与新合并重叠的旧合并
  commit.begin();
  store.updateElement(props.el.id, {
    mergedCells: buildTableLayout(rows.value, cols.value, next).merges,
  });
  commit.end();
}

function removeMerge() {
  const next = merged.value.filter((m) => !(m.row === sel.value.r && m.col === sel.value.c));
  commit.begin();
  store.updateElement(props.el.id, { mergedCells: next });
  commit.end();
  rowSpan.value = 1;
  colSpan.value = 1;
}

function setWrap(v: boolean) {
  commit.begin();
  store.updateElement(props.el.id, { cellWrap: v });
  commit.end();
}
</script>

<style scoped>
.cell-input.cell-anchor { outline: 2px solid #409eff; }
.cell-input.cell-covered { background: #f0f4fa; color: #aab; }
.merge-box { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--border, #d8dee9); }
.merge-row { display: flex; align-items: center; gap: 4px; margin-top: 4px; }
</style>
