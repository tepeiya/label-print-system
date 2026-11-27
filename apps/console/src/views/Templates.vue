<template>
  <div>
    <div class="page-header"><h2>模板库</h2></div>
    <TemplateLibraryPanel @open="goDesigner" />
  </div>
</template>

<script setup lang="ts">
// =============================================================================
// Templates.vue —— 模板库（独立页面入口）
//   以往这里只是个「迁移到设计器」的提示页，菜单点进来看不到任何模板。
//   现直接挂载 TemplateLibraryPanel，与「标签设计器」里的模板库弹窗共用同一份
//   列表/版本逻辑，菜单点进来即可看到全部已保存的标签。
//   「打开」走路由跳到设计器并带上 ?id= 自动打开该模板。
// =============================================================================
import { useRouter } from 'vue-router';
import TemplateLibraryPanel from './designer/components/TemplateLibraryPanel.vue';
// 模板库面板用到的 .tpl-* 样式都定义在 designer.css（全局，原本由 Designer.vue 引入）。
// 这里单独引入，保证用户没进过设计器、直接访问「模板库」菜单页时样式也在。
import './designer/designer.css';

const router = useRouter();

function goDesigner(id: number) {
  router.push({ path: '/designer', query: { id } });
}
</script>
