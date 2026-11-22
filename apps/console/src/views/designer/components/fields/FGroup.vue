<template>
  <section class="f-group">
    <button
      v-if="title && collapsible"
      type="button"
      class="f-group-head"
      @click="toggle"
    >
      <span class="f-group-caret" :class="{ collapsed }">▾</span>
      <span class="f-group-title">{{ title }}</span>
      <span v-if="advanced" class="f-group-badge">高级</span>
    </button>
    <div v-else-if="title" class="f-group-title">{{ title }}</div>
    <div v-show="!collapsed || !collapsible"><slot /></div>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

const props = withDefaults(defineProps<{
  title?: string;
  collapsible?: boolean;
  advanced?: boolean;
  /** 折叠状态记忆键（同一 title 不同元素类型可用不同 key） */
  storeKey?: string;
  defaultCollapsed?: boolean;
}>(), { collapsible: false, advanced: false, defaultCollapsed: false });

const KEY_PREFIX = 'labelflow.groupCollapsed.';
const key = props.storeKey ? KEY_PREFIX + props.storeKey : '';
const stored = key ? localStorage.getItem(key) : null;
const collapsed = ref(stored === null ? props.defaultCollapsed : stored === '1');

function toggle() { collapsed.value = !collapsed.value; }

watch(collapsed, (v) => { if (key) localStorage.setItem(key, v ? '1' : '0'); });
</script>
