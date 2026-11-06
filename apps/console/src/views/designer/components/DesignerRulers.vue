<template>
  <div v-show="store.rulersVisible" class="lf-rulers">
    <!-- 水平标尺：按下并向下拖 = 新建水平参考线 -->
    <div
      ref="rhRef"
      class="ruler ruler-h"
      title="在标尺上按下并向下拖动即可添加水平参考线"
      @pointerdown="startGuide('y', $event)"
    >
      <i
        v-for="t in hTicks"
        :key="t.key"
        class="tick"
        :class="{ major: t.major, 'page-end': t.end }"
        :style="t.style"
      />
      <span v-for="t in hLabels" :key="`l${t.key}`" class="ruler-num" :style="t.style">{{ t.mm }}</span>
    </div>

    <!-- 垂直标尺：按下并向右拖 = 新建垂直参考线 -->
    <div
      ref="rvRef"
      class="ruler ruler-v"
      title="在标尺上按下并向右拖动即可添加垂直参考线"
      @pointerdown="startGuide('x', $event)"
    >
      <i
        v-for="t in vTicks"
        :key="t.key"
        class="tick"
        :class="{ major: t.major, 'page-end': t.end }"
        :style="t.style"
      />
      <span v-for="t in vLabels" :key="`l${t.key}`" class="ruler-num" :style="t.style">{{ t.mm }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
// =============================================================================
// DesignerRulers.vue —— 标尺（guides.js#drawRulers 的声明式版）
//   刻度间隔按缩放自适应，页面末端画一条强调线；在标尺上按下并拖动即新建参考线。
//   geo 是页面左上角相对 .lf-area 的像素位置，由 DesignerCanvas 在
//   滚动 / 缩放 / 尺寸变化时刷新。
// =============================================================================
import { computed, ref } from 'vue';
import type { CSSProperties } from 'vue';
import { useDesignerStore } from '../store';
import { MM2PX, clamp, r2 } from '../engine/util';

interface PageGeo { left: number; top: number; width: number; height: number }

const props = defineProps<{ geo: PageGeo }>();

const store = useDesignerStore();
const RULER_H = 18;

interface Tick { key: string; style: CSSProperties; major: boolean; end: boolean }
interface Label { key: string; mm: number; style: CSSProperties }

const unit = () => MM2PX * store.zoom;

/** 与原生版同一档：小缩放时 20/10 一格，正常 5/1 一格，避免标签挤成一团 */
const steps = computed(() => {
  const z = store.zoom;
  return {
    major: z < 0.45 ? 20 : z < 0.8 ? 10 : 5,
    minor: z < 0.45 ? 10 : z < 0.8 ? 5 : 1,
  };
});

function build(horizontal: boolean): { ticks: Tick[]; labels: Label[] } {
  const page = store.page;
  const lenMm = horizontal ? page.widthMm : page.heightMm;
  // 垂直标尺从 18px 处起算（让开左上角）
  const startPx = horizontal ? props.geo.left : props.geo.top - RULER_H;
  const sizePx = horizontal ? props.geo.width : props.geo.height;
  const u = unit();
  const { major, minor } = steps.value;
  const ticks: Tick[] = [];
  const labels: Label[] = [];

  for (let mm = 0; mm <= Math.floor(lenMm); mm += minor) {
    if (mm % major !== 0 && mm % 5 !== 0 && minor > 1) continue;
    const isMajor = mm % major === 0;
    const p = startPx + mm * u;
    ticks.push({
      key: `${mm}`,
      major: isMajor,
      end: false,
      style: horizontal
        ? { left: `${p}px`, height: isMajor ? '9px' : '5px' }
        : { top: `${p}px`, width: isMajor ? '9px' : '5px' },
    });
    if (isMajor) {
      labels.push({
        key: `${mm}`,
        mm,
        style: horizontal
          ? { left: `${p + 2}px` }
          : { top: `${p + 1}px`, transform: 'rotate(-90deg)', transformOrigin: 'left top' },
      });
    }
  }

  ticks.push({
    key: 'end',
    major: false,
    end: true,
    style: horizontal
      ? { left: `${startPx + sizePx}px`, height: '11px' }
      : { top: `${startPx + sizePx}px`, width: '11px' },
  });

  return { ticks, labels };
}

const hBuilt = computed(() => build(true));
const vBuilt = computed(() => build(false));
const hTicks = computed(() => hBuilt.value.ticks);
const hLabels = computed(() => hBuilt.value.labels);
const vTicks = computed(() => vBuilt.value.ticks);
const vLabels = computed(() => vBuilt.value.labels);

// --------------------------- 标尺拖出新参考线 ---------------------------
const rhRef = ref<HTMLElement | null>(null);
const rvRef = ref<HTMLElement | null>(null);
/** 正在从标尺拖出的那根参考线 id（松手即清空） */
let newGuideId: string | null = null;

/** 指针位置 → 参考线 mm（相对 .lf-area 取页面原点，与 geo 同一基准） */
function posFromEvent(axis: 'x' | 'y', e: PointerEvent): number {
  const host = (axis === 'x' ? rvRef.value : rhRef.value)?.closest('.lf-area') as HTMLElement | null;
  const rect = host?.getBoundingClientRect();
  if (!rect) return 0;
  const u = unit();
  const raw = axis === 'x'
    ? (e.clientX - rect.left - props.geo.left) / u
    : (e.clientY - rect.top - props.geo.top) / u;
  const max = axis === 'x' ? store.page.widthMm : store.page.heightMm;
  return r2(clamp(raw, 0, max));
}

function startGuide(axis: 'x' | 'y', e: PointerEvent) {
  if (e.button !== 0 || !store.rulersVisible) return;
  e.preventDefault();
  // 先静默插入，松手时一次性入历史 —— 和原生 startRulerGuide 的 undo 粒度一致
  const before = store.snapshot();
  const id = store.addGuideSilent(axis, posFromEvent(axis, e));
  newGuideId = id;

  const move = (ev: PointerEvent) => {
    if (newGuideId) store.moveGuide(newGuideId, posFromEvent(axis, ev));
  };
  const up = () => {
    newGuideId = null;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    store.commitSnapshot(before);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
</script>
