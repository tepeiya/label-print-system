<template>
  <div class="insp-inner">
    <FGroup title="尺寸预设">
      <div class="preset-grid">
        <FBtn
          v-for="pr in PAGE_PRESETS"
          :key="pr.name"
          :class="{ active: isActivePreset(pr) }"
          @click="set({ widthMm: pr.w, heightMm: pr.h })"
        >{{ pr.name }}</FBtn>
      </div>
    </FGroup>

    <FGroup title="自定义尺寸">
      <FRow>
        <FField label="宽 (mm)">
          <FNum :model-value="p.widthMm" :step="1" :min="5" @update:model-value="set({ widthMm: Math.max(5, r2($event)) })" />
        </FField>
        <FField label="高 (mm)">
          <FNum :model-value="p.heightMm" :step="1" :min="5" @update:model-value="set({ heightMm: Math.max(5, r2($event)) })" />
        </FField>
      </FRow>
      <FRow>
        <FLabel text="分辨率" />
        <FSelect :model-value="p.dpi" :options="dpiOptions" @update:model-value="set({ dpi: Number($event) })" />
      </FRow>
      <FRow>
        <FLabel text="方向" />
        <FSelect :model-value="p.orientation ?? 0" :options="ORIENT_OPTIONS" @update:model-value="set({ orientation: Number($event) })" />
      </FRow>
      <FRow>
        <FLabel text="份数" />
        <FNum :model-value="p.copies ?? 1" :step="1" :min="1" @update:model-value="set({ copies: Math.max(1, Math.round($event)) })" />
      </FRow>
    </FGroup>

    <FGroup title="拼版 / 多联">
      <FRow>
        <FLabel text="列数" />
        <FNum :model-value="p.columns ?? 1" :step="1" :min="1" @update:model-value="set({ columns: Math.max(1, Math.round($event)) })" />
        <FLabel text="行数" />
        <FNum :model-value="p.rows ?? 1" :step="1" :min="1" @update:model-value="set({ rows: Math.max(1, Math.round($event)) })" />
      </FRow>
      <FRow>
        <FLabel text="列间距 mm" />
        <FNum :model-value="p.gapXMm ?? 2" :step="0.5" :min="0" @update:model-value="set({ gapXMm: r2($event) })" />
        <FLabel text="行间距 mm" />
        <FNum :model-value="p.gapYMm ?? 2" :step="0.5" :min="0" @update:model-value="set({ gapYMm: r2($event) })" />
      </FRow>
      <FRow>
        <FLabel text="页边距 mm" />
        <FNum :model-value="p.marginMm ?? 0" :step="0.5" :min="0" @update:model-value="set({ marginMm: r2($event) })" />
        <FCheck text="双面打印" :model-value="!!p.duplex" @update:model-value="set({ duplex: $event })" />
      </FRow>
    </FGroup>

    <FGroup title="介质与定位">
      <FRow>
        <FLabel text="介质类型" />
        <FSelect :model-value="p.mediaType ?? 'gap'" :options="mediaOptions" @update:model-value="set({ mediaType: $event })" />
      </FRow>
      <FRow>
        <FLabel text="间隙 mm" />
        <FNum :model-value="p.gapMm ?? 2" :step="0.5" :min="0" @update:model-value="set({ gapMm: r2($event) })" />
        <FLabel text="黑标 mm" />
        <FNum :model-value="p.blackMarkMm ?? 3" :step="0.5" :min="0" @update:model-value="set({ blackMarkMm: r2($event) })" />
      </FRow>
      <FRow>
        <FLabel text="X 偏移 mm" />
        <FNum :model-value="p.offsetXMm ?? 0" :step="0.1" @update:model-value="set({ offsetXMm: r2($event) })" />
        <FLabel text="Y 偏移 mm" />
        <FNum :model-value="p.offsetYMm ?? 0" :step="0.1" @update:model-value="set({ offsetYMm: r2($event) })" />
      </FRow>
      <FRow>
        <FLabel text="X 校准 mm" />
        <FNum :model-value="p.calibrateXMm ?? 0" :step="0.1" @update:model-value="set({ calibrateXMm: r2($event) })" />
        <FLabel text="Y 校准 mm" />
        <FNum :model-value="p.calibrateYMm ?? 0" :step="0.1" @update:model-value="set({ calibrateYMm: r2($event) })" />
      </FRow>
      <span class="f-hint">偏移/校准用于补偿打印机走纸与打印头误差；导出 ZPL/TSPL 时会一并写入</span>
    </FGroup>

    <FGroup title="参考线 / 标尺">
      <FRow>
        <FCheck text="标尺与参考线可见" :model-value="store.rulersVisible" @update:model-value="store.setRulersVisible($event)" />
      </FRow>
      <FRow>
        <FBtn @click="store.addGuide('y', p.heightMm / 2)">＋ 水平中线</FBtn>
        <FBtn @click="store.addGuide('x', p.widthMm / 2)">＋ 垂直中线</FBtn>
        <FBtn kind="danger" :disabled="!guides.length" @click="store.clearGuides()">清空</FBtn>
      </FRow>
      <div v-if="!guides.length" class="f-hint-block">还没有参考线：在标尺上按下并拖动即可创建</div>
      <FRow v-for="g in guides" :key="g.id" class="guide-row">
        <FLabel :text="`${g.axis === 'x' ? '垂直' : '水平'} ${g.pos} mm`" />
        <FBtn kind="danger" @click="store.removeGuide(g.id)">删除</FBtn>
      </FRow>
      <span class="f-hint">拖标尺可自由定位；拖动画布上的参考线可微调，双击删除；拖动元素时自动吸附</span>
    </FGroup>

    <FGroup title="打印信息">
      <div class="f-hint-block">
        画布物理尺寸 <b>{{ p.widthMm }} × {{ p.heightMm }} mm</b><br>
        打印像素 {{ printPx.w }} × {{ printPx.h }} px · {{ p.dpi }} dpi
      </div>
    </FGroup>
  </div>
</template>

<script setup lang="ts">
// =============================================================================
// PagePanel.vue —— 页面设置（inspector.js#pageView）
//   写页面走 setPageSilent（实时、不入历史），一次编辑收口由控件层的
//   commit.begin/end 负责；改完页面后 store 会 clamp 元素越界（同原生 setPage）。
// =============================================================================
import { computed, inject } from 'vue';
import { useDesignerStore } from '../store';
import { DPI_OPTIONS, MEDIA_TYPES, PAGE_PRESETS } from '../model';
import { r2 } from '../engine/util';
import type { PageSpec } from '../types';
import { COMMIT_KEY, NO_COMMIT } from '../useCommit';
import FBtn from './fields/FBtn.vue';
import FCheck from './fields/FCheck.vue';
import FField from './fields/FField.vue';
import FGroup from './fields/FGroup.vue';
import FLabel from './fields/FLabel.vue';
import FNum from './fields/FNum.vue';
import FRow from './fields/FRow.vue';
import FSelect from './fields/FSelect.vue';

const store = useDesignerStore();
const commit = inject(COMMIT_KEY, NO_COMMIT);

const ORIENT_OPTIONS: Array<[number, string]> = [
  [0, '纵向 0°'], [90, '横向 90°'], [180, '180°'], [270, '270°'],
];

const p = computed(() => store.page);
const guides = computed(() => p.value.guides ?? []);
const dpiOptions = computed(() => DPI_OPTIONS.map((d) => [d, `${d} dpi`] as [number, string]));
const mediaOptions = computed(() => MEDIA_TYPES.map((m) => [m.value, m.label] as [string, string]));

const printPx = computed(() => ({
  w: Math.round((p.value.widthMm * p.value.dpi) / 25.4),
  h: Math.round((p.value.heightMm * p.value.dpi) / 25.4),
}));

function isActivePreset(pr: { w: number; h: number }) {
  return Math.abs(p.value.widthMm - pr.w) < 0.01 && Math.abs(p.value.heightMm - pr.h) < 0.01;
}

/**
 * 页面属性写入。
 * setPageSilent 只改状态；越界元素由这里补一次 clamp —— 原生 setPage 是「入历史 + clamp」，
 * Vue 版历史改由 commit.begin/end 收口，所以 clamp 得自己调。
 */
function set(patch: Partial<PageSpec>) {
  commit.begin();
  store.setPageSilent(patch);
  store.clampElementsToPage();
}
</script>
