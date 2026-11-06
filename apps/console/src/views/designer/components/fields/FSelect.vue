<template>
  <select
    class="f-input f-select"
    :value="String(modelValue ?? '')"
    :disabled="disabled"
    @focus="commit.begin()"
    @change="onChange"
  >
    <option v-for="opt in normalized" :key="String(opt.value)" :value="String(opt.value)">
      {{ opt.label }}
    </option>
  </select>
</template>

<script setup lang="ts">
// 下拉：选项可以是 ['A','B'] 这样的纯值数组、[['value','label'], ...] 元组，
// 或者 { value, label } 对象 —— 与原生 inspector.js#selectInput 接受的入参形状一致
// （VAR_VALIDATIONS 就是对象形状的那一路）。
import { computed, inject } from 'vue';
import { COMMIT_KEY, NO_COMMIT } from '../../useCommit';

type Opt = string | number | [string | number, string] | { value: string | number; label: string };

const props = withDefaults(defineProps<{
  modelValue: string | number | boolean;
  options: Opt[];
  disabled?: boolean;
}>(), { modelValue: '' });

const emit = defineEmits<{ 'update:modelValue': [string] }>();
const commit = inject(COMMIT_KEY, NO_COMMIT);

const normalized = computed(() => props.options.map((o) => {
  if (Array.isArray(o)) return { value: o[0], label: o[1] };
  if (typeof o === 'object') return { value: o.value, label: o.label };
  return { value: o, label: String(o) };
}));

function onChange(e: Event) {
  emit('update:modelValue', (e.target as HTMLSelectElement).value);
  commit.end();
}
</script>
