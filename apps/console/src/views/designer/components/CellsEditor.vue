<template>
  <FGroup :title="`单元格（${rows} × ${cols}）`">
    <div v-for="r in rows" :key="r" class="cell-row">
      <input
        v-for="c in cols"
        :key="c"
        class="f-input cell-input"
        type="text"
        :value="cellAt(r - 1, c - 1)"
        :placeholder="`R${r}C${c}`"
        @focus="commit.begin()"
        @input="onInput(r - 1, c - 1, $event)"
        @change="endCommit"
        @blur="endCommit"
      >
    </div>
  </FGroup>
</template>

<script setup lang="ts">
// 单元格编辑（inspector.js#cellsEditor）：改一个格子时整格数组重建，
// 行列增减后旧值按索引对齐 —— 与原生版「Array.from({length: rows*cols})」同一写法。
import { computed, inject } from 'vue';
import { useDesignerStore } from '../store';
import { COMMIT_KEY, NO_COMMIT } from '../useCommit';
import type { ElementData } from '../types';
import FGroup from './fields/FGroup.vue';

const props = defineProps<{ el: ElementData }>();

const store = useDesignerStore();
const commit = inject(COMMIT_KEY, NO_COMMIT);

const rows = computed(() => Math.max(1, props.el.rows || 1));
const cols = computed(() => Math.max(1, props.el.cols || 1));

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
</script>
