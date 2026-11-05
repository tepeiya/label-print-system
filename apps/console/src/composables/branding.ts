// =============================================================================
// 白标（D6）主题注入：把后端解析出的品牌应用到当前文档上
//
// 三条实现约束（改这里之前先看）：
//  1. **只用 CSS 变量，不注入自由 CSS**。后端 sanitizeBranding 已经限制成 `--小写名: 值`，
//     这里再过滤一遍（cssVarsToObject 的白名单），双保险。
//  2. Element Plus 的主色是一组派生变量（light-3/5/7/8/9、dark-2），只覆盖 --el-color-primary
//     会让 hover/禁用态还是老颜色，看着像「换色失败」。所以按比例混色一起写。
//  3. 解析失败/没命中域名 → 必须回到出厂外观，不能留半套颜色。clearBranding() 负责这件事。
// =============================================================================
import { ref } from 'vue';
import { apiPublicBranding, type PublicBranding } from '@/api/branding';

const DEFAULT_TITLE = 'LabelFlow 标签打印';
const DEFAULT_LOGO = '';

/** 全局可读的品牌状态（登录页文案、侧栏标题都读它） */
export const branding = ref<PublicBranding | null>(null);
export const brandingLoaded = ref(false);

function normalizeHex(c?: string | null): string | null {
  if (!c) return null;
  const s = c.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

/** 与白色按 ratio 混合（ratio=0.3 → 30% 白），派生 EP 的 light-* */
function lighten(hex: string, ratio: number): string {
  const n = normalizeHex(hex);
  if (!n) return hex;
  const v = [1, 3, 5].map((i) => Math.round(parseInt(n.slice(i, i + 2), 16) * (1 - ratio) + 255 * ratio));
  return `#${v.map((x) => Math.min(255, Math.max(0, x)).toString(16).padStart(2, '0')).join('')}`;
}

/** 与黑色混合，派生 EP 的 dark-2 */
function darken(hex: string, ratio: number): string {
  const n = normalizeHex(hex);
  if (!n) return hex;
  const v = [1, 3, 5].map((i) => Math.round(parseInt(n.slice(i, i + 2), 16) * (1 - ratio)));
  return `#${v.map((x) => Math.min(255, Math.max(0, x)).toString(16).padStart(2, '0')).join('')}`;
}

function setVar(name: string, value: string | null) {
  if (value) document.documentElement.style.setProperty(name, value);
  else document.documentElement.style.removeProperty(name);
}

const EP_PRIMARY_DERIVED: Array<[string, number, boolean]> = [
  ['--el-color-primary-light-3', 0.3, true],
  ['--el-color-primary-light-5', 0.5, true],
  ['--el-color-primary-light-7', 0.7, true],
  ['--el-color-primary-light-8', 0.8, true],
  ['--el-color-primary-light-9', 0.9, true],
  ['--el-color-primary-dark-2', 0.2, false],
];

/** 恢复出厂外观（清掉所有品牌变量、标题、favicon） */
export function clearBranding() {
  setVar('--el-color-primary', null);
  for (const [name] of EP_PRIMARY_DERIVED) setVar(name, null);
  setVar('--lf-page-bg', null);
  const b = branding.value;
  if (b) for (const k of Object.keys(b.cssVars || {})) setVar(k, null);
  branding.value = null;
  document.title = DEFAULT_TITLE;
  applyFavicon('');
}

function applyFavicon(url: string) {
  let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  if (url) link.href = url;
  // 没有自定义 favicon 时不动：清掉会让浏览器回退到 /favicon.ico 触发一次 404
}

/** 把一份品牌配置真正刷到文档上 */
export function applyBranding(b: PublicBranding | null) {
  const prev = branding.value;
  // 先撤掉上一套自定义变量，避免租户 A 切到「无品牌」时残留
  if (prev) for (const k of Object.keys(prev.cssVars || {})) setVar(k, null);

  branding.value = b;
  if (!b) {
    clearBranding();
    return;
  }
  const primary = normalizeHex(b.primaryColor);
  setVar('--el-color-primary', primary);
  if (primary) for (const [name, ratio, isLight] of EP_PRIMARY_DERIVED) {
    setVar(name, isLight ? lighten(primary, ratio) : darken(primary, ratio));
  }
  setVar('--lf-page-bg', normalizeHex(b.backgroundColor));
  for (const [k, v] of Object.entries(b.cssVars || {})) {
    if (/^--[a-z][a-z0-9-]{0,30}$/.test(k) && v && !/[}"'\\]|url\(/i.test(v)) setVar(k, String(v));
  }
  document.title = b.appName || DEFAULT_TITLE;
  applyFavicon(b.faviconUrl || '');
}

/**
 * 启动时拉一次公开品牌。
 * 不 await：拉不到就用出厂外观，不能让白标把首屏阻塞掉。
 * 返回 Promise 只是为了登录页可以「等它好了再决定要不要显示租户输入框」。
 */
export async function loadBranding(): Promise<PublicBranding | null> {
  const res = await apiPublicBranding();
  applyBranding(res?.matched ? res.branding : null);
  brandingLoaded.value = true;
  return branding.value;
}

/** 设置页保存成功后，用最新配置立刻回显（不用刷新页面） */
export function previewFromMyBranding(b: Record<string, string>, tenantCode = '', tenantName = '') {
  applyBranding({
    tenantId: 0, tenantCode, tenantName, matchedDomain: '',
    appName: b.appName || tenantName || DEFAULT_TITLE,
    logoUrl: b.logoUrl || DEFAULT_LOGO || null,
    faviconUrl: b.faviconUrl || null,
    primaryColor: b.primaryColor || null,
    backgroundColor: b.backgroundColor || null,
    loginNotice: b.loginNotice || null,
    cssVars: Object.fromEntries(
      String(b.customCssVars || '').split(';')
        .map((s) => s.trim()).filter(Boolean)
        .map((s) => [s.slice(0, s.indexOf(':')).trim(), s.slice(s.indexOf(':') + 1).trim()])
        .filter((p) => p.length === 2 && /^--[a-z][a-z0-9-]{0,30}$/.test(p[0])),
    ),
  });
}
