// 文本归一：去零宽/全角空格/BOM，避免客户 Excel 里看不见的字符导致编码对不上。
export function norm(v) {
  return String(v ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\u3000/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .trim();
}

export function isBlank(v) {
  return norm(v) === '';
}

export function pad2(n) { return String(n).padStart(2, '0'); }

/** 文件名安全化：用于报告文件命名 */
export function safeName(s) {
  return String(s).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 80);
}
