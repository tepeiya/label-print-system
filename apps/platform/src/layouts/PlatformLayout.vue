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
      </aside>

      <main class="layout-main">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/store/auth';
import { PLATFORM_MENUS } from '@/router';

/**
 * 平台后台骨架：顶栏（身份 + 退出）+ 左侧固定菜单 + 内容区。
 * 菜单是静态的（4 个页面），不像 console 那样由后端 /auth/me.menus 驱动 ——
 * 运营身份没有「订阅模块裁剪菜单」这一说。
 */
const menus = PLATFORM_MENUS;
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
.side-menu { height: 100%; }
</style>
