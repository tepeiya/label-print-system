// =============================================================================
// App.tsx —— 专业标签设计器主界面（三栏布局）
// 左工具箱 | 中画布 + 缩放 + 状态栏 | 右属性/页面/变量多标签面板
// =============================================================================

import { useEffect, useState, useCallback } from 'react';
import { useDesignerStore, newElementId, DEFAULT_FONT, BARCODE_SYMS, QRCODE_SYMS } from '../designer/store';
import { DesignerView } from './DesignerView';
import { PropertyPanel } from './PropertyPanel';
import { PageSettingsPanel } from './PageSettingsPanel';
import { VariablesPanel } from './VariablesPanel';
import { PrintPanel, PrintDialog } from './PrintDialog';
import { api } from './api';
import { handleKey } from '../designer/interactions';
import type { AnyElement } from '../designer/types';

type RightTab = 'properties' | 'page' | 'variables';

export function App() {
  // —— 订阅 store（精确 selector，避免全量重渲染） ——
  const elements = useDesignerStore((s) => s.template.elements);
  const page = useDesignerStore((s) => s.template.page);
  const variables = useDesignerStore((s) => s.template.variables);
  const selectedIds = useDesignerStore((s) => s.selectedIds);
  const scale = useDesignerStore((s) => s.scale);

  const addElement = useDesignerStore((s) => s.addElement);
  const removeElements = useDesignerStore((s) => s.removeElements);
  const select = useDesignerStore((s) => s.select);
  const duplicateSelected = useDesignerStore((s) => s.duplicateSelected);

  const setScale = useDesignerStore((s) => s.setScale);
  const zoomIn = useDesignerStore((s) => s.zoomIn);
  const zoomOut = useDesignerStore((s) => s.zoomOut);
  const zoomFit = useDesignerStore((s) => s.zoomFit);
  const zoomOne = useDesignerStore((s) => s.zoomOne);

  const undo = useDesignerStore((s) => s.undo);
  const redo = useDesignerStore((s) => s.redo);
  const history = useDesignerStore((s) => s.history);
  const future = useDesignerStore((s) => s.future);

  const bringForward = useDesignerStore((s) => s.bringForward);
  const sendBackward = useDesignerStore((s) => s.sendBackward);
  const bringToFront = useDesignerStore((s) => s.bringToFront);
  const sendToBack = useDesignerStore((s) => s.sendToBack);

  const toJSON = useDesignerStore((s) => s.toJSON);

  const [rightTab, setRightTab] = useState<RightTab>('properties');
  const [templateName, setTemplateName] = useState('未命名标签');
  // 三个主 Tab：design（设计器）/ print（打印预览）/ templates（模板列表）
  const [mainTab, setMainTab] = useState<'design' | 'print' | 'templates'>('design');

  // —— dev 模式自动登录（确保预览/保存/打印都能调 API） ——
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) return;
    api.login('admin', 'admin123').then((r: any) => {
      localStorage.setItem('token', r.accessToken);
    }).catch(() => { /* 后端未启动时静默 */ });
  }, []);

  // —— 全局键盘 ——
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl/Cmd+S 保存
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault(); save(); return;
      }
      // Ctrl+D 复制
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault(); duplicateSelected(); return;
      }
      // Ctrl+A 全选
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault(); select(elements.map(e => e.id)); return;
      }
      // Ctrl+G 网格切换占位
      handleKey(e);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [elements, select, duplicateSelected]);

  const save = useCallback(async () => {
    try {
      await api.saveTemplate({ name: templateName, content: toJSON() });
      alert(`模板 "${templateName}" 已保存到后端 ✓`);
    } catch (e: any) {
      alert('保存失败: ' + (e?.message ?? e));
    }
  }, [templateName, toJSON]);

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(toJSON(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${templateName}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const zoomPct = Math.round(scale * 100);
  const selected = selectedIds.length > 0
    ? elements.find((e) => e.id === selectedIds[0])
    : null;

  // =============================================================================
  return (
    <div style={{ ...LAYOUT.root }}>
      {/* --------------------------- 主工具栏 --------------------------- */}
      <div style={TOOLBAR.container}>
        <div style={TOOLBAR.group}>
          <span style={{ fontSize: 13, fontWeight: 600, marginRight: 8 }}>LabelFlow</span>
          <input
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            style={TOOLBAR.nameInput}
          />
        </div>

        <Divider />

        <div style={TOOLBAR.group}>
          <ToolbarBtn onClick={undo} disabled={history.length === 0} title="撤销 (Ctrl+Z)">↶ 撤销</ToolbarBtn>
          <ToolbarBtn onClick={redo} disabled={future.length === 0} title="重做 (Ctrl+Shift+Z)">↷ 重做</ToolbarBtn>
        </div>

        <Divider />

        <div style={TOOLBAR.group}>
          <ToolbarBtn onClick={() => bringForward()} title="上移一层 (Ctrl+])">↑</ToolbarBtn>
          <ToolbarBtn onClick={() => sendBackward()} title="下移一层 (Ctrl+[)">↓</ToolbarBtn>
          <ToolbarBtn onClick={() => bringToFront()} title="置顶">⇈</ToolbarBtn>
          <ToolbarBtn onClick={() => sendToBack()} title="置底">⇊</ToolbarBtn>
        </div>

        <Divider />

        <div style={TOOLBAR.group}>
          <ToolbarBtn onClick={zoomOut} title="缩小 (-)">A-</ToolbarBtn>
          <span style={{ minWidth: 50, textAlign: 'center', fontSize: 12, fontFamily: 'monospace' }}>
            {zoomPct}%
          </span>
          <ToolbarBtn onClick={zoomIn} title="放大 (+)">A+</ToolbarBtn>
          <ToolbarBtn onClick={zoomOne} title="100%">1:1</ToolbarBtn>
          <ToolbarBtn onClick={zoomFit} title="适配">□</ToolbarBtn>
        </div>

        <div style={{ flex: 1 }} />

        <div style={TOOLBAR.group}>
          <ToolbarBtn onClick={exportJSON} title="导出 JSON">⤓ 导出</ToolbarBtn>
          <ToolbarBtn primary onClick={() => setMainTab('print')} title="打印 / 预览">🖨️ 打印</ToolbarBtn>
          <ToolbarBtn primary onClick={save} title="保存到后端 (Ctrl+S)">💾 保存模板</ToolbarBtn>
        </div>
      </div>

      {/* --------------------------- 主 Tab 切换（和工具栏同级） --------------------------- */}
      <div style={MAINTAB.container}>
        {[
          ['design', '✏️ 标签设计'],
          ['print', '🖨️ 打印预览'],
          ['templates', '📚 模板管理'],
        ].map(([key, label]) => (
          <div key={key}
            onClick={() => setMainTab(key as any)}
            style={{
              ...MAINTAB.tab,
              background: mainTab === key ? '#fff' : 'transparent',
              color: mainTab === key ? '#2979ff' : '#555',
              borderTop: mainTab === key ? '2px solid #2979ff' : '2px solid transparent',
            }}>
            {label}
          </div>
        ))}
      </div>

      {/* --------------------------- 主内容 --------------------------- */}
      {mainTab === 'design' ? (
        <div style={LAYOUT.main}>
          {/* 左侧工具箱 */}
          <div style={TOOLBOX.container}>
            <div style={TOOLBOX.sectionTitle}>基本图形</div>
            <ToolBtn label="文本" icon="T" onClick={() => addElement(newText())} />
            <ToolBtn label="线条" icon="/" onClick={() => addElement(newLine())} />
            <ToolBtn label="矩形" icon="▭" onClick={() => addElement(newRect())} />
            <ToolBtn label="椭圆" icon="◯" onClick={() => addElement(newEllipse())} />
            <ToolBtn label="表格" icon="⊞" onClick={() => addElement(newTable())} />
            <ToolBtn label="图片" icon="🖼" onClick={() => addElement(newImage())} />

            <div style={{ ...TOOLBOX.sectionTitle, marginTop: 16 }}>条码二维码</div>
            <ToolBtn label="一维码" icon="▮▮" onClick={() => addElement(newBarcode())} />
            <ToolBtn label="二维码" icon="▦" onClick={() => addElement(newQrcode())} />

            <div style={{ ...TOOLBOX.sectionTitle, marginTop: 16 }}>动态字段</div>
            <ToolBtn label="公式" icon="fx" onClick={() => addElement(newFormula())} />
            <ToolBtn label="流水号" icon="#" onClick={() => addElement(newSerial())} />
            <ToolBtn label="日期" icon="📅" onClick={() => addElement(newDateTime())} />
            <ToolBtn label="系统变量" icon="{SYS}" onClick={() => addElement(newSysvar())} />
          </div>

          {/* 中央画布 */}
          <div style={LAYOUT.canvasWrap} ref={(el) => {
            if (el) {
              // 给 Konva 生成的 .konvajs-content + canvas 强制提升层级，盖过右侧 PANEL
              const inner = el.querySelector('.konvajs-content');
              if (inner) {
                (inner as HTMLElement).style.position = 'relative';
                (inner as HTMLElement).style.zIndex = '999';
              }
            }
          }}>
            <DesignerView />
          </div>

          {/* 右侧面板 */}
          <div style={PANEL.container}>
            <div style={PANEL.tabs}>
              {([
                ['properties', `属性`],
                ['page', '页面'],
                ['variables', `变量 (${variables.length})`],
              ] as [RightTab, string][]).map(([key, label]) => (
                <div key={key} onClick={() => setRightTab(key)} style={{
                  ...PANEL.tab,
                  background: rightTab === key ? '#2979ff' : 'transparent',
                  color: rightTab === key ? '#fff' : '#555',
                  borderBottom: rightTab === key ? '2px solid #2979ff' : '2px solid transparent',
                }}>{label}</div>
              ))}
            </div>
            <div style={PANEL.body}>
              {rightTab === 'properties' && <PropertyPanel />}
              {rightTab === 'page' && <PageSettingsPanel />}
              {rightTab === 'variables' && <VariablesPanel />}
            </div>
          </div>
        </div>
      ) : mainTab === 'print' ? (
        <PrintTabView />
      ) : (
        <TemplateTabView />
      )}

      {/* --------------------------- 状态栏 --------------------------- */}
      <div style={STATUS.container}>
        <span>
          选中: {selectedIds.length === 0 ? '无' :
            selectedIds.length === 1 ? `${selected?.type} (${selected?.w?.toFixed?.(1) ?? ''}×${selected?.h?.toFixed?.(1) ?? ''}mm)` :
            `${selectedIds.length} 个元素`}
        </span>
        <span>  |  </span>
        <span>元素总数: {elements.length}</span>
        <span>  |  </span>
        <span>画布: {page.widthMm} × {page.heightMm} mm · {page.dpi} dpi</span>
        <span>  |  </span>
        <span style={{ marginLeft: 'auto' }}>空格+拖拽 = 平移画布  ·  缩放: {zoomPct}%</span>
      </div>
    </div>
  );
}

// =============================================================================
// PrintTabView / TemplateTabView —— 主 Tab 内容组件
// =============================================================================
function PrintTabView() {
  return <PrintPanel />;
}

function TemplateTabView() {
  return (
    <div style={{
      flex: 1, background: '#fff', padding: 24, overflow: 'auto',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      color: '#888', fontSize: 13, gap: 8,
    }}>
      <div style={{ fontSize: 48 }}>📚</div>
      <div style={{ fontSize: 16, color: '#333', fontWeight: 600 }}>模板管理（开发中）</div>
      <div style={{ textAlign: 'center', lineHeight: 1.6, maxWidth: 400 }}>
        切换到 <b>✏️ 标签设计</b> Tab 设计标签，然后点 <b>💾 保存模板</b> 入库。<br />
        保存后可在此列出、重命名、导入导出、版本回滚。
      </div>
    </div>
  );
}

// =============================================================================
// UI 小组件
// =============================================================================
function ToolbarBtn({ children, onClick, disabled, title, primary }: any) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      style={{
        padding: '4px 10px', borderRadius: 4, border: '1px solid transparent',
        background: primary ? '#2979ff' : 'transparent',
        color: primary ? '#fff' : disabled ? '#bbb' : '#333',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 12, fontWeight: primary ? 600 : 400,
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={(e: any) => { if (!primary && !disabled) e.currentTarget.style.background = '#eef3ff'; }}
      onMouseLeave={(e: any) => { if (!primary) e.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div style={{ width: 1, height: 20, background: '#e0e0e0', margin: '0 6px' }} />;
}

function ToolBtn({ label, icon, onClick }: { label: string; icon: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
      padding: '10px 4px', border: '1px solid transparent', borderRadius: 6,
      background: 'transparent', cursor: 'pointer', width: 60,
    }}
      onMouseEnter={(e: any) => { e.currentTarget.style.background = '#eef3ff'; e.currentTarget.style.border = '1px solid #c6d6ff'; }}
      onMouseLeave={(e: any) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.border = '1px solid transparent'; }}>
      <span style={{ fontSize: 20, lineHeight: 1, color: '#2979ff' }}>{icon}</span>
      <span style={{ fontSize: 11, color: '#333' }}>{label}</span>
    </button>
  );
}

function SectionTitle({ children, style }: any) {
  return <div style={{ fontSize: 10, fontWeight: 600, color: '#888', letterSpacing: 1, textTransform: 'uppercase', ...style }}>{children}</div>;
}

// =============================================================================
// 默认元素工厂 —— 所有尺寸 mm
// =============================================================================
function newText(): AnyElement {
  const s = useDesignerStore.getState();
  return {
    id: newElementId(), type: 'text', name: '文本',
    x: 5, y: 5, w: 40, h: 7, rotation: 0,
    zIndex: s.template.elements.length + 1,
    text: '双击编辑文本',
    font: { ...DEFAULT_FONT, size: 10, align: 'left', wrap: true },
  } as AnyElement;
}

function newLine(): AnyElement {
  const s = useDesignerStore.getState();
  return {
    id: newElementId(), type: 'line', name: '线条',
    x: 5, y: 5, w: 0, h: 0, rotation: 0,
    zIndex: s.template.elements.length + 1,
    x2: 25, y2: 5,
    stroke: { width: 0.5, color: '#333', style: 'solid' },
  } as AnyElement;
}

function newRect(): AnyElement {
  const s = useDesignerStore.getState();
  return {
    id: newElementId(), type: 'rect', name: '矩形',
    x: 5, y: 5, w: 30, h: 20, rotation: 0,
    zIndex: s.template.elements.length + 1,
    fill: '#ffffff',
    stroke: { width: 0.5, color: '#333', style: 'solid' },
    cornerRadius: 0,
  } as AnyElement;
}

function newEllipse(): AnyElement {
  const s = useDesignerStore.getState();
  return {
    id: newElementId(), type: 'ellipse', name: '椭圆',
    x: 5, y: 5, w: 20, h: 15, rotation: 0,
    zIndex: s.template.elements.length + 1,
    fill: '#ffe6b3',
    stroke: { width: 0.5, color: '#fa8c16', style: 'solid' },
  } as AnyElement;
}

function newTable(): AnyElement {
  const s = useDesignerStore.getState();
  const rows = 3, cols = 3;
  return {
    id: newElementId(), type: 'table', name: '表格',
    x: 5, y: 5, w: 50, h: 25, rotation: 0,
    zIndex: s.template.elements.length + 1,
    rows, cols,
    cells: Array.from({ length: rows * cols }, (_, i) => i < cols ? `表头${i + 1}` : `单元格${i + 1}`),
    showBorder: true, borderWidth: 0.3, borderColor: '#333',
    headerRow: true, headerBg: '#f5f5f5',
    font: { family: 'Arial', size: 8, color: '#333', bold: false, align: 'center' },
  } as AnyElement;
}

function newImage(): AnyElement {
  const s = useDesignerStore.getState();
  return {
    id: newElementId(), type: 'image', name: '图片',
    x: 5, y: 5, w: 30, h: 30, rotation: 0,
    zIndex: s.template.elements.length + 1,
    src: '',
  } as AnyElement;
}

function newBarcode(): AnyElement {
  const s = useDesignerStore.getState();
  return {
    id: newElementId(), type: 'barcode', name: '一维码',
    x: 5, y: 5, w: 55, h: 15, rotation: 0,
    zIndex: s.template.elements.length + 1,
    barcode: { sym: 'CODE128', content: '{{sku}}', moduleWidthMm: 0.25, wideRatio: 2.5, heightMm: 12, showText: true, textPosition: 'bottom', checksum: true },
  } as AnyElement;
}

function newQrcode(): AnyElement {
  const s = useDesignerStore.getState();
  return {
    id: newElementId(), type: 'qrcode', name: '二维码',
    x: 5, y: 5, w: 20, h: 20, rotation: 0,
    zIndex: s.template.elements.length + 1,
    qrcode: { sym: 'QRCODE', content: '{{sku}}', ecc: 'M', moduleSizeMm: 0.5, quietZoneMm: 2 },
  } as AnyElement;
}

function newFormula(): AnyElement {
  const s = useDesignerStore.getState();
  return {
    id: newElementId(), type: 'formula', name: '公式',
    x: 5, y: 5, w: 40, h: 7, rotation: 0,
    zIndex: s.template.elements.length + 1,
    formula: { expr: '{{price}} * 1.13', defaultOnError: '—' },
    font: { family: 'Arial', size: 10, color: '#531dab', bold: false, align: 'left' },
  } as AnyElement;
}

function newSerial(): AnyElement {
  const s = useDesignerStore.getState();
  return {
    id: newElementId(), type: 'serial', name: '流水号',
    x: 5, y: 5, w: 20, h: 7, rotation: 0,
    zIndex: s.template.elements.length + 1,
    serial: { sequenceRef: 'default', digits: 6, prefix: '', suffix: '' },
    font: { family: 'Consolas', size: 10, color: '#13c2c2', bold: true, align: 'center' },
  } as AnyElement;
}

function newDateTime(): AnyElement {
  const s = useDesignerStore.getState();
  return {
    id: newElementId(), type: 'datetime', name: '日期时间',
    x: 5, y: 5, w: 35, h: 7, rotation: 0,
    zIndex: s.template.elements.length + 1,
    datetime: { pattern: 'YYYY-MM-DD HH:mm', source: 'print' },
    font: { family: 'Arial', size: 9, color: '#666', bold: false, align: 'left' },
  } as AnyElement;
}

function newSysvar(): AnyElement {
  const s = useDesignerStore.getState();
  return {
    id: newElementId(), type: 'sysvar', name: '系统变量',
    x: 5, y: 5, w: 30, h: 7, rotation: 0,
    zIndex: s.template.elements.length + 1,
    sysvar: { key: 'printDate' },
    font: { family: 'Arial', size: 9, color: '#666', bold: false, align: 'left' },
  } as AnyElement;
}

// =============================================================================
// 样式常量
// =============================================================================
const LAYOUT: Record<string, React.CSSProperties> = {
  root: { display: 'flex', flexDirection: 'column', height: '100vh', background: '#f7f7f7', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif', fontSize: 12, position: 'relative' as const, zIndex: 0 },
  main: { display: 'flex', flex: 1, overflow: 'hidden' as const, position: 'relative' as const },
  // ⚠️ 关键：canvasWrap 必须能容纳 Konva 的 canvas（400x300px 固定尺寸）
  // 且 z-index 必须盖过右侧 PANEL + 左侧 TOOLBOX
  canvasWrap: {
    flex: '1 0 auto',         // grow, don't shrink, basis=auto
    overflow: 'auto' as const,
    padding: 12,
    background: '#e8e8e8',
    position: 'relative' as const,
    zIndex: 100,
    minWidth: 424,            // 400 canvas + 2*12 padding
    minHeight: 324,           // 300 canvas + 2*12 padding
  },
};

const TOOLBAR: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex', alignItems: 'center', padding: '6px 10px', gap: 4,
    background: '#fff', borderBottom: '1px solid #e4e4e4',
    boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
  },
  group: { display: 'flex', alignItems: 'center', gap: 2 },
  nameInput: {
    border: '1px solid transparent', padding: '4px 8px', borderRadius: 4,
    fontSize: 13, fontWeight: 600, minWidth: 160, outline: 'none' as const,
  },
};

const TOOLBOX: Record<string, React.CSSProperties> = {
  container: {
    width: 110, background: '#fff', borderRight: '1px solid #e4e4e4',
    padding: 10, display: 'flex', flexDirection: 'column', gap: 4,
    overflowY: 'auto' as const,
    flexShrink: 0,           // 不被挤压
    position: 'relative' as const, zIndex: 1,
  },
};

const PANEL: Record<string, React.CSSProperties> = {
  container: {
    width: 300, background: '#fff', borderLeft: '1px solid #e4e4e4',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    flexShrink: 0,           // 不被挤压
    position: 'relative' as const, zIndex: 1,
  },
  tabs: { display: 'flex', borderBottom: '1px solid #e4e4e4' },
  tab: {
    flex: 1, padding: '8px 4px', textAlign: 'center', cursor: 'pointer',
    fontSize: 12, userSelect: 'none' as const, transition: 'all 0.15s',
  },
  body: { flex: 1, overflowY: 'auto' as const, padding: 12 },
};

const STATUS: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex', alignItems: 'center', padding: '4px 12px',
    background: '#262626', color: '#d9d9d9', fontSize: 11,
    borderTop: '1px solid #1a1a1a',
    position: 'relative' as const, zIndex: 0,
    flexShrink: 0,
  },
};

const MAINTAB: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex', borderBottom: '1px solid #e4e4e4', background: '#fafafa',
    paddingLeft: 12,
  },
  tab: {
    padding: '8px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 500,
    borderTop: '2px solid transparent', marginRight: 2,
  },
};
