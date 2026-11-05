<template>
  <div>
    <div class="page-header">
      <h2>🔌 Agent 接入</h2>
      <el-button type="primary" v-permission.hide="'sys:agent:manage'" @click="openCreate">
        <el-icon><Plus /></el-icon> 新建 Agent
      </el-button>
    </div>

    <el-alert type="info" :closable="false" show-icon class="explain">
      <template #title>一个 Agent 客户端 = 一个可以拿 Token 调系统的外部程序（MCP / 内部脚本）。</template>
      <div class="explain-body">
        Token 明文只在签发那一刻给你一次，服务端只存 sha256，忘了只能重新签发；
        停用客户端会让它手上<b>所有 Token 立刻失效</b>。高危写操作仍需到「Agent 待确认」页人工放行。
      </div>
    </el-alert>

    <div class="card">
      <el-table
        ref="tableRef"
        :data="rows"
        v-loading="loading"
        stripe
        size="small"
        style="width: 100%"
        @expand-change="onExpand"
      >
        <!-- Token 管理挂在展开行里：一个客户端一组 Token，不必再跳一层路由 -->
        <el-table-column type="expand" width="42">
          <template #default="{ row }">
            <div class="tokens">
              <div class="tokens-head">
                <b>Token（{{ (tokenMap[row.id] || []).length }}）</b>
                <span class="hint">后端只回 sha256 指纹尾 8 位，明文无法找回</span>
                <div class="tokens-actions">
                  <el-button link size="small" @click="loadTokens(row.id, true)">重新拉取</el-button>
                  <el-button
                    link size="small" type="primary"
                    v-permission.hide="'sys:agent:manage'"
                    @click="openIssue(row)"
                  >签发新 Token</el-button>
                </div>
              </div>

              <el-table
                :data="tokenMap[row.id] || []"
                v-loading="!!tokenLoading[row.id]"
                size="small"
                empty-text="还没有 Token —— 点右上角「签发新 Token」生成一个"
              >
                <el-table-column prop="id" label="ID" width="70" />
                <el-table-column label="指纹" width="120">
                  <template #default="{ row: t }"><code class="mono">{{ t.hashTail }}</code></template>
                </el-table-column>
                <el-table-column label="scopes" min-width="280">
                  <template #default="{ row: t }">
                    <div class="scopes">
                      <el-tag v-for="s in t.scopes" :key="s" size="small" type="info">{{ s }}</el-tag>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column label="状态" width="100">
                  <template #default="{ row: t }">
                    <el-tag v-if="t.revoked" type="danger" size="small">已撤销</el-tag>
                    <el-tag v-else-if="expired(t)" type="warning" size="small">已过期</el-tag>
                    <el-tag v-else type="success" size="small">可用</el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="到期" width="160">
                  <template #default="{ row: t }">{{ formatTime(t.expiresAt) }}</template>
                </el-table-column>
                <el-table-column label="末次使用" width="160">
                  <template #default="{ row: t }">
                    <span v-if="t.lastUsedAt">{{ formatTime(t.lastUsedAt) }}</span>
                    <span v-else class="hint">从未使用</span>
                  </template>
                </el-table-column>
                <el-table-column label="操作" width="90" fixed="right">
                  <template #default="{ row: t }">
                    <el-popconfirm
                      v-if="!t.revoked"
                      :title="`撤销后该 Token 立即失效，Agent 侧调用会报鉴权失败。确认撤销 #${t.id}？`"
                      width="260"
                      @confirm="doRevoke(row.id, t.id)"
                    >
                      <template #reference>
                        <el-button link size="small" type="danger" v-permission.hide="'sys:agent:manage'">
                          撤销
                        </el-button>
                      </template>
                    </el-popconfirm>
                    <span v-else class="hint">—</span>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </template>
        </el-table-column>

        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="名称" min-width="170" />
        <el-table-column label="类型" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="kindTag(row.kind)">{{ kindLabel(row.kind) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="140">
          <template #default="{ row }">
            <el-switch
              :model-value="row.status === 'active'"
              :disabled="!canManage"
              :loading="!!statusBusy[row.id]"
              active-text="启用"
              inactive-text="停用"
              inline-prompt
              @change="() => toggleStatus(row)"
            />
            <span v-if="row.status !== 'active'" class="hint" style="margin-left: 6px;">已停用</span>
          </template>
        </el-table-column>
        <el-table-column label="描述" min-width="200">
          <template #default="{ row }">
            <span v-if="row.description">{{ row.description }}</span>
            <span v-else class="hint">—</span>
          </template>
        </el-table-column>
        <el-table-column label="Token" width="80">
          <template #default="{ row }">{{ row.tokenCount ?? 0 }}</template>
        </el-table-column>
        <el-table-column label="末次使用" width="160">
          <template #default="{ row }">
            <span v-if="row.lastUsedAt">{{ formatTime(row.lastUsedAt) }}</span>
            <span v-else class="hint">—</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="160">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button link size="small" @click="toggleExpand(row)">Token</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-if="!loading && !rows.length" description="还没有 Agent 客户端，点右上角新建一个" />

      <el-pagination
        v-if="total > 0"
        class="pager"
        layout="total, sizes, prev, pager, next, jumper"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        :page-size="query.pageSize"
        :current-page="query.page"
        @current-change="onPage"
        @size-change="onSize"
      />
    </div>

    <!-- 新建 Agent -->
    <el-dialog v-model="createDialog.show" title="新建 Agent 客户端" width="480px">
      <el-form ref="createFormRef" :model="createDialog.form" :rules="createRules" label-width="80px">
        <el-form-item label="名称" prop="name">
          <el-input v-model="createDialog.form.name" maxlength="80" show-word-limit placeholder="例：WMS 对接 Agent" />
        </el-form-item>
        <el-form-item label="类型" prop="kind">
          <el-select v-model="createDialog.form.kind" style="width: 100%;">
            <el-option label="MCP stdio（本地进程，标准输入输出）" value="mcp_stdio" />
            <el-option label="MCP HTTP（远程 HTTP 服务）" value="mcp_http" />
            <el-option label="internal（站内自调）" value="internal" />
          </el-select>
        </el-form-item>
        <el-form-item label="描述" prop="description">
          <el-input
            v-model="createDialog.form.description"
            type="textarea"
            :rows="2"
            maxlength="300"
            show-word-limit
            placeholder="可选，给接手的同事看：这个 Agent 用来做什么"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog.show = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 签发 Token -->
    <el-dialog v-model="issueDialog.show" title="签发 Token" width="540px">
      <div class="issue-context">
        客户端：<b>{{ issueDialog.client?.name }}</b>
        <span class="hint">（scope 必须 ⊆ 你自己的权限，超管除外 —— 后端 §11.7.7 护栏 1）</span>
      </div>
      <el-form :model="issueDialog" label-width="96px">
        <el-form-item label="有效期（天）" required>
          <el-input-number v-model="issueDialog.expiresInDays" :min="1" :max="365" controls-position="right" />
          <span class="hint" style="margin-left: 8px;">1–365，到期后 Agent 调用直接被拒</span>
        </el-form-item>
        <el-form-item label="scopes">
          <el-select
            v-model="issueDialog.scopes"
            multiple filterable allow-create default-first-option clearable
            style="width: 100%;"
            placeholder="留空 = 只读集合（后端默认）"
          >
            <el-option v-for="s in SCOPE_SUGGESTIONS" :key="s" :label="s" :value="s" />
          </el-select>
          <div class="hint">
            留空则使用后端默认只读集合：{{ READ_SCOPE_HINT }}；手输其它权限点需你自己也有
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="issueDialog.show = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="doIssue">签发</el-button>
      </template>
    </el-dialog>

    <!-- 一次性明文：关掉就再也没有第二次 -->
    <el-dialog
      v-model="issuedDialog.show"
      title="Token 已签发 —— 明文只显示这一次"
      width="640px"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
      :show-close="false"
      top="8vh"
    >
      <el-alert type="error" :closable="false" show-icon class="once-alert">
        <template #title>
          <span class="once-title">立刻复制走并存到安全的地方 —— 关闭这个窗口后就再也看不到了。</span>
        </template>
        <div class="once-body">
          服务端只保存 sha256，任何人都无法找回（包括管理员）。丢了只能撤销旧的再签发一个新的。
          <b>不要贴到聊天工具、工单或代码里</b>，它等同于这个租户的登录凭证。
        </div>
      </el-alert>

      <el-input
        :model-value="issuedDialog.data?.token || ''"
        type="textarea"
        readonly
        :autosize="{ minRows: 3, maxRows: 5 }"
        class="once-token"
        data-testid="plain-token"
      />

      <el-descriptions :column="1" border size="small" class="once-meta">
        <el-descriptions-item label="指纹（列表里用这个认）">{{ issuedDialog.data?.tokenMasked }}</el-descriptions-item>
        <el-descriptions-item label="scopes">
          <div class="scopes">
            <el-tag v-for="s in issuedDialog.data?.scopes || []" :key="s" size="small" type="info">{{ s }}</el-tag>
          </div>
        </el-descriptions-item>
        <el-descriptions-item label="到期">{{ formatTime(issuedDialog.data?.expiresAt) }}</el-descriptions-item>
        <el-descriptions-item label="用法">
          <code class="mono">Authorization: Bearer &lt;token&gt;</code>
          <span class="hint">（MCP server 侧配 agent token）</span>
        </el-descriptions-item>
      </el-descriptions>

      <template #footer>
        <el-button type="primary" :icon="copied ? 'Check' : 'DocumentCopy'" @click="doCopy">
          {{ copied ? '已复制' : '复制到剪贴板' }}
        </el-button>
        <el-button @click="closeIssued">我已复制，关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
// ============================================================================
// Agents —— Agent 客户端 + Token 管理（docs/11 §11.6.1 / §11.7.7，P4/P5）
//
// 全部写操作后端是 sys:agent:manage 单权限（不像审批页有 approve 兜底），
// 所以整页操作按 manage 判定即可。
// 契约里几个容易踩的点（都对着跑着的后端验过）：
//   - GET /agents 只回 { items, total }，没有 page/pageSize，分页得自己记住；
//   - GET /agents/:id/tokens 直接回数组；
//   - POST /agents/:id/tokens 不返回 token id，只回一次性明文 → 列表要重新拉。
// ============================================================================
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import {
  apiCreateAgent, apiCreateAgentToken, apiListAgents, apiListAgentTokens,
  apiRevokeAgentToken, apiSetAgentStatus,
  type AgentClient, type AgentClientKind, type AgentToken, type AgentTokenIssued,
} from '@/api';
import { useAuthStore } from '@/store/auth';

const auth = useAuthStore();
const canManage = computed(() => auth.hasPermission('sys:agent:manage'));

/** scope 建议项：只读集合（= 后端 defaultReadScopes）+ 常见高危写权限 */
const SCOPE_SUGGESTIONS = [
  'template:read', 'inventory:stock:read', 'inventory:batch:read', 'bom:kit:read', 'bom:shortage:read',
  'inventory:stock:adjust', 'inventory:stock:transfer', 'print:job:submit',
];
const READ_SCOPE_HINT = 'template:read / inventory:stock:read / inventory:batch:read / bom:kit:read / bom:shortage:read';

const loading = ref(false);
const saving = ref(false);
const rows = ref<AgentClient[]>([]);
const total = ref(0);
const query = reactive({ page: 1, pageSize: 20 });

const tableRef = ref<any>();
const statusBusy = reactive<Record<number, boolean>>({});
const tokenMap = reactive<Record<number, AgentToken[]>>({});
const tokenLoading = reactive<Record<number, boolean>>({});

const formatTime = (t: any) => (t ? new Date(t).toLocaleString() : '—');
const expired = (t: AgentToken) => !!t.expiresAt && new Date(t.expiresAt).getTime() <= Date.now();

function kindLabel(k: string) {
  if (k === 'mcp_stdio') return 'mcp_stdio';
  if (k === 'mcp_http') return 'mcp_http';
  if (k === 'internal') return 'internal';
  return k;
}
function kindTag(k: string): 'primary' | 'success' | 'warning' | 'info' {
  if (k === 'mcp_stdio') return 'primary';
  if (k === 'mcp_http') return 'success';
  if (k === 'internal') return 'warning';
  return 'info';
}

async function load() {
  loading.value = true;
  try {
    const res: any = await apiListAgents({ page: query.page, pageSize: query.pageSize });
    rows.value = res?.items ?? [];
    total.value = Number(res?.total ?? rows.value.length);
  } catch { /* 拦截器已弹错 */ } finally {
    loading.value = false;
  }
}

function onPage(p: number) { query.page = p; load(); }
function onSize(n: number) { query.pageSize = n; query.page = 1; load(); }

async function loadTokens(clientId: number, force = false) {
  if (!force && tokenMap[clientId]) return;
  tokenLoading[clientId] = true;
  try {
    // 后端这里直接回数组，不是 { items }
    tokenMap[clientId] = (await apiListAgentTokens(clientId)) as any ?? [];
  } catch {
    tokenMap[clientId] = [];
  } finally {
    tokenLoading[clientId] = false;
  }
}

/** 展开行时懒加载该客户端的 token（loadTokens 内部有缓存，重复展开不再打接口） */
function onExpand(row: AgentClient) { loadTokens(row.id); }

/** 「Token」按钮：展开对应行并拉一次 token 列表 */
function toggleExpand(row: AgentClient) {
  tableRef.value?.toggleRowExpansion(row);
  loadTokens(row.id);
}

async function toggleStatus(row: AgentClient) {
  const next = row.status === 'active' ? 'disabled' : 'active';
  if (next === 'disabled') {
    try {
      await ElMessageBox.confirm(
        `停用后「${row.name}」手上的 ${row.tokenCount ?? 0} 个 Token 会立即全部失效，Agent 侧调用马上报鉴权失败。确认停用？`,
        '停用 Agent 客户端',
        { type: 'warning', confirmButtonText: '停用', cancelButtonText: '取消' },
      );
    } catch { return; }
  }
  statusBusy[row.id] = true;
  try {
    await apiSetAgentStatus(row.id, next);
    row.status = next;
    ElMessage.success(next === 'active' ? `已启用 ${row.name}` : `已停用 ${row.name}（其 Token 立即失效）`);
  } catch { /* 拦截器已弹错；状态不改，switch 由 model-value 兜回原样 */ } finally {
    statusBusy[row.id] = false;
  }
}

// ---------------------------------------------------------------- 新建客户端

const createFormRef = ref<FormInstance>();
const createDialog = reactive<{ show: boolean; form: { name: string; description: string; kind: AgentClientKind } }>({
  show: false,
  form: { name: '', description: '', kind: 'mcp_stdio' },
});
const createRules: FormRules = {
  name: [
    { required: true, message: '请输入名称', trigger: 'blur' },
    { max: 80, message: '名称不超过 80 个字符', trigger: 'blur' },
  ],
  description: [{ max: 300, message: '描述不超过 300 个字符', trigger: 'blur' }],
  kind: [{ required: true, message: '请选择类型', trigger: 'change' }],
};

function openCreate() {
  createDialog.form = { name: '', description: '', kind: 'mcp_stdio' };
  createDialog.show = true;
}

async function doCreate() {
  if (!createFormRef.value) return;
  try { await createFormRef.value.validate(); } catch { return; }
  saving.value = true;
  try {
    const form = createDialog.form;
    await apiCreateAgent({
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      kind: form.kind,
    });
    ElMessage.success('已创建，默认启用；接着展开这一行签发 Token');
    createDialog.show = false;
    query.page = 1;
    await load();
  } catch { /* 拦截器已弹错 */ } finally {
    saving.value = false;
  }
}

// ---------------------------------------------------------------- 签发 Token

const issueDialog = reactive<{ show: boolean; client: AgentClient | null; scopes: string[]; expiresInDays: number }>({
  show: false, client: null, scopes: [], expiresInDays: 30,
});

function openIssue(row: AgentClient) {
  issueDialog.client = row;
  issueDialog.scopes = [];
  issueDialog.expiresInDays = 30;   // 表单必填、给个合理的默认，别让人误用后端 90 天缺省
  issueDialog.show = true;
}

async function doIssue() {
  const client = issueDialog.client;
  if (!client) return;
  const days = Math.floor(Number(issueDialog.expiresInDays));
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    ElMessage.warning('有效期只支持 1–365 天');
    return;
  }
  saving.value = true;
  try {
    const scopes = issueDialog.scopes.map((s) => s.trim()).filter(Boolean);
    const res: any = await apiCreateAgentToken(client.id, {
      ...(scopes.length ? { scopes } : {}),
      expiresInDays: days,
    });
    issueDialog.show = false;
    issuedDialog.data = res as AgentTokenIssued;
    issuedDialog.show = true;
    copied.value = false;
    // 接口不回 token id，列表只能整表重拉
    loadTokens(client.id, true);
    load();
  } catch { /* 拦截器已弹错 */ } finally {
    saving.value = false;
  }
}

async function doRevoke(clientId: number, tokenId: number) {
  try {
    await apiRevokeAgentToken(clientId, tokenId);
    ElMessage.success(`Token #${tokenId} 已撤销，Agent 侧下次调用即失败`);
    loadTokens(clientId, true);
  } catch { /* 拦截器已弹错 */ }
}

// ---------------------------------------------------------------- 一次性明文

const issuedDialog = reactive<{ show: boolean; data: AgentTokenIssued | null }>({ show: false, data: null });
const copied = ref(false);

/** 剪贴板：优先异步 Clipboard API，非安全上下文（http + 非 localhost）退回临时 textarea */
async function writeToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

async function doCopy() {
  const text = issuedDialog.data?.token || '';
  if (!text) return;
  const ok = await writeToClipboard(text);
  if (ok) {
    copied.value = true;
    ElMessage.success('已复制到剪贴板 —— 请存进密码管理器，别再贴回聊天窗口');
  } else {
    ElMessage.warning('浏览器没给剪贴板权限，请手动选中上面的 token 复制');
  }
}

function closeIssued() {
  const tip = issuedDialog.data?.token && !copied.value
    ? '你还没点复制。关掉之后明文再也查不到，只能撤销重签。确定要关闭？'
    : '';
  if (tip) {
    ElMessageBox.confirm(tip, '确认已经保存好 Token？', { type: 'warning', confirmButtonText: '我确定没复制', cancelButtonText: '返回复制' })
      .then(() => {
        issuedDialog.show = false;
        issuedDialog.data = null;
      })
      .catch(() => { /* 留在弹窗继续复制 */ });
    return;
  }
  issuedDialog.show = false;
  issuedDialog.data = null;
}

onMounted(load);
</script>

<style scoped>
.explain { margin-bottom: 14px; }
.explain-body { font-size: 12px; line-height: 1.7; color: #606266; }
.hint { color: #a8abb2; font-size: 12px; }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }

.tokens { padding: 10px 18px 14px 46px; background: #fafafa; }
.tokens-head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
.tokens-actions { margin-left: auto; display: flex; gap: 8px; }
.scopes { display: flex; gap: 4px; flex-wrap: wrap; max-width: 100%; }

.issue-context { margin-bottom: 12px; font-size: 13px; color: #606266; }

.once-alert { margin-bottom: 14px; }
.once-title { font-size: 16px; font-weight: 700; }
.once-body { font-size: 12px; line-height: 1.7; }
.once-token :deep(textarea) {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 15px; font-weight: 600; letter-spacing: .3px;
}
.once-meta { margin-top: 14px; }
.pager { margin-top: 12px; display: flex; justify-content: flex-end; }
</style>
