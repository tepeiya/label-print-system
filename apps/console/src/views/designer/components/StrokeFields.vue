<template>
  <FGroup :title="title">
    <FRow>
      <FLabel text="线宽 (mm)" />
      <FNum :model-value="s.width ?? 0.3" :step="0.05" :min="0" @update:model-value="upd({ width: r2($event) })" />
      <FLabel text="线型" />
      <FSelect :model-value="s.style ?? 'solid'" :options="STYLE_OPTIONS" @update:model-value="upd({ style: $event })" />
    </FRow>
    <FRow>
      <FLabel text="颜色" />
      <FColor :model-value="s.color ?? '#333333'" @update:model-value="upd({ color: $event })" />
    </FRow>
  </FGroup>
</template>

<script setup lang="ts">
// 描边分组（inspector.js#strokeGroup）：line / rect / ellipse 共用
import { computed } from 'vue';
import { useDesignerStore } from '../store';
import { r2 } from '../engine/util';
import type { ElementData, StrokeSpec } from '../types';
import FColor from './fields/FColor.vue';
import FGroup from './fields/FGroup.vue';
import FLabel from './fields/FLabel.vue';
import FNum from './fields/FNum.vue';
import FRow from './fields/FRow.vue';
import FSelect from './fields/FSelect.vue';

const props = withDefaults(defineProps<{ el: ElementData; title?: string }>(), { title: '描边' });

const store = useDesignerStore();

const STYLE_OPTIONS: Array<[string, string]> = [['solid', '实线'], ['dashed', '虚线'], ['dotted', '点线']];

const s = computed<StrokeSpec>(() => props.el.stroke ?? { width: 0.3, color: '#333333', style: 'solid' });

function upd(patch: Partial<Record<keyof StrokeSpec, unknown>>) {
  store.updateElement(props.el.id, { stroke: { ...s.value, ...patch } as StrokeSpec });
}
</script>
