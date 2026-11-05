<template>
  <div>
    <div class="page-header">
      <h2>🧾 账单中心</h2>
      <el-button @click="load" :loading="loading">刷新</el-button>
      <el-button type="primary" @click="openCreate">出账</el-button>
    </div>

    <div class="card">
      <!-- 筛选：租户 + 状态，改动即回到第 1 页重查 -->
      <el-form class="filters" inline @submit.prevent>
        <el-form-item label="租户">
          <el-select v-model="q.tenantId" clearable filterable placeholder="全部租户" style="width: 220px" @change="reload">
            <el-option v-for="t in tenants" :key="t.id" :label="`${t.name}（${t.code}）`" :value="t.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="q.status" clearable placeholder="全部状态" style="width: 140px" @change="reload">
            <el-option v-for="s in STATUS_ORDER" :key="s" :label="STATUS_LABEL[s]" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button @click="reload" :loading="loading">查询</el-button>
          <el-button @click="resetFilters">重置</el-button>
        </el-form-item>
      </el-form>

      <el-table :data="rows" v-loading="loading" stripe size="small" style="width: 100%">
        <el-table-column prop="id" label="ID" width="64" />
        <el-table-column label="账单号 / 租户" min-width="230">
          <template #default="{ row }">
            <div class="mono">{{ row.number }}</div>
            <div class="muted sub">{{ tenantName(row.tenantId) }} · ID {{ row.tenantId }}</div>
          </template>
        </el-table-column>
        <el-table-column label="来源" width="90">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" :type="row.detail?.source === 'plan' ? 'success' : 'info'">
              {{ row.detail?.source === 'plan' ? '套餐' : '手工' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="应付" width="120" align="right">
          <template #default="{ row }">
            <span class="money">{{ money(row.amountCents) }}</span>
            <span class="muted sub"> {{ row.currency }}</span>
          </template>
        </el-table-column>
        <el-table-column label="已收" width="110" align="right">
          <template #default="{ row }">{{ money(row.paidCents ?? 0) }}</template>
        </el-table-column>
        <el-table-column label="待收余额" width="110" align="right">
          <template #default="{ row }">
            <span :class="{ danger: (row.balanceCents ?? 0) > 0 && row.status !== 'void' }">
              {{ money(row.balanceCents ?? 0) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="92">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTagType(row.status)">{{ STATUS_LABEL[row.status] ?? row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="账期" width="180">
          <template #default="{ row }">
            <span v-if="row.periodStart || row.periodEnd">{{ row.periodStart || '—' }} ~ {{ row.periodEnd || '—' }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="到期 / 实付" width="120">
          <template #default="{ row }">
            <div v-if="row.dueAt">{{ fmtDate(row.dueAt) }}</div>
            <div v-if="row.paidAt" class="muted sub">已付 {{ fmtDate(row.paidAt) }}</div>
            <span v-if="!row.dueAt && !row.paidAt" class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="150">
          <template #default="{ row }">
            <div>{{ fmtDate(row.createdAt) }}</div>
            <div class="muted sub">{{ fmtTime(row.createdAt) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="250" fixed="right">
          <template #default="{ row }">
            <el-button link size="small" @click="openDetail(row.id)">详情</el-button>
            <el-button v-if="row.status === 'draft'" link size="small" type="primary" @click="openIssue(row)">发出</el-button>
            <el-button
              v-if="row.status === 'issued' || row.status === 'overdue'"
              link size="small" type="success" @click="openPayment(row)"
            >登记收款</el-button>
            <el-button
              v-if="row.status !== 'void' && row.status !== 'paid'"
              link size="small" type="danger" @click="doVoid(row)"
            >作废</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && !rows.length" description="没有账单，点「出账」按套餐或手工开一张" />

      <el-pagination
        class="pager"
        layout="total, sizes, prev, pager, next, jumper"
        :total="total"
        :page-size="q.pageSize"
        :current-page="q.page"
        :page-sizes="[10, 20, 50, 100]"
        @current-change="onPage"
        @size-change="onSize"
      />
    </div>

    <!-- ============ 出账 ============ -->
    <el-dialog v-model="cd.show" title="出账（生成草稿账单）" width="640px" top="6vh">
      <el-form label-width="96px">
        <el-form-item label="租户" required>
          <el-select v-model="cd.tenantId" filterable placeholder="选择出账租户" style="width: 100%">
            <el-option v-for="t in tenants" :key="t.id" :label="`${t.name}（${t.code}）`" :value="t.id">
              <div class="opt">
                <span>{{ t.name }}</span>
                <span class="muted">{{ t.code }} · {{ t.plan?.name ?? '无生效订阅' }}</span>
              </div>
            </el-option>
          </el-select>
        </el-form-item>

        <el-form-item label="出账方式">
          <el-radio-group v-model="cd.mode">
            <el-radio value="plan">按套餐月费</el-radio>
            <el-radio value="fixed">固定金额</el-radio>
            <el-radio value="items">手填行项</el-radio>
          </el-radio-group>
        </el-form-item>

        <el-form-item v-if="cd.mode === 'plan'" label="">
          <span class="muted sub">{{ planHint }}</span>
        </el-form-item>

        <el-form-item v-if="cd.mode === 'fixed'" label="金额（元）">
          <el-input-number v-model="cd.amountYuan" :min="0" :precision="2" :step="100" controls-position="right" />
          <span class="muted sub">换算分值 {{ centsOf(cd.amountYuan) }}（分），0 元账单也合法（赠送 / 减免）</span>
        </el-form-item>

        <el-form-item v-if="cd.mode === 'items'" label="行项">
          <div class="lines">
            <div v-for="(ln, i) in cd.items" :key="i" class="line">
              <el-input v-model="ln.title" size="small" class="l-title" placeholder="项目名（必填）" maxlength="200" />
              <el-input v-model="ln.code" size="small" class="l-code" placeholder="code 可选" maxlength="40" />
              <el-input-number v-model="ln.qty" size="small" class="l-num" :min="0" :precision="2" :controls="false" placeholder="数量" />
              <el-input-number v-model="ln.priceYuan" size="small" class="l-num" :min="0" :precision="2" :controls="false" placeholder="单价元" />
              <span class="l-sum">{{ money(lineCents(ln)) }}</span>
              <el-button link size="small" type="danger" @click="cd.items.splice(i, 1)">删</el-button>
            </div>
            <div class="line foot">
              <el-button size="small" @click="addItem">新增一行</el-button>
              <span class="muted">合计</span>
              <span class="money">{{ money(itemsCents) }}</span>
              <span class="muted sub">（不传 amountCents，由后端按 qty×单价 汇总）</span>
            </div>
          </div>
        </el-form-item>

        <el-form-item label="账期">
          <el-date-picker
            v-model="cd.periodStart" type="date" value-format="YYYY-MM-DD"
            placeholder="开始（缺省本月初）" style="width: 160px"
          />
          <span class="muted tilde">~</span>
          <el-date-picker
            v-model="cd.periodEnd" type="date" value-format="YYYY-MM-DD"
            placeholder="结束（缺省本月末）" style="width: 160px"
          />
        </el-form-item>
        <el-form-item label="币种">
          <el-input v-model="cd.currency" maxlength="8" placeholder="默认 CNY" style="width: 120px" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="cd.note" type="textarea" :rows="2" maxlength="300" show-word-limit placeholder="可选，写入账单快照 detail.note" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="cd.show = false">取消</el-button>
        <el-button type="primary" :loading="cd.saving" @click="doCreate">确认出账</el-button>
      </template>
    </el-dialog>

    <!-- ============ 发出账单 ============ -->
    <el-dialog v-model="issue.show" :title="`发出账单 · ${issue.invoice?.number ?? ''}`" width="420px">
      <el-form label-width="92px">
        <el-form-item label="账期内天数">
          <el-input-number v-model="issue.dueDays" :min="1" :max="365" controls-position="right" />
        </el-form-item>
        <el-form-item label="">
          <span class="muted sub">
            发出后账单转 issued，到期未收会被每日任务转 overdue。缺省 15 天。
          </span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="issue.show = false">取消</el-button>
        <el-button type="primary" :loading="issue.saving" @click="doIssue">确认发出</el-button>
      </template>
    </el-dialog>

    <!-- ============ 登记收款 ============ -->
    <el-dialog v-model="pm.show" :title="`登记收款 · ${pm.invoice?.number ?? ''}`" width="480px">
      <el-form label-width="92px">
        <el-form-item label="待收余额">
          <span class="money">{{ money(pm.invoice?.balanceCents ?? 0) }}</span>
          <el-button link size="small" type="primary" @click="pm.amountYuan = centsToYuan(pm.invoice?.balanceCents ?? 0)">
            按余额填入
          </el-button>
        </el-form-item>
        <el-form-item label="金额（元）" required>
          <el-input-number v-model="pm.amountYuan" :min="0.01" :precision="2" :step="100" controls-position="right" />
          <span class="muted sub">换算分值 {{ centsOf(pm.amountYuan) }}（分）</span>
        </el-form-item>
        <el-form-item label="通道">
          <el-select v-model="pm.provider" style="width: 100%">
            <el-option v-for="p in PROVIDER_ORDER" :key="p" :label="PROVIDER_LABEL[p]" :value="p" />
          </el-select>
        </el-form-item>
        <el-form-item label="流水号">
          <el-input v-model="pm.providerRef" maxlength="200" placeholder="银行回单号 / 三方流水号，可选" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="pm.note" type="textarea" :rows="2" maxlength="300" show-word-limit placeholder="可选" />
        </el-form-item>
        <el-form-item label="">
          <span class="muted sub">累计收款 ≥ 应付后账单自动转 paid 并写 paidAt（D5：线下收款后人工登记，无支付回调）。</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pm.show = false">取消</el-button>
        <el-button type="primary" :loading="pm.saving" @click="doPayment">确认登记</el-button>
      </template>
    </el-dialog>

    <!-- ============ 账单详情（含收款记录，可对账） ============ -->
    <el-drawer v-model="dt.show" :title="`账单详情 · ${dt.invoice?.number ?? ''}`" size="620px">
      <div v-loading="dt.loading">
        <template v-if="dt.invoice">
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="租户">{{ tenantName(dt.invoice.tenantId) }}（ID {{ dt.invoice.tenantId }}）</el-descriptions-item>
            <el-descriptions-item label="状态">
              <el-tag size="small" :type="statusTagType(dt.invoice.status)">{{ STATUS_LABEL[dt.invoice.status] }}</el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="应付">{{ money(dt.invoice.amountCents) }} {{ dt.invoice.currency }}</el-descriptions-item>
            <el-descriptions-item label="已收">{{ money(dt.invoice.paidCents) }}</el-descriptions-item>
            <el-descriptions-item label="待收余额">{{ money(dt.invoice.balanceCents) }}</el-descriptions-item>
            <el-descriptions-item label="出账来源">{{ dt.invoice.detail?.source === 'plan' ? '按套餐出账' : '手工出账' }}</el-descriptions-item>
            <el-descriptions-item label="账期">{{ dt.invoice.periodStart || '—' }} ~ {{ dt.invoice.periodEnd || '—' }}</el-descriptions-item>
            <el-descriptions-item label="到期">{{ fmtDate(dt.invoice.dueAt) }}</el-descriptions-item>
            <el-descriptions-item label="实付时间">{{ fmtDate(dt.invoice.paidAt) }}</el-descriptions-item>
            <el-descriptions-item label="创建人">运营账号 #{{ dt.invoice.createdBy ?? '—' }}</el-descriptions-item>
          </el-descriptions>

          <el-alert
            :type="reconcile.ok ? 'success' : 'warning'"
            :closable="false"
            show-icon
            :title="reconcile.title"
            :description="reconcile.detail"
            style="margin: 12px 0;"
          />

          <h4 class="block-title">账单项</h4>
          <el-table :data="dt.invoice.detail?.items ?? []" size="small" stripe empty-text="无行项">
            <el-table-column prop="title" label="项目" min-width="180" />
            <el-table-column prop="code" label="code" width="120">
              <template #default="{ row }">{{ row.code || '—' }}</template>
            </el-table-column>
            <el-table-column label="数量" width="80" align="right">
              <template #default="{ row }">{{ row.qty ?? '—' }}</template>
            </el-table-column>
            <el-table-column label="单价" width="100" align="right">
              <template #default="{ row }">{{ row.unitPriceCents === undefined ? '—' : money(row.unitPriceCents) }}</template>
            </el-table-column>
            <el-table-column label="金额" width="110" align="right">
              <template #default="{ row }">
                <span class="money">{{ money(row.amountCents ?? (Number(row.qty ?? 0) * Number(row.unitPriceCents ?? 0))) }}</span>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="dt.invoice.detail?.plan" class="muted sub plan-snap">
            套餐快照：{{ dt.invoice.detail.plan.name }}（{{ dt.invoice.detail.plan.code }}）月费
            {{ money(dt.invoice.detail.plan.priceCents ?? 0) }}
          </div>
          <div v-if="dt.invoice.detail?.note" class="muted sub plan-snap">备注：{{ dt.invoice.detail.note }}</div>

          <h4 class="block-title">收款记录（{{ dt.invoice.payments.length }} 笔）</h4>
          <el-table :data="dt.invoice.payments" size="small" stripe empty-text="还没有收款">
            <el-table-column label="时间" width="150">
              <template #default="{ row }">
                <div>{{ fmtDate(row.paidAt) }}</div>
                <div class="muted sub">{{ fmtTime(row.paidAt) }}</div>
              </template>
            </el-table-column>
            <el-table-column label="通道" width="90">
              <template #default="{ row }">
                <el-tag size="small" effect="plain">{{ PROVIDER_LABEL[row.provider] ?? row.provider }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="金额" width="110" align="right">
              <template #default="{ row }"><span class="money">{{ money(row.amountCents) }}</span></template>
            </el-table-column>
            <el-table-column label="流水号 / 备注" min-width="180">
              <template #default="{ row }">
                <div class="mono">{{ row.providerRef || '—' }}</div>
                <div class="muted sub">{{ row.note || '' }}</div>
              </template>
            </el-table-column>
            <el-table-column label="登记人" width="90">
              <template #default="{ row }">#{{ row.paidBy ?? '—' }}</template>
            </el-table-column>
          </el-table>

          <div class="drawer-actions">
            <el-button v-if="dt.invoice.status === 'draft'" size="small" type="primary" @click="openIssue(dt.invoice)">发出账单</el-button>
            <el-button
              v-if="dt.invoice.status === 'issued' || dt.invoice.status === 'overdue'"
              size="small" type="success" @click="openPayment(dt.invoice)"
            >登记收款</el-button>
            <el-button
              v-if="dt.invoice.status !== 'void' && dt.invoice.status !== 'paid'"
              size="small" type="danger" @click="doVoid(dt.invoice)"
            >作废</el-button>
          </div>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  apiCreateInvoice,
  apiInvoiceDetail,
  apiIssueInvoice,
  apiListInvoices,
  apiListTenants,
  apiRegisterPayment,
  apiVoidInvoice,
} from '@/api';
import type {
  CreateInvoicePayload,
  Invoice,
  InvoiceDetail,
  InvoiceStatus,
  PaymentProvider,
  PlatformTenant,
} from '@/api/types';

// ---------------------------------------------------------------- 展示常量

const STATUS_ORDER: InvoiceStatus[] = ['draft', 'issued', 'paid', 'overdue', 'void'];
const STATUS_LABEL: Record<string, string> = {
  draft: '草稿', issued: '已发出', paid: '已付清', overdue: '逾期未付', void: '已作废',
};
const STATUS_TAG: Record<string, 'info' | 'primary' | 'success' | 'danger' | 'warning'> = {
  draft: 'info', issued: 'primary', paid: 'success', overdue: 'danger', void: 'warning',
};
const statusTagType = (s: string) => STATUS_TAG[s] ?? 'info';

const PROVIDER_ORDER: PaymentProvider[] = ['manual', 'wechat', 'alipay', 'stripe', 'bank'];
const PROVIDER_LABEL: Record<string, string> = {
  manual: '人工登记', wechat: '微信', alipay: '支付宝', stripe: 'Stripe', bank: '银行转账',
};

// ---------------------------------------------------------------- 金额换算
// 后端金额一律「分」（BIGINT），这里集中一处换算，view 内不再散落 /100。

/** 分 → 「元」字符串（保留两位），列表与详情展示统一走它 */
const money = (cents: number | undefined | null) => (Number(cents ?? 0) / 100).toFixed(2);
/** 分 → 元（数字），给输入框回填用 */
const centsToYuan = (cents: number | undefined | null) => Number((Number(cents ?? 0) / 100).toFixed(2));
/** 元 → 分（四舍五入取整），提交前唯一换算入口 */
const centsOf = (yuan: number | undefined | null) => Math.round(Number(yuan ?? 0) * 100);

const fmtDate = (t: string | null | undefined) => (t ? new Date(t).toLocaleDateString('zh-CN') : '—');
const fmtTime = (t: string | null | undefined) =>
  (t ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) : '');

// ---------------------------------------------------------------- 列表

const loading = ref(false);
const rows = ref<Invoice[]>([]);
const total = ref(0);
const tenants = ref<PlatformTenant[]>([]);
const q = reactive<{ tenantId?: number; status?: string; page: number; pageSize: number }>({
  tenantId: undefined, status: undefined, page: 1, pageSize: 20,
});

const tenantName = (id: number) => tenants.value.find((t) => t.id === id)?.name ?? `租户 #${id}`;

async function load() {
  loading.value = true;
  try {
    const res = await apiListInvoices({ ...q });
    rows.value = res.items;
    total.value = res.total;
  } finally {
    loading.value = false;
  }
}

function reload() {
  q.page = 1;
  return load();
}

function onPage(p: number) {
  q.page = p;
  load();
}

function onSize(s: number) {
  q.pageSize = s;
  q.page = 1;
  load();
}

function resetFilters() {
  q.tenantId = undefined;
  q.status = undefined;
  reload();
}

// ---------------------------------------------------------------- 出账

type CreateMode = 'plan' | 'fixed' | 'items';

interface LineDraft {
  title: string;
  code: string;
  qty: number;
  priceYuan: number;
}

const emptyLine = (): LineDraft => ({ title: '', code: '', qty: 1, priceYuan: 0 });
const lineCents = (ln: LineDraft) => Math.round(Number(ln.qty ?? 0) * centsOf(ln.priceYuan));

const cd = reactive({
  show: false,
  saving: false,
  tenantId: undefined as number | undefined,
  mode: 'plan' as CreateMode,
  amountYuan: 0,
  items: [emptyLine()] as LineDraft[],
  periodStart: '' as string,
  periodEnd: '' as string,
  currency: 'CNY',
  note: '',
});

const itemsCents = computed(() => cd.items.reduce((a, ln) => a + lineCents(ln), 0));

/** 按套餐出账前先说清楚租户订阅与月费，避免后端「无有效套餐」400 */
const planHint = computed(() => {
  const t = tenants.value.find((x) => x.id === cd.tenantId);
  if (!t) return '不传 items 与 amountCents，后端会按该租户当前套餐月费自动生成单行账单项。';
  if (!t.plan) return `「${t.name}」当前无生效订阅，按套餐出账会被后端拒绝（400），请改用固定金额或手填行项。`;
  return `将按「${t.plan.name}」的月费出账（月费在「套餐配置」页维护），套餐快照会冻结进账单 detail。`;
});

function openCreate() {
  cd.tenantId = q.tenantId;
  cd.mode = 'plan';
  cd.amountYuan = 0;
  cd.items = [emptyLine()];
  cd.periodStart = '';
  cd.periodEnd = '';
  cd.currency = 'CNY';
  cd.note = '';
  cd.show = true;
}

function addItem() {
  cd.items.push(emptyLine());
}

function buildPayload(): CreateInvoicePayload {
  const payload: CreateInvoicePayload = { tenantId: cd.tenantId as number };
  if (cd.mode === 'fixed') payload.amountCents = centsOf(cd.amountYuan);
  if (cd.mode === 'items') {
    payload.items = cd.items
      .filter((ln) => ln.title.trim())
      .map((ln) => ({
        title: ln.title.trim(),
        qty: Number(ln.qty ?? 0),
        unitPriceCents: centsOf(ln.priceYuan),
        ...(ln.code.trim() ? { code: ln.code.trim() } : {}),
      }));
  }
  if (cd.periodStart) payload.periodStart = cd.periodStart;
  if (cd.periodEnd) payload.periodEnd = cd.periodEnd;
  if (cd.currency.trim().length >= 3) payload.currency = cd.currency.trim();
  if (cd.note.trim()) payload.note = cd.note.trim();
  return payload;
}

async function doCreate() {
  if (!cd.tenantId) {
    ElMessage.warning('请先选择租户');
    return;
  }
  if (cd.mode === 'fixed' && centsOf(cd.amountYuan) < 0) {
    ElMessage.warning('金额不能为负');
    return;
  }
  if (cd.mode === 'items' && !cd.items.some((ln) => ln.title.trim())) {
    ElMessage.warning('手填行项至少需要一个带项目名的行');
    return;
  }
  cd.saving = true;
  try {
    const inv = await apiCreateInvoice(buildPayload());
    ElMessage.success(`已生成草稿账单 ${inv.number}（应付 ${money(inv.amountCents)}）`);
    cd.show = false;
    await load();
  } catch {
    /* 拦截器已提示（如「该租户无有效套餐，无法自动出账」） */
  } finally {
    cd.saving = false;
  }
}

// ---------------------------------------------------------------- 发出

const issue = reactive({
  show: false,
  saving: false,
  invoice: null as Invoice | null,
  dueDays: 15,
});

function openIssue(row: Invoice) {
  issue.invoice = row;
  issue.dueDays = 15;
  issue.show = true;
}

async function doIssue() {
  const inv = issue.invoice;
  if (!inv) return;
  issue.saving = true;
  try {
    const res = await apiIssueInvoice(inv.id, issue.dueDays);
    ElMessage.success(`账单 ${res.number} 已发出，到期日 ${fmtDate(res.dueAt)}`);
    issue.show = false;
    await load();
    if (dt.show && dt.id === inv.id) await loadDetail(res.id);
  } catch {
    /* 拦截器已提示 */
  } finally {
    issue.saving = false;
  }
}

// ---------------------------------------------------------------- 作废

async function doVoid(row: Invoice) {
  try {
    await ElMessageBox.confirm(
      `确认作废账单 ${row.number}（应付 ${money(row.amountCents)}）？已付账单不能作废，`
      + `退款需另开负额账单（V1 手工）。`,
      '作废确认',
      { type: 'warning', confirmButtonText: '确认作废', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  try {
    const res = await apiVoidInvoice(row.id);
    ElMessage.success(`账单 ${res.number} 已作废`);
    await load();
    if (dt.show && dt.id === row.id) await loadDetail(res.id);
  } catch {
    /* 已付账单 400 由拦截器提示 */
  }
}

// ---------------------------------------------------------------- 登记收款

const pm = reactive({
  show: false,
  saving: false,
  invoice: null as Invoice | null,
  amountYuan: 0,
  provider: 'manual' as PaymentProvider,
  providerRef: '',
  note: '',
});

function openPayment(row: Invoice) {
  pm.invoice = row;
  pm.amountYuan = centsToYuan(row.balanceCents ?? row.amountCents);
  pm.provider = 'manual';
  pm.providerRef = '';
  pm.note = '';
  pm.show = true;
}

async function doPayment() {
  const inv = pm.invoice;
  if (!inv) return;
  const amountCents = centsOf(pm.amountYuan);
  if (amountCents <= 0) {
    ElMessage.warning('收款金额需大于 0');
    return;
  }
  pm.saving = true;
  try {
    const res = await apiRegisterPayment(inv.id, {
      amountCents,
      provider: pm.provider,
      ...(pm.providerRef.trim() ? { providerRef: pm.providerRef.trim() } : {}),
      ...(pm.note.trim() ? { note: pm.note.trim() } : {}),
    });
    ElMessage.success(`已登记收款 ${money(amountCents)}，账单 ${res.number} 待收 ${money(res.balanceCents)}`);
    pm.show = false;
    await load();
    if (dt.show && dt.id === inv.id) await loadDetail(res.id);
  } catch {
    /* 拦截器已提示（状态不符 / 金额非法） */
  } finally {
    pm.saving = false;
  }
}

// ---------------------------------------------------------------- 详情抽屉

const dt = reactive({
  show: false,
  loading: false,
  id: 0,
  invoice: null as InvoiceDetail | null,
});

async function openDetail(id: number) {
  dt.id = id;
  dt.show = true;
  await loadDetail(id);
}

async function loadDetail(id: number) {
  dt.loading = true;
  try {
    dt.invoice = await apiInvoiceDetail(id);
  } catch {
    /* 拦截器已提示 */
  } finally {
    dt.loading = false;
  }
}

/** 对账自检：应付 = 已收 + 余额；超额收款会显式提示不平 */
const reconcile = computed(() => {
  const inv = dt.invoice;
  if (!inv) return { ok: false, title: '对账待校验', detail: '' };
  const ok = inv.amountCents === inv.paidCents + inv.balanceCents;
  if (ok) {
    return {
      ok: true,
      title: `对账一致：应付 ${money(inv.amountCents)} = 已收 ${money(inv.paidCents)} + 待收 ${money(inv.balanceCents)}`,
      detail: `共 ${inv.payments.length} 笔收款，逐笔合计与账单口径一致。`,
    };
  }
  return {
    ok: false,
    title: `对账不平：应付 ${money(inv.amountCents)}，已收 ${money(inv.paidCents)}，待收 ${money(inv.balanceCents)}`,
    detail: '已收超过应付（超额收款）或多笔登记后余额已清零，请核对流水后另开红字账单调整。',
  };
});

onMounted(async () => {
  load();
  try {
    tenants.value = await apiListTenants();
  } catch {
    /* 租户列表拉不到不影响账单主体，只少了名称与筛选 */
  }
});
</script>

<style scoped>
.filters { margin-bottom: 8px; }
.pager { margin-top: 12px; display: flex; justify-content: flex-end; }
.sub { font-size: 12px; }
.danger { color: #f56c6c; }
.money { font-weight: 600; font-variant-numeric: tabular-nums; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.opt { display: flex; justify-content: space-between; gap: 12px; }
.tilde { margin: 0 8px; }
.block-title { margin: 18px 0 8px; font-size: 14px; }
.plan-snap { margin-top: 6px; }
.lines { width: 100%; }
.line { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.l-title { flex: 1; }
.l-code { width: 110px; }
.l-num { width: 92px; }
.l-sum { width: 90px; text-align: right; font-size: 12px; }
.line.foot { margin-top: 4px; }
.drawer-actions { display: flex; gap: 8px; margin-top: 18px; }
</style>
