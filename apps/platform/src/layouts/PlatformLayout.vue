<template>
  <div class="layout">
    <header class="layout-header">
      <div class="logo">🏢 LabelFlow 平台运营后台</div>
      <div class="right">
        <el-tag size="small" type="info" v-if="auth.user">scope=platform</el-tag>
        <el-dropdown trigger="click">
          <span class="user-trigger">
            {{ auth.displayName }}
            <el-icon><ArrowDown /></el-icon>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item disabled>账号：{{ auth.user?.username || '-' }}</el-dropdown-item>
              <el-dropdown-item disabled>角色：{{ auth.user?.role || '-' }}</el-dropdown-item>
              <el-dropdown-item divided @click="doLogout">退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </header>

    <div class="layout-body">
      <aside class="layout-sidebar">
        <!-- 左侧固定菜单：router 模式下 index 就是路径，高亮跟随 route.path -->
        <el-menu class="side-menu" :default-active="route.path" router :collapse="false">
          <el-menu-item v-for="m in menus" :key="m.path" :index="m.path">
            <el-icon><component :is="m.icon" /></el-icon>
            <span>{{ m.title }}</span>
          </el-menu-item>
        </el-menu>

        <!--
          「AI 助手」是悬浮组件不是页面，所以不放进 el-menu（否则会抢走高亮并触发 404 路由）。
          这里做成侧栏底部常驻入口：助手被右上角 × 关掉后，随时从这里调回来。
        -->
        <div v-if="aiMenu" class="side-assistant" title="打开/收起 AI 助手" @click="assistant.toggle()">
          <el-icon><component :is="aiMenu.icon" /></el-icon>
          <span>{{ aiMenu.title }}</span>
          <el-tag v-if="!assistant.open" size="small" type="success" effect="dark">打开</el-tag>
          <el-tag v-else size="small" type="info">已开</el-tag>
        </div>
      </aside>

      <main class="layout-main">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>

    <!-- 悬浮球 / 面板都在这个组件里，位置固定在右下角 -->
    <AiAssistant />
  </div>
</template>

<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/store/auth';
import { useAssistantStore } from '@/store/assistant';
import { PLATFORM_MENUS } from '@/router';
import AiAssistant from '@/components/AiAssistant.vue';

/**
 * 平台后台骨架：顶栏（身份 + 退出）+ 左侧固定菜单 + 内容区。
 * 菜单项来自 router 的 PLATFORM_MENUS（5 个页面），这里只负责渲染；
 * 不像 console 那样由后端 /auth/me.menus 驱动 —— 运营身份没有「订阅模块裁剪菜单」这一说。
 */
// 菜单只渲染页面项；带 action 的（AI 助手）单独渲染成侧栏底部按钮
const menus = PLATFORM_MENUS.filter((m) => !m.action);
const aiMenu = PLATFORM_MENUS.find((m) => m.action === 'assistant') ?? null;
const assistant = useAssistantStore();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

function doLogout() {
  // 平台侧没有 logout 接口（token 2h 自然过期），只清本地登录态
  auth.logout();
  router.push('/login');
}
</script>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.15s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.user-trigger {
  cursor: pointer; display: flex; align-items: center; gap: 4px;
  font-size: 14px; color: #303133;
}
.side-menu { height: auto; }
.side-assistant {
  display: flex; align-items: center; gap: 8px;
  margin: 4px 8px 12px; padding: 9px 12px; border-radius: 4px;
  color: #b8c4d9; font-size: 13px; cursor: pointer; user-select: none;
  background: rgba(255,255,255,0.04);
}
.side-assistant:hover { background: #0c2135; color: #fff; }
.side-assistant .el-tag { margin-left: auto; }
</style>
