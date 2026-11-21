<template>
  <FGroup title="DB 字段绑定">
    <span class="f-hint">{{ HINT }}</span>
    <FField label="字段名 / 占位">
      <FText :model-value="d.field" placeholder="如 productName 或 {{sku}}" @update:model-value="patch({ field: $event })" />
    </FField>
    <FField label="数据源 ID（可选）">
      <FText :model-value="d.datasetId ?? ''" placeholder="留空=模板变量/数据行" @update:model-value="patch({ datasetId: $event })" />
    </FField>
    <FField label="取值格式">
      <FSelect
        :model-value="d.format ?? ''"
        :options="FORMAT_OPTIONS"
        @update:model-value="patch({ format: $event })"
      />
    </FField>
    <FField v-if="isDateFmt" label="日期格式">
      <FText :model-value="datePattern" placeholder="YYYY-MM-DD" @update:model-value="onDatePattern" />
    </FField>
    <FField v-if="isNumFmt" label="小数位">
      <FNum :model-value="numDigits" :step="1" :min="0" :max="6" @update:model-value="onNumDigits" />
    </FField>
    <FField label="空值占位">
      <FText :model-value="d.fallback ?? ''" placeholder="—" @update:model-value="patch({ fallback: $event })" />
    </FField>
    <div v-if="varOptions.length" class="db-quick">
      <FLabel text="常用字段" />
      <div class="db-chips">
        <button v-for="v in varOptions" :key="v" type="button" class="db-chip" @click="patch({ field: `{{${v}}}` })">{{ v }}</button>
      </div>
    </div>
  </FGroup>
</template>

<script setup lang="ts">
// DB 字段编辑器：绑定数据源字段名 + 格式 + 空值占位。
// 设计态只存「字段名 / {{变量}}」字符串，真实取值由后端打印时按数据行注入；
// 这里列出模板变量作为快捷填充，避免设计器依赖数据源 API（数据源在打印侧读取）。
import { computed, inject } from 'vue';
import { useDesignerStore } from '../store';
import { COMMIT_KEY, NO_COMMIT } from '../useCommit';
import type { DbFieldSpec, ElementData } from '../types';
import FField from './fields/FField.vue';
import FGroup from './fields/FGroup.vue';
import FLabel from './fields/FLabel.vue';
import FNum from './fields/FNum.vue';
import FSelect from './fields/FSelect.vue';
import FText from './fields/FText.vue';

const props = defineProps<{ el: ElementData }>();
const store = useDesignerStore();
const commit = inject(COMMIT_KEY, NO_COMMIT);

const HINT = '字段名写 {{变量名}} 绑定模板变量/数据行，或直接写数据源列名；datasetId 仅在多数据源时指定。矢量/指令通道按纯文本输出。';
const FORMAT_OPTIONS: Array<[string, string]> = [
  ['', '原样'], ['upper', '转大写'], ['lower', '转小写'],
  ['num:2', '数值 2 位'], ['num:0', '数值取整'], ['date', '日期 YYYY-MM-DD'],
  ['date:YYYY/MM/DD', '日期 YYYY/MM/DD'], ['date:YYYYMMDD', '日期 YYYYMMDD'],
];

const d = computed<DbFieldSpec>(() => props.el.dbField ?? { field: '' });
const varOptions = computed(() => (store.variables ?? []).map((v) => v.name).slice(0, 12));
const isDateFmt = computed(() => String(d.value.format ?? '').startsWith('date:'));
const isNumFmt = computed(() => /^num:\d+$/.test(String(d.value.format ?? '')));
const datePattern = computed(() => String(d.value.format ?? '').slice(5) || 'YYYY-MM-DD');
const numDigits = computed(() => Number(String(d.value.format ?? '').slice(4)) || 0);

function patch(p: Partial<DbFieldSpec>) {
  commit.begin();
  store.updateElement(props.el.id, { dbField: { ...d.value, ...p } });
  commit.end();
}
function onDatePattern(v: string) { patch({ format: `date:${v || 'YYYY-MM-DD'}` }); }
function onNumDigits(v: number) { patch({ format: `num:${Math.max(0, Math.round(v))}` }); }
</script>

<style scoped>
.db-quick { margin-top: 6px; }
.db-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.db-chip { font-size: 11px; padding: 1px 6px; border: 1px solid var(--border, #d8dee9); border-radius: 10px; background: transparent; cursor: pointer; }
</style>
