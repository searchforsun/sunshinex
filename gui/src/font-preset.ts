/**
 * 字体预设(2026-10-26 用户裁定·全局管线版):四预设风格发散——default 紧凑(系统黑体,出厂)/
 * serif 衬线阅读(宋体·Georgia)/mono 终端等宽(Cascadia 全局)/roomy 宽松(黑体+现代等宽+大行距)。
 *
 * 全局管线:预设落根内联字族与排版令牌——--font-ui(界面字族,全 GUI 无衬线位消费)/
 * --font-mono(等宽字族)/--f-base-lh(body 基础行高);字号不归预设(2026-11-07 用户裁定:
 * 界面字号/代码字号为外观独立两项,font-size.ts 独占 --f-base-size/--fz/--f-code);
 * 聊天正文的段距/工具/代码尺寸等既有 --f-* 细部令牌随预设同落。default 清空全部内联,
 * 样式表缺省值接管=零漂移。
 *
 * 覆盖面(2026-10-31 用户裁定「除浏览器外网页外全跟随」):聊天正文/思考/工具行、代码块卡、
 * 工具内 md/exec 命令、自绘 diff 行、文件 md 预览、Monaco 源码/DiffEditor、xterm 终端、
 * 设置 raw 编辑器、mermaid 图文——浏览器 Web 标签 iframe 外内容不入管线。
 *
 * 持久与主题/缩放同通路:localStorage 即时层 + /app/gui-state 公共档双写(ui-pref-sync)。
 */

export type FontPreset = 'default' | 'serif' | 'mono' | 'roomy';

import { notifyUiPref } from './ui-pref-sync';

const KEY = 'sunshinex.font-preset';

const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif`;
const SERIF = `Georgia, 'Times New Roman', 'Source Han Serif SC', 'Noto Serif SC', 'SimSun', serif`;
// mono 栈补 CJK 回退(2026-10-31 用户报障「选择图片字体是全局漏网之鱼」):等宽栈全为拉丁字族,
// 中文字符落到浏览器缺省(Windows=宋体衬线)即「字体逃逸」——generic 前插雅黑,CJK 走黑体、拉丁仍等宽
const MODERN_MONO = `'Cascadia Mono', 'JetBrains Mono', ui-monospace, 'SF Mono', consolas, 'Microsoft YaHei', monospace`;
const SYSTEM_MONO = `ui-monospace, SFMono-Regular, 'SF Mono', menlo, consolas, 'Liberation Mono', 'Microsoft YaHei', monospace`;

/** 预设→CSS 变量表(根内联;未列出的变量在切换时移除,回落样式表缺省)。
 *  --font-ui/--font-mono/--f-base-size/--f-base-lh=全局管线令牌;--f-*=聊天排版细部 */
const PRESETS: Record<FontPreset, Record<string, string>> = {
  default: {},
  serif: {
    '--font-ui': SERIF,
    '--font-mono': SYSTEM_MONO,
    '--f-base-lh': '1.75',
    '--f-para-gap': '12px',
    '--f-body-lh': '1.8',
    '--f-tool': '14px',
    '--f-tool-lh': '1.55',
    '--f-code-lh': '1.6',
    '--f-code-pad': '8px 12px',
    '--f-think-lh': '1.7',
  },
  mono: {
    '--font-ui': MODERN_MONO,
    '--font-mono': MODERN_MONO,
    '--f-base-lh': '1.6',
    '--f-para-gap': '10px',
    '--f-body-lh': '1.65',
    '--f-tool': '14px',
    '--f-tool-lh': '1.5',
    '--f-code-lh': '1.55',
    '--f-code-pad': '8px 12px',
    '--f-think-lh': '1.6',
  },
  roomy: {
    '--font-ui': SANS,
    '--font-mono': MODERN_MONO,
    '--f-base-lh': '1.75',
    '--f-para-gap': '14px',
    '--f-body-lh': '1.75',
    '--f-tool': '14px',
    '--f-tool-lh': '1.55',
    '--f-code-lh': '1.65',
    '--f-code-pad': '10px 14px',
    '--f-think-lh': '1.7',
  },
};

/** 全变量并集(default 清空用) */
const ALL_VARS = [...new Set(Object.values(PRESETS).flatMap((v) => Object.keys(v)))];

/** 设置卡展示名单单源(2026-10-27 技术债轮 D55②:值×双语标签原散 SettingsForm,加预设须两处同步
 *  无锁——收编本件后加预设只改此处;标签 {en,zh} 数据形态,渲染期 t() 求值消费) */
export const FONT_PRESET_CHOICES: ReadonlyArray<{ v: FontPreset; l: { en: string; zh: string } }> = [
  { v: 'default', l: { en: 'Default', zh: '默认' } },
  { v: 'serif', l: { en: 'Serif reading', zh: '衬线阅读' } },
  { v: 'mono', l: { en: 'Terminal mono', zh: '终端等宽' } },
  { v: 'roomy', l: { en: 'Roomy', zh: '宽松' } },
];

export function readFontPreset(): FontPreset {
  try {
    const v = localStorage.getItem(KEY);
    // 旧档迁移:首版发散不足的 cozy/cozyMono 就近映射新四款
    if (v === 'serif' || v === 'mono' || v === 'roomy') return v;
    if (v === 'cozyMono') return 'mono';
    if (v === 'cozy') return 'roomy';
    return 'default';
  } catch {
    return 'default';
  }
}

export function applyFontPreset(p: FontPreset): void {
  notifyUiPref('fontPreset', p);
  const rootStyle = document.documentElement.style;
  const vars = PRESETS[p];
  for (const name of ALL_VARS) {
    const v = vars[name];
    if (v === undefined) rootStyle.removeProperty(name);
    else rootStyle.setProperty(name, v);
  }
  // 非 CSS 消费方(xterm canvas 等)变更信号:字族/字号取值面自行重读并热更
  window.dispatchEvent(new CustomEvent('sunshinex:font-preset'));
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* 隐私模式等持久化失败:仅内存态生效,不阻断 */
  }
}

/** 终端字体规格(2026-10-29 用户裁定「终端可控也跟随预设」):family=当前生效 --font-mono
 *  (含 default 预设的 :root 缺省,computed 读取统一两源),size=--f-code 数值(px,失败 12)。
 *  xterm canvas 接 CSS 变量字符串不解析,须经此取实值。 */
export function terminalFontSpec(): { family: string; size: number } {
  let family = '';
  let size = 12;
  try {
    const cs = getComputedStyle(document.documentElement);
    family = cs.getPropertyValue('--font-mono').trim();
    size = parseFloat(cs.getPropertyValue('--f-code')) || 12;
  } catch {
    /* 非浏览器环境守卫:回落 xterm 缺省 */
  }
  return { family: family || 'monospace', size };
}

/** 代码字号 px(2026-10-29 字体预设一致性面):Monaco 等非 CSS 数字消费方读取
 *  --f-code 当前生效值(代码字号设置,缺省 12)。 */
export function codeFontSize(): number {
  try {
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--f-code')) || 12;
  } catch {
    return 12;
  }
}

/** 代码等宽字族(Monaco/热更面):取当前生效 --font-mono(含 default 的 :root 缺省)。 */
export function codeFontFamily(): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace';
  } catch {
    return 'monospace';
  }
}

/** 代码行高 px(Monaco lineHeight):--f-code × --f-code-lh(缺省 1.55)——与 diff 面/raw 编辑器同口径;
 *  md 代码块不随预设(行距钉 1.5,2026-11-07 用户裁定五轮)。 */
export function codeLineHeightPx(): number {
  let lh = 1.55;
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--f-code-lh').trim();
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n > 0) lh = n;
  } catch {
    /* 非浏览器守卫 */
  }
  return Math.round(codeFontSize() * lh);
}

/** Monaco 等宽面三项(挂载+sunshinex:font-preset 热更共用)。 */
export function monacoCodeFontOptions(): { fontSize: number; fontFamily: string; lineHeight: number } {
  return { fontSize: codeFontSize(), fontFamily: codeFontFamily(), lineHeight: codeLineHeightPx() };
}

/** 设置页预览卡消费:预设的变量表原样给 UI(卡片内联样式直映) */
export function presetVars(p: FontPreset): Record<string, string> {
  return PRESETS[p];
}
