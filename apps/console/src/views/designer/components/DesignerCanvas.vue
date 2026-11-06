<template>
  <div ref="areaRef" class="lf-area" :class="{ 'rulers-hidden': !store.rulersVisible }">
    <DesignerRulers :geo="geo" />

    <div
      ref="viewportRef"
      class="viewport"
      :style="{ cursor: cursorStyle || undefined }"
      :class="{ panning: panning }"
    >
      <div class="canvas-stage">
        <div
          ref="pageRef"
          data-page="1"
          class="page"
          :style="pageStyle"
        >
          <div class="page-elements">
            <DesignerElement
              v-for="el in store.sortedElements"
              :key="el.id"
              :el="el"
              :zoom="store.zoom"
              :ctx="ctx"
            />
          </div>
          <DesignerOverlay />
        </div>
      </div>
    </div>

    <DesignerStatusbar :cursor="cursorMm" />
  </div>
</template>

<script setup lang="ts">
// =============================================================================
// DesignerCanvas.vue —— 画布容器（app.js#renderCanvas 的声明式版）
//   结构照搬原生版：viewport（滚动）> canvas-stage（居中）> page（mm 换算的纸）
//   > page-elements（元素，overflow:hidden）+ page-overlay（选区，不裁切）。
//   手势由 useGestures 直接挂在这两个 ref 上，因此 ref 名字不能改。
// =============================================================================
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { CSSProperties } from 'vue';
import { useDesignerStore } from '../store';
import { useGestures } from '../useGestures';
import { buildContext, sampleRowOf } from '../engine/context';
import { MM2PX } from '../engine/util';
import DesignerElement from './DesignerElement.vue';
import DesignerOverlay from './DesignerOverlay.vue';
import DesignerRulers from './DesignerRulers.vue';
import DesignerStatusbar from './DesignerStatusbar.vue';

const store = useDesignerStore();

const areaRef = ref<HTMLElement | null>(null);
const viewportRef = ref<HTMLElement | null>(null);
const pageRef = ref<HTMLElement | null>(null);

const { cursorMm, cursorStyle, panning, startTextEditIfEditable } = useGestures({ viewport: viewportRef, page: pageRef });

/** Enter 键的就地编辑入口由 Designer.vue 通过模板 ref 调用 */
defineExpose({ startTextEditIfEditable });

const pageStyle = computed<CSSProperties>(() => ({
  width: `${store.page.widthMm * MM2PX * store.zoom}px`,
  height: `${store.page.heightMm * MM2PX * store.zoom}px`,
}));

/** 设计态预览：示例值 → 数据源第一行（有 rows 时由外部塞进 store） */
const ctx = computed(() => buildContext(store.template, sampleRowOf(store.template), {
  pageNo: 1, pageTotal: 1, serialNo: store.serialStart,
}));

// --------------------------- 标尺几何 ---------------------------
/** 页面左上角相对 .lf-area 的像素位置，标尺按它对齐 */
const geo = reactive({ left: 0, top: 0, width: 0, height: 0 });

function updateGeo() {
  const a = areaRef.value;
  const p = pageRef.value;
  if (!a || !p) return;
  const ar = a.getBoundingClientRect();
  const pr = p.getBoundingClientRect();
  geo.left = pr.left - ar.left;
  geo.top = pr.top - ar.top;
  geo.width = pr.width;
  geo.height = pr.height;
}

let raf = 0;
function scheduleGeo() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; updateGeo(); });
}

let ro: ResizeObserver | null = null;

onMounted(() => {
  updateGeo();
  viewportRef.value?.addEventListener('scroll', scheduleGeo, { passive: true });
  window.addEventListener('resize', scheduleGeo);
  if (typeof ResizeObserver !== 'undefined' && pageRef.value) {
    ro = new ResizeObserver(scheduleGeo);
    ro.observe(pageRef.value);
  }
});

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf);
  viewportRef.value?.removeEventListener('scroll', scheduleGeo);
  window.removeEventListener('resize', scheduleGeo);
  ro?.disconnect();
});

// 缩放、页面尺寸、元素增删都会改变页面在视口里的位置
watch(
  () => [store.zoom, store.page.widthMm, store.page.heightMm, store.template.elements.length],
  () => nextTick(scheduleGeo),
);
</script>
