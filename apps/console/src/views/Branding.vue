<template>
  <div v-loading="loading">
    <div class="page-header">
      <h2>🎨 品牌与域名</h2>
      <span style="color: #888; font-size: 13px;">白标：改的是登录页与外壳对外的长相，不影响任何数据权限</span>
    </div>

    <el-row :gutter="16">
      <el-col :span="12">
        <el-card shadow="never">
          <template #header><span>品牌外观</span></template>
          <!-- 页面本身由路由守卫按 meta.permission=sys:branding:manage 把关，
               进得来就一定有权改，按钮不再逐个挂 v-permission -->
          <el-form :model="form" label-width="110px" label-position="top">
            <el-form-item label="应用名称">
              <el-input v-model="form.appName" maxlength="40" show-word-limit
                        :placeholder="tenantName || '默认显示租户名称'" />
            </el-form-item>
            <!-- ⚠️ 占位文案里别写 `https://`：本仓库的 vue-tsc（Volar）会把模板行里
                 出现 `//` 的静态属性当成行注释截断，报错是「Property 'value' does not
                 exist on type …」这种和真实原因无关的 TS2339。踩过一次，写在近旁。 -->
            <el-form-item label="Logo 地址（https 绝对地址）">
              <el-input v-model="form.logoUrl" maxlength="500" placeholder="cdn.example.com/logo.png" />
            </el-form-item>
            <el-form-item label="图标地址（favicon）">
              <el-input v-model="form.faviconUrl" maxlength="500" placeholder="cdn.example.com/favicon.ico" />
            </el-form-item>
            <el-row :gutter="12">
              <el-col :span="12">
                <el-form-item label="主色">
                  <el-color-picker v-model="form.primaryColor" />
                  <span class="tip">留空 = 出厂主题</span>
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="页面底色">
                  <el-color-picker v-model="form.backgroundColor" />
                </el-form-item>
              </el-col>
            </el-row>
            <el-form-item label="登录页提示">
              <el-input v-model="form.loginNotice" type="textarea" :rows="2" maxlength="200" show-word-limit
                        placeholder="仅按纯文本显示，不解析 HTML" />
            </el-form-item>
            <el-form-item label="自定义 CSS 变量（可选）">
              <el-input v-model="form.customCssVars" type="textarea" :rows="3"
                        placeholder="--lf-sidebar-bg: #1f2937; --lf-page-bg: #f5f7fa" />
              <div class="tip">
                只接受 <code>--小写变量名: 值</code> 形式（外壳可用 <code>--lf-sidebar-bg</code> / <code>--lf-page-bg</code>）；
                自由 CSS 选择器、<code>url()</code>、<code>data:</code> 会被后端判 400 整笔退回，白名单外的键进「已丢弃」。
              </div>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="saving" @click="save">
                保存并预览
              </el-button>
              <el-button @click="reset">重新载入</el-button>
            </el-form-item>
            <el-alert v-if="dropped.length" type="warning" :closable="false" show-icon
                      :title="`已丢弃 ${dropped.length} 项：${dropped.join('、')}`" />
          </el-form>
        </el-card>
      </el-col>

      <el-col :span="12">
        <el-card shadow="never">
          <template #header>
            <div style="display: flex; align-items: center;">
              <span style="flex: 1;">自定义域名</span>
              <el-button size="small" type="primary" @click="addDialog = true">
                登记域名
              </el-button>
            </div>
          </template>
          <el-alert type="info" :closable="false" show-icon style="margin-bottom: 12px;">
            新登记的域名必须在自己 DNS 放一条 TXT 记录证明归属，<b>校验通过后才会参与域名→租户解析</b>；
            未校验的域名只占用名字，不会让任何人登录到这家租户。
          </el-alert>
          <el-table :data="domains" size="small" stripe>
            <el-table-column prop="domain" label="域名" min-width="160" />
            <el-table-column label="状态" width="150">
              <template #default="{ row }">
                <el-tag v-if="row.verified" type="success" size="small">已校验</el-tag>
                <el-tag v-else type="warning" size="small">待校验</el-tag>
                <el-tag v-if="row.isPrimary" size="small" style="margin-left: 4px;">主</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="校验记录" min-width="220">
              <template #default="{ row }">
                <div v-if="row.verified" style="color: #999;">{{ formatTime(row.verifiedAt) }}</div>
                <div v-else class="mono">
                  TXT {{ row.verifyRecordName }}<br />
                  labelflow-verify={{ row.verifyToken }}
                  <el-button link size="small" @click="copy(row)">复制</el-button>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="180" fixed="right">
              <template #default="{ row }">
                <el-button v-if="!row.verified" link size="small" type="primary" @click="verify(row)">校验</el-button>
                <el-button v-if="!row.isPrimary && row.verified" link size="small" @click="setPrimary(row)">设为主</el-button>
                <el-button link size="small" type="danger" @click="remove(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!domains.length" description="还没有登记域名" :image-size="60" />

          <div style="margin-top: 12px; display: flex; align-items: center; gap: 8px;">
            <el-input v-model="probeDomain" size="small" class="mono"
                      placeholder="解析测试：label.acme.com（留空用当前访问域名）" />
            <el-button size="small" :loading="probing" @click="probe">解析</el-button>
          </div>
          <div v-if="probeResult" class="tip">{{ probeResult }}</div>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="addDialog" title="登记自定义域名" width="460px">
      <el-form label-position="top" @submit.prevent="doAdd">
        <el-form-item label="域名">
          <el-input v-model="newDomain" class="mono" placeholder="label.acme.com" />
        </el-form-item>
      </el-form>
      <div class="tip">
        先把域名 CNAME/A 指向平台地址，再来这里登记并做 DNS TXT 校验。不带协议、不带路径。
      </div>
      <template #footer>
        <el-button @click="addDialog = false">取消</el-button>
        <el-button type="primary" :loading="adding" @click="doAdd">登记</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { previewFromMyBranding } from '@/composables/branding';
import {
  apiAddDomain, apiDeleteDomain, apiMyBranding, apiPublicBranding,
  apiSaveBranding, apiSetPrimaryDomain, apiVerifyDomain, type BrandingForm, type TenantDomainRow,
} from '@/api/branding';

const loading = ref(false);
const saving = ref(false);
const tenantName = ref('');
const tenantCode = ref('');
const dropped = ref<string[]>([]);
const domains = ref<TenantDomainRow[]>([]);
const form = reactive({
  appName: '', logoUrl: '', faviconUrl: '', primaryColor: '', backgroundColor: '',
  loginNotice: '', customCssVars: '',
});

function formatTime(t: string | null) { return t ? new Date(t).toLocaleString() : '—'; }

async function load() {
  loading.value = true;
  try {
    const me = await apiMyBranding();
    tenantName.value = me.tenantName;
    tenantCode.value = me.tenantCode;
    for (const k of Object.keys(form) as Array<keyof BrandingForm>) {
      (form as any)[k] = me.branding?.[k] ?? '';
    }
    domains.value = me.domains || [];
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    const out: any = await apiSaveBranding({ ...form });
    dropped.value = out?.dropped || [];
    const stored = (out?.branding || {}) as Record<string, string>;
    for (const k of Object.keys(form) as Array<keyof BrandingForm>) {
      (form as any)[k] = stored[k] ?? '';
    }
    previewFromMyBranding(stored, tenantCode.value, tenantName.value);
    ElMessage.success(dropped.value.length ? '已保存，但有字段被规则丢弃' : '已保存并应用');
  } catch {} finally {
    saving.value = false;
  }
}

function reset() { void load(); dropped.value = []; }

async function doAdd() {
  const d = newDomain.value.trim();
  if (!d) { ElMessage.warning('请填写域名'); return; }
  adding.value = true;
  try {
    const out: any = await apiAddDomain(d);
    addDialog.value = false;
    newDomain.value = '';
    await load();
    if (out?.instruction) {
      await ElMessageBox.alert(out.instruction, '请添加 DNS TXT 记录', { confirmButtonText: '知道了' });
    }
  } catch {} finally {
    adding.value = false;
  }
}

async function verify(row: TenantDomainRow) {
  verifying.value = row.id;
  try {
    const out: any = await apiVerifyDomain(row.id);
    ElMessage.success(out?.devBypass ? '已校验（dev 逃生口，生产需真实 TXT）' : '校验通过');
    await load();
  } catch (e: any) {
    // 后端把期望记录一起带回来了（expected.record/value），照着填比翻文档快
    const msg = e?.message || '校验失败';
    await ElMessageBox.alert(msg, '未通过校验', { confirmButtonText: '我再改改' });
  } finally {
    verifying.value = 0;
  }
}

async function setPrimary(row: TenantDomainRow) {
  await apiSetPrimaryDomain(row.id);
  ElMessage.success(`已将 ${row.domain} 设为主域名`);
  await load();
}

async function remove(row: TenantDomainRow) {
  await ElMessageBox.confirm(`删除 ${row.domain}？该域名将不再指向本租户。`, '确认删除', { type: 'warning' });
  await apiDeleteDomain(row.id);
  ElMessage.success('已删除');
  await load();
}

async function copy(row: TenantDomainRow) {
  const text = `labelflow-verify=${row.verifyToken || ''}`;
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('已复制记录值');
  } catch {
    await ElMessageBox.alert(`${row.verifyRecordName}\n${text}`, '手动复制', { confirmButtonText: '关闭' });
  }
}

const addDialog = ref(false);
const adding = ref(false);
const newDomain = ref('');
const verifying = ref(0);
const probing = ref(false);
const probeDomain = ref('');
const probeResult = ref('');

async function probe() {
  probing.value = true;
  probeResult.value = '';
  try {
    const res = await apiPublicBranding(probeDomain.value.trim() || undefined);
    if (!res) probeResult.value = '解析接口不可用（后端版本过旧或网络不通）';
    else if (!res.matched) probeResult.value = `${res.host} 未命中任何已校验域名 → 登录页用出厂外观`;
    else probeResult.value = `${res.host} → ${res.branding?.tenantName}（${res.branding?.tenantCode}），主色 ${res.branding?.primaryColor || '默认'}`;
  } finally {
    probing.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.tip { color: #888; font-size: 12px; line-height: 1.6; }
.mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
code { background: #f5f5f5; padding: 0 4px; border-radius: 3px; }
</style>
