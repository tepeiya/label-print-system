import { useDesignerStore } from '../designer/store';

export function PropertyPanel() {
  const selectedIds = useDesignerStore((s) => s.selectedIds);
  const elements = useDesignerStore((s) => s.template.elements);
  const update = useDesignerStore((s) => s.updateElement);
  const el = elements.find((e) => selectedIds.includes(e.id));
  if (!el) return <div style={{ padding: 16, color: '#999' }}>未选择元素</div>;

  const set = (patch: any) => update(el.id, patch);
  return (
    <div style={{ padding: 12, width: 260, borderLeft: '1px solid #eee' }}>
      <h4>{el.type} 属性</h4>
      <label>X(mm) <input value={el.x} onChange={(e) => set({ x: +e.target.value })} /></label><br />
      <label>Y(mm) <input value={el.y} onChange={(e) => set({ y: +e.target.value })} /></label><br />
      <label>宽(mm) <input value={el.w} onChange={(e) => set({ w: +e.target.value })} /></label><br />
      <label>高(mm) <input value={el.h} onChange={(e) => set({ h: +e.target.value })} /></label><br />
      <label>旋转 <select value={el.rotation} onChange={(e) => set({ rotation: +e.target.value })}>
        <option value={0}>0</option><option value={90}>90</option>
        <option value={180}>180</option><option value={270}>270</option>
      </select></label><br />
      {(el.type === 'text') && (
        <><label>文本 <input value={el.text} onChange={(e) => set({ text: e.target.value })} /></label><br />
        <label>字号 <input value={el.font?.size ?? 10} onChange={(e) => set({ font: { ...el.font, size: +e.target.value } })} /></label></>
      )}
      {el.type === 'barcode' && (
        <><label>内容 <input value={el.barcode.content} onChange={(e) => set({ barcode: { ...el.barcode, content: e.target.value } })} /></label><br />
        <label>模块宽(mm) <input value={el.barcode.moduleWidthMm} onChange={(e) => set({ barcode: { ...el.barcode, moduleWidthMm: +e.target.value } })} /></label></>
      )}
      <label><input type="checkbox" checked={!el.visible} onChange={(e) => set({ visible: !e.target.checked })} /> 不打印</label>
    </div>
  );
}
