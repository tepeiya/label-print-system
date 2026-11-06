<template>
  <div v-if="paper" class="tpl-thumb">
    <div class="thumb-paper" :style="paperStyle">
      <DesignerElement
        v-for="el in visible"
        :key="el.id"
        :el="el"
        :zoom="scale"
        :ctx="ctx"
      />
    </div>
  </div>
  <span v-else class="thumb-none">—</span>
</template>

<script setup lang="ts">
// =============================================================================
// TemplateThumb.vue —— 模板缩略图（templates.js#thumbHtml）
//   和画布、打印共用同一套渲染，只是把 zoom 换成「塞进 64×44 框」的比例因子，
//   所以列表里看到的和真实标签是同一个形状，而不是手绘示意图。
// =============================================================================
import { computed } from 'vue';
import type { CSSProperties } from 'vue';
import DesignerElement from './DesignerElement.vue';
import { buildContext } from '../engine/context';
import { MM2PX } from '../engine/util';
import type { TemplateData } from '../types';

const props = defineProps<{ content?: TemplateData | null }>();

/** 与原生版同一框径：宽 64px、高 44px */
const BOX_W = 64;
const BOX_H = 44;

const scale = computed(() => {
  const p = props.content?.page;
  if (!p?.widthMm || !p?.heightMm) return 0;
  return Math.min(BOX_W / (p.widthMm * MM2PX), BOX_H / (p.heightMm * MM2PX));
});

const paper = computed(() => scale.value > 0);

const paperStyle = computed<CSSProperties>(() => {
  const p = props.content!.page;
  return {
    width: `${Math.round(p.widthMm * MM2PX * scale.value)}px`,
    height: `${Math.round(p.heightMm * MM2PX * scale.value)}px`,
  };
});

const visible = computed(() => (props.content?.elements ?? [])
  .filter((e) => e.visible !== false)
  .slice()
  .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0)));

/** 缩略图不带数据，占位符按空值求值，和原生 buildContext(content, {}) 一致 */
const ctx = computed(() => buildContext(props.content ?? ({} as TemplateData), {}));
</script>
