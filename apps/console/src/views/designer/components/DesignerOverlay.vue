<template>
  <div class="lf-overlay">
    <!-- 多选时的逐个虚线框 -->
    <div
      v-for="sub in subBoxes"
      :key="sub.id"
      class="sel-sub"
      :style="sub.style"
    />

    <!-- 选区外框 -->
    <div v-if="selBox" class="sel-box" :class="{ multi: isMulti }" :style="selBox" />

    <!-- 八向缩放手柄：单选中且未锁定时出现 -->
    <template v-if="showHandles">
      <div
        v-for="h in HANDLE_NAMES"
        :key="h"
        class="handle"
        :data-handle="h"
        :style="handleStyle(h)"
      />
      <div class="rot-handle" data-handle="rotate" :style="rotStyle" />
    </template>

    <!-- 参考线（拖动 data-guide-id 命中，双击删除） -->
    <div
      v-for="g in guides"
      :key="g.id"
      class="guide"
      :class="g.axis === 'x' ? 'guide-x' : 'guide-y'"
      :data-guide-id="g.id"
      :style="guideStyle(g)"
      :title="`${g.pos} mm（双击删除）`"
      @dblclick.stop="store.removeGuide(g.id)"
    />

    <!-- 拖动吸附线 -->
    <div v-for="(v, i) in snapV" :key="`v${i}`" class="snap-line snap-v" :style="{ left: `${v}px` }" />
    <div v-for="(h2, i) in snapH" :key="`h${i}`" class="snap-line snap-h" :style="{ top: `${h2}px` }" />

    <!-- 框选矩形 -->
    <div v-if="marqueeBox" class="marquee" :style="marqueeBox" />

    <!-- 双击文本 / 公式后的就地编辑框 -->
    <textarea
      v-if="editing"
      ref="editorRef"
      class="text-editor"
      :style="editorStyle"
      :value="editValue"
      spellcheck="false"
      @input="onEditInput"
      @keydown.esc.prevent="cancel"
      @keydown.enter.exact.prevent="commitEdit"
      @blur="commitEdit"
    />
  </div>
</template>

<script setup lang="ts">
// =============================================================================
// DesignerOverlay.vue —— 选区 / 手柄 / 参考线 / 吸附线 / 框选 / 就地编辑
//   对应原生 interactions.js#drawOverlay + guides.js#drawGuides + 就地 textarea。
//   手势本身在 useGestures（它靠 data-handle / data-guide-id / .lf-el 识别目标），
//   这里只负责把这些标记画到正确的位置上。
// =============================================================================
import { computed, nextTick, ref, watch } from 'vue';
import type { CSSProperties } from 'vue';
import { storeToRefs } from 'pinia';
import { useDesignerStore } from '../store';
import { HANDLE_NAMES } from '../useGestures';
import { elementBBox } from '../engine/geometry';
import { MM2PX } from '../engine/util';
import { textStyleInner } from '../engine/styles';
import type { Guide } from '../types';

const store = useDesignerStore();
const { zoom, snapLines, marquee, editingId } = storeToRefs(store);

const px = (mm: number) => mm * MM2PX * zoom.value;

const sel = computed(() => store.selectedElements);
const isMulti = computed(() => sel.value.length > 1);
const showHandles = computed(() => sel.value.length === 1 && !sel.value[0].locked);

const selBox = computed<CSSProperties | null>(() => {
  const b = store.selectionBox;
  if (!b) return null;
  return { left: `${px(b.x)}px`, top: `${px(b.y)}px`, width: `${px(b.w)}px`, height: `${px(b.h)}px` };
});

const subBoxes = computed(() => {
  if (!isMulti.value) return [];
  return sel.value.map((el) => {
    const b = elementBBox(el);
    return { id: el.id, style: {
      left: `${px(b.x)}px`, top: `${px(b.y)}px`, width: `${px(b.w)}px`, height: `${px(b.h)}px`,
    } as CSSProperties };
  });
});

function handleStyle(h: typeof HANDLE_NAMES[number]): CSSProperties {
  const b = store.selectionBox!;
  const x = px(b.x);
  const y = px(b.y);
  const w = px(b.w);
  const hh = px(b.h);
  const cx = x + w / 2;
  const cy = y + hh / 2;
  const pos: Record<string, [number, number]> = {
    nw: [x, y], n: [cx, y], ne: [x + w, y],
    e: [x + w, cy], se: [x + w, y + hh], s: [cx, y + hh],
    sw: [x, y + hh], w: [x, cy],
  };
  const p = pos[h];
  return { left: `${p[0]}px`, top: `${p[1]}px`, cursor: `${h}-resize` };
}

const rotStyle = computed<CSSProperties>(() => {
  const b = store.selectionBox!;
  return { left: `${px(b.x) + px(b.w) / 2}px`, top: `${px(b.y) - 22}px` };
});

const guides = computed<Guide[]>(() => store.page.guides ?? []);

function guideStyle(g: Guide): CSSProperties {
  return g.axis === 'x'
    ? { left: `${px(g.pos)}px`, top: '0', height: `${px(store.page.heightMm)}px` }
    : { top: `${px(g.pos)}px`, left: '0', width: `${px(store.page.widthMm)}px` };
}

const snapV = computed(() => snapLines.value.v.map(px));
const snapH = computed(() => snapLines.value.h.map(px));

const marqueeBox = computed<CSSProperties | null>(() => {
  if (!marquee.value) return null;
  const m = marquee.value;
  return { left: `${px(m.x)}px`, top: `${px(m.y)}px`, width: `${px(m.w)}px`, height: `${px(m.h)}px` };
});

// --------------------------- 就地文本编辑 ---------------------------
const editorRef = ref<HTMLTextAreaElement | null>(null);
const editValue = ref('');
const editingEl = computed(() => (editingId.value ? store.elementById(editingId.value) : undefined));
const editing = computed(() => !!editingEl.value);

/**
 * 编辑框的尺寸/字号跟元素本体一致（原生版是把 textarea 盖在节点上并 copy computed style），
 * 这里直接用同一套 styles.ts 换算，避免两套口径。padding 1px 2px、边框 1.5px 由 CSS 提供，
 * 所以位置要往外让出边框宽度，视觉上才不跳动。
 */
const editorStyle = computed<CSSProperties>(() => {
  const el = editingEl.value;
  if (!el) return {};
  return {
    left: `${px(el.x) - 1.5}px`,
    top: `${px(el.y) - 1.5}px`,
    width: `${px(el.w) + 3}px`,
    height: `${px(el.h) + 3}px`,
    ...textStyleInner(el, zoom.value),
    padding: '1px 2px',
  };
});

watch(editingId, (id) => {
  if (!id) return;
  const el = store.elementById(id);
  if (!el) return;
  editValue.value = el.type === 'text' ? String(el.text ?? '') : String(el.formula?.expr ?? '');
  nextTick(() => {
    const ta = editorRef.value;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
});

function onEditInput(e: Event) {
  editValue.value = (e.target as HTMLTextAreaElement).value;
}

function commitEdit() {
  if (!editingId.value) return;
  store.commitTextEdit(editingId.value, editValue.value, true);
}

function cancel() {
  if (!editingId.value) return;
  store.commitTextEdit(editingId.value, '', false);
}
</script>
