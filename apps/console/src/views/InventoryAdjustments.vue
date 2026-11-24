<template>
  <div class="page">
    <div class="page-head">
      <h2>库存调整</h2>
      <div class="head-actions">
        <el-button size="small" :loading="loading" @click="load">刷新</el-button>
        <el-button type="primary" @click="openCreate">新建调整单</el-button>
      </div>
    </div>

    <div class="hint" style="margin-bottom: 12px">
      盘盈 / 盘亏 / 报废 / 退货入库 都要开单：填类型 + 原因 + 明细，过账后才动库存。
      过账仍走原来的库存写路径（FIFO、批次、台账），只是给这笔账补上了单号与凭证。
    </div>

    <div class="filters">
      <el-select v-model="query.status" placeholder="全部状态" clearable style="width: 140px" @change="onFilter">
        <el-option v-for="s in STATUS_LIST" :key="s" :label="statusText(s)" :value="s" />
      </el-select>
      <el-select v-model="query.adjustType" placeholder="全部类型" clearable style="width: 140px" @change="onFilter">
        <el-option v-for="t in TYPE_LIST" :key="t" :label="typeText(t)" :value="t" />
      </el-select>
      <el-input v-model="query.keyword" placeholder="单号 / 原因" clearable style="width: 220px"
                @keyup.enter="onFilter" />
      <el-button type="primary" @click="onFilter">查询</el-button>
    </div>

    <el-table :data="rows" size="small" border v-loading="loading" empty-text="还没有调整单">
      <el-table-column prop="adjustNo" label="单号" width="170" />
      <el-table-column label="类型" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="typeTag(row.adjustType)">{{ row.adjustTypeText }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="warehouse" label="仓库" min-width="140" show-overflow-tooltip />
      <el-table-column prop="reason" label="原因" min-width="200" show-overflow-tooltip />
      <el-table-column label="行数" width="110">
        <template #default="{ row }">{{ row.doneLines }} / {{ row.lineCount }}</template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="statusTag(row.status)">{{ statusText(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" width="155">
        <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" min-width="150">
        <template #default="{ row }">
          <el-button link size="small" @click="openDetail(row)">详情</el-button>
          <el-button v-if="canEdit && (row.status === 'DRAFT' || row.status === 'PARTIAL')" link size="small"
                     type="primary" @click="confirmPost(row)">过账</el-button>
          <el-button v-if="canEdit && row.status !== 'POSTED' && row.status !== 'CANCELLED'" link size="small"
                     type="danger" @click="confirmCancel(row)">作废</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination v-model:current-page="query.page" :page-size="query.pageSize" :total="total"
                   layout="total, prev, pager, next" style="margin-top: 10px" @current-change="load" />

    <!-- ==================== 新建 ==================== -->
    <el-dialog v-model="createDialog" title="新建库存调整单" width="880px" append-to-body>
      <el-form :model="form" label-width="90px">
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="调整类型" required>
              <el-select v-model="form.adjustType" style="width: 100%" @change="onTypeChange">
                <el-option v-for="t in TYPE_LIST" :key="t" :label="typeText(t)" :value="t" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="仓库" required>
              <el-select v-model="form.warehouseCode" filterable style="width: 100%">
                <el-option v-for="w in warehouses" :key="w.id" :label="`${w.code} · ${w.name}`" :value="w.code" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="原因" required>
              <el-input v-model="form.reason" placeholder="如：10 月盘点差异 / 破损报废" maxlength="200" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="备注">
          <el-input v-model="form.remark" placeholder="选填：谁盘点的、对应哪个盘点计划等" maxlength="300" />
        </el-form-item>
        <div class="dir-hint">{{ dirHint }}</div>

        <div class="line-head">
          <span>明细（{{ form.lines.length }} 行）</span>
          <el-button size="small" :disabled="form.lines.length >= 50" @click="addLine">+ 加一行</el-button>
        </div>

        <el-table :data="form.lines" size="small" border empty-text="至少加一行">
          <el-table-column label="物料" min-width="200">
            <template #default="{ row }">
              <el-select v-model="row.sku" filterable placeholder="编码或名称搜索" style="width: 100%">
                <el-option v-for="m in materials" :key="m.code" :label="`${m.code} · ${m.name}`" :value="m.code" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="批次" width="150">
            <template #default="{ row }">
              <el-input v-model="row.batchNo" placeholder="空=自动/FIFO" />
            </template>
          </el-table-column>
          <el-table-column label="库位" width="150">
            <template #default="{ row }">
              <el-select v-model="row.locationId" clearable filterable placeholder="空=不限" style="width: 100%">
                <el-option v-for="l in locsOf(form.warehouseCode)" :key="l.id" :label="l.code" :value="l.id" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="方向" width="90">
            <template #default="{ row }">
              <el-select v-model="row.dir" :disabled="form.adjustType !== 'OTHER'" style="width: 100%">
                <el-option label="+" value="+" />
                <el-option label="−" value="-" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="数量" width="130">
            <template #default="{ row }">
              <el-input-number v-model="row.qty" :min="0.001" :precision="3" :step="1" style="width: 100%" />
            </template>
          </el-table-column>
          <el-table-column label="" width="60">
            <template #default="{ $index }">
              <el-button link size="small" type="danger" @click="removeLine($index)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div class="line-hint">过账前不会动库存；过账按行执行，某行失败会停在那一行，已成功的行不会假装回滚。</div>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitCreate">保存草稿</el-button>
      </template>
    </el-dialog>

    <!-- ==================== 详情 ==================== -->
    <el-drawer v-model="detailDrawer" :title="`调整单 ${detail?.adjustNo || ''}`" size="720px" append-to-body>
      <template v-if="detail">
        <el-descriptions :column="2" size="small" border>
          <el-descriptions-item label="状态">
            <el-tag size="small" :type="statusTag(detail.status)">{{ statusText(detail.status) }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="类型">{{ detail.adjustTypeText }}</el-descriptions-item>
          <el-descriptions-item label="仓库">{{ detail.warehouse?.code }} {{ detail.warehouse?.name }}</el-descriptions-item>
          <el-descriptions-item label="净变动">{{ detail.netDelta > 0 ? '+' : '' }}{{ detail.netDelta }}</el-descriptions-item>
          <el-descriptions-item label="原因" :span="2">{{ detail.reason }}</el-descriptions-item>
          <el-descriptions-item v-if="detail.remark" label="备注" :span="2">{{ detail.remark }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ fmtTime(detail.createdAt) }}</el-descriptions-item>
          <el-descriptions-item label="过账时间">{{ fmtTime(detail.postedAt) }}</el-descriptions-item>
          <el-descriptions-item v-if="detail.cancelReason" label="作废原因" :span="2">{{ detail.cancelReason }}</el-descriptions-item>
        </el-descriptions>

        <el-table :data="detail.lines" size="small" border style="margin-top: 14px" empty-text="没有明细">
          <el-table-column prop="lineNo" label="行#" width="55" />
          <el-table-column label="物料" min-width="170" show-overflow-tooltip>
            <template #default="{ row }">{{ row.skuCode }} {{ row.materialName }}</template>
          </el-table-column>
          <el-table-column label="批次" width="120">
            <template #default="{ row }">{{ row.batchNo || '自动/FIFO' }}</template>
          </el-table-column>
          <el-table-column label="增减" width="95" align="right">
            <template #default="{ row }">
              <span :class="row.qtyDelta > 0 ? 'text-success' : 'text-danger'">
                {{ row.qtyDelta > 0 ? '+' : '' }}{{ row.qtyDelta }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="变动前→后" width="130">
            <template #default="{ row }">
              <span v-if="row.qtyBefore != null">{{ row.qtyBefore }} → {{ row.qtyAfter }}</span>
              <span v-else>-</span>
            </template>
          </el-table-column>
          <el-table-column label="行状态" min-width="150">
            <template #default="{ row }">
              <el-tag size="small" :type="lineTag(row.status)">{{ lineText(row.status) }}</el-tag>
              <span v-if="row.error" class="err" :title="row.error">{{ row.error }}</span>
            </template>
          </el-table-column>
        </el-table>

        <div v-if="detail.status === 'PARTIAL'" class="warn-box">
          部分行过账失败：成功的行已在库存里生效，失败行修正后点「过账」可继续处理剩余行。
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiInventoryMaterials, apiInventoryWarehouses, apiMdLocations } from '@/api';
import {
  apiListAdjustments, apiGetAdjustment, apiCreateAdjustment, apiPostAdjustment, apiCancelAdjustment,
  type AdjustDoc, type AdjustType,
} from '@/api/inventory-adjustments';
import { useAuthStore } from '@/store/auth';

const auth = useAuthStore();
const canEdit = computed(() => auth.hasPermission('inventory:stock:adjust'));

const TYPE_LIST: AdjustType[] = ['GAIN', 'LOSS', 'DAMAGE', 'RETURN', 'OTHER'];
const STATUS_LIST = ['DRAFT', 'PARTIAL', 'POSTED', 'CANCELLED'];
const TYPE_TEXT: Record<string, string> = { GAIN: '盘盈', LOSS: '盘亏', DAMAGE: '报废', RETURN: '退货入库', OTHER: '其他调整' };
const STATUS_TEXT: Record<string, string> = { DRAFT: '待过账', PARTIAL: '部分过账', POSTED: '已过账', CANCELLED: '已作废' };
const LINE_TEXT: Record<string, string> = { PENDING: '待过账', DONE: '已过账', FAILED: '失败' };
const typeText = (t?: string) => (t ? (TYPE_TEXT[t] ?? t) : '-');
const statusText = (s?: string) => (s ? (STATUS_TEXT[s] ?? s) : '-');
const lineText = (s?: string) => (s ? (LINE_TEXT[s] ?? s) : '-');
const typeTag = (t: string) => ({ GAIN: 'success', RETURN: 'success', LOSS: 'danger', DAMAGE: 'warning' }[t] ?? 'info');
const statusTag = (s: string) => ({ DRAFT: 'info', PARTIAL: 'warning', POSTED: 'success', CANCELLED: 'danger' }[s] ?? 'info');
const lineTag = (s: string) => ({ PENDING: 'info', DONE: 'success', FAILED: 'danger' }[s] ?? 'info');

const QUERY = { status: '', adjustType: '', keyword: '', page: 1, pageSize: 20 };
const query = reactive({ ...QUERY });
const rows = ref<any[]>([]);
const total = ref(0);
const loading = ref(false);

const warehouses = ref<any[]>([]);
const materials = ref<any[]>([]);
const allLocations = ref<any[]>([]);
const locsOf = (warehouseCode: string) => {
  const w = warehouses.value.find((x) => x.code === warehouseCode);
  return w ? allLocations.value.filter((l) => l.warehouseId === w.id) : [];
};

const createDialog = ref(false);
const saving = ref(false);
const form = reactive({
  adjustType: 'GAIN' as AdjustType,
  warehouseCode: '',
  reason: '',
  remark: '',
  lines: [] as Array<{ sku: string; batchNo: string; locationId?: number; dir: '+' | '-'; qty: number }>,
});

const detailDrawer = ref(false);
const detail = ref<AdjustDoc | null>(null);

const dirHint = computed(() => {
  const t = form.adjustType;
  if (t === 'GAIN') return '盘盈：只能增加库存（方向固定 +），一般来自盘点发现实物多于账面。';
  if (t === 'RETURN') return '退货入库：只能增加库存（方向固定 +），客户/车间退回。';
  if (t === 'LOSS') return '盘亏：只能减少库存（方向固定 −），盘点发现实物少于账面。';
  if (t === 'DAMAGE') return '报废：只能减少库存（方向固定 −），破损/过期销毁。';
  return '其他调整：方向可正可负，请在原因里写清楚业务背景（非盘点类调整都走这里）。';
});

const fmtTime = (v?: string | null) => {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function load() {
  loading.value = true;
  try {
    const r = await apiListAdjustments({
      status: query.status || undefined, adjustType: query.adjustType || undefined,
      keyword: query.keyword || undefined, page: query.page, pageSize: query.pageSize,
    });
    rows.value = r?.items ?? [];
    total.value = r?.total ?? 0;
  } catch (e: any) { ElMessage.error(e?.message || '加载调整单失败'); }
  finally { loading.value = false; }
}
function onFilter() { query.page = 1; load(); }

async function loadBase() {
  try {
    const [ws, ms, ls] = await Promise.all([apiInventoryWarehouses(), apiInventoryMaterials(), apiMdLocations()]);
    warehouses.value = ws || [];
    materials.value = ms || [];
    allLocations.value = ls || [];
  } catch { /* 拦截器已提示 */ }
}

function openCreate() {
  form.adjustType = 'GAIN'; form.warehouseCode = ''; form.reason = ''; form.remark = '';
  form.lines = [{ sku: '', batchNo: '', locationId: undefined, dir: '+', qty: 1 }];
  createDialog.value = true;
}

/** 类型决定方向：盘盈/退货只能 +，盘亏/报废只能 − */
function onTypeChange(t: AdjustType) {
  const dir: '+' | '-' = t === 'GAIN' || t === 'RETURN' ? '+' : t === 'LOSS' || t === 'DAMAGE' ? '-' : '+';
  if (t !== 'OTHER') form.lines.forEach((l) => { l.dir = dir; });
}

function addLine() {
  const dir: '+' | '-' = form.adjustType === 'LOSS' || form.adjustType === 'DAMAGE' ? '-' : '+';
  form.lines.push({ sku: '', batchNo: '', locationId: undefined, dir, qty: 1 });
}
function removeLine(i: number) { form.lines.splice(i, 1); }

async function submitCreate() {
  if (!form.warehouseCode) return ElMessage.warning('请选择仓库');
  if (form.reason.trim().length < 2) return ElMessage.warning('原因至少 2 个字');
  if (!form.lines.length) return ElMessage.warning('至少加一行明细');
  const bad = form.lines.findIndex((l) => !l.sku || !l.qty);
  if (bad >= 0) return ElMessage.warning(`第 ${bad + 1} 行：物料和数量必填`);

  saving.value = true;
  try {
    const doc = await apiCreateAdjustment({
      adjustType: form.adjustType, warehouseCode: form.warehouseCode,
      reason: form.reason.trim(), remark: form.remark.trim() || undefined,
      lines: form.lines.map((l) => ({
        sku: l.sku, batchNo: l.batchNo?.trim() || undefined, locationId: l.locationId,
        qtyDelta: l.dir === '-' ? -Math.abs(l.qty) : Math.abs(l.qty),
      })),
    });
    ElMessage.success(`已保存草稿 ${doc.adjustNo}，确认无误后点「过账」`);
    createDialog.value = false;
    await load();
    detail.value = doc;
    detailDrawer.value = true;
  } catch (e: any) { ElMessage.error(e?.message || '建单失败'); }
  finally { saving.value = false; }
}

async function openDetail(row: any) {
  try {
    detail.value = await apiGetAdjustment(row.id);
    detailDrawer.value = true;
  } catch (e: any) { ElMessage.error(e?.message || '加载详情失败'); }
}

async function confirmPost(row: any) {
  try {
    await ElMessageBox.confirm(
      `确定过账 ${row.adjustNo}？过账后库存立即变动，且不能作废（要冲回得另开一张反方向单）。`,
      '过账确认', { type: 'warning', confirmButtonText: '过账', cancelButtonText: '再看看' },
    );
  } catch { return; }
  try {
    const r = await apiPostAdjustment(row.id);
    if (r.allDone) ElMessage.success(`${row.adjustNo} 已全部过账`);
    else {
      const failed = (r.results || []).find((x: any) => x.status === 'FAILED');
      ElMessage.warning(`部分行未过账：${failed?.message || '见详情'}`);
    }
    await load();
    detail.value = r.adjustment;
    detailDrawer.value = true;
  } catch (e: any) { ElMessage.error(e?.message || '过账失败'); }
}

async function confirmCancel(row: any) {
  let reason = '';
  try {
    const r = await ElMessageBox.prompt('作废原因（会记在单据上）', `作废 ${row.adjustNo}`, {
      confirmButtonText: '作废', cancelButtonText: '取消', inputPlaceholder: '如：建错仓库 / 重复建单',
    });
    reason = r.value || '';
  } catch { return; }
  try {
    const r = await apiCancelAdjustment(row.id, reason);
    ElMessage.success(r.note || '已作废');
    await load();
  } catch (e: any) { ElMessage.error(e?.message || '作废失败'); }
}

onMounted(async () => { await loadBase(); await load(); });
</script>

<style scoped>
.page-head { display: flex; align-items: center; justify-content: space-between; }
.head-actions { display: flex; gap: 8px; }
.filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 12px; }
.hint { color: #909399; font-size: 12px; line-height: 1.7; }
.dir-hint { font-size: 12px; color: #606266; background: #f4f4f5; border-radius: 4px; padding: 8px 10px; margin-bottom: 10px; }
.line-head { display: flex; align-items: center; justify-content: space-between; margin: 6px 0 8px; font-size: 13px; color: #606266; }
.line-hint { font-size: 12px; color: #909399; margin-top: 8px; }
.warn-box { margin-top: 12px; background: #fdf6ec; color: #b88230; font-size: 12px; padding: 8px 10px; border-radius: 4px; }
.text-success { color: #67c23a; }
.text-danger { color: #f56c6c; }
.err { color: #f56c6c; font-size: 12px; margin-left: 6px; }
</style>
