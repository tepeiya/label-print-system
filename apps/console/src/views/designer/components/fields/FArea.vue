<template>
  <textarea
    class="f-input f-area"
    :rows="rows"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    @focus="commit.begin()"
    @input="onInput"
    @keydown="onKeydown"
    @change="onCommit"
    @blur="onCommit"
  />
</template>

<script setup lang="ts">
// =============================================================================
// FArea.vue —— 多行文本控件（文本 / 公式 / 图片地址 / 二维码内容共用）
//   noNewline 是给「条码内容」这类字段用的：框子放大只为看长内容，
//   不代表这条数据允许带换行。ZPL/TSPL 的指令按行切分，^FD…^FS 里塞进
//   \n 会让打印机把后半段当新指令读；EPL 生成器是显式剔除并报 [数据] 告警。
//   与其打出一张错码，不如在输入这一侧就把换行挡掉，并且把挡掉的个数说出来。
// =============================================================================
import { inject } from 'vue';
import { COMMIT_KEY, NO_COMMIT } from '../../useCommit';

/** 换行/制表符 → 单个空格（把两段内容接起来，而不是黏成一坨） */
const CTRL_TO_SPACE = /[\r\n\t]+/g;
/* eslint-disable no-control-regex -- 这条正则的用途就是把控制字符找出来清掉，不是拿去做传输校验 */
/** 其余 C0 控制字符（不含 \t \n \r）直接删 */
const CTRL_DROP = /[\u0000-\u0008\u000b-\u001f]/g;

const props = withDefaults(defineProps<{
  modelValue: string;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  /** 单行语义：回车不插入换行，粘贴/拖入的换行按空格接续，并上报本次整理掉几个控制字符 */
  noNewline?: boolean;
}>(), { modelValue: '', rows: 3, noNewline: false });

const emit = defineEmits<{ 'update:modelValue': [string]; normalize: [number] }>();
const commit = inject(COMMIT_KEY, NO_COMMIT);

function clean(v: string) {
  return v.replace(CTRL_TO_SPACE, ' ').replace(CTRL_DROP, '');
}

function onInput(e: Event) {
  const ta = e.target as HTMLTextAreaElement;
  const raw = ta.value;
  if (!props.noNewline || !/[\u0000-\u001f]/.test(raw)) {
    emit('update:modelValue', raw);
    return;
  }
  const cleaned = clean(raw);
  // 光标位置用同一套规则清洗前缀得到，落在换行串中间时最多多算一个空格，不影响编辑
  const caret = raw.slice(0, ta.selectionStart ?? raw.length);
  ta.value = cleaned;
  const at = clean(caret).length;
  ta.setSelectionRange(at, at);
  emit('update:modelValue', cleaned);
  // 报「原始串里有几个控制字符」，不是「净删了几个」——换行换成空格时净删是 0，
  // 按净删报会让提示说「整理了 0 个」，那是假话。
  emit('normalize', (raw.match(/[\u0000-\u001f]/g) ?? []).length);
}

function onKeydown(e: KeyboardEvent) {
  if (props.noNewline && e.key === 'Enter') e.preventDefault();
}

function onCommit() {
  commit.end();
}
</script>
