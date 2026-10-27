/**
 * 字体预设(2026-10-26 用户裁定·全局管线版):四预设风格发散——default 紧凑(系统黑体,出厂)/
 * serif 衬线阅读(宋体·Georgia)/mono 终端等宽(Cascadia 全局)/roomy 宽松(黑体+现代等宽+大字)。
 *
 * 全局管线:预设落根内联的四个全局令牌——--font-ui(界面字族,全 GUI 无衬线位消费)/
 * --font-mono(等宽字族)/--f-base-size·--f-base-lh(body 基础排版,全 UI 字号行高从它派生);
 * 聊天正文的段距/工具/代码尺寸等既有 --f-* 细部令牌随预设同落。default 清空全部内联,
 * 样式表缺省值接管=零漂移。
 *
 * 持久与主题/缩放同通路:localStorage 即时层 + /app/gui-state 公共档双写(ui-pref-sync)。
 */

export type FontPreset = 'default' | 'serif' | 'mono' | 'roomy';

import { notifyUiPref } from './ui-pref-sync';

const KEY = 'sunshinex.font-preset';

const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif`;
const SERIF = `Georgia, 'Times New Roman', 'Source Han Serif SC', 'Noto Serif SC', 'SimSun', serif`;
const MODERN_MONO = `'Cascadia Mono', 'JetBrains Mono', ui-monospace, 'SF Mono', consolas, monospace`;
const SYSTEM_MONO = `ui-monospace, SFMono-Regular, 'SF Mono', menlo, consolas, 'Liberation Mono', monospace`;

/** 预设→CSS 变量表(根内联;未列出的变量在切换时移除,回落样式表缺省)。
 *  --font-ui/--font-mono/--f-base-size/--f-base-lh=全局管线令牌;--f-*=聊天排版细部 */
const PRESETS: Record<FontPreset, Record<string, string>> = {
  default: {},
  serif: {
    '--font-ui': SERIF,
    '--font-mono': SYSTEM_MONO,
    '--f-base-size': '15px',
    '--f-base-lh': '1.75',
    '--f-para-gap': '10px',
    '--f-body-lh': '1.8',
    '--f-tool': '12px',
    '--f-tool-lh': '1.55',
    '--f-code': '12px',
    '--f-code-lh': '1.6',
    '--f-code-pad': '8px 12px',
    '--f-think-lh': '1.7',
  },
  mono: {
    '--font-ui': MODERN_MONO,
    '--font-mono': MODERN_MONO,
    '--f-base-size': '13px',
    '--f-base-lh': '1.6',
    '--f-para-gap': '8px',
    '--f-body-lh': '1.65',
    '--f-tool': '12px',
    '--f-tool-lh': '1.5',
    '--f-code': '12px',
    '--f-code-lh': '1.55',
    '--f-code-pad': '8px 12px',
    '--f-think-lh': '1.6',
  },
  roomy: {
    '--font-ui': SANS,
    '--font-mono': MODERN_MONO,
    '--f-base-size': '14.5px',
    '--f-base-lh': '1.75',
    '--f-para-gap': '10px',
    '--f-body-lh': '1.75',
    '--f-tool': '12px',
    '--f-tool-lh': '1.55',
    '--f-code': '12.5px',
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
  { v: 'default', l: { en: 'Compact (default)', zh: '紧凑(默认)' } },
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
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* 隐私模式等持久化失败:仅内存态生效,不阻断 */
  }
}

/** 设置页预览卡消费:预设的变量表原样给 UI(卡片内联样式直映) */
export function presetVars(p: FontPreset): Record<string, string> {
  return PRESETS[p];
}
