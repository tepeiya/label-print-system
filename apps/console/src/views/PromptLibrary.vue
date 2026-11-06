<template>
  <div>
    <div class="page-header">
      <h2>Prompt 库</h2>
      <el-button type="primary" v-permission.hide="'sys:prompt:manage'" @click="openNew">
        <el-icon><Plus /></el-icon> 新建提示词
      </el-button>
    </div>

    <el-alert type="info" :closable="false" show-icon class="explain">
      <template #title>系统内置 {{ countBy('system') }} 个开箱即用场景；在这里改 = 给本租户建一份同名覆盖。</template>
      <div class="explain-body">
        正文用 <code>&#123;&#123;参数名&#125;&#125;</code> 占位符，出现的占位符必须先在参数里声明；
        删除覆盖行即回落系统默认文案（系统行本身不可删除）。关闭「启用」后，Agent 的
        <code>prompts/list</code> 里就看不到这一条，但这里仍保留，方便再打开。
      </div>
    </el-alert>

    <div class="card">
      <div class="toolbar">
        <el-input v-model="keyword" placeholder="搜索名称 / 标题" clearable style="width: 260px" />
        <span class="hint">
          共 {{ filtered.length }} 条 · 系统默认 {{ countBy('system') }} · 租户自定义 {{ countBy('custom') }}
        </span>
      </div>

      <el-table :data="filtered" v-loading="loading" stripe size="small" style="width: 100%">
        <el-table-column label="名称" min-width="200">
          <template #default="{ row }"><code class="mono">{{ row.name }}</code></template>
        </el-table-column>
        <el-table-column prop="title" label="标题" min-width="150" />
        <el-table-column label="来源" width="110">
          <template #default="{ row }">
            <el-tag v-if="row.overridden" size="small" type="warning">覆盖系统</el-tag>
            <el-tag v-else-if="row.source === 'system'" size="small" type="info">系统</el-tag>
            <el-tag v-else size="small" type="success">自定义</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="参数" width="80">
          <template #default="{ row }">{{ (row.arguments || []).length }}</template>
        </el-table-column>
        <el-table-column label="启用" width="80">
          <template #default="{ row }">
            <el-switch
              :model-value="row.enabled"
              :disabled="!canManage || !!switchBusy[row.name]"
              :loading="!!switchBusy[row.name]"
              @change="(v: any) => toggle(row, !!v)"
            />
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">{{ formatTime(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button link size="small" type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link size="small" type="primary" @click="openPreview(row)">预览</el-button>
            <el-popconfirm
              v-if="row.source === 'custom'"
              :title="row.overridden ? `恢复系统默认后，本租户对「${row.name}」的修改会丢失。确认？` : `删除自定义提示词「${row.name}」？`"
              width="280"
              @confirm="remove(row)"
            >
              <template #reference>
                <el-button link size="small" type="danger">
                  {{ row.overridden ? '恢复默认' : '删除' }}
                </el-button>
              </template>
            </el-popconfirm>
            <span v-else class="hint">—</span>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 编辑器 -->
    <el-dialog v-model="editorOpen" :title="isNew ? '新建提示词' : `编辑：${form.name}`" width="880px" top="4vh" destroy-on-close>
      <el-form :model="form" label-width="86px">
        <el-form-item label="名称" required>
          <el-input v-model="form.name" :disabled="!isNew" placeholder="inventory.health_check" />
          <div class="hint">小写字母开头，可含 a-z0-9_.-；与系统同名 = 覆盖（保存后可「恢复默认」）。</div>
        </el-form-item>
        <el-form-item label="标题" required>
          <el-input v-model="form.title" maxlength="120" show-word-limit />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="form.description" maxlength="500" show-word-limit />
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sortOrder" :min="0" :max="10000" />
          <el-switch v-model="form.enabled" style="margin-left: 18px" active-text="启用" inactive-text="停用" />
        </el-form-item>

        <el-form-item label="参数">
          <div class="args">
            <el-table :data="form.arguments" size="small" empty-text="没有参数（正文可以不用占位符）">
              <el-table-column label="名称" width="150">
                <template #default="{ row }"><el-input v-model="row.name" size="small" placeholder="warehouse" /></template>
              </el-table-column>
              <el-table-column label="标题" width="140">
                <template #default="{ row }"><el-input v-model="row.title" size="small" /></template>
              </el-table-column>
              <el-table-column label="说明">
                <template #default="{ row }"><el-input v-model="row.description" size="small" /></template>
              </el-table-column>
              <el-table-column label="必填" width="70" align="center">
                <template #default="{ row }"><el-checkbox v-model="row.required" /></template>
              </el-table-column>
              <el-table-column label="默认值" width="140">
                <template #default="{ row }"><el-input v-model="row.default" size="small" /></template>
              </el-table-column>
              <el-table-column label="" width="56" align="center">
                <template #default="{ $index }">
                  <el-button link size="small" type="danger" @click="form.arguments.splice($index, 1)">删</el-button>
                </template>
              </el-table-column>
            </el-table>
            <el-button link type="primary" size="small" @click="addArg">+ 添加参数</el-button>
          </div>
        </el-form-item>

        <el-form-item label="正文" required>
          <el-input v-model="form.content" type="textarea" :rows="14" class="mono-input" />
          <div class="hint">
            用 <code>&#123;&#123;参数名&#125;&#125;</code> 引用参数；保存时校验「占位符已声明」，拼错会直接报错。
          </div>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="editorOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- 预览 -->
    <el-dialog v-model="previewOpen" :title="`预览：${previewName}`" width="720px" top="6vh">
      <el-form label-width="96px">
        <el-form-item v-for="a in previewArgsList" :key="a.name" :label="a.title || a.name">
          <el-input
            v-model="previewArgs[a.name]"
            :placeholder="a.default ? `默认：${a.default}` : (a.required ? '必填' : '可空')"
          />
        </el-form-item>
      </el-form>
      <el-button type="primary" :loading="previewing" @click="runPreview">渲染预览</el-button>

      <div v-if="previewResult" class="preview">
        <div class="hint">
          来源 {{ previewResult.source === 'system' ? '系统默认' : '租户自定义' }} · {{ previewResult.length }} 字符
        </div>
        <pre>{{ previewResult.text }}</pre>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
// ============================================================================
// PromptLibrary —— 租户 Prompt 库（P6.5，docs/11 §11.7.5 / docs/10 §10.26）
//
// 数据形态：后端返回「系统默认 + 租户覆盖」的合并列表，前端不区分两份来源分别维护。
//   · source=system   还没有租户行，正文来自代码里的默认文案（只读）；
//   · source=custom   有租户行；overridden=true 表示覆盖了同名系统提示词。
// 保存走 PUT /agent-prompts/:name（同名即覆盖）；删除租户行 = 回落默认。
// 预览走 POST /agent-prompts/:name/preview：与 Agent 的 prompts/get 共用同一套渲染规则，
// 避免「预览好看、Agent 拿到空串」。
// ============================================================================
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import {
  apiDeletePrompt, apiListPrompts, apiPreviewPrompt, apiSavePrompt,
  type AgentPrompt, type PromptArgument, type PromptPreview,
} from '@/api';
import { useAuthStore } from '@/store/auth';

const auth = useAuthStore();
const canManage = computed(() => auth.hasPermission('sys:prompt:manage'));

const loading = ref(false);
const rows = ref<AgentPrompt[]>([]);
const keyword = ref('');
const switchBusy = reactive<Record<string, boolean>>({});

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase();
  if (!k) return rows.value;
  return rows.value.filter((r) => r.name.toLowerCase().includes(k) || r.title.toLowerCase().includes(k));
});
const countBy = (source: 'system' | 'custom') => rows.value.filter((r) => r.source === source).length;
const formatTime = (t: any) => (t ? new Date(t).toLocaleString() : '—');

async function load() {
  loading.value = true;
  try {
    rows.value = (await apiListPrompts()) ?? [];
  } catch (e: any) {
    ElMessage.error(e?.message || '加载 Prompt 库失败');
  } finally {
    loading.value = false;
  }
}

// ---------------------------------------------------------------- 编辑器
const editorOpen = ref(false);
const isNew = ref(false);
const saving = ref(false);
const form = reactive({
  name: '',
  title: '',
  description: '',
  content: '',
  enabled: true,
  sortOrder: 100,
  arguments: [] as PromptArgument[],
});

function resetForm(p?: AgentPrompt) {
  form.name = p?.name ?? '';
  form.title = p?.title ?? '';
  form.description = p?.description ?? '';
  form.content = p?.content ?? '';
  form.enabled = p?.enabled ?? true;
  form.sortOrder = p?.sortOrder ?? 100;
  form.arguments = (p?.arguments ?? []).map((a) => ({ ...a }));
}
function openNew() {
  isNew.value = true;
  resetForm();
  editorOpen.value = true;
}
function openEdit(row: AgentPrompt) {
  isNew.value = false;
  resetForm(row);
  editorOpen.value = true;
}
function addArg() {
  form.arguments.push({ name: '', title: '', description: '', required: false, default: '' });
}

function payloadFromForm() {
  return {
    title: form.title,
    description: form.description,
    content: form.content,
    enabled: form.enabled,
    sortOrder: form.sortOrder,
    // 空行（用户点了添加但没填名字）直接丢弃，避免后端报「参数名不合法」
    arguments: form.arguments
      .filter((a) => a.name.trim())
      .map((a) => ({
        name: a.name.trim(),
        ...(a.title?.trim() ? { title: a.title.trim() } : {}),
        ...(a.description?.trim() ? { description: a.description.trim() } : {}),
        ...(a.required ? { required: true } : {}),
        ...(a.default !== undefined && a.default !== '' ? { default: a.default } : {}),
      })),
  };
}

async function save() {
  const name = form.name.trim();
  if (!name) return ElMessage.warning('提示词名不能为空');
  saving.value = true;
  try {
    await apiSavePrompt(name, payloadFromForm());
    ElMessage.success('已保存');
    editorOpen.value = false;
    await load();
  } catch (e: any) {
    ElMessage.error(e?.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

async function toggle(row: AgentPrompt, enabled: boolean) {
  switchBusy[row.name] = true;
  try {
    await apiSavePrompt(row.name, {
      title: row.title,
      description: row.description,
      content: row.content,
      arguments: row.arguments,
      sortOrder: row.sortOrder,
      enabled,
    });
    row.enabled = enabled;
    ElMessage.success(enabled ? '已启用' : '已停用（Agent 侧不再下发）');
  } catch (e: any) {
    ElMessage.error(e?.message || '操作失败');
  } finally {
    switchBusy[row.name] = false;
  }
}

async function remove(row: AgentPrompt) {
  try {
    const res = await apiDeletePrompt(row.name);
    ElMessage.success(res.revertedToSystem ? '已恢复系统默认' : '已删除');
    await load();
  } catch (e: any) {
    ElMessage.error(e?.message || '删除失败');
  }
}

// ---------------------------------------------------------------- 预览
const previewOpen = ref(false);
const previewName = ref('');
const previewArgsList = ref<PromptArgument[]>([]);
const previewArgs = reactive<Record<string, string>>({});
const previewResult = ref<PromptPreview | null>(null);
const previewing = ref(false);

function openPreview(row: AgentPrompt) {
  previewName.value = row.name;
  previewArgsList.value = row.arguments ?? [];
  for (const k of Object.keys(previewArgs)) delete previewArgs[k];
  for (const a of previewArgsList.value) previewArgs[a.name] = a.default ?? '';
  previewResult.value = null;
  previewOpen.value = true;
}

async function runPreview() {
  previewing.value = true;
  try {
    previewResult.value = await apiPreviewPrompt(previewName.value, { ...previewArgs });
  } catch (e: any) {
    previewResult.value = null;
    ElMessage.error(e?.message || '渲染失败');
  } finally {
    previewing.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 10px;
}
.args {
  width: 100%;
}
.mono,
.mono-input :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.preview {
  margin-top: 14px;
}
.preview pre {
  max-height: 420px;
  overflow: auto;
  padding: 12px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.6;
}
</style>
