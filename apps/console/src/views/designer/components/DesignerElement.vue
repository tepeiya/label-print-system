<template>
  <div
    class="lf-el"
    :class="[`el-${el.type}`, { locked: !!el.locked, 'hidden-el': el.visible === false }]"
    :data-id="el.id"
    :data-kind="el.type === 'text' ? undefined : el.type"
    :data-warn="barcodeWarn"
    :title="el.name"
    :style="rootStyle"
  >
    <!-- 直线：任意角度用 SVG，端点/dash 计算与原生版同一口径 -->
    <svg
      v-if="el.type === 'line'"
      width="100%"
      height="100%"
      style="overflow: visible; display: block"
    >
      <line
        :x1="lineGeom.x1"
        :y1="lineGeom.y1"
        :x2="lineGeom.x2"
        :y2="lineGeom.y2"
        :stroke="el.stroke?.color || '#333'"
        :stroke-width="lineGeom.sw"
        stroke-linecap="round"
        :stroke-dasharray="lineGeom.dash"
      />
    </svg>

    <!-- 表格：grid 单元格 -->
    <template v-else-if="el.type === 'table'">
      <div v-for="cell in tableCells" :key="cell.idx" :style="cell.style">
        <span
          v-for="(part, i) in cell.parts"
          :key="i"
          :class="part.placeholder ? 'ph' : undefined"
          :title="part.placeholder ? part.text : undefined"
        >{{ part.resolved }}</span>
      </div>
    </template>

    <!-- 图片 -->
    <template v-else-if="el.type === 'image'">
      <img v-if="el.src" class="el-img" :src="el.src" alt="" draggable="false">
      <div v-else class="img-ph">🖼<span>未设置图片<br>右侧属性面板粘贴 data URL</span></div>
    </template>

    <!-- 一维码：SVG 拉伸填满 + 可选明文（顺序由 textPosition 决定） -->
    <template v-else-if="el.type === 'barcode'">
      <div class="bc-svg" v-html="barcodeHtml" />
      <div v-if="el.barcode?.showText" class="bc-text" :style="bcTextStyle">{{ barcodeContent }}</div>
    </template>

    <!-- 二维码 / 矩阵码：等比居中 + 静区 -->
    <template v-else-if="el.type === 'qrcode'">
      <div class="qr-holder" :style="qrHolderStyle" v-html="qrHtml" />
    </template>

    <!-- 文本 / 公式 / 流水号 / 日期 / 系统变量 -->
    <div v-else class="el-text-inner" :style="textInnerStyle">
      <template v-for="(part, i) in textParts" :key="i">
        <span v-if="part.placeholder" class="ph" :title="part.text">{{ part.resolved }}</span>
        <span v-else>{{ part.text }}</span>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
// =============================================================================
// DesignerElement.vue —— 单元素设计态渲染（render.js#renderElement 的声明式版）
//   只管「长什么样」；选中、拖动、缩放手柄在 DesignerOverlay + useGestures。
//   类名 / data-* 是手势层契约：.lf-el、data-id 不能改名。
//   位置尺寸全部由 engine/styles.ts 按 mm × 96/25.4 × zoom 换算，
//   与原生画布、打印 HTML 共用同一份口径，否则同模板三种画面会对不齐。
// =============================================================================
import { computed } from 'vue';
import type { CSSProperties } from 'vue';
import type { ElementData } from '../types';
import {
  barcodeStyle, boxStyle, ellipseStyle, lineBoxStyle, qrcodeStyle, rectStyle,
  tableCellStyle, tableStyle, textStyle, textStyleInner,
} from '../engine/styles';
import { elementText, interpolate, splitPlaceholders, type RenderContext } from '../engine/context';
import { containSvg, makeBarcodeSvg, makeQrSvg, stretchSvg } from '../engine/barcode';
import { MM2PX } from '../engine/util';

const props = defineProps<{
  el: ElementData;
  zoom: number;
  ctx: RenderContext;
}>();

/** 盒子 + 类型外观合并成一份 style（原生版是分两条语句写 DOM，这里等价） */
const rootStyle = computed<CSSProperties>(() => {
  const el = props.el;
  const z = props.zoom;
  const base = el.type === 'line' ? lineBoxStyle(el, z) : boxStyle(el, z);
  switch (el.type) {
    case 'rect': return { ...base, ...rectStyle(el, z) };
    case 'ellipse': return { ...base, ...ellipseStyle(el, z) };
    case 'table': return { ...base, ...tableStyle(el, z) };
    case 'barcode': return { ...base, ...barcodeStyle(el) };
    case 'image': return el.src ? base : {
      ...base,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: '1px dashed #b9c4d4',
      background: '#f7f9fc',
      color: '#8a94a6',
      fontSize: `${9 * z}px`,
      textAlign: 'center',
    };
    case 'text':
    case 'formula':
    case 'serial':
    case 'datetime':
    case 'sysvar': return { ...base, ...textStyle(el) };
    default: return base;
  }
});

const lineGeom = computed(() => {
  const el = props.el;
  const dx = (el.x2 ?? el.x) - el.x;
  const dy = (el.y2 ?? el.y) - el.y;
  const w = Math.max(Math.abs(dx), 0.3) * MM2PX * props.zoom;
  const h = Math.max(Math.abs(dy), 0.3) * MM2PX * props.zoom;
  const sw = Math.max(0.6, (el.stroke?.width ?? 0.3) * MM2PX * props.zoom);
  const style = el.stroke?.style;
  return {
    x1: dx < 0 ? w : 0,
    y1: dy < 0 ? h : 0,
    x2: dx < 0 ? 0 : w,
    y2: dy < 0 ? 0 : h,
    sw,
    dash: style === 'dashed' ? `${sw * 4} ${sw * 3}` : style === 'dotted' ? `${sw} ${sw * 2}` : undefined,
  };
});

const textParts = computed(() => {
  const el = props.el;
  if (el.type === 'text') return splitPlaceholders(el.text, props.ctx);
  const shown = elementText(el, props.ctx);
  return [{ text: shown, placeholder: false, resolved: shown }];
});

const textInnerStyle = computed<CSSProperties>(() => ({
  ...textStyleInner(props.el, props.zoom),
  // 公式取不到值时原生版会显示 #公式错误，这里同一兜底
  color: props.el.type === 'formula' && elementText(props.el, props.ctx) === '#公式错误'
    ? '#c0392b'
    : undefined,
}));

const tableCells = computed(() => {
  const el = props.el;
  const rows = Math.max(1, el.rows || 1);
  const cols = Math.max(1, el.cols || 1);
  const out: Array<{ idx: number; style: CSSProperties; parts: ReturnType<typeof splitPlaceholders> }> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      out.push({
        idx,
        style: tableCellStyle(el, r, c, rows, cols, props.zoom),
        parts: splitPlaceholders(el.cells?.[idx] ?? '', props.ctx),
      });
    }
  }
  return out;
});

const barcodeContent = computed(() => interpolate(props.el.barcode?.content ?? '', props.ctx));
const barcodeResult = computed(() => makeBarcodeSvg(props.el.barcode, barcodeContent.value));
const barcodeHtml = computed(() => stretchSvg(barcodeResult.value.svgStr));

/** 条码画不下时透出提示（原生版写在 data-warn，状态栏读它） */
const barcodeWarn = computed(() => {
  const nat = barcodeResult.value.naturalWmm;
  return nat != null && nat > (props.el.w ?? 40) + 0.01
    ? `条码自然宽度 ${nat.toFixed(1)}mm > 元素宽度 ${props.el.w}mm`
    : undefined;
});

const bcTextStyle = computed<CSSProperties>(() => ({
  flex: '0 0 auto',
  textAlign: 'center',
  fontFamily: `${props.el.barcode?.textFont?.family || 'Arial'},sans-serif`,
  fontSize: `${(props.el.barcode?.textFont?.size ?? 2.6) * props.zoom}px`,
  lineHeight: '1.15',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
}));

const qrContent = computed(() => interpolate(props.el.qrcode?.content ?? '', props.ctx));
const qrHtml = computed(() => containSvg(makeQrSvg(props.el.qrcode, qrContent.value).svgStr));
const qrHolderStyle = computed(() => qrcodeStyle(props.el, props.zoom));
</script>
