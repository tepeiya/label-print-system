<template>
  <div class="lf-designer">
    <DesignerToolbar
      @library="openLibrary(null)"
      @versions="openLibrary(store.templateId)"
      @print="printVisible = true"
    />

    <div class="design-grid">
      <DesignerToolbox @added="focusProperties" />
      <DesignerCanvas ref="canvasRef" />
      <InspectorPanel ref="inspectorRef" />
    </div>

    <TemplateLibraryDialog
      v-model="libraryVisible"
      :version-target="libraryVersionTarget"
      @opened="onTemplateOpened"
    />
    <PrintPreviewDialog v-model="printVisible" />
  </div>
</template>

<script setup lang="ts">
// =============================================================================
// Designer.vue —— Vue 化设计器（替换原先 iframe 嵌 /web 的方案）
//   引擎、状态、手势全部搬进 Console：engine/* 是无框架纯函数，store 是 Pinia，
//   交互在 useGestures（仍然直接操作 DOM，因为拖拽要拿到真实节点），渲染声明式。
//   模板 JSON 与 web/ 原生设计器、后端打印端完全同一份，两边可以互开。
//   iframe 版 web/ 仍在 /web 提供，作为独立客户端保留。
// =============================================================================
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import DesignerToolbar from './designer/components/DesignerToolbar.vue';
import DesignerToolbox from './designer/components/DesignerToolbox.vue';
import DesignerCanvas from './designer/components/DesignerCanvas.vue';
import InspectorPanel from './designer/components/InspectorPanel.vue';
import TemplateLibraryDialog from './designer/components/TemplateLibraryDialog.vue';
import PrintPreviewDialog from './designer/components/PrintPreviewDialog.vue';
import { useDesignerStore } from './designer/store';
import { useTemplateIO } from './designer/useTemplateIO';
import { useShortcuts } from './designer/useShortcuts';
import { useAutosave } from './designer/useAutosave';
import './designer/designer.css';

const store = useDesignerStore();
const io = useTemplateIO();
const route = useRoute();

const canvasRef = ref<InstanceType<typeof DesignerCanvas> | null>(null);
const inspectorRef = ref<InstanceType<typeof InspectorPanel> | null>(null);

const libraryVisible = ref(false);
const libraryVersionTarget = ref<number | null>(null);
const printVisible = ref(false);

function openLibrary(versionTarget: number | null) {
  libraryVersionTarget.value = versionTarget;
  libraryVisible.value = true;
}

/** 工具箱加完元素就把检查器切回属性页，和原生 addElement 的行为一致 */
function focusProperties() {
  inspectorRef.value?.selectTab('properties');
}

function onTemplateOpened() {
  focusProperties();
}

useShortcuts({
  onSave: () => void io.save(),
  onEdit: () => canvasRef.value?.startTextEditIfEditable(),
});

// 本地草稿：刷新/误关页面后回来还能接着改
useAutosave();

// ?id=3 直接打开服务器模板（模板库列表、AI 生成页都按这个入口跳转）
onMounted(() => {
  const id = Number(route.query.id);
  if (Number.isFinite(id) && id > 0) void io.open(id);
});
</script>
