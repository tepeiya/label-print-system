<template>
  <!-- 收起态：右下角悬浮球；点开就是面板 -->
  <div v-if="!open" class="ai-fab" title="打开 AI 助手" @click="show">
    <span class="ai-fab-icon">💬</span>
    <span class="ai-fab-text">AI 助手</span>
  </div>

  <div v-else class="ai-panel">
    <header class="ai-head">
      <div class="ai-title">
        <span class="ai-avatar">💬</span>
        <div>
          <div class="ai-name">AI 助手</div>
          <div class="ai-sub">基于产品知识库回答"怎么用"</div>
        </div>
      </div>
      <div class="ai-head-right">
        <el-button text circle size="small" title="清空对话" @click="clearChat">
          <el-icon><Delete /></el-icon>
        </el-button>
        <el-button text circle size="small" title="收起" @click="close">
          <el-icon><Close /></el-icon>
        </el-button>
      </div>
    </header>

    <div class="ai-status" :class="statusClass">
      <span class="dot"></span>
      {{ statusText }}
    </div>

    <div ref="listEl" class="ai-list">
      <div v-if="!messages.length" class="ai-welcome">
        <p>模板怎么设计、打印报错怎么排查、条码扫不出是什么原因，直接问我。</p>
        <div class="ai-chips">
          <span v-for="(s, i) in suggestions" :key="i" class="ai-chip" @click="send(s.question)">{{ s.question }}</span>
        </div>
        <p v-if="!suggestions.length" class="ai-tip">正在读取常见问题…</p>
      </div>

      <div v-for="(m, i) in messages" :key="i" class="ai-msg" :class="m.role">
        <div v-if="m.role === 'user'" class="bubble user-bubble">{{ m.text }}</div>
        <div v-else class="bubble bot-bubble">
          <div v-if="m.loading" class="ai-typing"><span></span><span></span><span></span></div>
          <template v-else>
            <div class="bot-text" v-html="formatAnswer(m.text)" />
            <div v-if="m.note" class="bot-note">{{ m.note }}</div>
            <div v-if="m.refs?.length" class="bot-refs">
              <div class="refs-title">参考文章</div>
              <span v-for="r in m.refs" :key="r.slug" class="ref-chip" @click="openArticle(r.slug)">
                {{ r.title }}
              </span>
            </div>
          </template>
        </div>
      </div>
    </div>

    <div class="ai-input">
      <el-input
        v-model="draft"
        size="small"
        placeholder="例如：条码扫不出怎么办"
        :disabled="asking"
        @keyup.enter="send()"
      />
      <el-button type="primary" size="small" :loading="asking" @click="send()">发送</el-button>
    </div>

    <!-- 文章详情：助手引用的原文，直接读全文，不用跳页面 -->
    <el-dialog v-model="articleVisible" :title="article?.title || '文章'" width="640px" append-to-body>
      <div v-if="article" class="ai-article" v-html="formatAnswer(article.content)" />
      <div v-else class="ai-tip">加载中…</div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
// =============================================================================
// AiAssistant.vue —— 租户端 AI 助手悬浮球（console）
//   与平台端同名组件的差别：
//   · 没有租户下拉（租户身份由登录 token 决定，后端按 token 取租户）；
//   · 知识库只读 scope='tenant' 的产品使用内容，平台运营内容不会出现在这里。
//   · 只用"怎么用"类问答，不替用户点按钮、不改配置、不查业务数据。
// =============================================================================
import { computed, nextTick, onMounted, ref } from 'vue';
import { Close, Delete } from '@element-plus/icons-vue';
import {
  apiAssistantArticle, apiAssistantAsk, apiAssistantStatus, apiAssistantSuggestions,
  type AssistantAnswer, type AssistantArticle, type AssistantRef, type AssistantStatus, type AssistantSuggestion,
} from '@/api/assistant';

interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
  loading?: boolean;
  refs?: AssistantRef[];
  note?: string | null;
}

const OPEN_KEY = 'labelflow_console_ai_open';
const CHAT_KEY = 'labelflow_console_ai_chat';

const open = ref(false);
const draft = ref('');
const asking = ref(false);
const listEl = ref<HTMLElement | null>(null);
const status = ref<AssistantStatus | null>(null);
const suggestions = ref<AssistantSuggestion[]>([]);
const messages = ref<ChatMsg[]>(readChat());
const articleVisible = ref(false);
const article = ref<AssistantArticle | null>(null);

function readChat(): ChatMsg[] {
  try {
    const raw = localStorage.getItem(CHAT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.slice(-20).map((m: ChatMsg) => ({ ...m, loading: false })) : [];
  } catch {
    return [];
  }
}

function saveChat() {
  try {
    localStorage.setItem(CHAT_KEY, JSON.stringify(messages.value.filter((m) => !m.loading).slice(-20)));
  } catch {
    /* 配额满了不影响问答 */
  }
}

function show() { open.value = true; localStorage.setItem(OPEN_KEY, '1'); scrollBottom(); }
function close() { open.value = false; localStorage.setItem(OPEN_KEY, '0'); }

const statusText = computed(() => {
  if (!status.value) return '正在读取 AI 配置…';
  return status.value.configured
    ? `已接入模型：${status.value.model || '—'}`
    : '未接入模型：回答为知识库原文整理，同样可用';
});
const statusClass = computed(() => (status.value ? (status.value.configured ? 'ok' : 'warn') : 'muted'));

function scrollBottom() {
  nextTick(() => {
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight;
  });
}

/**
 * 极简 markdown：后端答案是知识库原文 + 模型润色，可能带 ## 标题、**加粗**、表格行。
 * 这里只做"能读"的处理（转义 → 去标题符号 → 加粗 → 换行），不引入完整 md 解析器。
 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 行内标记：粗体、行内代码；顺带把模型爱写的“依据：K1、K3”收回成一句人话
function inlineMd(text: string): string {
  return text
    .replace(/依据：K\d+(\s*、\s*K\d+)*/g, '依据：见下方参考文章')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

// markdown 表格 → 真表格（知识库里的“报错 | 原因 | 处理”对照表全靠它）
function renderTable(block: string[]): string {
  const rows = block
    .filter((l) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(l)) // 去掉 |---|---| 分隔行
    .map((l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => inlineMd(c.trim())));
  if (!rows.length) return '';
  const head = rows[0].map((c) => `<th>${c}</th>`).join('');
  const body = rows.slice(1).map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function formatAnswer(raw: string): string {
  const lines = escapeHtml(String(raw ?? '')).split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|/.test(line)) {
      const block: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) block.push(lines[i++]);
      out.push(renderTable(block));
      continue;
    }
    out.push(inlineMd(line.replace(/^#{1,6}\s+/, '')));
    i++;
  }
  return out.join('<br>').replace(/<\/table><br>/g, '</table>');
}

async function send(text?: string) {
  const q = String(text ?? draft.value ?? '').trim();
  if (!q || asking.value) return;
  draft.value = '';
  if (!open.value) show();
  messages.value.push({ role: 'user', text: q });
  const bot: ChatMsg = { role: 'assistant', text: '', loading: true };
  messages.value.push(bot);
  saveChat();
  scrollBottom();
  asking.value = true;
  const t0 = Date.now();
  try {
    const r = await apiAssistantAsk(q, 4) as unknown as AssistantAnswer;
    bot.loading = false;
    bot.text = r?.answer || '（没有拿到答案，请稍后再试）';
    bot.refs = r?.refs ?? [];
    bot.note = r?.answeredBy === 'llm_failed'
      ? '模型调用失败，已退回知识库原文整理'
      : (r?.aiSource === 'none' ? '未接入模型，本条为知识库原文整理' : null);
  } catch (e: any) {
    bot.loading = false;
    bot.text = `出错了：${e?.message || '请求失败，请稍后再试'}`;
  } finally {
    asking.value = false;
    saveChat();
    scrollBottom();
    // 慢查询只在日志里留痕，不打扰用户
    if (Date.now() - t0 > 15000) console.warn('[ai] 回答耗时过长', Date.now() - t0);
  }
}

function clearChat() {
  messages.value = [];
  saveChat();
}

async function openArticle(slug: string) {
  article.value = null;
  articleVisible.value = true;
  try {
    article.value = await apiAssistantArticle(slug) as unknown as AssistantArticle;
  } catch {
    article.value = { slug, title: '加载失败', category: '', summary: null, content: '文章加载失败，请稍后重试。' };
  }
}

onMounted(async () => {
  open.value = localStorage.getItem(OPEN_KEY) === '1';
  try {
    status.value = await apiAssistantStatus() as unknown as AssistantStatus;
  } catch {
    status.value = null;
  }
  try {
    const r = await apiAssistantSuggestions(6) as unknown as { items: AssistantSuggestion[] };
    suggestions.value = r?.items ?? [];
  } catch {
    suggestions.value = [];
  }
});
</script>

<style scoped>
.ai-fab {
  position: fixed; right: 18px; bottom: 18px; z-index: 3000;
  display: flex; align-items: center; gap: 6px;
  padding: 9px 14px; border-radius: 24px;
  background: var(--el-color-primary, #2563eb); color: #fff; cursor: pointer;
  box-shadow: 0 6px 18px rgba(37, 99, 235, .35);
  font-size: 13px; user-select: none;
}
.ai-fab:hover { filter: brightness(1.08); }
.ai-fab-icon { font-size: 15px; }

.ai-panel {
  position: fixed; right: 18px; bottom: 18px; z-index: 3001;
  width: 380px; height: 74vh; max-height: 640px;
  display: flex; flex-direction: column;
  background: #fff; border: 1px solid #e4e7ed; border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, .16);
  overflow: hidden;
}
.ai-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-bottom: 1px solid #f0f2f5;
}
.ai-title { display: flex; align-items: center; gap: 8px; }
.ai-avatar { font-size: 18px; }
.ai-name { font-size: 14px; font-weight: 600; color: #1f2937; }
.ai-sub { font-size: 11px; color: #8a919f; }
.ai-head-right { display: flex; align-items: center; }

.ai-status { display: flex; align-items: center; gap: 6px; padding: 6px 12px; font-size: 11px; background: #fafafa; color: #6b7280; }
.ai-status .dot { width: 6px; height: 6px; border-radius: 50%; background: #c0c4cc; }
.ai-status.ok .dot { background: #22c55e; }
.ai-status.warn .dot { background: #f59e0b; }

.ai-list { flex: 1; overflow-y: auto; padding: 12px; background: #f7f8fa; }
.ai-welcome { font-size: 12px; color: #606266; line-height: 1.7; }
.ai-welcome p { margin: 0 0 8px; }
.ai-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ai-chip { padding: 4px 9px; border-radius: 12px; background: #fff; border: 1px solid #e4e7ed; cursor: pointer; font-size: 11px; color: #4b5563; }
.ai-chip:hover { border-color: var(--el-color-primary, #2563eb); color: var(--el-color-primary, #2563eb); }
.ai-tip { font-size: 11px; color: #9ca3af; margin: 6px 0 0; }

.ai-msg { display: flex; margin-bottom: 10px; }
.ai-msg.user { justify-content: flex-end; }
.bubble { max-width: 86%; padding: 9px 11px; border-radius: 10px; font-size: 12.5px; line-height: 1.65; word-break: break-word; }
.user-bubble { background: var(--el-color-primary, #2563eb); color: #fff; }
.bot-bubble { background: #fff; border: 1px solid #eceff3; color: #303133; }
.bot-text b { font-weight: 600; }
.bot-text code { background: #f2f3f5; padding: 0 3px; border-radius: 3px; font-size: 11.5px; }
.bot-text table { width: 100%; max-width: 100%; border-collapse: collapse; margin: 6px 0; font-size: 11px; display: block; overflow-x: auto; }
.bot-text th, .bot-text td { border: 1px solid #e5e7eb; padding: 3px 6px; text-align: left; white-space: nowrap; }
.bot-text th { background: #f5f7fa; font-weight: 600; }
.bot-note { margin-top: 6px; font-size: 11px; color: #9ca3af; }
.bot-refs { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.refs-title { font-size: 11px; color: #9ca3af; width: 100%; }
.ref-chip { font-size: 11px; padding: 3px 8px; border-radius: 10px; background: #f2f6ff; color: #2563eb; cursor: pointer; }
.ref-chip:hover { text-decoration: underline; }

.ai-typing span { display: inline-block; width: 5px; height: 5px; margin-right: 3px; border-radius: 50%; background: #c0c4cc; animation: ai-blink 1.2s infinite; }
.ai-typing span:nth-child(2) { animation-delay: .2s; }
.ai-typing span:nth-child(3) { animation-delay: .4s; }
@keyframes ai-blink { 0%, 80%, 100% { opacity: .35; } 40% { opacity: 1; } }

.ai-input { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid #f0f2f5; background: #fff; }
.ai-article { font-size: 13px; line-height: 1.8; color: #303133; max-height: 62vh; overflow-y: auto; }
</style>
