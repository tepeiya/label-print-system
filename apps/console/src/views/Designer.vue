<template>
  <div>
    <div class="page-header"><h2>✏️ 标签设计器</h2></div>
    <el-alert type="warning" :closable="false" style="margin-bottom: 12px;">
      设计器当前以 iframe 方式嵌入原生 HTML5 版本（位于 /web 目录），SaaS 架构稿 §11.10 的方案。
      后续将把 render.js / interactions.js / store.js Vue 化后替换此 iframe。
    </el-alert>
    <iframe class="designer-iframe" :src="designerUrl" title="LabelFlow Designer" />
  </div>
</template>

<script setup lang="ts">
// 现有 web/ 目录由 serve.mjs 在 backend 同端口提供
// 开发时直接访问 /designer.html（NestJS 静态资源托管已配置）
const designerUrl = '/designer.html';
</script>
