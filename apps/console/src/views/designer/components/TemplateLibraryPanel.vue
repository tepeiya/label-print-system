<template>
  <div class="tpl-panel">
    <!-- ------------------------------ 列表 ------------------------------ -->
    <template v-if="pane === 'list'">
      <div class="tpl-filter">
        <el-input
          v-model="keyword"
          placeholder="按名称搜索"
          clearable
          style="width: 220px"
          @input="reload"
        />
        <el-select v-model="category" style="width: 150px">
          <el-option label="全部分类" value="" />
          <el-option v-for="c in categories" :key="c" :label="c" :value="c" />
        </el-select>
        <el-checkbox v-model="favOnly">仅看收藏</el-checkbox>
        <span class="tpl-count">共 {{ total }} 个，当前 {{ rows.length }} 个</span>
        <el-button link type="primary" :loading="loading" @click="reload">刷新</el-button>
      </div>

      <div v-if="error" class="tpl-error">{{ error }}</div>

      <el-table
        v-else
        v-loading="loading"
        :data="rows"
        size="small"
        max-height="460"
        class="tpl-table"
        :row-class-name="rowClass"
      >
        <el-table-column label="预览" width="86">
          <template #default="{ row }"><TemplateThumb :content="row.content" /></template>
        </el-table-column>
        <el-table-column label="名称" min-width="200">
          <template #default="{ row }">
            <b>{{ row.name }}</b>
            <span class="tpl-id">#{{ row.id }}</span>
            <span v-if="row.isFavorite" class="fav">★</span>
          </template>
        </el-table-column>
        <el-table-column label="分类" width="110">
          <template #default="{ row }">{{ row.category || '默认' }}</template>
        </el-table-column>
        <el-table-column label="版本" width="70">
          <template #default="{ row }">v{{ row.currentVersion ?? 1 }}</template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">{{ when(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="260">
          <template #default="{ row }">
            <el-button link size="small" @click="io.toggleFavorite(row, !row.isFavorite)">{{ row.isFavorite ? '★' : '☆' }}</el-button>
            <el-button link size="small" type="primary" @click="open(row)">打开</el-button>
            <el-button link size="small" @click="showVersions(row)">版本</el-button>
            <el-button link size="small" @click="io.copy(row.id, `${row.name}-副本`).then(reload)">复制</el-button>
            <el-button link size="small" @click="exportOne(row)">导出</el-button>
            <el-button link size="small" type="danger" @click="del(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="tpl-empty-text">
            {{ loading ? '加载中…' : (all.length ? '当前筛选条件下没有模板' : '还没有保存过模板，在设计器里点「💾 保存」') }}
          </div>
        </template>
      </el-table>
    </template>

    <!-- ------------------------------ 版本 ------------------------------ -->
    <template v-else>
      <div v-if="!versions.length" class="tpl-empty-text">暂无版本记录</div>
      <div v-else class="version-list">
        <div v-for="v in versions" :key="v.version" class="version-item">
          <div class="version-head">
            <b>v{{ v.version }}</b>
            <span class="version-time">{{ when(v.createdAt) }}</span>
            <span class="st-spacer" />
            <el-button link size="small" @click="toggleDiff(v.version)">对比当前</el-button>
            <el-button link size="small" @click="loadVersion(v)">载入画布</el-button>
            <el-button link size="small" type="primary" @click="doRollback(v.version)">回滚到此版本</el-button>
          </div>
          <div v-if="diffs[v.version]" class="diff-lines">
            <div v-for="(line, i) in diffs[v.version]" :key="i">{{ line }}</div>
          </div>
        </div>
      </div>
      <div class="ver-foot">
        <el-button link type="primary" @click="backToList">← 返回模板库</el-button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
// =============================================================================
// TemplateLibraryPanel.vue —— 模板库面板（无弹窗壳，可嵌在弹窗或独立页面）
//   列表 / 搜索 / 分类 / 收藏 / 打开 / 复制 / 删除 / 导出 / 版本历史与回滚全在这一处。
//   原 TemplateLibraryDialog 只保留 el-dialog 外壳后复用本组件，菜单「模板库」页
//   也直接挂载本组件，保证两处行为完全一致。
//   「打开 / 载入画布」统一向上 emit('open', id)，由父组件决定落地行为：
//     设计器弹窗 → 载入画布；模板库独立页 → 路由跳设计器打开。
// =============================================================================
import { computed, ref, onMounted } from 'vue';
import { apiExportTemplate, apiListTemplates } from '@/api/templates';
import { useDesignerStore } from '../store';
import { useTemplateIO } from '../useTemplateIO';
import { downloadFile } from '../engine/util';
import type { TemplateData, TemplateRecord, TemplateVersion } from '../types';
import TemplateThumb from './TemplateThumb.vue';

const props = defineProps<{ versionTarget?: number | null }>();
const emit = defineEmits<{ open: [number] }>();

const store = useDesignerStore();
const io = useTemplateIO();

const all = ref<TemplateRecord[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref('');
const keyword = ref('');
const category = ref('');
const favOnly = ref(false);

const rows = computed(() => all.value.filter((t) =>
  (!favOnly.value || t.isFavorite) && (!category.value || (t.category || '默认') === category.value)));

const categories = computed(() =>
  [...new Set(all.value.map((t) => t.category || '默认'))].sort((a, b) => a.localeCompare(b, 'zh-CN')));

// ------------------------------ 版本页 ------------------------------
const pane = ref<'list' | 'versions'>('list');
const versionsFor = ref<{ id: number; name: string } | null>(null);
const versions = ref<TemplateVersion[]>([]);
const diffs = ref<Record<number, string[]>>({});

function when(s?: string) {
  return s ? new Date(s).toLocaleString('zh-CN') : '—';
}

function rowClass({ row }: { row: TemplateRecord }) {
  return row.id === store.templateId ? 'tpl-current' : '';
}

/** 后端 list 返回 [rows, total] 元组，与 templates.js 的解析口径一致 */
async function reload() {
  loading.value = true;
  error.value = '';
  try {
    const [list, count] = await apiListTemplates({
      page: 1, pageSize: 50, ...(keyword.value.trim() ? { keyword: keyword.value.trim() } : {}),
    });
    all.value = list ?? [];
    total.value = count ?? all.value.length;
    if (category.value && !categories.value.includes(category.value)) category.value = '';
  } catch (e) {
    error.value = `加载失败：${(e as Error).message || '未知错误'}`;
    all.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

/** 打开模板：统一向上抛 id，父组件决定是载入画布还是路由跳走 */
function open(row: TemplateRecord) {
  emit('open', row.id);
}

async function del(row: TemplateRecord) {
  if (await io.remove(row.id)) void reload();
}

/** 导出：优先用服务端的模板包结构，与 /templates/:id/export 一致 */
async function exportOne(row: TemplateRecord) {
  try {
    const pack = await apiExportTemplate(row.id);
    downloadFile(`${row.name}.json`, JSON.stringify(pack, null, 2));
  } catch {
    downloadFile(`${row.name}.json`, JSON.stringify({
      schemaVersion: 1, name: row.name, category: row.category || '默认',
      tags: row.tags || [], content: row.content,
    }, null, 2));
  }
}

async function showVersions(row: { id: number; name: string }) {
  versionsFor.value = row;
  versions.value = await io.loadVersions(row.id);
  diffs.value = {};
  pane.value = 'versions';
}

function backToList() {
  pane.value = 'list';
  void reload();
}

function toggleDiff(v: number) {
  const next = { ...diffs.value };
  if (next[v]) delete next[v];
  else {
    const ver = versions.value.find((x) => x.version === v);
    if (ver) next[v] = diffLines(ver.content, store.template);
  }
  diffs.value = next;
}

/** 载入历史版本到画布（设计器语义）；独立页里由父组件把 open 路由到设计器打开 */
function loadVersion(_v: TemplateVersion) {
  if (versionsFor.value?.id != null) emit('open', versionsFor.value.id);
}

async function doRollback(v: number) {
  const id = versionsFor.value?.id;
  if (id == null) return;
  if (await io.rollback(id, v)) void reload();
}

// ---------------------------------------------------------------------------
// 版本对比：沿用原生版的新增/删除/修改 + 页面尺寸三段式
// ---------------------------------------------------------------------------
function diffLines(a: TemplateData, b: TemplateData): string[] {
  const ea = a?.elements ?? [];
  const eb = b?.elements ?? [];
  const idsA = new Set(ea.map((x) => x.id));
  const idsB = new Set(eb.map((x) => x.id));
  const added = eb.filter((x) => !idsA.has(x.id));
  const removed = ea.filter((x) => !idsB.has(x.id));
  const changed = eb.filter((x) => {
    const old = ea.find((y) => y.id === x.id);
    return !!old && JSON.stringify(old) !== JSON.stringify(x);
  });
  const pa = a?.page;
  const pb = b?.page;
  const lines = [
    pa && pb && (pa.widthMm !== pb.widthMm || pa.heightMm !== pb.heightMm || pa.dpi !== pb.dpi)
      ? `页面：${pa.widthMm}×${pa.heightMm}mm @${pa.dpi}dpi → ${pb.widthMm}×${pb.heightMm}mm @${pb.dpi}dpi`
      : '页面尺寸未变',
    `元素：旧 ${ea.length} 个 → 当前 ${eb.length} 个`,
    added.length ? `新增 ${added.length} 个（${added.map((x) => x.name || x.type).join('、')}）` : '',
    removed.length ? `删除 ${removed.length} 个（${removed.map((x) => x.name || x.type).join('、')}）` : '',
    changed.length ? `修改 ${changed.length} 个（${changed.map((x) => x.name || x.type).join('、')}）` : '',
  ];
  return lines.filter(Boolean);
}

onMounted(() => {
  diffs.value = {};
  versions.value = [];
  if (props.versionTarget != null) {
    versionsFor.value = { id: props.versionTarget, name: '' };
    void showVersions(versionsFor.value);
  } else {
    pane.value = 'list';
    void reload();
  }
});
</script>
