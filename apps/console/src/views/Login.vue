<template>
  <div class="login-wrap">
    <div class="login-card">
      <h1>
        <img v-if="branding?.logoUrl" :src="branding.logoUrl" class="logo" alt="" />
        <span v-if="!branding?.logoUrl">🏷️</span>
        {{ branding?.appName || 'LabelFlow' }}
      </h1>
      <!-- 命中已校验域名时副标题换成租户名；否则保持出厂文案 -->
      <p class="subtitle">{{ branding ? branding.tenantName : '专业标签设计与打印系统' }}</p>
      <el-alert v-if="branding?.loginNotice" class="notice" type="info" :closable="false" show-icon>
        <!-- 用插值而不是 v-html：后端虽已限长去尖括号，前端再留一层转义兜底 -->
        {{ branding.loginNotice }}
      </el-alert>
      <el-form :model="form" :rules="rules" ref="formRef" label-width="70px" @submit.prevent="submit">
        <el-form-item label="租户" prop="tenantCode">
          <!-- 白标（D6）：从客户自己的域名进来时租户由域名决定，输入框只展示不可改，
               免得在 A 家的登录页登进 B 家。平台自己的域名/本机访问仍然手输。 -->
          <el-input v-model="form.tenantCode" placeholder="默认 default" size="large"
                    :disabled="!!branding" />
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
import { reactive, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '@/store/auth';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { branding, brandingLoaded, loadBranding } from '@/composables/branding';

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

// main.ts 已经发过一次解析请求；这里兜一下直接进登录页（还没挂载完/解析失败）的场景，
// 命中就把租户码固定成域名所属租户。不阻塞渲染：老后端 404、DNS 不通时保持出厂登录页。
if (!brandingLoaded.value) void loadBranding();
watch(branding, (b) => { if (b?.tenantCode) form.tenantCode = b.tenantCode; }, { immediate: true });

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

<style scoped>
.logo { height: 28px; vertical-align: -6px; margin-right: 8px; }
.notice { margin: 0 0 12px; }
</style>
