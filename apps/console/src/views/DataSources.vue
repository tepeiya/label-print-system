<template>
  <div>
    <div class="page-header">
      <h2>📊 数据源管理</h2>
      <div style="display: flex; gap: 8px;">
        <el-button type="primary" v-permission="'datasource:write'" @click="openImport">
          <el-icon><Upload /></el-icon> 导入表格
        </el-button>
        <el-button v-permission="'datasource:write'" @click="sqlDlg.visible = true">
          <el-icon><Plus /></el-icon> 新建 SQL 数据源
        </el-button>
        <el-button @click="load" :loading="loading">刷新</el-button>
      </div>
    </div>

    <el-alert type="info" :closable="false" style="margin-bottom: 16px;">
      这里是全系统<strong>唯一的数据源与表格导入入口</strong>：Excel / CSV / TSV / JSON 文件在此上传、映射字段并保存。
      标签设计器「打印预览」与「打印」页只引用这里已保存的数据源，不再各自导入文件。
      SQL 数据源仅允许 SELECT / WITH 只读查询。
    </el-alert>

    <div class="card">
      <el-table :data="rows" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="名称" min-width="180" />
        <el-table-column label="类型" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="row.type === 'sql' ? 'warning' : 'success'" effect="plain">
              {{ sourceTypeLabel(row) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="说明 / 查询" min-width="260">
          <template #default="{ row }">
            <span v-if="row.config?.description">{{ row.config.description }}</span>
            <code v-else-if="row.config?.queryTemplate" style="font-size: 12px;">
              {{ truncate(row.config.queryTemplate, 80) }}
            </code>
            <span v-else-if="row.config?.headers?.length" style="font-size: 12px; color: #666;">
              {{ row.config.headers.length }} 列：{{ row.config.headers.slice(0, 5).join(', ') }}
            </span>
            <span v-else style="color: #999;">—</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="180">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <el-button link size="small" v-permission="'datasource:read'" @click="openRows(row)">预览数据</el-button>
            <el-button link size="small" :loading="testingId === row.id"
                       v-if="row.type === 'sql'"
                       v-permission="'datasource:read'"
                       @click="doTest(row)">测试连接</el-button>
            <el-popconfirm title="删除后模板变量将无法再取该数据源的数据，确认？" @confirm="doDelete(row)">
              <template #reference>
                <el-button link size="small" type="danger" v-permission="'datasource:write'">删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && !rows.length" description="还没有数据源，点右上角「导入表格」或「新建 SQL 数据源」" />
    </div>

    <!-- ============ 导入表格（Excel / CSV / TSV / JSON 统一入口） ============ -->
    <el-dialog v-model="importDlg.visible" title="导入表格数据源" width="780px" top="4vh">
      <el-steps :active="importDlg.step" finish-status="success" simple style="margin-bottom: 16px;">
        <el-step title="选择文件 / 粘贴数据" />
        <el-step title="字段映射" />
        <el-step title="完成" />
      </el-steps>

      <!-- Step 1：上传或粘贴 -->
      <div v-show="importDlg.step === 0">
        <el-form label-width="90px">
          <el-form-item label="数据源名称">
            <el-input v-model="importDlg.name" placeholder="例如：11月物料清单" />
          </el-form-item>
          <el-form-item label="文件">
            <el-upload
              :auto-upload="false"
              :show-file-list="false"
              accept=".xlsx,.xls,.csv,.tsv,.txt,.json"
              :on-change="onImportFile"
            >
              <el-button><el-icon><FolderOpened /></el-icon> 选择文件</el-button>
            </el-upload>
            <div class="hint">支持 .xlsx / .xls / .csv / .tsv / .txt / .json，Excel ≤ 10MB。Excel 由后端解析，其余在浏览器解析。</div>
          </el-form-item>
          <el-form-item label="或粘贴数据">
            <el-input v-model="importDlg.text" type="textarea" :rows="8" spellcheck="false"
                      placeholder='JSON 数组：[{"sku":"A-100","name":"可乐"}]  或 CSV / TSV（第一行为表头）'
                      @input="parseImportedText" />
          </el-form-item>
        </el-form>
        <div v-if="importDlg.parseError" class="err">{{ importDlg.parseError }}</div>
        <div v-if="importDlg.previewHeaders.length" class="map-tip">
          已解析 {{ importDlg.parsedRows.length }} 行 · {{ importDlg.previewHeaders.length }} 列
        </div>
      </div>

      <!-- Step 2：字段映射 -->
      <div v-show="importDlg.step === 1">
        <div class="hint" style="margin-bottom: 10px;">
          修改「保存后字段名」可重命名列；模板里的 DB 字段按此名称取数。留空则保持原名。
        </div>
        <el-table :data="importDlg.mappings" size="small" border max-height="360">
          <el-table-column prop="original" label="原始列" min-width="160" />
          <el-table-column label="示例值" min-width="180">
            <template #default="{ row }"><span class="cell">{{ row.sample }}</span></template>
          </el-table-column>
          <el-table-column label="保存后字段名" min-width="180">
            <template #default="{ row }"><el-input v-model="row.target" size="small" /></template>
          </el-table-column>
        </el-table>
      </div>

      <!-- Step 3：完成 -->
      <div v-show="importDlg.step === 2" class="done">
        <el-result icon="success" title="导入完成"
                   :sub-title="`数据源「${importDlg.name}」已保存 ${importDlg.savedRows} 行，可在设计器打印预览或打印页引用`" />
      </div>

      <template #footer>
        <el-button @click="closeImport">{{ importDlg.step === 2 ? '关闭' : '取消' }}</el-button>
        <el-button v-if="importDlg.step === 1" @click="importDlg.step = 0">上一步</el-button>
        <el-button v-if="importDlg.step === 0" type="primary" :disabled="!canGotoMap" @click="gotoMapping">下一步：字段映射</el-button>
        <el-button v-if="importDlg.step === 1" type="primary" :loading="importDlg.saving" @click="saveImport">保存到数据源</el-button>
      </template>
    </el-dialog>

    <!-- ============ 数据预览 ============ -->
    <el-dialog v-model="rowsDlg.visible" :title="`数据预览 · ${rowsDlg.name}`" width="1000px" top="5vh">
      <div class="hint" style="margin-bottom: 8px;">
        共 {{ rowsDlg.total }} 行（最多显示 500 行）。这些数据在设计器打印预览 / 打印页选择本数据源后即可使用。
      </div>
      <el-table :data="rowsDlg.rows" v-loading="rowsDlg.loading" size="small" border max-height="60vh">
        <el-table-column v-for="h in rowsDlg.headers" :key="h" :prop="h" :label="h" min-width="140" show-overflow-tooltip />
      </el-table>
      <template #footer><el-button @click="rowsDlg.visible = false">关闭</el-button></template>
    </el-dialog>

    <!-- ============ 新建 SQL 数据源 ============ -->
    <el-dialog v-model="sqlDlg.visible" title="新建 SQL 数据源" width="560px">
      <el-form label-width="110px">
        <el-form-item label="名称">
          <el-input v-model="sqlDlg.form.name" placeholder="例如：MES 物料视图" />
        </el-form-item>
        <el-form-item label="连接串">
          <el-input v-model="sqlDlg.form.connectionUrl" placeholder="postgresql://user:pass@host:5432/db" />
        </el-form-item>
        <el-form-item label="查询语句">
          <el-input v-model="sqlDlg.form.queryTemplate" type="textarea" :rows="4"
                    placeholder="SELECT code, name FROM v_item WHERE code = :code" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="sqlDlg.form.description" placeholder="选填" />
        </el-form-item>
      </el-form>
      <div style="color: #999; font-size: 12px;">
        连接串在后端用 AES-256-GCM 加密存储（<code>SQL_SECRET_KEY</code>），数据库里不落明文；
        查询强制只读，多语句会被拒绝。
      </div>
      <template #footer>
        <el-button @click="sqlDlg.visible = false">取消</el-button>
        <el-button type="primary" :loading="sqlDlg.saving" @click="doSaveSql">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import {
  apiListDataSources, apiDeleteDataSource, apiTestSqlDataSource, apiSaveSqlDataSource,
  apiUploadExcelDataSource, apiSaveDataSourceRows, apiDataSourceRows,
} from '@/api';
import { parseData } from '@/views/designer/engine/print';

const loading = ref(false);
const rows = ref<any[]>([]);
const testingId = ref<number | null>(null);

// ---------- 数据源列表 ----------
const sourceTypeLabel = (row: any) => {
  if (row.type === 'sql') return 'SQL';
  const st = row.config?.sourceType || row.type;
  return String(st || '—').toUpperCase();
};
const truncate = (s: string, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '—');
const formatTime = (t: string) => (t ? new Date(t).toLocaleString() : '-');

async function load() {
  loading.value = true;
  try { rows.value = (await apiListDataSources()) as any[]; }
  finally { loading.value = false; }
}

async function doTest(row: any) {
  testingId.value = row.id;
  try {
    const res: any = await apiTestSqlDataSource(row.id);
    if (res?.ok) ElMessage.success(`连接正常（${res.durationMs ?? 0}ms）`);
    else ElMessage.error(res?.message || '连接失败');
  } catch {}
  finally { testingId.value = null; }
}

async function doDelete(row: any) {
  try {
    await apiDeleteDataSource(row.id);
    ElMessage.success('已删除');
    await load();
  } catch {}
}

// ---------- 数据预览 ----------
const rowsDlg = ref<{
  visible: boolean; loading: boolean; name: string; total: number;
  rows: any[]; headers: string[];
}>({ visible: false, loading: false, name: '', total: 0, rows: [], headers: [] });

async function openRows(src: any) {
  rowsDlg.value = { visible: true, loading: true, name: src.name, total: 0, rows: [], headers: [] };
  try {
    const res: any = await apiDataSourceRows(src.id, 500);
    const list = Array.isArray(res) ? res : (res?.rows ?? res?.items ?? []);
    rowsDlg.value.rows = list;
    const hs: string[] = [];
    for (const r of list) for (const k of Object.keys(r ?? {})) if (!hs.includes(k)) hs.push(k);
    rowsDlg.value.headers = hs;
    rowsDlg.value.total = list.length;
  } catch {
    ElMessage.error('读取数据行失败（SQL 源请先执行刷新）');
  } finally {
    rowsDlg.value.loading = false;
  }
}

// ---------- 表格导入 ----------
interface Mapping { original: string; target: string; sample: string }
const importDlg = ref<{
  visible: boolean; step: number; saving: boolean; name: string; text: string;
  parseError: string; parsedRows: any[]; previewHeaders: string[];
  mappings: Mapping[]; sourceKind: 'excel' | 'text'; excelFile: File | null;
  savedRows: number;
}>({
  visible: false, step: 0, saving: false, name: '', text: '', parseError: '',
  parsedRows: [], previewHeaders: [], mappings: [], sourceKind: 'text', excelFile: null, savedRows: 0,
});

function openImport() {
  importDlg.value = {
    visible: true, step: 0, saving: false, name: '', text: '', parseError: '',
    parsedRows: [], previewHeaders: [], mappings: [], sourceKind: 'text', excelFile: null, savedRows: 0,
  };
}
function closeImport() { importDlg.value.visible = false; }

function buildMappings(headers: string[], sampleRow: any) {
  importDlg.value.previewHeaders = headers;
  importDlg.value.mappings = headers.map((h) => ({
    original: h,
    target: h,
    sample: String(sampleRow?.[h] ?? '').slice(0, 40),
  }));
}

function parseImportedText() {
  const d = importDlg.value;
  d.parseError = '';
  d.excelFile = null;
  d.sourceKind = 'text';
  try {
    const parsed = parseData(d.text);
    if (!parsed.rows.length) { d.parsedRows = []; d.previewHeaders = []; d.mappings = []; return; }
    d.parsedRows = parsed.rows;
    buildMappings(parsed.headers, parsed.rows[0]);
  } catch (e) {
    d.parsedRows = []; d.previewHeaders = []; d.mappings = [];
    d.parseError = `解析失败：${(e as Error).message}`;
  }
}

async function onImportFile(uploadFile: any) {
  const f = uploadFile.raw as File;
  if (!f) return;
  const d = importDlg.value;
  d.parseError = '';
  if (!d.name) d.name = f.name.replace(/\.[^.]+$/, '');
  if (/\.xlsx?$/i.test(f.name)) {
    // Excel：后端 SheetJS 解析，先上传拿到列与行样本
    d.sourceKind = 'excel';
    d.excelFile = f;
    d.saving = true;
    try {
      const res: any = await apiUploadExcelDataSource(f, d.name);
      const sourceId = res?.sourceId;
      const rowRes: any = await apiDataSourceRows(sourceId, 5);
      const list = Array.isArray(rowRes) ? rowRes : (rowRes?.rows ?? rowRes?.items ?? []);
      d.parsedRows = list;
      const hs: string[] = res?.columns?.length ? res.columns : Object.keys(list[0] ?? {});
      buildMappings(hs, list[0]);
      d.text = `已上传 Excel（数据源 #${sourceId}），共 ${res?.rows ?? list.length} 行`;
    } catch (e) {
      d.parseError = `Excel 上传失败：${(e as Error).message}`;
    } finally {
      d.saving = false;
    }
    return;
  }
  // CSV / TSV / TXT / JSON：浏览器解析
  d.sourceKind = 'text';
  d.excelFile = null;
  try {
    d.text = (await f.text()).slice(0, 2_000_000);
    parseImportedText();
  } catch (e) {
    d.parseError = `读取文件失败：${(e as Error).message}`;
  }
}

const canGotoMap = computed(() =>
  (importDlg.value.sourceKind === 'excel' || importDlg.value.parsedRows.length > 0)
  && !!importDlg.value.name.trim(),
);

function gotoMapping() {
  if (!importDlg.value.name.trim()) { ElMessage.warning('请填写数据源名称'); return; }
  importDlg.value.step = 1;
}

async function saveImport() {
  const d = importDlg.value;
  d.saving = true;
  try {
    if (d.sourceKind === 'excel') {
      // Excel 已在 Step1 上传入库，这里按字段映射另存一份规范名称的数据源
      const fieldMap: Record<string, string> = {};
      for (const m of d.mappings) if (m.target && m.target !== m.original) fieldMap[m.original] = m.target;
      const res: any = await apiSaveDataSourceRows({
        name: d.name, type: 'excel',
        headers: d.mappings.map((m) => m.target || m.original),
        rows: d.parsedRows, fieldMap,
      });
      d.savedRows = res?.rows ?? d.parsedRows.length;
    } else {
      const fieldMap: Record<string, string> = {};
      for (const m of d.mappings) if (m.target && m.target !== m.original) fieldMap[m.original] = m.target;
      const res: any = await apiSaveDataSourceRows({
        name: d.name, type: 'csv',
        headers: d.mappings.map((m) => m.target || m.original),
        rows: d.parsedRows, fieldMap, config: { sourceType: 'text' },
      });
      d.savedRows = res?.rows ?? d.parsedRows.length;
    }
    d.step = 2;
    await load();
    ElMessage.success('数据源已保存');
  } catch (e) {
    ElMessage.error(`保存失败：${(e as Error).message}`);
  } finally {
    d.saving = false;
  }
}

// ---------- 新建 SQL ----------
const sqlDlg = ref<{
  visible: boolean; saving: boolean;
  form: { name: string; connectionUrl: string; queryTemplate: string; description: string };
}>({
  visible: false, saving: false,
  form: { name: '', connectionUrl: '', queryTemplate: '', description: '' },
});

async function doSaveSql() {
  const f = sqlDlg.value.form;
  if (!f.name || !f.connectionUrl) { ElMessage.warning('名称和连接串必填'); return; }
  sqlDlg.value.saving = true;
  try {
    await apiSaveSqlDataSource({ ...f });
    ElMessage.success('已创建 SQL 数据源');
    sqlDlg.value.visible = false;
    sqlDlg.value.form = { name: '', connectionUrl: '', queryTemplate: '', description: '' };
    await load();
  } catch {}
  finally { sqlDlg.value.saving = false; }
}

onMounted(load);
</script>

<style scoped>
.hint { color: #909399; font-size: 12px; margin-top: 6px; }
.err { color: #f56c6c; font-size: 13px; margin-bottom: 10px; }
.map-tip { color: #67c23a; font-size: 13px; margin-top: 8px; }
.cell { font-family: monospace; font-size: 12px; color: #606266; }
.done { padding: 20px 0; }
</style>
