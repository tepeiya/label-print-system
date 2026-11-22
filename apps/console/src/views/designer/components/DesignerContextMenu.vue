<template>
  <Teleport to="body">
    <div
      v-if="contextMenuOpen"
      ref="menuRef"
      class="ctx-menu"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
      @contextmenu.prevent
    >
      <template v-for="(item, i) in items" :key="item.key || `sep-${i}`">
        <div v-if="item.separator" class="ctx-sep"></div>
        <button
          v-else
          class="ctx-item"
          :class="{ danger: item.danger, disabled: item.disabled }"
          :disabled="item.disabled"
          @click="run(item)"
        >
          <span class="ctx-icon">{{ item.icon || '·' }}</span>
          <span class="ctx-label">{{ item.label }}</span>
          <span v-if="item.hint" class="ctx-hint">{{ item.hint }}</span>
        </button>
      </template>
      <div v-if="!items.length" class="ctx-empty">无可操作项</div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDesignerStore } from '../store';
import { TYPE_LABELS } from '../model';
import { closeContextMenu, contextMenuOpen, contextMenuPayload } from '../contextMenuState';
import type { ElementType } from '../types';

const emit = defineEmits<{ edit: []; properties: [] }>();

const store = useDesignerStore();
const menuRef = ref<HTMLElement | null>(null);

interface MenuItem {
  key: string;
  label: string;
  icon?: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  action?: () => void;
}

/** 就地编辑仅 text / formula 支持，其余走右侧属性面板 */
const INLINE_EDIT_TYPES: ElementType[] = ['text', 'formula'];

const pos = computed(() => {
  const p = contextMenuPayload.value;
  const el = menuRef.value;
  const w = el?.offsetWidth ?? 190;
  const h = el?.offsetHeight ?? 200;
  return {
    x: Math.max(4, Math.min(p.x, window.innerWidth - w - 4)),
    y: Math.max(4, Math.min(p.y, window.innerHeight - h - 4)),
  };
});

const selected = computed(() => store.selectedElements);
const multi = computed(() => selected.value.length > 1);

const items = computed<MenuItem[]>(() => {
  const p = contextMenuPayload.value;
  const target = p.targetId ? store.elementById(p.targetId) : undefined;
  const list: MenuItem[] = [];

  // ---- 空白区域：仅全局操作 ----
  if (!target) {
    list.push(
      { key: 'selectAll', label: '全选', icon: '▦', hint: 'Ctrl+A', action: () => store.selectAll() },
      { key: 'paste', label: '粘贴', icon: '📋', hint: 'Ctrl+V', disabled: !store.clipboard?.length, action: () => store.pasteClipboard() },
      { key: 'sep1', label: '', separator: true },
      { key: 'clear', label: '清空画布', icon: '🗑', danger: true, disabled: !store.template.elements.length, action: () => {
        if (window.confirm('确定清空画布上的全部元素？')) store.clearCanvas();
      } },
    );
    return list;
  }

  // 右键目标未在多选中 → 只选中它；已多选则保留多选
  const ids = selected.value.map((e) => e.id);
  if (!ids.includes(target.id)) store.select([target.id]);
  const targets = store.selectedElements;
  const one = targets.length === 1 ? targets[0] : undefined;
  const locked = targets.every((e) => e.locked);

  // ---- 编辑入口（按类型差异化）----
  if (one) {
    if (INLINE_EDIT_TYPES.includes(one.type)) {
      list.push({ key: 'edit', label: '编辑文字', icon: '✎', hint: '双击/Enter', disabled: !!one.locked, action: () => emit('edit') });
    }
    list.push({ key: 'props', label: `设置「${TYPE_LABELS[one.type] || one.type}」属性`, icon: '⚙', action: () => emit('properties') });
  } else {
    list.push({ key: 'props', label: `批量设置 ${targets.length} 个元素`, icon: '⚙', action: () => emit('properties') });
  }

  list.push(
    { key: 'sep1', label: '', separator: true },
    { key: 'copy', label: '复制', icon: '⧉', hint: 'Ctrl+D', action: () => store.duplicateSelected() },
    { key: 'cut', label: '剪切', icon: '✂', hint: 'Ctrl+X', action: () => store.cutSelection() },
  );

  // ---- 多选专属：对齐 / 分布 / 组合 ----
  if (multi.value) {
    list.push(
      { key: 'sep2', label: '', separator: true },
      { key: 'align-left', label: '左对齐', icon: '⇤', action: () => store.alignSelected('left') },
      { key: 'align-hcenter', label: '水平居中', icon: '↔', action: () => store.alignSelected('hcenter') },
      { key: 'align-right', label: '右对齐', icon: '⇥', action: () => store.alignSelected('right') },
      { key: 'align-top', label: '顶对齐', icon: '⇡', action: () => store.alignSelected('top') },
      { key: 'align-vcenter', label: '垂直居中', icon: '↕', action: () => store.alignSelected('vcenter') },
      { key: 'align-bottom', label: '底对齐', icon: '⇣', action: () => store.alignSelected('bottom') },
      { key: 'sep3', label: '', separator: true },
      { key: 'group', label: '组合', icon: '⊞', hint: 'Ctrl+G', action: () => store.groupSelected() },
      { key: 'ungroup', label: '取消组合', icon: '⊟', hint: 'Ctrl+Shift+G', action: () => store.ungroupSelected() },
    );
  }

  list.push(
    { key: 'sep4', label: '', separator: true },
    { key: 'front', label: '置于顶层', icon: '⬆', action: () => store.bringToFront() },
    { key: 'forward', label: '上移一层', icon: '↑', action: () => store.bringForward() },
    { key: 'backward', label: '下移一层', icon: '↓', action: () => store.sendBackward() },
    { key: 'back', label: '置于底层', icon: '⬇', action: () => store.sendToBack() },
    { key: 'sep5', label: '', separator: true },
    { key: 'lock', label: locked ? '解锁' : '锁定', icon: locked ? '🔓' : '🔒', action: () => toggleLock(targets, locked) },
    { key: 'delete', label: '删除', icon: '🗑', hint: 'Del', danger: true, action: () => store.removeElements() },
  );
  return list;
});

/** 锁定/解锁走 pushHistory + 批量改，保证可撤销 */
function toggleLock(targets: typeof store.selectedElements, locked: boolean) {
  if (!targets.length) return;
  store.pushHistory();
  store.updateSelected({ locked: !locked }, { history: false });
}

function run(item: MenuItem) {
  if (item.disabled) return;
  item.action?.();
  closeContextMenu();
}

function onDocPointerDown(e: PointerEvent) {
  if (!contextMenuOpen.value) return;
  if (menuRef.value?.contains(e.target as Node)) return;
  closeContextMenu();
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && contextMenuOpen.value) {
    e.stopImmediatePropagation();
    e.preventDefault();
    closeContextMenu();
  }
}

// 菜单尺寸影响防溢出定位，打开后重算一次
watch(() => contextMenuOpen.value, async (open) => {
  if (!open) return;
  await nextTick();
  void menuRef.value?.offsetWidth;
});

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown, true);
  window.addEventListener('keydown', onKeyDown, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  window.removeEventListener('keydown', onKeyDown, true);
});
</script>
