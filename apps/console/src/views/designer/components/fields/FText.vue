<template>
  <input
    class="f-input"
    type="text"
    :value="shown"
    :placeholder="placeholder"
    :disabled="disabled"
    @focus="onFocus"
    @input="onInput"
    @change="onCommit"
    @blur="onBlur"
    @keydown.enter.prevent="onEnter"
    @keydown.esc="onEsc"
  >
</template>

<script setup lang="ts">
// lazy=true：输入过程只改本地草稿，回车/失焦才提交。
// 变量名这类「一提交就重建 DOM（key 变化）」的字段必须用它，否则每敲一个字符就丢焦点。
import { computed, inject, nextTick, ref, watch } from 'vue';
import { COMMIT_KEY, NO_COMMIT } from '../../useCommit';

const props = withDefaults(defineProps<{
  modelValue: string;
  placeholder?: string;
  disabled?: boolean;
  lazy?: boolean;
}>(), {
  modelValue: '',
  lazy: false,
});

const emit = defineEmits<{ 'update:modelValue': [string] }>();
const commit = inject(COMMIT_KEY, NO_COMMIT);

const draft = ref(props.modelValue);
const focused = ref(false);
/** change 与 blur 会先后触发，同一个值只提交一次，避免重复弹错误提示 */
const lastFlushed = ref<string | null>(null);

watch(() => props.modelValue, (v) => {
  // 编辑中不覆盖用户正在敲的内容；外部改名（撤销/导入）时才同步
  if (!props.lazy || !focused.value) draft.value = v;
});

const shown = computed(() => (props.lazy ? draft.value : props.modelValue));

function onFocus() {
  focused.value = true;
  lastFlushed.value = null;
  if (props.lazy) draft.value = props.modelValue;
  commit.begin();
}

function onInput(e: Event) {
  const val = (e.target as HTMLInputElement).value;
  if (!props.lazy) {
    emit('update:modelValue', val);
    return;
  }
  lastFlushed.value = null;
  draft.value = val;
}

function flush() {
  if (!props.lazy || draft.value === props.modelValue) return;
  if (lastFlushed.value === draft.value) return;
  lastFlushed.value = draft.value;
  emit('update:modelValue', draft.value);
  // 父组件拒收（校验失败/重名）时，props 不会变，回退到旧值
  nextTick(() => {
    if (props.modelValue !== draft.value) draft.value = props.modelValue;
  });
}

function onCommit() {
  commit.end();
  flush();
}

function onBlur() {
  focused.value = false;
  onCommit();
}

/** 回车即确认：直接 blur，走同一条提交路径 */
function onEnter(e: KeyboardEvent) {
  (e.target as HTMLInputElement).blur();
}

function onEsc(e: KeyboardEvent) {
  if (!props.lazy) return;
  draft.value = props.modelValue;
  (e.target as HTMLInputElement).blur();
}
</script>
