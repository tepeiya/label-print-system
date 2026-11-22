<template>
  <el-dialog :model-value="modelValue" title="快捷键与使用技巧" width="680px" top="8vh" @update:model-value="emit('update:modelValue', $event)">
    <div class="sc-grid">
      <div v-for="g in GROUPS" :key="g.title" class="sc-group">
        <div class="sc-title">{{ g.title }}</div>
        <div v-for="row in g.rows" :key="row[0]" class="sc-row">
          <span class="sc-label">{{ row[0] }}</span>
          <span class="sc-keys">
            <kbd v-for="k in row[1].split(' / ')" :key="k">{{ k }}</kbd>
          </span>
        </div>
      </div>
    </div>
    <div class="sc-foot">
      <strong>鼠标技巧</strong>
      <span>左键点选 · Shift+点选 多选 · 拖空白处 框选 · 双击文本 直接改字 · 右键 快捷菜单 · 空格+拖动 平移 · Ctrl+滚轮 缩放</span>
    </div>
    <template #footer><el-button type="primary" @click="emit('update:modelValue', false)">知道了</el-button></template>
  </el-dialog>
</template>

<script setup lang="ts">
defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [boolean] }>();

// 与 useShortcuts.ts 逐条对齐；「/」表示等价键
const GROUPS: Array<{ title: string; rows: Array<[string, string]> }> = [
  {
    title: '编辑',
    rows: [
      ['撤销', 'Ctrl+Z'], ['重做', 'Ctrl+Y / Ctrl+Shift+Z'],
      ['复制选中', 'Ctrl+D'], ['复制', 'Ctrl+C'], ['粘贴', 'Ctrl+V'], ['剪切', 'Ctrl+X'],
      ['删除选中', 'Delete / Backspace'], ['编辑文字', 'Enter / 双击'],
    ],
  },
  {
    title: '选择',
    rows: [
      ['全选', 'Ctrl+A'], ['取消选择 / 关菜单', 'Esc'],
      ['多选', 'Shift+点选'], ['框选', '拖空白处'],
      ['组合', 'Ctrl+G'], ['取消组合', 'Ctrl+Shift+G'],
    ],
  },
  {
    title: '视图',
    rows: [
      ['缩放画布', 'Ctrl+滚轮'], ['平移画布', '空格+拖动 / 中键拖动'],
      ['微移元素 0.1mm', '方向键'], ['微移元素 1mm', 'Shift+方向键'],
      ['关闭吸附', '按住 Alt 拖动/缩放'],
    ],
  },
  {
    title: '文件',
    rows: [['保存模板', 'Ctrl+S']],
  },
];
</script>

<style scoped>
.sc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px; }
.sc-title { font-size: 13px; font-weight: 700; color: var(--d-accent-dark); margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid var(--d-line); }
.sc-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 26px; font-size: 12px; }
.sc-label { color: var(--d-text-2); }
.sc-keys { display: flex; gap: 3px; flex-wrap: wrap; justify-content: flex-end; }
.sc-keys kbd { font-family: inherit; font-size: 10.5px; padding: 2px 6px; border: 1px solid var(--d-line-strong); border-bottom-width: 2px; border-radius: 4px; background: var(--d-panel-soft); color: var(--d-text); white-space: nowrap; }
.sc-foot { margin-top: 16px; padding: 10px 12px; border-radius: 8px; background: var(--d-panel-soft); border: 1px solid var(--d-line); font-size: 12px; line-height: 1.7; }
.sc-foot strong { display: block; margin-bottom: 2px; }
.sc-foot span { color: var(--d-text-2); }
</style>
