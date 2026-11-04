// ============================================================================
// 按钮级权限指令（docs/11 §11.4.6 / §11.10「权限指令」）
//
//   v-permission="'template:write'"              单个权限点
//   v-permission="['ai:generate','template:write']"  数组 = OR，与后端
//                                                   @RequirePermission 语义一致
//   v-permission.hide="'audit:export'"           无权限时直接移除节点（默认只禁用）
//   v-module="'datasource'"                      按订阅模块控制
//
// ⚠️ 指令只是 UX。真正的拦截在后端守卫（4031 / 4032），前端隐藏不构成安全性。
// 通配权限（template:* / *）由 auth.hasPermission 负责，和后端 permission-match 同规则。
// ============================================================================
import type { App, Directive, DirectiveBinding } from 'vue';
import { useAuthStore } from '@/store/auth';

type Want = string | string[];

const toList = (v: Want): string[] => (Array.isArray(v) ? v : [v]).filter(Boolean);

/** OR 语义：命中其一即可；空声明视为不限制 */
function anyPermission(want: Want): boolean {
  const auth = useAuthStore();
  const list = toList(want);
  if (!list.length) return true;
  return list.some((p) => auth.hasPermission(p));
}

function anyModule(want: Want): boolean {
  const auth = useAuthStore();
  const list = toList(want);
  if (!list.length) return true;
  return list.some((m) => auth.hasModule(m));
}

/** 无权限时的处理：hide 修饰符移除节点，否则禁用并标记 data-denied 供样式使用 */
function apply(el: HTMLElement, allowed: boolean, modifiers: Partial<Record<string, boolean>>) {
  if (allowed) {
    el.removeAttribute('disabled');
    el.removeAttribute('data-denied');
    el.style.pointerEvents = '';
    el.style.opacity = '';
    return;
  }
  if (modifiers.hide) {
    // 移除后该节点不会再触发 updated；权限变更（重新登录 / fetchMe）会重建视图，可接受
    el.parentNode?.removeChild(el);
    return;
  }
  el.setAttribute('disabled', 'disabled');
  el.setAttribute('data-denied', 'true');
  el.style.pointerEvents = 'none';
  el.style.opacity = '0.55';
}

const vPermission: Directive<HTMLElement, Want> = {
  mounted(el, binding: DirectiveBinding<Want>) {
    apply(el, anyPermission(binding.value), binding.modifiers);
  },
  updated(el, binding: DirectiveBinding<Want>) {
    apply(el, anyPermission(binding.value), binding.modifiers);
  },
};

const vModule: Directive<HTMLElement, Want> = {
  mounted(el, binding: DirectiveBinding<Want>) {
    apply(el, anyModule(binding.value), binding.modifiers);
  },
  updated(el, binding: DirectiveBinding<Want>) {
    apply(el, anyModule(binding.value), binding.modifiers);
  },
};

export function registerPermissionDirectives(app: App) {
  app.directive('permission', vPermission);
  app.directive('module', vModule);
}
