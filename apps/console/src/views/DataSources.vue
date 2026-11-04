<template>
  <div>
    <div class="page-header">
      <h2>📊 数据源管理</h2>
      <div style="display: flex; gap: 8px;">
        <el-button type="primary" v-permission="'datasource:write'" @click="dlg.visible = true">
          <el-icon><Plus /></el-icon> 新建 SQL 数据源
        </el-button>
        <el-button @click="load" :loading="loading">刷新</el-button>
      </div>
    </div>

    <el-alert type="info" :closable="false" style="margin-bottom: 16px;">
      Excel / CSV 数据源请在标签设计器的「数据源」面板里上传（需要本地表格文件与字段映射）。
      本页管理已连接的数据源，SQL 数据源仅允许执行 SELECT / WITH 只读查询。
    </el-alert>

    <div class="card">
      <el-table :data="rows" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="名称" min-width="180" />
        <el-table-column label="类型" width="120">
          <template #default="{ row }">
            <el-tag size="small" :type="row.type === 'sql' ? 'warning' : 'success'" effect="plain">
              {{ (row.type || '').toUpperCase() }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="说明 / 查询" min-width="260">
          <template #default="{ row }">
            <span v-if="row.config?.description">{{ row.config.description }}</span>
            <code v-else-if="row.config?.queryTemplate" style="font-size: 12px;">
              {{ truncate(row.config.queryTemplate, 80) }}
            </code>
            <span v-else style="color: #999;">—</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="180">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
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
      <el-empty v-if="!loading && !rows.length" description="还没有数据源" />
    </div>

    <el-dialog v-model="dlg.visible" title="新建 SQL 数据源" width="560px">
      <el-form label-width="110px">
        <el-form-item label="名称">
          <el-input v-model="dlg.form.name" placeholder="例如：MES 物料视图" />
        </el-form-item>
        <el-form-item label="连接串">
          <el-input v-model="dlg.form.connectionUrl" placeholder="postgresql://user:pass@host:5432/db" />
        </el-form-item>
        <el-form-item label="查询语句">
          <el-input v-model="dlg.form.queryTemplate" type="textarea" :rows="4"
                    placeholder="SELECT code, name FROM v_item WHERE code = :code" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="dlg.form.description" placeholder="选填" />
        </el-form-item>
      </el-form>
      <div style="color: #999; font-size: 12px;">
        连接串在后端用 AES-256-GCM 加密存储（<code>SQL_SECRET_KEY</code>），数据库里不落明文；
        查询强制只读，多语句会被拒绝。
      </div>
      <template #footer>
        <el-button @click="dlg.visible = false">取消</el-button>
        <el-button type="primary" :loading="dlg.saving" @click="doSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import {
  apiListDataSources, apiDeleteDataSource, apiTestSqlDataSource, apiSaveSqlDataSource,
} from '@/api';

const loading = ref(false);
const rows = ref<any[]>([]);
const testingId = ref<number | null>(null);
// 这里用 ref 而不是 reactive：vue-tsc 3.3 对模板里 v-model 绑定 reactive 的嵌套属性
// （dlg.form.connectionUrl 这种三层路径）会误报 TS2339 Property 'value' does not exist。
// 换成 ref 后模板自动解包，脚本侧显式 .value，类型检查干净。
const dlg = ref<{
  visible: boolean;
  saving: boolean;
  form: { name: string; connectionUrl: string; queryTemplate: string; description: string };
}>({
  visible: false,
  saving: false,
  form: { name: '', connectionUrl: '', queryTemplate: '', description: '' },
});

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
    // 后端 ping() 返回 { ok, message?, durationMs }：失败也是 200，不抛异常
    const res: any = await apiTestSqlDataSource(row.id);
    if (res?.ok) ElMessage.success(`连接正常（${res.durationMs ?? 0}ms）`);
    else ElMessage.error(res?.message || '连接失败');
  } catch {}
  finally { testingId.value = null; }
}

async function doSave() {
  if (!dlg.value.form.name || !dlg.value.form.connectionUrl) {
    ElMessage.warning('名称和连接串必填');
    return;
  }
  dlg.value.saving = true;
  try {
    await apiSaveSqlDataSource({ ...dlg.value.form });
    ElMessage.success('已创建 SQL 数据源');
    dlg.value.visible = false;
    dlg.value.form = { name: '', connectionUrl: '', queryTemplate: '', description: '' };
    await load();
  } catch {}
  finally { dlg.value.saving = false; }
}

async function doDelete(row: any) {
  try {
    await apiDeleteDataSource(row.id);
    ElMessage.success('已删除');
    await load();
  } catch {}
}

onMounted(load);
</script>
