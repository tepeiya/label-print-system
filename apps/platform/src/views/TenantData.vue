<template>
  <div>
    <div class="page-header">
      <h2>🗄️ 数据保留与导出</h2>
      <el-button @click="load" :loading="loading">刷新</el-button>
    </div>

    <!-- 口径说明：看板只列已退订租户，不说清楚运营会以为「租户没了」 -->
    <el-alert
      class="scope-alert" type="info" :closable="false" show-icon
      title="这里只列「已退订」的租户（canceled_at 非空）——未退订的租户不会出现在这张表里，全量租户请看「租户管理」"
      :description="`D12 保留期 ${retentionDays} 天：退订满 ${retentionDays} 天（due）才允许硬删；距到期 7 天内进入提醒窗口（warn）。硬删不可逆，后端会在删除前自动落一份 purge-pre 快照。`"
    />

    <el-alert v-if="boardError" type="error" :closable="false" show-icon title="保留期看板加载失败" style="margin-bottom: 12px;">
      <div>{{ boardError }}</div>
      <el-button size="small" style="margin-top: 8px;" @click="load">重试</el-button>
    </el-alert>

    <div class="stat-grid" v-if="!boardError">
      <div class="stat-card">
        <div class="label">保留期内的已退订租户</div>
        <div class="value">{{ stats.total }}</div>
      </div>
      <div class="stat-card">
        <div class="label">7 天内到期（warn）</div>
        <div class="value warn-text">{{ stats.warn }}</div>
      </div>
      <div class="stat-card">
        <div class="label">已过保留期 · 可硬删（due）</div>
        <div class="value danger">{{ stats.due }}</div>
      </div>
      <div class="stat-card">
        <div class="label">涉及数据量</div>
        <div class="value">{{ stats.users }}<span class="unit"> 用户</span></div>
        <div class="muted sub">{{ stats.templates }} 个模板</div>
      </div>
    </div>

    <div class="card">
      <el-table
        :data="items" v-loading="loading" stripe size="small" style="width: 100%"
        :row-class-name="rowClass"
      >
        <el-table-column prop="tenantId" label="ID" width="64" />
        <el-table-column label="租户" min-width="200">
          <template #default="{ row }">
            <div>{{ row.name }}</div>
            <div class="muted sub">{{ row.code }}</div>
          </template>
        </el-table-column>
        <el-table-column label="退订时间" width="150">
          <template #default="{ row }">
            <div class="danger">{{ fmtDate(row.canceledAt) }}</div>
            <div class="muted sub">{{ fmtTime(row.canceledAt) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="可硬删时间" width="150">
          <template #default="{ row }">
            <div>{{ fmtDate(row.hardDeleteAt) }}</div>
            <div class="muted sub">{{ fmtTime(row.hardDeleteAt) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="保留期状态" width="180">
          <template #default="{ row }">
            <el-tag v-if="row.due" size="small" type="danger">已到保留期 · 可硬删</el-tag>
            <el-tag v-else-if="row.warn" size="small" type="warning">{{ daysText(row) }} · 提醒窗口</el-tag>
            <el-tag v-else size="small" type="info" effect="plain">{{ daysText(row) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="用户数" width="80" align="right">
          <template #default="{ row }">{{ row.users }}</template>
        </el-table-column>
        <el-table-column label="模板数" width="80" align="right">
          <template #default="{ row }">{{ row.templates }}</template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <el-button link size="small" type="primary" :loading="exporting[row.tenantId]" @click="doExport(row)">
              导出快照
            </el-button>
            <el-button link size="small" @click="openExports(row)">导出件</el-button>
            <el-button link size="small" @click="downloadLatest(row)">下载</el-button>
            <el-button link size="small" type="danger" @click="openPurge(row)">硬删</el-button>
          </template>
        </el-table-column>
        <!-- 空态：明确告诉运营「这里空 ≠ 没有租户」；加载失败时不能给「没有租户」的误导文案 -->
        <template #empty>
          <el-empty :description="emptyText" />
        </template>
      </el-table>
    </div>

    <!-- ============ 导出摘要 ============ -->
    <el-dialog v-model="ex.show" title="导出快照摘要" width="620px" top="8vh">
      <template v-if="ex.summary">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="租户">{{ ex.summary.tenantCode }}</el-descriptions-item>
          <el-descriptions-item label="导出件 ID">#{{ ex.summary.backupId }}</el-descriptions-item>
          <el-descriptions-item label="名称" :span="2">{{ ex.summary.name }}</el-descriptions-item>
          <el-descriptions-item label="覆盖表数">{{ ex.summary.tableCount }}</el-descriptions-item>
          <el-descriptions-item label="导出行数">{{ ex.summary.rowCount }}</el-descriptions-item>
          <el-descriptions-item label="压缩包大小">{{ sizeText(ex.summary.sizeBytes) }}</el-descriptions-item>
          <el-descriptions-item label="生成时间">{{ fmtDate(ex.summary.createdAt) }} {{ fmtTime(ex.summary.createdAt) }}</el-descriptions-item>
          <el-descriptions-item label="隔离方式" :span="2">
            <el-tag size="small" :type="rls(ex.summary.rlsActive).type">{{ rls(ex.summary.rlsActive).text }}</el-tag>
            <span class="muted sub"> {{ rls(ex.summary.rlsActive).hint }}</span>
          </el-descriptions-item>
        </el-descriptions>

        <el-alert
          v-if="ex.summary.truncated?.length" type="warning" :closable="false" show-icon
          style="margin-top: 12px;"
          :title="`导出件不完整：${ex.summary.truncated.length} 张表超过单表 5 万行上限被截断`"
          :description="`被截断的表：${ex.summary.truncated.join('、')}。这份快照不能当作完整备份恢复，需要分表单独取数。`"
        />
        <el-alert
          v-else type="success" :closable="false" show-icon style="margin-top: 12px;"
          title="没有表被截断（单表上限 5 万行），导出件为该租户当前全量数据"
        />

        <div class="drawer-actions">
          <el-button size="small" @click="openExportsByRow(ex.summary)">查看该租户导出件</el-button>
          <el-button size="small" type="primary" :loading="downloading[ex.summary.backupId]" @click="downloadById(ex.summary.tenantId, ex.summary.backupId, ex.summary.name)">
            下载 .json.gz
          </el-button>
        </div>
      </template>
      <el-empty v-else description="没有拿到导出摘要" />
    </el-dialog>

    <!-- ============ 该租户导出件列表 ============ -->
    <el-drawer v-model="ed.show" :title="`导出件 · ${ed.tenant?.name ?? ''}（${ed.tenant?.code ?? ''}）`" size="700px">
      <div v-loading="ed.loading">
        <el-alert
          v-if="ed.error" type="error" :closable="false" show-icon :title="ed.error" style="margin-bottom: 12px;"
        />
        <div class="muted sub ed-note">
          含平台侧导出（export）、硬删前自动快照（purge-pre），以及租户自己的手工/定时备份；后端最多回最近 100 条。
        </div>
        <el-table :data="ed.items" size="small" stripe>
          <el-table-column prop="id" label="ID" width="60" />
          <el-table-column label="名称" min-width="200">
            <template #default="{ row }">
              <div class="mono">{{ row.name }}</div>
              <div class="muted sub">{{ fmtDate(row.createdAt) }} {{ fmtTime(row.createdAt) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="种类" width="120">
            <template #default="{ row }">
              <el-tag size="small" effect="plain" :type="kindTag(row.kind)">{{ kindLabel(row.kind) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="大小" width="90" align="right">
            <template #default="{ row }">{{ sizeText(row.sizeBytes) }}</template>
          </el-table-column>
          <el-table-column label="创建人" width="80">
            <template #default="{ row }">{{ creatorText(row.createdBy) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="80" fixed="right">
            <template #default="{ row }">
              <el-button link size="small" type="primary" :loading="downloading[row.id]" @click="downloadById(ed.tenant?.tenantId ?? 0, row.id, row.name)">
                下载
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!ed.loading && !ed.error && !ed.items.length" description="该租户还没有任何导出件，先「导出快照」" />
        <div class="drawer-actions">
          <el-button size="small" @click="loadExports()">刷新列表</el-button>
        </div>
      </div>
    </el-drawer>

    <!-- ============ 硬删二次确认（最危险操作） ============ -->
    <el-dialog v-model="pg.show" title="⛔ 硬删租户全部业务数据" width="660px" top="6vh" :close-on-click-modal="false">
      <el-alert
        type="error" :closable="false" show-icon style="margin-bottom: 12px;"
        title="不可逆：执行后该租户所有业务数据会被物理删除，租户账号本身保留（D12）"
        description="后端会先自动落一份 purge-pre 快照再删；快照是唯一回滚凭据，删完请到「导出件」里下载保管。"
      />

      <el-descriptions v-if="pg.tenant" :column="2" border size="small">
        <el-descriptions-item label="租户">{{ pg.tenant.name }}</el-descriptions-item>
        <el-descriptions-item label="租户 code">
          <span class="mono danger">{{ pg.tenant.code }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="退订时间">
          {{ pg.tenant.canceledAt ? fmtDate(pg.tenant.canceledAt) : '尚未退订' }}
        </el-descriptions-item>
        <el-descriptions-item label="可硬删时间">{{ fmtDate(pg.tenant.hardDeleteAt) }}</el-descriptions-item>
        <el-descriptions-item label="保留期状态">
          <el-tag size="small" :type="pg.tenant.due ? 'danger' : (pg.tenant.warn ? 'warning' : 'info')">
            {{ purgeStatusText }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="数据量">
          {{ pg.tenant.users }} 用户 / {{ pg.tenant.templates }} 模板
        </el-descriptions-item>
      </el-descriptions>

      <h4 class="block-title">三道闸门（后端强制，这里只做预校验）</h4>
      <div v-for="g in gates" :key="g.title" class="gate">
        <el-tag size="small" :type="g.state === 'pass' ? 'success' : (g.state === 'force' ? 'warning' : 'info')" effect="plain">
          {{ g.state === 'pass' ? '已满足' : (g.state === 'force' ? '需 force' : '未完成') }}
        </el-tag>
        <div class="gate-body">
          <div class="gate-title">{{ g.title }}</div>
          <div class="muted sub">{{ g.desc }}</div>
        </div>
      </div>

      <el-form label-width="110px" style="margin-top: 12px;" @submit.prevent>
        <el-form-item label="逐字输入 code">
          <el-input
            v-model="pg.confirm" :placeholder="`请手动输入「${pg.tenant?.code ?? ''}」`"
            class="mono" @keyup.enter="doPurge"
          />
          <div class="muted sub" :class="{ danger: pg.confirm && !confirmOk }">{{ confirmHint }}</div>
        </el-form-item>
        <el-form-item v-if="needForce">
          <el-checkbox v-model="pg.force" class="force-box">
            我知道该租户还在保留期 / 尚未退订，仍然强制删除（force）
          </el-checkbox>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="pg.show = false">取消</el-button>
        <el-button
          type="danger" :disabled="!canSubmit" :loading="pg.busy" @click="doPurge"
          :title="canSubmit ? '' : '先逐字输入租户 code' + (needForce ? '，并勾选 force' : '')"
        >确认硬删（不可逆）</el-button>
      </template>
    </el-dialog>

    <!-- ============ 硬删结果 ============ -->
    <el-dialog v-model="rs.show" title="硬删结果" width="680px" top="6vh">
      <template v-if="rs.result">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="租户">{{ rs.result.tenantCode }}</el-descriptions-item>
          <el-descriptions-item label="删除行数">{{ rs.result.deletedRows }}</el-descriptions-item>
          <el-descriptions-item label="处理表数">{{ rs.result.tables }}</el-descriptions-item>
          <el-descriptions-item label="删到有行的表">{{ touchedCount }}</el-descriptions-item>
          <el-descriptions-item label="隔离方式" :span="2">
            <el-tag size="small" :type="rls(rs.result.rlsActive).type">{{ rls(rs.result.rlsActive).text }}</el-tag>
            <span class="muted sub"> {{ rls(rs.result.rlsActive).hint }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="删除前快照" :span="2">
            <span class="mono">{{ rs.result.snapshot?.name ?? '—' }}</span>
            <span class="muted sub">
              #{{ rs.result.snapshot?.backupId ?? '—' }} ·
              {{ sizeText(rs.result.snapshot?.sizeBytes) }} ·
              {{ rs.result.snapshot?.tableCount ?? 0 }} 张表
            </span>
          </el-descriptions-item>
        </el-descriptions>

        <el-alert
          v-if="rs.result.rlsActive === false" type="warning" :closable="false" show-icon style="margin-top: 12px;"
          title="本次跑在降级路径：未使用 RLS 角色"
          description="跨表范围只由 SQL 里的 tenant_id 条件保证（主库连接）。请人工复查下方明细，确认没有误删其他租户数据。"
        />
        <el-alert
          v-if="orphan" type="warning" :closable="false" show-icon style="margin-top: 12px;"
          :title="orphanTitle" :description="orphanDesc"
        />
        <el-alert
          v-else type="success" :closable="false" show-icon style="margin-top: 12px;"
          title="逐表复查剩余均为 0，无外键成环"
        />

        <h4 class="block-title">逐表明细（共 {{ rs.result.detail?.length ?? 0 }} 张，仅列出删到行的 {{ touchedCount }} 张）</h4>
        <el-table :data="touchedDetail" size="small" stripe max-height="260" empty-text="本次没有删除任何行">
          <el-table-column prop="table" label="表" min-width="200" class-name="mono" />
          <el-table-column prop="rows" label="删除行数" width="120" align="right" />
        </el-table>
        <div class="muted sub">
          另有 {{ (rs.result.detail?.length ?? 0) - touchedCount }} 张表本次 rows=0（该租户在这些表里没有数据），后端仍逐表回报了复查结果。
        </div>

        <div class="drawer-actions">
          <el-button size="small" @click="downloadSnapshot">下载删除前快照</el-button>
          <el-button size="small" type="primary" @click="rs.show = false">关闭</el-button>
        </div>
      </template>
      <el-empty v-else description="没有结果数据" />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import {
  apiExportTenantData,
  apiPurgeTenant,
  apiTenantExportDownload,
  apiTenantExports,
  apiTenantRetention,
} from '@/api';
import type {
  TenantExportItem,
  TenantExportSummary,
  TenantPurgeDetailRow,
  TenantPurgeResult,
  TenantRetentionBoard,
  TenantRetentionItem,
} from '@/api/types';

// ---------------------------------------------------------------- 展示辅助

const fmtDate = (t: string | null | undefined) => (t ? new Date(t).toLocaleDateString('zh-CN') : '—');
const fmtTime = (t: string | null | undefined) =>
  (t ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) : '');

/** 后端 sizeBytes 在导出件列表里是 BIGINT 字符串（"985"），统一 Number 后按 B/KB/MB 显示 */
function sizeText(n: number | string | null | undefined) {
  const b = Number(n ?? 0);
  if (!Number.isFinite(b) || b < 0) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

const KIND_LABEL: Record<string, string> = {
  export: '平台导出', 'purge-pre': '硬删前快照', manual: '租户手工备份', scheduled: '定时备份',
};
const KIND_TAG: Record<string, 'success' | 'warning' | 'info' | 'danger'> = {
  export: 'success', 'purge-pre': 'warning', manual: 'info', scheduled: 'info',
};
const kindLabel = (k: string) => KIND_LABEL[k] ?? k;
const kindTag = (k: string) => KIND_TAG[k] ?? 'info';

/** 剩余天数文案：负数=已过期（后端会直接给 due=true 的行），null=后端没算出来（未退订/脏时间） */
function daysText(row: TenantRetentionItem) {
  if (row.daysLeft === null || row.daysLeft === undefined) return '保留期状态未知';
  return row.daysLeft <= 0 ? `已过期 ${-row.daysLeft} 天` : `剩 ${row.daysLeft} 天`;
}

/** tenant_backups.created_by 是 BIGINT 字符串（"1"），为空表示系统/租户侧动作，不硬编成某个运营 */
const creatorText = (v: number | string | null | undefined) =>
  (v === null || v === undefined || v === '' ? '—' : `#${v}`);

/**
 * rlsActive 由后端如实回报，绝不允许写死成绿色：
 * true=走了带 RLS 角色的连接；false=降级到主库连接（只有应用层 tenant_id 隔离）；其他=后端没回这个字段。
 */
function rls(v: boolean | undefined | null): { type: 'success' | 'warning' | 'info'; text: string; hint: string } {
  if (v === true) return { type: 'success', text: 'RLS 已生效', hint: '操作跑在带 app.tenant_id 的 RLS 角色连接上' };
  if (v === false) return { type: 'warning', text: '降级：未走 RLS 角色', hint: '跑在主库连接上，跨表范围只靠 SQL 里的 tenant_id 条件，请人工复核' };
  return { type: 'info', text: '后端未回报 rlsActive', hint: '无法确认隔离方式，按未走 RLS 对待' };
}

// ---------------------------------------------------------------- 看板

const loading = ref(false);
const board = ref<TenantRetentionBoard | null>(null);
const boardError = ref('');

const items = computed<TenantRetentionItem[]>(() => board.value?.items ?? []);
const retentionDays = computed(() => board.value?.retentionDays ?? 90);
const stats = computed(() => ({
  total: items.value.length,
  warn: items.value.filter((i) => i.warn).length,
  due: items.value.filter((i) => i.due).length,
  users: items.value.reduce((s, i) => s + Number(i.users ?? 0), 0),
  templates: items.value.reduce((s, i) => s + Number(i.templates ?? 0), 0),
}));

/** due 行整行标红、warn 行标黄：让「可以删了」在列表里一眼可见 */
function rowClass({ row }: { row: TenantRetentionItem }) {
  if (row.due) return 'row-due';
  if (row.warn) return 'row-warn';
  return '';
}

async function load() {
  loading.value = true;
  boardError.value = '';
  try {
    board.value = await apiTenantRetention();
  } catch (err: any) {
    // 拦截器已弹 toast，这里额外留页面级错误态（失败时不能是白屏）
    boardError.value = err?.message || '保留期看板接口调用失败';
    board.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/** 表格空态文案：接口失败时不能显示成「没有已退订租户」，否则等于骗运营 */
const emptyText = computed(() => (boardError.value
  ? '保留期看板没取到数据（上方有错误原因），点「刷新」重试'
  : '没有处于保留期的已退订租户（未退订的租户不会出现在这里，请到「租户管理」查看全量租户）'));

// ---------------------------------------------------------------- 导出快照

const exporting = reactive<Record<number, boolean>>({});
const ex = reactive({ show: false, summary: null as TenantExportSummary | null });

async function doExport(row: TenantRetentionItem) {
  exporting[row.tenantId] = true;
  try {
    const res = await apiExportTenantData(row.tenantId);
    ex.summary = res;
    ex.show = true;
    ElMessage.success(
      res.truncated?.length
        ? `导出完成（${res.tableCount} 张表 / ${res.rowCount} 行，${res.truncated.length} 张被截断）`
        : `导出完成（${res.tableCount} 张表 / ${res.rowCount} 行）`,
    );
  } catch {
    /* 拦截器已提示 */
  } finally {
    exporting[row.tenantId] = false;
  }
}

// ---------------------------------------------------------------- 导出件列表 + 下载

const ed = reactive({
  show: false,
  loading: false,
  /** 抽屉只需要「是谁」，看板行 / 导出摘要都能拿到这三个字段 */
  tenant: null as { tenantId: number; code: string; name: string } | null,
  items: [] as TenantExportItem[],
  error: '',
});
const downloading = reactive<Record<number, boolean>>({});

function openExports(row: TenantRetentionItem) {
  ed.tenant = { tenantId: row.tenantId, code: row.code, name: row.name };
  ed.show = true;
  loadExports();
}

/** 导出摘要弹窗里的入口：按 tenantId 打开同一个抽屉（摘要里的 code/name 来自后端返回） */
function openExportsByRow(summary: TenantExportSummary) {
  ed.tenant = { tenantId: summary.tenantId, code: summary.tenantCode, name: `${summary.tenantCode}（平台导出）` };
  ex.show = false;
  ed.show = true;
  loadExports();
}

async function loadExports() {
  const tenantId = ed.tenant?.tenantId;
  if (!tenantId) return;
  ed.loading = true;
  ed.error = '';
  ed.items = [];
  try {
    ed.items = (await apiTenantExports(tenantId)).items ?? [];
  } catch (err: any) {
    ed.error = err?.message || '导出件列表加载失败';
  } finally {
    ed.loading = false;
  }
}

/** 浏览器另存：ObjectURL + a[download]，用完撤销 */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立即 revoke 会让部分浏览器来不及读流
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function downloadById(tenantId: number, exportId: number, name: string) {
  if (!tenantId || !exportId) {
    ElMessage.error('缺少租户 ID 或导出件 ID，无法下载');
    return;
  }
  downloading[exportId] = true;
  try {
    const blob = await apiTenantExportDownload(tenantId, exportId);
    // 后端 name 已是 <code>-<kind>-<日期>，文件名补 .json.gz（与 Content-Disposition 一致）
    saveBlob(blob, `${name || `export-${exportId}`}.json.gz`);
    ElMessage.success(`已开始下载 ${sizeText(blob.size)} 的导出件`);
  } catch {
    /* 拦截器（或 api 层的 blob 检测）已提示，绝不会存下 JSON 内容的 .gz */
  } finally {
    downloading[exportId] = false;
  }
}

/** 行内「下载」= 该租户最新一份导出件（列表按 id 倒序，第一条即最新） */
async function downloadLatest(row: TenantRetentionItem) {
  try {
    const list = await apiTenantExports(row.tenantId);
    const latest = (list.items ?? [])[0];
    if (!latest) {
      ElMessage.warning(`「${row.code}」还没有导出件，请先点「导出快照」`);
      return;
    }
    await downloadById(row.tenantId, latest.id, latest.name);
  } catch {
    /* 拦截器已提示 */
  }
}

// ---------------------------------------------------------------- 硬删

const pg = reactive({
  show: false,
  busy: false,
  tenant: null as TenantRetentionItem | null,
  confirm: '',
  force: false,
});

/** 闸门①：前端就逐字校验（后端 trim 后比对，这里同口径），不等它报 400 */
const confirmOk = computed(() => !!pg.tenant && pg.confirm.trim() === pg.tenant.code);
/** 闸门②③：未到保留期、或尚未退订 → 必须显式勾 force，否则不发请求 */
const needForce = computed(() => !!pg.tenant && (!pg.tenant.due || !pg.tenant.canceledAt));
const canSubmit = computed(() => confirmOk.value && (!needForce.value || pg.force));

/** 确认串实时反馈（多行三元放模板会把 SFC 解析器绕晕，这里收进 computed） */
const confirmHint = computed(() => {
  const code = pg.tenant?.code ?? '';
  if (!pg.confirm) return `后端 trim 后与租户 code 逐字比对，不一致直接 400 —— 需要逐字输入「${code}」。`;
  return confirmOk.value ? '✓ 确认串与租户 code 一致' : `✗ 还不一致：必须逐字等于「${code}」`;
});

/** 弹窗里的保留期徽标文案（due / 还剩几天 / 未回报天数） */
const purgeStatusText = computed(() => {
  const t = pg.tenant;
  if (!t) return '';
  if (t.due) return '已过保留期（due）';
  return t.daysLeft === null || t.daysLeft === undefined ? '保留期状态未知' : `还剩 ${t.daysLeft} 天`;
});

const gates = computed(() => {
  const t = pg.tenant;
  if (!t) return [] as { title: string; desc: string; state: 'pass' | 'pending' | 'force' }[];
  return [
    {
      title: `① 确认串逐字等于 code「${t.code}」`,
      desc: confirmOk.value ? '已逐字匹配，后端不会再因确认串拒绝' : '不一致时后端直接 400（确认串不匹配）',
      state: confirmOk.value ? 'pass' as const : 'pending' as const,
    },
    {
      title: `② 保留期（D12=${retentionDays.value} 天）`,
      desc: t.due
        ? `已过保留期（${fmtDate(t.hardDeleteAt)}），无需 force`
        : `还在保留期内：剩 ${t.daysLeft ?? '—'} 天，到期时间 ${fmtDate(t.hardDeleteAt)}；不勾 force 后端会 400`,
      state: t.due ? 'pass' as const : (pg.force ? 'force' as const : 'pending' as const),
    },
    {
      title: '③ 退订状态',
      desc: t.canceledAt
        ? `已于 ${fmtDate(t.canceledAt)} 退订，无需 force`
        : '尚未退订（canceled_at 为空）：必须 force=true，否则后端 400',
      state: t.canceledAt ? 'pass' as const : (pg.force ? 'force' as const : 'pending' as const),
    },
  ];
});

function openPurge(row: TenantRetentionItem) {
  pg.tenant = row;
  pg.confirm = '';
  pg.force = false;
  pg.busy = false;
  pg.show = true;
}

const rs = reactive({ show: false, result: null as TenantPurgeResult | null });

async function doPurge() {
  const t = pg.tenant;
  if (!t) return;
  if (!canSubmit.value) {
    ElMessage.warning(confirmOk.value ? '请先勾选 force 再执行硬删' : `请逐字输入租户 code「${t.code}」`);
    return;
  }
  pg.busy = true;
  try {
    // needForce=false 时不传 force，让后端按最小权限判定
    rs.result = await apiPurgeTenant(t.tenantId, { confirm: pg.confirm.trim(), force: needForce.value ? true : undefined });
    rs.show = true;
    pg.show = false;
    ElMessage.success(`已硬删 ${t.code}：${rs.result.deletedRows} 行 / ${rs.result.tables} 张表`);
    await load();
  } catch {
    /* 闸门拦截（400）由拦截器原样弹出后端 reason */
  } finally {
    pg.busy = false;
  }
}

const touchedDetail = computed<TenantPurgeDetailRow[]>(
  () => (rs.result?.detail ?? []).filter((d) => Number(d.rows ?? 0) > 0),
);
const touchedCount = computed(() => touchedDetail.value.length);

/** remaining / cyclic 非空 → 外键可能留了孤儿行，必须警示 + 提示人工核查（文案放 script，模板里不拼长句） */
const orphan = computed(() => !!(rs.result?.remaining?.length || rs.result?.cyclic?.length));
const orphanTitle = computed(
  () => `外键可能留了孤儿行，需要人工核查（remaining ${rs.result?.remaining?.length ?? 0} 张 / cyclic ${rs.result?.cyclic?.length ?? 0} 张）`,
);
const orphanDesc = computed(() => {
  const rest = rs.result?.remaining?.join('、') || '无';
  const ring = rs.result?.cyclic?.join('、') || '无';
  return `复查后仍有行的表：${rest}；外键成环、只能按原顺序删除的表：${ring}。`;
});

/** 结果面板里直接取回滚凭据（purge-pre 快照） */
function downloadSnapshot() {
  const r = rs.result;
  if (!r?.snapshot?.backupId) {
    ElMessage.warning('后端没有回报快照 ID，请到该租户的「导出件」里找 purge-pre 记录');
    return;
  }
  downloadById(r.tenantId, r.snapshot.backupId, r.snapshot.name);
}
</script>

<style scoped>
.scope-alert { margin-bottom: 12px; }
.sub { font-size: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.danger { color: #f56c6c; }
.warn-text { color: #e6a23c; }
.unit { font-size: 13px; font-weight: 400; color: #909399; }
.block-title { margin: 16px 0 8px; font-size: 14px; }
.gate { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; }
.gate-title { font-size: 13px; }
.ed-note { margin-bottom: 8px; }
.force-box :deep(.el-checkbox__label) { color: #f56c6c; font-weight: 600; }
.drawer-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
:deep(.row-due) > td.el-table__cell { background: #fef0f0 !important; }
:deep(.row-warn) > td.el-table__cell { background: #fdf6ec !important; }
</style>
