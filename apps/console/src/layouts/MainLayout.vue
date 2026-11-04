<template>
  <div class="layout">
    <header class="layout-header">
      <div class="logo">🏷️ LabelFlow Console</div>
      <el-menu mode="horizontal" :default-active="route.path" router style="flex:1; border-bottom: none; background: transparent;">
        <!-- 菜单项由 modules + permissions 双重过滤 -->
        <template v-for="m in menuItems" :key="m.path">
          <el-menu-item :index="m.path">{{ m.title }}</el-menu-item>
        </template>
      </el-menu>
      <div class="right">
        <el-dropdown trigger="click">
          <span style="cursor: pointer; display: flex; align-items: center; gap: 8px;">
            <el-avatar :size="32" :src="avatarUrl" />
            {{ auth.displayName }}
            <el-tag size="small" type="info" v-if="auth.isAdmin">admin</el-tag>
            <el-tag size="small" :type="planTagType">{{ planLabel }}</el-tag>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item disabled>租户：{{ auth.user?.tenantCode }}</el-dropdown-item>
              <el-dropdown-item divided @click="router.push('/subscription')">
                🎫 我的订阅
              </el-dropdown-item>
              <el-dropdown-item @click="doLogout">退出登录</el-dropdown-item>
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
import { computed, ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/store/auth';
import { apiSubscription } from '@/api';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

// 异步加载订阅状态（不阻塞启动）
const planCode = ref<string>('BASIC');
onMounted(async () => {
  try {
    const res: any = await apiSubscription();
    if (res?.plan?.code) planCode.value = res.plan.code;
  } catch { /* 忽略 */ }
});

const planLabel = computed(() => planCode.value);
const planTagType = computed(() => {
  if (planCode.value === 'ENTERPRISE') return 'danger';
  if (planCode.value === 'PRO') return 'warning';
  return 'info';
});

// SaaS P0：基于路由 meta 按 modules + permissions 双重过滤
const menuItems = computed(() => {
  const children = router.options.routes.find((r) => r.path === '/')?.children || [];
  return children
    .filter((r) => r.path)
    .filter((r) => auth.canAccess(r.meta as any))
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
