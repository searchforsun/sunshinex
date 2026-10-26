/**
 * 字体预设(2026-10-26 用户裁定:设置-通用提供预设卡片,给效果预览,点击即生效):
 * 四预设——default 紧凑(出厂)/cozy 舒适/cozyMono 舒适+现代等宽/roomy 宽松。
 * 持久与主题/缩放同通路:localStorage 即时层 + /app/gui-state 公共档双写(ui-pref-sync)。
 * 应用面=根节点内联 CSS 变量(缺省预设清空内联,样式表缺省值接管=零漂移)。
 */

export type FontPreset = 'default' | 'cozy' | 'cozyMono' | 'roomy';

import { notifyUiPref } from './ui-pref-sync';

const KEY = 'sunshinex.font-preset';

const MODERN_MONO = `'Cascadia Mono', 'JetBrains Mono', ui-monospace, 'SF Mono', consolas, monospace`;

/** 预设→CSS 变量表(根内联;未列出的变量在切换时移除,回落样式表缺省) */
const PRESETS: Record<FontPreset, Record<string, string>> = {
  default: {},
  cozy: {
    '--f-para-gap': '8px',
    '--f-body-lh': '1.65',
    '--f-tool': '12px',
    '--f-tool-lh': '1.5',
    '--f-code': '12px',
    '--f-code-lh': '1.55',
    '--f-code-pad': '8px 12px',
    '--f-think-lh': '1.6',
  },
  cozyMono: {
    '--f-para-gap': '8px',
    '--f-body-lh': '1.65',
    '--f-tool': '12px',
    '--f-tool-lh': '1.5',
    '--f-code': '12px',
    '--f-code-lh': '1.55',
    '--f-code-pad': '8px 12px',
    '--f-think-lh': '1.6',
    '--font-mono': MODERN_MONO,
  },
  roomy: {
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

export function readFontPreset(): FontPreset {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'cozy' || v === 'cozyMono' || v === 'roomy' ? v : 'default';
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
