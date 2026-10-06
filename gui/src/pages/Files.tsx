import { useCallback, useEffect, useState } from 'react';
import type { Connection } from '../connection';
import type { FileResp } from '../connection';
import { highlightCode } from '../highlight';

/**
 * G6 Files 页（会话内第三 tab）：会话 root 内文件的只读文本预览——路径输入框（Enter 加载）→
 * conn.readFile(sessionId, path)（daemon /session/:id/file 只读端点）→ highlightCode 高亮渲染
 * （<pre><code dangerouslySetInnerHTML>——hljs 产出的 HTML 已含转义，见 highlight.ts）。
 * truncated 横幅：daemon 侧 >512KB 截断回执（truncated:true）的可见标记。错误态直示 HTTP 面
 * 错误消息（403 越界/404 不存在/415 二进制——连接层抛错含 status）。initialPath 到场自动加载
 * （Chat write 工具 path 按钮跳转面——App 切 Files tab 时注入；输入框随之播种该路径）。
 */

export interface FilesProps {
  conn: Connection;
  /** 当前会话（:id 寻址维） */
  sessionId: string;
  /** 到场自动加载的路径（Chat 跳转注入；undefined = 空起步待输入） */
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

  /** 加载单点：trim 空 no-op；请求期间置 loading（清旧错误/旧文）,失败倒错误态不静默 */
  const fetchFile = useCallback(
    (p: string): void => {
      const target = p.trim();
      if (target === '') return;
      setLoad({ file: null, error: null, loading: true });
      void conn.readFile(sessionId, target).then(
        (f) => setLoad({ file: f, error: null, loading: false }),
        (err: unknown) => setLoad({ file: null, error: err instanceof Error ? err.message : String(err), loading: false }),
      );
    },
    [conn, sessionId],
  );

  /** initialPath 到场自动加载（App 跳转面：key={initialPath} 挂载即加载；依赖含 initialPath——
   *  已挂载时新跳转路径同样触发） */
  useEffect(() => {
    if (initialPath !== undefined && initialPath !== '') fetchFile(initialPath);
  }, [initialPath, fetchFile]);

  return (
    <div className="files" aria-label="files">
      <div className="files-bar">
        <input
          aria-label="file path input"
          className="files-path"
          value={pathInput}
          placeholder="相对会话根或绝对路径,如 src/main.ts"
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) fetchFile(pathInput);
          }}
        />
        <button type="button" className="files-load" onClick={() => fetchFile(pathInput)}>
          加载
        </button>
      </div>
      {load.loading && <div className="files-loading">加载中…</div>}
      {load.error !== null && <div className="files-error">{load.error}</div>}
      {load.file !== null && (
        <>
          {load.file.truncated === true && (
            <div className="files-truncated" role="status">
              文件超过 512KB,已截断为首 512KB 预览
            </div>
          )}
          <pre className="files-view" aria-label="file content">
            <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightCode(load.file.content, load.file.path) }} />
          </pre>
        </>
      )}
    </div>
  );
}
