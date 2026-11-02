// =============================================================================
// PageSettingsPanel.tsx —— 页面设置面板
// 标签尺寸 / 方向 / DPI / 多联（行列）/ 间距 / 边距 / 副本 / 双面
// 所有对外 mm，内部由 print engine 按 dpi 换算点阵
// =============================================================================

import { useDesignerStore } from '../designer/store';

export function PageSettingsPanel() {
  const page = useDesignerStore((s) => s.template.page);
  const setPage = useDesignerStore((s) => s.setPage);

  const set = (patch: any) => setPage(patch);

  const presets: { name: string; w: number; h: number; dpi: number }[] = [
    { name: '20×10mm 条码小标', w: 20, h: 10, dpi: 203 },
    { name: '30×15mm 物品标签', w: 30, h: 15, dpi: 203 },
    { name: '40×20mm SKU', w: 40, h: 20, dpi: 203 },
    { name: '50×25mm 物流标', w: 50, h: 25, dpi: 203 },
    { name: '60×40mm 商品价签', w: 60, h: 40, dpi: 203 },
    { name: '80×50mm 吊牌', w: 80, h: 50, dpi: 300 },
    { name: '100×70mm 大标签', w: 100, h: 70, dpi: 300 },
    { name: '100×100mm 圆标基', w: 100, h: 100, dpi: 300 },
    { name: 'A4 整页', w: 210, h: 297, dpi: 300 },
  ];

  const applyPreset = (p: typeof presets[number]) => {
    set({ widthMm: p.w, heightMm: p.h, dpi: p.dpi });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#2979ff', marginBottom: 6 }}>快速预设</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {presets.map((p) => (
            <button key={p.name}
              onClick={() => applyPreset(p)}
              style={{
                padding: '3px 6px', fontSize: 10, border: '1px solid #d9d9d9', borderRadius: 3,
                background: 'transparent', cursor: 'pointer', textAlign: 'left',
              }}>{p.name}</button>
          ))}
        </div>
      </div>

      <Group title="标签尺寸">
        <Row>
          <Field label="宽 (mm)" value={page.widthMm} onChange={(v) => set({ widthMm: Math.max(1, v) })} step={1} />
          <Field label="高 (mm)" value={page.heightMm} onChange={(v) => set({ heightMm: Math.max(1, v) })} step={1} />
        </Row>
        <div style={{ fontSize: 10, color: '#888', marginTop: 2 }}>
          点数: {(page.widthMm / 25.4 * page.dpi).toFixed(0)} × {(page.heightMm / 25.4 * page.dpi).toFixed(0)} dots
        </div>
      </Group>

      <Group title="打印机">
        <Row>
          <label style={labelStyle}>DPI</label>
          <select style={inputStyle} value={page.dpi}
            onChange={(e) => set({ dpi: +e.target.value })}>
            <option value={203}>203 dpi (8 dots/mm)</option>
            <option value={300}>300 dpi (11.81 dots/mm)</option>
            <option value={600}>600 dpi (23.62 dots/mm)</option>
          </select>
        </Row>
        <Row>
          <label style={labelStyle}>方向</label>
          <select style={inputStyle} value={page.orientation}
            onChange={(e) => {
              const or = +e.target.value as any;
              set({ orientation: or });
              if (or === 90 || or === 270) {
                const tmp = page.widthMm;
                set({ widthMm: page.heightMm, heightMm: tmp });
              }
            }}>
            <option value={0}>纵向 0°</option>
            <option value={90}>横向 90°</option>
            <option value={180}>反向 180°</option>
            <option value={270}>反向 270°</option>
          </select>
        </Row>
        <Row>
          <label style={labelStyle}>单位</label>
          <span style={{ fontSize: 11, color: '#888' }}>毫米 (mm)</span>
        </Row>
      </Group>

      <Group title="多联 / 排版（每页多张标签）">
        <Row>
          <Field label="列" value={page.columns ?? 1} onChange={(v) => set({ columns: Math.max(1, Math.round(v)) })} />
          <Field label="行" value={page.rows ?? 1} onChange={(v) => set({ rows: Math.max(1, Math.round(v)) })} />
        </Row>
        <Row>
          <Field label="列间距 (mm)" value={page.gapXMm ?? 2} onChange={(v) => set({ gapXMm: v })} step={0.5} />
          <Field label="行间距 (mm)" value={page.gapYMm ?? 2} onChange={(v) => set({ gapYMm: v })} step={0.5} />
        </Row>
        <Row>
          <Field label="边距 (mm)" value={page.marginMm ?? 0} onChange={(v) => set({ marginMm: Math.max(0, v) })} step={0.5} />
        </Row>
      </Group>

      <Group title="打印">
        <Row>
          <Field label="份数" value={page.copies ?? 1} onChange={(v) => set({ copies: Math.max(1, Math.round(v)) })} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, marginLeft: 12 }}>
            <input type="checkbox" checked={!!page.duplex}
              onChange={(e) => set({ duplex: e.target.checked })} />
            双面打印
          </label>
        </Row>
      </Group>
    </div>
  );
}

// --- 复用组件 (同 PropertyPanel) ---
function Group({ title, children }: any) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#2979ff', paddingBottom: 4, borderBottom: '1px solid #eef3ff', marginBottom: 6 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </div>
  );
}
function Row({ children }: any) { return <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>{children}</div>; }
function Field({ label, value, onChange, step }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (<><label style={labelStyle}>{label}</label>
    <input style={{ ...inputStyle, width: 64 }} type="number" step={step} value={value} onChange={(e) => onChange(+e.target.value)} /></>);
}
const labelStyle: React.CSSProperties = { fontSize: 11, color: '#555', width: 78 };
const inputStyle: React.CSSProperties = { border: '1px solid #d9d9d9', borderRadius: 3, padding: '3px 5px', fontSize: 12, outline: 'none', background: '#fff' };
