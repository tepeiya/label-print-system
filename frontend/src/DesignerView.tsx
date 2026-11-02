// =============================================================================
// DesignerView.tsx —— 画布主视图（react-konva）
// 所有元素渲染 / 选中 / 拖拽 / Transformer 缩放旋转 / 网格 / 画布平移
// 坐标：外部 mm → 内部 px = mm * PX_PER_MM * scale
// =============================================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer, Rect, Text, Line, Image as KImage, Group, Transformer } from 'react-konva';
import Konva from 'konva';
import { useDesignerStore } from '../designer/store';
import type { AnyElement, TableElement, LineElement, RectElement, EllipseElement, TextElement } from '../designer/types';
import { computeSnap } from '../designer/interactions';

const PX_PER_MM = 5;              // 基准 1mm = 5px 渲染（相对屏幕 96dpi 的预览）
const GRID_MM = 1;                // 网格间距 mm
const OFFSET_MM = 10;             // 页面留白 mm（四周）

export function DesignerView() {
  const template = useDesignerStore((s) => s.template);
  const scale = useDesignerStore((s) => s.scale);
  const selectedIds = useDesignerStore((s) => s.selectedIds);
  const select = useDesignerStore((s) => s.select);
  const addToSelection = useDesignerStore((s) => s.addToSelection);
  const updateElement = useDesignerStore((s) => s.updateElement);

  const stageRef = useRef<Konva.Stage | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);

  // 画布像素尺寸
  const page = template.page;
  const pageWpx = page.widthMm * PX_PER_MM;
  const pageHpx = page.heightMm * PX_PER_MM;
  const stageW = pageWpx + OFFSET_MM * PX_PER_MM * 2;
  const stageH = pageHpx + OFFSET_MM * PX_PER_MM * 2;
  const offset = OFFSET_MM * PX_PER_MM;

  // 选中后自动附加 Transformer
  useEffect(() => {
    const stage = stageRef.current;
    const t = transformerRef.current;
    if (!stage || !t) return;
    const nodes = selectedIds
      .map((id) => stage.findOne<Konva.Node>(`#${CSS.escape(id)}`) as Konva.Node | null)
      .filter((n): n is Konva.Node => !!n);
    console.log('[Transformer useEffect] selectedIds=', selectedIds, 'nodes=', nodes.map(n => n.id?.()));
    if (nodes.length > 0) {
      t.nodes(nodes);
      t.getLayer()?.batchDraw();
    } else {
      t.nodes([]);
      t.getLayer()?.batchDraw();
    }
  }, [selectedIds]);

  // 空格按下 → 画布平移模式
  useEffect(() => {
    const kd = (e: KeyboardEvent) => { if (e.code === 'Space') { setSpaceDown(true); e.preventDefault(); } };
    const ku = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceDown(false); };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); };
  }, []);

  const handleStageClick = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const t: any = e.target;
    console.log('[Stage.onClick] target=', t.id?.() ?? t.className, 'selecting none');
    if (t === e.target.getStage()) { select([]); }
  };

  // 注意：元素选中改到 ElementNode.onMouseDown 里做了（draggable=true 时 click 会被吞，但 mousedown 会先触发）

  // 拖拽：实时 update，松手时 push 历史
  const dragStartPosRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const handleDragStart = (el: AnyElement, e: Konva.KonvaEventObject<DragEvent>) => {
    dragStartPosRef.current = { id: el.id, x: el.x, y: el.y };
    if (!selectedIds.includes(el.id)) {
      if (e.evt.shiftKey) addToSelection(el.id);
      else select([el.id]);
    }
  };
  const handleDragMove = (el: AnyElement, _e: Konva.KonvaEventObject<DragEvent>) => {
    const node = _e.target;
    const nx = (node.x() - offset) / PX_PER_MM / scale;
    const ny = (node.y() - offset) / PX_PER_MM / scale;
    // 简单边界约束
    const x = Math.max(0, Math.min(page.widthMm - el.w, nx));
    const y = Math.max(0, Math.min(page.heightMm - el.h, ny));
    node.x(offset + x * PX_PER_MM * scale);
    node.y(offset + y * PX_PER_MM * scale);
    updateElement(el.id, { x: +x.toFixed(2), y: +y.toFixed(2) });
  };
  const handleDragEnd = (el: AnyElement, _e: Konva.KonvaEventObject<DragEvent>) => {
    const node = _e.target;
    const x = +((node.x() - offset) / PX_PER_MM / scale).toFixed(2);
    const y = +((node.y() - offset) / PX_PER_MM / scale).toFixed(2);
    // 确保 state 同步到 store
    updateElement(el.id, { x, y });
    // 推入历史（通过另一个 action creator 避免重复）
    useDesignerStore.setState((s) => ({
      history: [...s.history, [{ type: 'update' as const, id: el.id, patch: { x, y } }]].slice(-50),
      future: [],
    }));
  };

  // Transformer resize / rotate → 回写 mm
  const handleTransformEnd = (el: AnyElement, _e: Konva.KonvaEventObject<Event>) => {
    const node = _e.target;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    node.scaleX(1); node.scaleY(1);
    const w = +((el.w * scaleX * scaleX) / 1).toFixed(2); // w is in mm, Konva scale is relative
    const h = +((el.h * scaleY * scaleY) / 1).toFixed(2);
    // 更直接的方式：node.width() / scale
    const nw = +(node.width() / PX_PER_MM / scale).toFixed(2);
    const nh = +(node.height() / PX_PER_MM / scale).toFixed(2);
    const rot = Math.round(node.rotation()) % 360;
    const x = +((node.x() - offset) / PX_PER_MM / scale).toFixed(2);
    const y = +((node.y() - offset) / PX_PER_MM / scale).toFixed(2);
    node.x(offset + x * PX_PER_MM * scale);
    node.y(offset + y * PX_PER_MM * scale);
    const patch: any = { x, y, w: nw, h: nh };
    if (rot === 0 || rot === 90 || rot === 180 || rot === 270) patch.rotation = rot;
    updateElement(el.id, patch);
    useDesignerStore.setState((s) => ({
      history: [...s.history, [{ type: 'update' as const, id: el.id, patch }]].slice(-50),
      future: [],
    }));
    void w; void h;
  };

  // 网格线
  const gridLines = useMemo(() => {
    const lines: number[][] = [];
    const step = GRID_MM * PX_PER_MM;
    for (let x = offset; x <= offset + pageWpx; x += step) {
      lines.push([x, offset, x, offset + pageHpx]);
    }
    for (let y = offset; y <= offset + pageHpx; y += step) {
      lines.push([offset, y, offset + pageWpx, y]);
    }
    return lines;
  }, [pageWpx, pageHpx, offset]);

  // 渲染所有元素（按 zIndex 排序）
  const sortedElements = useMemo(
    () => [...template.elements].sort((a, b) => a.zIndex - b.zIndex),
    [template.elements],
  );

  return (
    <div ref={containerRef} style={{ overflow: 'auto', width: '100%', height: '100%', background: '#f0f0f0' }}>
      <Stage
        ref={stageRef}
        width={stageW * scale}
        height={stageH * scale}
        scaleX={scale}
        scaleY={scale}
        draggable={spaceDown}
        onClick={handleStageClick}
        style={{ cursor: spaceDown ? 'grab' : 'default', zIndex: 10, position: 'relative' }}
      >
        <Layer>
          {/* 网格 */}
          {scale >= 0.7 && gridLines.map((pts, i) => (
            <Line key={`grid-${i}`} points={pts} stroke="#ddd" strokeWidth={0.5} listening={false} />
          ))}
          {/* 页面背景 */}
          <Rect
            x={offset}
            y={offset}
            width={pageWpx}
            height={pageHpx}
            fill="#fff"
            stroke="#bbb"
            strokeWidth={1}
            listening={false}
            shadowColor="rgba(0,0,0,0.2)"
            shadowBlur={6}
            shadowOffset={{ x: 2, y: 2 }}
          />
          {/* 页面尺寸标注 */}
          <Text
            x={offset}
            y={offset + pageHpx + 4}
            text={`${page.widthMm} × ${page.heightMm} mm  ·  ${page.dpi} dpi`}
            fontSize={10 / scale}
            fill="#888"
            listening={false}
          />
        </Layer>

        <Layer>
          {sortedElements.map((el) => (
            <ElementNode
              key={el.id}
              el={el}
              pxPerMm={PX_PER_MM}
              offset={offset}
              scale={scale}
              selected={selectedIds.includes(el.id)}
              pageWmm={page.widthMm}
              pageHmm={page.heightMm}
              onSelect={(id, shift) => {
                console.log('[render.onSelect]', id, 'shift=', shift);
                if (shift) addToSelection(id);
                else select([id]);
              }}
              onUpdate={(id, patch) => updateElement(id, patch)}
            />
          ))}

          {/* Transformer：只要 selectedIds 里有元素，就自动挂上去（useEffect 里处理） */}
          <Transformer
            ref={transformerRef}
            rotateEnabled={true}
            anchorSize={8}
            borderStroke="#2979ff"
            anchorStroke="#2979ff"
            anchorFill="#fff"
            boundBoxFunc={(oldBox, newBox) => (newBox.width > 3 && newBox.height > 3 ? newBox : oldBox)}
            onTransformEnd={(e) => {
              // Transformer 变换结束 → 把缩放/旋转回写 mm
              const node = e.target as Konva.Node;
              const id = node.id();
              const el = template.elements.find((x) => x.id === id);
              if (!el) return;
              const scaleX = node.scaleX();
              const scaleY = node.scaleY();
              node.scaleX(1); node.scaleY(1);
              const nw = +(node.width() / PX_PER_MM / scale).toFixed(2);
              const nh = +(node.height() / PX_PER_MM / scale).toFixed(2);
              const rot = Math.round(node.rotation()) % 360;
              const x = +((node.x() - offset) / PX_PER_MM / scale).toFixed(2);
              const y = +((node.y() - offset) / PX_PER_MM / scale).toFixed(2);
              node.x(offset + x * PX_PER_MM * scale);
              node.y(offset + y * PX_PER_MM * scale);
              useDesignerStore.setState(((s: any) => ({
                template: {
                  ...s.template,
                  elements: s.template.elements.map((x2: AnyElement) => x2.id === id
                    ? ({ ...x2, x, y, w: nw, h: nh, rotation: rot } as AnyElement)
                    : x2),
                },
                history: [...s.history, [{ type: 'update' as const, id, patch: { x, y, w: nw, h: nh, rotation: rot } }]].slice(-50),
                future: [],
              })) as any);
            }}
          />
        </Layer>
      </Stage>
    </div>
  );
}

// -----------------------------------------------------------------------------
// ElementNode —— 每种元素类型渲染成 Konva Node
// -----------------------------------------------------------------------------
interface ElementNodeProps {
  el: AnyElement;
  pxPerMm: number; offset: number; scale: number;
  selected: boolean;
  pageWmm: number; pageHmm: number;
  // 所有回调都由外层 DesignerView 闭包提供（不能在 ElementNode 内部重新声明，否则拿不到外层变量）
  onSelect: (id: string, shiftKey: boolean) => void;
  onUpdate: (id: string, patch: Partial<AnyElement>) => void;
}

function ElementNode({ el, pxPerMm, offset, scale, selected, pageWmm, pageHmm, onSelect, onUpdate }: ElementNodeProps) {
  const x = offset + el.x * pxPerMm;
  const y = offset + el.y * pxPerMm;
  const w = el.w * pxPerMm;
  const h = el.h * pxPerMm;

  // 选中框（虚线蓝框）
  const selectionBox = selected ? (
    <Rect
      x={-2} y={-2} width={w + 4} height={h + 4}
      stroke="#2979ff" strokeWidth={1}
      dash={[4, 2]}
      listening={false}
      perfectDrawEnabled={false}
    />
  ) : null;

  // 透明捕获层：同尺寸、listening=true、fill 0.01 opacity 保证 hitTest 能命中
  const captureRect = (
    <Rect
      x={0} y={0} width={w} height={h}
      fill="rgba(0,0,0,0.001)"
      listening={true}
      perfectDrawEnabled={false}
      onClick={(e: Konva.KonvaEventObject<MouseEvent>) => {
        e.cancelBubble = true;
        console.log('[CaptureRect.onClick] id=', el.id, 'shift=', !!e.evt.shiftKey);
        onSelect(el.id, !!e.evt.shiftKey);
      }}
    />
  );

  const common: any = {
    id: el.id,
    x, y,
    rotation: el.rotation,
    opacity: el.opacity ?? 1,
    // 双保险：Group 自身也绑 onClick（即使 captureRect 没起作用）
    onClick: (e: Konva.KonvaEventObject<MouseEvent>) => {
      e.cancelBubble = true;
      console.log('[Group.onClick] id=', el.id, 'shift=', !!e.evt.shiftKey);
      onSelect(el.id, !!e.evt.shiftKey);
    },
  };

  switch (el.type) {
    case 'text': {
      const t = el as TextElement;
      return (
        <Group {...common}>
          {captureRect}
          {selectionBox}
          <Text
            x={0} y={0} width={w} height={h}
            text={renderTemplateText(t.text)}
            fontFamily={t.font?.family ?? 'Arial'}
            fontSize={(t.font?.size ?? 10) * pxPerMm * 0.85}
            fontStyle={[
              t.font?.bold ? 'bold' : '',
              t.font?.italic ? 'italic' : '',
            ].filter(Boolean).join(' ') as any}
            fontVariant={t.font?.bold ? 'bold' : '' as any}
            fill={t.font?.color ?? '#000'}
            align={t.font?.align ?? 'left'}
            verticalAlign={t.font?.vAlign ?? 'top'}
            wrap={t.font?.wrap ? 'word' : 'none'}
            listening={false}
          />
        </Group>
      );
    }

    case 'rect': {
      const r = el as RectElement;
      return (
        <Group {...common}>
          {captureRect}
          {selectionBox}
          <Rect
            x={0} y={0} width={w} height={h}
            fill={r.fill ?? '#ffffff'}
            stroke={r.stroke?.color ?? '#333'}
            strokeWidth={r.stroke?.width ?? 1}
            cornerRadius={(r.cornerRadius ?? 0) * pxPerMm}
            listening={false}
          />
        </Group>
      );
    }

    case 'ellipse': {
      const e = el as EllipseElement;
      return (
        <Group {...common}>
          {captureRect}
          {selectionBox}
          <KEllipseLocal
            w={w} h={h}
            fill={e.fill ?? '#ffffff'}
            stroke={e.stroke?.color ?? '#333'}
            strokeWidth={e.stroke?.width ?? 1}
            listening={false}
          />
        </Group>
      );
    }

    case 'line': {
      const l = el as LineElement;
      const x2p = (l.x2 - l.x) * pxPerMm;
      const y2p = (l.y2 - l.y) * pxPerMm;
      return (
        <Group {...common}>
          {captureRect}
          {selectionBox}
          <Line
            points={[0, 0, x2p, y2p]}
            stroke={l.stroke.color}
            strokeWidth={l.stroke.width}
            dash={l.stroke.style === 'dashed' ? [6, 4] : l.stroke.style === 'dotted' ? [1, 3] : undefined}
            listening={false}
          />
        </Group>
      );
    }

    case 'table': {
      return <TableNode el={el as TableElement} common={common} w={w} h={h} selected={selected} selectionBox={selectionBox} pxPerMm={pxPerMm} />;
    }

    case 'barcode': {
      return (
        <Group {...common}>
          {captureRect}
          {selectionBox}
          <BarcodeFallbackNode w={w} h={h} el={el} />
        </Group>
      );
    }

    case 'qrcode': {
      return (
        <Group {...common}>
          {captureRect}
          {selectionBox}
          <QRCodeFallbackNode w={w} h={h} el={el} />
        </Group>
      );
    }

    case 'image': {
      return (
        <Group {...common}>
          {captureRect}
          {selectionBox}
          <Rect x={0} y={0} width={w} height={h} fill="#e6f4ff" stroke="#91caff" strokeWidth={1} listening={false} />
          <Text x={0} y={h / 2 - 10} width={w} text={`图片\n${el.id.slice(-6)}`} align="center" fontSize={12} fill="#1677ff" listening={false} />
        </Group>
      );
    }

    case 'formula': case 'serial': case 'datetime': case 'sysvar': {
      const fallback = {
        formula: 'f(x)',
        serial: '000001',
        datetime: '2026-01-01',
        sysvar: '{{SYS}}',
      }[el.type];
      return (
        <Group {...common}>
          {captureRect}
          {selectionBox}
          <Rect x={0} y={0} width={w} height={h} fill="#f5f0ff" stroke="#d3adf7" strokeWidth={1} listening={false} />
          <Text x={0} y={0} width={w} height={h} text={fallback} align="center" verticalAlign="middle" fontSize={14} fontStyle="italic" fill="#531dab" listening={false} />
        </Group>
      );
    }

    default:
      return (
        <Group {...common}>
          {captureRect}
          {selectionBox}
          <Rect x={0} y={0} width={w} height={h} fill="#fff3e0" stroke="#fa8c16" listening={false} />
        </Group>
      );
  }
}

// -----------------------------------------------------------------------------
// 表格节点 —— 渲染行列单元格
// -----------------------------------------------------------------------------
interface TableNodeProps {
  el: TableElement;
  common: any; // Group 的通用 props（含位置/事件/变换）
  w: number; h: number; selected: boolean;
  selectionBox: any;
  pxPerMm: number;
}

function TableNode({ el, common, w, h, selected, selectionBox, pxPerMm }: TableNodeProps) {
  const cellW = w / el.cols;
  const cellH = h / el.rows;
  const border = el.showBorder !== false;
  const bw = el.borderWidth ?? 1;
  const bc = el.borderColor ?? '#333';

  const cells = [];
  for (let r = 0; r < el.rows; r++) {
    for (let c = 0; c < el.cols; c++) {
      const idx = r * el.cols + c;
      const bg = (el.headerRow && r === 0) ? (el.headerBg ?? '#fafafa') : '#ffffff';
      cells.push(
        <Rect key={`bg-${idx}`}
          x={c * cellW} y={r * cellH} width={cellW} height={cellH}
          fill={bg} listening={false} />
      );
      cells.push(
        <Text key={`txt-${idx}`}
          x={c * cellW} y={r * cellH + cellH * 0.1} width={cellW} height={cellH * 0.8}
          text={el.cells[idx] ?? ''}
          fontFamily={el.font?.family ?? 'Arial'}
          fontSize={(el.font?.size ?? 9) * 4.25}
          fontStyle={el.headerRow && r === 0 ? 'bold' : ''}
          fill={el.font?.color ?? '#000'}
          align={el.font?.align ?? 'left'}
          verticalAlign="middle"
          listening={false} />
      );
    }
  }

  return (
    <Group {...common}>
      {selectionBox}
      {cells}
      {border && <Rect x={0} y={0} width={w} height={h} fill={undefined} stroke={bc} strokeWidth={bw} listening={false} />}
      {border && Array.from({ length: el.cols - 1 }).map((_, i) => (
        <Line key={`cv-${i}`} points={[(i + 1) * cellW, 0, (i + 1) * cellW, h]} stroke={bc} strokeWidth={bw} listening={false} />
      ))}
      {border && Array.from({ length: el.rows - 1 }).map((_, i) => (
        <Line key={`ch-${i}`} points={[0, (i + 1) * cellH, w, (i + 1) * cellH]} stroke={bc} strokeWidth={bw} listening={false} />
      ))}
    </Group>
  );
}

// -----------------------------------------------------------------------------
// 条码 / 二维码 —— 前端预览 fallback（真实渲染走后端图片 / 服务端 node-canvas）
// -----------------------------------------------------------------------------
function BarcodeFallbackNode({ w, h, el }: { w: number; h: number; el: AnyElement }) {
  // 用矩形条模拟条码外观：交替黑白竖条纹
  const bars = [];
  const n = 28;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      bars.push(
        <Rect key={i}
          x={(w / n) * i} y={0}
          width={w / n - 1} height={h * 0.75}
          fill="#000" listening={false} />
      );
    }
  }
  // 文本占位
  const txt = (el as any).barcode?.content ?? '';
  return (
    <>
      {bars}
      <Text x={0} y={h * 0.78} width={w} text={txt || 'SKU-000001'} align="center" fontSize={Math.max(10, h * 0.12)} fill="#333" listening={false} />
    </>
  );
}

function QRCodeFallbackNode({ w, h, el }: { w: number; h: number; el: AnyElement }) {
  const n = 21;
  const cells: any[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // 三个定位方块 + 伪随机
      const isFinder = (i < 7 && j < 7) || (i < 7 && j >= n - 7) || (i >= n - 7 && j < 7);
      const on = isFinder
        ? ((i === 0 || i === 6 || j === 0 || j === 6) ||
           (i >= 2 && i <= 4 && j >= 2 && j <= 4))
        : ((i * 31 + j * 17 + (((el as any).qrcode?.sym || 'QRCODE').length)) % 3 !== 0);
      if (on) {
        cells.push(<Rect key={`q-${i}-${j}`}
          x={(w / n) * i} y={(h / n) * j}
          width={w / n + 0.5} height={h / n + 0.5}
          fill="#000" listening={false} />);
      }
    }
  }
  return <>{cells}</>;
}

// Konva Ellipse 组件不存在，用 custom 实现
const KEllipseLocal: any = (() => {
  const Ellipse = Konva.Ellipse as any;
  return ({ x = 0, y = 0, w, h, fill, stroke, strokeWidth, listening }: any) => (
    <Ellipse x={x + w / 2} y={y + h / 2} radiusX={w / 2} radiusY={h / 2}
      fill={fill} stroke={stroke} strokeWidth={strokeWidth} listening={listening} />
  );
})();

// -----------------------------------------------------------------------------
// 工具：{{var}} → 占位文本（设计态不绑定真实数据）
// -----------------------------------------------------------------------------
function renderTemplateText(raw: string): string {
  // 保留 {{var}} 原样展示（设计器用户应该能看见变量占位）
  return raw;
}
