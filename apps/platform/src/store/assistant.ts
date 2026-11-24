import { defineStore } from 'pinia';

/**
 * AI 助手悬浮球显隐状态（全局单例，layout 里的组件与菜单项共用）。
 *
 * 记忆点：关闭/打开状态写 localStorage，刷新后保持用户上次的选择；
 * 首次进平台（没有记录）默认展开 —— 让运营第一时间知道有这个入口。
 * 菜单里的「AI 助手」项负责在关闭后再打开（close 只关面板，不销毁数据）。
 */
const OPEN_KEY = 'labelflow_platform_ai_open';

export const useAssistantStore = defineStore('assistant', {
  state: () => ({
    open: localStorage.getItem(OPEN_KEY) !== '0',
    /** 未读提示：面板关着时后台有没有新回答（暂时只在面板内用） */
    unread: false,
  }),
  actions: {
    show() {
      this.open = true;
      this.unread = false;
      localStorage.setItem(OPEN_KEY, '1');
    },
    close() {
      this.open = false;
      localStorage.setItem(OPEN_KEY, '0');
    },
    toggle() {
      if (this.open) this.close();
      else this.show();
    },
  },
});
