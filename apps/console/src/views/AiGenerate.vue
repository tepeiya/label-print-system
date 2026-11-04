<template>
  <div>
    <div class="page-header">
      <h2>🤖 AI 生成模板</h2>
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
import { apiAiGenerate, apiAiJobs, apiAiSaveTemplate, apiAiTextToTemplate } from '@/api';

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
const text = reactive({ description: '', widthMm: 100, heightMm: 60 });

const visionEnabled = computed(() => auth.hasFeature('ai.vision'));
const warnings = computed<any[]>(() => result.value?.warnings ?? []);
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

onMounted(loadJobs);
</script>
