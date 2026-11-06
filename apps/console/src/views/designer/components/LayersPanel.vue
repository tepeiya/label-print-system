<template>
  <div class="insp-inner">
    <div class="layer-bar">
      <FBtn @click="addText">＋ 新建文本</FBtn>
      <FBtn kind="danger" :disabled="!store.elements.length" @click="clearCanvas">清空</FBtn>
    </div>

    <div v-if="!list.length" class="f-hint">画布上还没有元素</div>

    <div v-else class="layer-list">
      <div
        v-for="e in list"
        :key="e.id"
        class="layer-item"
        :class="{ active: store.selectedIds.includes(e.id), dimmed: e.visible === false }"
        @click="pick(e.id, $event)"
      >
        <span class="layer-icon">{{ TYPE_ICONS[e.type] }}</span>
        <span class="layer-name">{{ layerName(e) }}</span>
        <span
          class="layer-toggle"
          :title="e.visible === false ? '已隐藏，点击显示' : '点击隐藏'"
          @click.stop="toggleVisible(e)"
        >{{ e.visible === false ? '🚫' : '👁' }}</span>
        <span
          class="layer-toggle"
          :title="e.locked ? '已锁定，点击解锁' : '点击锁定'"
          @click.stop="toggleLocked(e)"
        >{{ e.locked ? '🔒' : '🔓' }}</span>
      </div>
    </div>

    <div class="layer-bar">
      <FBtn :disabled="!store.hasSelection" @click="store.bringToFront()">置顶</FBtn>
      <FBtn :disabled="!store.hasSelection" @click="store.bringForward()">上移</FBtn>
      <FBtn :disabled="!store.hasSelection" @click="store.sendBackward()">下移</FBtn>
      <FBtn :disabled="!store.hasSelection" @click="store.sendToBack()">置底</FBtn>
    </div>
  </div>
</template>

<script setup lang="ts">
// 图层面板（inspector.js#layersView）：倒序列表 + 显隐 / 锁定 / 层级
import { computed, inject } from 'vue';
import { ElMessageBox } from 'element-plus';
import { useDesignerStore } from '../store';
import { TYPE_ICONS, TYPE_LABELS, createElement } from '../model';
import { COMMIT_KEY, NO_COMMIT } from '../useCommit';
import type { ElementData } from '../types';
import FBtn from './fields/FBtn.vue';

const store = useDesignerStore();
const commit = inject(COMMIT_KEY, NO_COMMIT);

/** zIndex 倒序：最上面的元素排在列表最前，和 PS 的习惯一致 */
const list = computed(() => store.layerElements);

function layerName(e: ElementData) {
  return e.name || TYPE_LABELS[e.type] + (e.type === 'text' ? `：${String(e.text ?? '').slice(0, 14)}` : '');
}

function pick(id: string, ev: MouseEvent) {
  if (ev.shiftKey) store.toggleSelect(id);
  else store.select([id]);
}

/** 显隐/锁定属于「点一下就生效」的开关，用 begin/end 收口成一条历史 */
function toggleVisible(e: ElementData) {
  commit.begin();
  store.updateElement(e.id, { visible: e.visible === false });
  commit.end();
}

function toggleLocked(e: ElementData) {
  commit.begin();
  store.updateElement(e.id, { locked: !e.locked });
  commit.end();
}

function addText() {
  const el = createElement('text', store.template);
  const p = store.page;
  el.x = Math.max(0, (p.widthMm - el.w) / 2);
  el.y = Math.max(0, (p.heightMm - el.h) / 2);
  commit.begin();
  store.addElement(el);
  commit.end();
}

async function clearCanvas() {
  if (!store.elements.length) return;
  try {
    await ElMessageBox.confirm('确认清空画布上的所有元素？', '清空画布', {
      type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  store.clearCanvas();
}
</script>
