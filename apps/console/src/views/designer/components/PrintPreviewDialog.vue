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
            <el-button size="small" type="primary" :loading="cmdLoading" @click="parse(true)">生成预览</el-button>
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
        <!-- 后端 /print/commands 的 warnings：有则显示，无则整块不占位（类别取自后端自带标签，正文不加工） -->
        <div v-if="cmdWarnItems.length" class="pp-warns">
          <div class="pp-warn-title">
            指令导出提示
            <span class="pp-hint">ZPL / TSPL 打印指令共 {{ cmdWarnItems.length }} 条提示，按能力矩阵如实给出</span>
          </div>
          <div v-for="(w, i) in cmdWarnItems" :key="i" class="pp-warn">
            <span class="pp-warn-kind">【{{ w.kind }}】</span>{{ w.text }}
          </div>
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
//   另外向 /print/commands 各协议取一次 warnings 如实展示：预览 HTML 是浏览器出图，
//   不代表打印机能原生打这个码制，只有指令侧的提示才说明「真打印会怎样」。
// =============================================================================
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { apiPrintCommands } from '@/api';
import { useDesignerStore } from '../store';
import { DISPLAY_PROTOCOLS, warnBadge } from '../barcode-caps';
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

// --------------------------- 指令侧 warnings ---------------------------
/**
 * 展示口径只看 zpl/tspl，这是刻意的产品决策而不是入口限制：
 * backend 的 PrintCommandsDto 现在收 zpl|tspl|epl（EPL 通道 P7.7 已接通，控制器把缺省与
 * 非白名单值归一到 zpl），但 EPL 是可选协议、面向老 Zebra/Eltron 机型，覆盖面明显窄于
 * ZPL/TSPL（二维符号一律走 GW 点阵，GS1_128 / MSI 直接 previewOnly）。把它并进 warnings
 * 的并集，主流码制都会多出「位图打印」「仅预览」两类噪音。口径与 barcode-caps.ts 文件头
 * 「为什么不纳入 epl」那段一致；需要 EPL 提示时按 protocol:'epl' 单独调 /print/commands 即可。
 */
const CMD_PROTOCOLS = DISPLAY_PROTOCOLS.filter((p) => p === 'zpl' || p === 'tspl') as Array<'zpl' | 'tspl'>;

const cmdWarnings = ref<string[]>([]);
const cmdLoading = ref(false);
let cmdSeq = 0;

/** 展示用：类别前缀取自后端 warning 自带的 [码制]/[几何]/[静区]/… 标签，正文保持原样 */
const cmdWarnItems = computed(() => cmdWarnings.value.map((w) => warnBadge(w)));

/**
 * 逐协议取一次 warnings 并合并去重（除并集去重外不加工）。
 * 失败按「无提示」处理：这是如实呈现用的增强信息，不该挡住预览本身。
 * copies 固定 1 —— 提示与份数无关，别拿几百份去压后端。
 */
async function refreshCmdWarnings() {
  const p = store.page;
  const body = {
    templateContent: store.template,
    rows: rows.length ? rows : [sampleRowOf(store.template)],
    copies: 1,
    dpi: p.dpi ?? 300,
    widthMm: p.widthMm,
    heightMm: p.heightMm,
    gapMm: p.gapMm ?? 2,
    offsetXMm: (p.offsetXMm ?? 0) + (p.calibrateXMm ?? 0),
    offsetYMm: (p.offsetYMm ?? 0) + (p.calibrateYMm ?? 0),
  };
  const seq = ++cmdSeq;
  cmdLoading.value = true;
  try {
    const per = await Promise.all(CMD_PROTOCOLS.map((protocol) =>
      apiPrintCommands({ ...body, protocol }, { silentError: true })
        .then((r) => r?.warnings ?? [])
        .catch(() => [] as string[]),
    ));
    if (seq !== cmdSeq) return;   // 只认最后一次触发的结果
    cmdWarnings.value = Array.from(new Set(per.flat()));
  } finally {
    if (seq === cmdSeq) cmdLoading.value = false;
  }
}

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
    // 只有「用户主动要一份新预览」（生成预览 / 用示例数据 / 导入文件）才去问指令侧，
    // 避免每敲一个字符都打后端
    if (loud) void refreshCmdWarnings();
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
  else { parse(); void refreshCmdWarnings(); }   // 打开时数据没变，parse 不 loud，指令检查单独补一次
});
</script>
