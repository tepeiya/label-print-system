<template>
  <div class="apv" :class="depth === 0 ? 'apv-root' : 'apv-nested'">
    <!-- 顶层就是空对象：给一句话，不要渲染一个空白框 -->
    <div v-if="depth === 0 && isEmptyObject" class="apv-empty">（无参数）</div>

    <!-- __array/sample：后端把数组折叠成 { __array: 长度, sample: [前 2 项] } -->
    <div v-else-if="kind === 'array'" class="apv-block">
      <div class="apv-head">
        <span v-if="k" class="apv-k">{{ k }}</span>
        <el-tag size="small" type="warning" effect="plain">数组 · 共 {{ arrayLen }} 项</el-tag>
        <span class="apv-hint">仅展示前 {{ sampleItems.length }} 项样例</span>
      </div>
      <div class="apv-body">
        <ArgsPreview v-for="(s, i) in sampleItems" :key="i" :k="`[${i}]`" :v="s" :depth="depth + 1" />
      </div>
    </div>

    <!-- __json/keys：大对象只回 { __json: 'N 字符', keys: [前 8 个键] } -->
    <div v-else-if="kind === 'json'" class="apv-block">
      <div class="apv-head">
        <span v-if="k" class="apv-k">{{ k }}</span>
        <el-tag size="small" type="info" effect="plain">大对象 · {{ jsonSize }}</el-tag>
        <span class="apv-hint">内容过长，后端只回键名</span>
      </div>
      <div class="apv-keys">
        <el-tag v-for="key in jsonKeys" :key="key" size="small" type="info">{{ key }}</el-tag>
      </div>
    </div>

    <!-- 普通对象 / 数组：逐个子节点递归 -->
    <div v-else-if="kind === 'group'" class="apv-group">
      <div v-if="k" class="apv-head">
        <span class="apv-k">{{ k }}</span>
        <span class="apv-hint">{{ childEntries.length }} 项</span>
      </div>
      <div class="apv-body">
        <ArgsPreview
          v-for="e in childEntries"
          :key="e.key"
          :k="e.key"
          :v="e.value"
          :depth="depth + 1"
        />
      </div>
    </div>

    <!-- 叶子：字符串 / 数字 / 布尔 / null -->
    <div v-else class="apv-leaf">
      <span v-if="k" class="apv-k">{{ k }}</span>
      <span class="apv-v" :class="{ 'apv-null': primitive === 'null' }">{{ primitive }}</span>
      <el-tag v-if="foldChars" size="small" type="danger" effect="plain" class="apv-fold">
        已截断，共 {{ foldChars }} 字符
      </el-tag>
    </div>
  </div>
</template>

<script setup lang="ts">
// ============================================================================
// ArgsPreview —— 审批单 argsPreview 的友好渲染（递归组件）
//
// argsPreview 不是原始参数，而是 backend/src/agent/approval.calc.ts 的
// compactPreview() 产物，有三种「折叠标记」，直接 JSON.stringify 会很难看：
//   1. 数组        → { __array: 元素数, sample: [前 2 个已折叠元素] }
//   2. 大对象      → { __json: '<N> 字符', keys: [前 8 个键名] }
//   3. 长字符串    → '<前 120 字符>…（共 N 字符）'
// 这里按标记分支渲染：数组给样例、大对象给键名、长字符串给「共 N 字符」提示，
// 其余按嵌套结构递归，深度封顶避免界面被撑爆。
// ============================================================================
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  /** 键名（顶层不传） */
  k?: string;
  /** 待渲染的值 */
  v?: any;
  /** 递归深度 */
  depth?: number;
}>(), { k: '', depth: 0 });

/** 深度上限：compactPreview 的折叠只到数组前 2 项，正常不会到这么深 */
const MAX_DEPTH = 8;

const isPlainObject = (x: any) => !!x && typeof x === 'object' && !Array.isArray(x);

const isEmptyObject = computed(() => isPlainObject(props.v) && !Object.keys(props.v).length);

/** __array 标记（对象且有 __array 数字 + sample 数组） */
const isArrayMarker = computed(() => (
  isPlainObject(props.v)
  && typeof props.v.__array === 'number'
  && Array.isArray(props.v.sample)
));

/** __json 标记（对象且有 __json + keys 数组） */
const isJsonMarker = computed(() => (
  isPlainObject(props.v) && typeof props.v.__json === 'string' && Array.isArray(props.v.keys)
));

const isComposite = computed(() => isPlainObject(props.v) || Array.isArray(props.v));

const kind = computed<'array' | 'json' | 'group' | 'leaf'>(() => {
  if (isArrayMarker.value) return 'array';
  if (isJsonMarker.value) return 'json';
  // 复合值且没超深才继续展开，否则压成一行 JSON 兜住，避免无限递归
  if (isComposite.value && props.depth < MAX_DEPTH) return 'group';
  return 'leaf';
});

const arrayLen = computed(() => Number(props.v?.__array ?? 0));
const sampleItems = computed<any[]>(() => props.v?.sample ?? []);
const jsonSize = computed(() => props.v?.__json ?? '');
const jsonKeys = computed<string[]>(() => props.v?.keys ?? []);

const childEntries = computed<{ key: string; value: any }[]>(() => {
  const val = props.v;
  if (Array.isArray(val)) return val.map((item, i) => ({ key: `[${i}]`, value: item }));
  if (isPlainObject(val)) return Object.entries(val).map(([key, value]) => ({ key, value }));
  return [];
});

/** 折叠后的长字符串：'xxx…（共 1234 字符）' → '1234' */
const foldChars = computed(() => {
  if (typeof props.v !== 'string') return '';
  const m = props.v.match(/^.*…（共 (\d+) 字符）$/s);
  return m ? m[1] : '';
});

const primitive = computed(() => {
  const val = props.v;
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  // 超深嵌套兜底：压成一行 JSON，长度再截一刀
  try {
    const s = JSON.stringify(val) ?? String(val);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return String(val);
  }
});
</script>

<style scoped>
.apv { font-size: 12px; line-height: 1.7; color: #303133; min-width: 0; }
.apv-root { max-width: 100%; }
.apv-nested { padding-left: 14px; border-left: 1px dashed #e4e7ed; min-width: 0; }
.apv-group { min-width: 0; }
.apv-leaf { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; min-width: 0; }
.apv-head { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.apv-body { min-width: 0; }
.apv-k {
  font-family: ui-monospace, Consolas, monospace;
  color: #1a73e8; font-weight: 600; flex: none;
}
.apv-v {
  font-family: ui-monospace, Consolas, monospace;
  word-break: break-all; white-space: pre-wrap; max-width: 100%;
}
.apv-null { color: #a8abb2; font-style: italic; }
.apv-hint { color: #a8abb2; }
.apv-empty { color: #a8abb2; }
.apv-fold { flex: none; }
.apv-block { margin-bottom: 2px; min-width: 0; }
.apv-keys { display: flex; gap: 4px; flex-wrap: wrap; padding-left: 14px; }
</style>
