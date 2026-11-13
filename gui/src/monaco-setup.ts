import { loader } from '@monaco-editor/react';
import { useEffect, useState } from 'react';
import * as monaco from 'monaco-editor';
import { watchThemeChange } from './theme';
import { effectivePalette, mixHex, PALETTES } from './palette';
import type { Palette } from './palette';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';

/**
 * Monaco 共享装配（G14.5）：loader 本地化（离线，不走 CDN）+ worker 环境 + sx 双主题定义 +
 * 主题跟随 hook + 路径→语言映射。DiffPanel（diff 视图）与 Files（只读源码视图）共用——
 * 主题取值单源 palette.ts（monaco 读不了 CSS 变量），每套配色一个 sx-<id> 主题。
 */

loader.config({ monaco });

let themesDefined = false;

/** 配色 → monaco 主题(画布读不了 CSS 变量,取值单源 palette.ts;diff 增删色沿状态色亮/暗两档) */
function defineSxTheme(p: Palette): void {
  const t = p.tokens;
  const hex = (c: string): string => c.slice(1);
  const dark = p.mode === 'dark';
  const ok = dark ? '#40c977' : '#00a240';
  const err = dark ? '#ff6764' : '#e02e2a';
  monaco.editor.defineTheme(`sx-${p.id}`, {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [{ token: '', foreground: hex(t.fg), background: hex(t.editor) }],
    colors: {
      'editor.background': t.editor,
      'editor.foreground': t.fg,
      'editorLineNumber.foreground': mixHex(t.fg, t.editor, 0.44),
      'editorGutter.background': t.editor,
      'diffEditor.insertedTextBackground': `${ok}22`,
      'diffEditor.removedTextBackground': `${err}22`,
      'diffEditor.insertedLineBackground': `${ok}${dark ? '15' : '12'}`,
      'diffEditor.removedLineBackground': `${err}${dark ? '15' : '12'}`,
      'diffEditorBorder': '#00000000',
      'scrollbarSlider.background': `${t.fg}22`,
    },
  });
}

/** sx-<配色 id> 主题定义（幂等）+ worker 环境（非浏览器环境跳过） */
let appliedMonacoTheme = ''; // 全局重主题去重单点(2026-11-13 用户实测「切主题回正文卡」):setTheme 是
// monaco 全局操作且不因同名短路——hook、@monaco-editor/react 的 theme prop 每编辑器实例各调一次
// =N 次全编辑器重主题。ensureMonaco 在此包一层同值短路,全部调用方(含编辑器 prop 路径)一并收敛
export function ensureMonaco(): void {
  if (typeof Worker !== 'undefined' && (self as { MonacoEnvironment?: unknown }).MonacoEnvironment === undefined) {
    (self as { MonacoEnvironment?: unknown }).MonacoEnvironment = { getWorker: () => new editorWorker() };
  }
  if (themesDefined) return;
  for (const p of PALETTES) defineSxTheme(p);
  const rawSetTheme = monaco.editor.setTheme.bind(monaco.editor);
  monaco.editor.setTheme = (name: string): void => {
    if (appliedMonacoTheme === name) return;
    appliedMonacoTheme = name;
    rawSetTheme(name);
  };
  themesDefined = true;
}

/** 主题跟随 hook：mount 即定义主题并对齐生效配色；亮暗/配色切换经 watchThemeChange 单点实时重渲。
 *  取值走 effectivePalette 单点——亮色主题+「暗色代码」开时文件源码视图随暗色偏好配色。
 *  setTheme 走 ensureMonaco 的同值短路补丁(见上),多编辑器实例不再重复全局重主题 */
export function useSxTheme(): string {
  const [theme, setTheme] = useState<string>(() => `sx-${effectivePalette().id}`);
  useEffect(() => {
    ensureMonaco();
    const apply = (): void => {
      const next = `sx-${effectivePalette().id}`;
      setTheme(next);
      monaco.editor.setTheme(next);
    };
    apply();
    return watchThemeChange(apply);
  }, []);
  return theme;
}

/** 路径 → monaco 语言 id（常用扩展映射，未知回落 plaintext） */
export function monacoLangOf(path: string | undefined): string {
  if (path === undefined || path === '') return 'plaintext';
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    json: 'json', md: 'markdown', css: 'css', scss: 'scss', html: 'html', py: 'python',
    java: 'java', rs: 'rust', go: 'go', sh: 'shell', bat: 'bat', yml: 'yaml', yaml: 'yaml',
    toml: 'ini', ini: 'ini', sql: 'sql', php: 'php', rb: 'ruby', vue: 'xml', xml: 'xml', svg: 'xml',
  };
  return map[ext] ?? 'plaintext';
}
