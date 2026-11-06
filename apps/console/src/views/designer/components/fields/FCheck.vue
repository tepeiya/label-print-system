<template>
  <label class="f-check">
    <input
      type="checkbox"
      :checked="modelValue"
      :disabled="disabled"
      @focus="commit.begin()"
      @change="onChange"
    >
    <span>{{ text }}</span>
  </label>
</template>

<script setup lang="ts">
import { inject } from 'vue';
import { COMMIT_KEY, NO_COMMIT } from '../../useCommit';

defineProps<{ modelValue: boolean; text: string; disabled?: boolean }>();

const emit = defineEmits<{ 'update:modelValue': [boolean] }>();
const commit = inject(COMMIT_KEY, NO_COMMIT);

function onChange(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).checked);
  commit.end();
}
</script>
