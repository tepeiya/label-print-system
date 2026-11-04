<template>
  <div class="layout">
    <header class="layout-header">
      <div class="logo">🏷️ LabelFlow Console</div>
      <el-menu mode="horizontal" :default-active="route.path" router class="nav">
        <!-- P1 动态菜单：树由后端 /auth/me.menus 下发（modules + permissions 裁剪），
             前端只负责渲染，不再维护菜单清单。带 children 的是分组。 -->
        <template v-for="m in navItems" :key="m.key">
          <el-sub-menu v-if="m.children.length" :index="m.key">
            <template #title>
              <el-icon v-if="m.icon"><component :is="m.icon" /></el-icon>
              <span>{{ m.name }}</span>
            </template>
            <el-menu-item v-for="c in m.children" :key="c.path" :index="c.path">
              <el-icon v-if="c.icon"><component :is="c.icon" /></el-icon>
              <span>{{ c.name }}</span>
            </el-menu-item>
          </el-sub-menu>
          <el-menu-item v-else :index="m.path">
            <el-icon v-if="m.icon"><component :is="m.icon" /></el-icon>
            <span>{{ m.name }}</span>
          </el-menu-item>
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
              <el-dropdown-item disabled v-if="auth.tenant?.seatLimit">
                席位上限：{{ auth.tenant.seatLimit }}
              </el-dropdown-item>
              <el-dropdown-item divided @click="router.push('/subscription')">
                🎫 我的订阅
              </el-dropdown-item>
              <el-dropdown-item @click="doLogout">退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </header>

    <!-- 到期 / 试用提醒横幅（docs/11 §11.10「到期横幅」）：只提示不拦截，
         拦截由 ModuleGuard 在接口层做，前端拿 4031 再跳 /blocked。 -->
    <el-alert
      v-if="banner"
      :type="banner.type"
      :closable="banner.dismissible"
      show-icon
      class="banner"
    >
      <template #title>
        {{ banner.text }}
        <el-link type="primary" :underline="false" class="banner-link" @click="router.push('/subscription')">
          查看我的订阅
        </el-link>
      </template>
    </el-alert>

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
import { apiLogout, apiSubscription } from '@/api';
import type { MenuNode } from '@/store/auth';

/** 渲染用的菜单节点：后端 MenuNode 的 children 是可选的，这里统一成必有数组 */
interface NavItem { key: string; name: string; icon?: string; path?: string; children: NavItem[] }

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

// ---- 订阅状态：异步加载，不阻塞首屏 ----
const sub = ref<{ status: string; endsAt: string | null; planName?: string; planCode?: string } | null>(null);

async function loadSubscription() {
  try {
    const res: any = await apiSubscription();
    sub.value = {
      status: res?.subscription?.status ?? '',
      endsAt: res?.subscription?.endsAt ?? null,
      planName: res?.plan?.name,
      planCode: res?.plan?.code,
    };
  } catch {
    // 404「该租户暂无有效订阅」/ 网络错误都不该把整顶栏搞坏
    sub.value = null;
  }
}
onMounted(loadSubscription);

const planCode = computed(() => auth.tenant?.plan ?? sub.value?.planCode ?? 'BASIC');
const planLabel = computed(() => auth.tenant?.planName ?? sub.value?.planName ?? planCode.value);
const planTagType = computed(() => {
  if (planCode.value === 'ENTERPRISE') return 'danger';
  if (planCode.value === 'PRO') return 'warning';
  return 'info';
});

/** 距到期天数；负数=已过期，null=未设置到期时间（永久/内部租户） */
function daysLeft(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86_400_000);
}

const banner = computed(() => {
  const status = sub.value?.status;
  const trialEnds = auth.tenant?.trialEndsAt ?? null;
  const endsAt = sub.value?.endsAt ?? null;
  const isTrial = status === 'trial' || !!trialEnds;
  const d = daysLeft(isTrial ? (trialEnds ?? endsAt) : endsAt);

  if (d !== null && d < 0) {
    return { type: 'error', dismissible: false, text: `${isTrial ? '试用' : '订阅'}已到期，模块将在接口层被拦截，请尽快续费。` };
  }
  if (isTrial && d !== null) {
    return {
      type: d <= 7 ? 'warning' : 'info',
      dismissible: d > 7,
      text: `试用期剩余 ${d} 天，到期后未订阅的模块将不可用。`,
    };
  }
  if (d !== null && d <= 15) {
    return { type: 'warning', dismissible: d > 7, text: `订阅将在 ${d} 天后到期，请及时续费。` };
  }
  return null;
});

// ---- 动态菜单 ----
function toNav(n: MenuNode): NavItem {
  return { key: n.key, name: n.name, icon: n.icon, path: n.path, children: (n.children || []).map(toNav) };
}

const navItems = computed<NavItem[]>(() => {
  if (auth.menus.length) return auth.menus.map(toNav);
  // 兜底：老 token / 后端未返回 menus 时退回路由表推导，避免升级过程中顶栏空白。
  // 正常情况下走不到这里——菜单的唯一来源是后端（docs/11 §11.4.6 禁止前端硬编码）。
  const children = router.options.routes.find((r) => r.path === '/')?.children || [];
  return children
    .filter((r) => r.path && auth.canAccess(r.meta as any))
    .map((r) => ({
      key: r.path as string,
      name: (r.meta?.title as string) || (r.path as string),
      icon: r.meta?.icon as string | undefined,
      path: `/${r.path}`,
      children: [],
    }));
});

const avatarUrl = computed(() => {
  const name = auth.displayName || 'U';
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=1a73e8&color=fff`;
});

async function doLogout() {
  // 后端把 refresh token 落库置 revoked；只清本地会留下一个还能换 access token 的凭证
  const rt = auth.refreshToken;
  auth.logout();
  if (rt) {
    try { await apiLogout(rt); } catch { /* 已登出，失败忽略 */ }
  }
  router.push('/login');
}
</script>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity 0.15s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.nav { flex: 1; border-bottom: none; background: transparent; }
.banner { border-radius: 0; }
.banner-link { margin-left: 8px; }
</style>
