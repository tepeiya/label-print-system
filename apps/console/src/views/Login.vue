<template>
  <div class="lf-login">
    <!-- 左：品牌区 -->
    <aside class="lf-login-brand">
      <div class="lf-login-logo">
        <div class="lf-login-zmark">LF</div>
        <div>
          <div>{{ branding?.appName || 'LabelFlow' }}</div>
          <div style="font-size:12px;color:#94a3b8;font-weight:400;margin-top:2px;">标签设计 · 打印 · 仓储执行</div>
        </div>
      </div>

      <div>
        <h1 class="lf-login-headline">让每一张标签<br /><em>都可追溯、可交付</em></h1>
        <p class="lf-login-desc">
          UDI 合规标签、GS1 编码、装箱与库存、质量放行，一套系统贯穿从建模板到发货的全流程。
        </p>
        <div class="lf-login-points">
          <div class="lf-login-point"><span class="dot"></span><span>GS1 / UDI 编码校验与解码回读，打印失败当场拦</span></div>
          <div class="lf-login-point"><span class="dot"></span><span>多仓多库位实时库存，批次与效期全程留痕</span></div>
          <div class="lf-login-point"><span class="dot"></span><span>PDA 扫码作业，收货、上架、发料、装箱一张码到底</span></div>
        </div>
      </div>

      <div class="lf-login-foot">© LabelFlow · 医疗与制造标签打印平台</div>
    </aside>

    <!-- 右：表单 -->
    <main class="lf-login-panel">
      <div class="lf-login-form">
        <h2>登录</h2>
        <p class="lead">使用你的账号进入工作台</p>

        <el-alert v-if="branding?.loginNotice" class="lf-login-notice" type="info" :closable="false" show-icon>
          {{ branding.loginNotice }}
        </el-alert>

        <el-form :model="form" :rules="rules" ref="formRef" label-position="top" @submit.prevent="submit">
          <el-form-item label="租户" prop="tenantCode">
            <el-input v-model="form.tenantCode" placeholder="默认 default" size="large"
                      :disabled="!!branding" />
          </el-form-item>
          <el-form-item label="用户名" prop="username">
            <el-input v-model="form.username" size="large" autocomplete="username" placeholder="请输入用户名" />
          </el-form-item>
          <el-form-item label="密码" prop="password">
            <el-input v-model="form.password" type="password" size="large" show-password
                      placeholder="请输入密码" @keyup.enter="submit" />
          </el-form-item>
          <el-button type="primary" size="large" class="lf-login-submit" :loading="loading" @click="submit">
            登录
          </el-button>
        </el-form>

        <div class="lf-login-copy">
          遇到登录问题请联系系统管理员
        </div>
      </div>
    </main>
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
.lf-login-notice { margin: 0 0 16px; }
</style>
