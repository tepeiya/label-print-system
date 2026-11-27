<template>
  <div>
    <div class="page-header">
      <h2>AI 模型配置</h2>
      <div style="display: flex; gap: 8px;">
        <el-button type="primary" v-permission="'ai:models:manage'" @click="openCreate">
          <el-icon><Plus /></el-icon> 新增模型
        </el-button>
        <el-button @click="load" :loading="loading">刷新</el-button>
      </div>
    </div>

    <el-alert type="info" :closable="false" style="margin-bottom: 16px;">
      这里配置的是<strong>本租户自己使用的 AI 供应商</strong>。支持任何 OpenAI 兼容接口（OpenAI / DeepSeek / 通义千问 / 智谱 / Ollama / 自建网关）。
      API Key 加密存储，只在测试与生成时解密使用；每个租户独立隔离，互不可见。
    </el-alert>

    <div class="card">
      <el-table :data="models" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column label="名称" min-width="160">
          <template #default="{ row }">
            <span style="font-weight: 600">{{ row.name }}</span>
            <el-tag v-if="row.isDefault" type="success" size="small" effect="dark" style="margin-left: 6px">默认</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="供应商" width="130">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ providerLabel(row.provider) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="modelId" label="模型 ID" min-width="150" show-overflow-tooltip />
        <el-table-column prop="apiEndpoint" label="接口地址" min-width="220" show-overflow-tooltip />
        <el-table-column label="API Key" width="100">
          <template #default="{ row }">
            <span :style="{ color: row.apiKeySet ? '#67c23a' : '#e6a23c' }">
              {{ row.apiKeySet ? '已配置' : '未配置' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button link size="small" :loading="testingId === row.id" v-permission="'ai:models:manage'" @click="doTest(row)">测试连接</el-button>
            <el-popconfirm v-if="!row.isDefault" title="删除后使用该模型的任务将回退到默认模型，确认删除？" @confirm="doDelete(row)">
              <template #reference>
                <el-button link size="small" type="danger" v-permission="'ai:models:manage'">删除</el-button>
              </template>
            </el-popconfirm>
            <el-tooltip v-else content="默认模型不能删除，请先新增另一个模型并勾选默认">
              <el-button link size="small" type="danger" disabled>删除</el-button>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && !models.length" description="还没有配置 AI 模型">
        <el-button type="primary" v-permission="'ai:models:manage'" @click="openCreate">新增第一个模型</el-button>
      </el-empty>
    </div>

    <div class="card tips">
      <div class="tips-title">常见问题</div>
      <div class="tips-row"><b>不配置模型能用吗？</b> 能。没有可用模型时 AI 生成会退化为本地规则引擎，只是效果弱一些。</div>
      <div class="tips-row"><b>接口地址填什么？</b> 填到 <code>/v1</code> 为止，例如 DeepSeek 是 <code>https://api.deepseek.com/v1</code>，OpenAI 是 <code>https://api.openai.com/v1</code>，Ollama 本地是 <code>http://localhost:11434/v1</code>。</div>
      <div class="tips-row"><b>怎么切换默认模型？</b> 新增模型时勾选「设为默认」即可（新默认会顶替旧默认）。如需更换 Key，删除该模型后重新新增。</div>
      <div class="tips-row"><b>为什么测试报 401？</b> 多半是 Key 填错或模型 ID 与供应商不匹配；部分网关要求 Key 带特定前缀。</div>
    </div>

    <el-dialog v-model="dlg.visible" title="新增 AI 模型" width="600px">
      <el-form label-width="115px">
        <el-form-item label="名称" required>
          <el-input v-model="dlg.form.name" placeholder="例如：DeepSeek-V3" />
        </el-form-item>
        <el-form-item label="供应商">
          <el-select v-model="dlg.form.provider" style="width: 100%">
            <el-option v-for="p in PROVIDERS" :key="p.value" :label="p.label" :value="p.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="接口地址" required>
          <el-input v-model="dlg.form.apiEndpoint" placeholder="https://api.deepseek.com/v1" />
        </el-form-item>
        <el-form-item label="模型 ID" required>
          <el-input v-model="dlg.form.modelId" placeholder="deepseek-chat / gpt-4o / qwen-vl-max" />
        </el-form-item>
        <el-form-item label="API Key">
          <el-input v-model="dlg.form.apiKey" type="password" show-password placeholder="留空则不使用密钥（Ollama 等本地服务可留空）" />
        </el-form-item>
        <el-form-item label="设为默认">
          <el-switch v-model="dlg.form.isDefault" />
          <span class="hint" style="margin-left: 10px">AI 生成时优先使用默认模型</span>
        </el-form-item>
        <el-form-item label="高级参数">
          <el-input v-model="dlg.settingsText" type="textarea" :rows="2" placeholder='JSON，例如 {"temperature":0.2,"max_tokens":4000}' />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlg.visible = false">取消</el-button>
        <el-button type="primary" :loading="dlg.saving" @click="doCreate">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import {
  apiAiModels, apiCreateAiModel, apiTestAiModel, apiDeleteAiModel, type AiModelInput,
} from '@/api';

interface AiModelRow {
  id: number; name: string; provider: string; apiEndpoint: string; modelId: string;
  isDefault: boolean; apiKeySet: boolean; settings: any; createdAt: string;
}

// 与数据库 CHECK 约束一致：qwen/openai/zhipu/ollama/custom（DeepSeek 走 openai 兼容接口）
const PROVIDERS = [
  { value: 'openai', label: 'OpenAI 兼容接口（含 DeepSeek）' },
  { value: 'qwen', label: '通义千问 Qwen' },
  { value: 'zhipu', label: '智谱 GLM' },
  { value: 'ollama', label: 'Ollama 本地' },
  { value: 'custom', label: '自定义网关' },
];

const providerLabel = (p: string) => PROVIDERS.find((x) => x.value === p)?.label ?? p;

const models = ref<AiModelRow[]>([]);
const loading = ref(false);
const testingId = ref<number | null>(null);

async function load() {
  loading.value = true;
  try { models.value = (await apiAiModels()) as AiModelRow[]; }
  finally { loading.value = false; }
}

async function doTest(row: AiModelRow) {
  testingId.value = row.id;
  try {
    const res: any = await apiTestAiModel(row.id);
    if (res?.ok) ElMessage.success(`连接正常（${res.durationMs ?? 0}ms）`);
    else ElMessage.error(res?.message || '连接失败');
  } catch (e: any) {
    ElMessage.error(e?.message || '连接失败');
  } finally {
    testingId.value = null;
  }
}

async function doDelete(row: AiModelRow) {
  try {
    await apiDeleteAiModel(row.id);
    ElMessage.success('已删除');
    await load();
  } catch {}
}

const dlg = ref<{
  visible: boolean; saving: boolean; settingsText: string;
  form: AiModelInput;
}>({
  visible: false, saving: false, settingsText: '',
  form: { name: '', provider: 'openai', apiEndpoint: '', modelId: '', apiKey: '', isDefault: false },
});

function openCreate() {
  dlg.value = {
    visible: true, saving: false, settingsText: '',
    form: { name: '', provider: 'openai', apiEndpoint: '', modelId: '', apiKey: '', isDefault: !models.value.length },
  };
}

async function doCreate() {
  const f = dlg.value.form;
  if (!f.name || !f.apiEndpoint || !f.modelId) {
    ElMessage.warning('名称、接口地址、模型 ID 必填');
    return;
  }
  let settings: any = {};
  if (dlg.value.settingsText.trim()) {
    try { settings = JSON.parse(dlg.value.settingsText); }
    catch { ElMessage.warning('高级参数不是合法 JSON，已忽略'); }
  }
  dlg.value.saving = true;
  try {
    await apiCreateAiModel({ ...f, settings });
    ElMessage.success('已创建 AI 模型配置');
    dlg.value.visible = false;
    await load();
  } catch (e: any) {
    ElMessage.error(e?.message || '保存失败');
  } finally {
    dlg.value.saving = false;
  }
}

onMounted(load);
</script>

<style scoped>
.hint { color: #909399; font-size: 12px; }
.tips { line-height: 1.8; font-size: 13px; color: var(--el-text-color-regular); }
.tips-title { font-weight: 700; margin-bottom: 6px; }
.tips-row { padding: 2px 0; }
.tips-row b { color: var(--el-text-color-primary); }
code { background: #f1f5f9; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
</style>
