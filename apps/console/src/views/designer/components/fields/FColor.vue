<template>
  <span class="f-color">
    <input
      type="color"
      :value="hex"
      :disabled="disabled"
      @focus="commit.begin()"
      @input="onInput"
      @change="onCommit"
    >
    <input
      class="f-input f-color-text"
      type="text"
      :value="modelValue"
      :disabled="disabled"
      @focus="commit.begin()"
      @input="onInput"
      @change="onCommit"
      @blur="onCommit"
    >
  </span>
</template>

<script setup lang="ts">
// 颜色：色板 + 文本框并用。原生版只有色板，这里多给一个文本框是为了能填 #FFF000 之类的简写。
import { computed, inject } from 'vue';
import { COMMIT_KEY, NO_COMMIT } from '../../useCommit';

const props = defineProps<{ modelValue: string; disabled?: boolean }>();

const emit = defineEmits<{ 'update:modelValue': [string] }>();
const commit = inject(COMMIT_KEY, NO_COMMIT);

/** <input type=color> 只认 #rrggbb，其余写法一律回落到黑色，避免浏览器显示空白 */
const hex = computed(() => {
  const v = String(props.modelValue ?? '').trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return '#000000';
});

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).value);
}

function onCommit() {
  commit.end();
}
</script>
