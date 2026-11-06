<template>
  <input
    class="f-input f-num"
    type="number"
    :step="step"
    :min="min"
    :max="max"
    :value="modelValue"
    :disabled="disabled"
    @focus="commit.begin()"
    @input="onInput"
    @change="onCommit"
    @blur="onCommit"
  >
</template>

<script setup lang="ts">
// 数值输入：聚焦留快照 → 输入实时写 → change/blur 提交（inspector.js#numInput 的语义）
import { inject } from 'vue';
import { COMMIT_KEY, NO_COMMIT } from '../../useCommit';

withDefaults(defineProps<{
  modelValue: number;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
}>(), { step: 0.1 });

const emit = defineEmits<{ 'update:modelValue': [number] }>();
const commit = inject(COMMIT_KEY, NO_COMMIT);

function parse(e: Event): number | null {
  const v = Number.parseFloat((e.target as HTMLInputElement).value);
  return Number.isFinite(v) ? v : null;
}

function onInput(e: Event) {
  const v = parse(e);
  if (v !== null) emit('update:modelValue', v);
}

function onCommit(e: Event) {
  const v = parse(e);
  if (v !== null) emit('update:modelValue', v);
  commit.end();
}
</script>
