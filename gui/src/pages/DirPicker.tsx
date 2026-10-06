import { useCallback, useEffect, useState } from 'react';
import type { DirPickerResp } from '../connection';

/**
 * 服务端目录选择器(G3.5 首页会话创建入口):逐级浏览 GET /dirpicker(缺省 home 目录起)
 * / 自定义绝对路径输入(「前往」经服务端校验存在性)/ 确认回抛所选路径。组件自持浏览态,
 * props 仅 {conn(只要 dirpicker), onConfirm, onCancel}——可独立桩测;遮罩层归调用方(Home)。
 * 确认取值裁定:自定义输入非空优先(不经服务端校验,由 newSession 的 daemon 400 面兜底),
 * 否则取当前浏览路径(已经 dirpicker 校验在场)。
 * G6 mode 面:确认面板增「Manual approvals」checkbox(缺省不勾)——勾选即 onConfirm 第二参
 * manual=true,Home 转 newSession(root, 'manual')(G4 manual 会话的 UI 入口,fetch 注入面退役)。
 */

export interface DirPickerConn {
  dirpicker(path?: string): Promise<DirPickerResp>;
}

export interface DirPickerProps {
  conn: DirPickerConn;
  /** 确认:回抛所选目录绝对路径(自定义输入优先,缺省当前浏览路径)+ manual 勾选态(G6 mode 面) */
  onConfirm: (path: string, manual: boolean) => void;
  onCancel: () => void;
}

export function DirPicker({ conn, onConfirm, onCancel }: DirPickerProps): JSX.Element {
  const [current, setCurrent] = useState<DirPickerResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [custom, setCustom] = useState('');
  /** G6 manual 勾选(缺省不勾):审批/问询挂起会话的 UI 开关 */
  const [manual, setManual] = useState(false);

  const load = useCallback(
    (path?: string): void => {
      setLoading(true);
      setError('');
      conn.dirpicker(path).then(
        (resp) => {
          setCurrent(resp);
          setLoading(false);
        },
        (err: unknown) => {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        },
      );
    },
    [conn],
  );

  useEffect(() => {
    load(); // 首载:缺省路径(daemon 侧 home 目录)
  }, [load]);

  /** 确认:自定义输入非空优先(路径分隔符/存在性由服务端 newSession 校验兜底)+ manual 勾选态 */
  const confirm = (): void => {
    const typed = custom.trim();
    onConfirm(typed !== '' ? typed : (current?.path ?? ''), manual);
  };

  const atRoot = current !== null && current.parent === current.path;
  const canConfirm = current !== null || custom.trim() !== '';

  return (
    <div className="dirpicker" role="dialog" aria-label="choose directory">
      <header className="dirpicker-head">
        <span>选择工作区目录</span>
        <button type="button" aria-label="close picker" onClick={onCancel}>
          ✕
        </button>
      </header>
      <div className="dirpicker-path" aria-label="current path">
        {current?.path ?? (loading ? '加载中…' : '')}
      </div>
      {error !== '' && (
        <p className="dirpicker-error" role="alert">
          {error}
        </p>
      )}
      <ul className="dirpicker-list" aria-label="directory listing">
        {current !== null && (
          <li>
            <button type="button" className="dir-parent" disabled={atRoot} onClick={() => load(current.parent)}>
              ↑ 上级
            </button>
          </li>
        )}
        {current?.dirs.map((d) => (
          <li key={d}>
            <button
              type="button"
              className="dir-entry"
              disabled={loading}
              onClick={() => load(current.path === '' ? d : `${current.path}/${d}`)}
            >
              {d}
            </button>
          </li>
        ))}
        {current !== null && current.dirs.length === 0 && <li className="dir-empty">无子目录</li>}
      </ul>
      <div className="dirpicker-custom">
        <input
          aria-label="custom path"
          value={custom}
          placeholder="或输入绝对路径"
          onChange={(e) => setCustom(e.target.value)}
        />
        <button
          type="button"
          disabled={custom.trim() === ''}
          onClick={() => {
            const typed = custom.trim();
            if (typed !== '') load(typed);
          }}
        >
          前往
        </button>
      </div>
      <div className="dirpicker-mode">
        <label className="mode-option">
          <input
            type="checkbox"
            checked={manual}
            onChange={(e) => setManual(e.target.checked)}
          />
          <span>Manual approvals</span>
        </label>
        <p className="mode-hint">勾选后审批/问询挂起等待人工裁决(manual 会话)</p>
      </div>
      <footer className="dirpicker-foot">
        <button type="button" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="primary" disabled={!canConfirm} onClick={confirm}>
          选择此目录
        </button>
      </footer>
    </div>
  );
}
