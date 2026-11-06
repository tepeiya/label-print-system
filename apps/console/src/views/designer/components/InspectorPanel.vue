<template>
  <aside class="inspector">
    <nav class="inspector-tabs">
      <button
        v-for="t in TABS"
        :key="t.key"
        type="button"
        class="itab"
        :class="{ active: tab === t.key }"
        @click="pick(t.key)"
      >{{ t.label }}</button>
    </nav>
    <div class="inspector-body">
      <PropsPanel v-if="tab === 'properties'" />
      <PagePanel v-else-if="tab === 'page'" />
      <LayersPanel v-else-if="tab === 'layers'" />
      <VariablesPanel v-else />
    </div>
  </aside>
</template>

<script setup lang="ts">
// =============================================================================
// InspectorPanel.vue —— 右侧检查器容器（index.html#inspector + inspector.js 顶部）
//   这里同时是 COMMIT_KEY 的提供方：子面板里所有输入控件的
//   「focus 留快照 → input 实时改 → change/blur 入历史」都靠本组件收口，
//   所以连续敲一个字、拖一次滑块都只产生一条撤销记录。
//   切页签 / 换选中时把还没提交的快照补提交，避免半截编辑漏进历史。
// =============================================================================
import { provide, ref, watch } from 'vue';
import { useDesignerStore } from '../store';
import { COMMIT_KEY, type CommitApi } from '../useCommit';
import type { TemplateData } from '../types';
import PropsPanel from './PropsPanel.vue';
import PagePanel from './PagePanel.vue';
import LayersPanel from './LayersPanel.vue';
import VariablesPanel from './VariablesPanel.vue';

type TabKey = 'properties' | 'page' | 'layers' | 'variables';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'properties', label: '属性' },
  { key: 'page', label: '页面' },
  { key: 'layers', label: '图层' },
  { key: 'variables', label: '变量' },
];

const store = useDesignerStore();
const tab = ref<TabKey>('properties');

let snap: TemplateData | null = null;

function flush() {
  if (!snap) return;
  store.commitSnapshot(snap);
  snap = null;
}

provide<CommitApi>(COMMIT_KEY, {
  begin() {
    if (!snap) snap = store.snapshot();
  },
  end() {
    flush();
  },
});

function pick(t: TabKey) {
  flush();
  tab.value = t;
}

/** 父组件（Designer.vue）在新增元素 / 打开模板后把面板切回属性页 */
defineExpose({ selectTab: pick });

// 选中集变化会让子面板整块重渲染，原生版靠 blur 兜底，这里显式 flush
watch(() => store.selectedIds.join('|'), flush);
</script>
