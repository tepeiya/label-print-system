// =============================================================================
// useShortcuts.ts —— 键盘快捷键（app.js#bindKeyboard 的 Console 版）
//   组合式的原因只有一个：原生版直接在 window 上挂 keydown，Vue 组件需要
//   在 onMounted/onBeforeUnmount 成对装卸，否则会随页面切换越挂越多。
//   在输入框里打字时全部让位（只保留 Esc 退出编辑），和原生版同一判断。
// =============================================================================

import { onBeforeUnmount, onMounted } from 'vue';
import { useDesignerStore } from './store';
import { r2 } from './engine/util';

export interface ShortcutHandlers {
  /** Ctrl/Cmd + S */
  onSave?: () => void;
  /** Enter：进入就地文本编辑（useGestures#startTextEditIfEditable） */
  onEdit?: () => void;
}

function isTyping(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  if (!t) return false;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable === true;
}

export function useShortcuts(handlers: ShortcutHandlers = {}) {
  const store = useDesignerStore();

  function onKeydown(e: KeyboardEvent) {
    if (isTyping(e.target)) {
      if (e.key === 'Escape') (e.target as HTMLElement).blur();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) store.redo(); else store.undo();
      return;
    }
    if (mod && key === 'y') { e.preventDefault(); store.redo(); return; }
    if (mod && key === 'a') { e.preventDefault(); store.selectAll(); return; }
    if (mod && key === 'd') { e.preventDefault(); store.duplicateSelected(); return; }
    if (mod && key === 'c') { e.preventDefault(); store.copySelection(); return; }
    if (mod && key === 'v') { e.preventDefault(); store.pasteClipboard(); return; }
    if (mod && key === 'x') { e.preventDefault(); store.copySelection(); store.removeElements(); return; }
    if (mod && key === 's') { e.preventDefault(); handlers.onSave?.(); return; }
    if (mod && key === 'g') {
      e.preventDefault();
      if (e.shiftKey) store.ungroupSelected(); else store.groupSelected();
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); store.removeElements(); return; }
    if (e.key === 'Escape') { store.clearSelection(); return; }
    if (e.key === 'Enter') { handlers.onEdit?.(); return; }

    const step = e.shiftKey ? 1 : 0.1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    if (dx || dy) {
      if (!store.hasSelection) return;
      e.preventDefault();
      store.pushHistory();
      for (const el of store.selectedElements) {
        el.x = r2(Math.max(0, el.x + dx));
        el.y = r2(Math.max(0, el.y + dy));
      }
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeydown));
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
}
