<template>
  <input
    class="f-range"
    type="range"
    min="0"
    max="1"
    step="0.05"
    :value="modelValue"
    :disabled="disabled"
    @focus="commit.begin()"
    @input="onInput"
    @change="onCommit"
  >
</template>

<script setup lang="ts">
import { inject } from 'vue';
import { COMMIT_KEY, NO_COMMIT } from '../../useCommit';

defineProps<{ modelValue: number; disabled?: boolean }>();

const emit = defineEmits<{ 'update:modelValue': [number] }>();
const commit = inject(COMMIT_KEY, NO_COMMIT);

function onInput(e: Event) {
  emit('update:modelValue', Number.parseFloat((e.target as HTMLInputElement).value) || 0);
}

function onCommit() {
  commit.end();
}
</script>
