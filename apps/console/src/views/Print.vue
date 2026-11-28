<template>
  <div class="page">
    <div class="page-head">
      <h2>打印</h2>
      <el-button text type="primary" @click="router.push('/print-jobs')">查看打印任务 →</el-button>
    </div>

    <el-alert
      v-if="!printers.length"
      type="warning"
      :closable="false"
      show-icon
      title="还没有配置打印机"
      description="请先到「打印机」里添加一台打印机（如网络打印机 raw_tcp / 浏览器打印），否则任务只能生成、无法出纸。"
      style="margin-bottom: 12px;"
    />

    <el-form :model="form" label-width="110px" class="form">
      <el-form-item label="模板" required>
        <el-select v-model="form.templateId" filterable placeholder="选择标签模板" style="width: 100%" @change="onTemplateChange">
          <el-option v-for="t in templates" :key="t.id" :label="t.name" :value="t.id" />
        </el-select>
      </el-form-item>

      <!-- 打印时表单：模板里标了「打印时录入」的变量，操作员在这里填，不用回设计器改模板 -->
      <el-form-item v-if="printFields.length" label="打印时填写" required>
        <div class="pf-box">
          <div class="pf-head">
            <span class="pf-title">{{ currentTemplateName }} · 本单必填项</span>
            <el-button link type="primary" size="small" @click="fillFromLast">沿用上次</el-button>
          </div>
          <div class="pf-grid">
            <div v-for="f in printFields" :key="f.name" class="pf-item">
              <span class="pf-label">
                {{ f.label }}
                <i v-if="f.required" class="pf-star">*</i>
                <span v-if="f.validation === 'regex' && f.regex" class="pf-rule" :title="f.regex">规则</span>
              </span>
              <el-date-picker
                v-if="f.type === 'date'"
                v-model="formValues[f.name]"
                type="date"
                value-format="YYYY-MM-DD"
                placeholder="YYYY-MM-DD"
                size="small"
                style="width: 100%"
              />
              <el-input-number
                v-else-if="f.type === 'number' || f.type === 'integer'"
                :model-value="numOrUndef(f.name)"
                :precision="f.type === 'integer' ? 0 : undefined"
                :controls="false"
                size="small"
                style="width: 100%"
                @update:model-value="(v: any) => setFormValue(f.name, v)"
              />
              <el-input
                v-else
                v-model="formValues[f.name]"
                :placeholder="f.defaultValue ? `默认 ${f.defaultValue}` : `${f.label}`"
                size="small"
                clearable
              />
              <span v-if="formErrors[f.name]" class="pf-err">{{ formErrors[f.name] }}</span>
            </div>
          </div>
          <span class="hint">这些值只作用于本次打印，会覆盖数据行里的同名变量；同一批标签共用这一份值。</span>
        </div>
      </el-form-item>

      <el-form-item label="打印机" required>
        <el-select v-model="form.printerId" filterable placeholder="选择打印机" style="width: 100%">
          <el-option v-for="p in printers" :key="p.id" :label="`${p.name}（${typeLabel(p.type)}）`" :value="p.id" />
        </el-select>
        <span class="hint">不选则任务进入队列但由通道决定出纸方式；浏览器通道需在本机打印。</span>
      </el-form-item>

      <el-form-item label="份数">
        <el-input-number v-model="form.copies" :min="1" :max="500" />
      </el-form-item>

      <el-form-item label="数据源">
        <div class="data-box">
          <el-link type="primary" :underline="false" style="font-size: 12px" @click="router.push('/datasource')">去数据源管理导入表格 →</el-link>
          <el-select v-model="selectedSourceId" filterable clearable placeholder="选择已保存的数据源（在「数据源管理」中导入）"
                     style="width: 100%; margin-bottom: 8px" :loading="sourcesLoading" @change="onSourceChange">
            <el-option v-for="s in sources" :key="s.id" :label="`${s.name}（${s.type?.toUpperCase() || 'CSV'}）`" :value="s.id" />
          </el-select>
          <el-input
            v-model="dataText"
            type="textarea"
            :rows="8"
            spellcheck="false"
            placeholder='临时数据：JSON 数组或 CSV/TSV（第一行为表头）。正式数据请在「数据源管理」导入后从上方选择。'
            @input="onTempInput"
          />
          <div class="data-actions">
            <el-button size="small" @click="useSample">用示例数据</el-button>
            <el-button size="small" @click="clearData">清空临时数据</el-button>
            <span class="stat">{{ stat }}</span>
          </div>

          <div v-if="headers.length" class="prev">
            <div class="prev-title">数据前 {{ previewRows.length }} 行</div>
            <table>
              <thead><tr><th v-for="h in headers" :key="h">{{ h }}</th></tr></thead>
              <tbody>
                <tr v-for="(r, i) in previewRows" :key="i">
                  <td v-for="h in headers" :key="h">{{ cellText(r[h]) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </el-form-item>

      <el-form-item>
        <el-button :disabled="!form.templateId" @click="preview">👁 预览</el-button>
        <el-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="submit">
          🖨 提交打印任务
        </el-button>
        <span class="hint">预计 {{ labelCount }} 张（{{ rowsCount }} 行 × {{ form.copies }} 份）</span>
      </el-form-item>
    </el-form>

    <el-dialog v-model="previewVisible" title="打印预览" width="1080px" top="4vh" class="print-dialog">
      <iframe :srcdoc="previewHtml" class="pp-frame" title="打印预览" />
      <template #footer>
        <span class="hint">浏览器打印对话框里请选「实际尺寸 / 无缩放」，否则物理尺寸会偏</span>
      </template>
    </el-dialog>

    <el-result
      v-if="result"
      icon="success"
      title="打印任务已提交"
      :sub-title="`任务 #${result.jobId} · 共 ${result.total} 张 · 状态：${result.status}`"
    >
      <template #extra>
        <el-button type="primary" @click="router.push('/print-jobs')">去打印任务页查看进度</el-button>
        <el-button @click="result = null">再打一单</el-button>
      </template>
    </el-result>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { apiListTemplates, apiGetTemplate, apiTemplatePrintForm, type PrintFormField } from '@/api/templates';
import {
  apiListPrinters, apiCreatePrintJob, apiListDataSources, apiDataSourceRows,
} from '@/api';
import { buildPrintHtml, parseData } from './designer/engine/print';
import { sampleRowOf } from './designer/engine/context';

const router = useRouter();

const templates = ref<any[]>([]);
const printers = ref<any[]>([]);

const form = reactive({ templateId: undefined as number | undefined, printerId: undefined as number | undefined, copies: 1 });
const dataText = ref('');
const submitting = ref(false);
const result = ref<any>(null);
const previewVisible = ref(false);

// 数据源引用（统一在「数据源管理」导入）
const sources = ref<any[]>([]);
const sourcesLoading = ref(false);
const selectedSourceId = ref<number | null>(null);
const previewHtml = ref('');

const rows = ref<Record<string, unknown>[]>([]);
const headers = ref<string[]>([]);
const stat = ref('未填数据时，按模板示例值打印 1 张');

// ---- 打印时表单 ----
const printFields = ref<PrintFormField[]>([]);
const formValues = reactive<Record<string, any>>({});
const formErrors = reactive<Record<string, string>>({});
const currentTemplateName = ref('');
const LAST_KEY = 'labelflow_print_form_last';

function resetFormFields(fields: PrintFormField[]) {
  printFields.value = fields;
  for (const k of Object.keys(formValues)) delete formValues[k];
  for (const k of Object.keys(formErrors)) delete formErrors[k];
  for (const f of fields) formValues[f.name] = f.defaultValue ?? '';
}

async function onTemplateChange(id: number | undefined) {
  printFields.value = [];
  currentTemplateName.value = '';
  if (!id) return;
  currentTemplateName.value = templates.value.find((t) => t.id === id)?.name || '';
  try {
    const pf = await apiTemplatePrintForm(id);
    resetFormFields(pf.fields || []);
  } catch (e: any) {
    // 老模板可能没有 variables 字段；拿不到表单就当"无需填写"，但要说一声别让人以为漏了
    printFields.value = [];
    if (e?.message) ElMessage.warning(`读取打印表单失败：${e.message}`);
  }
}

/** 沿用上次输入：车间同一批号连续打多单时省事 */
function fillFromLast() {
  try {
    const last = JSON.parse(localStorage.getItem(LAST_KEY) || '{}');
    for (const f of printFields.value) if (last[f.name]) formValues[f.name] = last[f.name];
    ElMessage.success('已填入上次的值');
  } catch { ElMessage.warning('没有可沿用的历史值'); }
}

/** 数字框要 number|null；用户清空要能还原成空字符串，否则后端拿不到"没填"的事实 */
function numOrUndef(name: string): number | undefined {
  const v = formValues[name];
  if (v === '' || v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function setFormValue(name: string, v: any) {
  formValues[name] = v == null ? '' : v;
  if (formErrors[name]) delete formErrors[name];
}

function rememberForm() {
  try {
    const keep: Record<string, any> = {};
    for (const f of printFields.value) if (formValues[f.name] !== '' && formValues[f.name] != null) keep[f.name] = formValues[f.name];
    localStorage.setItem(LAST_KEY, JSON.stringify(keep));
  } catch { /* localStorage 不可用不影响打印 */ }
}

/** 前端预检（与后端 print-form.calc 同规则，减少一次往返；最终以后端为准） */
function checkForm(): boolean {
  for (const k of Object.keys(formErrors)) delete formErrors[k];
  let ok = true;
  for (const f of printFields.value) {
    const text = formValues[f.name] == null ? '' : String(formValues[f.name]).trim();
    if (f.required && !text) { formErrors[f.name] = '必填'; ok = false; continue; }
    if (!text) continue;
    if (f.type === 'integer' && !/^-?\d+$/.test(text)) { formErrors[f.name] = '要填整数'; ok = false; }
    else if (f.type === 'number' && !/^-?\d+(.\d+)?$/.test(text)) { formErrors[f.name] = '要填数字'; ok = false; }
    else if (f.validation === 'regex' && f.regex) {
      try { if (!new RegExp(f.regex).test(text)) { formErrors[f.name] = `不符合 ${f.regex}`; ok = false; } }
      catch { /* 正则写坏由后端统一报 */ }
    }
  }
  return ok;
}

/** 表单值并入数据行（预览/提交同一口径：表单优先，空值不覆盖） */
function rowsWithForm(values: Record<string, any>[]): Record<string, any>[] {
  const filled = Object.entries(formValues).filter(([, v]) => v !== '' && v != null);
  if (!filled.length) return values;
  return values.map((r) => ({ ...(r ?? {}), ...Object.fromEntries(filled) }));
}

const rowsCount = computed(() => (rows.value.length ? rows.value.length : 1));
const labelCount = computed(() => rowsCount.value * form.copies);
const previewRows = computed(() => rows.value.slice(0, 8));
const canSubmit = computed(() => !!form.templateId && !!form.printerId && !submitting.value);

function typeLabel(t: string) {
  return { raw_tcp: '网络打印机', browser: '浏览器', image: '服务端出图', windows_spooler: '本地代理' }[t] || t;
}
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

async function loadSources() {
  sourcesLoading.value = true;
  try { sources.value = (await apiListDataSources()) as any[]; }
  catch { /* 未订阅 datasource 时保持空，打印仍可用临时数据 */ }
  finally { sourcesLoading.value = false; }
}

async function onSourceChange(id: number | null) {
  if (!id) return;
  try {
    const res: any = await apiDataSourceRows(id, 2000);
    const list = Array.isArray(res) ? res : (res?.rows ?? res?.items ?? []);
    if (!list.length) { ElMessage.warning('该数据源暂无数据行（SQL 源请先执行刷新）'); return; }
    rows.value = list;
    headers.value = Object.keys(list[0] ?? {});
    dataText.value = '';
    stat.value = `数据源「${sources.value.find((s) => s.id === id)?.name || id}」共 ${rows.value.length} 行`;
  } catch (e) {
    ElMessage.error(`读取数据源失败：${(e as Error).message}`);
  }
}

function onTempInput() {
  selectedSourceId.value = null;
  parse();
}

function parse(loud = false) {
  try {
    const { rows: r, headers: h } = parseData(dataText.value);
    rows.value = r; headers.value = h;
    stat.value = r.length
      ? `${r.length} 行 · ${h.length} 列`
      : '未填数据时，按模板示例值打印 1 张';
  } catch (e: any) {
    if (loud) ElMessage.error(`数据解析失败：${e?.message}`);
  }
}

function clearData() { dataText.value = ''; parse(); }

function useSample() {
  dataText.value = '[{"sku":"A-100","name":"示例商品 A"},{"sku":"B-200","name":"示例商品 B"}]';
  parse(true);
}

async function submit() {
  if (!form.templateId || !form.printerId) { ElMessage.warning('请先选择模板和打印机'); return; }
  if (printFields.value.length && !checkForm()) {
    ElMessage.error('打印时填写的数据没填对，已标红的字段改一下再提交');
    return;
  }
  const payload: any = {
    templateId: form.templateId,
    printerId: form.printerId,
    copies: form.copies,
  };
  const hasForm = printFields.value.length > 0;
  if (hasForm) {
    // 表单值交给后端：它按模板 variables 再做一次必填/格式校验（前端预检不是唯一防线）
    payload.formValues = Object.fromEntries(Object.entries(formValues).filter(([, v]) => v !== '' && v != null));
    // rows 先并入表单值，让治理防重/数量检查看到的是最终值
    payload.rows = rowsWithForm(rows.value.length ? rows.value : [{}]);
  } else if (rows.value.length) payload.rows = rows.value;
  submitting.value = true;
  try {
    const r: any = await apiCreatePrintJob(payload);
    result.value = r;
    if (printFields.value.length) rememberForm();
    ElMessage.success('打印任务已提交');
  } finally { submitting.value = false; }
}

async function load() {
  try {
    const [tpl] = (await apiListTemplates({ pageSize: 200 })) || [[], 0];
    templates.value = tpl || [];
  } catch { /* 菜单已校验权限，列表失败仅提示 */ }
  try { printers.value = (await apiListPrinters()) || []; } catch { /* 同上 */ }
}

/** 本地生成打印预览 HTML（与设计器「打印预览」同一份生成器，所见即所得），不依赖后端 */
async function preview() {
  if (!form.templateId) { ElMessage.warning('请先选择模板'); return; }
  try {
    const tpl = await apiGetTemplate(form.templateId);
    const data = rowsWithForm(rows.value.length ? rows.value : [sampleRowOf(tpl.content)]);
    previewHtml.value = buildPrintHtml(tpl.content, data, {
      copies: form.copies,
      title: tpl.name || 'LabelFlow 打印',
    });
    previewVisible.value = true;
  } catch (e: any) {
    ElMessage.error(`预览失败：${e?.message}`);
  }
}

onMounted(() => { load(); loadSources(); });
</script>

<style scoped>
.page { padding: 16px 20px; max-width: 880px; }
.page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.form { margin-top: 8px; }
.hint { color: #909399; font-size: 12px; margin-left: 8px; }
.data-box { width: 100%; }
.data-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.stat { color: #909399; font-size: 12px; }
.prev { margin-top: 10px; max-height: 220px; overflow: auto; border: 1px solid #ebeef5; border-radius: 6px; }
.prev-title { padding: 6px 10px; background: #f5f7fa; font-size: 12px; color: #606266; }
.prev table { width: 100%; border-collapse: collapse; font-size: 12px; }
.prev th, .prev td { border-top: 1px solid #ebeef5; padding: 4px 8px; text-align: left; }
.prev th { background: #fafafa; }
.pp-frame { width: 100%; height: 70vh; border: 0; background: #fff; }
.pf-box { width: 100%; border: 1px solid #ebeef5; border-radius: 8px; padding: 10px 12px; background: #fafcff; }
.pf-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.pf-title { font-size: 13px; font-weight: 600; color: #303133; }
.pf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px 14px; }
.pf-item { display: flex; flex-direction: column; gap: 4px; }
.pf-label { font-size: 12px; color: #606266; }
.pf-star { color: #d9534f; font-style: normal; margin-left: 2px; }
.pf-rule { font-size: 11px; color: #909399; margin-left: 6px; cursor: help; border-bottom: 1px dashed #c0c4cc; }
.pf-err { font-size: 11px; color: #d9534f; }
</style>
