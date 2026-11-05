<template>
  <div class="quota-panel">
    <div class="head">
      <h4 class="block-title">配额与计量</h4>
      <el-button link size="small" @click="loadAll" :loading="loading">刷新</el-button>
    </div>

    <el-divider content-position="left">
      <span class="divider-text">用量配额（软上限只告警，硬上限直接拦截）</span>
    </el-divider>

    <div class="toolbar">
      <el-button size="small" type="primary" @click="openEdit(null)">新增配额</el-button>
      <span class="muted sub">未设配额的计量项不做限制；窗口周期 month=自然月、day=当天。</span>
    </div>

    <el-table :data="quotas" size="small" stripe v-loading="loading" empty-text="该租户还没有设置配额">
      <el-table-column prop="meter" label="计量项" min-width="140">
        <template #default="{ row }">{{ meterLabel(row.meter) }}</template>
      </el-table-column>
      <el-table-column label="软上限" width="110" align="right">
        <template #default="{ row }">
          <span v-if="row.softLimit !== null">{{ row.softLimit }}</span>
          <span v-else class="muted">不限</span>
        </template>
      </el-table-column>
      <el-table-column label="硬上限" width="110" align="right">
        <template #default="{ row }">
          <span class="danger" v-if="row.hardLimit !== null">{{ row.hardLimit }}</span>
          <span v-else class="muted">不限</span>
        </template>
      </el-table-column>
      <el-table-column label="周期" width="80">
        <template #default="{ row }">{{ PERIOD_LABEL[row.period] ?? row.period }}</template>
      </el-table-column>
      <el-table-column label="操作" width="120" align="right">
        <template #default="{ row }">
          <el-button link size="small" @click="openEdit(row.meter)">编辑</el-button>
          <el-button link size="small" type="danger" @click="doDelete(row.meter)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-divider content-position="left">
      <span class="divider-text">本月计量（usage_daily 聚合）</span>
    </el-divider>

    <el-table :data="month" size="small" stripe v-loading="meterLoading" empty-text="本月没有计量记录">
      <el-table-column prop="meter" label="计量项" min-width="140">
        <template #default="{ row }">{{ meterLabel(row.meter) }}</template>
      </el-table-column>
      <el-table-column label="已用" width="100" align="right">
        <template #default="{ row }">{{ row.used }}</template>
      </el-table-column>
      <el-table-column label="配额 / 使用率" min-width="180">
        <template #default="{ row }">
          <div v-if="row.hardLimit !== null || row.softLimit !== null" class="quota-line">
            <span class="muted sub">{{ limitText(row) }}</span>
            <el-progress
              :percentage="percentOf(row)"
              :stroke-width="8"
              :status="progressStatus(row)"
              :show-text="false"
            />
          </div>
          <span v-else class="muted sub">未设配额</span>
        </template>
      </el-table-column>
    </el-table>

    <el-divider content-position="left">
      <span class="divider-text">原始计量明细（最近 20 条，可对账）</span>
    </el-divider>

    <div class="toolbar">
      <el-select v-model="meterFilter" clearable placeholder="全部计量项" size="small" style="width: 180px" @change="loadMeters">
        <el-option v-for="m in meterOptions" :key="m" :label="meterLabel(m)" :value="m" />
      </el-select>
      <el-button size="small" @click="loadMeters" :loading="meterLoading">查询</el-button>
      <span class="muted sub">GET /platform/tenants/:id/meters 的 meters 数组，取前 20 条</span>
    </div>

    <el-table :data="meters" size="small" stripe v-loading="meterLoading" empty-text="没有原始计量记录">
      <el-table-column label="时间" width="150">
        <template #default="{ row }">
          <div>{{ fmtDate(row.occurredAt) }}</div>
          <div class="muted sub">{{ fmtTime(row.occurredAt) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="计量项" width="130">
        <template #default="{ row }">{{ meterLabel(row.meter) }}</template>
      </el-table-column>
      <el-table-column label="数量" width="80" align="right">
        <template #default="{ row }"><span class="money">{{ row.quantity }}</span></template>
      </el-table-column>
      <el-table-column label="模块 / 用户" width="120">
        <template #default="{ row }">
          <div>{{ row.moduleCode || '—' }}</div>
          <div class="muted sub">用户 #{{ row.userId ?? '—' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="meta" min-width="160">
        <template #default="{ row }"><span class="mono">{{ metaText(row.meta) }}</span></template>
      </el-table-column>
    </el-table>

    <!-- ============ 编辑 / 新增配额 ============ -->
    <el-dialog v-model="ed.show" :title="ed.exist ? `编辑配额 · ${ed.meter}` : '新增配额'" width="480px">
      <el-form label-width="92px">
        <el-form-item label="计量项" required>
          <el-select
            v-model="ed.meter" filterable allow-create default-first-option
            :disabled="ed.exist" placeholder="选择或输入 meter code" style="width: 100%"
          >
            <el-option v-for="m in meterOptions" :key="m" :label="meterLabel(m)" :value="m" />
          </el-select>
        </el-form-item>
        <el-form-item label="窗口周期">
          <el-radio-group v-model="ed.period">
            <el-radio value="month">按月</el-radio>
            <el-radio value="day">按天</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="软上限">
          <el-checkbox v-model="ed.useSoft" class="limit-check">限制</el-checkbox>
          <el-input-number v-model="ed.soft" :min="0" :disabled="!ed.useSoft" controls-position="right" />
          <span class="muted sub">超过只回告警，不拦截</span>
        </el-form-item>
        <el-form-item label="硬上限">
          <el-checkbox v-model="ed.useHard" class="limit-check">限制</el-checkbox>
          <el-input-number v-model="ed.hard" :min="0" :disabled="!ed.useHard" controls-position="right" />
          <span class="muted sub">超过拒绝（业务码 4033）</span>
        </el-form-item>
        <el-form-item label="">
          <span class="muted sub">取消勾选即提交 null = 取消该侧限制；两侧都不限请直接删除该配额。</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ed.show = false">取消</el-button>
        <el-button type="primary" :loading="ed.saving" @click="doSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiDeleteTenantQuota, apiSetTenantQuota, apiTenantMeters, apiTenantQuotas } from '@/api';
import type {
  MeterMonthSummary,
  MeterUsage,
  PlatformTenant,
  QuotaPeriod,
  TenantQuota,
  UpsertQuotaPayload,
} from '@/api/types';

/** 抽屉里的「配额与计量」区块：由 views/Tenants.vue 传入租户行，自己拉三类数据 */
const props = defineProps<{ tenant: PlatformTenant }>();

const METER_LABEL: Record<string, string> = {
  print_labels: '打印标签数',
  ai_generate: 'AI 生成次数',
};
const PERIOD_LABEL: Record<string, string> = { month: '按月', day: '按天' };
/** 后端 meter 是自由字符串（40 位），这里只给已知项做中文名，未知项原样展示 */
const meterLabel = (m: string) => (METER_LABEL[m] ? `${METER_LABEL[m]}（${m}）` : m);
const KNOWN_METERS = ['print_labels', 'ai_generate'];

const fmtDate = (t: string | null | undefined) => (t ? new Date(t).toLocaleDateString('zh-CN') : '—');
const fmtTime = (t: string | null | undefined) =>
  (t ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) : '');

const loading = ref(false);
const meterLoading = ref(false);
const quotas = ref<TenantQuota[]>([]);
const month = ref<MeterMonthSummary[]>([]);
const meters = ref<MeterUsage[]>([]);
const meterFilter = ref('');

/** 下拉候选：已知计量项 + 当前配额/明细里出现过的 meter */
const meterOptions = computed(() => {
  const set = new Set<string>(KNOWN_METERS);
  for (const r of quotas.value) set.add(r.meter);
  for (const r of month.value) set.add(r.meter);
  for (const r of meters.value) set.add(r.meter);
  return Array.from(set);
});

const limitText = (r: MeterMonthSummary) =>
  `软 ${r.softLimit ?? '不限'} / 硬 ${r.hardLimit ?? '不限'} · ${PERIOD_LABEL[r.period] ?? r.period}`;

/** 使用率按更严格的一侧算（有硬上限看硬上限，否则看软上限）；两侧都不限的行走「未设配额」分支，不进这里 */
function percentOf(r: MeterMonthSummary) {
  const cap = r.hardLimit ?? r.softLimit;
  if (cap === null || cap === 0) return 0;
  return Math.min(100, Math.round((Number(r.used) / Number(cap)) * 100));
}

function progressStatus(r: MeterMonthSummary) {
  const cap = r.hardLimit ?? r.softLimit;
  if (cap === null) return 'success';
  if (Number(r.used) > Number(cap)) return 'exception';
  if (Number(r.used) >= Number(cap) * 0.8) return 'warning';
  return 'success';
}

function metaText(meta: Record<string, unknown> | null | undefined) {
  if (!meta) return '—';
  const s = JSON.stringify(meta);
  return s === '{}' ? '—' : s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

async function loadQuotas() {
  loading.value = true;
  try {
    quotas.value = await apiTenantQuotas(props.tenant.id);
  } catch {
    /* 拦截器已提示 */
  } finally {
    loading.value = false;
  }
}

async function loadMeters() {
  meterLoading.value = true;
  try {
    const res = await apiTenantMeters(props.tenant.id, { meter: meterFilter.value, page: 1, pageSize: 20 });
    month.value = res.month;
    meters.value = res.meters;
  } catch {
    /* 拦截器已提示 */
  } finally {
    meterLoading.value = false;
  }
}

function loadAll() {
  loadQuotas();
  loadMeters();
}

// ---------------------------------------------------------------- 编辑配额

const ed = reactive({
  show: false,
  saving: false,
  /** true = 改已存在的 meter 配额（计量项不可改，改口径请「删除后新增」） */
  exist: false,
  meter: '',
  period: 'month' as QuotaPeriod,
  useSoft: true,
  soft: 0,
  useHard: false,
  hard: 0,
});

function openEdit(meter: string | null) {
  const row = meter ? quotas.value.find((x) => x.meter === meter) ?? null : null;
  ed.exist = !!row;
  ed.meter = row?.meter ?? '';
  ed.period = (row?.period === 'day' ? 'day' : 'month') as QuotaPeriod;
  ed.useSoft = row ? row.softLimit !== null : true;
  ed.soft = row?.softLimit ?? 0;
  ed.useHard = row ? row.hardLimit !== null : false;
  ed.hard = row?.hardLimit ?? 0;
  ed.show = true;
}

async function doSave() {
  const meter = ed.meter.trim();
  if (!meter) {
    ElMessage.warning('请选择或输入计量项');
    return;
  }
  if (!ed.useSoft && !ed.useHard) {
    ElMessage.warning('两侧都不设限请直接用「删除」，保存无意义的配额会让运营误判');
    return;
  }
  const soft = ed.useSoft ? Number(ed.soft) : null;
  const hard = ed.useHard ? Number(ed.hard) : null;
  if (soft !== null && hard !== null && soft > hard) {
    ElMessage.warning('软上限不能大于硬上限');
    return;
  }
  const payload: UpsertQuotaPayload = { softLimit: soft, hardLimit: hard, period: ed.period };
  ed.saving = true;
  try {
    await apiSetTenantQuota(props.tenant.id, meter, payload);
    ElMessage.success(`配额 ${meterLabel(meter)} 已保存`);
    ed.show = false;
    await loadAll();
  } catch {
    /* 拦截器已提示 */
  } finally {
    ed.saving = false;
  }
}

async function doDelete(meter: string) {
  try {
    await ElMessageBox.confirm(
      `确认删除「${meterLabel(meter)}」的配额？删除后该计量项不再限流（本月已用量保留）。`,
      '删除配额',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    await apiDeleteTenantQuota(props.tenant.id, meter);
    ElMessage.success('配额已删除');
    await loadAll();
  } catch {
    /* 拦截器已提示 */
  }
}

watch(() => props.tenant?.id, (id) => { if (id) { meterFilter.value = ''; loadAll(); } });
onMounted(loadAll);
</script>

<style scoped>
.head { display: flex; align-items: center; gap: 8px; }
.block-title { margin: 0; font-size: 15px; }
.divider-text { font-size: 13px; color: #606266; }
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.sub { font-size: 12px; }
.danger { color: #f56c6c; font-weight: 600; }
.money { font-weight: 600; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
.quota-line { display: flex; flex-direction: column; gap: 2px; }
.limit-check { margin-right: 10px; }
</style>
