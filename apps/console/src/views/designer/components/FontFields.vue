<template>
  <FGroup title="字体样式">
    <FRow>
      <FLabel text="字体" />
      <FSelect :model-value="f.family ?? 'Arial'" :options="FONT_FAMILIES" @update:model-value="upd({ family: $event })" />
    </FRow>
    <FRow v-if="size">
      <FLabel text="字号 (pt)" />
      <FNum :model-value="f.size ?? 9" :step="0.5" :min="1" @update:model-value="upd({ size: r2($event) })" />
      <FLabel text="颜色" />
      <FColor :model-value="f.color ?? '#000000'" @update:model-value="upd({ color: $event })" />
    </FRow>
    <FRow v-else>
      <FLabel text="颜色" />
      <FColor :model-value="f.color ?? '#000000'" @update:model-value="upd({ color: $event })" />
    </FRow>
    <FRow v-if="weight">
      <FCheck text="粗体" :model-value="!!f.bold" @update:model-value="upd({ bold: $event })" />
      <FCheck text="斜体" :model-value="!!f.italic" @update:model-value="upd({ italic: $event })" />
      <FCheck text="下划线" :model-value="!!f.underline" @update:model-value="upd({ underline: $event })" />
    </FRow>
    <FRow v-if="align">
      <FLabel text="水平" />
      <FSelect :model-value="f.align ?? 'left'" :options="ALIGN_OPTIONS" @update:model-value="upd({ align: $event })" />
      <FLabel text="垂直" />
      <FSelect :model-value="f.vAlign ?? 'middle'" :options="VALIGN_OPTIONS" @update:model-value="upd({ vAlign: $event })" />
    </FRow>
  </FGroup>
</template>

<script setup lang="ts">
// 字体分组（inspector.js#fontGroup）：table 不要粗细、image 不显示——矩阵与原生版一致
import { computed } from 'vue';
import { useDesignerStore } from '../store';
import { FONT_FAMILIES } from '../model';
import { r2 } from '../engine/util';
import type { ElementData, FontSpec } from '../types';
import FCheck from './fields/FCheck.vue';
import FColor from './fields/FColor.vue';
import FGroup from './fields/FGroup.vue';
import FLabel from './fields/FLabel.vue';
import FNum from './fields/FNum.vue';
import FRow from './fields/FRow.vue';
import FSelect from './fields/FSelect.vue';

const props = withDefaults(defineProps<{
  el: ElementData;
  size?: boolean;
  weight?: boolean;
  align?: boolean;
}>(), { size: true, weight: true, align: true });

const store = useDesignerStore();

const ALIGN_OPTIONS: Array<[string, string]> = [['left', '左'], ['center', '中'], ['right', '右']];
const VALIGN_OPTIONS: Array<[string, string]> = [['top', '顶'], ['middle', '中'], ['bottom', '底']];

const f = computed<FontSpec>(() => props.el.font ?? {});

/** FSelect/FText 交回来的是 string，落库前按 FontSpec 归位（同原生版：不做类型体操） */
function upd(patch: Partial<Record<keyof FontSpec, unknown>>) {
  store.updateElement(props.el.id, { font: { ...f.value, ...patch } as FontSpec });
}
</script>
