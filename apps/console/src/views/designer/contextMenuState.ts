// 右键菜单的轻量共享状态：useGestures（发）与 DesignerContextMenu（收）解耦，
// 避免两个组件/组合式函数互相 import 造成循环依赖。
import { ref } from 'vue';

export interface ContextMenuPayload {
  x: number;          // clientX（fixed 定位用）
  y: number;          // clientY
  targetId?: string;  // 命中的元素 id（空白右键时为 undefined）
}

export const contextMenuOpen = ref(false);
export const contextMenuPayload = ref<ContextMenuPayload>({ x: 0, y: 0 });

export function openContextMenu(p: ContextMenuPayload) {
  contextMenuPayload.value = p;
  contextMenuOpen.value = true;
}

export function closeContextMenu() {
  contextMenuOpen.value = false;
}
