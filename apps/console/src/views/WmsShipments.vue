<template>
  <div class="page">
    <div class="page-head">
      <h2>成品发运</h2>
      <div class="head-actions">
        <el-button size="small" :loading="loading" @click="load">刷新</el-button>
        <el-button type="primary" @click="openCreate">新建发货单</el-button>
      </div>
    </div>

    <div class="hint" style="margin-bottom: 12px">
      成品出库先开单：选客户和明细 → 拣货（可改批次/库位，空着就按 FIFO）→ 出库过账（扣库存、写台账、把 UDI 码置为已出库）→ 签收。
      已出库的单不能作废，客户退回请走退货入库。
    </div>

    <div class="filters">
      <el-select v-model="query.status" placeholder="全部状态" clearable style="width: 140px" @change="onFilter">
        <el-option v-for="s in STATUS_LIST" :key="s" :label="statusText(s)" :value="s" />
      </el-select>
      <el-select v-model="query.shipType" placeholder="全部类型" clearable style="width: 140px" @change="onFilter">
        <el-option v-for="t in TYPE_LIST" :key="t" :label="typeText(t)" :value="t" />
      </el-select>
      <el-input v-model="query.keyword" placeholder="单号 / 客户 / 运单号" clearable style="width: 220px"
                @keyup.enter="onFilter" />
      <el-button type="primary" @click="onFilter">查询</el-button>
    </div>

    <el-table :data="rows" size="small" border v-loading="loading" empty-text="还没有发货单">
      <el-table-column prop="shipmentNo" label="单号" width="165" />
      <el-table-column label="类型" width="100">
        <template #default="{ row }">
          <el-tag size="small" type="info">{{ row.shipTypeText }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="客户" min-width="150" show-overflow-tooltip>
        <template #default="{ row }">{{ row.customerName || row.customerCode || '-' }}</template>
      </el-table-column>
      <el-table-column prop="warehouse" label="仓库" min-width="130" show-overflow-tooltip />
      <el-table-column label="行（拣/发/总）" width="130">
        <template #default="{ row }">{{ row.pickedLines }} / {{ row.shippedLines }} / {{ row.lineCount }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="statusTag(row.status)">{{ row.statusText }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="要求发货" width="110">
        <template #default="{ row }">{{ row.expectedDate || '-' }}</template>
      </el-table-column>
      <el-table-column label="创建时间" width="150">
        <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="90">
        <template #default="{ row }">
          <el-button link size="small" type="primary" @click="openDetail(row.id)">详情</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination v-model:current-page="query.page" :page-size="query.pageSize" :total="total"
                   layout="total, prev, pager, next" style="margin-top: 10px" @current-change="load" />

    <!-- ==================== 新建 ==================== -->
    <el-dialog v-model="createDialog" title="新建发货单" width="980px" append-to-body>
      <el-form :model="form" label-width="82px">
        <el-row :gutter="12">
          <el-col :span="6">
            <el-form-item label="出库类型">
              <el-select v-model="form.shipType" style="width: 100%" @change="onTypeChange">
                <el-option v-for="t in TYPE_LIST" :key="t" :label="typeText(t)" :value="t" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="仓库" required>
              <el-select v-model="form.warehouseCode" filterable style="width: 100%">
                <el-option v-for="w in warehouses" :key="w.id" :label="`${w.code} · ${w.name}`" :value="w.code" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="客户名称" :required="form.shipType === 'SALES'">
              <el-input v-model="form.customerName" placeholder="如：某某医疗器械经销公司" maxlength="120" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="客户编码">
              <el-input v-model="form.customerCode" placeholder="选填：ERP 客户编码" maxlength="60" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="收货地址">
              <el-input v-model="form.shipTo" placeholder="选填：打印发货单用" maxlength="300" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="承运商">
              <el-input v-model="form.carrier" placeholder="选填：顺丰 / 自送" maxlength="80" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="运单号">
              <el-input v-model="form.trackingNo" placeholder="选填" maxlength="120" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="6">
            <el-form-item label="要求发货日">
              <el-date-picker v-model="form.expectedDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="18">
            <el-form-item label="备注">
              <el-input v-model="form.remark" placeholder="选填：合同号、批次要求等" maxlength="300" />
            </el-form-item>
          </el-col>
        </el-row>

        <div class="line-head">
          <span>明细（{{ form.lines.length }} 行）</span>
          <el-button size="small" :disabled="form.lines.length >= 100" @click="addLine">+ 加一行</el-button>
        </div>

        <el-table :data="form.lines" size="small" border empty-text="至少加一行">
          <el-table-column label="物料" min-width="210">
            <template #default="{ row }">
              <el-select v-model="row.sku" filterable placeholder="编码或名称搜索" style="width: 100%">
                <el-option v-for="m in materials" :key="m.code" :label="`${m.code} · ${m.name}`" :value="m.code" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="发货数量" width="120">
            <template #default="{ row }">
              <el-input-number v-model="row.qtyPlan" :min="0.001" :precision="3" :controls="false" style="width: 100%" />
            </template>
          </el-table-column>
          <el-table-column label="指定批次" width="140">
            <template #default="{ row }">
              <el-input v-model="row.batchNo" placeholder="空=FIFO" />
            </template>
          </el-table-column>
          <el-table-column label="托盘/箱码 SSCC" width="170">
            <template #default="{ row }">
              <el-input v-model="row.packSscc" placeholder="选填：出库联动 UDI" maxlength="20" />
            </template>
          </el-table-column>
          <el-table-column label="UDI 码" min-width="200">
            <template #default="{ row }">
              <el-input v-model="row.udiCodesText" placeholder="选填：多个码用逗号/空格分隔" />
            </template>
          </el-table-column>
          <el-table-column label="" width="60">
            <template #default="{ $index }">
              <el-button link size="small" type="danger" :disabled="form.lines.length <= 1"
                         @click="form.lines.splice($index, 1)">删</el-button>
            </template>
          </el-table-column>
        </el-table>

        <div class="warn-box" v-if="!materials.length">
          没有可选物料：请先在「基础资料」建物料，或确认 inventory 模块已订阅。
        </div>
      </el-form>
      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitCreate">建单</el-button>
      </template>
    </el-dialog>

    <!-- ==================== 详情 ==================== -->
    <el-drawer v-model="detailDrawer" :title="detail?.shipmentNo ? `发货单 ${detail.shipmentNo}` : '发货单'" size="72%">
      <div v-if="detail" v-loading="detailLoading">
        <el-descriptions :column="3" size="small" border>
          <el-descriptions-item label="状态">
            <el-tag size="small" :type="statusTag(detail.status)">{{ detail.statusText }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="类型">{{ detail.shipTypeText }}</el-descriptions-item>
          <el-descriptions-item label="仓库">{{ detail.warehouse ? `${detail.warehouse.code} ${detail.warehouse.name}` : '-' }}</el-descriptions-item>
          <el-descriptions-item label="客户">{{ detail.customerName || detail.customerCode || '-' }}</el-descriptions-item>
          <el-descriptions-item label="承运商">{{ detail.carrier || '-' }}</el-descriptions-item>
          <el-descriptions-item label="运单号">{{ detail.trackingNo || '-' }}</el-descriptions-item>
          <el-descriptions-item label="要求发货日">{{ detail.expectedDate || '-' }}</el-descriptions-item>
          <el-descriptions-item label="出库时间">{{ fmtTime(detail.shippedAt) }}</el-descriptions-item>
          <el-descriptions-item label="签收">{{ detail.signedReceiver || '-' }} {{ fmtTime(detail.signedAt) }}</el-descriptions-item>
          <el-descriptions-item label="收货地址" :span="2">{{ detail.shipTo || '-' }}</el-descriptions-item>
          <el-descriptions-item label="备注">{{ detail.remark || '-' }}</el-descriptions-item>
          <el-descriptions-item v-if="detail.cancelReason" label="作废原因" :span="3">{{ detail.cancelReason }}</el-descriptions-item>
        </el-descriptions>

        <div class="actions">
          <el-button size="small" @click="loadRecommend">FIFO 批次推荐</el-button>
          <el-button v-if="canPost" type="primary" size="small" :loading="acting" @click="confirmPost">出库过账</el-button>
          <el-button v-if="canSign" type="success" size="small" :loading="acting" @click="confirmSign">签收</el-button>
          <el-button v-if="canCancel" type="danger" size="small" plain :loading="acting" @click="confirmCancel">作废</el-button>
        </div>

        <el-alert v-if="recommend" type="info" style="margin: 10px 0">
          <template #title>FIFO 建议（仅预览：过账时按真实库存加锁扣减，可跨批次）</template>
          <div v-for="r in recommend.lines" :key="r.lineId" class="rec-line">
            <b>{{ r.lineNo }}. {{ r.skuCode }}</b> · 计划 {{ r.qtyPlan }}
            <span v-if="r.note"> — {{ r.note }}</span>
            <span v-else-if="!r.allocations || !r.allocations.length"> — 无可用批次（缺口 {{ r.shortage }}）</span>
            <span v-else>
              — <el-tag v-for="a in r.allocations" :key="a.batchNo" size="small" style="margin-right: 4px">
                {{ a.batchNo }} × {{ a.qty }}<span v-if="a.expiresAt">（{{ a.expiresAt }}）</span>
              </el-tag>
              <span v-if="r.shortage > 0" class="err">缺口 {{ r.shortage }}</span>
            </span>
          </div>
        </el-alert>

        <el-table :data="detail.lines" size="small" border style="margin-top: 8px" empty-text="没有明细">
          <el-table-column prop="lineNo" label="行" width="50" />
          <el-table-column label="物料" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">{{ row.skuCode }} {{ row.materialName }}</template>
          </el-table-column>
          <el-table-column prop="qtyPlan" label="计划" width="80" />
          <el-table-column prop="qtyPicked" label="已拣" width="80" />
          <el-table-column prop="qtyShipped" label="已发" width="80" />
          <el-table-column label="批次" width="120">
            <template #default="{ row }">{{ row.batchNo || 'FIFO' }}</template>
          </el-table-column>
          <el-table-column label="库位" width="100">
            <template #default="{ row }">{{ row.locationText || '-' }}</template>
          </el-table-column>
          <el-table-column label="SSCC / 码" width="150" show-overflow-tooltip>
            <template #default="{ row }">
              <span>{{ row.packSscc || '' }}</span>
              <span v-if="row.udiCodes?.length" class="err"> +{{ row.udiCodes.length }} 码</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag size="small" :type="lineTag(row.status)">{{ row.statusText }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="余量" width="130" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.qtyAfter != null">{{ row.qtyBefore }} → {{ row.qtyAfter }}</span>
              <span v-else>-</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="110">
            <template #default="{ row }">
              <el-button v-if="canPickLine(row)" link size="small" type="primary" @click="pickLine(row)">拣货</el-button>
              <span v-if="row.error" class="err" :title="row.error">!</span>
            </template>
          </el-table-column>
        </el-table>

        <div v-if="hasUdiWarning" class="warn-box">
          UDI 联动有失败项：库存已扣减（事实已发生），码状态未置「已出库」，请到「UDI 追溯」按码补记或核对后再发货。
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiInventoryMaterials, apiInventoryWarehouses } from '@/api';
import {
  apiListShipments, apiGetShipment, apiCreateShipment, apiRecommendShipment,
  apiPickShipmentLine, apiPostShipment, apiSignShipment, apiCancelShipment,
  type ShipmentDoc, type ShipType,
} from '@/api/wms-shipments';

const TYPE_LIST: ShipType[] = ['SALES', 'TRANSFER', 'SAMPLE', 'OTHER'];
const STATUS_LIST = ['CREATED', 'PICKING', 'PICKED', 'SHIPPED', 'SIGNED', 'CANCELLED'];
const TYPE_TEXT: Record<string, string> = { SALES: '销售出库', TRANSFER: '调拨出库', SAMPLE: '样品/试用', OTHER: '其他出库' };
const STATUS_TEXT: Record<string, string> = {
  CREATED: '待拣货', PICKING: '拣货中', PICKED: '已拣完', SHIPPED: '已出库', SIGNED: '已签收', CANCELLED: '已作废',
};
const typeText = (t?: string) => (t ? (TYPE_TEXT[t] ?? t) : '-');
const statusText = (s?: string) => (s ? (STATUS_TEXT[s] ?? s) : '-');
const statusTag = (s: string) => ({
  CREATED: 'info', PICKING: 'warning', PICKED: 'primary', SHIPPED: 'success', SIGNED: 'success', CANCELLED: 'danger',
}[s] ?? 'info');
const lineTag = (s: string) => ({ PENDING: 'info', PICKED: 'primary', SHIPPED: 'success', SHORT: 'warning', FAILED: 'danger' }[s] ?? 'info');

const QUERY = { status: '', shipType: '', keyword: '', page: 1, pageSize: 20 };
const query = reactive({ ...QUERY });
const rows = ref<any[]>([]);
const total = ref(0);
const loading = ref(false);

const warehouses = ref<any[]>([]);
const materials = ref<any[]>([]);

const createDialog = ref(false);
const saving = ref(false);
const form = reactive({
  shipType: 'SALES' as ShipType,
  warehouseCode: '',
  customerName: '',
  customerCode: '',
  shipTo: '',
  carrier: '',
  trackingNo: '',
  expectedDate: '' as string | '',
  remark: '',
  lines: [] as Array<{ sku: string; qtyPlan: number; batchNo: string; packSscc: string; udiCodesText: string }>,
});

const detailDrawer = ref(false);
const detailLoading = ref(false);
const acting = ref(false);
const detail = ref<ShipmentDoc | null>(null);
const recommend = ref<any | null>(null);

const canPost = computed(() => !!detail.value && ['CREATED', 'PICKING', 'PICKED'].includes(detail.value.status));
const canSign = computed(() => detail.value?.status === 'SHIPPED');
const canCancel = computed(() => !!detail.value && detail.value.status !== 'SHIPPED' && detail.value.status !== 'SIGNED' && detail.value.status !== 'CANCELLED');
const hasUdiWarning = computed(() => {
  if (!detail.value) return false;
  return detail.value.lines.some((l) => {
    const u = l.udiResult;
    if (!u) return false;
    return (u.sscc?.error) || (u.codes?.failed > 0);
  });
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
    const r = await apiListShipments({
      status: query.status || undefined, shipType: query.shipType || undefined,
      keyword: query.keyword || undefined, page: query.page, pageSize: query.pageSize,
    });
    rows.value = r?.items ?? [];
    total.value = r?.total ?? 0;
  } catch (e: any) { ElMessage.error(e?.message || '加载发货单失败'); }
  finally { loading.value = false; }
}
function onFilter() { query.page = 1; load(); }

async function loadBase() {
  try {
    const [ws, ms] = await Promise.all([apiInventoryWarehouses(), apiInventoryMaterials()]);
    warehouses.value = ws || [];
    materials.value = ms || [];
  } catch { /* 拦截器已提示 */ }
}

function openCreate() {
  form.shipType = 'SALES'; form.warehouseCode = ''; form.customerName = ''; form.customerCode = '';
  form.shipTo = ''; form.carrier = ''; form.trackingNo = ''; form.expectedDate = ''; form.remark = '';
  form.lines = [newLine()];
  createDialog.value = true;
}
const newLine = () => ({ sku: '', qtyPlan: 1, batchNo: '', packSscc: '', udiCodesText: '' });
function addLine() { form.lines.push(newLine()); }
function onTypeChange() { /* 类型只影响文案与客户必填，不改明细 */ }

async function submitCreate() {
  if (!form.warehouseCode) return ElMessage.warning('请选择仓库');
  if (form.shipType === 'SALES' && !form.customerName.trim()) return ElMessage.warning('销售出库必须填客户名称');
  if (form.lines.some((l) => !l.sku)) return ElMessage.warning('有明细行还没选物料');
  saving.value = true;
  try {
    const payload = {
      shipType: form.shipType,
      warehouseCode: form.warehouseCode,
      customerName: form.customerName.trim() || undefined,
      customerCode: form.customerCode.trim() || undefined,
      shipTo: form.shipTo.trim() || undefined,
      carrier: form.carrier.trim() || undefined,
      trackingNo: form.trackingNo.trim() || undefined,
      expectedDate: form.expectedDate || undefined,
      remark: form.remark.trim() || undefined,
      lines: form.lines.map((l) => {
        const codes = l.udiCodesText.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
        return {
          sku: l.sku, qtyPlan: Number(l.qtyPlan),
          batchNo: l.batchNo.trim() || undefined,
          packSscc: l.packSscc.trim() || undefined,
          udiCodes: codes.length ? codes : undefined,
        };
      }),
    };
    const doc = await apiCreateShipment(payload);
    createDialog.value = false;
    ElMessage.success(`已建单 ${doc.shipmentNo}`);
    await load();
    openDetail(doc.id);
  } catch (e: any) { ElMessage.error(e?.message || '建单失败'); }
  finally { saving.value = false; }
}

async function openDetail(id: number) {
  detailDrawer.value = true;
  detailLoading.value = true;
  recommend.value = null;
  try {
    detail.value = await apiGetShipment(id);
  } catch (e: any) { ElMessage.error(e?.message || '加载发货单失败'); }
  finally { detailLoading.value = false; }
}

async function refreshDetail() {
  if (!detail.value) return;
  detail.value = await apiGetShipment(detail.value.id);
}

async function loadRecommend() {
  if (!detail.value) return;
  try { recommend.value = await apiRecommendShipment(detail.value.id); }
  catch (e: any) { ElMessage.error(e?.message || '推荐失败'); }
}

const canPickLine = (row: any) => ['PENDING', 'PICKED', 'FAILED'].includes(row.status)
  && !!detail.value && ['CREATED', 'PICKING', 'PICKED'].includes(detail.value.status);

async function pickLine(row: any) {
  if (!detail.value) return;
  try {
    const r = await ElMessageBox.prompt(
      `物料 ${row.skuCode}（计划 ${row.qtyPlan} ${row.unit || ''}）拣货数量；批次留空=出库时按 FIFO`,
      `拣货 · 第 ${row.lineNo} 行`,
      { inputValue: String(row.qtyPicked || row.qtyPlan), inputPattern: /^\d+(\.\d{1,3})?$/, inputErrorMessage: '请输入正数（最多 3 位小数）' },
    );
    const qty = Number(r.value);
    if (!Number.isFinite(qty) || qty <= 0) return ElMessage.warning('拣货数量必须为正数');
    await apiPickShipmentLine(detail.value.id, row.id, { qty, batchNo: row.batchNo || undefined });
    ElMessage.success('已记录拣货');
    await refreshDetail();
  } catch (e: any) {
    if (e === 'cancel' || e === 'close') return;
    ElMessage.error(e?.message || '拣货失败');
  }
}

async function confirmPost() {
  if (!detail.value) return;
  const missing = detail.value.lines.filter((l) => l.status === 'PENDING').length;
  try {
    await ElMessageBox.confirm(
      missing
        ? `还有 ${missing} 行没拣货，将按计划量直接出库（FIFO 扣减）。确认过账？`
        : '确认出库过账？过账后库存立即扣减，单据不能再作废。',
      '出库过账', { type: 'warning' },
    );
  } catch { return; }
  acting.value = true;
  try {
    const res = await apiPostShipment(detail.value.id);
    const failed = res?.results?.filter((r: any) => r.status === 'FAILED') ?? [];
    if (failed.length) {
      ElMessage.warning(`部分行失败：第 ${failed.map((f: any) => f.lineNo).join('、')} 行 —— ${failed[0]?.message || ''}`);
    } else {
      ElMessage.success(`出库完成，合计 ${res?.shippedQty ?? 0}`);
    }
    await refreshDetail();
  } catch (e: any) { ElMessage.error(e?.message || '过账失败'); }
  finally { acting.value = false; }
}

async function confirmSign() {
  if (!detail.value) return;
  try {
    const r = await ElMessageBox.prompt('客户签收人姓名（可留空记「客户签收」）', '签收', { inputValue: '' });
    await apiSignShipment(detail.value.id, r.value || undefined);
    ElMessage.success('已签收');
    await refreshDetail();
  } catch (e: any) {
    if (e === 'cancel' || e === 'close') return;
    ElMessage.error(e?.message || '签收失败');
  }
}

async function confirmCancel() {
  if (!detail.value) return;
  try {
    const r = await ElMessageBox.prompt('作废原因（选填）', '作废发货单', { inputValue: '' });
    await apiCancelShipment(detail.value.id, r.value || undefined);
    ElMessage.success('已作废');
    await refreshDetail();
  } catch (e: any) {
    if (e === 'cancel' || e === 'close') return;
    ElMessage.error(e?.message || '作废失败');
  }
}

onMounted(async () => { await Promise.all([load(), loadBase()]); });
</script>

<style scoped>
.page-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.page-head h2 { margin: 0; font-size: 18px; }
.filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.hint { color: var(--lf-text-2, #6b7280); font-size: 12px; line-height: 1.7; }
.line-head { display: flex; justify-content: space-between; align-items: center; margin: 14px 0 8px; font-weight: 600; }
.actions { display: flex; gap: 8px; margin: 12px 0 4px; flex-wrap: wrap; }
.rec-line { font-size: 12px; line-height: 1.9; }
.err { color: #dc2626; font-size: 12px; margin-left: 4px; }
.warn-box { margin-top: 12px; padding: 10px 12px; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 6px; font-size: 12px; color: #9a3412; }
</style>
