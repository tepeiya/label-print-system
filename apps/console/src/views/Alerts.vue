<template>
  <div class="page">
    <div class="page-head">
      <h2>呆滞 / 效期预警</h2>
      <div class="head-actions">
        <el-button type="primary" :loading="scanning" :disabled="!canConfigure" @click="runScan">
          ⟳ 立即扫描
        </el-button>
      </div>
    </div>

    <el-row :gutter="12" class="stat-row">
      <el-col :span="6">
        <el-card shadow="never"><div class="stat">
          <div class="stat-label">预警总数</div>
          <div class="stat-value">{{ summary.total }}</div>
        </div></el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" :class="{ 'stat-alert': summary.open > 0 }"><div class="stat">
          <div class="stat-label">待处理</div>
          <div class="stat-value">{{ summary.open }}</div>
        </div></el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never" :class="{ 'stat-alert': summary.critical > 0 }"><div class="stat">
          <div class="stat-label">严重</div>
          <div class="stat-value">{{ summary.critical }}</div>
        </div></el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="never"><div class="stat">
          <div class="stat-label">呆滞 / 效期</div>
          <div class="stat-value">{{ summary.byType?.dead_stock || 0 }} <span class="stat-unit">/ {{ summary.byType?.expiring || 0 }}</span></div>
        </div></el-card>
      </el-col>
    </el-row>

    <el-tabs v-model="tab" class="alert-tabs">
      <!-- 预警事件 -->
      <el-tab-pane label="预警事件" name="events">
        <div class="filters">
          <el-input v-model="query.keyword" placeholder="编码 / 名称 / 批次" clearable
                    style="width: 220px" @keyup.enter="loadEvents" />
          <el-select v-model="query.status" placeholder="全部状态" clearable style="width: 130px">
            <el-option label="待处理" value="open" />
            <el-option label="已处理" value="ack" />
            <el-option label="已忽略" value="ignored" />
          </el-select>
          <el-select v-model="query.severity" placeholder="全部级别" clearable style="width: 130px">
            <el-option label="严重" value="critical" />
            <el-option label="警告" value="warning" />
          </el-select>
          <el-select v-model="query.type" placeholder="全部类型" clearable style="width: 130px">
            <el-option label="呆滞" value="dead_stock" />
            <el-option label="效期" value="expiring" />
          </el-select>
          <el-button type="primary" @click="loadEvents">查询</el-button>
        </div>

        <el-table :data="events" v-loading="loading" border stripe size="small">
          <el-table-column label="级别" width="90">
            <template #default="{ row }">
              <el-tag :type="row.severity === 'critical' ? 'danger' : 'warning'" size="small">
                {{ row.severity === 'critical' ? '严重' : '警告' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="code" label="物料编码" min-width="120" />
          <el-table-column prop="name" label="物料名称" min-width="150" />
          <el-table-column prop="batchNo" label="批次" min-width="110" />
          <el-table-column prop="type" label="类型" width="90">
            <template #default="{ row }">
              {{ row.type === 'expiring' ? '效期' : '呆滞' }}
            </template>
          </el-table-column>
          <el-table-column label="库龄 / 呆滞天数" min-width="130" align="right">
            <template #default="{ row }">
              {{ row.ageDays }} / <span :class="{ 'text-danger': row.severity === 'critical' }">{{ row.lastOutDays }}</span> 天
            </template>
          </el-table-column>
          <el-table-column label="距到期" width="100" align="right">
            <template #default="{ row }">
              <span v-if="row.daysToExpire !== null && row.daysToExpire !== undefined">{{ row.daysToExpire }} 天</span>
              <span v-else>—</span>
            </template>
          </el-table-column>
          <el-table-column label="库存" min-width="110" align="right">
            <template #default="{ row }">{{ fmtQty(row.qty) }} {{ row.unit }}</template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="statusTag(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="170" fixed="right">
            <template #default="{ row }">
              <template v-if="row.status === 'open' && canAck">
                <el-button link type="success" size="small" @click="handleAck(row, 'ack')">处理</el-button>
                <el-button link size="small" @click="handleAck(row, 'ignored')">忽略</el-button>
              </template>
              <span v-else class="muted">{{ row.ackBy || '—' }}</span>
            </template>
          </el-table-column>
        </el-table>
        <div class="pager">
          <el-pagination background layout="total, prev, pager, next" :total="total"
                         :page-size="query.limit" :current-page="page"
                         @current-change="onPage" />
        </div>
      </el-tab-pane>

      <!-- 规则配置 -->
      <el-tab-pane label="规则配置" name="rules">
        <div class="rule-head">
          <el-button v-if="canConfigure" type="primary" size="small" @click="openRule()">+ 新建规则</el-button>
          <span class="hint">规则按租户生效；扫描时逐条执行，命中后生成/更新预警事件。</span>
        </div>
        <el-table :data="rules" v-loading="rulesLoading" border stripe size="small">
          <el-table-column prop="name" label="规则名称" min-width="160" />
          <el-table-column prop="type" label="类型" width="100">
            <template #default="{ row }">{{ row.type === 'expiring' ? '效期预警' : '呆滞预警' }}</template>
          </el-table-column>
          <el-table-column label="阈值" min-width="200">
            <template #default="{ row }">
              <template v-if="row.type === 'expiring'">
                临期 {{ row.expiryDays }} 天（{{ row.criticalDays }} 天严重）
              </template>
              <template v-else>
                呆滞 {{ row.idleDays }} 天（{{ row.criticalDays }} 天严重）
              </template>
            </template>
          </el-table-column>
          <el-table-column label="最低数量" width="110" align="right">
            <template #default="{ row }">{{ fmtQty(row.minQty) }}</template>
          </el-table-column>
          <el-table-column prop="category" label="分类过滤" min-width="120">
            <template #default="{ row }">{{ row.category || '全部' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.active ? 'success' : 'info'" size="small">{{ row.active ? '启用' : '停用' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="canConfigure" label="操作" width="200" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="openRule(row)">编辑</el-button>
              <el-button link size="small" @click="toggleRule(row)">{{ row.active ? '停用' : '启用' }}</el-button>
              <el-button link type="danger" size="small" @click="removeRule(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- 规则编辑弹窗 -->
    <el-dialog v-model="ruleDialog" :title="ruleForm.id ? '编辑规则' : '新建规则'" width="480px">
      <el-form :model="ruleForm" label-width="110px" size="small">
        <el-form-item label="规则名称" required>
          <el-input v-model="ruleForm.name" placeholder="如：呆滞90天预警" />
        </el-form-item>
        <el-form-item label="预警类型">
          <el-select v-model="ruleForm.type" style="width: 100%">
            <el-option label="呆滞预警（库龄/动销）" value="dead_stock" />
            <el-option label="效期预警（到期日）" value="expiring" />
          </el-select>
        </el-form-item>
        <template v-if="ruleForm.type === 'dead_stock'">
          <el-form-item label="呆滞天数阈值">
            <el-input-number v-model="ruleForm.idleDays" :min="1" :max="3650" />
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="临期天数阈值">
            <el-input-number v-model="ruleForm.expiryDays" :min="1" :max="365" />
          </el-form-item>
        </template>
        <el-form-item label="严重天数阈值">
          <el-input-number v-model="ruleForm.criticalDays" :min="1" :max="3650" />
          <span class="hint-inline">{{ ruleForm.type === 'expiring' ? '距到期≤该值升级严重' : '呆滞≥该值升级严重' }}</span>
        </el-form-item>
        <el-form-item label="最低数量">
          <el-input-number v-model="ruleForm.minQty" :min="0" :precision="3" :step="1" />
        </el-form-item>
        <el-form-item label="分类过滤">
          <el-input v-model="ruleForm.category" placeholder="留空=全部分类" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button size="small" @click="ruleDialog = false">取消</el-button>
        <el-button type="primary" size="small" :loading="savingRule" @click="saveRule">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/store/auth';
import {
  apiAlertRules, apiAlertCreateRule, apiAlertUpdateRule, apiAlertRuleActive,
  apiAlertDeleteRule, apiAlertScan, apiAlertEvents, apiAlertSummary, apiAlertAck,
} from '@/api';

const auth = useAuthStore();
const canConfigure = computed(() => auth.hasPermission('alert:rule:configure'));
const canAck = computed(() => auth.hasPermission('alert:event:ack'));

const tab = ref('events');
const loading = ref(false);
const scanning = ref(false);
const events = ref<any[]>([]);
const total = ref(0);
const page = ref(1);
const summary = ref<any>({ total: 0, open: 0, ack: 0, ignored: 0, critical: 0, byType: {} });
const query = reactive({ keyword: '', status: '', severity: '', type: '', limit: 20 });

const rules = ref<any[]>([]);
const rulesLoading = ref(false);
const ruleDialog = ref(false);
const savingRule = ref(false);
const blankRule = () => ({
  id: 0, name: '', type: 'dead_stock', idleDays: 90, criticalDays: 180,
  expiryDays: 30, minQty: 0, category: '',
});
const ruleForm = reactive<any>(blankRule());

function fmtQty(v: any) {
  const n = Number(v ?? 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
function statusText(s: string) {
  return s === 'open' ? '待处理' : s === 'ack' ? '已处理' : '已忽略';
}
function statusTag(s: string) {
  return s === 'open' ? 'danger' : s === 'ack' ? 'success' : 'info';
}

async function loadEvents() {
  loading.value = true;
  try {
    const params: any = { ...query, offset: (page.value - 1) * query.limit };
    Object.keys(params).forEach((k) => { if (params[k] === '' || params[k] == null) delete params[k]; });
    const res: any = await apiAlertEvents(params);
    events.value = res?.items || [];
    total.value = res?.total || 0;
    if (res?.summary) summary.value = res.summary;
  } finally { loading.value = false; }
}

async function loadSummary() {
  try { summary.value = (await apiAlertSummary()) as any; } catch { /* 忽略 */ }
}
const onPage = (p: number) => { page.value = p; loadEvents(); };

async function runScan() {
  scanning.value = true;
  try {
    const reports: any = await apiAlertScan();
    const created = (reports || []).reduce((s: number, r: any) => s + (r.created || 0), 0);
    const updated = (reports || []).reduce((s: number, r: any) => s + (r.updated || 0), 0);
    ElMessage.success(`扫描完成：新增 ${created} 条，更新 ${updated} 条`);
    await Promise.all([loadEvents(), loadSummary()]);
  } finally { scanning.value = false; }
}

async function handleAck(row: any, status: 'ack' | 'ignored') {
  let note = '';
  try {
    const r = await ElMessageBox.prompt(
      status === 'ack' ? '确认处理该预警？可填写处理备注' : '确认忽略该预警？',
      status === 'ack' ? '处理预警' : '忽略预警',
      { inputPlaceholder: '处理备注（可选）', inputType: 'textarea', confirmButtonText: '确定', cancelButtonText: '取消' },
    );
    note = r.value || '';
  } catch { return; }
  try {
    await apiAlertAck(row.id, { status, note });
    ElMessage.success(status === 'ack' ? '已标记处理' : '已忽略');
    await Promise.all([loadEvents(), loadSummary()]);
  } catch (e: any) { ElMessage.error(e?.message || '操作失败'); }
}

async function loadRules() {
  rulesLoading.value = true;
  try { rules.value = (await apiAlertRules(true)) as any; }
  finally { rulesLoading.value = false; }
}
function openRule(row?: any) {
  Object.assign(ruleForm, row ? { ...row } : blankRule());
  ruleDialog.value = true;
}
async function saveRule() {
  if (!ruleForm.name) return ElMessage.warning('规则名称必填');
  if (ruleForm.type === 'expiring' && ruleForm.criticalDays < 1) return ElMessage.warning('严重天数阈值须≥1');
  savingRule.value = true;
  try {
    const payload = {
      name: ruleForm.name, type: ruleForm.type,
      idleDays: ruleForm.idleDays, criticalDays: ruleForm.criticalDays,
      expiryDays: ruleForm.expiryDays, minQty: ruleForm.minQty,
      category: ruleForm.category,
    };
    if (ruleForm.id) await apiAlertUpdateRule(ruleForm.id, payload);
    else await apiAlertCreateRule(payload);
    ElMessage.success('已保存'); ruleDialog.value = false; await loadRules();
  } catch (e: any) { ElMessage.error(e?.message || '保存失败'); }
  finally { savingRule.value = false; }
}
async function toggleRule(row: any) {
  try {
    await apiAlertRuleActive(row.id, !row.active);
    ElMessage.success(row.active ? '已停用' : '已启用');
    await loadRules();
  } catch (e: any) { ElMessage.error(e?.message || '操作失败'); }
}
async function removeRule(row: any) {
  try {
    await ElMessageBox.confirm(`确定删除规则「${row.name}」？相关预警事件也会清除。`, '提示', { type: 'warning' });
    await apiAlertDeleteRule(row.id);
    ElMessage.success('已删除');
    await Promise.all([loadRules(), loadEvents(), loadSummary()]);
  } catch { /* 取消 */ }
}

onMounted(() => {
  if (auth.hasPermission('alert:event:read')) loadEvents();
  else loadSummary();
  if (canConfigure.value) loadRules();
});
</script>

<style scoped>
.page { padding: 16px; }
.page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.page-head h2 { margin: 0; font-size: 20px; }
.head-actions { display: flex; gap: 8px; }
.stat-row { margin-bottom: 4px; }
.stat { padding: 6px 4px; }
.stat-label { color: #909399; font-size: 13px; }
.stat-value { font-size: 26px; font-weight: 600; margin-top: 4px; }
.stat-unit { font-size: 15px; color: #909399; font-weight: 400; }
.stat-alert .stat-value { color: #f56c6c; }
.alert-tabs :deep(.el-tabs__content) { overflow: visible; }
.filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.rule-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.hint, .hint-inline { color: #909399; font-size: 12px; }
.hint-inline { margin-left: 8px; }
.pager { display: flex; justify-content: flex-end; margin-top: 12px; }
.text-danger { color: #f56c6c; }
.muted { color: #c0c4cc; font-size: 12px; }
</style>
