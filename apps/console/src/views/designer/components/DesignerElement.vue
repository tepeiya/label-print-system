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

    <!-- 富文本（第四层）：逐 run 样式 span，画布 v-html 预览 -->
    <div v-else-if="el.type === 'richtext'" class="el-text-inner" :style="textInnerStyle" v-html="richHtml" />

    <!-- DB 字段（第四层）：显示数据源/字段名占位，打印时按行取值 -->
    <div v-else-if="el.type === 'dbField'" class="el-text-inner" :style="textInnerStyle">
      <span class="db-field-tag" :title="dbFieldTip">{{ dbFieldLabel }}</span>
    </div>

    <!-- 图片：src 支持 {{变量}}，设计态用变量示例值预览 -->
    <template v-else-if="el.type === 'image'">
      <img v-if="imgSrc" class="el-img" :src="imgSrc" alt="" draggable="false">
      <div v-else class="img-ph">🖼<span>未设置图片<br>右侧属性面板粘贴 data URL</span></div>
    </template>

    <!-- 一维码：SVG 拉伸填满 + 可选明文（顺序由 textPosition 决定） -->
    <template v-else-if="el.type === 'barcode'">
      <div class="bc-svg" v-html="barcodeHtml" />
      <div v-if="el.barcode?.showText" class="bc-text" :style="bcTextStyle">{{ barcodeContent }}</div>
      <!-- 弧形条码画布无法真实弯曲，给角标说明；SVG 导出走弧线近似 -->
      <span v-if="el.curve?.enabled" class="el-arc-placeholder" title="弧形条码：导出 SVG 走弧线近似，画布为直线预览">弧形</span>
    </template>

    <!-- 二维码 / 矩阵码：等比居中 + 静区 -->
    <template v-else-if="el.type === 'qrcode'">
      <div class="qr-holder" :style="qrHolderStyle" v-html="qrHtml" :class="{ 'qr-holder--bad': !!qrError }" :title="qrError" />
      <!-- 编码失败时画布上必须看得见：占位灰块 + 一句原因，而不是静默变成一张空白 -->
      <div v-if="qrError" class="qr-error-tag">编码失败</div>
    </template>

    <!-- 弧形文字（第二层）：SVG textPath 真曲线预览，与矢量导出同口径 -->
    <svg
      v-else-if="isArcText"
      class="el-arc-text"
      :width="arcBox.w"
      :height="arcBox.h"
      :viewBox="`0 0 ${el.w} ${el.h}`"
    >
      <defs><path :id="arcPathId" :d="arcPathD" fill="none" /></defs>
      <text
        :font-family="el.font?.family || 'Arial'"
        :font-size="arcFontSize"
        :fill="arcColor"
        :font-weight="el.font?.bold ? 700 : 400"
        :font-style="el.font?.italic ? 'italic' : 'normal'"
      >
        <textPath :href="`#${arcPathId}`" :start-offset="arcOffset" :text-anchor="arcAnchor">{{ arcText }}</textPath>
      </text>
    </svg>

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
import { normalizeRuns, renderRunsHtml } from '../engine/rich-text';
import { containSvg, makeBarcodeSvg, makeQrSvg, stretchSvg } from '../engine/barcode';
import { MM2PX } from '../engine/util';

const props = defineProps<{
  el: ElementData;
  zoom: number;
  ctx: RenderContext;
  /** 整份模板元素：HRI 文本元素要靠它找到绑定的条码并取内容 */
  elements?: ElementData[];
}>();

/** 图片地址按数据上下文解析：绑定变量后画布仍显示示例图，不会裂图 */
const imgSrc = computed(() => interpolate(props.el.src ?? '', props.ctx));

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
    case 'image': return imgSrc.value ? base : {
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
    case 'richtext':
    case 'dbField':
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
  if (el.type === 'text') {
    // HRI 绑定：内容跟随目标条码（不显示占位高亮，因为它已不是手填的模板串）
    if (el.bindId && props.elements?.length) {
      const t = elementText(el, props.ctx, props.elements);
      return [{ text: t, placeholder: false, resolved: t }];
    }
    return splitPlaceholders(el.text, props.ctx);
  }
  if (el.type === 'dbField') {
    const shown = dbFieldLabel.value;
    return [{ text: shown, placeholder: false, resolved: shown }];
  }
  const shown = elementText(el, props.ctx);
  return [{ text: shown, placeholder: false, resolved: shown }];
});

/** 富文本画布预览：run 样式 span + 占位符插值（与打印态同口径） */
const richHtml = computed(() => {
  if (props.el.type !== 'richtext') return '';
  const runs = normalizeRuns(props.el.runs, props.el.text);
  const font = props.el.font ?? {};
  return renderRunsHtml(runs, font, {
    interp: (s: string) => interpolate(s, props.ctx),
    // 画布预览不转义：runs 文本来自模板编辑，占位符插值结果直接显示
    esc: (s: string) => s,
  });
});

/** DB 字段：画布显示 {{字段}} 占位（设计态无真实数据行，预览用字段别名） */
const dbFieldLabel = computed(() => {
  const f = props.el.dbField?.field ?? '';
  const resolved = interpolate(f, props.ctx);
  return resolved && resolved !== f ? resolved : (f || '{{字段}}');
});
const dbFieldTip = computed(() => {
  const d = props.el.dbField;
  return `数据源: ${d?.datasetId || '模板变量'}\n字段: ${d?.field || '(未设置)'}\n格式: ${d?.format || '原样'}`;
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
const qrResult = computed(() => makeQrSvg(props.el.qrcode, qrContent.value));
const qrError = computed(() => String(qrResult.value?.error ?? ''));
const qrHtml = computed(() => containSvg(qrResult.value.svgStr));
const qrHolderStyle = computed(() => qrcodeStyle(props.el, props.zoom));

// ---- 第二层：弧形文字预览（与后端 vector-renderer.arcTextSvg 同口径）----
const isArcText = computed(() =>
  !!props.el.curve?.enabled &&
  ['text', 'formula', 'serial', 'datetime', 'sysvar'].includes(props.el.type) &&
  !String(props.el.text ?? '').includes('\n'),
);
const arcBox = computed(() => ({
  w: props.el.w * MM2PX * props.zoom,
  h: props.el.h * MM2PX * props.zoom,
}));
const arcPathId = computed(() => `arc-prev-${props.el.id.replace(/[^\w-]/g, '')}`);
const arcPathD = computed(() => {
  const el = props.el;
  const w = el.w, h = el.h;
  const radius = Math.max(w / 2, el.curve?.radiusMm ?? w);
  const sweep = Math.max(10, Math.min(180, el.curve?.sweepDeg ?? 60));
  const up = (el.curve?.direction ?? 'up') !== 'down';
  const cx = w / 2, cy = up ? h + radius : -radius;
  const half = (sweep * Math.PI) / 360;
  const sign = up ? -1 : 1;
  const x1 = cx - radius * Math.sin(half), y1 = cy + sign * radius * Math.cos(half);
  const x2 = cx + radius * Math.sin(half);
  const flag = up ? 1 : 0;
  return `M ${x1.toFixed(3)} ${y1.toFixed(3)} A ${radius} ${radius} 0 0 ${flag} ${x2.toFixed(3)} ${y1.toFixed(3)}`;
});
const arcFontSize = computed(() => (props.el.font?.size ?? 10) * (96 / 72) * props.zoom);
const arcColor = computed(() => props.el.font?.color || '#000');
const arcAnchor = computed(() => props.el.font?.align === 'right' ? 'end' : props.el.font?.align === 'left' ? 'start' : 'middle');
const arcOffset = computed(() => props.el.font?.align === 'right' ? '100%' : props.el.font?.align === 'left' ? '0%' : '50%');
const arcText = computed(() => elementText(props.el, props.ctx));
</script>
