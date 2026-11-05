<template>
  <div class="login-wrap">
    <div class="login-card">
      <h1>🏢 LabelFlow 平台运营</h1>
      <p class="subtitle">SaaS 运营后台 · 租户 / 套餐 / 用量 / 审计</p>
      <el-form :model="form" :rules="rules" ref="formRef" label-width="70px" @submit.prevent="submit">
        <el-form-item label="账号" prop="username">
          <el-input v-model="form.username" size="large" autocomplete="username" placeholder="平台运营账号" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input v-model="form.password" type="password" size="large" show-password placeholder="登录密码" />
        </el-form-item>
        <el-button type="primary" size="large" :loading="loading" style="width: 100%" @click="submit">
          登录
        </el-button>
      </el-form>
      <p class="tip">
        与租户 Console（apps/console）是两套身份：这里用 platform_users 账号登录，
        签发 scope=platform 的独立 token，有效期 2 小时。
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { useAuthStore } from '@/store/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const formRef = ref<FormInstance>();
const loading = ref(false);
const form = reactive({ username: '', password: '' });

const rules: FormRules = {
  username: [{ required: true, message: '请输入平台账号', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
};

async function submit() {
  if (!formRef.value) return;
  await formRef.value.validate();
  loading.value = true;
  try {
    await auth.login(form.username, form.password);
    ElMessage.success('登录成功');
    router.push((route.query.redirect as string) || '/tenants');
  } catch {
    // 账号密码错误的文案由 axios 拦截器统一弹（后端返回 401 + message）
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.tip {
  margin: 16px 0 0; font-size: 12px; color: #909399; line-height: 1.6;
}
</style>
