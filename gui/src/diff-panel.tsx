import { DiffEditor } from '@monaco-editor/react';
import { useMemo } from 'react';
import { monacoLangOf, useSxTheme } from './monaco-setup';

/**
 * G6 diff 面板（Chat 工具条 write 展开 / Diff 标签消费）——G14.5 起换 Monaco DiffEditor
 * （用户裁定：VSCode 原生组件，不自拼）：inline（unified）形态，原生行号/±号/词级高亮，
 * 主题随 data-theme（monaco-setup 共享装配）。未变更区折叠为 VSCode 原生行为。
 * 文件头不渲染（用户裁定：面板内无文件名）；diff 标签入口=调用面角标钮（tool-path）。
 * jsdom 无布局，测试经 data-diff-old/new 断言（monaco 渲染属浏览器面）。
 */

export interface DiffPanelProps {
  /** 旧文本（缺场 = 新文件全行增） */
  oldStr?: string;
  /** 新文本（恒在场） */
  newStr: string;
  /** 文件相对路径（语言推断用；面板内不显示文件名） */
  path?: string;
  /** 在场 → 面板右上角标钮可点（打开 diff 标签；aria-label=path） */
  onOpenDiff?: () => void;
  /** 角标钮 title */
  openDiffTitle?: string;
  /** G14.46:定高覆盖(工具行内嵌=280 与 IO 段一致;缺省=行数自适应,Diff 标签消费) */
  height?: number;
}

/** 行数估算 → 面板高度（monaco 需定高；封顶内滚） */
function diffHeight(oldStr: string | undefined, newStr: string): number {
  const lines = Math.max(oldStr !== undefined ? oldStr.split('\n').length : 0, newStr.split('\n').length);
  return Math.min(480, Math.max(38, lines * 19 + 12));
}

export function DiffPanel({ oldStr, newStr, path, onOpenDiff, openDiffTitle, height: heightOverride }: DiffPanelProps): JSX.Element {
  const theme = useSxTheme();
  const auto = useMemo(() => diffHeight(oldStr, newStr), [oldStr, newStr]);
  const height = heightOverride ?? auto;

  return (
    <div className="diff-panel" aria-label="diff" data-diff-old={oldStr ?? ''} data-diff-new={newStr}>
      {onOpenDiff !== undefined && (
        <button
          type="button"
          className="tool-path diff-open-tab"
          aria-label={path ?? 'open diff'}
          data-tip={openDiffTitle}
          onClick={onOpenDiff}
        >
          <span aria-hidden="true">⇄</span>
        </button>
      )}
      <DiffEditor
        original={oldStr ?? ''}
        modified={newStr}
        language={monacoLangOf(path)}
        theme={theme}
        height={height}
        options={{
          renderSideBySide: false, // unified(inline)形态——原生单列行号/±标
          readOnly: true,
          contextmenu: false, // G14.60:与文件预览同款——禁自带右键菜单(Ctrl+C 系统复制保留)
          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
          renderOverviewRuler: false,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          lineNumbersMinChars: 3,
          fontSize: 12,
          lineHeight: 19,
          fontFamily: 'ui-monospace, SFMono-Regular, consolas, monospace',
          automaticLayout: true,
          diffWordWrap: 'off',
          hideUnchangedRegions: { enabled: true, contextLineCount: 3 }, // 折叠未变更区(VSCode 原生行为)
        }}
      />
    </div>
  );
}
