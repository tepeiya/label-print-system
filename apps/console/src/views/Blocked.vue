<template>
  <div>
    <div class="page-header"><h2>🚫 无法访问</h2></div>
    <div class="card" style="max-width: 720px;">
      <template v-if="isModule">
        <el-alert type="warning" :closable="false" show-icon
          :title="`当前套餐未订阅「${moduleName}」模块`"
          :description="`该功能需要升级套餐或单独加购模块后才能使用（接口返回业务码 4031）。`" />
        <p style="margin: 16px 0 8px;">
          当前套餐：<b>{{ auth.tenant?.planName || auth.tenant?.plan || '—' }}</b>
          <span v-if="auth.tenant?.seatLimit"> · 座位 {{ auth.tenant.seatLimit }}</span>
        </p>
        <p style="color: #666;">
          已开通模块：{{ auth.modules.join('、') || '（无）' }}
        </p>
        <p style="color: #999; font-size: 13px;">
          加购由平台运营在后台完成（套餐外单模块加购已支持，来源标记为 <code>addon</code>）。
          请联系销售 / 平台管理员开通后，回到本页重新检查权限。
        </p>
      </template>
      <template v-else>
        <el-alert type="info" :closable="false" show-icon
          title="你的角色缺少所需权限"
          :description="`权限点 ${code} 未授予当前角色（接口返回业务码 4032），请联系租户管理员分配角色。`" />
        <p style="margin-top: 16px; color: #666;">
          当前角色：{{ auth.user?.roles?.join('、') || '—' }}
        </p>
      </template>

      <div style="display: flex; gap: 8px; margin-top: 20px;">
        <el-button @click="goBack">返回上一页</el-button>
        <el-button @click="recheck" :loading="rechecking">重新检查权限</el-button>
        <el-button type="primary" plain @click="router.push('/subscription')">查看我的订阅</el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 模块未订阅 / 权限不足的统一落地页（docs/11 §11.10「模块未订阅」）
// 由 router 守卫跳入：/blocked?kind=module|permission&code=xxx&from=/yyy
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/store/auth';
import { MODULE_LABELS } from '@/constants/modules';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const rechecking = ref(false);

const kind = computed(() => String(route.query.kind ?? 'permission'));
const code = computed(() => String(route.query.code ?? ''));
const isModule = computed(() => kind.value === 'module');
const from = computed(() => String(route.query.from ?? '/dashboard'));

/** 模块码 → 中文名：见 constants/modules.ts（只用于展示，不是菜单/权限来源） */
const moduleName = computed(() => MODULE_LABELS[code.value] ?? code.value ?? '该');

function goBack() { router.push(from.value || '/dashboard'); }

async function recheck() {
  rechecking.value = true;
  try {
    await auth.fetchMe();
    router.push(from.value || '/dashboard');
  } finally {
    rechecking.value = false;
  }
}
</script>
