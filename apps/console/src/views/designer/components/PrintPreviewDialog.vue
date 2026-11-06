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
            <span class="pp-hint">JSON / CSV / TSV，第一行为表头</span>
          </div>
          <textarea
            v-model="text"
            class="pp-data"
            spellcheck="false"
            placeholder='[{"sku":"A-100","name":"可乐 330ml","price":"5.50"}]'
            @input="parse()"
          />
          <div class="pp-actions">
            <el-button size="small" @click="fileRef?.click()">导入文件</el-button>
            <el-button size="small" @click="useSample">用示例数据</el-button>
            <el-button size="small" @click="clearData">清空</el-button>
            <el-button size="small" type="primary" @click="parse(true)">生成预览</el-button>
            <input ref="fileRef" type="file" accept=".csv,.tsv,.txt,.json" hidden @change="onFile">
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
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useDesignerStore } from '../store';
import { buildPrintHtml, parseData } from '../engine/print';
import { downloadFile } from '../engine/util';
import { sampleRowOf } from '../engine/context';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [boolean] }>();

const store = useDesignerStore();

const text = ref('');
const copies = ref(1);
const serialStart = ref(1);
const stat = ref('未填数据时，按变量示例值打印 1 张');
const frameRef = ref<HTMLIFrameElement | null>(null);
const fileRef = ref<HTMLInputElement | null>(null);

let rows: Record<string, unknown>[] = [];
let headers: string[] = [];
const html = ref('');

const page = computed(() => store.page);
const labelCount = computed(() => Math.max(1, rows.length) * copies.value);
const perSheet = computed(() => Math.max(1, page.value.columns) * Math.max(1, page.value.rows));
const sheetCount = computed(() => Math.ceil(labelCount.value / perSheet.value));
const previewRows = computed(() => rows.slice(0, 8));

/** 表格里的值统一成字符串，对象/数组按 JSON 展示，和条码内容取值口径一致 */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** @param loud 用户主动点「生成预览」时把解析错误说出来 */
function parse(loud = false): boolean {
  try {
    const parsed = parseData(text.value);
    rows = parsed.rows;
    headers = parsed.headers;
    stat.value = rows.length
      ? `${rows.length} 行 · ${headers.length} 列${rows.length > previewRows.value.length ? `（表格仅显示前 ${previewRows.value.length} 行）` : ''}`
      : '未填数据时，按变量示例值打印 1 张';
    build();
    return true;
  } catch (e) {
    if (loud) ElMessage.error(`数据解析失败：${(e as Error).message}`);
    return false;
  }
}

function build() {
  const data = rows.length ? rows : [sampleRowOf(store.template)];
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

async function onFile(e: Event) {
  const inp = e.target as HTMLInputElement;
  const f = inp.files?.[0];
  if (!f) return;
  try {
    text.value = (await f.text()).slice(0, 200_000);
    parse(true);
  } catch (err) {
    ElMessage.error(`读取文件失败：${(err as Error).message}`);
  } finally {
    inp.value = '';
  }
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
  if (!text.value) useSample();
  else parse();
});
</script>
