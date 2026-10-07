import { useEffect, useRef, useState } from 'react';

/**
 * G8c T9 高级面板(原始编辑):scope select(project/global)+ file select(settings/mcp)+
 * 「读取」(conn.settingsRaw → textarea 等宽装载;content=null 缺文件=空态判据)+
 * 「验证并保存」(conn.putSettingsRaw → 成功 toast「已保存:新建会话起」/失败(400 带服务端
 * 解析错误原文)行内错误条)。textarea 受控;服务端验证拒存+原子写——GUI 不本地预解析
 * (parseSettingsFile 严格口径在服务端,原文保真是本面板价值)。
 * root=''(仅全局)时 scope=project 禁用(提示——scope=project 必带 root,服务端 400 面)。
 * scope=global 时 root 定位面被服务端忽略,请求省参(不留空串伪参)。
 */

/** raw 面连接面(结构满足即收,App 传整只 Connection) */
export interface RawPaneConn {
  settingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp'): Promise<{ content: string | null }>;
  putSettingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp', content: string): Promise<void>;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface RawPaneProps {
  readonly conn: RawPaneConn;
  /** 项目上下文('' = 仅全局——scope=project 禁选) */
  readonly root: string;
}

export function RawPane({ conn, root }: RawPaneProps): JSX.Element {
  /** 初始 scope:有项目上下文=project,仅全局=global(唯一可选) */
  const [scope, setScope] = useState<'project' | 'global'>(root === '' ? 'global' : 'project');
  const [file, setFile] = useState<'settings' | 'mcp'>('settings');
  const [content, setContent] = useState('');
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  /** toast 3s 自隐句柄(连续保存重置;卸载兜底清) */
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    },
    [],
  );

  /** scope=global 恒省 root(服务端忽略定位面);scope=project 必带(禁选守卫在 select) */
  const rootArg = scope === 'project' ? root : undefined;

  const read = (): void => {
    setLoadError('');
    setSaveError('');
    conn.settingsRaw(scope, rootArg, file).then(
      (v) => {
        setContent(v.content ?? ''); // null = 缺文件:空编辑器(JSONC 保真面由保存写盘建立)
      },
      (err: unknown) => setLoadError(errText(err)),
    );
  };

  const save = (): void => {
    if (saving) return;
    setSaving(true);
    setSaveError('');
    conn.putSettingsRaw(scope, rootArg, file, content).then(
      () => {
        setSaving(false);
        setToast('已保存:新建会话起');
        if (toastTimer.current !== null) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(''), 3_000);
      },
      (err: unknown) => {
        setSaving(false);
        setSaveError(errText(err)); // 400 解析错误原文行内示出
      },
    );
  };

  return (
    <section className="sx-settings-form" aria-label="settings pane 高级">
      <h2>高级(原始编辑)</h2>
      <div className="sx-raw-controls">
        <label>
          层级
          <select aria-label="raw scope" value={scope} onChange={(e) => setScope(e.target.value as 'project' | 'global')}>
            <option value="project" disabled={root === ''}>
              项目
            </option>
            <option value="global">全局</option>
          </select>
        </label>
        <label>
          文件
          <select aria-label="raw file" value={file} onChange={(e) => setFile(e.target.value as 'settings' | 'mcp')}>
            <option value="settings">settings.json</option>
            <option value="mcp">mcp.json</option>
          </select>
        </label>
        <button type="button" onClick={read}>
          读取
        </button>
        {root === '' && <p className="sx-raw-hint">未选择项目:仅全局可编辑(scope=项目需项目上下文)。</p>}
      </div>
      {loadError !== '' && <p className="home-error" role="alert">{loadError}</p>}
      <textarea
        aria-label="raw editor"
        className="sx-raw-editor"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={20}
        spellCheck={false}
        placeholder="读取后编辑;保存前服务端验证(JSONC 注释/未知键保真,畸形拒存)"
      />
      {saveError !== '' && <p className="home-error" role="alert">{saveError}</p>}
      <button type="button" className="sx-settings-save" disabled={saving} onClick={save}>
        验证并保存
      </button>
      {toast !== '' && (
        <div className="sx-toast" role="status">
          {toast}
        </div>
      )}
    </section>
  );
}
