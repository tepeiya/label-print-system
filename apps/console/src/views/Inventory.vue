<template>
  <div class="page">
    <div class="page-head">
      <h2>库存与出入库</h2>
      <div class="head-actions">
        <el-button v-if="canAdjust" type="primary" @click="openMove('in')">+ 入库</el-button>
        <el-button v-if="canAdjust" type="warning" @click="openMove('out')">− 出库</el-button>
        <el-button v-if="canTransfer" @click="openTransfer">⇄ 调拨</el-button>
      </div>
    </div>

    <el-row :gutter="12" class="stat-row">
      <el-col :span="8">
        <el-card shadow="never"><div class="stat">
          <div class="stat-label">库存物料 / 批次</div>
          <div class="stat-value">{{ stats.sku }} <span class="stat-unit">/ {{ stats.batches }}</span></div>
        </div></el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never" :class="{ 'stat-alert': stats.low > 0 }"><div class="stat">
          <div class="stat-label">低于安全库存</div>
          <div class="stat-value">{{ stats.low }}</div>
        </div></el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never" :class="{ 'stat-alert': stats.expiring > 0 }"><div class="stat">
          <div class="stat-label">30 天内到期批次</div>
          <div class="stat-value">{{ stats.expiring }}</div>
        </div></el-card>
      </el-col>
    </el-row>

    <el-tabs v-model="tab" class="inv-tabs">
      <!-- 库存查询 -->
      <el-tab-pane label="库存查询" name="stock">
        <div class="filters">
          <el-input v-model="stockQuery.keyword" placeholder="物料编码 / 名称 / 规格" clearable
                    style="width: 240px" @keyup.enter="loadStock" />
          <el-select v-model="stockQuery.warehouse" placeholder="全部仓库" clearable filterable style="width: 180px">
            <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.code" />
          </el-select>
          <el-select v-model="stockQuery.groupBy" style="width: 130px">
            <el-option label="按物料" value="sku" />
            <el-option label="按批次" value="batch" />
            <el-option label="按仓库" value="warehouse" />
          </el-select>
          <el-checkbox v-model="stockQuery.belowSafety">仅低于安全库存</el-checkbox>
          <el-button type="primary" @click="loadStock">查询</el-button>
        </div>

        <el-table :data="stockRows" v-loading="stockLoading" border stripe size="small">
          <el-table-column prop="code" label="物料编码" min-width="130" />
          <el-table-column prop="name" label="物料名称" min-width="160" />
          <el-table-column v-if="stockQuery.groupBy === 'batch'" prop="batchNo" label="批次" min-width="150" />
          <el-table-column v-if="stockQuery.groupBy === 'batch'" prop="expiresAt" label="到期日" width="120" />
          <el-table-column v-if="stockQuery.groupBy === 'warehouse'" prop="warehouse" label="仓库" min-width="140" />
          <el-table-column prop="qty" label="库存数量" min-width="120" align="right">
            <template #default="{ row }">
              <span :class="{ 'text-danger': row.belowSafety }">{{ fmtQty(row.qty) }}</span>
              <span class="unit"> {{ row.unit }}</span>
            </template>
          </el-table-column>
          <el-table-column v-if="stockQuery.groupBy === 'sku'" prop="safetyStock" label="安全库存" min-width="110" align="right">
            <template #default="{ row }">{{ fmtQty(row.safetyStock) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag v-if="row.belowSafety" type="danger" size="small">低于安全线</el-tag>
              <el-tag v-else type="success" size="small">正常</el-tag>
            </template>
          </el-table-column>
          <template #empty><el-empty description="暂无库存数据" /></template>
        </el-table>
        <div class="table-foot">共 {{ stockRows.length }} 条（最多 100 条）</div>
      </el-tab-pane>

      <!-- 出入库台账 -->
      <el-tab-pane label="出入库台账" name="moves">
        <div class="filters">
          <el-select v-model="moveQuery.kind" placeholder="全部类型" clearable style="width: 140px">
            <el-option label="入库" value="in" />
            <el-option label="出库" value="out" />
            <el-option label="调拨" value="transfer" />
          </el-select>
          <el-input v-model="moveQuery.keyword" placeholder="单号 / 物料 / 批次 / 事由" clearable
                    style="width: 250px" @keyup.enter="loadMoves" />
          <el-date-picker v-model="moveQuery.range" type="daterange" value-format="YYYY-MM-DD"
                          start-placeholder="开始日期" end-placeholder="结束日期" style="width: 260px" />
          <el-select v-model="moveQuery.warehouseId" placeholder="全部仓库" clearable filterable style="width: 180px">
            <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.id" />
          </el-select>
          <el-button type="primary" @click="loadMoves">查询</el-button>
        </div>

        <el-table :data="moveRows" v-loading="moveLoading" border stripe size="small">
          <el-table-column prop="createdAt" label="时间" width="165" />
          <el-table-column prop="moveNo" label="单号" min-width="180" />
          <el-table-column label="类型" width="90">
            <template #default="{ row }">
              <el-tag :type="kindTag(row.kind)" size="small">{{ kindLabel(row.kind) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="materialName" label="物料" min-width="150" />
          <el-table-column prop="warehouse" label="仓库" min-width="120" />
          <el-table-column prop="batchNo" label="批次" min-width="130" />
          <el-table-column prop="locationCode" label="库位" min-width="100">
            <template #default="{ row }">{{ row.locationCode || '—' }}</template>
          </el-table-column>
          <el-table-column prop="qty" label="变动量" min-width="100" align="right">
            <template #default="{ row }">
              <span :class="row.qty >= 0 ? 'text-success' : 'text-danger'">
                {{ row.qty >= 0 ? '+' : '' }}{{ fmtQty(row.qty) }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="变动前 → 后" min-width="150">
            <template #default="{ row }">{{ fmtQty(row.beforeQty) }} → {{ fmtQty(row.afterQty) }}</template>
          </el-table-column>
          <el-table-column prop="reason" label="事由" min-width="160" show-overflow-tooltip />
          <el-table-column prop="operator" label="操作人" width="100" />
          <template #empty><el-empty description="暂无出入库记录" /></template>
        </el-table>
        <div class="table-foot">
          共 {{ moveTotal }} 条
          <el-pagination layout="prev, pager, next" :total="moveTotal" :page-size="20"
                         :current-page="movePage" @current-change="onMovePage" style="margin-left: auto" />
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- 入库 / 出库 -->
    <el-dialog v-model="moveDialog" :title="moveMode === 'in' ? '入库登记' : '出库登记'" width="540px">
      <el-form :model="moveForm" label-width="100px">
        <el-form-item label="物料" required>
          <el-select v-model="moveForm.sku" filterable placeholder="输入编码或名称搜索" style="width: 100%"
                     @change="onMoveSkuChange">
            <el-option v-for="m in materials" :key="m.id" :label="`${m.code} · ${m.name}`" :value="m.code">
              <span>{{ m.code }} · {{ m.name }}</span>
              <span class="option-unit">{{ m.unit }}</span>
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="仓库" required>
          <el-select v-model="moveForm.warehouse" filterable placeholder="选择仓库" style="width: 100%">
            <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.code" />
          </el-select>
        </el-form-item>
        <el-form-item :label="moveMode === 'in' ? '入库批次' : '指定批次'">
          <el-input v-model="moveForm.batchNo" placeholder="留空：入库自动生成批次 / 出库按 FIFO 先到期先出" />
        </el-form-item>
        <el-form-item :label="moveMode === 'in' ? '入库库位' : '出库库位'">
          <el-select v-model="moveForm.locationId" clearable filterable placeholder="留空不指定"
                     :disabled="!moveForm.warehouse" style="width: 100%">
            <el-option v-for="l in locsOf(moveForm.warehouse)" :key="l.id"
                       :label="`${l.code} · ${l.name}`" :value="l.id" />
          </el-select>
        </el-form-item>
        <el-form-item :label="moveMode === 'in' ? '入库数量' : '出库数量'" required>
          <el-input-number v-model="moveForm.qty" :min="0.001" :precision="3" :step="1" style="width: 100%" />
        </el-form-item>
        <el-form-item label="事由" required>
          <el-input v-model="moveForm.reason" :placeholder="moveMode === 'in' ? '如：采购到货 / 退货入库' : '如：销售出库 / 领料'" />
        </el-form-item>
        <el-form-item label="预演">
          <el-checkbox v-model="moveForm.dryRun">只预览影响，不实际改动库存</el-checkbox>
        </el-form-item>
      </el-form>
      <div v-if="preview" class="preview-box">
        <div class="preview-title">预演结果</div>
        <div v-for="(l, i) in preview.lines" :key="i" class="preview-line">
          {{ l.warehouse }} / {{ l.batchNo }}：{{ l.before }} → {{ l.after }}（{{ l.change > 0 ? '+' : '' }}{{ l.change }}）
        </div>
        <div class="preview-note">{{ preview.material.name }} · {{ preview.warehouse.name }}</div>
      </div>
      <template #footer>
        <el-button @click="moveDialog = false">取消</el-button>
        <el-button @click="submitMove(true)" :loading="saving">预演</el-button>
        <el-button type="primary" @click="submitMove(false)" :loading="saving">确认{{ moveMode === 'in' ? '入库' : '出库' }}</el-button>
      </template>
    </el-dialog>

    <!-- 调拨 -->
    <el-dialog v-model="transferDialog" title="跨仓调拨" width="540px">
      <el-form :model="transferForm" label-width="100px">
        <el-form-item label="物料" required>
          <el-select v-model="transferForm.sku" filterable placeholder="输入编码或名称搜索" style="width: 100%"
                     @change="onTransferSkuChange">
            <el-option v-for="m in materials" :key="m.id" :label="`${m.code} · ${m.name}`" :value="m.code" />
          </el-select>
        </el-form-item>
        <el-form-item label="源仓库" required>
          <el-select v-model="transferForm.fromWarehouse" filterable style="width: 100%">
            <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.code" />
          </el-select>
        </el-form-item>
        <el-form-item label="源库位">
          <el-select v-model="transferForm.fromLocationId" clearable filterable placeholder="留空按 FIFO"
                     :disabled="!transferForm.fromWarehouse" style="width: 100%">
            <el-option v-for="l in locsOf(transferForm.fromWarehouse)" :key="l.id"
                       :label="`${l.code} · ${l.name}`" :value="l.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="目标仓库" required>
          <el-select v-model="transferForm.toWarehouse" filterable style="width: 100%">
            <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.code" />
          </el-select>
        </el-form-item>
        <el-form-item label="目标库位">
          <el-select v-model="transferForm.toLocationId" clearable filterable placeholder="留空不指定"
                     :disabled="!transferForm.toWarehouse" style="width: 100%">
            <el-option v-for="l in locsOf(transferForm.toWarehouse)" :key="l.id"
                       :label="`${l.code} · ${l.name}`" :value="l.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="批次">
          <el-input v-model="transferForm.batchNo" placeholder="留空按 FIFO 先到期先出" />
        </el-form-item>
        <el-form-item label="数量" required>
          <el-input-number v-model="transferForm.qty" :min="0.001" :precision="3" :step="1" style="width: 100%" />
        </el-form-item>
        <el-form-item label="事由">
          <el-input v-model="transferForm.reason" placeholder="如：仓间补货" />
        </el-form-item>
        <el-form-item label="预演">
          <el-checkbox v-model="transferForm.dryRun">只预览影响，不实际调拨</el-checkbox>
        </el-form-item>
      </el-form>
      <div v-if="preview" class="preview-box">
        <div class="preview-title">预演结果</div>
        <div v-for="(l, i) in preview.lines" :key="i" class="preview-line">
          {{ l.warehouse }} / {{ l.batchNo }}：{{ l.before }} → {{ l.after }}（{{ l.change > 0 ? '+' : '' }}{{ l.change }}）
        </div>
      </div>
      <template #footer>
        <el-button @click="transferDialog = false">取消</el-button>
        <el-button @click="submitTransfer(true)" :loading="saving">预演</el-button>
        <el-button type="primary" @click="submitTransfer(false)" :loading="saving">确认调拨</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import {
  apiQueryStock, apiLowStock, apiExpiringStock, apiQueryMoves,
  apiInventoryMaterials, apiInventoryWarehouses, apiStockInbound, apiStockOutbound, apiStockTransfer,
  apiMdLocations,
} from '@/api';
import { useAuthStore } from '@/store/auth';

const auth = useAuthStore();
const canAdjust = computed(() => auth.hasPermission('inventory:stock:adjust'));
const canTransfer = computed(() => auth.hasPermission('inventory:stock:transfer'));

const tab = ref('stock');
const warehouses = ref<any[]>([]);
const materials = ref<any[]>([]);
const allLocations = ref<any[]>([]);
/** 入库/出库/调拨表单的库位选项按所选仓库过滤，避免跨仓库位串货 */
const locsOf = (warehouseCode: string) => {
  const w = warehouses.value.find((x) => x.code === warehouseCode);
  return w ? allLocations.value.filter((l) => l.warehouseId === w.id) : [];
};

const stats = reactive({ sku: 0, batches: 0, low: 0, expiring: 0 });
const stockQuery = reactive({ keyword: '', warehouse: '', groupBy: 'sku', belowSafety: false });
const stockRows = ref<any[]>([]);
const stockLoading = ref(false);
const moveQuery = reactive({ kind: '', keyword: '', range: null as string[] | null, warehouseId: undefined as number | undefined });
const moveRows = ref<any[]>([]);
const moveTotal = ref(0);
const movePage = ref(1);
const moveLoading = ref(false);

const moveDialog = ref(false);
const moveMode = ref<'in' | 'out'>('in');
const moveForm = reactive({
  sku: '', warehouse: '', batchNo: '', locationId: undefined as number | undefined,
  qty: 1, reason: '', dryRun: false,
});
const transferDialog = ref(false);
const transferForm = reactive({
  sku: '', fromWarehouse: '', toWarehouse: '', batchNo: '',
  fromLocationId: undefined as number | undefined,
  toLocationId: undefined as number | undefined,
  qty: 1, reason: '', dryRun: false,
});
const saving = ref(false);
const preview = ref<any>(null);

const fmtQty = (v: any) => {
  const n = Number(v ?? 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
};
const kindLabel = (k: string) => ({ in: '入库', out: '出库', transfer: '调拨' }[k] ?? k);
const kindTag = (k: string) => ({ in: 'success', out: 'danger', transfer: 'warning' }[k] ?? 'info');

async function loadBase() {
  try {
    const [ws, ms, ls] = await Promise.all([apiInventoryWarehouses(), apiInventoryMaterials(), apiMdLocations()]);
    warehouses.value = ws || [];
    materials.value = ms || [];
    allLocations.value = ls || [];
  } catch { /* 拦截器已提示 */ }
}

async function loadStats() {
  try {
    const [sku, batches, low, expiring] = await Promise.all([
      apiQueryStock({ groupBy: 'sku', limit: 100 }),
      apiQueryStock({ groupBy: 'batch', limit: 100 }),
      apiLowStock(),
      apiExpiringStock({ days: 30, limit: 100 }),
    ]);
    stats.sku = sku?.total ?? 0;
    stats.batches = batches?.total ?? 0;
    stats.low = low?.total ?? 0;
    stats.expiring = expiring?.total ?? 0;
  } catch { /* 拦截器已提示 */ }
}

async function loadStock() {
  stockLoading.value = true;
  try {
    const r = await apiQueryStock({
      keyword: stockQuery.keyword || undefined,
      warehouse: stockQuery.warehouse || undefined,
      groupBy: stockQuery.groupBy,
      belowSafety: stockQuery.belowSafety ? 'true' : undefined,
      limit: 100,
    });
    stockRows.value = r?.items || [];
  } finally { stockLoading.value = false; }
}

async function loadMoves() {
  moveLoading.value = true;
  try {
    const r = await apiQueryMoves({
      kind: moveQuery.kind || undefined,
      keyword: moveQuery.keyword || undefined,
      warehouseId: moveQuery.warehouseId,
      from: moveQuery.range?.[0],
      to: moveQuery.range?.[1],
      limit: 20,
      offset: (movePage.value - 1) * 20,
    });
    moveRows.value = r?.items || [];
    moveTotal.value = r?.total ?? 0;
  } finally { moveLoading.value = false; }
}

function onMovePage(p: number) { movePage.value = p; loadMoves(); }

function resetMove() {
  moveForm.sku = ''; moveForm.warehouse = ''; moveForm.batchNo = ''; moveForm.locationId = undefined;
  moveForm.qty = 1; moveForm.reason = ''; moveForm.dryRun = false;
  preview.value = null;
}

/** 选产品后按产品/分组默认位置联动仓库与库位 */
function onMoveSkuChange(code: string) {
  const m = materials.value.find((x) => x.code === code);
  if (!m) return;
  if (m.defaultWarehouseId) {
    const w = warehouses.value.find((x) => x.id === m.defaultWarehouseId);
    if (w) moveForm.warehouse = w.code;
  }
  moveForm.locationId = m.defaultLocationId ?? undefined;
}
function onTransferSkuChange(code: string) {
  const m = materials.value.find((x) => x.code === code);
  if (!m?.defaultWarehouseId) return;
  const w = warehouses.value.find((x) => x.id === m.defaultWarehouseId);
  if (w) transferForm.fromWarehouse = w.code;
  transferForm.fromLocationId = m.defaultLocationId ?? undefined;
}

function openMove(mode: 'in' | 'out') {
  moveMode.value = mode;
  resetMove();
  moveDialog.value = true;
}

function openTransfer() {
  transferForm.sku = ''; transferForm.fromWarehouse = ''; transferForm.toWarehouse = '';
  transferForm.batchNo = ''; transferForm.fromLocationId = undefined; transferForm.toLocationId = undefined;
  transferForm.qty = 1; transferForm.reason = ''; transferForm.dryRun = false;
  preview.value = null;
  transferDialog.value = true;
}

async function submitMove(dry: boolean) {
  if (!moveForm.sku || !moveForm.warehouse || !moveForm.qty || moveForm.reason.length < 2) {
    ElMessage.warning('请填物料、仓库、数量与事由（至少 2 字）');
    return;
  }
  saving.value = true;
  try {
    const payload = {
      sku: moveForm.sku, warehouse: moveForm.warehouse, batchNo: moveForm.batchNo || undefined,
      locationId: moveForm.locationId,
      delta: moveForm.qty, reason: moveForm.reason, dryRun: dry ? 'true' : String(moveForm.dryRun),
    };
    const r = await (moveMode.value === 'in' ? apiStockInbound(payload) : apiStockOutbound(payload));
    if (dry || moveForm.dryRun) {
      preview.value = r;
      ElMessage.success('预演完成，未改动库存');
      return;
    }
    ElMessage.success(moveMode.value === 'in' ? '入库成功' : '出库成功');
    moveDialog.value = false;
    await Promise.all([loadStock(), loadMoves(), loadStats()]);
    tab.value = 'moves';
  } finally { saving.value = false; }
}

async function submitTransfer(dry: boolean) {
  if (!transferForm.sku || !transferForm.fromWarehouse || !transferForm.toWarehouse || !transferForm.qty) {
    ElMessage.warning('请填物料、源仓、目标仓与数量');
    return;
  }
  if (transferForm.fromWarehouse === transferForm.toWarehouse) {
    ElMessage.warning('源仓与目标仓不能相同');
    return;
  }
  saving.value = true;
  try {
    const r = await apiStockTransfer({
      sku: transferForm.sku,
      fromWarehouse: transferForm.fromWarehouse,
      toWarehouse: transferForm.toWarehouse,
      batchNo: transferForm.batchNo || undefined,
      fromLocationId: transferForm.fromLocationId,
      toLocationId: transferForm.toLocationId,
      qty: transferForm.qty,
      reason: transferForm.reason || undefined,
      dryRun: dry ? 'true' : String(transferForm.dryRun),
    });
    if (dry || transferForm.dryRun) {
      preview.value = r;
      ElMessage.success('预演完成，未实际调拨');
      return;
    }
    ElMessage.success('调拨成功');
    transferDialog.value = false;
    await Promise.all([loadStock(), loadMoves(), loadStats()]);
    tab.value = 'moves';
  } finally { saving.value = false; }
}

onMounted(async () => {
  await loadBase();
  await Promise.all([loadStock(), loadMoves(), loadStats()]);
});
</script>

<style scoped>
.page-head { display: flex; align-items: center; justify-content: space-between; }
.head-actions { display: flex; gap: 8px; }
.stat-row { margin-bottom: 12px; }
.stat { padding: 4px 6px; }
.stat-label { color: #909399; font-size: 13px; }
.stat-value { font-size: 24px; font-weight: 600; margin-top: 4px; }
.stat-unit { font-size: 14px; font-weight: 400; color: #909399; }
.stat-alert .stat-value { color: #f56c6c; }
.filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 12px; }
.table-foot { display: flex; align-items: center; gap: 8px; margin-top: 10px; color: #909399; font-size: 12px; }
.unit { color: #909399; }
.text-danger { color: #f56c6c; }
.text-success { color: #67c23a; }
.option-unit { float: right; color: #909399; }
.preview-box { background: #f4f4f5; border-radius: 4px; padding: 10px 12px; font-size: 13px; }
.preview-title { font-weight: 600; margin-bottom: 6px; }
.preview-line { line-height: 1.8; }
.preview-note { color: #909399; margin-top: 4px; }
</style>
