<template>
  <!-- 关闭状态：右下角只剩一个悬浮球，点一下重新展开；也可以从左侧菜单「AI 助手」调出 -->
  <div v-if="!assistant.open" class="ai-fab" title="打开 AI 助手" @click="assistant.show()">
    <span class="ai-fab-icon">💬</span>
    <span class="ai-fab-text">AI 助手</span>
  </div>

  <div v-else class="ai-panel">
    <header class="ai-head">
      <div class="ai-title">
        <span class="ai-avatar">💬</span>
        <div>
          <div class="ai-name">AI 助手</div>
          <div class="ai-sub">基于平台知识库回答</div>
        </div>
      </div>
      <div class="ai-head-right">
        <el-select
          v-model="tenantId"
          size="small"
          class="ai-tenant"
          placeholder="不指定租户"
          clearable
          @change="onTenantChange"
        >
          <el-option :value="null" label="通用（不限租户）" />
          <el-option v-for="t in tenants" :key="t.id" :value="t.id" :label="`${t.name}（租户 ${t.id}）`" />
        </el-select>
        <el-button class="ai-close" text circle size="small" title="清空对话" @click="clearChat">
          <el-icon><Delete /></el-icon>
        </el-button>
        <!-- 关闭按钮：只收起面板，状态记在 localStorage；菜单里可再次打开 -->
        <el-button class="ai-close" text circle size="small" title="关闭助手" @click="assistant.close()">
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
        <p>你好，我是平台知识库助手。系统功能怎么用、报错怎么排查，直接问我。</p>
        <div class="ai-chips">
          <span v-for="(q, i) in quickQuestions" :key="i" class="ai-chip" @click="send(q)">{{ q }}</span>
        </div>
      </div>

      <div v-for="(m, i) in messages" :key="i" class="ai-msg" :class="m.role">
        <div v-if="m.role === 'user'" class="bubble user-bubble">{{ m.text }}</div>
        <div v-else class="bubble bot-bubble">
          <div v-if="m.loading" class="ai-typing"><span></span><span></span><span></span></div>
          <template v-else>
            <div class="bot-text" v-html="renderMarkdown(m.text)"></div>
            <div v-if="m.note" class="bot-note">{{ m.note }}</div>
            <div v-if="m.refs?.length" class="bot-refs">
              <div class="refs-title">参考文章</div>
              <div v-for="r in m.refs" :key="r.slug" class="ref-item" @click="gotoArticle(r.slug)">
                <span class="ref-tag">{{ r.tag }}</span>
                <span class="ref-title">{{ r.title }}</span>
                <span class="ref-cat">{{ r.category }}</span>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <footer class="ai-foot">
      <el-input
        v-model="draft"
        type="textarea"
        :rows="2"
        resize="none"
        maxlength="1000"
        placeholder="问功能用法、操作步骤、报错排查…（Enter 发送，Shift+Enter 换行）"
        @keydown.enter.exact.prevent="send()"
      />
      <div class="ai-foot-bar">
        <span class="muted sub">{{ tenantId ? `按租户 ${tenantId} 的 AI 配置优先` : '租户配置 > 平台配置' }}</span>
        <el-button type="primary" size="small" :loading="asking" :disabled="!draft.trim()" @click="send()">
          发送
        </el-button>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { apiListTenants } from '@/api';
import { apiKbAsk, apiKbStatus, type KbAiStatus, type KbRef } from '@/api/kb';
import { useAssistantStore } from '@/store/assistant';
import { renderMarkdown } from '@/utils/md';

interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
  loading?: boolean;
  refs?: KbRef[];
  note?: string | null;
  answeredBy?: string;
}

const CHAT_KEY = 'labelflow_platform_ai_chat';
const router = useRouter();
const assistant = useAssistantStore();

const draft = ref('');
const asking = ref(false);
const listEl = ref<HTMLElement | null>(null);
const tenantId = ref<number | null>(null);
const tenants = ref<Array<{ id: number; name: string }>>([]);
const status = ref<KbAiStatus | null>(null);

const quickQuestions = [
  '怎么给物料建标签模板？',
  'PDA 收货扫码提示 GTIN 不符怎么办？',
  '发料时退货怎么操作？',
  '哪些功能要单独订阅模块？',
];

const messages = ref<ChatMsg[]>(readChat());

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
    // 只留用户问题与最终回答，别把 loading 态存进去
    const clean = messages.value.filter((m) => !m.loading).slice(-20);
    localStorage.setItem(CHAT_KEY, JSON.stringify(clean));
  } catch {
    /* 配额满了就算了，聊天记录不是关键数据 */
  }
}

const statusText = computed(() => {
  if (!status.value) return '正在读取 AI 配置…';
  const map: Record<string, string> = {
    tenant: `当前用租户 ${tenantId.value ?? ''} 的模型`,
    platform: '当前用平台级模型',
    env: '当前用环境变量里的模型',
    none: '未配置 AI，回答为知识库原文整理',
  };
  return map[status.value.source] || status.value.note;
});
const statusClass = computed(() =>
  status.value?.configured ? 'ok' : status.value ? 'warn' : 'muted-row',
);

function scrollBottom() {
  nextTick(() => {
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight;
  });
}

/** 长答案（知识库原文可能十几行）滚动到这条回答的开头，否则用户只能看到结尾 */
function scrollToMsg(index: number) {
  nextTick(() => {
    const list = listEl.value;
    const el = list?.querySelectorAll('.ai-msg')[index] as HTMLElement | undefined;
    if (!list || !el) return;
    // 用 rect 差值算相对列表顶部的距离：offsetTop 的 offsetParent 是面板而不是滚动容器
    const delta = el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    list.scrollTop = Math.max(0, delta - 8);
  });
}

function clearChat() {
  messages.value = [];
  localStorage.removeItem(CHAT_KEY);
  assistant.show();
}

async function loadStatus() {
  try {
    status.value = await apiKbStatus(tenantId.value);
  } catch {
    status.value = null;
  }
}

function onTenantChange() {
  loadStatus();
}

async function send(text?: string) {
  const q = (text ?? draft.value).trim();
  if (!q || asking.value) return;
  draft.value = '';
  messages.value.push({ role: 'user', text: q });
  const bot: ChatMsg = { role: 'assistant', text: '', loading: true };
  messages.value.push(bot);
  const botIndex = messages.value.length - 1;
  asking.value = true;
  scrollBottom();

  try {
    const res = await apiKbAsk(q, { tenantId: tenantId.value });
    bot.text = res.answer || '（没有返回内容）';
    bot.refs = res.refs;
    bot.note = res.note;
    bot.answeredBy = res.answeredBy;
    bot.loading = false;
  } catch (e: any) {
    bot.loading = false;
    bot.text = `抱歉，这次没答上来：${e?.message || '接口异常'}`;
    bot.note = '可以换个说法，或直接浏览左侧「知识库」的对应章节。';
  } finally {
    asking.value = false;
    saveChat();
    scrollToMsg(botIndex);
  }
}

function gotoArticle(slug: string) {
  router.push({ path: '/knowledge', query: { slug } });
  assistant.close();
}

// 菜单点「AI 助手」调出来时，焦点直接落到输入框、状态刷新一次
watch(
  () => assistant.open,
  (v) => {
    if (v) {
      loadStatus();
      scrollBottom();
    }
  },
);

onMounted(async () => {
  await loadStatus();
  scrollBottom();
  try {
    const rows = await apiListTenants();
    tenants.value = (rows || []).map((t: any) => ({ id: t.id, name: t.name }));
  } catch {
    tenants.value = [];
  }
});
</script>

<style scoped>
.ai-fab {
  position: fixed; right: 24px; bottom: 24px; z-index: 2000;
  display: flex; align-items: center; gap: 6px;
  padding: 10px 16px; border-radius: 24px; cursor: pointer;
  background: linear-gradient(135deg, #1a73e8, #4f9bff); color: #fff;
  box-shadow: 0 6px 18px rgba(26, 115, 232, 0.35);
  font-size: 13px; user-select: none; transition: transform .15s;
}
.ai-fab:hover { transform: translateY(-2px); }
.ai-fab-icon { font-size: 16px; }

.ai-panel {
  position: fixed; right: 24px; bottom: 24px; z-index: 2000;
  width: 400px; height: 580px; max-height: calc(100vh - 100px);
  background: #fff; border-radius: 12px; overflow: hidden;
  display: flex; flex-direction: column;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18); border: 1px solid #e6ebf3;
}
.ai-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; background: linear-gradient(135deg, #16233a, #1a3f70); color: #fff;
}
.ai-title { display: flex; align-items: center; gap: 8px; }
.ai-avatar {
  width: 30px; height: 30px; border-radius: 50%; background: rgba(255,255,255,.16);
  display: flex; align-items: center; justify-content: center; font-size: 15px;
}
.ai-name { font-size: 14px; font-weight: 600; }
.ai-sub { font-size: 11px; opacity: .75; }
.ai-head-right { display: flex; align-items: center; gap: 4px; }
.ai-tenant { width: 130px; }
.ai-close { color: #fff; }
.ai-close:hover { background: rgba(255,255,255,.15); color: #fff; }

.ai-status {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; padding: 6px 12px; background: #f7f9fc; color: #606266;
  border-bottom: 1px solid #eef2f7;
}
.ai-status .dot { width: 6px; height: 6px; border-radius: 50%; background: #c0c4cc; }
.ai-status.ok .dot { background: #67c23a; }
.ai-status.warn .dot { background: #e6a23c; }

.ai-list { flex: 1; overflow-y: auto; padding: 12px; background: #fafbfd; }
.ai-welcome { font-size: 13px; color: #606266; line-height: 1.7; }
.ai-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.ai-chip {
  font-size: 12px; padding: 5px 10px; border-radius: 12px; cursor: pointer;
  background: #fff; border: 1px solid #dbe6f5; color: #1a73e8;
}
.ai-chip:hover { background: #eef5ff; }

.ai-msg { display: flex; margin-bottom: 10px; }
.ai-msg.user { justify-content: flex-end; }
.bubble { max-width: 88%; border-radius: 10px; padding: 8px 10px; font-size: 13px; line-height: 1.6; }
.user-bubble { background: #1a73e8; color: #fff; border-bottom-right-radius: 3px; white-space: pre-wrap; }
.bot-bubble { background: #fff; border: 1px solid #e8eef6; border-bottom-left-radius: 3px; color: #303133; }
.bot-text :deep(.md-body) { font-size: 13px; }
.ai-typing { display: flex; gap: 4px; padding: 4px 2px; }
.ai-typing span {
  width: 6px; height: 6px; border-radius: 50%; background: #b8c4d9;
  animation: ai-blink 1.2s infinite;
}
.ai-typing span:nth-child(2) { animation-delay: .2s; }
.ai-typing span:nth-child(3) { animation-delay: .4s; }
@keyframes ai-blink { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }

.bot-note { margin-top: 8px; font-size: 11px; color: #b07d20; background: #fff8e6; padding: 5px 8px; border-radius: 4px; }
.bot-refs { margin-top: 10px; border-top: 1px dashed #e8eef6; padding-top: 8px; }
.refs-title { font-size: 11px; color: #909399; margin-bottom: 4px; }
.ref-item {
  display: flex; align-items: center; gap: 6px; font-size: 12px;
  padding: 4px 6px; border-radius: 4px; cursor: pointer; color: #1a73e8;
}
.ref-item:hover { background: #f2f7ff; }
.ref-tag { font-size: 10px; background: #eef5ff; color: #1a73e8; padding: 0 4px; border-radius: 3px; }
.ref-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ref-cat { font-size: 10px; color: #a8abb2; }

.ai-foot { border-top: 1px solid #eef2f7; padding: 8px 10px 10px; background: #fff; }
.ai-foot-bar { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
.sub { font-size: 11px; }
</style>

<style>
/* 助手气泡里的 Markdown 走 v-html，需要全局样式 */
.ai-panel .md-body { font-size: 13px; line-height: 1.65; }
.ai-panel .md-body .md-h3 { font-size: 14px; color: #1a73e8; margin: 10px 0 4px; }
.ai-panel .md-body .md-h4 { font-size: 13px; margin: 8px 0 4px; }
.ai-panel .md-body .md-p { margin: 6px 0; }
.ai-panel .md-body .md-table { font-size: 12px; }
.ai-panel .md-body .md-table th, .ai-panel .md-body .md-table td { padding: 4px 6px; }
.ai-panel .md-body .md-code { font-size: 12px; }
</style>
