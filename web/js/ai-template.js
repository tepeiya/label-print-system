// =============================================================================
// ai-template.js —— AI 标签图片 → 模板 自动生成（前端）
// =============================================================================
import { api, getToken, doLogin } from './api.js';
import { store } from './store.js';
import { resetCurrentTemplateId } from './templates.js';
import { toast } from './util.js';

const BASE = api.base;

const state = {
  file: null,
  previewUrl: '',
  result: null,      // 后端返回的 { template, meta }
};

const $ = (id) => document.getElementById(id);

export function initAiTemplate() {
  const fileInput = $('ai-file');
  const dropzone = $('ai-dropzone');
  if (!fileInput || !dropzone) return;

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) setFile(f);
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragging'); }));
  dropzone.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) setFile(f);
  });

  $('btn-ai-generate')?.addEventListener('click', generate);
  $('btn-ai-reset')?.addEventListener('click', reset);
  $('btn-ai-load')?.addEventListener('click', loadIntoCanvas);
  $('btn-ai-save-tpl')?.addEventListener('click', saveToLibrary);
  $('btn-ai-model-save')?.addEventListener('click', saveModel);
  $('btn-ai-model-refresh')?.addEventListener('click', loadModels);

  // 切到该页签时刷新模型列表
  window.addEventListener('ai-refresh', () => loadModels());
}

function setFile(f) {
  if (!/^image\//.test(f.type)) { toast('请选择图片文件', 'error'); return; }
  if (f.size > 10 * 1024 * 1024) { toast('图片超过 10MB', 'error'); return; }
  state.file = f;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(f);
  const img = $('ai-preview');
  img.src = state.previewUrl;
  img.hidden = false;
  const hint = $('ai-dropzone-hint');
  if (hint) hint.hidden = true;
  $('btn-ai-generate').disabled = false;
  setStatus(`已选择：${f.name}（${(f.size / 1024).toFixed(0)} KB）`);
}

function setStatus(msg) {
  const el = $('ai-status');
  if (el) el.textContent = msg;
}

function reset() {
  state.file = null;
  state.result = null;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = '';
  const img = $('ai-preview');
  if (img) { img.hidden = true; img.src = ''; }
  const hint = $('ai-dropzone-hint');
  if (hint) hint.hidden = false;
  const fi = $('ai-file');
  if (fi) fi.value = '';
  $('btn-ai-generate').disabled = true;
  $('btn-ai-load').disabled = true;
  $('btn-ai-save-tpl').disabled = true;
  $('ai-summary').textContent = '尚未生成';
  $('ai-warnings').hidden = true;
  $('ai-elements-body').innerHTML = '<tr><td colspan="6" class="tpl-empty">上传图片并生成后在此查看</td></tr>';
  $('ai-variables').textContent = '—';
  setStatus('等待上传图片');
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------
async function generate() {
  if (!state.file) { toast('请先选择图片', 'error'); return; }
  const widthMm = Number($('ai-width').value);
  const heightMm = Number($('ai-height').value);
  const dpi = Number($('ai-dpi').value);
  if (!(widthMm > 0) || !(heightMm > 0)) { toast('请填写有效的标签宽高', 'error'); return; }

  const btn = $('btn-ai-generate');
  btn.disabled = true;
  const t0 = Date.now();
  setStatus('正在识别…（条码 / 文字 / 图形，首次 OCR 需加载模型，可能 10-30 秒）');

  try {
    const fd = new FormData();
    fd.append('file', state.file);
    fd.append('widthMm', String(widthMm));
    fd.append('heightMm', String(heightMm));
    fd.append('dpi', String(dpi));
    fd.append('lang', $('ai-lang').value);
    fd.append('useLlm', $('ai-use-llm').checked ? 'true' : 'false');
    const kw = $('ai-keywords').value.trim();
    if (kw) fd.append('variableHintKeywords', kw);

    const res = await fetch(BASE + '/ai-template/generate', {
      method: 'POST',
      headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
      body: fd,
    });
    let json = await res.json().catch(() => null);
    if (res.status === 401) {
      await doLogin();
      return generate();
    }
    if (!json || json.code !== 0) {
      throw new Error(json?.message || `HTTP ${res.status}`);
    }
    state.result = json.data;
    renderResult(json.data);
    setStatus(`完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    $('btn-ai-load').disabled = false;
    $('btn-ai-save-tpl').disabled = false;
  } catch (e) {
    console.error(e);
    setStatus('生成失败：' + e.message);
    toast('生成失败：' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 渲染结果
// ---------------------------------------------------------------------------
const TYPE_LABEL = {
  text: '文本', barcode: '一维码', qrcode: '二维码', line: '线条',
  rect: '矩形', ellipse: '圆', table: '表格', image: '图片',
  serial: '流水号', formula: '公式', datetime: '日期', sysvar: '系统变量',
};

function renderResult(data) {
  const { template, meta } = data || {};
  if (!template) return;

  const c = meta?.counts || {};
  $('ai-summary').textContent =
    `${template.elements.length} 元素 · ${template.variables.length} 变量 · ` +
    `条码 ${c.barcodes ?? 0} · 文字行 ${c.ocrLines ?? 0} · ` +
    `模型 ${meta?.model || '-'}${meta?.llmUsed ? '（AI 精修）' : '（规则引擎）'}`;

  // 警告
  const warns = (meta?.warnings || []).filter(Boolean);
  const box = $('ai-warnings');
  if (warns.length) {
    box.hidden = false;
    box.innerHTML = '';
    for (const w of warns.slice(0, 8)) {
      const div = document.createElement('div');
      const level = typeof w === 'string' ? 'low' : (w.level || 'low');
      const msg = typeof w === 'string' ? w : w.message;
      div.className = `ai-warn ai-warn-${level}`;
      div.textContent = (level === 'high' ? '⛔ ' : level === 'medium' ? '⚠ ' : 'ℹ ') + msg;
      box.appendChild(div);
    }
  } else {
    box.hidden = true;
  }

  // 元素表
  const tbody = $('ai-elements-body');
  tbody.innerHTML = '';
  const hints = new Map((meta?.variableHints || []).map((h) => [h.elementId, h]));
  const conf = meta?.confidence || {};

  if (!template.elements.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="tpl-empty">未识别到元素</td></tr>';
  }

  for (const el of template.elements) {
    const tr = document.createElement('tr');
    const content = elementContent(el);
    const hint = hints.get(el.id);
    const confVal = conf[el.id];
    const confText = typeof confVal === 'number' ? `${Math.round(confVal * 100)}%` : '—';
    const confClass = typeof confVal === 'number' ? (confVal >= 0.9 ? 'ok' : confVal >= 0.7 ? 'mid' : 'low') : '';
    tr.innerHTML = `
      <td><span class="ai-type">${TYPE_LABEL[el.type] || el.type}</span></td>
      <td class="ai-content" title="${escapeAttr(content)}">${escapeHtml(content)}</td>
      <td class="ai-pos">${fmt(el.x)} , ${fmt(el.y)} · ${fmt(el.w)} × ${fmt(el.h)}</td>
      <td>${hint ? `<span class="ai-chip">${escapeHtml(hint.category)}</span> ${escapeHtml(hint.suggestedName)}` : '常量'}</td>
      <td><span class="ai-conf ${confClass}">${confText}</span></td>
      <td>${Math.round(el.zIndex ?? 0)}</td>
    `;
    tbody.appendChild(tr);
  }

  // 变量
  const vars = $('ai-variables');
  if (template.variables.length) {
    vars.innerHTML = template.variables
      .map((v) => `<span class="ai-var"><b>{{${escapeHtml(v.name)}}}</b> ${escapeHtml(v.label || '')} <i>${escapeHtml(v.type)}</i></span>`)
      .join('');
  } else {
    vars.textContent = '未识别到变量';
  }
}

function elementContent(el) {
  if (el.type === 'barcode') return el.barcode?.content || '';
  if (el.type === 'qrcode') return el.qrcode?.content || '';
  if (el.type === 'image') return el.src ? '（图片，已内嵌）' : '（图片，空）';
  if (el.type === 'line') return `(${el.x},${el.y}) → (${el.x2},${el.y2})`;
  if (el.type === 'table') return `${el.rows}×${el.cols} 表格`;
  return el.text || '';
}

const fmt = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(1) : '-');
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escapeAttr = (s) => escapeHtml(s).replace(/`/g, '&#96;');

// ---------------------------------------------------------------------------
// 载入画布 / 保存
// ---------------------------------------------------------------------------
function loadIntoCanvas() {
  const tpl = state.result?.template;
  if (!tpl) return;
  store.loadTemplate(JSON.parse(JSON.stringify(tpl)));
  resetCurrentTemplateId();
  const nameEl = $('tpl-name');
  if (nameEl) nameEl.value = 'AI 生成标签';
  toast('已载入画布，可继续手动微调', 'success');
  window.dispatchEvent(new CustomEvent('goto-tab', { detail: 'design' }));
}

async function saveToLibrary() {
  const tpl = state.result?.template;
  if (!tpl) return;
  const nameEl = $('tpl-name');
  const name = (nameEl?.value || '').trim() || 'AI 生成标签';
  try {
    const r = await api.saveAiTemplate({ template: tpl, name, category: 'AI 生成' });
    toast(`已保存到模板库（#${r.id}）`, 'success');
  } catch (e) {
    toast('保存失败：' + e.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// AI 模型配置
// ---------------------------------------------------------------------------
async function loadModels() {
  const host = $('ai-model-list');
  if (!host) return;
  try {
    const rows = await api.listAiModels();
    if (!rows?.length) {
      host.textContent = '未配置（将使用本地规则引擎 / 环境变量 OPENAI_API_KEY）';
      return;
    }
    host.innerHTML = rows
      .map((m) => `<div class="ai-model-row">
        <b>${escapeHtml(m.name)}</b>
        <span>${escapeHtml(m.modelId)}</span>
        <span class="ai-chip">${m.isDefault ? '默认' : ''}</span>
        <span class="ai-model-key">${m.apiKeySet ? '密钥已配置' : '无密钥'}</span>
      </div>`)
      .join('');
  } catch (e) {
    host.textContent = '模型列表加载失败：' + e.message;
  }
}

async function saveModel() {
  const endpoint = $('ai-model-endpoint').value.trim();
  const modelId = $('ai-model-id').value.trim();
  const apiKey = $('ai-model-key').value.trim();
  if (!endpoint || !modelId || !apiKey) {
    toast('请填写接口地址、模型名和 API Key', 'error');
    return;
  }
  try {
    await api.createAiModel({
      name: modelId,
      provider: 'openai',
      apiEndpoint: endpoint,
      modelId,
      apiKey,
      isDefault: true,
    });
    $('ai-model-key').value = '';
    toast('模型已保存为默认', 'success');
    loadModels();
  } catch (e) {
    toast('保存模型失败：' + e.message, 'error');
  }
}
