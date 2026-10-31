import { useEffect } from 'react';
import { useDesignerStore } from '../designer/store';
import { handleKey } from '../designer/interactions';
import { DesignerView } from './DesignerView';
import { PropertyPanel } from './PropertyPanel';
import { api } from './api';

let uid = 1;
const newId = () => `el_${uid++}_${Date.now()}`;

export function App() {
  const store = useDesignerStore();
  const { template, setScale, undo, redo, addElement, removeElements, selectedIds } = store;

  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const addText = () => addElement({
    id: newId(), type: 'text', x: 5, y: 5, w: 40, h: 8, rotation: 0, zIndex: template.elements.length + 1,
    text: '双击编辑文本', font: { family: 'Arial', size: 12, color: '#000', align: 'left' },
  } as any);

  const addBarcode = () => addElement({
    id: newId(), type: 'barcode', x: 5, y: 20, w: 50, h: 12, rotation: 0, zIndex: template.elements.length + 1,
    barcode: { sym: 'CODE128', content: '{{sku}}', moduleWidthMm: 0.3, wideRatio: 2.5, heightMm: 12, showText: true, textPosition: 'bottom', checksum: true },
  } as any);

  const save = async () => {
    try { await api.saveTemplate({ name: '未命名模板', content: store.toJSON() }); alert('已保存到后端'); }
    catch (e: any) { alert('保存失败: ' + e.message); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ padding: 8, borderBottom: '1px solid #eee', display: 'flex', gap: 8 }}>
        <button onClick={addText}>+ 文本</button>
        <button onClick={addBarcode}>+ 条码</button>
        <button onClick={() => removeElements(selectedIds)}>删除</button>
        <button onClick={undo}>撤销</button>
        <button onClick={redo}>重做</button>
        <span>缩放</span>
        <input type="range" min={0.25} max={4} step={0.25} value={store.scale}
          onChange={(e) => setScale(+e.target.value)} />
        <button onClick={save} style={{ marginLeft: 'auto' }}>保存模板</button>
      </div>
      <div style={{ display: 'flex', flex: 1 }}>
        <div style={{ flex: 1, overflow: 'auto', padding: 16, background: '#f5f5f5' }}>
          <DesignerView />
        </div>
        <PropertyPanel />
      </div>
    </div>
  );
}
