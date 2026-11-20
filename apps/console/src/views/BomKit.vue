<template>
  <div class="page">
    <div class="page-head">
      <h2>BOM 齐套率</h2>
      <div class="head-actions">
        <el-button v-if="canWrite" type="primary" size="small" @click="openBom()">+ 新建 BOM</el-button>
      </div>
    </div>

    <el-tabs v-model="tab" class="bom-tabs">
      <!-- ============ 齐套查询 ============ -->
      <el-tab-pane label="齐套查询" name="kit">
        <div class="filters">
          <el-select v-model="kitForm.product" filterable clearable placeholder="选择产品（编码/名称）"
                     style="width: 260px">
            <el-option v-for="m in materials" :key="m.id" :label="`${m.code} ${m.name}`" :value="m.code" />
          </el-select>
          <el-input-number v-model="kitForm.demand" :min="1" :max="999999" :step="1" style="width: 140px" />
          <el-select v-model="kitForm.warehouse" filterable clearable placeholder="全部仓库"
                     style="width: 180px">
            <el-option v-for="w in warehouses" :key="w.id" :label="w.name" :value="w.code || String(w.id)" />
          </el-select>
          <el-button type="primary" :loading="kitLoading" :disabled="!kitForm.product" @click="runCheck">计算齐套</el-button>
        </div>

        <template v-if="kit">
          <el-row :gutter="12" class="stat-row">
            <el-col :span="6">
              <el-card shadow="never" :class="{ 'stat-good': kit.kitRate >= 100, 'stat-alert': kit.kitRate < 100 }">
                <div class="stat"><div class="stat-label">齐套率</div>
                  <div class="stat-value">{{ kit.kitRate }}<span class="stat-unit">%</span></div></div>
              </el-card>
            </el-col>
            <el-col :span="6">
              <el-card shadow="never"><div class="stat"><div class="stat-label">可配套数</div>
                <div class="stat-value">{{ kit.maxSets }} <span class="stat-unit">/ {{ kit.demand }}</span></div></div>
              </el-card>
            </el-col>
            <el-col :span="6">
              <el-card shadow="never"><div class="stat"><div class="stat-label">BOM 版本</div>
                <div class="stat-value stat-value-sm">{{ kit.bom?.version || '—' }}</div></div>
              </el-card>
            </el-col>
            <el-col :span="6">
              <el-card shadow="never"><div class="stat"><div class="stat-label">缺料项</div>
                <div class="stat-value" :class="{ 'text-danger': kit.shortages?.length }">{{ kit.shortages?.length || 0 }}</div></div>
              </el-card>
            </el-col>
          </el-row>

          <el-alert v-if="kit.summary" :title="kit.summary" type="warning" show-icon
                    :closable="false" class="kit-summary" />
          <el-alert v-else-if="kit.kitRate >= 100" title="库存齐套，可按需求投产。" type="success" show-icon
                    :closable="false" class="kit-summary" />

          <el-table :data="kit.lines" border stripe size="small" class="kit-table">
            <el-table-column prop="code" label="物料编码" min-width="120" />
            <el-table-column prop="name" label="物料名称" min-width="150" />
            <el-table-column label="单件用量" width="110" align="right">
              <template #default="{ row }">{{ fmtQty(row.qtyPer) }}</template>
            </el-table-column>
            <el-table-column label="损耗率" width="90" align="right">
              <template #default="{ row }">{{ (row.lossRate * 100).toFixed(1) }}%</template>
            </el-table-column>
            <el-table-column label="应耗量" min-width="110" align="right">
              <template #default="{ row }">{{ fmtQty(row.needed) }} {{ row.unit }}</template>
            </el-table-column>
            <el-table-column label="可用库存" min-width="110" align="right">
              <template #default="{ row }">{{ fmtQty(row.available) }} {{ row.unit }}</template>
            </el-table-column>
            <el-table-column label="缺口" min-width="110" align="right">
              <template #default="{ row }">
                <span :class="{ 'text-danger': row.shortage > 0 }">
                  {{ row.shortage > 0 ? fmtQty(row.shortage) : '—' }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.ok ? 'success' : 'danger'" size="small">{{ row.ok ? '齐套' : '缺料' }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </template>
        <el-empty v-else description="选择产品与需求量后点击「计算齐套」" :image-size="80" />
      </el-tab-pane>

      <!-- ============ 缺料明细 ============ -->
      <el-tab-pane label="缺料明细" name="shortage">
        <div class="filters">
          <el-select v-model="shortForm.product" filterable clearable placeholder="选择产品"
                     style="width: 260px">
            <el-option v-for="m in materials" :key="m.id" :label="`${m.code} ${m.name}`" :value="m.code" />
          </el-select>
          <el-input-number v-model="shortForm.demand" :min="1" :max="999999" :step="1" style="width: 140px" />
          <el-button type="primary" :loading="shortLoading" :disabled="!shortForm.product" @click="runShortage">查缺料</el-button>
        </div>

        <template v-if="shortage">
          <el-alert :title="shortage.summary || '无缺料，库存齐套。'"
                    :type="shortage.summary ? 'warning' : 'success'" show-icon
                    :closable="false" class="kit-summary" />
          <el-table :data="shortage.items" border stripe size="small">
            <el-table-column prop="code" label="物料编码" min-width="120" />
            <el-table-column prop="name" label="物料名称" min-width="150" />
            <el-table-column label="应耗量" min-width="110" align="right">
              <template #default="{ row }">{{ fmtQty(row.needed) }} {{ row.unit }}</template>
            </el-table-column>
            <el-table-column label="可用库存" min-width="110" align="right">
              <template #default="{ row }">{{ fmtQty(row.available) }} {{ row.unit }}</template>
            </el-table-column>
            <el-table-column label="缺口" min-width="110" align="right">
              <template #default="{ row }"><span class="text-danger">{{ fmtQty(row.shortage) }} {{ row.unit }}</span></template>
            </el-table-column>
          </el-table>
        </template>
        <el-empty v-else description="选择产品与需求量后点击「查缺料」" :image-size="80" />
      </el-tab-pane>

      <!-- ============ BOM 维护 ============ -->
      <el-tab-pane label="BOM 维护" name="boms">
        <div class="rule-head">
          <el-input v-model="bomKeyword" placeholder="按产品编码/名称过滤" clearable style="width: 240px"
                    @keyup.enter="loadBoms" />
          <el-button @click="loadBoms">查询</el-button>
          <span class="hint">同一产品最多一个启用中的 BOM；启用新版本会自动停用旧版本。</span>
        </div>
        <el-table :data="boms" v-loading="bomLoading" border stripe size="small">
          <el-table-column prop="id" label="ID" width="70" />
          <el-table-column label="产品" min-width="180">
            <template #default="{ row }">{{ row.productCode }} {{ row.productName }}</template>
          </el-table-column>
          <el-table-column prop="version" label="版本" width="100" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="row.status === 'active' ? 'success' : (row.status === 'draft' ? 'info' : 'warning')" size="small">
                {{ statusText(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="明细行数" width="100" align="right">
            <template #default="{ row }">{{ row.lines?.length || 0 }}</template>
          </el-table-column>
          <el-table-column prop="createdAt" label="创建时间" min-width="170">
            <template #default="{ row }">{{ fmtDate(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="230" fixed="right">
            <template #default="{ row }">
              <template v-if="canWrite">
                <el-button link type="primary" size="small" @click="openBom(row)">编辑</el-button>
                <el-button v-if="row.status !== 'active'" link type="success" size="small"
                           @click="changeStatus(row, 'active')">启用</el-button>
                <el-button v-else link size="small" @click="changeStatus(row, 'inactive')">停用</el-button>
                <el-button link type="danger" size="small" :disabled="row.status === 'active'"
                           @click="removeBom(row)">删除</el-button>
              </template>
              <span v-else class="muted">只读</span>
            </template>
          </el-table-column>
        </el-table>
        <div class="pager">
          <el-pagination background layout="total" :total="boms.length" :page-size="100" />
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- BOM 编辑弹窗 -->
    <el-dialog v-model="bomDialog" :title="bomForm.id ? '编辑 BOM' : '新建 BOM'" width="760px">
      <el-form label-width="90px" size="small">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="产品" required>
              <el-select v-model="bomForm.product" filterable placeholder="选择产品" style="width: 100%">
                <el-option v-for="m in materials" :key="m.id" :label="`${m.code} ${m.name}`" :value="m.code" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="版本">
              <el-input v-model="bomForm.version" placeholder="如 v1" />
            </el-form-item>
          </el-col>
          <el-col :span="4">
            <el-form-item label="状态">
              <el-select v-model="bomForm.status" style="width: 100%">
                <el-option label="启用" value="active" />
                <el-option label="草稿" value="draft" />
                <el-option label="停用" value="inactive" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>

        <el-divider content-position="left">明细行（单件用量 × (1 + 损耗率)）</el-divider>
        <el-table :data="bomForm.items" size="small" border>
          <el-table-column label="物料" min-width="200">
            <template #default="{ row }">
              <el-select v-model="row.material" filterable placeholder="选择物料" style="width: 100%">
                <el-option v-for="m in materials" :key="m.id" :label="`${m.code} ${m.name}`" :value="m.code" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="单件用量" width="140">
            <template #default="{ row }">
              <el-input-number v-model="row.qtyPer" :min="0" :step="1" :precision="4" controls-position="right" style="width: 100%" />
            </template>
          </el-table-column>
          <el-table-column label="损耗率" width="140">
            <template #default="{ row }">
              <el-input-number v-model="row.lossPercent" :min="0" :max="100" :step="1" :precision="1"
                               controls-position="right" style="width: 100%" />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="70">
            <template #default="{ $index }">
              <el-button link type="danger" size="small" @click="bomForm.items.splice($index, 1)">删</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-button size="small" style="margin-top: 8px" @click="addBomItem">+ 添加明细行</el-button>
      </el-form>
      <template #footer>
        <el-button @click="bomDialog = false">取消</el-button>
        <el-button type="primary" :loading="bomSaving" @click="saveBom">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/store/auth';
import {
  apiBomCheckKit, apiBomShortages, apiBomList, apiBomCreate, apiBomUpdate,
  apiBomStatus, apiBomDelete, apiMdMaterials, apiMdWarehouses,
} from '@/api';

const auth = useAuthStore();
const canWrite = computed(() => auth.hasPermission('bom:bom:write'));

const tab = ref('kit');
const materials = ref<any[]>([]);
const warehouses = ref<any[]>([]);

const fmtQty = (n: number) => Number(n ?? 0).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
const fmtDate = (s: string) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—');
const statusText = (s: string) => (s === 'active' ? '启用' : s === 'draft' ? '草稿' : '停用');

// ---- 齐套查询 ----
const kitForm = reactive({ product: '', demand: 1, warehouse: '' });
const kit = ref<any>(null);
const kitLoading = ref(false);
async function runCheck() {
  kitLoading.value = true;
  try {
    const params: any = { product: kitForm.product, demand: kitForm.demand };
    if (kitForm.warehouse) params.warehouse = kitForm.warehouse;
    kit.value = (await apiBomCheckKit(params)) as any;
  } catch (e: any) { ElMessage.error(e?.message || '计算失败'); }
  finally { kitLoading.value = false; }
}

// ---- 缺料明细 ----
const shortForm = reactive({ product: '', demand: 1 });
const shortage = ref<any>(null);
const shortLoading = ref(false);
async function runShortage() {
  shortLoading.value = true;
  try {
    shortage.value = (await apiBomShortages({
      product: shortForm.product, demand: shortForm.demand,
    })) as any;
  } catch (e: any) { ElMessage.error(e?.message || '查询失败'); }
  finally { shortLoading.value = false; }
}

// ---- BOM 维护 ----
const boms = ref<any[]>([]);
const bomKeyword = ref('');
const bomLoading = ref(false);
const bomDialog = ref(false);
const bomSaving = ref(false);
const bomForm = reactive<any>({ id: undefined, product: '', version: 'v1', status: 'draft', items: [] });

async function loadBoms() {
  bomLoading.value = true;
  try { boms.value = (await apiBomList(bomKeyword.value || undefined)) as any; }
  catch (e: any) { ElMessage.error(e?.message || '加载 BOM 失败'); }
  finally { bomLoading.value = false; }
}

function openBom(row?: any) {
  if (row) {
    bomForm.id = row.id;
    bomForm.product = row.productCode;
    bomForm.version = row.version;
    bomForm.status = row.status;
    bomForm.items = (row.lines || []).map((l: any) => ({
      material: l.code, qtyPer: l.qtyPer, lossPercent: Number((l.lossRate * 100).toFixed(1)),
    }));
  } else {
    bomForm.id = undefined;
    bomForm.product = '';
    bomForm.version = 'v1';
    bomForm.status = 'draft';
    bomForm.items = [];
  }
  bomDialog.value = true;
}

function addBomItem() {
  bomForm.items.push({ material: '', qtyPer: 1, lossPercent: 0 });
}

async function saveBom() {
  if (!bomForm.product) return ElMessage.warning('请选择产品');
  if (!bomForm.items.length) return ElMessage.warning('至少添加一行明细');
  if (bomForm.items.some((i: any) => !i.material)) return ElMessage.warning('每行都需选择物料');
  bomSaving.value = true;
  try {
    const payload = {
      product: bomForm.product,
      version: bomForm.version || 'v1',
      status: bomForm.status,
      items: bomForm.items.map((i: any) => ({
        material: i.material, qtyPer: Number(i.qtyPer), lossRate: Number(i.lossPercent) / 100,
      })),
    };
    if (bomForm.id) await apiBomUpdate(bomForm.id, payload);
    else await apiBomCreate(payload);
    ElMessage.success('已保存');
    bomDialog.value = false;
    await loadBoms();
  } catch (e: any) { ElMessage.error(e?.message || '保存失败'); }
  finally { bomSaving.value = false; }
}

async function changeStatus(row: any, status: 'active' | 'inactive') {
  try {
    await apiBomStatus(row.id, status);
    ElMessage.success(status === 'active' ? '已启用' : '已停用');
    await loadBoms();
  } catch (e: any) { ElMessage.error(e?.message || '操作失败'); }
}

async function removeBom(row: any) {
  try {
    await ElMessageBox.confirm(`确定删除 BOM #${row.id}（${row.productName} ${row.version}）？`, '提示', { type: 'warning' });
    await apiBomDelete(row.id);
    ElMessage.success('已删除');
    await loadBoms();
  } catch (e: any) { if (e !== 'cancel') ElMessage.error(e?.message || '删除失败'); }
}

onMounted(async () => {
  try {
    const [mats, whs]: any[] = await Promise.all([apiMdMaterials(), apiMdWarehouses()]);
    materials.value = Array.isArray(mats) ? mats : (mats?.items || []);
    warehouses.value = Array.isArray(whs) ? whs : (whs?.items || []);
  } catch { /* 下拉为空不阻塞 */ }
  await loadBoms();
});
</script>

<style scoped>
.page { padding: 4px 0; }
.page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.page-head h2 { margin: 0; font-size: 18px; }
.filters { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
.stat-row { margin-bottom: 12px; }
.stat { text-align: center; padding: 6px 0; }
.stat-label { font-size: 12px; color: #909399; }
.stat-value { font-size: 26px; font-weight: 600; line-height: 1.3; }
.stat-value-sm { font-size: 20px; }
.stat-unit { font-size: 14px; color: #909399; font-weight: 400; }
.stat-alert { border-color: #f5c2c7; }
.stat-good { border-color: #a7f3d0; }
.text-danger { color: #d9363e; }
.muted { color: #c0c4cc; }
.kit-summary { margin-bottom: 12px; }
.kit-table { margin-top: 4px; }
.rule-head { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.hint { font-size: 12px; color: #909399; }
.pager { display: flex; justify-content: flex-end; margin-top: 12px; }
</style>
