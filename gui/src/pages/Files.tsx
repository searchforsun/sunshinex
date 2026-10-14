import { useCallback, useEffect, useRef, useState } from 'react';
import { Editor } from '@monaco-editor/react';
import { ChevronRight } from 'lucide-react';
import type { Connection } from '../connection';
import type { FileResp } from '../connection';
import { FileIcon } from '../file-icon';
import { monacoLangOf, useSxTheme } from '../monaco-setup';
import { t } from '../i18n';

/**
 * G6 Files 页（会话内文件只读预览）——G14.5 起 VSCode 形态（用户裁定）：**顶部文件路径面包屑**
 * （逐级文件夹图标+分隔符，末级文件图标+名）+ **Monaco 只读源码视图**（原生行号/高亮/主题跟随）。
 * 无常驻输入行/加载钮（加载入口=目录树点击/工具行/Diff 跳转，均经 initialPath 自动加载）；
 * 裸开档（+菜单「文件」无路径）示空态引导+路径输入（Enter/加载钮，仅空态/错误态在场）。
 * G7 请求序守卫保持：requestIdRef 单调发号，慢旧应答不覆写。
 */

export interface FilesProps {
  conn: Connection;
  /** 当前会话（:id 寻址维） */
  sessionId: string;
  /** 到场自动加载的路径（跳转注入；undefined = 空态待选） */
  initialPath?: string;
}

/** 一次加载的三态：file=成功面（含 truncated 标）；error=失败面（HTTP 错误消息）；loading 在途 */
interface LoadState {
  file: FileResp | null;
  error: string | null;
  loading: boolean;
}

const EMPTY_LOAD: LoadState = { file: null, error: null, loading: false };

export function Files({ conn, sessionId, initialPath }: FilesProps): JSX.Element {
  const [pathInput, setPathInput] = useState(initialPath ?? '');
  const [load, setLoad] = useState<LoadState>(EMPTY_LOAD);
  /** G7 请求序守卫：发号单调节点——发请求 ++,应答落定时号不匹配即过期丢弃 */
  const requestIdRef = useRef(0);
  const theme = useSxTheme();

  /** 加载单点：trim 空 no-op；请求期间保留旧文（切换不闪空）,失败倒错误态不静默 */
  const fetchFile = useCallback(
    (p: string): void => {
      const target = p.trim();
      if (target === '') return;
      const rid = ++requestIdRef.current;
      setLoad((prev) => ({ file: prev.file, error: null, loading: true }));
      void conn.readFile(sessionId, target).then(
        (f) => {
          if (rid !== requestIdRef.current) return; // 过期应答:丢弃
          setLoad({ file: f, error: null, loading: false });
        },
        (err: unknown) => {
          if (rid !== requestIdRef.current) return; // 过期应答:丢弃
          setLoad({ file: null, error: err instanceof Error ? err.message : String(err), loading: false });
        },
      );
    },
    [conn, sessionId],
  );

  /** initialPath 到场自动加载（跳转面：依赖含 initialPath——已挂载时新跳转同样触发） */
  useEffect(() => {
    if (initialPath !== undefined && initialPath !== '') fetchFile(initialPath);
  }, [initialPath, fetchFile]);

  const segments = load.file !== null ? load.file.path.replace(/\\/g, '/').split('/').filter(Boolean) : [];

  return (
    <div className="files" aria-label="files">
      {load.file !== null ? (
        <>
          {/* 顶部文件路径面包屑(VSCode 同形):逐级文件夹+分隔符,末级文件图标+名 */}
          <div className="files-breadcrumb" aria-label="file path">
            {segments.map((seg, i) => (
              <span key={`${seg}:${i}`} className="files-crumb">
                {i > 0 && <ChevronRight size={12} strokeWidth={1.75} className="files-crumb-sep" aria-hidden="true" />}
                <FileIcon path={seg} folder={i < segments.length - 1} />
                <span className={i === segments.length - 1 ? 'files-crumb-name' : 'files-crumb-seg'}>{seg}</span>
              </span>
            ))}
          </div>
          {load.file.truncated === true && (
            <div className="files-truncated" role="status">
              文件超过 512KB,已截断为首 512KB 预览
            </div>
          )}
          <div className="files-editor" aria-label="file content" onContextMenu={(e) => e.preventDefault()}>
            <Editor
              value={load.file.content}
              language={monacoLangOf(load.file.path)}
              theme={theme}
              options={{
                readOnly: true,
                contextmenu: false, // G14.60:禁用自带右键菜单(外层拦浏览器菜单);Ctrl+C 系统复制保留
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                lineNumbersMinChars: 3,
                fontSize: 12,
                lineHeight: 19,
                fontFamily: 'ui-monospace, SFMono-Regular, consolas, monospace',
                automaticLayout: true,
                renderLineHighlight: 'none',
                overviewRulerLanes: 0,
                scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
              }}
            />
          </div>
          {load.loading && <div className="files-loading" role="status">加载中…</div>}
        </>
      ) : (
        <div className="files-empty">
          <p className="files-hint">{t('Open a file from the directory tree or a tool row', '从目录树或工具行打开文件')}</p>
          <div className="files-bar">
            <input
              aria-label="file path input"
              className="files-path"
              value={pathInput}
              placeholder={t('Relative to the workspace root, e.g. src/main.ts', '相对会话根或绝对路径,如 src/main.ts')}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) fetchFile(pathInput);
              }}
            />
            <button type="button" className="files-load" onClick={() => fetchFile(pathInput)}>
              {t('Load', '加载')}
            </button>
          </div>
          {load.loading && <div className="files-loading" role="status">加载中…</div>}
          {load.error !== null && <div className="files-error">{load.error}</div>}
        </div>
      )}
    </div>
  );
}
