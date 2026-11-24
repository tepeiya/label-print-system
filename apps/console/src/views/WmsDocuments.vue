<template>
  <div class="page">
    <div class="page-head">
      <h2>{{ isIssuing ? '工单发料' : '收货与上架' }}</h2>
      <div class="head-actions">
        <el-button size="small" :loading="loading" @click="reload">刷新</el-button>
      </div>
    </div>

    <div class="hint" style="margin-bottom: 12px">
      本页只读：电脑上看 PDA 现场作业产生的单据。新建单据 / 扫码收货 / 发料过账请在 PDA 端操作。
    </div>

    <!-- ==================== 收货与上架 ==================== -->
    <template v-if="!isIssuing">
      <el-tabs v-model="subTab">
        <el-tab-pane label="收货单" name="receipts">
          <div class="filters">
            <el-select v-model="receipt.status" placeholder="全部状态" clearable style="width: 150px" @change="onReceiptFilter">
              <el-option v-for="s in RECEIPT_STATUS" :key="s" :label="statusText(s)" :value="s" />
            </el-select>
            <el-button type="primary" @click="onReceiptFilter">查询</el-button>
          </div>

          <el-table :data="receipts" size="small" border v-loading="loading" empty-text="还没有收货单">
            <el-table-column prop="receiptNo" label="收货单号" width="180" />
            <el-table-column label="来源" width="120">
              <template #default="{ row }">{{ sourceText(row.sourceType) }}</template>
            </el-table-column>
            <el-table-column prop="sourceNo" label="来源单号" width="160" show-overflow-tooltip />
            <el-table-column prop="warehouseId" label="仓库ID" width="90" />
            <el-table-column label="状态" width="110">
              <template #default="{ row }"><el-tag size="small" :type="tagType(row.status)">{{ statusText(row.status) }}</el-tag></template>
            </el-table-column>
            <el-table-column label="创建时间" width="160">
              <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" min-width="90">
              <template #default="{ row }">
                <el-button link size="small" @click="openReceipt(row)">明细</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-pagination v-model:current-page="receipt.page" :page-size="receipt.pageSize" :total="receipt.total"
                         layout="total, prev, pager, next" style="margin-top: 10px" @current-change="loadReceipts" />
        </el-tab-pane>

        <el-tab-pane label="上架任务" name="putaway">
          <div class="filters">
            <el-select v-model="putaway.status" placeholder="全部状态" clearable style="width: 150px" @change="onPutawayFilter">
              <el-option v-for="s in PUTAWAY_STATUS" :key="s" :label="statusText(s)" :value="s" />
            </el-select>
            <el-button type="primary" @click="onPutawayFilter">查询</el-button>
          </div>

          <el-table :data="putawayTasks" size="small" border v-loading="loading" empty-text="还没有上架任务">
            <el-table-column prop="id" label="任务#" width="80" />
            <el-table-column prop="receiptLineId" label="收货行#" width="100" />
            <el-table-column prop="qty" label="数量" width="100" />
            <el-table-column label="建议库位" width="110">
              <template #default="{ row }">{{ row.suggestedLocationId ?? '-' }}</template>
            </el-table-column>
            <el-table-column label="实际库位" width="110">
              <template #default="{ row }">{{ row.actualLocationId ?? '-' }}</template>
            </el-table-column>
            <el-table-column label="状态" width="110">
              <template #default="{ row }"><el-tag size="small" :type="tagType(row.status)">{{ statusText(row.status) }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="recommendReason" label="推荐理由" min-width="160" show-overflow-tooltip />
            <el-table-column label="完成时间" width="160">
              <template #default="{ row }">{{ fmtTime(row.finishedAt) }}</template>
            </el-table-column>
          </el-table>
          <el-pagination v-model:current-page="putaway.page" :page-size="putaway.pageSize" :total="putaway.total"
                         layout="total, prev, pager, next" style="margin-top: 10px" @current-change="loadPutaway" />
        </el-tab-pane>
      </el-tabs>
    </template>

    <!-- ==================== 工单发料 ==================== -->
    <template v-else>
      <div class="filters">
        <el-input v-model="wo.keyword" placeholder="工单号 / 来源单号" clearable style="width: 220px" @keyup.enter="onWoFilter" />
        <el-select v-model="wo.status" placeholder="全部状态" clearable style="width: 150px" @change="onWoFilter">
          <el-option v-for="s in WO_STATUS" :key="s" :label="statusText(s)" :value="s" />
        </el-select>
        <el-button type="primary" @click="onWoFilter">查询</el-button>
      </div>

      <el-table :data="workOrders" size="small" border v-loading="loading" empty-text="还没有发料工单">
        <el-table-column prop="woNo" label="工单号" width="170" />
        <el-table-column prop="sourceNo" label="来源单号" width="150" show-overflow-tooltip />
        <el-table-column prop="productMaterialId" label="产品ID" width="90" />
        <el-table-column prop="warehouseId" label="仓库ID" width="90" />
        <el-table-column prop="demandQty" label="需求数" width="100" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }"><el-tag size="small" :type="tagType(row.status)">{{ statusText(row.status) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="缺料" width="80">
          <template #default="{ row }">
            <el-tag v-if="row.shortageFlag" size="small" type="danger">缺料</el-tag>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" min-width="90">
          <template #default="{ row }">
            <el-button link size="small" @click="openWorkOrder(row)">明细</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination v-model:current-page="wo.page" :page-size="wo.pageSize" :total="wo.total"
                     layout="total, prev, pager, next" style="margin-top: 10px" @current-change="loadWorkOrders" />
    </template>

    <!-- ==================== 收货单明细 ==================== -->
    <el-drawer v-model="receiptDrawer" :title="`收货单 ${receiptDetail?.receiptNo || ''}`" size="620px" append-to-body>
      <template v-if="receiptDetail">
        <el-descriptions :column="2" size="small" border>
          <el-descriptions-item label="状态">{{ statusText(receiptDetail.status) }}</el-descriptions-item>
          <el-descriptions-item label="来源">{{ receiptDetail.sourceType }} / {{ receiptDetail.sourceNo || '-' }}</el-descriptions-item>
          <el-descriptions-item label="仓库ID">{{ receiptDetail.warehouseId }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ fmtTime(receiptDetail.createdAt) }}</el-descriptions-item>
        </el-descriptions>

        <h4 style="margin: 16px 0 8px">收货行</h4>
        <el-table :data="receiptDetail.lines ?? []" size="small" border empty-text="没有收货行">
          <el-table-column prop="lineNo" label="行#" width="60" />
          <el-table-column prop="skuId" label="物料ID" width="90" />
          <el-table-column prop="batchNo" label="批号" width="120" />
          <el-table-column prop="qtyExpected" label="应收" width="80" />
          <el-table-column prop="qtyReceived" label="实收" width="80" />
          <el-table-column label="差异" width="90">
            <template #default="{ row }">
              <span v-if="row.diffType">{{ diffText(row.diffType) }} {{ row.diffQty }}</span>
              <span v-else>-</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">{{ lineText(row.status) }}</template>
          </el-table-column>
        </el-table>

        <h4 style="margin: 16px 0 8px">上架任务</h4>
        <el-table :data="receiptDetail.putawayTasks ?? []" size="small" border empty-text="没有上架任务">
          <el-table-column prop="id" label="任务#" width="70" />
          <el-table-column prop="receiptLineId" label="收货行#" width="90" />
          <el-table-column prop="qty" label="数量" width="80" />
          <el-table-column label="建议库位" width="90">
            <template #default="{ row }">{{ row.suggestedLocationId ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="实际库位" width="90">
            <template #default="{ row }">{{ row.actualLocationId ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">{{ statusText(row.status) }}</template>
          </el-table-column>
        </el-table>
      </template>
    </el-drawer>

    <!-- ==================== 工单明细 ==================== -->
    <el-drawer v-model="woDrawer" :title="`工单 ${woDetail?.woNo || ''}`" size="680px" append-to-body>
      <template v-if="woDetail">
        <el-descriptions :column="2" size="small" border>
          <el-descriptions-item label="状态">{{ statusText(woDetail.status) }}</el-descriptions-item>
          <el-descriptions-item label="成品">{{ woDetail.product?.code }} {{ woDetail.product?.name }}</el-descriptions-item>
          <el-descriptions-item label="需求数">{{ woDetail.demandQty }}</el-descriptions-item>
          <el-descriptions-item label="仓库ID">{{ woDetail.warehouseId }}</el-descriptions-item>
          <el-descriptions-item label="缺料">{{ woDetail.shortageFlag ? '是' : '否' }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ fmtTime(woDetail.createdAt) }}</el-descriptions-item>
        </el-descriptions>

        <h4 style="margin: 16px 0 8px">工单行</h4>
        <el-table :data="woDetail.lines ?? []" size="small" border empty-text="没有工单行">
          <el-table-column prop="lineNo" label="行#" width="55" />
          <el-table-column label="物料" min-width="150" show-overflow-tooltip>
            <template #default="{ row }">{{ row.materialCode }} {{ row.materialName }}</template>
          </el-table-column>
          <el-table-column prop="batchNo" label="批号" width="110" />
          <el-table-column prop="qtyRequired" label="需求" width="80" />
          <el-table-column prop="qtyIssued" label="已发" width="80" />
          <el-table-column prop="qtyShortage" label="缺口" width="80" />
          <el-table-column label="状态" width="95">
            <template #default="{ row }">{{ lineText(row.status) }}</template>
          </el-table-column>
          <el-table-column prop="shortageReason" label="缺料原因" min-width="110" show-overflow-tooltip />
        </el-table>

        <h4 style="margin: 16px 0 8px">发料记录</h4>
        <el-table :data="woDetail.issues ?? []" size="small" border empty-text="还没有发料记录">
          <el-table-column prop="id" label="#" width="60" />
          <el-table-column prop="materialId" label="物料ID" width="90" />
          <el-table-column prop="batchNo" label="批号" width="120" />
          <el-table-column prop="qty" label="数量" width="80" />
          <el-table-column label="库位" width="80">
            <template #default="{ row }">{{ row.locationId ?? '-' }}</template>
          </el-table-column>
          <el-table-column label="时间" width="150">
            <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
          </el-table-column>
        </el-table>

        <template v-if="(woDetail.returns ?? []).length">
          <h4 style="margin: 16px 0 8px">退料记录</h4>
          <el-table :data="woDetail.returns" size="small" border>
            <el-table-column prop="id" label="#" width="60" />
            <el-table-column prop="batchNo" label="批号" width="120" />
            <el-table-column prop="qty" label="数量" width="80" />
            <el-table-column prop="reason" label="原因" min-width="140" show-overflow-tooltip />
            <el-table-column label="时间" width="150">
              <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
            </el-table-column>
          </el-table>
        </template>
      </template>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  apiWmsPutawayTasks, apiWmsReceiptDetail, apiWmsReceipts, apiWmsWorkOrderDetail, apiWmsWorkOrders,
  type WmsPutawayTaskRow, type WmsReceiptRow, type WmsWorkOrderRow,
} from '@/api/wms';

const route = useRoute();

/** 同一组件承载两条路由：/wms-receipts（收货与上架，内含两个子 tab）与 /wms-issuing（工单发料） */
const isIssuing = computed(() => String(route.meta?.tab || 'receipts') === 'issuing');
const subTab = ref('receipts');
const loading = ref(false);

// ---------------- 收货单
// 后端真实流转：CREATED → RECEIVING → RECEIVED → PUTAWAY_DONE；CANCELLED 为终态
const RECEIPT_STATUS = ['CREATED', 'RECEIVING', 'RECEIVED', 'PUTAWAY_DONE', 'CANCELLED'];
const receipt = reactive({ status: '', page: 1, pageSize: 20, total: 0 });
const receipts = ref<WmsReceiptRow[]>([]);
const receiptDrawer = ref(false);
const receiptDetail = ref<any>(null);

async function loadReceipts() {
  loading.value = true;
  try {
    const r = await apiWmsReceipts({ status: receipt.status || undefined, page: receipt.page, pageSize: receipt.pageSize });
    receipts.value = r.items ?? [];
    receipt.total = r.total ?? 0;
  } catch (e: any) { ElMessage.error(e?.message || '加载收货单失败'); }
  finally { loading.value = false; }
}

function onReceiptFilter() { receipt.page = 1; loadReceipts(); }

async function openReceipt(row: WmsReceiptRow) {
  try {
    receiptDetail.value = await apiWmsReceiptDetail(row.id);
    receiptDrawer.value = true;
  } catch (e: any) { ElMessage.error(e?.message || '加载收货单明细失败'); }
}

// ---------------- 上架任务
// 上架任务：PENDING（已生成未指派）→ ASSIGNED（推荐位已下发）→ DONE
const PUTAWAY_STATUS = ['PENDING', 'ASSIGNED', 'DONE', 'CANCELLED'];
const putaway = reactive({ status: '', page: 1, pageSize: 20, total: 0 });
const putawayTasks = ref<WmsPutawayTaskRow[]>([]);

async function loadPutaway() {
  loading.value = true;
  try {
    const r = await apiWmsPutawayTasks({ status: putaway.status || undefined, page: putaway.page, pageSize: putaway.pageSize });
    putawayTasks.value = r.items ?? [];
    putaway.total = r.total ?? 0;
  } catch (e: any) { ElMessage.error(e?.message || '加载上架任务失败'); }
  finally { loading.value = false; }
}

function onPutawayFilter() { putaway.page = 1; loadPutaway(); }

// ---------------- 工单发料
// 工单头状态受 ck_wms_wo_status 约束：无 SHORTAGE/RETURN，缺料体现在 shortageFlag + 行状态 SHORT
const WO_STATUS = ['CREATED', 'RELEASED', 'ISSUING', 'ISSUED', 'CLOSED', 'CANCELLED'];
const wo = reactive({ status: '', keyword: '', page: 1, pageSize: 20, total: 0 });
const workOrders = ref<WmsWorkOrderRow[]>([]);
const woDrawer = ref(false);
const woDetail = ref<any>(null);

async function loadWorkOrders() {
  loading.value = true;
  try {
    const r = await apiWmsWorkOrders({ status: wo.status || undefined, keyword: wo.keyword || undefined, page: wo.page, pageSize: wo.pageSize });
    workOrders.value = r.items ?? [];
    wo.total = r.total ?? 0;
  } catch (e: any) { ElMessage.error(e?.message || '加载工单失败'); }
  finally { loading.value = false; }
}

function onWoFilter() { wo.page = 1; loadWorkOrders(); }

async function openWorkOrder(row: WmsWorkOrderRow) {
  try {
    woDetail.value = await apiWmsWorkOrderDetail(row.id);
    woDrawer.value = true;
  } catch (e: any) { ElMessage.error(e?.message || '加载工单明细失败'); }
}

// ---------------- 通用
const STATUS_TEXT: Record<string, string> = {
  CREATED: '待处理', RECEIVING: '收货中', RECEIVED: '已收货', PUTAWAY_DONE: '已上架',
  CANCELLED: '已取消', PENDING: '待处理', ASSIGNED: '已指派', DONE: '已完成',
  RELEASED: '已下发', ISSUING: '发料中', ISSUED: '已发料', CLOSED: '已关单',
  PARTIAL: '部分发料', SHORT: '缺料',
};

/** 工单行状态与单据头状态口径不同（PENDING 在行里是「待发料」） */
const LINE_TEXT: Record<string, string> = {
  PENDING: '待发料', PARTIAL: '部分发料', DONE: '已发完', SHORT: '缺料',
  RECEIVED: '已收货', PUTAWAY_DONE: '已上架',
};
const lineText = (s?: string | null) => (s ? (LINE_TEXT[s] ?? STATUS_TEXT[s] ?? s) : '-');
const statusText = (s?: string | null) => (s ? (STATUS_TEXT[s] ?? s) : '-');

/** 单据来源类型（后端存英文枚举，页面给中文） */
const SOURCE_TEXT: Record<string, string> = {
  PO: '采购订单', ASN: '到货通知', MES: 'MES 工单', MANUAL: '手工创建', RETURN: '退货', TRANSFER: '调拨',
};
const sourceText = (s?: string | null) => (s ? (SOURCE_TEXT[s] ?? s) : '-');

/** 收货差异类型 */
const DIFF_TEXT: Record<string, string> = { SHORT: '短收', OVER: '溢收', WRONG_SKU: '错料', DAMAGE: '破损' };
const diffText = (s?: string | null) => (s ? (DIFF_TEXT[s] ?? s) : '-');

function tagType(s?: string | null) {
  if (!s) return 'info';
  if (['PUTAWAY_DONE', 'RECEIVED', 'DONE', 'CLOSED', 'ISSUED', 'SHORT'].includes(s)) return s === 'SHORT' ? 'danger' : 'success';
  if (s === 'CANCELLED') return 'danger';
  if (['RECEIVING', 'ISSUING', 'RELEASED', 'ASSIGNED', 'PARTIAL', 'PENDING'].includes(s)) return 'warning';
  return 'info';
}

function fmtTime(v?: string | null) {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function reload() {
  if (isIssuing.value) await loadWorkOrders();
  else if (subTab.value === 'putaway') await loadPutaway();
  else await loadReceipts();
}

onMounted(() => { reload(); });

/** 子 tab 切换时懒加载：首屏只请求当前 tab，切过去再取，避免一次打三个接口 */
watch(subTab, (v) => {
  if (isIssuing.value) return;
  if (v === 'putaway') loadPutaway();
  else loadReceipts();
});

/** 两条路由共用同一组件：从 /wms-issuing 切回 /wms-receipts 时组件不重建，需手动重载 */
watch(isIssuing, () => { subTab.value = 'receipts'; reload(); });
</script>

<style scoped>
.filters { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.hint { color: #909399; font-size: 12px; }
</style>
