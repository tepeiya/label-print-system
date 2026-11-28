<template>
  <div>
    <div class="page-header">
      <h2>AI 生成模板</h2>
      <el-tag type="info" v-if="auth.tenant?.plan">套餐 {{ auth.tenant.plan }}</el-tag>
    </div>

    <el-alert v-if="!visionEnabled" type="warning" :closable="false" style="margin-bottom: 16px;">
      当前租户的视觉模型开关（<code>features['ai.vision']</code>）已关闭，图片生成会失败或退化为纯规则引擎。
      需要开启请联系平台运营。
    </el-alert>

    <el-row :gutter="16">
      <el-col :span="12">
        <div class="card">
          <h3 style="margin-top: 0;">① 图片 → 模板</h3>
          <el-form label-width="90px">
            <el-form-item label="标签图片">
              <input type="file" accept="image/png,image/jpeg,image/webp,image/tiff" @change="onFile" />
            </el-form-item>
            <el-form-item label="宽 × 高">
              <el-input-number v-model="form.widthMm" :min="1" :max="1000" size="small" /> mm
              <el-input-number v-model="form.heightMm" :min="1" :max="1000" size="small" style="margin-left: 8px;" /> mm
            </el-form-item>
            <el-form-item label="DPI">
              <el-select v-model="form.dpi" style="width: 120px;">
                <el-option v-for="d in [203, 300, 600]" :key="d" :label="d" :value="d" />
              </el-select>
            </el-form-item>
            <el-form-item label="调用大模型">
              <el-switch v-model="form.useLlm" />
              <span style="color: #999; font-size: 12px; margin-left: 8px;">关闭后只用本地规则引擎，不消耗配额</span>
            </el-form-item>
          </el-form>
          <el-button type="primary" :loading="generating" :disabled="!file"
                     v-permission="'ai:generate'" @click="doGenerate">
            开始生成
          </el-button>
        </div>
      </el-col>

      <el-col :span="12">
        <div class="card">
          <h3 style="margin-top: 0;">② 文字描述 → 模板</h3>
          <el-form label-width="90px">
            <el-form-item label="描述">
              <el-input v-model="text.description" type="textarea" :rows="4"
                        placeholder="例如：60×40mm 生鲜标签，左上品名，右上条码，下方净含量与生产日期" />
            </el-form-item>
            <el-form-item label="宽 × 高">
              <el-input-number v-model="text.widthMm" :min="1" :max="1000" size="small" /> mm
              <el-input-number v-model="text.heightMm" :min="1" :max="1000" size="small" style="margin-left: 8px;" /> mm
            </el-form-item>
          </el-form>
          <el-button type="primary" :loading="textGenerating" :disabled="!text.description"
                     v-permission="'ai:text-to-template'" @click="doText">
            生成
          </el-button>
          <div style="color: #999; font-size: 12px; margin-top: 8px;">
            文本生成依赖已配置的大模型；没有可用模型时会报「未配置模型」，此时请改用图片模式。
          </div>
        </div>
      </el-col>
    </el-row>

    <div class="card" style="margin-top: 16px;">
      <h3 style="margin-top: 0;">③ 字段 → 模板（自动排版）</h3>
      <div style="color: #666; font-size: 13px; margin-bottom: 10px;">
        把要印的字段列出来，AI 自动排成带外框、标题、分割线、信息区、条码/二维码的精美版式；没有配置大模型也能用（走规则引擎）。
      </div>

      <el-form inline label-width="68px" size="small" style="margin-bottom: 4px;">
        <el-form-item label="纸型">
          <el-input-number v-model="lay.widthMm" :min="10" :max="500" controls-position="right" style="width: 110px;" /> ×
          <el-input-number v-model="lay.heightMm" :min="10" :max="500" controls-position="right" style="width: 110px; margin-left: 6px;" /> mm
        </el-form-item>
        <el-form-item label="DPI">
          <el-select v-model="lay.dpi" style="width: 96px;">
            <el-option v-for="d in [203, 300, 600]" :key="d" :label="d" :value="d" />
          </el-select>
        </el-form-item>
        <el-form-item label="风格">
          <el-select v-model="lay.style" style="width: 116px;">
            <el-option label="医疗" value="medical" />
            <el-option label="工业" value="industrial" />
            <el-option label="零售" value="retail" />
            <el-option label="极简" value="clean" />
          </el-select>
        </el-form-item>
        <el-form-item label="美化">
          <el-switch v-model="lay.useLlm" />
          <span style="color: #999; font-size: 12px; margin-left: 6px;">关掉=纯规则引擎，不耗配额</span>
        </el-form-item>
      </el-form>

      <el-form inline label-width="68px" size="small">
        <el-form-item label="标题">
          <el-input v-model="lay.title" placeholder="留空则用产品名/默认标题" style="width: 240px;" />
        </el-form-item>
        <el-form-item label="页脚">
          <el-input v-model="lay.footer" placeholder="如：某某医疗器械有限公司" style="width: 260px;" />
        </el-form-item>
      </el-form>

      <div style="display: flex; gap: 8px; align-items: center; margin: 6px 0 8px;">
        <el-button size="small" @click="addField">＋ 加字段</el-button>
        <el-button size="small" @click="applyPreset('udiUnit')">套用：医疗器械单件</el-button>
        <el-button size="small" @click="applyPreset('udiCarton')">套用：医疗器械箱标</el-button>
        <el-button size="small" @click="applyPreset('retail')">套用：零售价签</el-button>
        <span style="color: #999; font-size: 12px; margin-left: auto;">共 {{ lay.fields.length }} 个字段</span>
      </div>

      <el-table :data="lay.fields" size="small" border style="margin-bottom: 10px;">
        <el-table-column label="变量名" width="150">
          <template #default="{ row }">
            <el-input v-model="row.name" size="small" placeholder="productName" />
          </template>
        </el-table-column>
        <el-table-column label="中文名（印在标签上）" width="170">
          <template #default="{ row }">
            <el-input v-model="row.label" size="small" placeholder="产品名" />
          </template>
        </el-table-column>
        <el-table-column label="类型" width="110">
          <template #default="{ row }">
            <el-select v-model="row.type" size="small">
              <el-option label="文本" value="text" />
              <el-option label="数字" value="number" />
              <el-option label="日期" value="date" />
              <el-option label="一维码" value="barcode" />
              <el-option label="二维码" value="qrcode" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="示例值" min-width="200">
          <template #default="{ row }">
            <el-input v-model="row.sample" size="small" :placeholder="row.type === 'barcode' ? '(01)06901234567892(10)LOT01' : '打印前可留空，示例值只做预览'" />
          </template>
        </el-table-column>
        <el-table-column label="强调" width="70" align="center">
          <template #default="{ row }"><el-checkbox v-model="row.emphasis" /></template>
        </el-table-column>
        <el-table-column label="打印必填" width="84" align="center">
          <template #default="{ row }"><el-checkbox v-model="row.required" /></template>
        </el-table-column>
        <el-table-column width="56" align="center">
          <template #default="{ $index }">
            <el-button link type="danger" size="small" @click="lay.fields.splice($index, 1)">删</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-button type="primary" :loading="layGenerating" :disabled="!lay.fields.length"
                 v-permission="'ai:text-to-template'" @click="doLayout">
        自动排版生成
      </el-button>
      <span v-if="layoutNote" style="color: #67c23a; font-size: 12px; margin-left: 10px;">{{ layoutNote }}</span>
    </div>

    <div class="card" style="margin-top: 16px;" v-if="result">
      <h3 style="margin-top: 0;">生成结果</h3>
      <el-descriptions :column="4" border size="small" style="margin-bottom: 12px;">
        <el-descriptions-item label="元素数">{{ elementCount }}</el-descriptions-item>
        <el-descriptions-item label="耗时">{{ (result.meta?.elapsedMs ?? result.elapsedMs ?? 0) }} ms</el-descriptions-item>
        <el-descriptions-item label="模型">{{ result.model || result.meta?.model || '规则引擎' }}</el-descriptions-item>
        <el-descriptions-item label="警告">{{ warnings.length }} 条</el-descriptions-item>
      </el-descriptions>

      <el-alert v-for="(w, i) in warnings" :key="i" :type="w.level === 'high' ? 'error' : 'warning'"
                :closable="false" style="margin-bottom: 6px;">
        {{ w.message }}<span v-if="w.elementId"> · 元素 {{ w.elementId }}</span>
      </el-alert>

      <div style="display: flex; gap: 8px; align-items: center; margin-top: 12px;">
        <el-input v-model="saveName" placeholder="模板名（留空自动命名）" style="width: 260px;" />
        <el-button type="success" :loading="saving" v-permission="'template:write'" @click="doSave">
          保存为模板
        </el-button>
        <el-button v-if="savedId" @click="router.push('/designer')">去设计器继续编辑</el-button>
        <span v-if="savedId" style="color: #67c23a;">已保存，模板 ID {{ savedId }}</span>
      </div>
    </div>

    <div class="card" style="margin-top: 16px;">
      <h3 style="margin-top: 0;">最近生成记录</h3>
      <el-table :data="jobs" size="small" stripe v-loading="jobsLoading">
        <el-table-column prop="id" label="#" width="70" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'done' ? 'success' : row.status === 'failed' ? 'danger' : 'info'">
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="model" label="模型" width="180" />
        <el-table-column label="元素" width="90">
          <template #default="{ row }">{{ row.counts?.elements ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="耗时" width="100">
          <template #default="{ row }">{{ row.elapsedMs != null ? row.elapsedMs + ' ms' : '—' }}</template>
        </el-table-column>
        <el-table-column label="时间" min-width="180">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script setup lang="ts">
// AI 工作台（P1 新增页）：只做「生成 → 检查警告 → 存模板」这条最短链路。
// 画布级的元素微调仍在设计器（iframe）里做，不在这里重画一套。
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '@/store/auth';
import { apiAiFieldsToTemplate, apiAiGenerate, apiAiJobs, apiAiSaveTemplate, apiAiTextToTemplate } from '@/api';

const auth = useAuthStore();
const router = useRouter();

const file = ref<File | null>(null);
const generating = ref(false);
const textGenerating = ref(false);
const saving = ref(false);
const jobsLoading = ref(false);
const result = ref<any>(null);
const savedId = ref<number | null>(null);
const jobs = ref<any[]>([]);
const saveName = ref('');

const form = reactive({ widthMm: 100, heightMm: 60, dpi: 300, useLlm: true });
const layGenerating = ref(false);
const layoutNote = ref('');
const lay = reactive({
  widthMm: 50, heightMm: 30, dpi: 203, style: 'medical' as 'medical' | 'industrial' | 'retail' | 'clean',
  title: '', footer: '', useLlm: true,
  fields: [] as Array<{ name: string; label: string; type: string; sample: string; emphasis: boolean; required: boolean }>,
});

const PRESETS: Record<string, { size: [number, number]; dpi: number; style: any; fields: any[] }> = {
  udiUnit: {
    size: [50, 30], dpi: 203, style: 'medical',
    fields: [
      { name: 'productName', label: '产品名', type: 'text', sample: '一次性使用无菌注射器', emphasis: true, required: true },
      { name: 'spec', label: '规格', type: 'text', sample: '5ml', emphasis: false, required: false },
      { name: 'lot', label: '批号', type: 'text', sample: 'PF2601', emphasis: false, required: true },
      { name: 'expiry', label: '有效期', type: 'date', sample: '2027-10-31', emphasis: false, required: true },
      { name: 'serial', label: '序列号', type: 'text', sample: '', emphasis: false, required: false },
      { name: 'qr', label: 'UDI 二维码', type: 'qrcode', sample: '(01)06901234567892(10)PF2601(17)271031', emphasis: false, required: false },
      { name: 'barcodeText', label: '一维码', type: 'barcode', sample: '(01)06901234567892(10)PF2601(17)271031', emphasis: false, required: false },
    ],
  },
  udiCarton: {
    size: [100, 70], dpi: 203, style: 'industrial',
    fields: [
      { name: 'productName', label: '产品名', type: 'text', sample: '一次性使用无菌注射器', emphasis: true, required: true },
      { name: 'spec', label: '规格', type: 'text', sample: '5ml', emphasis: false, required: false },
      { name: 'lot', label: '批号', type: 'text', sample: 'PF2601', emphasis: false, required: true },
      { name: 'expiry', label: '有效期', type: 'date', sample: '2027-10-31', emphasis: false, required: true },
      { name: 'qty', label: '装箱数量', type: 'number', sample: '100', emphasis: false, required: true },
      { name: 'sscc', label: 'SSCC 箱码', type: 'barcode', sample: '(00)106901234567890123', emphasis: false, required: false },
      { name: 'qr', label: 'UDI 二维码', type: 'qrcode', sample: '(01)06901234567892(10)PF2601(17)271031', emphasis: false, required: false },
    ],
  },
  retail: {
    size: [40, 30], dpi: 203, style: 'retail',
    fields: [
      { name: 'productName', label: '品名', type: 'text', sample: '鲜牛奶 250ml', emphasis: true, required: true },
      { name: 'price', label: '售价', type: 'number', sample: '6.50', emphasis: true, required: true },
      { name: 'unit', label: '单位', type: 'text', sample: '瓶', emphasis: false, required: false },
      { name: 'producedAt', label: '生产日期', type: 'date', sample: '2026-11-28', emphasis: false, required: false },
      { name: 'barcodeText', label: '条码', type: 'barcode', sample: '6901234567892', emphasis: false, required: false },
    ],
  },
};

function addField() {
  const i = lay.fields.length + 1;
  lay.fields.push({ name: `field${i}`, label: `字段${i}`, type: 'text', sample: '', emphasis: false, required: false });
}

function applyPreset(key: string) {
  const p = PRESETS[key];
  if (!p) return;
  lay.widthMm = p.size[0]; lay.heightMm = p.size[1]; lay.dpi = p.dpi; lay.style = p.style;
  lay.fields = p.fields.map((f) => ({ ...f }));
}

async function doLayout() {
  if (!lay.fields.length) return;
  layGenerating.value = true; layoutNote.value = '';
  try {
    const res: any = await apiAiFieldsToTemplate({
      fields: lay.fields.map((f) => ({
        name: f.name.trim(), label: f.label.trim() || f.name.trim(),
        type: f.type as any, sample: f.sample || undefined,
        required: f.required, emphasis: f.emphasis,
      })),
      widthMm: lay.widthMm, heightMm: lay.heightMm, dpi: lay.dpi,
      style: lay.style, title: lay.title || undefined, footer: lay.footer || undefined,
      useLlm: lay.useLlm,
    });
    result.value = res;
    savedId.value = null;
    layoutNote.value =
      `来源：${res.source === 'llm' ? '大模型美化' : '规则引擎'}` +
      ` · ${res.meta?.columns ?? 1} 列 / 行高 ${res.meta?.rowHeightMm ?? '-'}mm / 字号 ${res.meta?.fontPt ?? '-'}pt`;
    ElMessage.success(`排版完成，共 ${elementCount.value} 个元素`);
  } catch {}
  finally { layGenerating.value = false; }
}
const text = reactive({ description: '', widthMm: 100, heightMm: 60 });

const visionEnabled = computed(() => auth.hasFeature('ai.vision'));
// 字段接口的警告是纯字符串（规则引擎口径），统一成 {level,message} 便于展示
const warnings = computed<any[]>(() =>
  (result.value?.warnings ?? []).map((w: any) =>
    typeof w === 'string' ? { level: 'warning', message: w } : w,
  ),
);
const elementCount = computed<number>(() => result.value?.template?.elements?.length ?? 0);

const formatTime = (t: string) => (t ? new Date(t).toLocaleString() : '-');

function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  file.value = input.files?.[0] ?? null;
  savedId.value = null;
}

async function doGenerate() {
  if (!file.value) return;
  generating.value = true;
  try {
    const fd = new FormData();
    fd.append('file', file.value);
    fd.append('widthMm', String(form.widthMm));
    fd.append('heightMm', String(form.heightMm));
    fd.append('dpi', String(form.dpi));
    fd.append('useLlm', String(form.useLlm));
    result.value = await apiAiGenerate(fd);
    savedId.value = null;
    ElMessage.success(`生成完成，共 ${elementCount.value} 个元素`);
    await loadJobs();
  } catch {}
  finally { generating.value = false; }
}

async function doText() {
  textGenerating.value = true;
  try {
    result.value = await apiAiTextToTemplate({
      description: text.description, widthMm: text.widthMm, heightMm: text.heightMm,
    });
    savedId.value = null;
    ElMessage.success(`生成完成，共 ${elementCount.value} 个元素`);
    await loadJobs();
  } catch {}
  finally { textGenerating.value = false; }
}

async function doSave() {
  if (!result.value?.template) return;
  saving.value = true;
  try {
    const res: any = await apiAiSaveTemplate({ template: result.value.template, name: saveName.value || undefined });
    savedId.value = res?.id ?? null;
    ElMessage.success('已保存为模板');
  } catch {}
  finally { saving.value = false; }
}

async function loadJobs() {
  jobsLoading.value = true;
  try { jobs.value = (await apiAiJobs(10)) as any[]; }
  finally { jobsLoading.value = false; }
}

onMounted(() => { applyPreset('udiUnit'); loadJobs(); });
</script>
