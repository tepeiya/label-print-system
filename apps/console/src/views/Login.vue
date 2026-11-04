<template>
  <div class="login-wrap">
    <div class="login-card">
      <h1>🏷️ LabelFlow</h1>
      <p class="subtitle">专业标签设计与打印系统</p>
      <el-form :model="form" :rules="rules" ref="formRef" label-width="70px" @submit.prevent="submit">
        <el-form-item label="租户" prop="tenantCode">
          <el-input v-model="form.tenantCode" placeholder="默认 default" size="large" />
        </el-form-item>
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" size="large" autocomplete="username" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input v-model="form.password" type="password" size="large" show-password />
        </el-form-item>
        <el-button type="primary" size="large" :loading="loading" style="width: 100%" @click="submit">登录</el-button>
      </el-form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '@/store/auth';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const formRef = ref<FormInstance>();
const loading = ref(false);
const form = reactive({ tenantCode: 'default', username: '', password: '' });
const rules: FormRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
};

async function submit() {
  if (!formRef.value) return;
  await formRef.value.validate();
  loading.value = true;
  try {
    await auth.login(form.username, form.password, form.tenantCode);
    ElMessage.success('登录成功');
    const redirect = (route.query.redirect as string) || '/dashboard';
    router.push(redirect);
  } catch {
    // axios 拦截器已弹错
  } finally {
    loading.value = false;
  }
}
</script>
