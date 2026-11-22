<template>
  <FGroup title="富文本片段">
    <span class="f-hint">{{ hintText }}</span>
    <div v-for="(run, i) in runs" :key="i" class="rt-run">
      <div class="rt-run-head">
        <span class="rt-idx">#{{ i + 1 }}</span>
        <FText :model-value="run.text" placeholder="片段文本，可含 {{变量}}" @update:model-value="patch(i, { text: $event })" />
        <FBtn kind="danger" title="删除片段" @click="remove(i)">✕</FBtn>
      </div>
      <div class="rt-run-opts">
        <FCheck text="粗" :model-value="!!run.bold" @update:model-value="patch(i, { bold: $event })" />
        <FCheck text="斜" :model-value="!!run.italic" @update:model-value="patch(i, { italic: $event })" />
        <FCheck text="划" :model-value="!!run.underline" @update:model-value="patch(i, { underline: $event })" />
        <FSelect
          :model-value="run.script ?? ''"
          :options="SCRIPT_OPTIONS"
          @update:model-value="setScript(i, $event)"
        />
      </div>
      <div class="rt-run-opts">
        <FLabel text="色" />
        <FColor :model-value="run.color ?? el.font?.color ?? '#000000'" @update:model-value="patch(i, { color: $event })" />
        <FLabel text="字号" />
        <FNum :model-value="run.size ?? el.font?.size ?? 9" :step="0.5" :min="1" :max="400" @update:model-value="patch(i, { size: $event })" />
      </div>
    </div>
    <div class="rt-actions">
      <FBtn @click="add">＋ 添加片段</FBtn>
    </div>
  </FGroup>
</template>

<script setup lang="ts">
// 富文本片段编辑器：runs 增删 + 每段样式覆盖。走单一真源 normalizeRuns，
// 写回走 store.updateElement（与其余属性面板一致，快照式撤销可用）。
import { computed, inject } from 'vue';
import { useDesignerStore } from '../store';
import { normalizeRuns, type RichTextRun } from '../engine/rich-text';
import { COMMIT_KEY, NO_COMMIT } from '../useCommit';
import type { ElementData } from '../types';
import FBtn from './fields/FBtn.vue';
import FCheck from './fields/FCheck.vue';
import FColor from './fields/FColor.vue';
import FGroup from './fields/FGroup.vue';
import FLabel from './fields/FLabel.vue';
import FNum from './fields/FNum.vue';
import FSelect from './fields/FSelect.vue';
import FText from './fields/FText.vue';

const props = defineProps<{ el: ElementData }>();
const store = useDesignerStore();
const commit = inject(COMMIT_KEY, NO_COMMIT);
const hintText = '每段独立设置样式；占位符 {{变量}} 在每段内均可用';

const runs = computed<RichTextRun[]>(() => normalizeRuns(props.el.runs, props.el.text));
const SCRIPT_OPTIONS: Array<[string, string]> = [['', '正常'], ['sub', '下标'], ['super', '上标']];

function write(next: RichTextRun[]) {
  commit.begin();
  store.updateElement(props.el.id, { runs: next });
  commit.end();
}

function patch(i: number, p: Partial<RichTextRun>) {
  const next = runs.value.map((r, idx) => (idx === i ? { ...r, ...p } : r));
  write(next);
}

function setScript(i: number, v: string) {
  const script = v === 'sub' || v === 'super' ? v : undefined;
  const next = runs.value.map((r, idx) => {
    if (idx !== i) return r;
    const copy = { ...r };
    if (script) copy.script = script; else delete copy.script;
    return copy;
  });
  write(next);
}

function remove(i: number) {
  write(runs.value.filter((_, idx) => idx !== i));
}

function add() {
  write([...runs.value, { text: '新片段' }]);
}
</script>

<style scoped>
.rt-run { border: 1px solid var(--border, #d8dee9); border-radius: 4px; padding: 4px 6px; margin-bottom: 6px; }
.rt-run-head, .rt-run-opts { display: flex; align-items: center; gap: 4px; margin-bottom: 3px; }
.rt-run-head > :nth-child(2) { flex: 1; }
.rt-idx { font-size: 11px; color: #888; min-width: 20px; }
.rt-run-opts .f-select { max-width: 92px; }
.rt-actions { display: flex; gap: 6px; margin-top: 4px; }
</style>
