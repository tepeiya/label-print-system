// =============================================================================
// useTemplateIO.ts —— 模板的服务器读写（templates.js 的 Console 版）
//   保存语义与原生版一致：
//     · templateId 为空 → 新建（POST /templates），成功后把 id/version 回填 store
//     · 已有 id        → 更新（PUT /templates/:id），后端自动 +1 个版本快照
//   content 就是设计器 JSON（schemaVersion 1），与 web/ 原生设计器、打印端同一份。
// =============================================================================

import { ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  apiCopyTemplate, apiCreateTemplate, apiExportTemplate, apiFavoriteTemplate,
  apiGetTemplate, apiImportTemplate, apiRollbackTemplate, apiTemplateVersion,
  apiDeleteTemplate, apiTemplateVersions, apiUpdateTemplate,
} from '@/api/templates';
import { useAuthStore } from '@/store/auth';
import { useDesignerStore, AUTOSAVE_KEY } from './store';
import { downloadFile } from './engine/util';
import type { TemplateRecord, TemplateVersion } from './types';

export function useTemplateIO() {
  const store = useDesignerStore();
  const auth = useAuthStore();
  const saving = ref(false);

  const userId = () => auth.user?.id;

  /** 保存（新建或更新），返回服务器行；失败时已弹过 toast，返回 null */
  async function save(opts: { saveAs?: boolean } = {}): Promise<TemplateRecord | null> {
    if (!store.templateName.trim()) {
      ElMessage.warning('请先填写模板名称');
      return null;
    }
    const content = store.template;
    saving.value = true;
    try {
      let row: TemplateRecord;
      if (store.templateId != null && !opts.saveAs) {
        row = await apiUpdateTemplate(store.templateId, {
          name: store.templateName, content, updatedBy: userId(),
        });
      } else {
        row = await apiCreateTemplate({
          name: store.templateName,
          category: store.templateCategory || undefined,
          content,
          createdBy: userId(),
        });
      }
      store.templateId = row.id;
      store.templateVersion = row.currentVersion ?? null;
      store.templateName = row.name;
      store.markSaved();
      // 保存成功后清掉本地草稿，避免下次进来又提示恢复旧 autosave
      clearAutosave();
      ElMessage.success(`已保存（v${row.currentVersion}）`);
      return row;
    } catch {
      return null;
    } finally {
      saving.value = false;
    }
  }

  /** 打开服务器模板 */
  async function open(id: number): Promise<boolean> {
    try {
      const row = await apiGetTemplate(id);
      if (store.dirty && !(await confirmLoseChanges())) return false;
      store.loadTemplate(row.content, {
        id: row.id,
        name: row.name,
        category: row.category ?? undefined,
        version: row.currentVersion,
      });
      ElMessage.success(`已打开「${row.name}」`);
      return true;
    } catch {
      return false;
    }
  }

  async function copy(id: number, name: string): Promise<TemplateRecord | null> {
    try {
      const row = await apiCopyTemplate(id, name);
      ElMessage.success(`已复制为「${row.name}」`);
      return row;
    } catch {
      return null;
    }
  }

  async function toggleFavorite(row: TemplateRecord, value: boolean) {
    try {
      await apiFavoriteTemplate(row.id, value);
      row.isFavorite = value;
    } catch { /* 拦截器已提示 */ }
  }

  async function remove(id: number): Promise<boolean> {
    if (!(await confirmLoseChanges('删除后不可恢复，确认删除该模板？'))) return false;
    try {
      await apiDeleteTemplate(id);
      if (store.templateId === id) {
        store.templateId = null;
        store.templateVersion = null;
        store.markDirty();
      }
      ElMessage.success('已删除');
      return true;
    } catch {
      return false;
    }
  }

  async function loadVersions(id: number): Promise<TemplateVersion[]> {
    try {
      return await apiTemplateVersions(id);
    } catch {
      return [];
    }
  }

  async function loadVersion(id: number, v: number): Promise<TemplateVersion | null> {
    try {
      return await apiTemplateVersion(id, v);
    } catch {
      return null;
    }
  }

  /** 回滚：后端把历史内容另存为新版本并返回最新行，这里顺带刷新画布 */
  async function rollback(id: number, v: number): Promise<boolean> {
    if (!(await confirmLoseChanges(`回滚到 v${v}？当前未保存的修改会丢失`))) return false;
    try {
      const row = await apiRollbackTemplate(id, v);
      store.loadTemplate(row.content, {
        id: row.id, name: row.name, version: row.currentVersion,
      });
      ElMessage.success(`已回滚到 v${v}（当前 v${row.currentVersion}）`);
      return true;
    } catch {
      return false;
    }
  }

  /** 导出到本地文件（.json，结构与 /templates/:id/export 一致） */
  async function exportJson() {
    const name = store.templateName || 'template';
    if (store.templateId != null) {
      try {
        const pack = await apiExportTemplate(store.templateId);
        downloadFile(`${name}.json`, JSON.stringify(pack, null, 2));
        return;
      } catch { /* 退化成本地导出 */ }
    }
    downloadFile(`${name}.json`, JSON.stringify({
      name, category: store.templateCategory, content: store.template, schemaVersion: store.template.schemaVersion,
    }, null, 2));
  }

  /** 导入本地文件：直接建到服务器（与原生 templates.js#importTemplate 同语义） */
  async function importJson(text: string): Promise<boolean> {
    let pack: Record<string, unknown>;
    try {
      pack = JSON.parse(text) as Record<string, unknown>;
    } catch {
      ElMessage.error('导入失败：不是合法的 JSON');
      return false;
    }
    const content = (pack.content ?? pack) as TemplateRecord['content'];
    const name = String(pack.name || '导入模板');
    if (!content || !Array.isArray((content as { elements?: unknown }).elements)) {
      ElMessage.error('导入失败：缺少 elements');
      return false;
    }
    if (store.dirty && !(await confirmLoseChanges())) return false;
    try {
      const row = await apiImportTemplate({
        name,
        content,
        category: typeof pack.category === 'string' ? pack.category : undefined,
        tags: Array.isArray(pack.tags) ? (pack.tags as string[]) : undefined,
        schemaVersion: typeof pack.schemaVersion === 'number' ? pack.schemaVersion : undefined,
      });
      store.loadTemplate(row.content, {
        id: row.id, name: row.name, category: row.category ?? undefined, version: row.currentVersion,
      });
      ElMessage.success(`已导入「${row.name}」`);
      return true;
    } catch {
      return false;
    }
  }

  /** 当前模板内容直接进画布（AI 生成、示例模板走这条路） */
  function applyLocally(content: TemplateRecord['content'], name?: string) {
    store.loadTemplate(content, { id: null, name });
  }

  return {
    saving, save, open, copy, toggleFavorite, remove,
    loadVersions, loadVersion, rollback, exportJson, importJson, applyLocally,
  };
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------
async function confirmLoseChanges(message = '当前有未保存的修改，继续将丢失。确认？'): Promise<boolean> {
  if (!useDesignerStore().dirty) return true;
  try {
    await ElMessageBox.confirm(message, '未保存的修改', {
      type: 'warning', confirmButtonText: '继续', cancelButtonText: '取消',
    });
    return true;
  } catch {
    return false;
  }
}

function clearAutosave() {
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch { /* 隐私模式忽略 */ }
}
