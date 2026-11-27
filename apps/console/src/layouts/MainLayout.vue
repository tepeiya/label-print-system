<template>
  <div class="lf-shell">
    <!-- 左侧导航 -->
    <aside class="lf-sider">
      <div class="lf-brand">
        <div v-if="!branding?.logoUrl" class="lf-brand-mark">LF</div>
        <img v-else :src="branding.logoUrl" alt="" />
        <div class="lf-brand-text">
          <div class="lf-brand-name">{{ branding?.appName || 'LabelFlow' }}</div>
          <div class="lf-brand-sub">{{ branding?.tenantName || '标签与仓储管理' }}</div>
        </div>
      </div>

      <div class="lf-sider-nav">
        <el-menu :default-active="route.path" router unique-opened>
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
      </div>

      <div class="lf-sider-foot">
        <span>{{ versionLabel }}</span>
      </div>
    </aside>

    <!-- 右侧主区 -->
    <div class="lf-main">
      <header class="lf-topbar">
        <div class="lf-crumbs">
          <span>工作台</span>
          <span class="sep">/</span>
          <span class="cur">{{ currentTitle }}</span>
        </div>
        <div class="lf-topbar-right">
          <el-tag v-if="auth.isAdmin" size="small" type="info" effect="plain">管理员</el-tag>
          <el-tag size="small" effect="plain">{{ planLabel }}</el-tag>
          <el-dropdown trigger="click">
            <div class="lf-user-chip">
              <el-avatar :size="30" :src="avatarUrl" class="lf-avatar">{{ avatarText }}</el-avatar>
              <div>
                <div class="lf-user-name">{{ auth.displayName }}</div>
                <div class="lf-user-tenant">{{ auth.user?.tenantCode }}</div>
              </div>
            </div>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item disabled>租户：{{ auth.user?.tenantCode }}</el-dropdown-item>
                <el-dropdown-item disabled v-if="auth.tenant?.seatLimit">
                  席位上限：{{ auth.tenant.seatLimit }}
                </el-dropdown-item>
                <el-dropdown-item divided @click="router.push('/subscription')">我的订阅</el-dropdown-item>
                <el-dropdown-item @click="doLogout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <el-alert v-if="banner" :type="banner.type" :closable="banner.dismissible" show-icon class="lf-alert">
        <template #title>
          {{ banner.text }}
          <el-link type="primary" :underline="false" class="lf-alert-link" @click="router.push('/subscription')">
            查看我的订阅
          </el-link>
        </template>
      </el-alert>

      <main class="lf-content">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>

    <AiAssistant />
  </div>
</template>

<script setup lang="ts">
import AiAssistant from '@/components/AiAssistant.vue';
import { computed, ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/store/auth';
import { apiLogout, apiSubscription } from '@/api';
import { branding } from '@/composables/branding';
import type { MenuNode } from '@/store/auth';

interface NavItem { key: string; name: string; icon?: string; path?: string; children: NavItem[] }

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const versionLabel = 'LabelFlow · WMS';

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
    sub.value = null;
  }
}
onMounted(loadSubscription);

const planCode = computed(() => auth.tenant?.plan ?? sub.value?.planCode ?? 'BASIC');
const planLabel = computed(() => auth.tenant?.planName ?? sub.value?.planName ?? planCode.value);

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
    return { type: d <= 7 ? 'warning' : 'info', dismissible: d > 7, text: `试用期剩余 ${d} 天，到期后未订阅的模块将不可用。` };
  }
  if (d !== null && d <= 15) {
    return { type: 'warning', dismissible: d > 7, text: `订阅将在 ${d} 天后到期，请及时续费。` };
  }
  return null;
});

function toNav(n: MenuNode): NavItem {
  return { key: n.key, name: n.name, icon: n.icon, path: n.path, children: (n.children || []).map(toNav) };
}

const navItems = computed<NavItem[]>(() => {
  if (auth.menus.length) return auth.menus.map(toNav);
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

const currentTitle = computed(() => {
  const t = (route.meta?.title as string) || '';
  if (t) return t;
  for (const m of navItems.value) {
    if (m.path && route.path.startsWith(m.path)) return m.name;
    for (const c of m.children) if (c.path && route.path.startsWith(c.path)) return c.name;
  }
  return '';
});

const avatarText = computed(() => (auth.displayName || 'U').trim().slice(0, 1).toUpperCase());
const avatarUrl = computed(() => '');

async function doLogout() {
  const rt = auth.refreshToken;
  auth.logout();
  if (rt) {
    try { await apiLogout(rt); } catch { /* 已登出，失败忽略 */ }
  }
  router.push('/login');
}
</script>

<style scoped>
.lf-brand-text { min-width: 0; overflow: hidden; }
.lf-brand-text .lf-brand-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lf-avatar { background: linear-gradient(135deg, #3b82f6, #2563eb); color: #fff; font-weight: 600; font-size: 13px; flex: 0 0 auto; }
.lf-alert-link { margin-left: 8px; }
</style>
