<template>
  <div class="page">
    <div class="page-head">
      <h2>UDI 合规申报</h2>
      <div class="head-actions">
        <el-tag v-if="probe" size="small" :type="probe.configured ? 'success' : 'info'">
          国家 UDID：{{ probe.configured ? '已配凭据' : '未配凭据（只能导出文件）' }}
        </el-tag>
        <el-button size="small" :loading="probeLoading" @click="runProbe">连通性自检</el-button>
      </div>
    </div>

    <el-tabs v-model="tab" @tab-change="onTab">
      <!-- ============================ DI 台账 ============================ -->
      <el-tab-pane label="DI 台账" name="di">
        <div class="filters">
          <el-input v-model="diKw" placeholder="搜索 DI / 名称 / 规格 / 注册证号" clearable style="width: 280px" @keyup.enter="loadDi" />
          <el-select v-model="diLevel" placeholder="包装层级" clearable style="width: 130px">
            <el-option label="最小销售单元" value="UNIT" />
            <el-option label="中包装" value="CARTON" />
            <el-option label="托盘" value="PALLET" />
          </el-select>
          <el-button type="primary" @click="loadDi">查询</el-button>
          <el-button @click="openDiEdit(null)">新增 DI</el-button>
          <el-button @click="bulkVisible = true">批量粘贴导入</el-button>
          <span class="hint">一物一 DI：包装层级靠 parentDi 串成 PALLET → CARTON → UNIT</span>
        </div>

        <el-table :data="diRows" size="small" border v-loading="diLoading" max-height="520">
          <el-table-column prop="di" label="DI（GTIN-14）" width="150" />
          <el-table-column prop="name" label="产品名称" min-width="180" show-overflow-tooltip />
          <el-table-column prop="spec" label="规格" min-width="120" show-overflow-tooltip />
          <el-table-column prop="registrationNo" label="注册证号" width="140" show-overflow-tooltip />
          <el-table-column prop="catalogCode" label="分类目录" width="100" />
          <el-table-column label="层级" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="row.packageLevel === 'UNIT' ? '' : 'warning'">
                {{ row.packageLevel }}{{ row.qtyInPackage ? ` × ${Number(row.qtyInPackage)}` : '' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="parentDi" label="上级 DI" width="150" />
          <el-table-column label="操作" width="130" fixed="right">
            <template #default="{ row }">
              <el-button link size="small" @click="openDiEdit(row)">编辑</el-button>
              <el-popconfirm title="从台账删除这个 DI？" @confirm="removeDi(row)">
                <template #reference><el-button link size="small" type="danger">删除</el-button></template>
              </el-popconfirm>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- ============================ 提交前校验 ============================ -->
      <el-tab-pane label="提交前校验" name="validate">
        <div class="filters">
          <el-switch v-model="validateAll" active-text="校验全部台账" />
          <el-input v-if="!validateAll" v-model="validateDis" placeholder="指定 DI，逗号分隔" style="width: 320px" />
          <el-button type="primary" :loading="validating" @click="runValidate">跑规则</el-button>
          <span class="hint">规则：GTIN 校验位 / 必填项 / 分类目录格式 / 发码机构 / 包装层级与上级一致性</span>
        </div>
        <el-alert v-if="validateResult" :type="validateResult.ok ? 'success' : 'error'" :closable="false" show-icon
                  :title="validateResult.ok ? `校验通过（${validateResult.checked} 个 DI）` : `发现 ${errorsCount} 条错误，${warnCount} 条提醒`" />
        <el-table v-if="validateResult?.issues?.length" :data="validateResult.issues" size="small" border style="margin-top: 10px" max-height="480">
          <el-table-column label="级别" width="90">
            <template #default="{ row }"><el-tag size="small" :type="row.level === 'error' ? 'danger' : 'warning'">{{ row.level === 'error' ? '错误' : '提醒' }}</el-tag></template>
          </el-table-column>
          <el-table-column prop="di" label="DI" width="150" />
          <el-table-column prop="field" label="字段" width="130" />
          <el-table-column prop="message" label="问题" />
        </el-table>
      </el-tab-pane>

      <!-- ============================ 召回范围 ============================ -->
      <el-tab-pane label="召回范围" name="recall">
        <div class="filters">
          <el-input v-model="recallForm.gtin" placeholder="GTIN-14" style="width: 160px" />
          <el-input v-model="recallForm.lot" placeholder="批号" style="width: 120px" />
          <el-input v-model="recallForm.serial" placeholder="序列号" style="width: 130px" />
          <el-input v-model="recallForm.sscc" placeholder="包装 SSCC" style="width: 160px" />
          <el-date-picker v-model="recallRange" type="daterange" value-format="YYYY-MM-DD" start-placeholder="入库起" end-placeholder="入库止" style="width: 250px" />
          <el-button type="primary" :loading="recallLoading" @click="runRecall">查影响面</el-button>
          <el-button :disabled="!recallResult" @click="exportRecall">导出召回清单</el-button>
        </div>
        <div class="hint" style="margin-bottom: 8px">至少填一个条件。结果包含命中的单品、所在包装、以及已发料/已发运的下游单据。</div>

        <template v-if="recallResult">
          <el-row :gutter="12" class="stat-row">
            <el-col :span="5"><el-card shadow="never"><div class="stat"><div class="stat-label">命中单品</div><div class="stat-value">{{ recallResult.summary.units }}</div></div></el-card></el-col>
            <el-col :span="5"><el-card shadow="never"><div class="stat"><div class="stat-label">涉及包装</div><div class="stat-value">{{ recallResult.summary.packages }}</div></div></el-card></el-col>
            <el-col :span="7"><el-card shadow="never"><div class="stat"><div class="stat-label">已发料单据</div><div class="stat-value">{{ recallResult.summary.issuedRefs }}</div></div></el-card></el-col>
            <el-col :span="7"><el-card shadow="never"><div class="stat"><div class="stat-label">已发运单据</div><div class="stat-value">{{ recallResult.summary.shippedRefs }}</div></div></el-card></el-col>
          </el-row>
          <el-table :data="recallResult.downstream" size="small" border max-height="240" style="margin-bottom: 12px">
            <el-table-column prop="refType" label="单据类型" width="120" />
            <el-table-column prop="refNo" label="单据号" width="200" />
            <el-table-column prop="units" label="命中件数" width="110" />
            <el-table-column label="最后发生时间" width="200">
              <template #default="{ row }">{{ fmtTime(row.lastAt) }}</template>
            </el-table-column>
          </el-table>
          <el-table :data="recallResult.units" size="small" border max-height="360">
            <el-table-column prop="gtin" label="GTIN" width="150" />
            <el-table-column prop="lot" label="批号" width="120" />
            <el-table-column prop="serial" label="序列号" width="130" />
            <el-table-column prop="expiryDate" label="有效期" width="110" />
            <el-table-column prop="status" label="状态" width="110" />
            <el-table-column prop="packageSscc" label="包装 SSCC" width="170" />
            <el-table-column prop="workOrderNo" label="工单" width="140" />
          </el-table>
        </template>
        <el-empty v-else description="填条件后点「查影响面」" />
      </el-tab-pane>

      <!-- ============================ 申报 ============================ -->
      <el-tab-pane label="申报" name="submit">
        <div class="filters">
          <el-select v-model="submitForm.channel" style="width: 150px">
            <el-option label="NMPA 国家 UDID" value="NMPA" />
            <el-option label="EUDAMED（欧盟）" value="EUDAMED" />
            <el-option label="GUDID（FDA）" value="GUDID" />
            <el-option label="仅生成文件" value="FILE" />
          </el-select>
          <el-select v-model="submitForm.mode" style="width: 150px">
            <el-option label="只校验" value="validate" />
            <el-option label="生成文件" value="file" />
            <el-option label="接口直传" value="api" />
          </el-select>
          <el-input v-model="submitDis" placeholder="DI，逗号分隔（空=全部台账）" style="width: 320px" />
          <el-button type="primary" :loading="submitting" @click="doSubmit">提交</el-button>
          <span class="hint">直传只有 NMPA 有官方 REST 接口；EUDAMED/GUDID 只能生成文件后人工上传</span>
        </div>

        <el-alert v-if="lastSubmission" :type="submitAlertType" :closable="false" show-icon style="margin-bottom: 10px"
                  :title="`最近一次：${lastSubmission.channel} / ${lastSubmission.mode} → ${lastSubmission.status}${lastSubmission.remoteMsg ? ` · ${lastSubmission.remoteMsg}` : ''}`" />

        <el-table :data="subRows" size="small" border max-height="420" v-loading="subLoading">
          <el-table-column prop="id" label="#" width="70" />
          <el-table-column prop="channel" label="渠道" width="110" />
          <el-table-column prop="mode" label="方式" width="100" />
          <el-table-column label="DI 数" width="90"><template #default="{ row }">{{ (row.dis || []).length }}</template></el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="row.status === 'submitted' ? 'success' : (row.status === 'failed' ? 'danger' : 'info')">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="remoteCode" label="返回码" width="130" />
          <el-table-column prop="remoteMsg" label="返回信息" min-width="200" show-overflow-tooltip />
          <el-table-column label="时间" width="170">
            <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- DI 编辑弹窗 -->
    <el-dialog v-model="diDialog" :title="diForm.id ? '编辑 DI' : '新增 DI'" width="640px" append-to-body>
      <el-form label-width="110px" size="small">
        <el-row :gutter="10">
          <el-col :span="12"><el-form-item label="DI（GTIN-14）"><el-input v-model="diForm.di" placeholder="14 位，含校验位" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="产品名称"><el-input v-model="diForm.name" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="规格"><el-input v-model="diForm.spec" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="型号"><el-input v-model="diForm.model" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="注册证号"><el-input v-model="diForm.registrationNo" placeholder="国械注准…/备案号" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="分类目录"><el-input v-model="diForm.catalogCode" placeholder="02-04-01" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="包装层级">
            <el-select v-model="diForm.packageLevel" style="width: 100%">
              <el-option label="UNIT 最小销售单元" value="UNIT" />
              <el-option label="CARTON 中包装" value="CARTON" />
              <el-option label="PALLET 托盘" value="PALLET" />
            </el-select>
          </el-form-item></el-col>
          <el-col :span="12"><el-form-item label="上级 DI"><el-input v-model="diForm.parentDi" placeholder="中包装/托盘才有" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="包装内含数"><el-input-number v-model="diForm.qtyInPackage" :min="0" :precision="3" style="width: 100%" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="发码机构">
            <el-select v-model="diForm.issuingAgency" style="width: 100%">
              <el-option label="GS1" value="GS1" />
              <el-option label="HIBCC" value="HIBCC" />
              <el-option label="ICCBBA" value="ICCBBA" />
            </el-select>
          </el-form-item></el-col>
          <el-col :span="12"><el-form-item label="无菌"><el-switch v-model="diForm.isSterile" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="一次性使用"><el-switch v-model="diForm.isSingleUse" /></el-form-item></el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="diDialog = false">取消</el-button>
        <el-button type="primary" :loading="diSaving" @click="saveDi">保存</el-button>
      </template>
    </el-dialog>

    <!-- 批量粘贴 -->
    <el-dialog v-model="bulkVisible" title="批量粘贴导入" width="720px" append-to-body>
      <div class="hint" style="margin-bottom: 8px">
        每行一条，逗号分隔：<code>DI,名称,规格,型号,注册证号,分类目录,层级(UNIT/CARTON/PALLET),上级DI,包装内含数</code>
      </div>
      <el-input v-model="bulkText" type="textarea" :rows="10" placeholder="12345678901231,一次性使用无菌注射器,5ml,5ml-A,国械注准20223140001,14-01-02,UNIT,,&#10;12345678901248,一次性使用无菌注射器(中包),5ml×100,5ml-A,国械注准20223140001,14-01-02,CARTON,12345678901231,100" />
      <template #footer>
        <el-button @click="bulkVisible = false">取消</el-button>
        <el-button type="primary" :loading="bulkLoading" @click="doBulk">导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { downloadCsvUrl } from '@/api';
import {
  apiUdiDiList, apiUdiDiRemove, apiUdiDiSave, apiUdiNmpaProbe, apiUdiRecall,
  apiUdiSubmissions, apiUdiSubmit, apiUdiValidate, udiRecallUrl,
  type UdiDiRow, type UdiSubmissionRow,
} from '@/api/udi-compliance';

const tab = ref('di');

// ---------------- DI 台账
const diRows = ref<UdiDiRow[]>([]);
const diLoading = ref(false);
const diKw = ref('');
const diLevel = ref('');
const diDialog = ref(false);
const diSaving = ref(false);
const diForm = reactive<any>({});
const bulkVisible = ref(false);
const bulkText = ref('');
const bulkLoading = ref(false);

async function loadDi() {
  diLoading.value = true;
  try {
    const r = await apiUdiDiList({ keyword: diKw.value, packageLevel: diLevel.value });
    diRows.value = r.items ?? [];
  } catch (e: any) { ElMessage.error(e?.message || '加载 DI 台账失败'); }
  finally { diLoading.value = false; }
}

function openDiEdit(row: any) {
  Object.keys(diForm).forEach((k) => delete diForm[k]);
  Object.assign(diForm, row
    ? { ...row, qtyInPackage: row.qtyInPackage ? Number(row.qtyInPackage) : undefined }
    : { packageLevel: 'UNIT', issuingAgency: 'GS1', isSterile: false, isSingleUse: false });
  diDialog.value = true;
}

async function saveDi() {
  if (!diForm.di || !diForm.name) { ElMessage.warning('DI 和产品名称必填'); return; }
  diSaving.value = true;
  try {
    const r = await apiUdiDiSave([{ ...diForm }]);
    if (r?.rejected?.length) ElMessage.error(r.rejected[0].message);
    else ElMessage.success('已保存');
    diDialog.value = false;
    await loadDi();
  } catch (e: any) { ElMessage.error(e?.message || '保存失败'); }
  finally { diSaving.value = false; }
}

async function removeDi(row: UdiDiRow) {
  try {
    await apiUdiDiRemove(row.di);
    ElMessage.success('已删除');
    await loadDi();
  } catch (e: any) { ElMessage.error(e?.message || '删除失败'); }
}

async function doBulk() {
  const lines = bulkText.value.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) { ElMessage.warning('没有内容'); return; }
  const rows = lines.map((l) => {
    const [di, name, spec, model, registrationNo, catalogCode, packageLevel, parentDi, qty] = l.split(',').map((s) => s.trim());
    return { di, name, spec, model, registrationNo, catalogCode, packageLevel: packageLevel || 'UNIT', parentDi: parentDi || null, qtyInPackage: qty ? Number(qty) : undefined };
  });
  bulkLoading.value = true;
  try {
    const r = await apiUdiDiSave(rows);
    const msg = `成功 ${r.saved ?? 0} 条` + (r.rejected?.length ? `，拒绝 ${r.rejected.length} 条（${r.rejected[0].message}）` : '');
    r.rejected?.length ? ElMessage.warning(msg) : ElMessage.success(msg);
    bulkVisible.value = false;
    await loadDi();
  } catch (e: any) { ElMessage.error(e?.message || '导入失败'); }
  finally { bulkLoading.value = false; }
}

// ---------------- 校验
const validateAll = ref(true);
const validateDis = ref('');
const validating = ref(false);
const validateResult = ref<any>(null);
const errorsCount = computed(() => (validateResult.value?.issues ?? []).filter((i: any) => i.level === 'error').length);
const warnCount = computed(() => (validateResult.value?.issues ?? []).filter((i: any) => i.level === 'warn').length);

async function runValidate() {
  const dis = validateAll.value ? [] : validateDis.value.split(',').map((s) => s.trim()).filter(Boolean);
  validating.value = true;
  try {
    validateResult.value = await apiUdiValidate(dis);
  } catch (e: any) { ElMessage.error(e?.message || '校验失败'); }
  finally { validating.value = false; }
}

// ---------------- 召回
const recallForm = reactive({ gtin: '', lot: '', serial: '', sscc: '' });
const recallRange = ref<[string, string] | null>(null);
const recallLoading = ref(false);
const recallResult = ref<any>(null);

async function runRecall() {
  const params: any = {};
  (['gtin', 'lot', 'serial', 'sscc'] as const).forEach((k) => { if (recallForm[k]) params[k] = recallForm[k]; });
  if (recallRange.value?.[0]) params.since = recallRange.value[0];
  if (recallRange.value?.[1]) params.until = `${recallRange.value[1]}T23:59:59`;
  if (!Object.keys(params).length) { ElMessage.warning('至少填一个条件'); return; }
  recallLoading.value = true;
  try {
    recallResult.value = await apiUdiRecall(params);
    if (!recallResult.value?.summary?.units) ElMessage.info('没有命中的单品');
  } catch (e: any) { ElMessage.error(e?.message || '查询失败'); }
  finally { recallLoading.value = false; }
}

function exportRecall() {
  const params: any = {};
  (['gtin', 'lot', 'serial', 'sscc'] as const).forEach((k) => { if (recallForm[k]) params[k] = recallForm[k]; });
  if (recallRange.value?.[0]) params.since = recallRange.value[0];
  if (recallRange.value?.[1]) params.until = `${recallRange.value[1]}T23:59:59`;
  downloadCsvUrl(udiRecallUrl(params), `udi-recall-${new Date().toISOString().slice(0, 10)}.csv`)
    .catch((e) => ElMessage.error(e?.message || '导出失败'));
}

// ---------------- 申报
const submitForm = reactive({ channel: 'NMPA', mode: 'validate' });
const submitDis = ref('');
const submitting = ref(false);
const subRows = ref<UdiSubmissionRow[]>([]);
const subLoading = ref(false);
const lastSubmission = ref<UdiSubmissionRow | null>(null);
const submitAlertType = computed(() => {
  const s = lastSubmission.value?.status;
  return s === 'submitted' || s === 'validated' || s === 'generated' ? 'success' : (s === 'failed' ? 'error' : 'info');
});

async function loadSubs() {
  subLoading.value = true;
  try {
    const r = await apiUdiSubmissions({ limit: 20 });
    subRows.value = r.items ?? [];
  } catch (e: any) { ElMessage.error(e?.message || '加载申报记录失败'); }
  finally { subLoading.value = false; }
}

async function doSubmit() {
  const dis = submitDis.value.split(',').map((s) => s.trim()).filter(Boolean);
  if (submitForm.mode === 'api') {
    try { await ElMessageBox.confirm('会真实调用国家 UDID 接口（需要已配凭据），确认提交？', '接口直传', { type: 'warning' }); }
    catch { return; }
  }
  submitting.value = true;
  try {
    const r = await apiUdiSubmit({ channel: submitForm.channel, mode: submitForm.mode, dis });
    lastSubmission.value = r;
    if (r.status === 'failed') ElMessage.error(r.remoteMsg || '提交失败');
    else ElMessage.success(`已完成：${r.status}`);
    await loadSubs();
  } catch (e: any) { ElMessage.error(e?.message || '提交失败'); }
  finally { submitting.value = false; }
}

// ---------------- 连通性自检
const probe = ref<any>(null);
const probeLoading = ref(false);
async function runProbe() {
  probeLoading.value = true;
  try {
    probe.value = await apiUdiNmpaProbe();
    ElMessage.info(`${probe.value.ok ? '连通' : '不通'}：${probe.value.message}`);
  } catch (e: any) { ElMessage.error(e?.message || '探测失败'); }
  finally { probeLoading.value = false; }
}

/** ISO 时间转本地可读格式，空值给 '-' */
function fmtTime(v?: string | null) {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function onTab(name: string) {
  if (name === 'submit' && !subRows.value.length) loadSubs();
  if (name === 'di' && !diRows.value.length) loadDi();
}

onMounted(() => { loadDi(); runProbe(); });
</script>

<style scoped>
.filters { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.hint { color: #909399; font-size: 12px; }
.stat-row { margin-bottom: 12px; }
.stat { display: flex; flex-direction: column; gap: 4px; }
.stat-label { color: #909399; font-size: 12px; }
.stat-value { font-size: 24px; font-weight: 600; }
</style>
