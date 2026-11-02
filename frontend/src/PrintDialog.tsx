// =============================================================================
// PrintPanel —— 打印面板（非模态，可嵌入 Tab）
// 同时 PrintDialog 复用它作为 modal 内容
// =============================================================================

import { useState, useEffect, useMemo, useRef } from 'react';
import { useDesignerStore } from '../designer/store';
import { api } from './api';

export function PrintPanel() {
  const template = useDesignerStore((s) => s.toJSON());
  const page = useDesignerStore((s) => s.template.page);
  const [rowsText, setRowsText] = useState('{"sku":"SKU-001","productName":"测试商品","price":99}\n{"sku":"SKU-002","productName":"另一条","price":199}');
  const [copies, setCopies] = useState(1);
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => { void doPreview(); }, []);

  const rows = useMemo(() => {
    try {
      const trimmed = rowsText.trim();
      if (!trimmed) return [{}];
      if (trimmed.startsWith('[')) return JSON.parse(trimmed);
      return trimmed.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
    } catch { return null as any; }
  }, [rowsText]);

  const doPreview = async () => {
    setPreview({ status: 'loading' });
    try {
      const rowsArr = Array.isArray(rows) ? rows : [{}];
      const res = await api.preview({
        templateContent: template,
        rows: rowsArr,
        copies: Math.max(1, copies | 0),
      });
      const data = (res as any).data ?? res;
      setPreview({
        status: 'ready', html: data.html, labelCount: data.labelCount,
        widthMm: data.widthMm, heightMm: data.heightMm,
      });
    } catch (e: any) {
      setPreview({ status: 'error', message: e?.message ?? '预览失败' });
    }
  };

  // HTML → iframe（单一 DOM 源）
  useEffect(() => {
    if (preview.status !== 'ready') return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    const doc = iframe.contentDocument;
    if (!doc) return;
    doc.open(); doc.write((preview as any).html); doc.close();
  }, [preview.status === 'ready' ? (preview as any).html : null]);

  const print = () => {
    const iframe = iframeRef.current;
    if (!iframe || !iframe.contentWindow) { alert('预览还没好'); return; }
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
  };

  const downloadHtml = () => {
    if (preview.status !== 'ready') return;
    const blob = new Blob([(preview as any).html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${page.widthMm}x${page.heightMm}mm-label.html`;
    a.click(); URL.revokeObjectURL(url);
  };

  const importCsv = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const lines = String(reader.result || '').split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) { setRowsText(String(reader.result || '')); return; }
      const header = lines[0].split(/[,\t;]/).map((s) => s.trim());
      const arr = lines.slice(1).map((line) => {
        const vals = line.split(/[,\t;]/);
        const obj: any = {};
        header.forEach((h, i) => obj[h] = vals[i] ?? '');
        return obj;
      });
      setRowsText(arr.map((o) => JSON.stringify(o)).join('\n'));
    };
    reader.readAsText(file);
  };

  const labelCount = (preview as any).labelCount ?? (Array.isArray(rows) ? rows.length * copies : copies);

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden', background: '#f0f0f0' }}>
      {/* 左侧控制面板 */}
      <div style={{
        width: 280, background: '#fff', borderRight: '1px solid #e4e4e4',
        padding: 12, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#333' }}>🖨️ 打印 & 预览</div>
        <div style={{ fontSize: 10, color: '#888', lineHeight: 1.6 }}>
          模板: {page.widthMm}×{page.heightMm} mm · {page.dpi} dpi<br />
          标签数: {labelCount}
        </div>

        <div>
          <div style={SCTITLE}>数据源（JSONL / CSV）</div>
          <textarea style={{ ...TEXTarea, height: 100 }}
            value={rowsText}
            onChange={(e) => setRowsText(e.target.value)}
            placeholder={'{"sku":"SKU-001","name":"商品A"}\n{"sku":"SKU-002","name":"商品B"}'}
          />
          {!Array.isArray(rows) && <div style={ERR}>⚠ JSON 解析失败</div>}
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <button style={BTNMINOR} onClick={() => {
              const input = document.createElement('input');
              input.type = 'file'; input.accept = '.csv,.txt,.json';
              input.onchange = () => input.files?.[0] && importCsv(input.files[0]);
              input.click();
            }}>📁 导入 CSV</button>
            <button style={BTNMINOR} onClick={() => setRowsText('{}')}>单张</button>
            <button style={BTNMINOR} onClick={doPreview}>🔄</button>
          </div>
        </div>

        <div>
          <div style={SCTITLE}>打印参数</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            份数
            <input type="number" min={1} value={copies}
              onChange={(e) => setCopies(+e.target.value)}
              style={{ width: 50, padding: '3px 5px', border: '1px solid #d9d9d9', borderRadius: 3 }} />
          </label>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
          <button style={{ ...BTNPRIMARY, opacity: preview.status === 'ready' ? 1 : 0.5 }}
            disabled={preview.status !== 'ready'}
            onClick={print}>🖨️ 打印（浏览器对话框）</button>
          <button style={BTNMINOR} disabled={preview.status !== 'ready'}
            onClick={downloadHtml}>⬇ 下载 HTML</button>
        </div>
      </div>

      {/* 右侧预览区 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#2b2b2b', padding: 16, overflow: 'auto' }}>
        {preview.status === 'loading' && <div style={LOADING}>⏳ 渲染中...</div>}
        {preview.status === 'error' && <div style={ERRBOX}>❌ {preview.message}</div>}
        {preview.status === 'idle' && <div style={LOADING}>点 🔄 刷新预览</div>}
        {preview.status === 'ready' && (
          <iframe
            ref={iframeRef}
            title="print-preview"
            style={{ flex: 1, width: '100%', border: 'none', background: '#fff', borderRadius: 4 }}
          />
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// PrintDialog —— 包装 PrintPanel 成 modal（保留向后兼容）
// -----------------------------------------------------------------------------
export function PrintDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      zIndex: 9999, display: 'flex', flexDirection: 'column',
    }} onClick={onClose}>
      <div style={{
        margin: 'auto', width: '85vw', height: '85vh',
        background: '#fff', borderRadius: 8, overflow: 'hidden',
        display: 'flex', flexDirection: 'column', boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{
          padding: '10px 16px', borderBottom: '1px solid #e4e4e4',
          display: 'flex', alignItems: 'center', gap: 12, background: '#fafafa',
        }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>🖨️ 打印预览</span>
          <span style={{ fontSize: 10, color: '#888' }}>（和主 Tab 同样功能，modal 仅作备选）</span>
          <div style={{ marginLeft: 'auto' }}>
            <button onClick={onClose}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 18, color: '#888' }}>✕</button>
          </div>
        </div>
        <PrintPanel />
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// 类型 & 样式
// -----------------------------------------------------------------------------
interface PreviewState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  html?: string; labelCount?: number; widthMm?: number; heightMm?: number;
  message?: string;
}

const SCTITLE: React.CSSProperties = { fontSize: 10, fontWeight: 600, color: '#2979ff', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 };
const TEXTarea: React.CSSProperties = { fontFamily: 'monospace', fontSize: 11, padding: 8, border: '1px solid #d9d9d9', borderRadius: 3, resize: 'vertical', background: '#fafafa', outline: 'none', width: '100%', boxSizing: 'border-box' };
const BTNPRIMARY: React.CSSProperties = { padding: '10px 16px', background: '#2979ff', color: '#fff', border: 'none', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const BTNMINOR: React.CSSProperties = { padding: '6px 10px', background: '#fff', border: '1px solid #d9d9d9', borderRadius: 3, fontSize: 11, cursor: 'pointer' };
const ERR: React.CSSProperties = { color: '#ff4d4f', fontSize: 10, marginTop: 2 };
const ERRBOX: React.CSSProperties = { padding: 40, color: '#ff4d4f', fontSize: 13, textAlign: 'center' };
const LOADING: React.CSSProperties = { padding: 40, color: '#bbb', fontSize: 13, textAlign: 'center' };
