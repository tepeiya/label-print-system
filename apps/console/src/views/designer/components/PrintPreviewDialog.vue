<template>
  <el-dialog
    :model-value="modelValue"
    title="打印预览"
    width="1080px"
    top="4vh"
    class="print-dialog"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="print-grid">
      <!-- ------------------------------ 数据侧 ------------------------------ -->
      <div class="print-side">
        <div class="pp-block">
          <div class="pp-title">
            数据源
            <el-link type="primary" :underline="false" style="font-size: 12px; font-weight: normal" @click="gotoDataSource">去数据源管理 →</el-link>
          </div>
          <div class="pp-pick">
            <el-select v-model="selectedSourceId" filterable clearable placeholder="选择已保存的数据源（在「数据源管理」中导入）"
                       style="width: 100%" :loading="sourcesLoading" @change="onSourceChange">
              <el-option v-for="s in sources" :key="s.id" :label="`${s.name}（${s.type?.toUpperCase() || 'CSV'}）`" :value="s.id" />
            </el-select>
          </div>
          <textarea
            v-model="text"
            class="pp-data"
            spellcheck="false"
            placeholder='临时数据：JSON 数组或 CSV / TSV（第一行为表头）。正式数据请在「数据源管理」导入后从上方选择。'
            @input="onTempInput"
          />
          <div class="pp-actions">
            <el-button size="small" @click="useSample">用示例数据</el-button>
            <el-button size="small" @click="clearData">清空临时数据</el-button>
            <el-button size="small" type="primary" @click="parse(true)">生成预览</el-button>
          </div>
          <div class="pp-stat">{{ stat }}</div>
        </div>

        <div class="pp-block">
          <div class="pp-title">输出参数</div>
          <div class="pp-row">
            <span class="pp-label">份数</span>
            <el-input-number v-model="copies" size="small" :min="1" :max="999" controls-position="right" />
            <span class="pp-label">流水号起始</span>
            <el-input-number v-model="serialStart" size="small" :min="1" controls-position="right" />
          </div>
          <div class="pp-row">
            <span class="pp-label">标签</span>
            <span class="pp-val">{{ labelCount }} 张 · {{ sheetCount }} 张纸（拼版 {{ page.columns }}×{{ page.rows }}）</span>
          </div>
          <div class="pp-row">
            <span class="pp-label">单张</span>
            <span class="pp-val">{{ page.widthMm }} × {{ page.heightMm }} mm @ {{ page.dpi }} dpi</span>
          </div>
        </div>

        <div v-if="headers.length" class="pp-block">
          <div class="pp-title">数据前 {{ previewRows.length }} 行</div>
          <div class="pp-table">
            <table>
              <thead>
                <tr><th v-for="h in headers" :key="h">{{ h }}</th></tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in previewRows" :key="i">
                  <td v-for="h in headers" :key="h">{{ cellText(r[h]) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- ------------------------------ 预览侧 ------------------------------ -->
      <div class="print-view">
        <div class="pp-bar">
          <el-button size="small" @click="printNow">🖨 打印</el-button>
          <el-button size="small" @click="downloadHtml">下载打印 HTML</el-button>
          <span class="pp-hint">浏览器打印对话框里请选「实际尺寸 / 无缩放」，否则物理尺寸会偏</span>
        </div>
        <iframe ref="frameRef" class="pp-frame" :srcdoc="html" title="打印预览" />
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
// =============================================================================
// PrintPreviewDialog.vue —— 打印预览（print.js 的「所见即所打」子集）
//   预览 HTML 直接复用 engine/print.ts#buildPrintHtml，和后端出图、原生打印页
//   同一份生成器；这里只负责喂数据（JSON/CSV）、份数与流水号起点。
//   数据解析失败时保留上一次结果，避免边打字边报错（原生 parseAndRefresh 同语义）。
// =============================================================================
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useDesignerStore } from '../store';
import { buildPrintHtml, parseData } from '../engine/print';
import { downloadFile } from '../engine/util';
import { sampleRowOf } from '../engine/context';
import { apiListDataSources, apiDataSourceRows } from '@/api';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [boolean] }>();

const store = useDesignerStore();
const router = useRouter();

const text = ref('');
const copies = ref(1);
const serialStart = ref(1);
const stat = ref('未填数据时，按变量示例值打印 1 张');
const frameRef = ref<HTMLIFrameElement | null>(null);

// 数据源选择（统一在「数据源管理」导入）
const sources = ref<any[]>([]);
const sourcesLoading = ref(false);
const selectedSourceId = ref<number | null>(null);

async function loadSources() {
  sourcesLoading.value = true;
  try { sources.value = (await apiListDataSources()) as any[]; }
  catch { /* 未订阅 datasource 时保持空，不阻塞预览 */ }
  finally { sourcesLoading.value = false; }
}

function gotoDataSource() {
  emit('update:modelValue', false);
  void router.push('/datasource');
}

/** 选中已保存数据源后，读取数据行并生成预览（不走本地文件解析） */
async function onSourceChange(id: number | null) {
  if (!id) return;
  try {
    const res: any = await apiDataSourceRows(id, 2000);
    const list = Array.isArray(res) ? res : (res?.rows ?? res?.items ?? []);
    if (!list.length) { ElMessage.warning('该数据源暂无数据行（SQL 源请先执行刷新）'); return; }
    rows.value = list;
    headers.value = Object.keys(list[0] ?? {});
    text.value = ''; // 清空临时数据，避免混淆
    stat.value = `数据源「${sources.value.find((s) => s.id === id)?.name || id}」共 ${rows.value.length} 行`;
    build();
  } catch (e) {
    ElMessage.error(`读取数据源失败：${(e as Error).message}`);
  }
}

/** 手动改临时数据时，清空数据源选择，避免两者混淆 */
function onTempInput() {
  selectedSourceId.value = null;
  parse();
}

const rows = ref<Record<string, unknown>[]>([]);
const headers = ref<string[]>([]);
const html = ref('');

const page = computed(() => store.page);
const labelCount = computed(() => Math.max(1, rows.value.length) * copies.value);
const perSheet = computed(() => Math.max(1, page.value.columns) * Math.max(1, page.value.rows));
const sheetCount = computed(() => Math.ceil(labelCount.value / perSheet.value));
const previewRows = computed(() => rows.value.slice(0, 8));

/** 表格里的值统一成字符串，对象/数组按 JSON 展示，和条码内容取值口径一致 */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** @param loud 用户主动点「生成预览」时把解析错误说出来 */
function parse(loud = false): boolean {
  try {
    const parsed = parseData(text.value);
    rows.value = parsed.rows;
    headers.value = parsed.headers;
    stat.value = rows.value.length
      ? `${rows.value.length} 行 · ${headers.value.length} 列${rows.value.length > previewRows.value.length ? `（表格仅显示前 ${previewRows.value.length} 行）` : ''}`
      : '未填数据时，按变量示例值打印 1 张';
    build();
    return true;
  } catch (e) {
    if (loud) ElMessage.error(`数据解析失败：${(e as Error).message}`);
    return false;
  }
}

function build() {
  const data = rows.value.length ? rows.value : [sampleRowOf(store.template)];
  html.value = buildPrintHtml(store.template, data, {
    copies: copies.value,
    serialStart: serialStart.value,
    title: store.templateName || 'LabelFlow 打印',
  });
}

function useSample() {
  const one = sampleRowOf(store.template);
  text.value = JSON.stringify(
    store.variables.length ? [one, one] : [one],
    null, 2,
  );
  parse(true);
}

function clearData() {
  text.value = '';
  parse();
}

function printNow() {
  if (!html.value) build();
  const win = frameRef.value?.contentWindow;
  if (!win) return;
  win.focus();
  win.print();
}

function downloadHtml() {
  if (!html.value) build();
  const safe = (store.templateName || 'label').replace(/[\\/:*?"<>|]/g, '_');
  downloadFile(`${safe}-print.html`, html.value, 'text/html;charset=utf-8');
}

// 份数/流水号改动即刻重算预览；页面与元素由「生成预览」或打开时触发，避免大表格频繁重建
watch([copies, serialStart], () => { if (props.modelValue) build(); });

watch(() => props.modelValue, (open) => {
  if (!open) return;
  serialStart.value = store.serialStart;
  copies.value = Math.max(1, page.value.copies ?? 1);
  if (!text.value && !selectedSourceId.value) useSample();
  else if (text.value) parse();
});

onMounted(loadSources);
</script>
