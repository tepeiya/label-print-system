// =============================================================================
// useElementVariable —— 「一键设为变量」的交互收口（按钮 / 右键菜单共用）
//   store 只返回结构化结果，提示文案统一放这里，避免两处漂移。
// =============================================================================

import { ElMessage } from 'element-plus';
import { useDesignerStore, type ElementVariableOutcome } from './store';

export function useElementVariable() {
  const store = useDesignerStore();

  function makeVariableFromElement(id?: string): ElementVariableOutcome {
    const res = store.createVariableFromElement(id);
    if (!res.ok) {
      ElMessage.warning(res.reason || '该元素没有可绑定的内容');
      return res;
    }

    if (!res.created) {
      ElMessage.success(`已绑定到现有变量「${res.name}」${res.slot ? `，绑定位置 ${res.slot}` : ''}`);
      return res;
    }

    let detail = '';
    if (res.slot === '图片地址') detail = '，图片地址已改为占位（预览沿用示例图）';
    else if (res.slot) detail = `，绑定位置 ${res.slot}`;
    ElMessage.success(`已创建变量「${res.name}」${detail}，可在「变量」页签改示例值`);
    return res;
  }

  return { makeVariableFromElement };
}
