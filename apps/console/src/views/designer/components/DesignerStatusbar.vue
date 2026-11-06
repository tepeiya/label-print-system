<template>
  <div class="lf-statusbar">
    <span class="st-item">选中：<b>{{ selectionText }}</b></span>
    <span class="st-item">共 <b>{{ store.elements.length }}</b> 个元素</span>
    <span class="st-item">{{ store.page.widthMm }} × {{ store.page.heightMm }} mm · {{ store.page.dpi }} dpi</span>
    <span class="st-item">缩放 <b>{{ Math.round(store.zoom * 100) }}%</b></span>
    <span v-if="cursor" class="st-item st-cursor">{{ cursor.x.toFixed(1) }}, {{ cursor.y.toFixed(1) }} mm</span>
    <span v-if="store.dirty" class="st-item st-dirty" title="有未保存的修改">未保存</span>
    <span class="st-spacer" />
    <span v-if="store.templateId" class="st-item st-id">#{{ store.templateId }} v{{ templateVersion }}</span>
  </div>
</template>

<script setup lang="ts">
// 状态栏（app.js#renderStatus）：选中摘要 / 元素数 / 页面 / 缩放 / 光标 mm
import { computed } from 'vue';
import { useDesignerStore } from '../store';
import { TYPE_LABELS } from '../model';
import { r2 } from '../engine/util';

defineProps<{ cursor: { x: number; y: number } | null }>();

const store = useDesignerStore();

/** 版本号由保存流程回填（TemplateLibraryDialog 里更新），这里只展示 */
const templateVersion = computed(() => store.templateVersion ?? '—');

const selectionText = computed(() => {
  const sel = store.selectedElements;
  if (sel.length === 1) {
    const e = sel[0];
    return `${TYPE_LABELS[e.type]}  ${r2(e.w)} × ${r2(e.h)} mm  @ (${r2(e.x)}, ${r2(e.y)})`;
  }
  if (sel.length > 1) return `${sel.length} 个元素`;
  return '无';
});
</script>
