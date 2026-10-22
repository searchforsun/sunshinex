import { loader } from '@monaco-editor/react';
import { useEffect, useState } from 'react';
import * as monaco from 'monaco-editor';
import { currentTheme, watchThemeChange } from './theme';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';

/**
 * Monaco 共享装配（G14.5）：loader 本地化（离线，不走 CDN）+ worker 环境 + sx 双主题定义 +
 * 主题跟随 hook + 路径→语言映射。DiffPanel（diff 视图）与 Files（只读源码视图）共用——
 * 主题令牌值与 app.css 手工同值（monaco 读不了 CSS 变量）。
 */

loader.config({ monaco });

let themesDefined = false;

/** sx-dark/sx-light 主题定义（幂等）+ worker 环境（非浏览器环境跳过） */
export function ensureMonaco(): void {
  if (typeof Worker !== 'undefined' && (self as { MonacoEnvironment?: unknown }).MonacoEnvironment === undefined) {
    (self as { MonacoEnvironment?: unknown }).MonacoEnvironment = { getWorker: () => new editorWorker() };
  }
  if (themesDefined) return;
  monaco.editor.defineTheme('sx-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [{ token: '', foreground: 'dfdfdf', background: '101010' }],
    colors: {
      'editor.background': '#101010',
      'editor.foreground': '#dfdfdf',
      'editorLineNumber.foreground': '#6b6b6b',
      'editorGutter.background': '#101010',
      'diffEditor.insertedTextBackground': '#40c97722',
      'diffEditor.removedTextBackground': '#ff676422',
      'diffEditor.insertedLineBackground': '#40c97715',
      'diffEditor.removedLineBackground': '#ff676415',
      'diffEditorBorder': '#00000000',
      'scrollbarSlider.background': '#dfdfdf22',
    },
  });
  monaco.editor.defineTheme('sx-light', {
    base: 'vs',
    inherit: true,
    rules: [{ token: '', foreground: '1a1c1f', background: 'fcfcfc' }],
    colors: {
      'editor.background': '#fcfcfc',
      'editor.foreground': '#1a1c1f',
      'editorLineNumber.foreground': '#9a9a9a',
      'editorGutter.background': '#fcfcfc',
      'diffEditor.insertedTextBackground': '#00a24022',
      'diffEditor.removedTextBackground': '#e02e2a22',
      'diffEditor.insertedLineBackground': '#00a24012',
      'diffEditor.removedLineBackground': '#e02e2a12',
      'diffEditorBorder': '#00000000',
      'scrollbarSlider.background': '#1a1c1f22',
    },
  });
  themesDefined = true;
}

/** 主题跟随 hook：mount 即定义主题并对齐 data-theme；切换经 watchThemeChange 单点实时重渲 */
export function useSxTheme(): 'sx-dark' | 'sx-light' {
  const [theme, setTheme] = useState<'sx-dark' | 'sx-light'>(currentTheme() === 'light' ? 'sx-light' : 'sx-dark');
  useEffect(() => {
    ensureMonaco();
    const apply = (): void => {
      const next = currentTheme() === 'light' ? 'sx-light' : 'sx-dark';
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
