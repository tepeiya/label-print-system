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
        <el-select v-model="form.templateId" filterable placeholder="选择标签模板" style="width: 100%">
          <el-option v-for="t in templates" :key="t.id" :label="t.name" :value="t.id" />
        </el-select>
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

      <el-form-item label="数据">
        <div class="data-box">
          <el-input
            v-model="dataText"
            type="textarea"
            :rows="8"
            spellcheck="false"
            placeholder='JSON 数组：[{"sku":"A-100","name":"可乐 330ml"}]  或  CSV/TSV（第一行为表头）'
            @input="parse"
          />
          <div class="data-actions">
            <el-button size="small" @click="fileRef?.click()">导入文件</el-button>
            <el-button size="small" @click="useSample">用示例数据</el-button>
            <el-button size="small" @click="clearData">清空</el-button>
            <input ref="fileRef" type="file" accept=".csv,.tsv,.txt,.json" hidden @change="onFile" />
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
import { apiListTemplates, apiGetTemplate } from '@/api/templates';
import { apiListPrinters, apiCreatePrintJob } from '@/api';
import { buildPrintHtml } from './designer/engine/print';
import { sampleRowOf } from './designer/engine/context';

const router = useRouter();

const templates = ref<any[]>([]);
const printers = ref<any[]>([]);

const form = reactive({ templateId: undefined as number | undefined, printerId: undefined as number | undefined, copies: 1 });
const dataText = ref('');
const submitting = ref(false);
const result = ref<any>(null);
const fileRef = ref<HTMLInputElement | null>(null);
const previewVisible = ref(false);
const previewHtml = ref('');

let rows: Record<string, unknown>[] = [];
let headers: string[] = [];
const stat = ref('未填数据时，按模板示例值打印 1 张');

const rowsCount = computed(() => (rows.length ? rows.length : 1));
const labelCount = computed(() => rowsCount.value * form.copies);
const previewRows = computed(() => rows.slice(0, 8));
const canSubmit = computed(() => !!form.templateId && !!form.printerId && !submitting.value);

function typeLabel(t: string) {
  return { raw_tcp: '网络打印机', browser: '浏览器', image: '服务端出图', windows_spooler: '本地代理' }[t] || t;
}
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** 解析 JSON 数组 / 对象，或 CSV/TSV（首行表头） */
function parseData(text: string): { rows: Record<string, unknown>[]; headers: string[] } {
  const s = text.trim();
  if (!s) return { rows: [], headers: [] };
  if (s[0] === '[' || s[0] === '{') {
    const parsed = JSON.parse(s);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const hs: string[] = [];
    for (const r of arr) if (r && typeof r === 'object') for (const k of Object.keys(r)) if (!hs.includes(k)) hs.push(k);
    return { rows: arr.map((r) => (r && typeof r === 'object' ? r : { value: r })), headers: hs };
  }
  const lines = s.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return { rows: [], headers: [] };
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const hs = lines[0].split(delim).map((h) => h.trim());
  const rs = lines.slice(1).map((line) => {
    const cells = line.split(delim);
    const obj: Record<string, unknown> = {};
    hs.forEach((h, i) => (obj[h] = cells[i]?.trim() ?? ''));
    return obj;
  });
  return { rows: rs, headers: hs };
}

function parse(loud = false) {
  try {
    const { rows: r, headers: h } = parseData(dataText.value);
    rows = r; headers = h;
    stat.value = r.length
      ? `${r.length} 行 · ${h.length} 列`
      : '未填数据时，按模板示例值打印 1 张';
  } catch (e: any) {
    if (loud) ElMessage.error(`数据解析失败：${e?.message}`);
  }
}

function clearData() { dataText.value = ''; parse(); }

async function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try { dataText.value = (await f.text()).slice(0, 200_000); parse(true); }
  catch (err: any) { ElMessage.error(`读取文件失败：${err?.message}`); }
  finally { (e.target as HTMLInputElement).value = ''; }
}

function useSample() {
  dataText.value = '[{"sku":"A-100","name":"示例商品 A"},{"sku":"B-200","name":"示例商品 B"}]';
  parse(true);
}

async function submit() {
  if (!form.templateId || !form.printerId) { ElMessage.warning('请先选择模板和打印机'); return; }
  const payload: any = {
    templateId: form.templateId,
    printerId: form.printerId,
    copies: form.copies,
  };
  if (rows.length) payload.rows = rows;
  submitting.value = true;
  try {
    const r: any = await apiCreatePrintJob(payload);
    result.value = r;
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
    const data = rows.length ? rows : [sampleRowOf(tpl.content)];
    previewHtml.value = buildPrintHtml(tpl.content, data, {
      copies: form.copies,
      title: tpl.name || 'LabelFlow 打印',
    });
    previewVisible.value = true;
  } catch (e: any) {
    ElMessage.error(`预览失败：${e?.message}`);
  }
}

onMounted(load);
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
</style>
