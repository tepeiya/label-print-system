<template>
  <textarea
    class="f-input f-area"
    :rows="rows"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    @focus="commit.begin()"
    @input="onInput"
    @change="onCommit"
    @blur="onCommit"
  />
</template>

<script setup lang="ts">
import { inject } from 'vue';
import { COMMIT_KEY, NO_COMMIT } from '../../useCommit';

withDefaults(defineProps<{
  modelValue: string;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
}>(), { modelValue: '', rows: 3 });

const emit = defineEmits<{ 'update:modelValue': [string] }>();
const commit = inject(COMMIT_KEY, NO_COMMIT);

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value);
}

function onCommit() {
  commit.end();
}
</script>
