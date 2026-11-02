// =============================================================================
// render.js —— 元素渲染引擎（设计画布 与 打印输 共用，确保所见即所得）
//   · 屏幕：mm → CSS px（96dpi 基准），叠加画布缩放
//   · 打印：mm → mm、pt → pt，交给浏览器做物理尺寸映射
//   · 条码：JsBarcode 本地生成 SVG；二维码：QRCode 本地生成 SVG
// =============================================================================

import { MM2PX, escapeHtml, clamp } from './util.js';

const PXMM = MM2PX;

// ---------------------------------------------------------------------------
// 数据上下文
// ---------------------------------------------------------------------------
export function buildContext(template, row = {}, extra = {}) {
  return {
    row: row || {},
    vars: template.variables ?? [],
    pageNo: extra.pageNo ?? 1,
    pageTotal: extra.pageTotal ?? 1,
    copies: extra.copies ?? 1,
    serialNo: extra.serialNo ?? 1,
    now: extra.now ?? new Date(),
  };
}

function varValue(name, ctx) {
  if (ctx.row && Object.prototype.hasOwnProperty.call(ctx.row, name)) return ctx.row[name];
  const v = ctx.vars.find((x) => x.name === name);
  return v ? v.defaultValue ?? '' : '';
}

/** 文本插值：{{var}} → 值 */
export function interpolate(str, ctx) {
  return String(str ?? '').replace(/\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g, (_, name) => {
    const v = varValue(name, ctx);
    return v == null ? '' : String(v);
  });
}

/** 文本是否包含变量占位 */
export function hasPlaceholder(str) {
  return /\{\{[^}]+\}\}/.test(String(str ?? ''));
}

function pad(n, w) {
  return String(n).padStart(w, '0');
}

export function fmtDateTime(pattern, date) {
  const d = date || new Date();
  return String(pattern ?? '')
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/MM/g, pad(d.getMonth() + 1, 2))
    .replace(/DD/g, pad(d.getDate(), 2))
    .replace(/HH/g, pad(d.getHours(), 2))
    .replace(/mm/g, pad(d.getMinutes(), 2))
    .replace(/ss/g, pad(d.getSeconds(), 2));
}

export function sysvarValue(key, ctx) {
  const d = ctx.now || new Date();
  switch (key) {
    case 'printDate': return fmtDateTime('YYYY-MM-DD', d);
    case 'printTime': return fmtDateTime('HH:mm:ss', d);
    case 'pageNo': return String(ctx.pageNo ?? 1);
    case 'pageTotal': return String(ctx.pageTotal ?? 1);
    case 'printerName': return ctx.printerName ?? '未指定';
    case 'tenantName': return ctx.tenantName ?? '默认租户';
    case 'printUser': return ctx.printUser ?? 'admin';
    case 'uuid': return ctx.uuid ?? '—';
    default: return key;
  }
}

export function serialValue(spec, ctx) {
  const n = (ctx.serialNo ?? 1) + (ctx.serialOffset ?? 0);
  return `${spec.prefix ?? ''}${pad(n, spec.digits ?? 5)}${spec.suffix ?? ''}`;
}

// ---------------------------------------------------------------------------
// 公式求值（白名单递归下降解析，不使用 eval）
// ---------------------------------------------------------------------------
class FormulaError extends Error {}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ t: 'num', v: parseFloat(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') { out += src[j + 1]; j += 2; continue; }
        out += src[j]; j++;
      }
      tokens.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ t: 'ident', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.substr(i, 2);
    if (['>=', '<=', '==', '!=', '&&', '||'].includes(two)) {
      tokens.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/%()<>,!='.includes(c)) {
      tokens.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new FormulaError(`不支持字符: ${c}`);
  }
  return tokens;
}

const FN = {
  LEN: (s) => String(s ?? '').length,
  UPPER: (s) => String(s ?? '').toUpperCase(),
  LOWER: (s) => String(s ?? '').toLowerCase(),
  TRIM: (s) => String(s ?? '').trim(),
  LEFT: (s, n) => String(s ?? '').slice(0, Number(n) || 0),
  RIGHT: (s, n) => {
    const k = Number(n) || 0;
    return k <= 0 ? '' : String(s ?? '').slice(-k);
  },
  MID: (s, start, len) => String(s ?? '').substr((Number(start) || 1) - 1, Number(len) || 0),
  ROUND: (n, d = 0) => {
    const p = 10 ** (Number(d) || 0);
    return Math.round((Number(n) || 0) * p) / p;
  },
  INT: (n) => Math.floor(Number(n) || 0),
  ABS: (n) => Math.abs(Number(n) || 0),
  NUM: (s) => {
    const n = parseFloat(String(s ?? '').replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  },
  CONCAT: (...a) => a.map((x) => (x == null ? '' : String(x))).join(''),
  IF: (c, a, b) => (c ? a : b),
  PAD: (n, w) => pad(Number(n) || 0, Number(w) || 0),
};

function evalExpr(src, ctx) {
  // 变量替换：{{name}} → 字面量（数字或带引号字符串）
  const text = String(src ?? '').replace(/\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g, (_, name) => {
    const v = varValue(name, ctx);
    if (typeof v === 'number' && Number.isFinite(v)) return `(${v})`;
    const s = v == null ? '' : String(v);
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });

  const toks = tokenize(text);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (v) => {
    const t = toks[p];
    if (!t || t.v !== v) throw new FormulaError(`缺少 ${v}`);
    p++;
  };

  function primary() {
    const t = next();
    if (!t) throw new FormulaError('表达式不完整');
    if (t.t === 'num' || t.t === 'str') return t.v;
    if (t.t === 'op' && t.v === '(') {
      const v = expr();
      expect(')');
      return v;
    }
    if (t.t === 'op' && t.v === '-') return -Number(primary());
    if (t.t === 'op' && t.v === '+') return Number(primary());
    if (t.t === 'op' && t.v === '!') return !truthy(primary());
    if (t.t === 'ident') {
      const upper = t.v.toUpperCase();
      if (toks[p] && toks[p].v === '(') {
        p++;
        const args = [];
        if (toks[p] && toks[p].v !== ')') {
          args.push(expr());
          while (toks[p] && toks[p].v === ',') {
            p++;
            args.push(expr());
          }
        }
        expect(')');
        const fn = FN[upper];
        if (!fn) throw new FormulaError(`未知函数: ${t.v}`);
        return fn(...args);
      }
      if (upper === 'TRUE') return true;
      if (upper === 'FALSE') return false;
      throw new FormulaError(`未知标识: ${t.v}`);
    }
    throw new FormulaError(`语法错误: ${t.v}`);
  }

  function unary() { return primary(); }

  function mul() {
    let v = unary();
    while (toks[p] && toks[p].t === 'op' && ['*', '/', '%'].includes(toks[p].v)) {
      const op = next().v;
      const rhs = Number(unary());
      if (op === '*') v = Number(v) * rhs;
      else if (op === '/') v = rhs === 0 ? 0 : Number(v) / rhs;
      else v = rhs === 0 ? 0 : Number(v) % rhs;
    }
    return v;
  }

  function add() {
    let v = mul();
    while (toks[p] && toks[p].t === 'op' && ['+', '-'].includes(toks[p].v)) {
      const op = next().v;
      const rhs = mul();
      v = op === '+' ? v + rhs : Number(v) - Number(rhs);
    }
    return v;
  }

  function cmp() {
    let v = add();
    while (toks[p] && toks[p].t === 'op' && ['>', '<', '>=', '<=', '==', '!=', '='].includes(toks[p].v)) {
      const op = next().v;
      const rhs = add();
      switch (op) {
        case '>': v = Number(v) > Number(rhs); break;
        case '<': v = Number(v) < Number(rhs); break;
        case '>=': v = Number(v) >= Number(rhs); break;
        case '<=': v = Number(v) <= Number(rhs); break;
        case '!=': v = v !== rhs; break;
        default: v = v == rhs; // eslint-disable-line eqeqeq
      }
    }
    return v;
  }

  function truthy(v) {
    if (typeof v === 'string') return v.length > 0;
    return !!v;
  }

  function and() {
    let v = cmp();
    while (toks[p] && toks[p].t === 'op' && toks[p].v === '&&') {
      next();
      const rhs = cmp();
      v = truthy(v) && truthy(rhs);
    }
    return v;
  }

  function or() {
    let v = and();
    while (toks[p] && toks[p].t === 'op' && toks[p].v === '||') {
      next();
      const rhs = and();
      v = truthy(v) || truthy(rhs);
    }
    return v;
  }

  function expr() { return or(); }

  const out = expr();
  if (p < toks.length) throw new FormulaError('表达式存在多余内容');
  return out;
}

export function evalFormula(expr, ctx) {
  try {
    const v = evalExpr(expr, ctx);
    if (typeof v === 'number' && Number.isFinite(v)) {
      return Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : String(Number(v.toFixed(3)));
    }
    return String(v);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 条码 / 二维码（bwip-js 全码制，设计态与打印共用；SVG 缓存）
// ---------------------------------------------------------------------------
const CACHE = { qr: new Map(), bc: new Map() };

/** UI 码制 → bwip-js bcid */
const BWIP_MAP = {
  CODE128: 'code128', GS1_128: 'gs1-128', CODE39: 'code39', CODE93: 'code93',
  EAN13: 'ean13', EAN8: 'ean8', UPC: 'upca', UPC_A: 'upca', UPC_E: 'upce',
  ITF14: 'itf14', ITF: 'interleaved2of5', CODABAR: 'rationalizedCodabar',
  MSI: 'msi', PHARMACODE: 'pharmacode', CODE16K: 'code16k',
  QRCODE: 'qrcode', MICROQR: 'microqrcode', MICROQRCODE: 'microqrcode',
  DATAMATRIX: 'datamatrix', DATAMATRIX_RECT: 'datamatrixrectangular',
  PDF417: 'pdf417', AZTEC: 'azteccode', AZTECCODE: 'azteccode',
};

export function bcidOf(sym) {
  return BWIP_MAP[String(sym || '').toUpperCase()] ?? 'code128';
}

export function is2dSym(sym) {
  return /^(QR|MICRO|DATAMATRIX|PDF417|AZTEC)/i.test(String(sym || ''));
}

const BWIP_SVG_SCALE = 4;

/** 调用浏览器版 bwip-js 生成 SVG（失败返回 null） */
function bwipSvg(opts) {
  if (typeof window.bwipjs?.toSVG !== 'function') return null;
  try {
    return window.bwipjs.toSVG(opts);
  } catch (e) {
    console.warn('[bwip] 编码失败', e?.message || e);
    return null;
  }
}

/** 从 SVG viewBox 推算物理尺寸（mm） */
function svgMetrics(svgStr, moduleMm) {
  const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svgStr || '');
  const w = m ? parseFloat(m[1]) : 100;
  const h = m ? parseFloat(m[2]) : 40;
  const modules = Math.max(1, w / BWIP_SVG_SCALE);
  return { naturalWmm: modules * (moduleMm || 0.25), naturalHmm: h / BWIP_SVG_SCALE * (moduleMm || 0.25) };
}

/** 生成一维码 SVG（不内置明文，明文单独排版避免拉伸变形） */
function makeBarcodeSvg(spec, content) {
  const s = spec || {};
  const key = `${s.sym}|${content}|${s.moduleWidthMm}|${s.heightMm}|${s.wideRatio}|${s.includetext}`;
  if (CACHE.bc.has(key)) return CACHE.bc.get(key);

  const bcid = bcidOf(s.sym);
  const barHeightPx = Math.max(20, Math.round((s.heightMm ?? 9) * PXMM / (s.moduleWidthMm ?? 0.25)));
  const opts = {
    bcid,
    text: String(content ?? ''),
    scale: BWIP_SVG_SCALE,
    height: Math.round((s.heightMm ?? 9) / (s.moduleWidthMm ?? 0.25) * BWIP_SVG_SCALE) || barHeightPx,
    paddingwidth: 8,
    paddingheight: 4,
    backgroundcolor: 'FFFFFF',
    includetext: false,
  };
  if (s.wideRatio) opts.ratio = s.wideRatio;
  if (bcid === 'gs1-128') opts.parsefnc = true;

  const svgStr = bwipSvg(opts);
  if (svgStr) {
    const out = { svgStr, ...svgMetrics(svgStr, s.moduleWidthMm) };
    CACHE.bc.set(key, out);
    return out;
  }
  // 兜底：伪条码占位（不可扫，但保证布局）
  const w = Math.max(40, Math.round((s.moduleWidthMm ?? 0.25) * PXMM * 60));
  const h = Math.max(20, Math.round((s.heightMm ?? 9) * PXMM));
  let bars = '';
  let x = 0;
  let seed = 7;
  while (x < w) {
    seed = (seed * 73 + 17) % 101;
    const bw = 1 + (seed % 3);
    if (seed % 2 === 0) bars += `<rect x="${x}" y="0" width="${bw}" height="${h}" fill="#000"/>`;
    x += bw;
  }
  const out = {
    svgStr: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${bars}</svg>`,
    naturalWmm: w / PXMM,
    naturalHmm: h / PXMM,
  };
  CACHE.bc.set(key, out);
  return out;
}

/** 二维码/二维码 SVG（同步生成 + 缓存，缩略图/设计态/打印共用） */
function makeQrSvg(spec, content) {
  const s = spec || {};
  const key = `${s.sym}|${s.ecc}|${s.moduleSizeMm}|${s.quietZoneMm}|${content}`;
  if (CACHE.qr.has(key)) return CACHE.qr.get(key);

  const bcid = bcidOf(s.sym);
  const opts = {
    bcid,
    text: String(content ?? ''),
    scale: BWIP_SVG_SCALE,
    paddingwidth: 0,
    paddingheight: 0,
    backgroundcolor: 'FFFFFF',
  };
  if (bcid === 'qrcode' || bcid === 'microqrcode') opts.eclevel = s.ecc || 'M';
  if (bcid === 'pdf417') opts.compact = false;
  const svgStr = bwipSvg(opts);
  if (svgStr) {
    const metrics = svgMetrics(svgStr, s.moduleSizeMm ?? 0.4);
    const out = { svgStr, modules: Math.round(metrics.naturalWmm / (s.moduleSizeMm ?? 0.4)), naturalWmm: metrics.naturalWmm };
    CACHE.qr.set(key, out);
    return out;
  }
  // 兜底：灰底占位
  const n = 21;
  const out = {
    svgStr: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}"><rect width="${n}" height="${n}" fill="#eee"/><path d="M2 2h7v7h-7zM3 3h5v5h-5z" fill="#000" fill-rule="evenodd"/></svg>`,
    modules: n,
    naturalWmm: n * (s.moduleSizeMm ?? 0.4),
  };
  CACHE.qr.set(key, out);
  return out;
}

/** 把 svg 填入容器，等比缩放并居中（设计态二维码） */
function attachQr(holder, el, content) {
  const r = makeQrSvg(el.qrcode, content);
  holder.innerHTML = r.svgStr;
  const svg = holder.firstElementChild;
  if (svg) {
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.display = 'block';
  }
}

/** 一维码明文是否在上方 */
function showTextIsTop(spec) {
  return String(spec?.textPosition || 'bottom').toLowerCase() === 'top';
}

/** 一维码填充容器 + 可选明文（设计态/打印共用语义） */
function barcodeInnerHtml(spec, content, opts = {}) {
  const r = makeBarcodeSvg(spec, content);
  const showText = !!spec?.showText;
  const textSize = opts.textSizeCss || `${spec?.textFont?.size ?? 2.6}mm`;
  const svg = r.svgStr.replace('<svg ', '<svg preserveAspectRatio="none" style="width:100%;height:100%;display:block" ');
  const textHtml = showText
    ? `<div style="flex:0 0 auto;text-align:center;font-family:${spec?.textFont?.family || 'Arial'},sans-serif;font-size:${textSize};line-height:1.15;overflow:hidden;white-space:nowrap;">${escapeHtml(content)}</div>`
    : '';
  return { svg, textHtml, naturalWmm: r.naturalWmm };
}

// ----------------------------- 条码内容校验（前端预检） -----------------------------
const BC_RULES = {
  CODE128: { note: '支持 ASCII 全字符' },
  GS1_128: { note: '使用 (AI) 应用标识符，如 (01)12345678901231' },
  CODE39: { re: /^[0-9A-Za-z\-.$/+% ]*$/, note: '仅 0-9 A-Z a-z 及 - . $ / + % 空格' },
  CODE93: { note: '支持 ASCII 全字符' },
  CODE16K: { maxLen: 1500, note: 'Code 16K 多层码' },
  EAN13: { maxLen: 13, re: /^\d{12,13}$/, note: '12 位数字（第 13 位为校验位）' },
  EAN8: { maxLen: 8, re: /^\d{7,8}$/, note: '7 位数字（第 8 位为校验位）' },
  UPC: { maxLen: 12, re: /^\d{11,12}$/, note: '11 位数字（第 12 位为校验位）' },
  UPC_A: { maxLen: 12, re: /^\d{11,12}$/, note: '11 位数字（第 12 位为校验位）' },
  UPC_E: { maxLen: 8, re: /^\d{7,8}$/, note: '7 位数字（第 8 位为校验位）' },
  ITF14: { maxLen: 14, re: /^\d{13,14}$/, note: '13 位数字（GTIN-14）' },
  ITF: { re: /^\d+$/, note: '仅数字，偶数位' },
  CODABAR: { re: /^[0-9$:/.+\-]+$/, note: '数字及 $ : / . + -' },
  MSI: { re: /^\d+$/, note: '仅数字' },
  PHARMACODE: { re: /^\d+$/, note: '仅数字' },
  QRCODE: { maxLen: 2953, note: '建议 ≤ 2000 字符' },
  MICROQR: { maxLen: 500, note: 'Micro QR 建议 ≤ 300 字符' },
  MICROQRCODE: { maxLen: 500, note: 'Micro QR 建议 ≤ 300 字符' },
  DATAMATRIX: { maxLen: 2000, note: '建议 ≤ 1500 字符' },
  DATAMATRIX_RECT: { maxLen: 2000, note: '建议 ≤ 1500 字符' },
  PDF417: { maxLen: 1800, note: '建议 ≤ 1800 字符' },
  AZTEC: { maxLen: 1800, note: '建议 ≤ 1800 字符' },
};

/** 校验条码/二维码内容；含 {{变量}} 占位时不报错（运行期才有值） */
export function validateBarcodeText(sym, content) {
  const key = String(sym || '').toUpperCase();
  const r = BC_RULES[key];
  if (!r) return { ok: false, error: `不支持的码制：${sym}`, note: '' };
  const text = String(content ?? '');
  const hasVar = /\{\{[^}]+\}\}/.test(text);
  if (!text.trim()) return { ok: hasVar, error: hasVar ? '' : '内容为空', note: r.note ?? '' };
  if (hasVar) return { ok: true, note: r.note ?? '' };
  if (r.re && !r.re.test(text)) return { ok: false, error: `内容不符合 ${sym} 字符集（${r.note}）`, note: r.note ?? '' };
  if (r.maxLen && text.length > r.maxLen) return { ok: false, error: `内容超长，最大 ${r.maxLen} 字符`, note: r.note ?? '' };
  return { ok: true, note: r.note ?? '' };
}

/** 条码在指定模块宽下的自然宽度（mm），供预检提示 */
export function barcodeNaturalWidth(spec, content) {
  if (/\{\{[^}]+\}\}/.test(String(content ?? ''))) return null;
  return makeBarcodeSvg(spec, content).naturalWmm;
}

// ---------------------------------------------------------------------------
// 元素显示文本
// ---------------------------------------------------------------------------
export function elementText(el, ctx) {
  switch (el.type) {
    case 'text': return interpolate(el.text, ctx);
    case 'formula': {
      const v = evalFormula(el.formula?.expr ?? '', ctx);
      return v == null ? (el.formula?.defaultOnError || '#公式错误') : v;
    }
    case 'serial': return serialValue(el.serial ?? {}, ctx);
    case 'datetime': return fmtDateTime(el.datetime?.pattern, ctx.now);
    case 'sysvar': return sysvarValue(el.sysvar?.key, ctx);
    default: return '';
  }
}

// ---------------------------------------------------------------------------
// 设计态渲染（返回 DOM）
// ---------------------------------------------------------------------------

function fontCss(font, zoom) {
  const f = font || {};
  return {
    fontFamily: f.family || 'Arial',
    fontWeight: f.bold ? '700' : '400',
    fontStyle: f.italic ? 'italic' : 'normal',
    textDecoration: f.underline ? 'underline' : 'none',
    color: f.color || '#000',
    // pt → CSS px（96dpi 基准），再乘缩放
    fontSize: `${(f.size ?? 9) * (96 / 72) * zoom}px`,
    lineHeight: String(f.lineHeight ?? 1.15),
    letterSpacing: `${(f.letterSpacing ?? 0) * zoom}px`,
  };
}

function alignToJustify(a) {
  return a === 'center' ? 'center' : a === 'right' ? 'flex-end' : 'flex-start';
}
function valignToAlign(v) {
  return v === 'middle' ? 'center' : v === 'bottom' ? 'flex-end' : 'flex-start';
}

/** 文本内容（含占位高亮） */
function textInnerHtml(el, ctx) {
  const raw = el.type === 'text' ? String(el.text ?? '') : '';
  if (!raw) return escapeHtml(elementText(el, ctx));
  const parts = raw.split(/(\{\{[^}]+\}\})/g);
  return parts.map((p) => {
    if (!p) return '';
    if (/^\{\{[^}]+\}\}$/.test(p)) {
      const name = p.slice(2, -2).trim();
      const val = varValue(name, ctx);
      const shown = val === '' || val == null ? p : escapeHtml(String(val));
      return `<span class="ph" title="${escapeHtml(p)}">${shown}</span>`;
    }
    return escapeHtml(p);
  }).join('');
}

/** 手势期间局部刷新（避免整树重建带来的抖动/条码重绘） */
export function updateNodeBox(node, el, zoom) {
  applyBox(node, el, zoom);
}

function applyBox(node, el, zoom) {
  node.style.left = `${el.x * PXMM * zoom}px`;
  node.style.top = `${el.y * PXMM * zoom}px`;
  node.style.width = `${el.w * PXMM * zoom}px`;
  node.style.height = `${el.h * PXMM * zoom}px`;
  node.style.transform = el.rotation ? `rotate(${el.rotation}deg)` : '';
  node.style.opacity = el.opacity === undefined ? '' : String(el.opacity);
  node.style.zIndex = String(Math.round(el.zIndex ?? 1));
  if (el.locked) node.classList.add('locked');
  if (el.visible === false) node.classList.add('hidden-el');
}

/**
 * 渲染单个元素为 DOM 节点。
 * @param {object} el 元素
 * @param {object} opts { zoom, ctx }
 */
export function renderElement(el, opts) {
  const { zoom = 1, ctx } = opts;
  const node = document.createElement('div');
  node.className = `el el-${el.type}`;
  node.dataset.id = el.id;
  applyBox(node, el, zoom);

  switch (el.type) {
    case 'rect': {
      node.style.background = el.fill ?? '#fff';
      node.style.borderRadius = `${(el.cornerRadius ?? 0) * PXMM * zoom}px`;
      const s = el.stroke;
      if (s && s.width > 0) {
        node.style.border = `${Math.max(0.5, s.width * PXMM * zoom)}px ${s.style === 'dashed' ? 'dashed' : s.style === 'dotted' ? 'dotted' : 'solid'} ${s.color || '#333'}`;
      }
      break;
    }
    case 'ellipse': {
      node.style.background = el.fill ?? '#fff';
      node.style.borderRadius = '50%';
      const s = el.stroke;
      if (s && s.width > 0) {
        node.style.border = `${Math.max(0.5, s.width * PXMM * zoom)}px ${s.style === 'dashed' ? 'dashed' : s.style === 'dotted' ? 'dotted' : 'solid'} ${s.color || '#333'}`;
      }
      break;
    }
    case 'line': {
      // 直线用 SVG 画，保证任意角度/线型
      const dx = (el.x2 ?? el.x) - el.x;
      const dy = (el.y2 ?? el.y) - el.y;
      const w = Math.max(Math.abs(dx), 0.3) * PXMM * zoom;
      const h = Math.max(Math.abs(dy), 0.3) * PXMM * zoom;
      node.style.width = `${w}px`;
      node.style.height = `${h}px`;
      node.style.left = `${Math.min(el.x, el.x2 ?? el.x) * PXMM * zoom}px`;
      node.style.top = `${Math.min(el.y, el.y2 ?? el.y) * PXMM * zoom}px`;
      node.style.overflow = 'visible';
      const sw = Math.max(0.6, (el.stroke?.width ?? 0.3) * PXMM * zoom);
      const x1 = dx < 0 ? w : 0;
      const y1 = dy < 0 ? h : 0;
      const x2 = dx < 0 ? 0 : w;
      const y2 = dy < 0 ? 0 : h;
      node.innerHTML = `<svg width="100%" height="100%" style="overflow:visible;display:block">
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
          stroke="${escapeHtml(el.stroke?.color || '#333')}" stroke-width="${sw}"
          stroke-linecap="round"
          ${el.stroke?.style === 'dashed' ? `stroke-dasharray="${sw * 4} ${sw * 3}"` : ''}
          ${el.stroke?.style === 'dotted' ? `stroke-dasharray="${sw} ${sw * 2}"` : ''} />
      </svg>`;
      break;
    }
    case 'table': {
      const rows = Math.max(1, el.rows || 1);
      const cols = Math.max(1, el.cols || 1);
      const bw = Math.max(0.5, (el.borderWidth ?? 0.2) * PXMM * zoom);
      const bc = el.borderColor || '#333';
      const f = fontCss(el.font, zoom);
      node.style.display = 'grid';
      node.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      node.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
      node.style.border = el.showBorder === false ? 'none' : `${bw}px solid ${bc}`;
      node.style.overflow = 'hidden';
      node.style.background = '#fff';
      let html = '';
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const raw = el.cells?.[idx] ?? '';
          const isHeader = !!el.headerRow && r === 0;
          const borders = el.showBorder === false ? '' :
            `border-right:${c < cols - 1 ? `${bw}px solid ${bc}` : 'none'};border-bottom:${r < rows - 1 ? `${bw}px solid ${bc}` : 'none'};`;
          html += `<div style="display:flex;align-items:center;justify-content:${alignToJustify(el.font?.align)};padding:0 2px;overflow:hidden;
            ${borders}
            background:${isHeader ? (el.headerBg || '#f2f2f2') : 'transparent'};
            font-family:${f.fontFamily};font-size:${f.fontSize};font-weight:${isHeader ? '700' : f.fontWeight};
            color:${f.color};white-space:nowrap;text-overflow:ellipsis;">${textInnerHtmlForCell(raw, ctx)}</div>`;
        }
      }
      node.innerHTML = html;
      break;
    }
    case 'image': {
      if (el.src) {
        const img = document.createElement('img');
        img.src = el.src;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'contain';
        img.draggable = false;
        node.appendChild(img);
      } else {
        node.innerHTML = `<div class="img-ph">🖼<span>未设置图片<br>右侧属性面板粘贴 data URL</span></div>`;
        node.style.display = 'flex';
        node.style.alignItems = 'center';
        node.style.justifyContent = 'center';
        node.style.border = '1px dashed #b9c4d4';
        node.style.background = '#f7f9fc';
        node.style.color = '#8a94a6';
        node.style.fontSize = `${9 * zoom}px`;
        node.style.textAlign = 'center';
      }
      break;
    }
    case 'barcode': {
      const content = interpolate(el.barcode?.content ?? '', ctx);
      const r = barcodeInnerHtml(el.barcode, content, { textSizeCss: `${(el.barcode?.textFont?.size ?? 2.6) * zoom}px` });
      node.style.display = 'flex';
      node.style.flexDirection = showTextIsTop(el.barcode) ? 'column-reverse' : 'column';
      node.style.overflow = 'hidden';
      const holder = document.createElement('div');
      holder.style.flex = '1 1 auto';
      holder.style.minHeight = '0';
      holder.innerHTML = r.svg;
      node.appendChild(holder);
      if (r.textHtml) {
        const t = document.createElement('div');
        t.style.flex = '0 0 auto';
        t.innerHTML = r.textHtml;
        const inner = t.firstElementChild;
        if (inner) inner.style.fontSize = `${(el.barcode?.textFont?.size ?? 2.6) * zoom}px`;
        node.appendChild(inner || t);
      }
      node.dataset.naturalWmm = String(Math.round(r.naturalWmm * 10) / 10);
      if (r.naturalWmm > (el.w ?? 40) + 0.01) {
        node.dataset.warn = `条码自然宽度 ${r.naturalWmm.toFixed(1)}mm > 元素宽度 ${el.w}mm`;
      }
      break;
    }
    case 'qrcode': {
      const content = interpolate(el.qrcode?.content ?? '', ctx);
      node.style.display = 'flex';
      node.style.alignItems = 'center';
      node.style.justifyContent = 'center';
      const holder = document.createElement('div');
      holder.style.width = '100%';
      holder.style.height = '100%';
      holder.style.boxSizing = 'border-box';
      const quiet = Math.max(0, el.qrcode?.quietZoneMm ?? 1) * PXMM * zoom;
      if (quiet > 0) holder.style.padding = `${quiet}px`;
      node.appendChild(holder);
      attachQr(holder, el, content);
      break;
    }
    default: {
      // text / formula / serial / datetime / sysvar
      const f = fontCss(el.font, zoom);
      node.style.display = 'flex';
      node.style.alignItems = valignToAlign(el.font?.vAlign);
      node.style.justifyContent = alignToJustify(el.font?.align);
      node.style.overflow = 'hidden';
      const inner = document.createElement('div');
      inner.className = 'el-text-inner';
      inner.style.width = '100%';
      Object.assign(inner.style, f);
      inner.style.whiteSpace = el.font?.wrap === false ? 'nowrap' : 'pre-wrap';
      inner.style.textAlign = el.font?.align || 'left';
      inner.style.overflow = 'hidden';
      inner.innerHTML = textInnerHtml(el, ctx);
      node.appendChild(inner);
      if (el.type !== 'text') node.dataset.kind = el.type;
    }
  }

  if (el.name) node.title = el.name;
  return node;
}

function textInnerHtmlForCell(raw, ctx) {
  const parts = String(raw ?? '').split(/(\{\{[^}]+\}\})/g);
  return parts.map((p) => {
    if (!p) return '';
    if (/^\{\{[^}]+\}\}$/.test(p)) {
      const name = p.slice(2, -2).trim();
      const val = varValue(name, ctx);
      return `<span class="ph">${escapeHtml(val === '' || val == null ? p : String(val))}</span>`;
    }
    return escapeHtml(p);
  }).join('');
}

// ---------------------------------------------------------------------------
// 打印态渲染（生成 HTML 字符串，单位 mm / pt）
// ---------------------------------------------------------------------------
function printFontCss(font) {
  const f = font || {};
  return `font-family:${cssFont(f.family || 'Arial')};font-size:${f.size ?? 9}pt;` +
    `font-weight:${f.bold ? 700 : 400};font-style:${f.italic ? 'italic' : 'normal'};` +
    `text-decoration:${f.underline ? 'underline' : 'none'};color:${f.color || '#000'};` +
    `line-height:${f.lineHeight ?? 1.15};` +
    (f.letterSpacing ? `letter-spacing:${f.letterSpacing}pt;` : '');
}

function cssFont(family) {
  // 注意：该结果会写进 style="..." 属性里，只能用单引号，避免破坏属性结构
  const safe = String(family || 'Arial').replace(/["'<>]/g, '');
  return `'${safe}', sans-serif`;
}

function printBoxStyle(el) {
  const r = el.rotation ? `transform:rotate(${el.rotation}deg);transform-origin:center center;` : '';
  return `position:absolute;left:${el.x}mm;top:${el.y}mm;width:${el.w}mm;height:${el.h}mm;` +
    `z-index:${Math.round(el.zIndex ?? 1)};` +
    (el.opacity !== undefined && el.opacity !== 1 ? `opacity:${el.opacity};` : '') + r;
}

async function printElement(el, ctx) {
  const st = printBoxStyle(el);
  switch (el.type) {
    case 'rect': {
      const border = el.stroke && el.stroke.width > 0
        ? `border:${el.stroke.width}mm ${el.stroke.style || 'solid'} ${el.stroke.color || '#333'};`
        : 'border:none;';
      return `<div style="${st}background:${el.fill ?? '#fff'};border-radius:${el.cornerRadius ?? 0}mm;${border}"></div>`;
    }
    case 'ellipse': {
      const border = el.stroke && el.stroke.width > 0
        ? `border:${el.stroke.width}mm ${el.stroke.style || 'solid'} ${el.stroke.color || '#333'};`
        : 'border:none;';
      return `<div style="${st}background:${el.fill ?? '#fff'};border-radius:50%;${border}"></div>`;
    }
    case 'line': {
      const dx = (el.x2 ?? el.x) - el.x;
      const dy = (el.y2 ?? el.y) - el.y;
      const len = Math.hypot(dx, dy);
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      const sw = el.stroke?.width ?? 0.3;
      const dash = el.stroke?.style === 'dashed' ? 'stroke-dasharray="0.8 0.6"' :
        el.stroke?.style === 'dotted' ? 'stroke-dasharray="0.2 0.4"' : '';
      return `<div style="position:absolute;left:${el.x}mm;top:${el.y}mm;width:${len}mm;height:${sw}mm;
        transform:rotate(${angle}deg);transform-origin:0 50%;z-index:${Math.round(el.zIndex ?? 1)};">
        <svg width="${len}mm" height="${sw * 3}mm" viewBox="0 0 ${len} ${sw * 3}" preserveAspectRatio="none" style="overflow:visible;display:block">
          <line x1="0" y1="${sw * 1.5}" x2="${len}" y2="${sw * 1.5}" stroke="${el.stroke?.color || '#333'}" stroke-width="${sw}" ${dash} />
        </svg></div>`;
    }
    case 'table': {
      const rows = Math.max(1, el.rows || 1);
      const cols = Math.max(1, el.cols || 1);
      const bw = el.showBorder === false ? 0 : (el.borderWidth ?? 0.2);
      const bc = el.borderColor || '#333';
      let cells = '';
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const raw = el.cells?.[idx] ?? '';
          const isHeader = !!el.headerRow && r === 0;
          cells += `<div style="display:flex;align-items:center;justify-content:${alignToJustify(el.font?.align)};
            padding:0 0.4mm;overflow:hidden;${printFontCss(el.font)}${isHeader ? 'font-weight:700;' : ''}
            ${isHeader ? `background:${el.headerBg || '#f2f2f2'};` : ''}
            ${bw ? `border-right:${c < cols - 1 ? `${bw}mm solid ${bc}` : 'none'};border-bottom:${r < rows - 1 ? `${bw}mm solid ${bc}` : 'none'}` : ''};">
            ${interpolateCellHtml(raw, ctx)}</div>`;
        }
      }
      return `<div style="${st}display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr);
        background:#fff;${bw ? `border:${bw}mm solid ${bc};` : ''}overflow:hidden;">${cells}</div>`;
    }
    case 'image': {
      if (!el.src) return '';
      return `<div style="${st}"><img src="${escapeHtml(el.src)}" style="width:100%;height:100%;object-fit:contain;display:block" /></div>`;
    }
    case 'barcode': {
      const content = interpolate(el.barcode?.content ?? '', ctx);
      const r = barcodeInnerHtml(el.barcode, content);
      const dir = showTextIsTop(el.barcode) ? 'column-reverse' : 'column';
      return `<div style="position:absolute;left:${el.x}mm;top:${el.y}mm;width:${el.w}mm;height:${el.h}mm;
        z-index:${Math.round(el.zIndex ?? 1)};display:flex;flex-direction:${dir};overflow:hidden;">
        <div style="flex:1 1 auto;min-height:0;">${r.svg}</div>${r.textHtml}</div>`;
    }
    case 'qrcode': {
      const content = interpolate(el.qrcode?.content ?? '', ctx);
      if (!content) return '';
      const r = await makeQrSvg(el.qrcode, content);
      const quiet = Math.max(0, el.qrcode?.quietZoneMm ?? 1);
      const size = Math.max(4, Math.min(el.w, el.h) - quiet * 2);
      const off = { x: (el.w - size) / 2, y: (el.h - size) / 2 };
      const svg = r.svgStr.replace('<svg ', '<svg preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block" ');
      return `<div style="position:absolute;left:${el.x + off.x}mm;top:${el.y + off.y}mm;width:${size}mm;height:${size}mm;
        z-index:${Math.round(el.zIndex ?? 1)};">${svg}</div>`;
    }
    default: {
      const align = el.font?.align || 'left';
      const vAlign = el.font?.vAlign || 'middle';
      const txt = escapeHtml(elementText(el, ctx));
      return `<div style="${st}display:flex;align-items:${valignToAlign(vAlign)};justify-content:${alignToJustify(align)};overflow:hidden;">
        <div style="${printFontCss(el.font)}width:100%;white-space:${el.font?.wrap === false ? 'nowrap' : 'pre-wrap'};text-align:${align};">${txt}</div></div>`;
    }
  }
}

function interpolateCellHtml(raw, ctx) {
  return String(raw ?? '').split(/(\{\{[^}]+\}\})/g).map((p) => {
    if (!p) return '';
    if (/^\{\{[^}]+\}\}$/.test(p)) return escapeHtml(interpolate(p, ctx));
    return escapeHtml(p);
  }).join('');
}

/**
 * 生成可打印 HTML。
 * @param {object} template 模板
 * @param {Array} rows 数据行
 * @param {object} opts { copies, serialStart, title }
 * @returns {Promise<string>}
 */
export async function buildPrintHtml(template, rows, opts = {}) {
  const page = template.page;
  const data = (rows && rows.length ? rows : [{}]);
  const copies = Math.max(1, opts.copies ?? 1);
  const labelCount = data.length * copies;
  const labels = [];
  let serial = opts.serialStart ?? 1;

  for (const row of data) {
    for (let c = 0; c < copies; c++) {
      const ctx = buildContext(template, row, { pageNo: labels.length + 1, pageTotal: labelCount, serialNo: serial, copies, uuid: opts.uuid });
      const visible = template.elements
        .filter((e) => e.visible !== false)
        .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
      const parts = [];
      for (const el of visible) {
        if (el.printIf && el.printIf.trim()) {
          const cond = evalFormula(el.printIf.replace(/\{\{[^}]+\}\}/g, (m) => m), ctx);
          if (cond === 'false' || cond === '0' || cond === null) continue;
        }
        parts.push(await printElement(el, ctx));
      }
      labels.push(`<div class="label">${parts.join('')}</div>`);
      serial++;
    }
  }

  // 拼版 / 多联：一页排 cols × rows 张，页尺寸按标签+间距+边距推算
  const cols = Math.max(1, Math.round(page.columns ?? 1));
  const rowsN = Math.max(1, Math.round(page.rows ?? 1));
  const gapX = Math.max(0, page.gapXMm ?? 2);
  const gapY = Math.max(0, page.gapYMm ?? 2);
  const margin = Math.max(0, page.marginMm ?? 0);
  const labelW = page.widthMm;
  const labelH = page.heightMm;
  const sheetW = cols > 1 ? margin * 2 + labelW * cols + gapX * (cols - 1) : labelW;
  const sheetH = rowsN > 1 ? margin * 2 + labelH * rowsN + gapY * (rowsN - 1) : labelH;
  const imposed = cols > 1 || rowsN > 1;

  let body = labels.join('');
  if (imposed) {
    const perSheet = cols * rowsN;
    const sheets = [];
    for (let i = 0; i < labels.length; i += perSheet) {
      const cells = labels.slice(i, i + perSheet)
        .map((l) => `<div class="slot">${l}</div>`).join('');
      sheets.push(`<div class="sheet">${cells}</div>`);
    }
    body = sheets.join('');
  }

  const sheetCss = imposed ? `
  .sheet { display: grid; grid-template-columns: repeat(${cols}, ${labelW}mm); grid-auto-rows: ${labelH}mm;
    gap: ${gapY}mm ${gapX}mm; padding: ${margin}mm; page-break-after: always; break-after: page; background: #fff; }
  .sheet:last-child { page-break-after: auto; break-after: auto; }
  .sheet .label { page-break-after: auto; break-after: auto; }
` : '';

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(opts.title || 'LabelFlow 打印')}</title>
<style>
  @page { size: ${sheetW}mm ${sheetH}mm; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .label { position: relative; width: ${labelW}mm; height: ${labelH}mm; overflow: hidden; background: #fff;
    page-break-after: always; break-after: page; }
  .label:last-child { page-break-after: auto; break-after: auto; }
  ${sheetCss}
  @media screen { body { padding: 12px; background: #e9edf3; } .label, .sheet { margin: 0 auto ${imposed ? 18 : 12}px; box-shadow: 0 2px 8px rgba(0,0,0,.15); } }
</style></head>
<body>${body}</body></html>`;
}
