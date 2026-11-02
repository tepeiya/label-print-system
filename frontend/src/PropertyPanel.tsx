// =============================================================================
// PropertyPanel.tsx —— 选中元素属性面板
// 通用属性 (位置/尺寸/旋转/层级/可见) + 类型专属表单
// =============================================================================

import { useDesignerStore } from '../designer/store';
import type { AnyElement, TextElement, LineElement, RectElement, EllipseElement, TableElement, ImageElement, BarcodeElement, QrcodeElement, FormulaElement, SerialElement, DateTimeElement, SysvarElement } from '../designer/types';

export function PropertyPanel() {
  const selectedIds = useDesignerStore((s) => s.selectedIds);
  const elements = useDesignerStore((s) => s.template.elements);
  const update = useDesignerStore((s) => s.updateElement);
  const remove = useDesignerStore((s) => s.removeElements);
  const dupe = useDesignerStore((s) => s.duplicateSelected);
  const el = elements.find((e) => selectedIds.includes(e.id));

  if (!el) {
    return (
      <div style={{ color: '#888', fontSize: 12, textAlign: 'center', padding: 20 }}>
        画布上点选元素以编辑属性<br />
        <span style={{ fontSize: 11, color: '#bbb' }}>多选元素仅显示通用属性</span>
      </div>
    );
  }

  const set = (patch: Partial<AnyElement>) => update(el.id, patch);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 操作行 */}
      <div style={{ display: 'flex', gap: 6 }}>
        <span style={{ flex: 1, fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 1 }}>
          {el.type} · {el.id.slice(-6)}
        </span>
        <button onClick={dupe} style={btnStyle}>复制</button>
        <button onClick={() => remove([el.id])} style={{ ...btnStyle, color: '#ff4d4f' }}>删除</button>
      </div>

      {/* —— 通用：位置 / 尺寸 —— */}
      <Group title="位置与尺寸">
        <Row>
          <Field label="X (mm)" value={el.x} onChange={(v) => set({ x: v })} step={0.5} />
          <Field label="Y (mm)" value={el.y} onChange={(v) => set({ y: v })} step={0.5} />
        </Row>
        <Row>
          <Field label="宽 (mm)" value={el.w} onChange={(v) => set({ w: v })} step={0.5} />
          <Field label="高 (mm)" value={el.h} onChange={(v) => set({ h: v })} step={0.5} />
        </Row>
        <Row>
          <label style={{ ...labelStyle, width: 64 }}>旋转</label>
          <select style={inputStyle} value={el.rotation}
            onChange={(e) => set({ rotation: +e.target.value as any })}>
            <option value={0}>0°</option>
            <option value={90}>90°</option>
            <option value={180}>180°</option>
            <option value={270}>270°</option>
          </select>
          <label style={{ ...labelStyle, width: 60, marginLeft: 8 }}>层级</label>
          <input style={{ ...inputStyle, width: 50 }} type="number" value={el.zIndex}
            onChange={(e) => set({ zIndex: +e.target.value })} />
        </Row>
      </Group>

      {/* —— 类型专属 —— */}
      {el.type === 'text' && <TextProps el={el as TextElement} set={set} />}
      {el.type === 'rect' && <RectProps el={el as RectElement} set={set} />}
      {el.type === 'ellipse' && <EllipseProps el={el as EllipseElement} set={set} />}
      {el.type === 'line' && <LineProps el={el as LineElement} set={set} />}
      {el.type === 'table' && <TableProps el={el as TableElement} set={set} />}
      {el.type === 'image' && <ImageProps el={el as ImageElement} set={set} />}
      {el.type === 'barcode' && <BarcodeProps el={el as BarcodeElement} set={set} />}
      {el.type === 'qrcode' && <QrcodeProps el={el as QrcodeElement} set={set} />}
      {el.type === 'formula' && <FormulaProps el={el as FormulaElement} set={set} />}
      {el.type === 'serial' && <SerialProps el={el as SerialElement} set={set} />}
      {el.type === 'datetime' && <DateTimeProps el={el as DateTimeElement} set={set} />}
      {el.type === 'sysvar' && <SysvarProps el={el as SysvarElement} set={set} />}

      {/* —— 通用：打印 —— */}
      <Group title="打印与可见">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={el.visible !== false}
            onChange={(e) => set({ visible: e.target.checked })} />
          打印输出
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={!!el.locked}
            onChange={(e) => set({ locked: e.target.checked })} />
          锁定位置（不可拖拽）
        </label>
        <Row>
          <label style={{ ...labelStyle, width: 80 }}>透明度</label>
          <input style={inputStyle} type="range" min={0} max={1} step={0.05}
            value={el.opacity ?? 1}
            onChange={(e) => set({ opacity: +e.target.value })} />
          <span style={{ fontSize: 11, width: 32 }}>{Math.round((el.opacity ?? 1) * 100)}%</span>
        </Row>
        <Row>
          <label style={{ ...labelStyle, width: 80 }}>打印条件</label>
          <input style={{ ...inputStyle, flex: 1 }}
            placeholder="如: {{quantity}} > 10"
            value={el.printIf ?? ''}
            onChange={(e) => set({ printIf: e.target.value })} />
        </Row>
      </Group>
    </div>
  );
}

// =============================================================================
// 各类型专属属性
// =============================================================================
type SetFn = (patch: Partial<AnyElement>) => void;

function TextProps({ el, set }: { el: TextElement; set: SetFn }) {
  const f = el.font ?? {};
  const upd = (patch: any) => set({ font: { ...f, ...patch } });
  return (
    <Group title="文本内容">
      <textarea style={{ ...inputStyle, height: 60, resize: 'vertical' }}
        value={el.text}
        onChange={(e) => set({ text: e.target.value })}
        placeholder="支持 {{变量名}} 占位" />

      <SubGroup title="字体">
        <Row>
          <label style={labelStyle}>字体</label>
          <select style={{ ...inputStyle, flex: 1 }} value={f.family ?? 'Arial'}
            onChange={(e) => upd({ family: e.target.value })}>
            {['Arial', 'Times New Roman', 'Courier New', 'SimSun', 'SimHei', 'Microsoft YaHei', 'Consolas', 'Georgia', 'Verdana'].map(x =>
              <option key={x}>{x}</option>)}
          </select>
        </Row>
        <Row>
          <Field label="字号 (pt)" value={f.size ?? 10}
            onChange={(v) => upd({ size: v })} step={0.5} />
          <Field label="字距" value={f.letterSpacing ?? 0}
            onChange={(v) => upd({ letterSpacing: v })} step={0.1} />
        </Row>
        <Row>
          <Toggle checked={!!f.bold} label="粗" onChange={(v) => upd({ bold: v })} />
          <Toggle checked={!!f.italic} label="斜" onChange={(v) => upd({ italic: v })} />
          <Toggle checked={!!f.underline} label="下划线" onChange={(v) => upd({ underline: v })} />
          <Toggle checked={!!f.wrap} label="自动换行" onChange={(v) => upd({ wrap: v })} />
        </Row>
        <Row>
          <label style={labelStyle}>颜色</label>
          <input type="color" style={inputStyle} value={f.color ?? '#000000'}
            onChange={(e) => upd({ color: e.target.value })} />
          <label style={{ ...labelStyle, marginLeft: 8 }}>对齐</label>
          <select style={inputStyle} value={f.align ?? 'left'}
            onChange={(e) => upd({ align: e.target.value })}>
            <option value="left">左</option>
            <option value="center">中</option>
            <option value="right">右</option>
          </select>
        </Row>
        <Row>
          <label style={labelStyle}>垂直</label>
          <select style={inputStyle} value={f.vAlign ?? 'top'}
            onChange={(e) => upd({ vAlign: e.target.value })}>
            <option value="top">顶</option>
            <option value="middle">中</option>
            <option value="bottom">底</option>
          </select>
        </Row>
      </SubGroup>
    </Group>
  );
}

function RectProps({ el, set }: { el: RectElement; set: SetFn }) {
  const s = el.stroke ?? { width: 0.5, color: '#333', style: 'solid' };
  return (
    <Group title="矩形样式">
      <Row>
        <label style={labelStyle}>填充色</label>
        <input type="color" style={inputStyle} value={el.fill ?? '#ffffff'}
          onChange={(e) => set({ fill: e.target.value })} />
        <label style={{ ...labelStyle, marginLeft: 8 }}>圆角(mm)</label>
        <input style={{ ...inputStyle, width: 60 }} type="number" step={0.25}
          value={el.cornerRadius ?? 0}
          onChange={(e) => set({ cornerRadius: +e.target.value })} />
      </Row>
      <StrokeFields stroke={s} onChange={(patch) => set({ stroke: { ...s, ...patch } })} />
    </Group>
  );
}

function EllipseProps({ el, set }: { el: EllipseElement; set: SetFn }) {
  const s = el.stroke ?? { width: 0.5, color: '#333', style: 'solid' };
  return (
    <Group title="椭圆样式">
      <Row>
        <label style={labelStyle}>填充色</label>
        <input type="color" style={inputStyle} value={el.fill ?? '#ffffff'}
          onChange={(e) => set({ fill: e.target.value })} />
      </Row>
      <StrokeFields stroke={s} onChange={(patch) => set({ stroke: { ...s, ...patch } })} />
    </Group>
  );
}

function LineProps({ el, set }: { el: LineElement; set: SetFn }) {
  const s = el.stroke;
  return (
    <Group title="直线">
      <Row>
        <Field label="终点 X (mm)" value={el.x2} onChange={(v) => set({ x2: v })} step={0.5} />
        <Field label="终点 Y (mm)" value={el.y2} onChange={(v) => set({ y2: v })} step={0.5} />
      </Row>
      <StrokeFields stroke={s} onChange={(patch) => set({ stroke: { ...s, ...patch } })} />
    </Group>
  );
}

function StrokeFields({ stroke, onChange }: { stroke: any; onChange: (p: any) => void }) {
  return (
    <>
      <Row>
        <Field label="线宽 (mm)" value={stroke.width} onChange={(v) => onChange({ width: v })} step={0.1} />
        <label style={{ ...labelStyle, marginLeft: 8 }}>线型</label>
        <select style={inputStyle} value={stroke.style}
          onChange={(e) => onChange({ style: e.target.value })}>
          <option value="solid">实线</option>
          <option value="dashed">虚线</option>
          <option value="dotted">点线</option>
        </select>
      </Row>
      <Row>
        <label style={labelStyle}>颜色</label>
        <input type="color" style={inputStyle} value={stroke.color}
          onChange={(e) => onChange({ color: e.target.value })} />
      </Row>
    </>
  );
}

function TableProps({ el, set }: { el: TableElement; set: SetFn }) {
  const f = el.font ?? { family: 'Arial', size: 9, color: '#000', bold: false, align: 'center' as const };
  return (
    <Group title="表格">
      <Row>
        <Field label="行" value={el.rows} onChange={(v) => set({ rows: Math.max(1, Math.round(v)) })} />
        <Field label="列" value={el.cols} onChange={(v) => set({ cols: Math.max(1, Math.round(v)) })} />
      </Row>
      <Row>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
          <input type="checkbox" checked={el.showBorder !== false}
            onChange={(e) => set({ showBorder: e.target.checked })} />
          显示表格线
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, marginLeft: 8 }}>
          <input type="checkbox" checked={!!el.headerRow}
            onChange={(e) => set({ headerRow: e.target.checked })} />
          首行为表头
        </label>
      </Row>
      {(el.headerRow || el.showBorder) && (
        <>
          {el.headerRow && (
            <Row>
              <label style={labelStyle}>表头底色</label>
              <input type="color" style={inputStyle} value={el.headerBg ?? '#f5f5f5'}
                onChange={(e) => set({ headerBg: e.target.value })} />
            </Row>
          )}
          {el.showBorder && (
            <Row>
              <Field label="线宽 (mm)" value={el.borderWidth ?? 1}
                onChange={(v) => set({ borderWidth: v })} step={0.1} />
              <label style={{ ...labelStyle, marginLeft: 8 }}>线色</label>
              <input type="color" style={inputStyle} value={el.borderColor ?? '#333'}
                onChange={(e) => set({ borderColor: e.target.value })} />
            </Row>
          )}
        </>
      )}
      <SubGroup title="文字">
        <Row>
          <label style={labelStyle}>字体</label>
          <select style={{ ...inputStyle, flex: 1 }} value={f.family ?? 'Arial'}
            onChange={(e) => set({ font: { ...f, family: e.target.value } })}>
            {['Arial', 'SimSun', 'SimHei', 'Microsoft YaHei', 'Consolas'].map(x => <option key={x}>{x}</option>)}
          </select>
        </Row>
        <Row>
          <Field label="字号" value={f.size ?? 9}
            onChange={(v) => set({ font: { ...f, size: v } })} step={0.5} />
          <label style={{ ...labelStyle, marginLeft: 8 }}>颜色</label>
          <input type="color" style={inputStyle} value={f.color ?? '#000'}
            onChange={(e) => set({ font: { ...f, color: e.target.value } })} />
        </Row>
        <Row>
          <label style={labelStyle}>对齐</label>
          <select style={inputStyle} value={f.align ?? 'center'}
            onChange={(e) => set({ font: { ...f, align: e.target.value as "left" | "center" | "right" } })}>
            <option value="left">左</option>
            <option value="center">中</option>
            <option value="right">右</option>
          </select>
        </Row>
      </SubGroup>
      {/* 单元格编辑 */}
      <SubGroup title="单元格内容（支持 {{var}}）">
        {Array.from({ length: el.rows }).map((_, r) => (
          <div key={r} style={{ display: 'flex', gap: 2, marginBottom: 2 }}>
            {Array.from({ length: el.cols }).map((_, c) => {
              const idx = r * el.cols + c;
              return <input key={c} style={{ ...inputStyle, flex: 1, padding: '3px 4px', fontSize: 11 }}
                value={el.cells[idx] ?? ''}
                onChange={(e) => {
                  const cells = [...(el.cells ?? [])];
                  cells[idx] = e.target.value;
                  // 保证长度正确
                  const full = Array.from({ length: el.rows * el.cols }, (_, i) => cells[i] ?? '');
                  set({ cells: full });
                }} />;
            })}
          </div>
        ))}
      </SubGroup>
    </Group>
  );
}

function ImageProps({ el, set }: { el: ImageElement; set: SetFn }) {
  return (
    <Group title="图片">
      <textarea style={{ ...inputStyle, height: 50, resize: 'vertical', fontFamily: 'monospace', fontSize: 11 }}
        value={el.src}
        placeholder="data:image/png;base64,... 或 /assets/logo.png"
        onChange={(e) => set({ src: e.target.value })} />
      <Row>
        <button style={btnStyle} onClick={async () => {
          const input = document.createElement('input');
          input.type = 'file'; input.accept = 'image/*';
          input.onchange = () => {
            const f = input.files?.[0];
            if (!f) return;
            const reader = new FileReader();
            reader.onload = () => set({ src: reader.result as string });
            reader.readAsDataURL(f);
          };
          input.click();
        }}>📁 本地文件</button>
      </Row>
    </Group>
  );
}

function BarcodeProps({ el, set }: { el: BarcodeElement; set: SetFn }) {
  const b = el.barcode;
  return (
    <Group title="一维码">
      <Row>
        <label style={labelStyle}>编码</label>
        <select style={{ ...inputStyle, flex: 1 }} value={b.sym}
          onChange={(e) => set({ barcode: { ...b, sym: e.target.value } })}>
          {['CODE128', 'CODE39', 'CODE93', 'EAN13', 'EAN8', 'UPCA', 'UPCE', 'ITF14', 'CODABAR', 'GS1-128', 'MSI'].map(x => <option key={x}>{x}</option>)}
        </select>
      </Row>
      <Row>
        <label style={labelStyle}>内容</label>
        <input style={{ ...inputStyle, flex: 1 }} value={b.content}
          onChange={(e) => set({ barcode: { ...b, content: e.target.value } })}
          placeholder="{{sku}} 或直接字符串" />
      </Row>
      <Row>
        <Field label="模块宽 (mm)" value={b.moduleWidthMm} onChange={(v) => set({ barcode: { ...b, moduleWidthMm: v } })} step={0.05} />
        <Field label="宽窄比" value={b.wideRatio} onChange={(v) => set({ barcode: { ...b, wideRatio: v } })} step={0.1} />
      </Row>
      <Row>
        <Field label="条码高 (mm)" value={b.heightMm} onChange={(v) => set({ barcode: { ...b, heightMm: v } })} step={0.5} />
      </Row>
      <Row>
        <Toggle checked={b.showText} label="显示明文" onChange={(v) => set({ barcode: { ...b, showText: v } })} />
        {b.showText && (
          <select style={inputStyle} value={b.textPosition}
            onChange={(e) => set({ barcode: { ...b, textPosition: e.target.value as 'top' | 'bottom' } })}>
            <option value="bottom">下方</option><option value="top">上方</option>
          </select>
        )}
        <Toggle checked={!!b.checksum} label="校验位" onChange={(v) => set({ barcode: { ...b, checksum: v } })} />
      </Row>
    </Group>
  );
}

function QrcodeProps({ el, set }: { el: QrcodeElement; set: SetFn }) {
  const q = el.qrcode;
  return (
    <Group title="二维码">
      <Row>
        <label style={labelStyle}>编码</label>
        <select style={{ ...inputStyle, flex: 1 }} value={q.sym}
          onChange={(e) => set({ qrcode: { ...q, sym: e.target.value } })}>
          {['QRCODE', 'MICROQRCODE', 'DATAMATRIX', 'PDF417', 'AZTEC'].map(x => <option key={x}>{x}</option>)}
        </select>
      </Row>
      <Row>
        <label style={labelStyle}>内容</label>
        <input style={{ ...inputStyle, flex: 1 }} value={q.content}
          onChange={(e) => set({ qrcode: { ...q, content: e.target.value } })}
          placeholder="支持 {{变量}}" />
      </Row>
      <Row>
        <Field label="模块 (mm)" value={q.moduleSizeMm} onChange={(v) => set({ qrcode: { ...q, moduleSizeMm: v } })} step={0.1} />
        <Field label="静区 (mm)" value={q.quietZoneMm} onChange={(v) => set({ qrcode: { ...q, quietZoneMm: v } })} step={0.5} />
      </Row>
      <Row>
        <label style={labelStyle}>纠错</label>
        <select style={inputStyle} value={q.ecc}
          onChange={(e) => set({ qrcode: { ...q, ecc: e.target.value as any } })}>
          <option value="L">L (低 ~7%)</option>
          <option value="M">M (中 ~15%)</option>
          <option value="Q">Q (较高 ~25%)</option>
          <option value="H">H (高 ~30%)</option>
        </select>
      </Row>
    </Group>
  );
}

function FormulaProps({ el, set }: { el: FormulaElement; set: SetFn }) {
  const f = el.font ?? {};
  return (
    <Group title="公式字段">
      <textarea style={{ ...inputStyle, height: 60, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
        value={el.formula.expr}
        onChange={(e) => set({ formula: { ...el.formula, expr: e.target.value } })}
        placeholder="如: {{price}} * {{qty}} + TAX(...) " />
      <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>
        支持: + - * / (), 比较 &amp;&amp; ||, LEN, LEFT, RIGHT, MID, UPPER, LOWER, ROUND, IF, CHECKSUM...
      </div>
      <Row>
        <Field label="字号" value={f.size ?? 10} onChange={(v) => set({ font: { ...f, size: v } })} step={0.5} />
        <label style={{ ...labelStyle, marginLeft: 8 }}>颜色</label>
        <input type="color" style={inputStyle} value={f.color ?? '#531dab'}
          onChange={(e) => set({ font: { ...f, color: e.target.value } })} />
      </Row>
    </Group>
  );
}

function SerialProps({ el, set }: { el: SerialElement; set: SetFn }) {
  const s = el.serial;
  return (
    <Group title="流水号">
      <Row>
        <label style={labelStyle}>序列名</label>
        <input style={{ ...inputStyle, flex: 1 }} value={s.sequenceRef}
          onChange={(e) => set({ serial: { ...s, sequenceRef: e.target.value } })} />
      </Row>
      <Row>
        <Field label="位数" value={s.digits ?? 6} onChange={(v) => set({ serial: { ...s, digits: Math.max(1, Math.round(v)) } })} />
      </Row>
      <Row>
        <label style={labelStyle}>前缀</label>
        <input style={{ ...inputStyle, flex: 1 }} value={s.prefix ?? ''}
          onChange={(e) => set({ serial: { ...s, prefix: e.target.value } })} placeholder="SKU-" />
      </Row>
      <Row>
        <label style={labelStyle}>后缀</label>
        <input style={{ ...inputStyle, flex: 1 }} value={s.suffix ?? ''}
          onChange={(e) => set({ serial: { ...s, suffix: e.target.value } })} placeholder="A" />
      </Row>
      <Row>
        <Field label="字号" value={el.font.size ?? 10} onChange={(v) => set({ font: { ...el.font, size: v } })} step={0.5} />
      </Row>
    </Group>
  );
}

function DateTimeProps({ el, set }: { el: DateTimeElement; set: SetFn }) {
  return (
    <Group title="日期时间">
      <Row>
        <label style={labelStyle}>格式</label>
        <input style={{ ...inputStyle, flex: 1, fontFamily: 'monospace' }} value={el.datetime.pattern}
          onChange={(e) => set({ datetime: { ...el.datetime, pattern: e.target.value } })}
          placeholder="YYYY-MM-DD HH:mm:ss" />
      </Row>
      <div style={{ fontSize: 10, color: '#888' }}>
        格式串参考: YYYY年 MM月 DD日 HH时 mm分 ss秒
      </div>
      <Row>
        <label style={labelStyle}>数据源</label>
        <select style={inputStyle} value={el.datetime.source}
          onChange={(e) => set({ datetime: { ...el.datetime, source: e.target.value as 'print' | 'now' } })}>
          <option value="print">打印时刻</option>
          <option value="now">页面预览</option>
        </select>
      </Row>
    </Group>
  );
}

function SysvarProps({ el, set }: { el: SysvarElement; set: SetFn }) {
  return (
    <Group title="系统变量">
      <Row>
        <label style={labelStyle}>键名</label>
        <select style={{ ...inputStyle, flex: 1 }} value={el.sysvar.key}
          onChange={(e) => set({ sysvar: { key: e.target.value } })}>
          {[
            ['printDate', '打印日期'], ['printTime', '打印时间'],
            ['pageNo', '当前页号'], ['pageTotal', '总页数'],
            ['printerName', '打印机名'], ['tenantName', '租户名'],
            ['printUser', '打印人'], ['uuid', 'UUID'],
          ].map(([k, l]) => <option key={k} value={k}>{l} ({k})</option>)}
        </select>
      </Row>
    </Group>
  );
}

// =============================================================================
// 通用 UI 组件
// =============================================================================
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#2979ff', paddingBottom: 4, borderBottom: '1px solid #eef3ff', marginBottom: 6 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </div>
  );
}

function SubGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ fontSize: 10, color: '#888', marginBottom: 4 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>{children}</div>;
}

function Field({ label, value, onChange, step, min }: {
  label: string; value: number; onChange: (v: number) => void;
  step?: number; min?: number;
}) {
  return (
    <>
      <label style={labelStyle}>{label}</label>
      <input style={{ ...inputStyle, width: 64 }} type="number" step={step} min={min}
        value={value}
        onChange={(e) => onChange(+e.target.value)} />
    </>
  );
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked}
        onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

const labelStyle: React.CSSProperties = { fontSize: 11, color: '#555', width: 64, flexShrink: 0 };
const inputStyle: React.CSSProperties = {
  border: '1px solid #d9d9d9', borderRadius: 3, padding: '3px 5px', fontSize: 12,
  outline: 'none', background: '#fff',
};
const btnStyle: React.CSSProperties = {
  padding: '3px 10px', fontSize: 11, border: '1px solid #d9d9d9', borderRadius: 3,
  background: '#fff', cursor: 'pointer',
};
