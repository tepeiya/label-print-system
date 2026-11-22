<template>
  <div class="login-page">
    <div class="login-brand">
      <div class="logo">📦</div>
      <div class="name">WMS 收货作业</div>
      <div class="sub">仓库现场扫码 · 移动作业端</div>
    </div>
    <div class="card">
      <div class="field">
        <label for="u">账号</label>
        <input id="u" v-model.trim="username" autocomplete="username" placeholder="请输入账号" @keyup.enter="submit" />
      </div>
      <div class="field">
        <label for="p">密码</label>
        <input id="p" v-model="password" type="password" autocomplete="current-password" placeholder="请输入密码" @keyup.enter="submit" />
      </div>
      <div class="field">
        <label for="t">租户编码（可留空）</label>
        <input id="t" v-model.trim="tenantCode" placeholder="默认租户" />
      </div>
      <div v-if="err" class="notice err">{{ err }}</div>
      <button class="btn primary wide big" :disabled="loading" @click="submit">
        {{ loading ? '登录中…' : '登 录' }}
      </button>
    </div>
    <div class="hint">与控制台同一套账号；首次登录后请妥善保管凭据。</div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/store/auth';
import { errorMessage } from '@/api';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const username = ref('');
const password = ref('');
const tenantCode = ref('');
const loading = ref(false);
const err = ref('');

async function submit() {
  if (!username.value || !password.value) {
    err.value = '请输入账号和密码';
    return;
  }
  loading.value = true;
  err.value = '';
  try {
    await auth.login(username.value, password.value, tenantCode.value || undefined);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    router.replace(redirect);
  } catch (e) {
    err.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-page { min-height: 100%; padding: 12vh 20px 30px; max-width: 460px; margin: 0 auto; }
.login-brand { text-align: center; margin-bottom: 32px; }
.login-brand .logo { font-size: 56px; }
.login-brand .name { font-size: 24px; font-weight: 800; margin-top: 8px; letter-spacing: 1px; }
.login-brand .sub { color: var(--text-dim); font-size: 14px; margin-top: 6px; }
.hint { text-align: center; color: var(--text-dim); font-size: 12px; margin-top: 20px; }
</style>
