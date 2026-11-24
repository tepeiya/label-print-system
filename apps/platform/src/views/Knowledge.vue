<template>
  <div class="kb-page">
    <div class="page-header">
      <h2>📚 系统功能与使用教程</h2>
      <el-input
        v-model="keyword"
        class="kb-search"
        placeholder="搜索功能、操作步骤、报错关键词"
        clearable
        @keyup.enter="loadList"
        @clear="loadList"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-button @click="loadList" :loading="listLoading">搜索</el-button>
      <el-button @click="openAi = true">AI 设置</el-button>
      <el-button type="primary" plain @click="assistant.show()">问 AI 助手</el-button>
    </div>

    <div class="kb-body">
      <aside class="kb-side card">
        <div class="kb-cats">
          <div
            v-for="c in catList"
            :key="c.category"
            class="kb-cat"
            :class="{ active: c.category === activeCat }"
            @click="pickCat(c.category)"
          >
            <span>{{ c.category }}</span>
            <span class="kb-cat-count">{{ c.count }}</span>
          </div>
        </div>

        <div class="kb-list" v-loading="listLoading">
          <div
            v-for="a in articles"
            :key="a.slug"
            class="kb-item"
            :class="{ active: a.slug === currentSlug }"
            @click="openArticle(a.slug)"
          >
            <div class="kb-item-title">{{ a.title }}</div>
            <div class="kb-item-sum">{{ a.summary }}</div>
          </div>
          <el-empty v-if="!listLoading && !articles.length" description="没有匹配的文章" :image-size="60" />
        </div>
      </aside>

      <section class="kb-main card" v-loading="detailLoading">
        <template v-if="detail">
          <div class="kb-art-head">
            <el-tag size="small" type="info">{{ detail.category }}</el-tag>
            <h1>{{ detail.title }}</h1>
          </div>
          <div class="kb-meta">
            <span v-if="detail.tags">标签：{{ detail.tags }}</span>
            <span class="muted">更新于 {{ fmtTime(detail.updatedAt) }}</span>
          </div>
          <div v-if="detail.summary" class="kb-summary">{{ detail.summary }}</div>
          <!-- 正文是我们自己种进库的 Markdown，renderMarkdown 先转义再替换标记，不会放行可执行标签 -->
          <div class="kb-content md-body" v-html="renderMarkdown(detail.content)"></div>
          <div class="kb-art-foot">
            <el-button type="primary" plain @click="assistant.show()">这篇没讲清楚？问 AI 助手</el-button>
            <span class="muted sub">助手优先用租户配置的模型，租户没配才走平台 AI 接口</span>
          </div>
        </template>
        <el-empty v-else description="从左侧选一篇文章" />
      </section>
    </div>

    <!-- 平台级 AI 配置（写 ai_model_configs 的 tenant_id=0；只是"兜底"，租户自己配了就优先租户） -->
    <el-dialog v-model="openAi" title="AI 助手配置（平台级兜底）" width="560px">
      <el-alert
        :title="status?.note || '正在读取当前生效的配置…'"
        :type="status?.configured ? 'success' : 'warning'"
        :closable="false"
        show-icon
        class="ai-status"
      />
      <div class="ai-status-line muted sub">
        生效来源：{{ sourceText }} · 模型：{{ status?.model || '未配置' }} · 接口：{{ status?.baseUrl || '-' }}
      </div>
      <el-form :model="form" label-width="110px" class="ai-form">
        <el-form-item label="配置名称">
          <el-input v-model="form.name" placeholder="platform-kb-assistant" />
        </el-form-item>
        <el-form-item label="服务商">
          <el-select v-model="form.provider" style="width: 100%">
            <el-option label="OpenAI 兼容（custom）" value="custom" />
            <el-option label="通义千问（qwen）" value="qwen" />
            <el-option label="OpenAI" value="openai" />
            <el-option label="智谱（zhipu）" value="zhipu" />
            <el-option label="本地 Ollama" value="ollama" />
          </el-select>
        </el-form-item>
        <el-form-item label="接口地址">
          <el-input v-model="form.apiEndpoint" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" />
          <span class="muted sub">OpenAI 兼容地址，末尾不用写 /chat/completions</span>
        </el-form-item>
        <el-form-item label="模型 ID">
          <el-input v-model="form.modelId" placeholder="qwen-plus" />
        </el-form-item>
        <el-form-item label="API Key">
          <el-input v-model="form.apiKey" type="password" show-password placeholder="保存后仅加密存储，不回显" />
        </el-form-item>
      </el-form>
      <template #footer>
        <span class="muted sub left">不知道填什么？留空也能用，助手会退回知识库原文整理。</span>
        <el-button @click="openAi = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveConfig">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  apiKbArticle,
  apiKbArticles,
  apiKbSaveConfig,
  apiKbStatus,
  type KbAiStatus,
  type KbArticleDetail,
  type KbArticleItem,
  type KbCategory,
} from '@/api/kb';
import { renderMarkdown } from '@/utils/md';
import { useAssistantStore } from '@/store/assistant';

const route = useRoute();
const router = useRouter();
const assistant = useAssistantStore();

const keyword = ref('');
const articles = ref<KbArticleItem[]>([]);
const catList = ref<KbCategory[]>([]);
const activeCat = ref('全部');
const currentSlug = ref('');
const detail = ref<KbArticleDetail | null>(null);
const listLoading = ref(false);
const detailLoading = ref(false);

const fmtTime = (t: string) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '-');

const allCount = () => catList.value.reduce((s, c) => s + c.count, 0);
function refreshCats() {
  const total = allCount();
  if (!catList.value.some((c) => c.category === '全部')) {
    catList.value = [{ category: '全部', count: total }, ...catList.value];
  } else {
    catList.value = catList.value.map((c) => (c.category === '全部' ? { category: '全部', count: total } : c));
  }
}

async function loadList() {
  listLoading.value = true;
  try {
    const res = await apiKbArticles({
      ...(activeCat.value && activeCat.value !== '全部' ? { category: activeCat.value } : {}),
      ...(keyword.value.trim() ? { keyword: keyword.value.trim() } : {}),
    });
    articles.value = res.items;
    catList.value = res.categories;
    refreshCats();
    if (!currentSlug.value && articles.value.length) openArticle(articles.value[0].slug, false);
  } finally {
    listLoading.value = false;
  }
}

function pickCat(category: string) {
  activeCat.value = category;
  loadList();
}

async function openArticle(slug: string, push = true) {
  currentSlug.value = slug;
  detailLoading.value = true;
  try {
    detail.value = await apiKbArticle(slug);
    if (push && route.query.slug !== slug) router.replace({ path: '/knowledge', query: { slug } });
  } finally {
    detailLoading.value = false;
  }
}

// 助手引用文章跳过来时带 ?slug=xx
watch(
  () => route.query.slug,
  (s) => {
    const slug = typeof s === 'string' ? s : '';
    if (slug && slug !== currentSlug.value) openArticle(slug, false);
  },
  { immediate: false },
);

// ---------------------------------------------------------------- AI 设置
const openAi = ref(false);
const saving = ref(false);
const status = ref<KbAiStatus | null>(null);
const form = ref({ name: 'platform-kb-assistant', provider: 'custom', apiEndpoint: '', modelId: '', apiKey: '' });

const sourceText = computed(() => {
  const map: Record<string, string> = { tenant: '租户配置', platform: '平台配置', env: '环境变量', none: '无（仅知识库）' };
  return status.value ? map[status.value.source] || status.value.source : '-';
});

async function loadStatus() {
  try {
    status.value = await apiKbStatus(null);
  } catch {
    status.value = null;
  }
}

async function saveConfig() {
  if (!form.value.apiEndpoint.trim() || !form.value.modelId.trim() || !form.value.apiKey.trim()) {
    ElMessage.warning('接口地址、模型 ID、API Key 都要填');
    return;
  }
  saving.value = true;
  try {
    const res = await apiKbSaveConfig({ ...form.value });
    ElMessage.success(`已保存平台级模型：${res.modelId}`);
    openAi.value = false;
    form.value.apiKey = '';
    await loadStatus();
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  await loadList();
  const s = typeof route.query.slug === 'string' ? route.query.slug : '';
  if (s) openArticle(s, false);
  await loadStatus();
});
</script>

<style scoped>
.kb-page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.kb-search { width: 280px; margin-right: 8px; }
.kb-body { flex: 1; display: flex; gap: 16px; min-height: 0; }
.kb-side { width: 320px; flex-shrink: 0; display: flex; flex-direction: column; padding: 0; overflow: hidden; }
.kb-cats { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px; border-bottom: 1px solid #ebeef5; }
.kb-cat {
  font-size: 12px; padding: 4px 8px; border-radius: 12px; background: #f2f5fa;
  color: #5b6b82; cursor: pointer; user-select: none;
}
.kb-cat:hover { background: #e6efff; }
.kb-cat.active { background: #1a73e8; color: #fff; }
.kb-cat-count { margin-left: 4px; opacity: 0.7; }
.kb-list { flex: 1; overflow-y: auto; padding: 8px; }
.kb-item { padding: 10px 12px; border-radius: 6px; cursor: pointer; border-left: 3px solid transparent; }
.kb-item:hover { background: #f6f8fa; }
.kb-item.active { background: #f0f6ff; border-left-color: #1a73e8; }
.kb-item-title { font-size: 14px; font-weight: 600; color: #303133; margin-bottom: 4px; }
.kb-item-sum { font-size: 12px; color: #909399; line-height: 1.5; }
.kb-main { flex: 1; overflow-y: auto; min-width: 0; padding: 24px 28px; }
.kb-art-head { display: flex; align-items: center; gap: 8px; }
.kb-art-head h1 { margin: 0; font-size: 20px; }
.kb-meta { display: flex; gap: 16px; margin: 8px 0 12px; font-size: 12px; color: #606266; }
.kb-summary {
  background: #f6f8fa; border-left: 3px solid #1a73e8; padding: 8px 12px;
  font-size: 13px; color: #5b6b82; border-radius: 4px; margin-bottom: 16px;
}
.kb-art-foot { margin-top: 28px; padding-top: 16px; border-top: 1px dashed #ebeef5; display: flex; align-items: center; gap: 12px; }
.ai-status { margin-bottom: 8px; }
.ai-status-line { margin-bottom: 16px; font-size: 12px; }
.ai-form { margin-top: 8px; }
.left { margin-right: auto; }
</style>

<style>
/* 正文 Markdown 全局样式（v-html 内的节点拿不到 scoped） */
.md-body { font-size: 14px; line-height: 1.75; color: #303133; }
.md-body .md-h2 { font-size: 18px; margin: 20px 0 10px; }
.md-body .md-h3 { font-size: 16px; margin: 18px 0 8px; color: #1a73e8; }
.md-body .md-h4 { font-size: 14px; margin: 14px 0 6px; color: #303133; }
.md-body .md-p { margin: 10px 0; }
.md-body .md-ul, .md-body .md-ol { margin: 8px 0 8px 20px; padding: 0; }
.md-body li { margin: 4px 0; }
.md-body .md-li-sub { margin-left: 18px; color: #606266; }
.md-body .md-table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 13px; }
.md-body .md-table th, .md-body .md-table td { border: 1px solid #e4e7ed; padding: 6px 10px; text-align: left; }
.md-body .md-table th { background: #f5f7fa; font-weight: 600; }
.md-body .md-table tr:nth-child(even) td { background: #fbfcfd; }
.md-body .md-quote {
  border-left: 3px solid #d9e2f0; background: #f8fafc; padding: 8px 12px;
  color: #606266; margin: 10px 0; border-radius: 4px;
}
.md-body .md-code {
  background: #f2f4f8; padding: 1px 5px; border-radius: 3px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: #c7254e;
}
.md-body strong { color: #1f2d3d; }
</style>
