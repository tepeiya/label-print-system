// =============================================================================
// useCommit.ts —— 检查器「聚焦留快照 / 失焦或回车才入历史」的组合式版
//   原生 inspector.js 用 beginEdit/endEdit + store.suspend 实现同一件事：
//   连续敲字不能产生几十条 undo，但一次编辑结束必须是一条可以撤销的记录。
// =============================================================================

import type { InjectionKey } from 'vue';

export interface CommitApi {
  /** 控件聚焦时调用：留下一份当前模板快照 */
  begin(): void;
  /** 控件 change / blur 时调用：有快照才入历史 */
  end(): void;
}

export const COMMIT_KEY: InjectionKey<CommitApi> = Symbol('designer-commit');

/** 什么都不做的兜底（面板被单独使用时不至于报错） */
export const NO_COMMIT: CommitApi = { begin() {}, end() {} };
