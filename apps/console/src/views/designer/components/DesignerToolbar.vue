<template>
  <div class="d-toolbar">
    <div class="d-tb-left">
      <input
        class="tpl-name"
        :value="store.templateName"
        title="模板名称"
        spellcheck="false"
        @change="rename"
      >
      <span v-if="store.dirty" class="d-dirty" title="有未保存的修改">● 未保存</span>
      <span class="d-ver">#{{ store.templateId ?? '—' }} v{{ store.templateVersion ?? '—' }}</span>
    </div>

    <div class="d-tb-right">
      <button type="button" class="icon-btn" :disabled="!store.canUndo" title="撤销 (Ctrl+Z)" @click="run(store.undo, '没有可撤销的操作')">↶</button>
      <button type="button" class="icon-btn" :disabled="!store.canRedo" title="重做 (Ctrl+Y)" @click="run(store.redo, '没有可重做的操作')">↷</button>
      <i class="sep" />

      <button type="button" class="icon-btn" title="缩小" @click="store.setZoom(store.zoom - 0.1)">－</button>
      <button type="button" class="icon-btn zoom-label" title="恢复 100%" @click="store.setZoom(1)">{{ Math.round(store.zoom * 100) }}%</button>
      <button type="button" class="icon-btn" title="放大" @click="store.setZoom(store.zoom + 0.1)">＋</button>
      <button type="button" class="icon-btn" title="适应窗口" @click="fit">⤢</button>
      <i class="sep" />

      <button type="button" class="icon-btn" :class="{ on: store.rulersVisible }" title="标尺与参考线" @click="store.setRulersVisible(!store.rulersVisible)">📏</button>
      <i class="sep" />

      <button type="button" class="icon-btn" :disabled="!hasSel" title="置顶" @click="store.bringToFront()">⬆</button>
      <button type="button" class="icon-btn" :disabled="!hasSel" title="上移一层" @click="store.bringForward()">↑</button>
      <button type="button" class="icon-btn" :disabled="!hasSel" title="下移一层" @click="store.sendBackward()">↓</button>
      <button type="button" class="icon-btn" :disabled="!hasSel" title="置底" @click="store.sendToBack()">⬇</button>
      <i class="sep" />

      <button type="button" class="icon-btn" :disabled="!hasSel" title="复制 (Ctrl+D)" @click="store.duplicateSelected()">⧉</button>
      <button type="button" class="icon-btn danger" :disabled="!hasSel" title="删除 (Delete)" @click="store.removeElements()">🗑</button>
      <i class="sep" />

      <button type="button" class="btn" title="模板库" @click="emit('library')">🗂 模板库</button>
      <button type="button" class="btn" :disabled="store.templateId == null" title="历史版本" @click="emit('versions')">🕘 版本</button>
      <button type="button" class="btn" title="打印预览" @click="emit('print')">🖨 打印预览</button>
      <button type="button" class="btn" title="导入模板 JSON" @click="pickFile">导入</button>
      <button type="button" class="btn" title="导出模板 JSON" @click="io.exportJson()">导出</button>
      <button type="button" class="btn" title="新建模板" @click="newTemplate">＋ 新建</button>
      <button type="button" class="btn primary" :disabled="!canWrite" v-permission="'template:write'" :title="saving ? '保存中…' : '保存模板 (Ctrl+S)'" @click="doSave()">
        {{ saving ? '保存中…' : '💾 保存' }}
      </button>
      <button type="button" class="btn" :disabled="!canWrite || store.templateId == null" v-permission="'template:write'" title="另存为新模板" @click="doSave(true)">另存为</button>
    </div>

    <input ref="fileRef" type="file" accept=".json,application/json" hidden @change="onFile">
  </div>
</template>

<script setup lang="ts">
// =============================================================================
// DesignerToolbar.vue —— 顶部工具栏（app.js#bindToolbar + index.html#design-toolbar）
//   按钮语义与原生版一一对应；保存/导入导出/新建走 useTemplateIO，
//   模板库 / 版本 / 打印预览这三个「原生版是独立页签」的能力在这里以弹窗呈现，
//   由 Designer.vue 持有对话框状态，工具栏只发意图。
//   写权限（template:write）用 v-permission 兜 UX，真正的拦截在后端守卫。
// =============================================================================
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useDesignerStore } from '../store';
import { useTemplateIO } from '../useTemplateIO';
import { MM2PX } from '../engine/util';
import { useAuthStore } from '@/store/auth';

const emit = defineEmits<{ library: []; versions: []; print: [] }>();

const store = useDesignerStore();
const auth = useAuthStore();
const io = useTemplateIO();

const saving = io.saving;
const hasSel = computed(() => store.hasSelection);
const canWrite = computed(() => auth.hasPermission('template:write'));
const fileRef = ref<HTMLInputElement | null>(null);

/** 原生版的 undo/redo 在无历史时只弹一句 toast，这里保持一致 */
function run(fn: () => boolean, empty: string) {
  if (!fn()) ElMessage.info(empty);
}

function rename(e: Event) {
  const v = (e.target as HTMLInputElement).value.trim();
  if (!v) { (e.target as HTMLInputElement).value = store.templateName; return; }
  store.templateName = v;
  store.markDirty();
}

/** 适应窗口：与 app.js#zoomFit 同一算法（视口内边距 48px） */
function fit() {
  const vp = document.querySelector('.lf-area .viewport') as HTMLElement | null;
  if (!vp) { store.setZoom(1); return; }
  const p = store.page;
  const z = Math.min((vp.clientWidth - 48) / (p.widthMm * MM2PX), (vp.clientHeight - 48) / (p.heightMm * MM2PX));
  store.setZoom(z);
}

async function doSave(saveAs = false) {
  await io.save({ saveAs });
}

async function newTemplate() {
  try {
    await ElMessageBox.confirm('新建模板会清空当前画布，未保存的修改将丢失。是否继续？', '新建模板', {
      type: 'warning', confirmButtonText: '新建', cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  store.newTemplate();
  ElMessage.success('已新建空白模板');
}

function pickFile() {
  fileRef.value?.click();
}

async function onFile(e: Event) {
  const inp = e.target as HTMLInputElement;
  const f = inp.files?.[0];
  if (!f) return;
  try {
    await io.importJson(await f.text());
  } finally {
    inp.value = '';
  }
}
</script>
