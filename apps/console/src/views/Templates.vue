<template>
  <div>
    <div class="page-header"><h2>📐 模板库</h2></div>
    <el-alert type="info" :closable="false" style="margin-bottom: 16px;">
      模板管理已迁移到标签设计器中，点击顶部「标签设计器」进入完整的设计与版本管理界面。
    </el-alert>
    <div class="card">
      <p>模板的创建、编辑、版本管理、缩略图预览、导入/导出请在设计器中完成。</p>
      <!-- 设计器要 templates 模块 + template:write：模块由路由 meta 拦（4031 → /blocked），
           这里只管权限点。两个指令别叠在同一个元素上——它们都改 el 的 disabled，
           后执行的那个会把前一个的结论覆盖掉。 -->
      <el-button type="primary" v-permission="'template:write'" @click="$router.push('/designer')">前往设计器</el-button>
    </div>
  </div>
</template>
