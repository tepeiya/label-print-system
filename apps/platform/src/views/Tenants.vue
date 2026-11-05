<template>
  <div>
    <div class="page-header">
      <h2>🏬 租户管理</h2>
      <el-button @click="load" :loading="loading">刷新</el-button>
      <el-button type="primary" @click="openProvision">开通租户</el-button>
    </div>

    <div class="card">
      <el-table :data="tenants" v-loading="loading" stripe size="small" style="width: 100%">
        <el-table-column prop="id" label="ID" width="64" />
        <el-table-column label="租户" min-width="220">
          <template #default="{ row }">
            <div>{{ row.name }}</div>
            <div class="muted sub">{{ row.code }} · {{ row.type }}</div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'danger'" size="small">
              {{ row.enabled ? '启用' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="套餐" width="110">
          <template #default="{ row }">
            <el-tag v-if="row.plan" size="small" :type="planTagType(row.plan.code)">{{ row.plan.name }}</el-tag>
            <span v-else class="muted">无生效订阅</span>
          </template>
        </el-table-column>
        <el-table-column label="订阅" width="90">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" :type="subTagType(row.subscriptionStatus)">
              {{ subLabel(row.subscriptionStatus) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="席位" width="96">
          <template #default="{ row }">
            <span :class="{ over: row.userCount > row.seatLimit }">
              {{ row.userCount }} / {{ row.seatLimit }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="试用到期" width="170">
          <template #default="{ row }">
            <template v-if="row.trialEndsAt">
              <div>{{ fmtDate(row.trialEndsAt) }}</div>
              <div class="muted sub">{{ trialLeft(row.trialEndsAt) }}</div>
            </template>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="moduleCount" label="模块数" width="80" />
        <el-table-column label="退订时间" width="120">
          <template #default="{ row }">
            <span v-if="row.canceledAt" class="danger">{{ fmtDate(row.canceledAt) }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="270" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.enabled" link size="small" type="warning" @click="toggleEnabled(row, false)">
              停用
            </el-button>
            <el-button v-else link size="small" type="success" @click="toggleEnabled(row, true)">恢复</el-button>
            <el-button v-if="!row.canceledAt" link size="small" type="danger" @click="doCancel(row)">退订</el-button>
            <el-button link size="small" @click="openAddModule(row)">加购模块</el-button>
            <el-button link size="small" @click="openModules(row)">租户详情</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && !tenants.length" description="还没有租户，点「开通租户」新建一个" />
    </div>

    <!-- ============ 开通租户 ============ -->
    <el-dialog v-model="pd.show" title="开通租户" width="560px" top="6vh">
      <el-form ref="pdFormRef" :model="pd.form" :rules="pdRules" label-width="92px">
        <el-form-item label="租户名称" prop="name">
          <el-input v-model="pd.form.name" placeholder="例如：华东制造" />
        </el-form-item>
        <el-form-item label="租户 code" prop="code">
          <el-input v-model="pd.form.code" placeholder="小写字母开头，a-z0-9-，2–60 位" />
        </el-form-item>
        <el-form-item label="套餐" prop="planCode">
          <el-select v-model="pd.form.planCode" style="width: 100%">
            <el-option v-for="p in plans" :key="p.code" :label="`${p.name}（${p.code}）`" :value="p.code" />
          </el-select>
        </el-form-item>
        <el-form-item label="订阅类型">
          <el-radio-group v-model="pd.form.status">
            <el-radio value="trial">试用</el-radio>
            <el-radio value="active">正式</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="pd.form.status === 'trial'" label="试用天数" prop="trialDays">
          <el-input-number v-model="pd.form.trialDays" :min="1" :max="365" />
          <span class="muted sub">缺省 14 天，到期后模块在接口层被拦截</span>
        </el-form-item>
        <el-form-item label="席位数" prop="seats">
          <el-input-number v-model="pd.form.seats" :min="1" :max="1000" />
          <span class="muted sub">该租户可启用的用户数上限</span>
        </el-form-item>
        <el-divider content-position="left">租户管理员账号</el-divider>
        <el-form-item label="用户名" prop="adminUsername">
          <el-input v-model="pd.form.adminUsername" placeholder="例如：admin" />
        </el-form-item>
        <el-form-item label="密码" prop="adminPassword">
          <el-input v-model="pd.form.adminPassword" type="password" show-password placeholder="至少 8 位" />
        </el-form-item>
        <el-form-item label="显示名" prop="adminDisplayName">
          <el-input v-model="pd.form.adminDisplayName" placeholder="可选，默认「租户管理员」" />
        </el-form-item>
        <el-form-item label="邮箱" prop="adminEmail">
          <el-input v-model="pd.form.adminEmail" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pd.show = false">取消</el-button>
        <el-button type="primary" :loading="pd.saving" @click="doProvision">确认开通</el-button>
      </template>
    </el-dialog>

    <!-- ============ 加购模块 ============ -->
    <el-dialog v-model="ad.show" :title="`加购模块 · ${ad.tenant?.name ?? ''}`" width="480px">
      <el-form label-width="80px">
        <el-form-item label="模块">
          <el-select v-model="ad.moduleCode" filterable placeholder="选择要开通的模块" style="width: 100%">
            <el-option v-for="m in modules" :key="m.code" :label="`${m.icon ?? ''} ${m.name}（${m.code}）`" :value="m.code">
              <div class="opt">
                <span>{{ m.icon ?? '' }} {{ m.name }}</span>
                <span class="muted">{{ m.code }}{{ depText(m.code) ? ' · 依赖 ' + depText(m.code) : '' }}</span>
              </div>
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="来源">
          <el-select v-model="ad.source" style="width: 100%">
            <el-option label="addon — 单独加购" value="addon" />
            <el-option label="manual — 人工开通" value="manual" />
            <el-option label="gift — 赠送" value="gift" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="ad.moduleCode" label="">
          <span class="muted sub">{{ addHint }}</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ad.show = false">取消</el-button>
        <el-button type="primary" :loading="ad.saving" :disabled="!ad.moduleCode" @click="doAddModule">确认加购</el-button>
      </template>
    </el-dialog>

    <!-- ============ 租户详情（抽屉）：已开模块 + 配额与计量 ============ -->
    <el-drawer v-model="drawer.show" :title="`租户详情 · ${drawer.tenant?.name ?? ''}`" size="640px">
      <div v-loading="drawer.loading">
        <el-descriptions :column="1" border size="small" style="margin-bottom: 16px;">
          <el-descriptions-item label="租户 code">{{ drawer.tenant?.code }}</el-descriptions-item>
          <el-descriptions-item label="套餐">{{ drawer.tenant?.plan?.name ?? '无生效订阅' }}</el-descriptions-item>
          <el-descriptions-item label="订阅状态">{{ subLabel(drawer.tenant?.subscriptionStatus) }}</el-descriptions-item>
          <el-descriptions-item label="模块数（生效中）">{{ drawer.tenant?.moduleCount ?? 0 }}</el-descriptions-item>
          <el-descriptions-item v-if="drawer.subscription" label="订阅到期">
            {{ fmtDate(drawer.subscription.subscription.endsAt) }}
          </el-descriptions-item>
        </el-descriptions>

        <el-divider content-position="left">已开模块</el-divider>

        <el-alert
          v-if="drawer.derived"
          type="warning"
          :closable="false"
          show-icon
          title="模块详情接口未就绪"
          description="后端暂未提供 GET /platform/tenants/:id/modules（实测 404），下面按套餐（含依赖补齐）推导，不含单独加购的模块，也不提供停用。"
          style="margin-bottom: 12px;"
        />

        <div v-for="m in drawer.modules" :key="m.code" class="mod-row">
          <div class="mod-main">
            <span class="mod-name">{{ m.icon ?? '📦' }} {{ m.name }}</span>
            <el-tag size="small" effect="plain" v-if="m.isCore">核心</el-tag>
            <el-tag size="small" type="success" effect="plain" v-if="m.source">{{ m.source }}</el-tag>
            <el-tag size="small" type="info" effect="plain" v-if="m.status">{{ m.status }}</el-tag>
            <span class="muted sub">{{ m.code }}</span>
          </div>
          <div class="muted sub">{{ m.description || '—' }}</div>
          <div class="mod-actions">
            <span v-if="m.dependsOn.length" class="muted sub">依赖：{{ m.dependsOn.join('、') }}</span>
            <el-button v-if="!drawer.derived" link size="small" type="danger" @click="doDisableModule(m.code)">
              停用
            </el-button>
          </div>
        </div>
        <el-empty v-if="!drawer.loading && !drawer.modules.length" description="该租户没有生效中的模块" />

        <QuotaPanel v-if="drawer.tenant" :tenant="drawer.tenant" />
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import QuotaPanel from './tenant/QuotaPanel.vue';
import {
  apiAddTenantModule,
  apiCancelTenant,
  apiDisableTenantModule,
  apiListModules,
  apiListPlans,
  apiListTenants,
  apiProvisionTenant,
  apiResumeTenant,
  apiSuspendTenant,
  apiTenantModules,
  apiTenantSubscription,
} from '@/api';
import type {
  ModuleCatalogItem,
  ModuleSource,
  PlanInfo,
  PlatformTenant,
  ProvisionTenantPayload,
  SubscriptionStatus,
  TenantModuleRow,
  TenantSubscriptionDetail,
} from '@/api/types';

const loading = ref(false);
const tenants = ref<PlatformTenant[]>([]);
const plans = ref<PlanInfo[]>([]);
const modules = ref<ModuleCatalogItem[]>([]);

/** code → 模块目录项，列表/抽屉都用它把 code 翻成中文名 */
const moduleMap = computed(() => {
  const m = new Map<string, ModuleCatalogItem>();
  for (const it of modules.value) m.set(it.code, it);
  return m;
});

async function load() {
  loading.value = true;
  try {
    tenants.value = await apiListTenants();
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  load();
  // 套餐与模块目录变化不频繁，进页面拉一次即可（弹窗的下拉靠它们）
  try {
    const [p, m] = await Promise.all([apiListPlans(), apiListModules()]);
    plans.value = p;
    modules.value = m;
  } catch {
    /* 拦截器已提示 */
  }
});

// ---------------------------------------------------------------- 展示辅助

const fmtDate = (t: string | null | undefined) => (t ? new Date(t).toLocaleDateString('zh-CN') : '—');

function trialLeft(t: string): string {
  const diff = new Date(t).getTime() - Date.now();
  const days = Math.ceil(diff / 86_400_000);
  return days < 0 ? `已过期 ${-days} 天` : `剩余 ${days} 天`;
}

function planTagType(code: string) {
  if (code === 'ENTERPRISE') return 'danger';
  if (code === 'PRO') return 'warning';
  return 'info';
}

const SUB_LABEL: Record<string, string> = {
  active: '正式', trial: '试用', canceled: '已退订',
};
const subLabel = (s: SubscriptionStatus | null | undefined) => (s ? SUB_LABEL[s] ?? s : '无');
function subTagType(s: SubscriptionStatus | null) {
  if (s === 'active') return 'success';
  if (s === 'trial') return 'warning';
  if (s === 'canceled') return 'danger';
  return 'info';
}

const depText = (code: string) => (moduleMap.value.get(code)?.dependsOn ?? []).join('、');

/** 加购提示：把后端会自动补齐的前置模块说清楚（D1） */
const addHint = computed(() => {
  const deps = depText(ad.moduleCode);
  return `开通后会按依赖自动补齐前置模块${deps ? `：${deps}` : '（无前置依赖）'}。`;
});

// ---------------------------------------------------------------- 停用 / 恢复 / 退订

async function toggleEnabled(row: PlatformTenant, enable: boolean) {
  const label = enable ? '恢复' : '停用';
  try {
    await ElMessageBox.confirm(
      `确认${label}租户「${row.name}（${row.code}）」？${enable ? '恢复后该租户用户可正常登录。' : '停用后该租户所有用户登录与接口调用会被拒绝。'}`,
      `${label}确认`,
      { type: enable ? 'info' : 'warning', confirmButtonText: `确认${label}`, cancelButtonText: '取消' },
    );
  } catch {
    return; // 用户取消
  }
  try {
    await (enable ? apiResumeTenant(row.id) : apiSuspendTenant(row.id));
    ElMessage.success(`已${label}`);
    await load();
  } catch {
    /* 拦截器已提示 */
  }
}

async function doCancel(row: PlatformTenant) {
  try {
    await ElMessageBox.confirm(
      `确认给租户「${row.name}（${row.code}）」退订？退订后订阅立即失效、模块不可用，`
      + `数据保留 90 天后将被物理删除（D12），该操作不可逆。`,
      '退订确认',
      { type: 'error', confirmButtonText: '确认退订', cancelButtonText: '再想想', confirmButtonClass: 'el-button--danger' },
    );
  } catch {
    return;
  }
  try {
    const res = await apiCancelTenant(row.id);
    ElMessage.success(`已退订，${fmtDate(res.hardDeleteAfter)} 起可被硬删`);
    await load();
  } catch {
    /* 拦截器已提示 */
  }
}

// ---------------------------------------------------------------- 开通租户

const pdFormRef = ref<FormInstance>();
const pd = reactive({
  show: false,
  saving: false,
  form: {
    name: '',
    code: '',
    planCode: 'BASIC',
    status: 'trial' as 'trial' | 'active',
    trialDays: 14,
    seats: 5,
    adminUsername: '',
    adminPassword: '',
    adminDisplayName: '',
    adminEmail: '',
  },
});

// 与后端 provision.service.ts 的硬校验对齐，先把不合法的输入挡在前端
const pdRules: FormRules = {
  name: [
    { required: true, message: '请输入租户名称', trigger: 'blur' },
    { max: 60, message: '租户名称不超过 60 个字符', trigger: 'blur' },
  ],
  code: [
    { required: true, message: '请输入租户 code', trigger: 'blur' },
    { pattern: /^[a-z][a-z0-9-]{1,59}$/, message: '小写字母开头，仅 a-z0-9-，长度 2–60', trigger: 'blur' },
  ],
  planCode: [{ required: true, message: '请选择套餐', trigger: 'change' }],
  trialDays: [{ type: 'number', min: 1, max: 365, message: '试用天数 1–365', trigger: 'change' }],
  seats: [{ type: 'number', min: 1, max: 1000, message: '席位数 1–1000', trigger: 'change' }],
  adminUsername: [
    { required: true, message: '请输入管理员用户名', trigger: 'blur' },
    { max: 60, message: '不超过 60 个字符', trigger: 'blur' },
  ],
  adminPassword: [
    { required: true, message: '请输入管理员密码', trigger: 'blur' },
    { min: 8, message: '密码至少 8 位', trigger: 'blur' },
  ],
  adminEmail: [{ type: 'email', message: '邮箱格式不正确', trigger: 'blur' }],
};

function openProvision() {
  pd.form = {
    name: '', code: '', planCode: 'BASIC', status: 'trial', trialDays: 14, seats: 5,
    adminUsername: '', adminPassword: '', adminDisplayName: '', adminEmail: '',
  };
  pd.show = true;
}

function buildPayload(): ProvisionTenantPayload {
  const f = pd.form;
  const payload: ProvisionTenantPayload = {
    name: f.name.trim(),
    code: f.code.trim(),
    planCode: f.planCode,
    status: f.status,
    adminUsername: f.adminUsername.trim(),
    adminPassword: f.adminPassword,
  };
  if (f.status === 'trial') payload.trialDays = f.trialDays;
  if (f.seats) payload.seats = f.seats;
  if (f.adminDisplayName.trim()) payload.adminDisplayName = f.adminDisplayName.trim();
  if (f.adminEmail.trim()) payload.adminEmail = f.adminEmail.trim();
  return payload;
}

async function doProvision() {
  if (!pdFormRef.value) return;
  await pdFormRef.value.validate();
  pd.saving = true;
  try {
    const res = await apiProvisionTenant(buildPayload());
    ElMessage.success(
      `租户 ${res.code} 已开通（管理员 ${res.adminUsername}，模块 ${res.modules.length} 个）`,
    );
    pd.show = false;
    await load();
  } catch {
    /* 拦截器已提示 */
  } finally {
    pd.saving = false;
  }
}

// ---------------------------------------------------------------- 加购模块

const ad = reactive({
  show: false,
  saving: false,
  tenant: null as PlatformTenant | null,
  moduleCode: '',
  source: 'addon' as ModuleSource,
});

function openAddModule(row: PlatformTenant) {
  ad.tenant = row;
  ad.moduleCode = '';
  ad.source = 'addon';
  ad.show = true;
}

async function doAddModule() {
  if (!ad.tenant || !ad.moduleCode) return;
  ad.saving = true;
  try {
    const res = await apiAddTenantModule(ad.tenant.id, ad.moduleCode, ad.source);
    ElMessage.success(res.added.length ? `已开通：${res.added.join('、')}` : '模块已在开通状态');
    ad.show = false;
    await load();
  } catch {
    /* 拦截器已提示 */
  } finally {
    ad.saving = false;
  }
}

async function doDisableModule(code: string) {
  const tenant = drawer.tenant;
  if (!tenant) return;
  try {
    await ElMessageBox.confirm(
      `确认停用模块「${moduleMap.value.get(code)?.name ?? code}」？该模块下菜单与接口会立即不可用。`,
      '停用模块',
      { type: 'warning', confirmButtonText: '确认停用', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await apiDisableTenantModule(tenant.id, code);
    ElMessage.success('模块已停用');
    await openModulesData(tenant);
    await load();
  } catch {
    /* 被依赖时后端会返回「请先停用 xxx」，拦截器已弹 */
  }
}

// ---------------------------------------------------------------- 已开模块抽屉

const drawer = reactive({
  show: false,
  loading: false,
  tenant: null as PlatformTenant | null,
  modules: [] as TenantModuleRow[],
  /** true = 详情接口没数据，这里展示的是「按套餐推导」的模块，不带停用 */
  derived: false,
  subscription: null as TenantSubscriptionDetail | null,
});

function openModules(row: PlatformTenant) {
  drawer.tenant = row;
  drawer.show = true;
  openModulesData(row);
}

async function openModulesData(row: PlatformTenant) {
  drawer.loading = true;
  drawer.modules = [];
  drawer.derived = false;
  drawer.subscription = null;
  try {
    // 两个 GET 都标了 silent：后端未上线时（404）不弹红色 toast，只在抽屉里给降级提示
    const [mods, sub] = await Promise.all([
      apiTenantModules(row.id).catch(() => null),
      apiTenantSubscription(row.id).catch(() => null),
    ]);
    if (mods) {
      drawer.modules = mods;
    } else {
      drawer.derived = true;
      // 退化成套餐展开（effectiveModules 已含依赖补齐），运营至少知道「应该有哪些模块」
      const codes = plans.value.find((p) => p.code === row.plan?.code)?.effectiveModules ?? [];
      drawer.modules = codes.map((c) => moduleMap.value.get(c)).filter((m): m is ModuleCatalogItem => !!m);
    }
    drawer.subscription = sub;
  } finally {
    drawer.loading = false;
  }
}
</script>

<style scoped>
.sub { font-size: 12px; }
.danger { color: #f56c6c; }
.over { color: #e6a23c; font-weight: 600; }
.opt { display: flex; justify-content: space-between; gap: 12px; }
.mod-row {
  padding: 10px 12px; border: 1px solid #ebeef5; border-radius: 4px; margin-bottom: 8px;
}
.mod-main { display: flex; align-items: center; gap: 8px; }
.mod-name { font-weight: 600; }
.mod-actions { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
</style>

