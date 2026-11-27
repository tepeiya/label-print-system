<template>
  <div>
    <div class="page-header">
      <h2>模板库</h2>
      <el-button type="primary" @click="openUdi">导入 UDI 模板包</el-button>
    </div>
    <TemplateLibraryPanel :key="panelKey" @open="goDesigner" />

    <!-- UDI 模板包：内置三个规格，导入后就是普通模板，改公司名/规格即可打印 -->
    <el-dialog v-model="udiVisible" title="UDI 模板包" width="760px" top="8vh">
      <div class="udi-tip">
        三个规格均按 GS1 规则内置：DataMatrix 走原生 <b>gs1datamatrix</b>（内含 FNC1），
        旁边配人眼可读的 HRI 明文。导入后是普通模板，可在设计器里改公司名、规格、字号。
      </div>
      <el-table v-loading="loading" :data="udiItems" size="small" max-height="380">
        <el-table-column label="模板" min-width="210">
          <template #default="{ row }">
            <b>{{ row.name }}</b>
            <div class="udi-code">{{ row.code }}</div>
          </template>
        </el-table-column>
        <el-table-column label="尺寸" width="110">
          <template #default="{ row }">{{ row.page?.widthMm }}×{{ row.page?.heightMm }} mm</template>
        </el-table-column>
        <el-table-column label="适用场景" min-width="180">
          <template #default="{ row }"><span class="udi-scn">{{ row.scenario }}</span></template>
        </el-table-column>
        <el-table-column label="变量" min-width="150">
          <template #default="{ row }">
            <span class="udi-vars">{{ (row.variables || []).join(' / ') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="96" align="right">
          <template #default="{ row }">
            <el-button link type="primary" :loading="importingCode === row.code" @click="importOne(row.code)">
              导入
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="udiError" class="udi-error">{{ udiError }}</div>
      <div v-if="lastImported" class="udi-ok">已导入：{{ lastImported }}（模板库搜得到，分类为 UDI）</div>
      <template #footer>
        <el-button @click="udiVisible = false">关闭</el-button>
        <el-button type="primary" :loading="importingAll" :disabled="!udiItems.length" @click="importAll">
          全部导入
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
// =============================================================================
// Templates.vue —— 模板库（独立页面入口）
//   1) 挂 TemplateLibraryPanel，与「标签设计器」里的模板库弹窗共用同一份列表逻辑；
//   2) 新增「导入 UDI 模板包」：从 /udi/templates 取内置三规格，
//      经 POST /templates/import 落成普通模板（此前只能手拼接口，界面没有入口）。
// =============================================================================
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useRouter } from 'vue-router';
import TemplateLibraryPanel from './designer/components/TemplateLibraryPanel.vue';
import { apiImportTemplate } from '@/api/templates';
import { apiUdiTemplates, apiUdiTemplatePayload, type UdiTemplateBrief } from '@/api/udi-compliance';
import './designer/designer.css';

const router = useRouter();
const panelKey = ref(0);

function goDesigner(id: number) {
  router.push({ path: '/designer', query: { id } });
}

const udiVisible = ref(false);
const udiItems = ref<UdiTemplateBrief[]>([]);
const loading = ref(false);
const udiError = ref('');
const importingCode = ref('');
const importingAll = ref(false);
const lastImported = ref('');

async function openUdi() {
  udiVisible.value = true;
  udiError.value = '';
  lastImported.value = '';
  if (udiItems.value.length) return;
  loading.value = true;
  try {
    const r = await apiUdiTemplates();
    udiItems.value = r.items || [];
  } catch (e: any) {
    udiError.value = '取模板包清单失败：' + (e?.message || e);
  } finally {
    loading.value = false;
  }
}

async function importOne(code: string) {
  importingCode.value = code;
  udiError.value = '';
  try {
    const p = await apiUdiTemplatePayload(code);
    const created: any = await apiImportTemplate({
      name: p.name,
      // 带模板编码：导入后 pack-print / 内部打印契约才能按 code 直接引用
      code,
      content: p.template as any,
      schemaVersion: 1,
      category: 'UDI',
      tags: ['UDI', 'GS1'],
    } as any);
    lastImported.value = `${p.name}（#${created?.id ?? '?'}）`;
    panelKey.value++; // 重新挂载列表，立刻能看到新模板
    ElMessage.success(`已导入「${p.name}」`);
  } catch (e: any) {
    udiError.value = `导入 ${code} 失败：` + (e?.response?.data?.message || e?.message || e);
  } finally {
    importingCode.value = '';
  }
}

async function importAll() {
  importingAll.value = true;
  udiError.value = '';
  const done: string[] = [];
  const failed: string[] = [];
  for (const t of udiItems.value) {
    try {
      const p = await apiUdiTemplatePayload(t.code);
      await apiImportTemplate({
        name: p.name,
        code: p.code ?? t.code,
        content: p.template as any,
        schemaVersion: 1,
        category: 'UDI',
        tags: ['UDI', 'GS1'],
      } as any);
      done.push(p.name);
    } catch (e: any) {
      failed.push(`${t.code}（${e?.response?.data?.message || e?.message || e}）`);
    }
  }
  importingAll.value = false;
  panelKey.value++;
  if (done.length) lastImported.value = done.join('、');
  if (failed.length) udiError.value = '失败：' + failed.join('；');
  ElMessage.success(`导入完成：成功 ${done.length} 个，失败 ${failed.length} 个`);
}
</script>

<style scoped>
.udi-tip {
  font-size: 12px;
  line-height: 1.7;
  color: #4b5563;
  background: #f6f8fb;
  border-left: 3px solid #2563eb;
  padding: 8px 12px;
  margin-bottom: 10px;
}
.udi-code { font-size: 11px; color: #6b7280; font-family: ui-monospace, monospace; }
.udi-scn { font-size: 12px; color: #374151; }
.udi-vars { font-size: 11px; color: #6b7280; }
.udi-error { margin-top: 8px; font-size: 12px; color: #b91c1c; }
.udi-ok { margin-top: 8px; font-size: 12px; color: #047857; }
</style>
