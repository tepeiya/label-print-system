<template>
  <input
    class="f-input"
    type="text"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    @focus="commit.begin()"
    @input="onInput"
    @change="onCommit"
    @blur="onCommit"
  >
</template>

<script setup lang="ts">
import { inject } from 'vue';
import { COMMIT_KEY, NO_COMMIT } from '../../useCommit';

withDefaults(defineProps<{ modelValue: string; placeholder?: string; disabled?: boolean }>(), {
  modelValue: '',
});

const emit = defineEmits<{ 'update:modelValue': [string] }>();
const commit = inject(COMMIT_KEY, NO_COMMIT);

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).value);
}

function onCommit() {
  commit.end();
}
</script>
