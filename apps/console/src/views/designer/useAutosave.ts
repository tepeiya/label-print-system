// =============================================================================
// useAutosave.ts —— 本地草稿（app.js#autosave / restoreAutosave）
//   目的只有一个：浏览器刷新或误关页面后回来还能接着改。真正的持久化在服务器，
//   保存成功时由 useTemplateIO 清掉这份草稿（store.markSaved 之后）。
//   400ms 防抖与原生版一致，避免拖动时每个 pointermove 都写一次 localStorage。
// =============================================================================

import { onBeforeUnmount, watch } from 'vue';
import { AUTOSAVE_KEY, useDesignerStore } from './store';

const DELAY = 400;

export function useAutosave() {
  const store = useDesignerStore();
  let timer = 0;

  function write() {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(store.template));
    } catch {
      /* 配额或隐私模式：草稿写不进去不影响编辑 */
    }
  }

  function flush() {
    clearTimeout(timer);
    timer = 0;
    write();
  }

  // 在 setup 里调用，watch 随组件卸载自动停止
  watch(() => store.template, () => {
    clearTimeout(timer);
    timer = setTimeout(write, DELAY);
  }, { deep: true });

  // 关页面（组件卸载）前把最后一段改动补上，别丢半秒的编辑
  onBeforeUnmount(() => {
    if (timer) flush();
  });

  return { flush, write };
}
