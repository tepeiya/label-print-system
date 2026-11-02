// =============================================================================
// inspector.js —— 右侧检查器：属性 / 页面 / 图层 / 变量
// 输入框采用「focus 存快照 → input 实时改 → change 提交历史」，
// 保证连续输入只产生一条撤销记录，同时画布实时跟随。
// =============================================================================

import { store } from './store.js';
import {
  SYSVAR_KEYS, FONT_FAMILIES, BARCODE_SYMS, QRCODE_SYMS, PAGE_PRESETS, DPI_OPTIONS,
  MEDIA_TYPES, VAR_VALIDATIONS,
} from './model.js';
import { r2 } from './util.js';
import { validateBarcodeText, barcodeNaturalWidth } from './render.js';
import { addGuide, clearGuides, guideList, removeGuideById, rulersVisible, setRulersVisible } from './guides.js';

let tab = 'properties';

export function setInspectorTab(t) {
  tab = t;
  renderInspector();
}

export function getInspectorTab() {
  return tab;
}

// ---------------------------------------------------------------------------
// 基础控件
// ---------------------------------------------------------------------------
function h(tag, cls, style) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (style) Object.assign(n.style, style);
  return n;
}

let snap = null;

function beginEdit() {
  if (!snap) snap = store.snapshot();
}

function endEdit() {
  if (snap) {
    store.commitSnapshot(snap);
    snap = null;
  }
}

/** 绑定输入：focus 快照 → input 实时 → change 提交 */
function bind(node, apply) {
  node.addEventListener('focus', beginEdit);
  node.addEventListener('pointerdown', beginEdit);
  node.addEventListener('input', () => apply(node, false));
  node.addEventListener('change', () => {
    apply(node, false);
    endEdit();
  });
  node.addEventListener('blur', () => {
    apply(node, false);
    endEdit();
  });
}

function commit(fn) {
  const s = store.snapshot();
  fn();
  store.commitSnapshot(s);
}

const row = (...kids) => {
  const r = h('div', 'form-row');
  kids.filter(Boolean).forEach((k) => r.appendChild(k));
  return r;
};

const row2 = (a, b) => {
  const r = h('div', 'form-row2');
  if (a) r.appendChild(a);
  if (b) r.appendChild(b);
  return r;
};

function lb(text) {
  const n = h('span', 'form-label');
  n.textContent = text;
  return n;
}

function numInput(value, apply, { step = 0.1, min, max } = {}) {
  const i = h('input', 'form-input num');
  i.type = 'number';
  i.step = String(step);
  if (min !== undefined) i.min = String(min);
  if (max !== undefined) i.max = String(max);
  i.value = String(value ?? 0);
  bind(i, (n) => {
    const v = parseFloat(n.value);
    if (Number.isFinite(v)) apply(v, n);
  });
  return i;
}

function textInput(value, apply, placeholder = '') {
  const i = h('input', 'form-input');
  i.type = 'text';
  i.value = value ?? '';
  i.placeholder = placeholder;
  bind(i, (n) => apply(n.value));
  return i;
}

function areaInput(value, apply, rows = 3, placeholder = '') {
  const i = h('textarea', 'form-textarea');
  i.rows = rows;
  i.value = value ?? '';
  i.placeholder = placeholder;
  bind(i, (n) => apply(n.value));
  return i;
}

function normColor(c) {
  if (!c) return '#000000';
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map((x) => x + x).join('');
  return '#000000';
}

function colorInput(value, apply) {
  const i = h('input', 'form-color');
  i.type = 'color';
  i.value = normColor(value);
  bind(i, (n) => apply(n.value));
  return i;
}

function selectInput(value, options, apply) {
  const s = h('select', 'form-input');
  options.forEach((o) => {
    const opt = document.createElement('option');
    if (Array.isArray(o)) { opt.value = String(o[0]); opt.textContent = o[1]; }
    else { opt.value = String(o); opt.textContent = String(o); }
    s.appendChild(opt);
  });
  s.value = String(value ?? '');
  bind(s, (n) => apply(n.value));
  return s;
}

function checkBox(text, checked, apply) {
  const wrap = h('label', 'form-check');
  const cb = h('input');
  cb.type = 'checkbox';
  cb.checked = !!checked;
  cb.addEventListener('change', () => commit(() => apply(cb.checked)));
  wrap.appendChild(cb);
  const t = document.createElement('span');
  t.textContent = text;
  wrap.appendChild(t);
  return wrap;
}

function btn(text, onClick, kind = '') {
  const b = h('button', `btn${kind ? ' btn-' + kind : ''}`);
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
  return b;
}

function group(title, ...kids) {
  const g = h('div', 'form-group');
  if (title) {
    const t = h('div', 'form-group-title');
    t.textContent = title;
    g.appendChild(t);
  }
  kids.filter(Boolean).forEach((k) => g.appendChild(k));
  return g;
}

function field(labelText, control) {
  const r = h('div', 'form-row');
  r.appendChild(lb(labelText));
  r.appendChild(control);
  return r;
}

function typeName(t) {
  return ({
    text: '文本', rect: '矩形', ellipse: '椭圆', line: '直线', table: '表格',
    image: '图片', barcode: '一维码', qrcode: '二维码', formula: '公式',
    serial: '流水号', datetime: '日期', sysvar: '系统变量',
  })[t] || t;
}

// ---------------------------------------------------------------------------
// 渲染入口
// ---------------------------------------------------------------------------
export function renderInspector() {
  const root = document.getElementById('inspector-body');
  if (!root) return;
  const scroll = root.scrollTop;
  root.innerHTML = '';
  document.querySelectorAll('#inspector-tabs .itab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  if (tab === 'properties') root.appendChild(propertiesView());
  else if (tab === 'page') root.appendChild(pageView());
  else if (tab === 'layers') root.appendChild(layersView());
  else root.appendChild(variablesView());
  root.scrollTop = scroll;
}

// ---------------------------------------------------------------------------
// 属性
// ---------------------------------------------------------------------------
function propertiesView() {
  const wrap = h('div', 'inspector-inner');
  const sel = store.selectedElements();

  if (!sel.length) {
    const empty = h('div', 'inspector-empty');
    empty.innerHTML = `<div class="ie-icon">⌖</div>
      <div class="ie-t">在画布上点选元素即可编辑属性</div>
      <div class="ie-sub">Shift + 点击 = 多选<br>拖动空白处 = 框选<br>双击文本 = 直接改写内容</div>`;
    wrap.appendChild(empty);
    return wrap;
  }

  if (sel.length > 1) {
    wrap.appendChild(group(`${sel.length} 个元素被选中`,
      row2(
        btn('左对齐', () => alignSelected('left')),
        btn('水平居中', () => alignSelected('hcenter'))
      ),
      row2(
        btn('顶对齐', () => alignSelected('top')),
        btn('垂直居中', () => alignSelected('vcenter'))
      ),
      row2(
        btn('水平等距', () => distributeSelected('h')),
        btn('垂直等距', () => distributeSelected('v'))
      ),
      row2(
        btn('同宽', () => matchSizeSelected('w')),
        btn('同高', () => matchSizeSelected('h'))
      ),
      row2(
        btn('组合 (Ctrl+G)', () => store.groupSelected()),
        btn('取消组合', () => store.ungroupSelected())
      ),
      row2(
        btn('复制', () => store.duplicateSelected()),
        btn('删除', () => store.removeElements(), 'danger')
      )
    ));
    return wrap;
  }

  const el = sel[0];
  const set = (patch) => store.updateElement(el.id, patch);

  // 头部
  const head = h('div', 'insp-head');
  const badge = h('span', 'type-badge');
  badge.textContent = typeName(el.type);
  head.appendChild(badge);
  const idc = h('span', 'insp-id');
  idc.textContent = el.id.slice(-8);
  head.appendChild(idc);
  head.appendChild(btn('复制', () => store.duplicateSelected()));
  head.appendChild(btn('删除', () => store.removeElements(), 'danger'));
  wrap.appendChild(head);

  // 位置尺寸
  wrap.appendChild(group('位置与尺寸',
    row2(
      field('X (mm)', numInput(el.x, (v) => set({ x: r2(v) }), { step: 0.5 })),
      field('Y (mm)', numInput(el.y, (v) => set({ y: r2(v) }), { step: 0.5 }))
    ),
    row2(
      field('宽 (mm)', numInput(el.w, (v) => set({ w: Math.max(1, r2(v)) }), { step: 0.5, min: 1 })),
      field('高 (mm)', numInput(el.h, (v) => set({ h: Math.max(1, r2(v)) }), { step: 0.5, min: 1 }))
    ),
    row(
      lb('旋转'),
      selectInput(el.rotation ?? 0, [[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']],
        (v) => set({ rotation: Number(v) })),
      lb('层级'),
      numInput(el.zIndex, (v) => set({ zIndex: Math.round(v) }), { step: 1 })
    )
  ));

  // 外观 / 输出
  wrap.appendChild(group('外观与输出',
    row(
      lb('透明度'),
      slideInput(el.opacity ?? 1, (v) => set({ opacity: v })),
      (() => {
        const t = h('span', 'form-hint');
        t.textContent = `${Math.round((el.opacity ?? 1) * 100)}%`;
        return t;
      })()
    ),
    checkBox('打印输出', el.visible !== false, (v) => set({ visible: v })),
    checkBox('锁定位置（不可拖动）', !!el.locked, (v) => set({ locked: v })),
    field('打印条件', textInput(el.printIf ?? '', (v) => set({ printIf: v }), '如: price > 10'))
  ));

  // 类型专属（specificView 统一返回节点数组）
  for (const node of specificView(el, set) || []) {
    if (node) wrap.appendChild(node);
  }
  return wrap;
}

function slideInput(value, apply) {
  const i = h('input', 'form-range');
  i.type = 'range';
  i.min = '0';
  i.max = '1';
  i.step = '0.05';
  i.value = String(value);
  bind(i, (n) => apply(parseFloat(n.value) || 0));
  return i;
}

function fontGroup(el, set, { size = true, weight = true, align = true } = {}) {
  const f = el.font || {};
  const upd = (patch) => set({ font: { ...f, ...patch } });
  const kids = [
    row(
      lb('字体'),
      selectInput(f.family ?? 'Arial', FONT_FAMILIES, (v) => upd({ family: v }))
    ),
  ];
  if (size) {
    kids.push(row(
      lb('字号 (pt)'),
      numInput(f.size ?? 9, (v) => upd({ size: r2(v) }), { step: 0.5, min: 1 }),
      lb('颜色'),
      colorInput(f.color ?? '#000000', (v) => upd({ color: v }))
    ));
  } else {
    kids.push(row(lb('颜色'), colorInput(f.color ?? '#000000', (v) => upd({ color: v }))));
  }
  if (weight) {
    kids.push(row(
      checkBox('粗体', !!f.bold, (v) => upd({ bold: v })),
      checkBox('斜体', !!f.italic, (v) => upd({ italic: v })),
      checkBox('下划线', !!f.underline, (v) => upd({ underline: v }))
    ));
  }
  if (align) {
    kids.push(row(
      lb('水平'),
      selectInput(f.align ?? 'left', [['left', '左'], ['center', '中'], ['right', '右']], (v) => upd({ align: v })),
      lb('垂直'),
      selectInput(f.vAlign ?? 'middle', [['top', '顶'], ['middle', '中'], ['bottom', '底']], (v) => upd({ vAlign: v }))
    ));
  }
  return group('字体样式', ...kids);
}

function strokeGroup(el, set, title = '描边') {
  const s = el.stroke || { width: 0.3, color: '#333333', style: 'solid' };
  const upd = (patch) => set({ stroke: { ...s, ...patch } });
  return group(title,
    row(
      lb('线宽 (mm)'),
      numInput(s.width ?? 0.3, (v) => upd({ width: r2(v) }), { step: 0.05, min: 0 }),
      lb('线型'),
      selectInput(s.style ?? 'solid', [['solid', '实线'], ['dashed', '虚线'], ['dotted', '点线']], (v) => upd({ style: v }))
    ),
    row(lb('颜色'), colorInput(s.color, (v) => upd({ color: v })))
  );
}

function specificView(el, set) {
  switch (el.type) {
    case 'text':
      return [
        group('文本内容',
          areaInput(el.text, (v) => set({ text: v }), 3, '支持 {{变量}} 占位'),
          row(
            checkBox('自动换行', el.font?.wrap !== false, (v) => set({ font: { ...el.font, wrap: v } }))
          )
        ),
        fontGroup(el, set),
      ];

    case 'rect':
      return [
        group('矩形样式',
          row(
            lb('填充'),
            colorInput(el.fill ?? '#ffffff', (v) => set({ fill: v })),
            lb('圆角 mm'),
            numInput(el.cornerRadius ?? 0, (v) => set({ cornerRadius: r2(v) }), { step: 0.25, min: 0 })
          )
        ),
        strokeGroup(el, set),
      ];

    case 'ellipse':
      return [
        group('椭圆样式', row(lb('填充'), colorInput(el.fill ?? '#ffffff', (v) => set({ fill: v })))),
        strokeGroup(el, set),
      ];

    case 'line':
      return [
        group('直线端点',
          row2(
            field('终点 X (mm)', numInput(el.x2, (v) => { set({ x2: r2(v) }); }, { step: 0.5 })),
            field('终点 Y (mm)', numInput(el.y2, (v) => { set({ y2: r2(v) }); }, { step: 0.5 }))
          )
        ),
        strokeGroup(el, set, '线条'),
      ];

    case 'table':
      return [
        group('表格结构',
          row(
            lb('行'),
            numInput(el.rows, (v) => set({ rows: Math.max(1, Math.round(v)) }), { step: 1, min: 1 }),
            lb('列'),
            numInput(el.cols, (v) => set({ cols: Math.max(1, Math.round(v)) }), { step: 1, min: 1 })
          ),
          row(
            checkBox('表格线', el.showBorder !== false, (v) => set({ showBorder: v })),
            checkBox('首行表头', !!el.headerRow, (v) => set({ headerRow: v }))
          ),
          row(
            lb('线宽 mm'),
            numInput(el.borderWidth ?? 0.2, (v) => set({ borderWidth: r2(v) }), { step: 0.05, min: 0 }),
            lb('线色'),
            colorInput(el.borderColor ?? '#333333', (v) => set({ borderColor: v }))
          ),
          row(lb('表头底色'), colorInput(el.headerBg ?? '#f2f2f2', (v) => set({ headerBg: v })))
        ),
        fontGroup(el, set, { size: true, weight: false, align: true }),
        cellsEditor(el, set),
      ];

    case 'image': {
      const kids = [
        areaInput(el.src, (v) => set({ src: v }), 4, 'data:image/png;base64,... 或 http 图片地址'),
        row(
          btn('📁 选择本地图片', () => {
            const inp = document.createElement('input');
            inp.type = 'file';
            inp.accept = 'image/*';
            inp.onchange = () => {
              const f = inp.files?.[0];
              if (!f) return;
              const reader = new FileReader();
              reader.onload = () => commit(() => set({ src: reader.result }));
              reader.readAsDataURL(f);
            };
            inp.click();
          }),
          btn('清空', () => commit(() => set({ src: '' })))
        ),
      ];
      return [group('图片', ...kids)];
    }

    case 'barcode': {
      const b = el.barcode || {};
      const upd = (patch) => set({ barcode: { ...b, ...patch } });
      const v = validateBarcodeText(b.sym ?? 'CODE128', b.content ?? '');
      const nat = barcodeNaturalWidth(b, b.content ?? '');
      const warn = nat != null && nat > (el.w ?? 0) + 0.01
        ? `条码自然宽度 ${nat.toFixed(1)}mm 大于元素宽度 ${el.w}mm，可能被压缩变形（建议加宽元素或减小模块宽）`
        : '';
      return [
        group('一维码内容',
          row(lb('码制'), selectInput(b.sym ?? 'CODE128', BARCODE_SYMS, (x) => upd({ sym: x }))),
          field('内容', textInput(b.content ?? '', (x) => upd({ content: x }), '支持 {{变量}}')),
          v.ok
            ? (v.note ? hint(`✓ ${v.note}`) : null)
            : hint(`✗ ${v.error}`),
          warn ? hint(`⚠ ${warn}`) : null,
          row(
            lb('模块宽 mm'),
            numInput(b.moduleWidthMm ?? 0.25, (x) => upd({ moduleWidthMm: r2(x) }), { step: 0.01, min: 0.05 }),
            lb('宽窄比'),
            numInput(b.wideRatio ?? 2.5, (x) => upd({ wideRatio: r2(x) }), { step: 0.1, min: 1.5 })
          ),
          row(
            lb('条码高 mm'),
            numInput(b.heightMm ?? 9, (x) => upd({ heightMm: r2(x) }), { step: 0.5, min: 2 }),
            lb('静区 mm'),
            numInput(b.quietZoneMm ?? 2, (x) => upd({ quietZoneMm: r2(x) }), { step: 0.5, min: 0 })
          ),
          row(
            checkBox('显示明文', !!b.showText, (x) => upd({ showText: x })),
            selectInput(b.textPosition ?? 'bottom', [['bottom', '文在下'], ['top', '文在上']],
              (x) => upd({ textPosition: x }))
          ),
          row(
            lb('明文号 (mm)'),
            numInput(b.textFont?.size ?? 2.4, (x) => upd({ textFont: { ...(b.textFont || {}), size: r2(x) } }), { step: 0.1, min: 1 })
          ),
          row(checkBox('校验位（自动追加）', b.checksum !== false, (x) => upd({ checksum: x })))
        ),
      ];
    }

    case 'qrcode': {
      const q = el.qrcode || {};
      const upd = (patch) => set({ qrcode: { ...q, ...patch } });
      const v = validateBarcodeText(q.sym ?? 'QRCODE', q.content ?? '');
      return [
        group('二维码内容',
          row(lb('码制'), selectInput(q.sym ?? 'QRCODE', QRCODE_SYMS, (x) => upd({ sym: x }))),
          field('内容', textInput(q.content ?? '', (x) => upd({ content: x }), '支持 {{变量}}')),
          v.ok ? (v.note ? hint(`✓ ${v.note}`) : null) : hint(`✗ ${v.error}`),
          row(
            lb('模块 mm'),
            numInput(q.moduleSizeMm ?? 0.4, (x) => upd({ moduleSizeMm: r2(x) }), { step: 0.02, min: 0.1 }),
            lb('静区 mm'),
            numInput(q.quietZoneMm ?? 2, (x) => upd({ quietZoneMm: r2(x) }), { step: 0.5, min: 0 })
          ),
          row(lb('纠错'), selectInput(q.ecc ?? 'M',
            [['L', 'L 低 7%'], ['M', 'M 中 15%'], ['Q', 'Q 较高 25%'], ['H', 'H 高 30%']],
            (x) => upd({ ecc: x })))
        ),
      ];
    }

    case 'formula':
      return [
        group('公式',
          areaInput(el.formula?.expr, (v) => set({ formula: { ...el.formula, expr: v } }), 3,
            '如: {{price}} * {{qty}}'),
          hint('支持 + - * / % 括号 比较 && || 与函数 LEN LEFT RIGHT MID UPPER LOWER ROUND INT ABS NUM CONCAT IF PAD')
        ),
        fontGroup(el, set),
      ];

    case 'serial': {
      const s = el.serial || {};
      const upd = (patch) => set({ serial: { ...s, ...patch } });
      return [
        group('流水号',
          field('序列名', textInput(s.sequenceRef ?? 'default', (v) => upd({ sequenceRef: v }))),
          row(
            lb('位数'),
            numInput(s.digits ?? 5, (v) => upd({ digits: Math.max(1, Math.round(v)) }), { step: 1, min: 1 }),
            lb('起始'),
            numInput(store.state.serialStart, (v) => { store.state.serialStart = Math.max(1, Math.round(v)); }, { step: 1, min: 1 })
          ),
          row(lb('前缀'), textInput(s.prefix ?? '', (v) => upd({ prefix: v }), 'SN-')),
          row(lb('后缀'), textInput(s.suffix ?? '', (v) => upd({ suffix: v }), 'A'))
        ),
        fontGroup(el, set),
      ];
    }

    case 'datetime':
      return [
        group('日期时间',
          field('格式串', textInput(el.datetime?.pattern ?? '', (v) => set({ datetime: { ...el.datetime, pattern: v } }), 'YYYY-MM-DD HH:mm:ss')),
          hint('可用: YYYY 年 · MM 月 · DD 日 · HH 时 · mm 分 · ss 秒'),
          row(lb('取值'), selectInput(el.datetime?.source ?? 'print',
            [['print', '打印时刻'], ['now', '预览时刻']],
            (v) => set({ datetime: { ...el.datetime, source: v } })))
        ),
        fontGroup(el, set),
      ];

    case 'sysvar':
      return [
        group('系统变量',
          field('键名', selectInput(el.sysvar?.key ?? 'printDate', SYSVAR_KEYS,
            (v) => set({ sysvar: { key: v } })))
        ),
        fontGroup(el, set),
      ];

    default:
      return [];
  }
}

function hint(text) {
  const n = h('span', 'form-hint');
  n.textContent = text;
  return n;
}

function cellsEditor(el, set) {
  const rows = Math.max(1, el.rows || 1);
  const cols = Math.max(1, el.cols || 1);
  const wrap = group(`单元格（${rows} × ${cols}）`);
  for (let r = 0; r < rows; r++) {
    const line = h('div', 'cell-row');
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const inp = h('input', 'form-input cell-input');
      inp.value = el.cells?.[idx] ?? '';
      inp.placeholder = `R${r + 1}C${c + 1}`;
      bind(inp, (n) => {
        const cells = Array.from({ length: rows * cols }, (_, i) => el.cells?.[i] ?? '');
        cells[idx] = n.value;
        set({ cells });
      });
      line.appendChild(inp);
    }
    wrap.appendChild(line);
  }
  return wrap;
}

function alignSelected(mode) {
  commit(() => {
    const sel = store.selectedElements();
    const minX = Math.min(...sel.map((e) => e.x));
    const maxR = Math.max(...sel.map((e) => e.x + e.w));
    const minY = Math.min(...sel.map((e) => e.y));
    const maxB = Math.max(...sel.map((e) => e.y + e.h));
    for (const e of sel) {
      if (mode === 'left') e.x = minX;
      if (mode === 'hcenter') e.x = r2((minX + maxR) / 2 - e.w / 2);
      if (mode === 'top') e.y = minY;
      if (mode === 'vcenter') e.y = r2((minY + maxB) / 2 - e.h / 2);
    }
  });
}

function distributeSelected(axis) {
  const sel = store.selectedElements();
  if (sel.length < 3) return;
  commit(() => {
    const sorted = [...sel].sort((a, b) => (axis === 'h' ? a.x - b.x : a.y - b.y));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const total = axis === 'h' ? last.x - first.x : last.y - first.y;
    const step = total / (sorted.length - 1);
    sorted.forEach((e, i) => {
      if (axis === 'h') e.x = r2(first.x + step * i);
      else e.y = r2(first.y + step * i);
    });
  });
}

function matchSizeSelected(axis) {
  const sel = store.selectedElements();
  if (sel.length < 2) return;
  commit(() => {
    const ref = sel[0];
    for (const e of sel.slice(1)) {
      if (axis === 'w') e.w = ref.w;
      else e.h = ref.h;
    }
  });
}

// ---------------------------------------------------------------------------
// 页面设置
// ---------------------------------------------------------------------------
function pageView() {
  const p = store.state.template.page;
  const wrap = h('div', 'inspector-inner');
  const set = (patch) => store.setPage(patch);

  const presetGrid = h('div', 'preset-grid');
  PAGE_PRESETS.forEach((pr) => {
    const b = btn(pr.name, () => set({ widthMm: pr.w, heightMm: pr.h }));
    b.classList.add('preset-btn');
    if (Math.abs(p.widthMm - pr.w) < 0.01 && Math.abs(p.heightMm - pr.h) < 0.01) b.classList.add('active');
    presetGrid.appendChild(b);
  });

  wrap.appendChild(group('尺寸预设', presetGrid));
  wrap.appendChild(group('自定义尺寸',
    row2(
      field('宽 (mm)', numInput(p.widthMm, (v) => set({ widthMm: Math.max(5, r2(v)) }), { step: 1, min: 5 })),
      field('高 (mm)', numInput(p.heightMm, (v) => set({ heightMm: Math.max(5, r2(v)) }), { step: 1, min: 5 }))
    ),
    row(
      lb('分辨率'),
      selectInput(p.dpi, DPI_OPTIONS.map((d) => [d, `${d} dpi`]), (v) => set({ dpi: Number(v) }))
    ),
    row(
      lb('方向'),
      selectInput(p.orientation ?? 0,
        [[0, '纵向 0°'], [90, '横向 90°'], [180, '180°'], [270, '270°']],
        (v) => set({ orientation: Number(v) }))
    ),
    row(
      lb('份数'),
      numInput(p.copies ?? 1, (v) => set({ copies: Math.max(1, Math.round(v)) }), { step: 1, min: 1 })
    )
  ));

  wrap.appendChild(group('拼版 / 多联',
    row(
      lb('列数'),
      numInput(p.columns ?? 1, (v) => set({ columns: Math.max(1, Math.round(v)) }), { step: 1, min: 1 }),
      lb('行数'),
      numInput(p.rows ?? 1, (v) => set({ rows: Math.max(1, Math.round(v)) }), { step: 1, min: 1 })
    ),
    row(
      lb('列间距 mm'),
      numInput(p.gapXMm ?? 2, (v) => set({ gapXMm: r2(v) }), { step: 0.5, min: 0 }),
      lb('行间距 mm'),
      numInput(p.gapYMm ?? 2, (v) => set({ gapYMm: r2(v) }), { step: 0.5, min: 0 })
    ),
    row(
      lb('页边距 mm'),
      numInput(p.marginMm ?? 0, (v) => set({ marginMm: r2(v) }), { step: 0.5, min: 0 }),
      lb('双面'),
      checkBox('双面打印', !!p.duplex, (v) => set({ duplex: v }))
    )
  ));

  wrap.appendChild(group('介质与定位',
    row(
      lb('介质类型'),
      selectInput(p.mediaType ?? 'gap', MEDIA_TYPES.map((m) => [m.value, m.label]),
        (v) => set({ mediaType: v }))
    ),
    row(
      lb('间隙 mm'),
      numInput(p.gapMm ?? 2, (v) => set({ gapMm: r2(v) }), { step: 0.5, min: 0 }),
      lb('黑标 mm'),
      numInput(p.blackMarkMm ?? 3, (v) => set({ blackMarkMm: r2(v) }), { step: 0.5, min: 0 })
    ),
    row(
      lb('X 偏移 mm'),
      numInput(p.offsetXMm ?? 0, (v) => set({ offsetXMm: r2(v) }), { step: 0.1 }),
      lb('Y 偏移 mm'),
      numInput(p.offsetYMm ?? 0, (v) => set({ offsetYMm: r2(v) }), { step: 0.1 })
    ),
    row(
      lb('X 校准 mm'),
      numInput(p.calibrateXMm ?? 0, (v) => set({ calibrateXMm: r2(v) }), { step: 0.1 }),
      lb('Y 校准 mm'),
      numInput(p.calibrateYMm ?? 0, (v) => set({ calibrateYMm: r2(v) }), { step: 0.1 })
    ),
    hint('偏移/校准用于补偿打印机走纸与打印头误差；导出 ZPL/TSPL 时会一并写入')
  ));

  const guideRows = h('div', 'form-hint-block');
  const gl = guideList();
  if (!gl.length) {
    guideRows.innerHTML = '还没有参考线：在标尺上按下并拖动即可创建';
  } else {
    guideRows.style.display = 'grid';
    guideRows.style.gap = '4px';
    for (const g of gl) {
      const r = row(
        lb(`${g.axis === 'x' ? '垂直' : '水平'} ${g.pos} mm`),
        btn('删除', () => removeGuideById(g.id), 'danger')
      );
      guideRows.appendChild(r);
    }
  }
  wrap.appendChild(group('参考线 / 标尺',
    row(
      lb('显示标尺'),
      checkBox('标尺与参考线可见', rulersVisible(), (v) => setRulersVisible(v))
    ),
    row(
      btn('＋ 水平中线', () => addGuide('y', p.heightMm / 2)),
      btn('＋ 垂直中线', () => addGuide('x', p.widthMm / 2)),
      btn('清空', () => clearGuides(), 'danger')
    ),
    guideRows,
    hint('拖标尺可自由定位；拖动画布上的参考线可微调，双击删除；拖动元素时自动吸附')
  ));

  const info = h('div', 'form-hint-block');
  info.innerHTML = `画布物理尺寸 <b>${p.widthMm} × ${p.heightMm} mm</b><br>
    打印像素 ${Math.round((p.widthMm * p.dpi) / 25.4)} × ${Math.round((p.heightMm * p.dpi) / 25.4)} px · ${p.dpi} dpi`;
  wrap.appendChild(group('打印信息', info));

  return wrap;
}

// ---------------------------------------------------------------------------
// 图层
// ---------------------------------------------------------------------------
function layersView() {
  const wrap = h('div', 'inspector-inner');
  const els = [...store.state.template.elements].sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0));

  const bar = h('div', 'layer-bar');
  bar.appendChild(btn('＋ 新建文本', () => document.dispatchEvent(new CustomEvent('add-element', { detail: 'text' }))));
  bar.appendChild(btn('清空', () => {
    if (store.state.template.elements.length && confirm('确认清空画布上的所有元素？')) {
      commit(() => { store.state.template.elements = []; });
      store.select([]);
    }
  }, 'danger'));
  wrap.appendChild(bar);

  if (!els.length) {
    wrap.appendChild(hint('画布上还没有元素'));
    return wrap;
  }

  const list = h('div', 'layer-list');
  for (const e of els) {
    const item = h('div', 'layer-item');
    if (store.state.selectedIds.includes(e.id)) item.classList.add('active');
    if (e.visible === false) item.classList.add('dimmed');

    const icon = h('span', 'layer-icon');
    icon.textContent = ({ text: 'T', rect: '▭', ellipse: '◯', line: '／', table: '▦', image: '🖼', barcode: '▮', qrcode: '▩', formula: 'ƒ', serial: '#', datetime: '📅', sysvar: '{}' })[e.type] || '?';
    item.appendChild(icon);

    const name = h('span', 'layer-name');
    name.textContent = e.name || typeName(e.type) + (e.type === 'text' ? `：${String(e.text ?? '').slice(0, 14)}` : '');
    item.appendChild(name);

    const eye = h('span', 'layer-toggle');
    eye.textContent = e.visible === false ? '🚫' : '👁';
    eye.title = '显示/隐藏';
    eye.addEventListener('click', (ev) => {
      ev.stopPropagation();
      commit(() => { e.visible = e.visible === false ? true : false; });
    });
    item.appendChild(eye);

    const lock = h('span', 'layer-toggle');
    lock.textContent = e.locked ? '🔒' : '🔓';
    lock.title = '锁定/解锁';
    lock.addEventListener('click', (ev) => {
      ev.stopPropagation();
      commit(() => { e.locked = !e.locked; });
    });
    item.appendChild(lock);

    item.addEventListener('click', (ev) => {
      if (ev.shiftKey) store.toggleSelect(e.id);
      else store.select([e.id]);
    });

    list.appendChild(item);
  }
  wrap.appendChild(list);

  const ops = h('div', 'layer-bar');
  ops.appendChild(btn('置顶', () => store.bringToFront()));
  ops.appendChild(btn('上移', () => store.bringForward()));
  ops.appendChild(btn('下移', () => store.sendBackward()));
  ops.appendChild(btn('置底', () => store.sendToBack()));
  wrap.appendChild(ops);

  return wrap;
}

// ---------------------------------------------------------------------------
// 变量
// ---------------------------------------------------------------------------
function variablesView() {
  const wrap = h('div', 'inspector-inner');
  const vars = store.state.template.variables ?? [];

  wrap.appendChild(hint('在文本/条码/单元格里写 {{变量名}} 即可绑定数据'));

  vars.forEach((v) => {
    const card = h('div', 'var-card');
    const name = h('input', 'form-input');
    name.value = v.name;
    name.addEventListener('change', () => {
      const nn = name.value.trim();
      if (!nn) return;
      commit(() => { v.name = nn; });
    });

    const lab = h('input', 'form-input');
    lab.value = v.label ?? '';
    lab.placeholder = '显示名';
    lab.addEventListener('change', () => commit(() => { v.label = lab.value; }));

    const def = h('input', 'form-input');
    def.value = v.defaultValue ?? '';
    def.placeholder = '示例值（设计态预览用）';
    def.addEventListener('change', () => commit(() => { v.defaultValue = def.value; }));

    const validSel = h('select', 'form-input');
    VAR_VALIDATIONS.forEach((o) => {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      validSel.appendChild(opt);
    });
    validSel.value = v.validation ?? '';
    validSel.addEventListener('change', () => commit(() => { v.validation = validSel.value; }));
    const ruleInput = h('input', 'form-input');
    ruleInput.value = v.regex ?? '';
    ruleInput.placeholder = '正则表达式，如 ^\\d{4}-\\d{4}$';
    ruleInput.style.display = v.validation === 'regex' ? '' : 'none';
    ruleInput.addEventListener('change', () => commit(() => { v.regex = ruleInput.value; }));
    validSel.addEventListener('change', () => {
      ruleInput.style.display = validSel.value === 'regex' ? '' : 'none';
    });

    const line2 = h('div', 'var-row');
    line2.appendChild(validSel);
    line2.appendChild(ruleInput);

    const reqWrap = h('label', 'form-check');
    const reqCb = h('input');
    reqCb.type = 'checkbox';
    reqCb.checked = !!v.required;
    reqCb.addEventListener('change', () => commit(() => { v.required = reqCb.checked; }));
    reqWrap.appendChild(reqCb);
    reqWrap.appendChild(Object.assign(document.createElement('span'), { textContent: '必填' }));

    const uniqueWrap = h('label', 'form-check');
    const uniqueCb = h('input');
    uniqueCb.type = 'checkbox';
    uniqueCb.checked = !!v.unique;
    uniqueCb.addEventListener('change', () => commit(() => { v.unique = uniqueCb.checked; }));
    uniqueWrap.appendChild(uniqueCb);
    uniqueWrap.appendChild(Object.assign(document.createElement('span'), { textContent: '唯一码' }));

    const del = btn('✕', () => commit(() => {
      store.state.template.variables = vars.filter((x) => x !== v);
    }), 'danger');

    const line1 = h('div', 'var-row');
    line1.appendChild(name);
    line1.appendChild(lab);
    line1.appendChild(del);

    const line3 = h('div', 'var-row');
    line3.appendChild(reqWrap);
    line3.appendChild(uniqueWrap);

    card.appendChild(line1);
    card.appendChild(def);
    card.appendChild(line2);
    card.appendChild(line3);
    card.appendChild(hint(`占位：{{${v.name}}}`));
    wrap.appendChild(card);
  });

  wrap.appendChild(btn('＋ 新增变量', () => {
    const n = prompt('变量名（英文/数字，如 orderNo）', 'field' + (vars.length + 1));
    if (!n) return;
    if (!/^[A-Za-z_][\w]*$/.test(n)) { alert('变量名只能由字母、数字、下划线组成，且以字母或下划线开头'); return; }
    if (vars.some((v) => v.name === n)) { alert('变量已存在'); return; }
    commit(() => { vars.push({ name: n, type: 'text', label: n, defaultValue: '' }); });
  }));

  return wrap;
}
