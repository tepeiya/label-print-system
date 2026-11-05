<template>
  <div>
    <div class="page-header">
      <h2>🤖 Agent 待确认</h2>
      <el-button @click="load" :loading="loading">
        <el-icon><Refresh /></el-icon> 刷新
      </el-button>
    </div>

    <!-- 这一页的定位说明：很多人会把它当成 OA 审批工单，实际不是 -->
    <el-alert type="info" :closable="false" show-icon class="explain">
      <template #title>
        这是给 <b>Agent 高危写操作</b>（库存调整 / 调拨 / 出库打印等）用的人工确认闸，<b>不是审批工单</b>。
      </template>
      <div class="explain-body">
        Agent 调用高危工具时后端<b>不执行任何副作用</b>，只挂一张待确认单在这里等人点。
        「确认」后 5 分钟内、且 Agent 用<b>完全相同的参数</b>带上 approval_id 重试，操作才会真正执行
        （参数被改 → args_hash 对不上 → 拒绝；成功执行一次即作废）。
        「驳回」则操作永不执行，Agent 重试会直接读到「审批被驳回」。
      </div>
    </el-alert>

    <div class="card toolbar">
      <el-form inline @submit.prevent>
        <el-form-item label="状态">
          <el-select v-model="query.status" style="width: 150px;" @change="reload">
            <el-option v-for="s in STATUS_OPTIONS" :key="s.value" :label="s.label" :value="s.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="每页">
          <el-select v-model="query.pageSize" style="width: 100px;" @change="reload">
            <el-option v-for="n in [10, 20, 50, 100]" :key="n" :label="n" :value="n" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="reload">查询</el-button>
        </el-form-item>
      </el-form>
      <div class="toolbar-meta">
        共 <b>{{ total }}</b> 条
        <span v-if="query.status === 'pending'" class="pending-hint">
          （待确认单默认 30 分钟未被处理即过期）
        </span>
      </div>
    </div>

    <div class="card">
      <el-table :data="rows" v-loading="loading" stripe size="small" style="width: 100%">
        <el-table-column prop="id" label="ID" width="70" />

        <el-table-column label="Agent" min-width="150">
          <template #default="{ row }">
            <!-- 租户列表接口里 agentClientName 恒为 null（后端 toDto 没传 clientName），
                 所以拿 sys:agent:manage 时补一次客户端表；补不到就退回 ID，不硬凑 -->
            <span>{{ agentLabel(row) }}</span>
            <div v-if="row.agentClientName" class="sub">#{{ row.agentClientId }}</div>
          </template>
        </el-table-column>

        <el-table-column label="工具" min-width="170">
          <template #default="{ row }"><code class="tool">{{ row.tool }}</code></template>
        </el-table-column>

        <el-table-column label="参数摘要" min-width="340">
          <template #default="{ row }">
            <div class="args-head">
              <el-button link size="small" @click="toggle(row.id)">
                {{ expanded[row.id] ? '收起' : '展开' }}
              </el-button>
              <span v-if="!expanded[row.id]" class="args-brief">{{ brief(row) }}</span>
              <el-tooltip v-if="!expanded[row.id]" :content="row.argsHash" placement="top">
                <span class="hash">指纹 {{ shortHash(row.argsHash) }}</span>
              </el-tooltip>
            </div>
            <div v-if="expanded[row.id]" class="args-box">
              <ArgsPreview :v="row.argsPreview" :depth="0" />
              <el-tooltip :content="row.argsHash" placement="top">
                <div class="hash">参数指纹（改一个字节就对不上）{{ shortHash(row.argsHash) }}</div>
              </el-tooltip>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="发起人" min-width="130">
          <template #default="{ row }">
            <el-tooltip
              content="审批单响应里没有 onBehalfOf 字段，按 Agent 客户端归属显示"
              placement="top"
            >
              <span>{{ agentLabel(row) }}</span>
            </el-tooltip>
          </template>
        </el-table-column>

        <el-table-column label="创建时间" width="160">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>

        <el-table-column label="有效期" width="200">
          <template #default="{ row }">
            <span :class="expiry(row).cls">{{ expiry(row).text }}</span>
            <div v-if="expiry(row).sub" class="sub">{{ expiry(row).sub }}</div>
          </template>
        </el-table-column>

        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tooltip v-if="row.message" :content="row.message" placement="top">
              <el-tag :type="statusTag(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
            </el-tooltip>
            <el-tag v-else :type="statusTag(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <!-- 后端是 manage OR approve，这里同样按 OR 判定：只有审批权限的人也要能点。
                 不要再叠加 manage —— 主管/仓管本来就没有 sys:agent:manage。 -->
            <template v-if="row.status === 'pending'">
              <el-button
                link size="small" type="primary"
                v-permission="['sys:agent:manage', 'sys:agent:approve']"
                :loading="busy === `a${row.id}`"
                @click="doApprove(row)"
              >确认</el-button>
              <el-button
                link size="small" type="danger"
                v-permission="['sys:agent:manage', 'sys:agent:approve']"
                :loading="busy === `r${row.id}`"
                @click="openReject(row)"
              >驳回</el-button>
            </template>
            <span v-else class="done">
              {{ row.approvedAt ? `已由 #${row.approvedBy ?? '?'} 处理` : '—' }}
            </span>
          </template>
        </el-table-column>
      </el-table>

      <el-empty v-if="!loading && !rows.length" :description="emptyText" />

      <el-pagination
        v-if="total > 0"
        class="pager"
        layout="total, prev, pager, next, jumper"
        :total="total"
        :page-size="query.pageSize"
        :current-page="query.page"
        @current-change="(p: number) => { query.page = p; load(); }"
      />
    </div>

    <!-- 驳回：reason 是可选的，但会进审计日志，给个框让人写两句 -->
    <el-dialog v-model="rejectDialog.show" title="驳回该待确认操作" width="460px">
      <div class="reject-context">
        工具：<code>{{ rejectDialog.row?.tool }}</code>
        <br />Agent：{{ rejectDialog.row ? agentLabel(rejectDialog.row) : '' }}
      </div>
      <el-input
        v-model="rejectDialog.reason"
        type="textarea"
        :rows="3"
        maxlength="200"
        show-word-limit
        placeholder="驳回原因（可选，会写进审计日志；Agent 侧只会收到「审批被驳回，操作未执行」）"
      />
      <template #footer>
        <el-button @click="rejectDialog.show = false">取消</el-button>
        <el-button type="danger" :loading="saving" @click="doReject">确认驳回</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
// ============================================================================
// AgentApprovals —— 高危操作待确认（docs/11 §11.7.6，P5）
//
// 权限：后端列表/确认/驳回都是 sys:agent:manage OR sys:agent:approve，
//       所以这页对「只有 approve 的主管/仓管」也必须可用 —— 全页不做 manage 硬判定，
//       只有补 Agent 名称那一次 GET /agents 才需要 manage（没权限就不发，免得白弹 403）。
// 倒计时：pending 的 expiresAt 是 30 分钟、approved 是 5 分钟窗口，
//         后端只在「读列表」时才把过期单回写成 expired，所以这里本地每秒判一次并提示。
// ============================================================================
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ArgsPreview from '@/components/ArgsPreview.vue';
import {
  apiApproveApproval, apiListAgents, apiListApprovals, apiRejectApproval,
  type AgentApproval,
} from '@/api';
import { useAuthStore } from '@/store/auth';

const auth = useAuthStore();

const STATUS_OPTIONS = [
  { value: 'pending', label: '待确认' },
  { value: 'approved', label: '已确认' },
  { value: 'rejected', label: '已驳回' },
  { value: 'expired', label: '已过期' },
  { value: 'consumed', label: '已执行' },
  { value: 'all', label: '全部' },
];

const loading = ref(false);
const saving = ref(false);
const busy = ref('');
const rows = ref<AgentApproval[]>([]);
const total = ref(0);
const query = reactive({ status: 'pending', page: 1, pageSize: 20 });
const expanded = reactive<Record<number, boolean>>({});
const agentNames = reactive<Record<number, string>>({});

const now = ref(Date.now());
let timer: number | undefined;

const emptyText = ref('没有符合条件的待确认单');

const formatTime = (t: any) => (t ? new Date(t).toLocaleString() : '—');
const shortHash = (h: string) => (h ? h.slice(0, 12) : '—');
const esc = (s: any) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function statusLabel(s: string) {
  return STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s;
}
function statusTag(s: string): 'primary' | 'success' | 'danger' | 'info' | 'warning' {
  if (s === 'pending') return 'primary';
  if (s === 'approved') return 'warning';
  if (s === 'consumed') return 'success';
  if (s === 'rejected') return 'danger';
  return 'info';
}

/** Agent 展示名：优先后端给的，其次本地补的客户端表，最后退回 ID */
function agentLabel(row: AgentApproval) {
  if (row.agentClientName) return row.agentClientName;
  return agentNames[row.agentClientId] ?? `Agent #${row.agentClientId}`;
}

/** 折叠态的一行摘要：只给键名，不铺开 */
function brief(row: AgentApproval) {
  const keys = Object.keys(row.argsPreview ?? {});
  return keys.length ? `${keys.length} 个参数：${keys.join('、')}` : '（无参数）';
}

const fmtRemain = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
};

/** 有效期列：pending / approved 走本地倒计时，其它状态只给绝对时间 */
function expiry(row: AgentApproval) {
  const exp = row.expiresAt ? new Date(row.expiresAt).getTime() : 0;
  const live = row.status === 'pending' || row.status === 'approved';
  if (!exp) return { text: '—', sub: '', cls: 'muted' };

  if (!live) {
    return { text: formatTime(row.expiresAt), sub: '不再有效', cls: 'muted' };
  }
  const remain = exp - now.value;
  if (remain <= 0) {
    return {
      text: '已过期，Agent 重试会被拒',
      sub: `到期时刻 ${formatTime(row.expiresAt)}（下次刷新自动置为 expired）`,
      cls: 'expired',
    };
  }
  return {
    text: `剩 ${fmtRemain(remain)}`,
    sub: `${row.status === 'pending' ? '待确认 30 分钟' : '批准后可用 5 分钟'} · 到期 ${formatTime(row.expiresAt)}`,
    cls: row.status === 'pending' ? 'living' : 'living warn',
  };
}

function toggle(id: number) { expanded[id] = !expanded[id]; }

async function load() {
  loading.value = true;
  try {
    const res: any = await apiListApprovals({
      status: query.status, page: query.page, pageSize: query.pageSize,
    });
    rows.value = res?.items ?? [];
    total.value = Number(res?.total ?? rows.value.length);
    emptyText.value = query.status === 'pending'
      ? '没有待确认的 Agent 操作（Agent 没发起高危调用，或都已处理完）'
      : '没有符合条件的记录';
  } catch {
    /* 拦截器已弹错 */
  } finally {
    loading.value = false;
  }
}

function reload() { query.page = 1; load(); }

/**
 * 补 Agent 名称：审批接口的 agentClientName 后端不填，只能自己按 ID 找。
 * 只有 sys:agent:manage 的人发这个请求（approve-only 的人调 /agents 必 4032，
 * 拦截器会无条件弹红条，所以宁可不发）。
 */
async function loadAgentNames() {
  if (!auth.hasPermission('sys:agent:manage')) return;
  try {
    const res: any = await apiListAgents({ page: 1, pageSize: 100 });
    for (const c of res?.items ?? []) agentNames[Number(c.id)] = c.name;
  } catch { /* 名称拿不到就用 Agent #id */ }
}

async function doApprove(row: AgentApproval) {
  const e = expiry(row);
  // ElMessageBox 用了 dangerouslyUseHTMLString，Agent 名称/工具名都是租户可写的字符串，
  // 拼进 HTML 前必须转义，否则客户端名字里塞个 <img onerror> 就是存储型 XSS。
  try {
    await ElMessageBox.confirm(
      `<div style="line-height:1.8">
         <p>即将放行 Agent <b>${esc(agentLabel(row))}</b> 执行 <code>${esc(row.tool)}</code>。</p>
         <p>确认后：<b>5 分钟内</b>，Agent 用<b>完全相同的参数</b>带上 approval_id（#${row.id}）重试，操作才会真正执行。</p>
         <p>参数哪怕改动一个字节 → args_hash 对不上 → 直接被拒；执行成功一次即作废，不能复用。</p>
         <p style="color:#e6a23c">当前有效期：${esc(e.text)}${e.sub ? `（${esc(e.sub)}）` : ''}</p>
       </div>`,
      '确认这就是你批准的那笔操作？',
      { dangerouslyUseHTMLString: true, type: 'warning', confirmButtonText: '确认放行', cancelButtonText: '先不' },
    );
  } catch { return; }

  busy.value = `a${row.id}`;
  try {
    const updated: any = await apiApproveApproval(row.id);
    if (updated && typeof updated === 'object') Object.assign(row, updated);
    ElMessage.success(`已确认 #${row.id}：5 分钟内相同参数重试才会执行，改参数会被拒`);
  } catch { /* 拦截器已弹错 */ } finally {
    busy.value = '';
  }
}

const rejectDialog = reactive<{ show: boolean; row: AgentApproval | null; reason: string }>({
  show: false, row: null, reason: '',
});

function openReject(row: AgentApproval) {
  rejectDialog.row = row;
  rejectDialog.reason = '';
  rejectDialog.show = true;
}

async function doReject() {
  const row = rejectDialog.row;
  if (!row) return;
  saving.value = true;
  busy.value = `r${row.id}`;
  try {
    const updated: any = await apiRejectApproval(row.id, rejectDialog.reason.trim() || undefined);
    if (updated && typeof updated === 'object') Object.assign(row, updated);
    rejectDialog.show = false;
    ElMessage.success(`已驳回 #${row.id}，操作不会执行，Agent 重试会收到「审批被驳回」`);
  } catch { /* 拦截器已弹错 */ } finally {
    saving.value = false;
    busy.value = '';
  }
}

onMounted(() => {
  timer = window.setInterval(() => { now.value = Date.now(); }, 1000);
  load();
  loadAgentNames();
});

onBeforeUnmount(() => { if (timer) window.clearInterval(timer); });
</script>

<style scoped>
.explain { margin-bottom: 14px; }
.explain-body { font-size: 12px; line-height: 1.7; color: #606266; }
.toolbar { display: flex; align-items: center; gap: 16px; margin-bottom: 14px; flex-wrap: wrap; }
.toolbar :deep(.el-form-item) { margin-bottom: 0; }
.toolbar-meta { margin-left: auto; color: #909399; font-size: 13px; }
.pending-hint { color: #a8abb2; }

.tool { font-size: 12px; color: #303133; background: #f4f4f5; padding: 1px 5px; border-radius: 3px; }
.args-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
.args-brief { color: #606266; font-size: 12px; word-break: break-all; }
.args-box {
  margin-top: 6px; padding: 8px 10px; background: #fafafa;
  border: 1px solid #ebeef5; border-radius: 4px;
  max-height: 320px; overflow: auto; max-width: 100%;
}
.hash { color: #a8abb2; font-size: 11px; cursor: default; }
.sub { color: #a8abb2; font-size: 11px; line-height: 1.5; }
.muted { color: #a8abb2; }
.living { color: #1a73e8; font-weight: 600; }
.warn { color: #e6a23c; }
.expired { color: #f56c6c; font-weight: 600; }
.done { color: #909399; font-size: 12px; }
.pager { margin-top: 12px; display: flex; justify-content: flex-end; }
.reject-context { margin-bottom: 10px; font-size: 13px; color: #606266; line-height: 1.8; }
</style>
