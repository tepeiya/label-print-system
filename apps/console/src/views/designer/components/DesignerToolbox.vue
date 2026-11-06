<template>
  <aside class="toolbox">
    <template v-for="g in TOOLS" :key="g.group">
      <div class="tool-group-title">{{ g.group }}</div>
      <div class="tool-grid">
        <button
          v-for="it in g.items"
          :key="it.type"
          type="button"
          class="tool-btn"
          :title="`添加${it.label}`"
          @click="add(it.type)"
        >
          <span class="tool-ico">{{ it.icon }}</span>
          <span class="tool-label">{{ it.label }}</span>
        </button>
      </div>
    </template>
  </aside>
</template>

<script setup lang="ts">
// =============================================================================
// DesignerToolbox.vue —— 左侧元素库（app.js#renderToolbox + addElement）
//   落点语义照搬原生版：createElement 造默认尺寸，再居中到页面内（clamp 防越界），
//   新元素默认选中并把检查器切到「属性」页签。
// =============================================================================
import { useDesignerStore } from '../store';
import { TOOLS, createElement } from '../model';
import { clamp, r2 } from '../engine/util';
import type { ElementType } from '../types';

const store = useDesignerStore();
const emit = defineEmits<{ added: [] }>();

function add(type: ElementType) {
  const el = createElement(type, store.template);
  const p = store.page;
  el.x = r2(clamp(p.widthMm / 2 - el.w / 2, 0, Math.max(0, p.widthMm - el.w)));
  el.y = r2(clamp(p.heightMm / 2 - el.h / 2, 0, Math.max(0, p.heightMm - el.h)));
  store.addElement(el);
  emit('added');
}
</script>
