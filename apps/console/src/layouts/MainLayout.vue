<template>
  <div class="layout">
    <header class="layout-header">
      <div class="logo">🏷️ LabelFlow Console</div>
      <el-menu mode="horizontal" :default-active="route.path" router style="flex:1; border-bottom: none; background: transparent;">
        <!-- 菜单项由 permissions 过滤 -->
        <template v-for="m in menuItems" :key="m.path">
          <el-menu-item :index="m.path">{{ m.title }}</el-menu-item>
        </template>
      </el-menu>
      <div class="right">
        <el-dropdown>
          <span style="cursor: pointer; display: flex; align-items: center; gap: 8px;">
            <el-avatar :size="32" :src="avatarUrl" />
            {{ auth.displayName }}
            <el-tag size="small" type="info" v-if="auth.isAdmin">admin</el-tag>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item disabled>租户：{{ auth.user?.tenantCode }}</el-dropdown-item>
              <el-dropdown-item divided @click="doLogout">退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </header>
    <main class="layout-body">
      <div class="layout-content">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/store/auth';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

// 基于路由 meta 动态生成菜单（过滤无权限项）
const menuItems = computed(() => {
  const children = router.options.routes.find((r) => r.path === '/')?.children || [];
  return children
    .filter((r) => r.path)
    .filter((r) => !r.meta?.permission || auth.hasPermission(r.meta.permission as string))
    .map((r) => ({ path: r.path as string, title: (r.meta?.title as string) || r.path }));
});

const avatarUrl = computed(() => {
  const name = auth.displayName || 'U';
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=1a73e8&color=fff`;
});

function doLogout() {
  auth.logout();
  router.push('/login');
}
</script>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.15s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
