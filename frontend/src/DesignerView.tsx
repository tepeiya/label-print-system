import { Stage, Layer, Rect, Text } from 'react-konva';
import { useDesignerStore } from '../designer/store';
import { onDragEnd as onDragEndImpl } from '../designer/interactions';
import type { AnyElement } from '../designer/types';

const BASE_PX_PER_MM = 5; // scale=1 时每毫米像素（屏幕预览）

export function DesignerView() {
  const template = useDesignerStore((s) => s.template);
  const scale = useDesignerStore((s) => s.scale);
  const selectedIds = useDesignerStore((s) => s.selectedIds);
  const select = useDesignerStore((s) => s.select);
  const px = BASE_PX_PER_MM * scale;
  const { widthMm, heightMm } = template.page;

  return (
    <Stage
      width={widthMm * px + 40}
      height={heightMm * px + 40}
      onMouseDown={(e) => { if (e.target === e.target.getStage()) select([]); }}
    >
      <Layer>
        {/* 标签白底 */}
        <Rect x={20} y={20} width={widthMm * px} height={heightMm * px} fill="#fff" stroke="#bbb" />
        {template.elements.map((el: AnyElement) => (
          <ElementNode key={el.id} el={el} px={px} selected={selectedIds.includes(el.id)}
            onSelect={() => select([el.id])}
            onDragEnd={(x, y) => onDragEndImpl(el.id, x, y)} />
        ))}
      </Layer>
    </Stage>
  );
}

function ElementNode({ el, px, selected, onSelect, onDragEnd }: any) {
  const update = useDesignerStore((s) => s.updateElement);
  const common = {
    x: 20 + el.x * px, y: 20 + el.y * px,
    width: el.w * px, height: el.h * px,
    rotation: el.rotation,
    draggable: !el.locked,
    stroke: selected ? '#1677ff' : undefined,
    strokeWidth: selected ? 1 : 0,
    onMouseDown: onSelect,
    onDragEnd: (e: any) => {
      const xMm = (e.target.x() - 20) / px;
      const yMm = (e.target.y() - 20) / px;
      update(el.id, { x: Math.round(xMm * 100) / 100, y: Math.round(yMm * 100) / 100 });
      onDragEnd(xMm, yMm);
    },
  };
  if (el.type === 'text' || el.type === 'serial' || el.type === 'formula') {
    const text = el.type === 'text' ? el.text : (el.rendered ?? el.serial?.sequenceRef ?? el.formula?.expr ?? '');
    return <Text {...common} text={text} fontSize={(el.font?.size ?? 10) * px / 25.4 * scale}
      fill={el.font?.color ?? '#000'} fontStyle={el.font?.bold ? 'bold' : 'normal'} />;
  }
  if (el.type === 'barcode' || el.type === 'qrcode') {
    const content = el.type === 'barcode' ? el.barcode.content : el.qrcode.content;
    return <Rect {...common} fill="#fff" stroke="#000" strokeWidth={0.5}
      sceneFunc={(ctx: any, shape: any) => { ctx.fillStrokeShape(shape); }} >
      <Text text={content} x={common.x} y={common.y + common.height - 12} fontSize={10} />
    </Rect>;
  }
  return <Rect {...common} fill={el.fill ?? '#cde'} />;
}
