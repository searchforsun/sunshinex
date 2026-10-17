import { useEffect, useRef, useState } from 'react';
import { Select } from './controls';
import { t } from '../i18n';

/**
 * G8c T9 高级面板(设置重构轮:仅全局+自动回显)——scope 面移除,恒 'global':本面板只编辑
 * 用户级文件(项目级结构化编辑走各配置项逐项写回,原文级项目编辑非本面职责;「高级只设置
 * 全局的配置」)。
 * 回显面:mount/切文件即自动「读取」(不再要求先点读取——原「空 textarea + 手动读取」即
 * 「无法回显」观感);content=null(缺文件)=空态判据照旧。「重新读取」钮保留(编辑中途弃改
 * 回磁盘现值)。textarea 受控;服务端验证拒存+原子写——GUI 不本地预解析(parseSettingsFile
 * 严格口径在服务端,原文保真是本面板价值)。
 * 切文件即回未读取态:content/错误/toast 清 + 保存禁用,自动读取随即装新原文——A 文件内容
 * 不跨文件写(部分方向能过服务端验证,守卫在 GUI 侧);在途读同款:切文件后迟到应答代不齐
 * 弃(read 代守卫,G8e 终审 A)。
 * G8d T5 告警透出:面板顶部渲染 GET /settings warnings(两级 settings.json 的未知/退役键
 * flatten 告警;root 省参=仅全局面)——逐行 role=alert;拉取失败静默空(告警是增强面,不挡
 * 编辑主流程);mount 拉一次。
 */

/** raw 面连接面(结构满足即收,App 传整只 Connection) */
export interface RawPaneConn {
  settingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp'): Promise<{ content: string | null }>;
  putSettingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp', content: string): Promise<void>;
  /** G8d T5 告警数据源:root 缺省 = 仅全局文件面(与 settings() 同裁定) */
  settings(root?: string): Promise<{ warnings?: string[] }>;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface RawPaneProps {
  readonly conn: RawPaneConn;
}

export function RawPane({ conn }: RawPaneProps): JSX.Element {
  const [file, setFile] = useState<'settings' | 'mcp'>('settings');
  const [content, setContent] = useState('');
  /** 未读取态判据:mount/切文件即未读取(保存禁用,自动读取在途)——陈旧内容不跨文件写 */
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  /** toast 3s 自隐句柄(连续保存重置;卸载兜底清) */
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** G8d T5 文件面告警(未知/退役键):拉取失败/无字段按空——增强面不挡编辑主流程 */
  const [warnings, setWarnings] = useState<string[]>([]);
  /** read 代计数(在途竞态守卫,镜像 SettingsForm loadGenRef):发起新读/切文件即递增;
   *  应答到达时代不齐 = 陈旧(文件已切走)——弃,不置 loaded/不装内容 */
  const readGenRef = useRef(0);
  /** 编辑器自增长锚(高度随原文长度撑开,滚动交外层面——不再内部裁剪) */
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  /** 自增长:content/file 变化即重算高度(scrollHeight 撑开,下限 320);先置 auto 归零防旧高钳制 */
  useEffect(() => {
    const el = editorRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight + 2, 320)}px`;
  }, [content, file]);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    conn.settings().then(
      (v) => {
        if (alive) setWarnings(v.warnings ?? []);
      },
      () => {
        if (alive) setWarnings([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [conn]);

  /** scope=global 恒省 root(服务端忽略定位面) */

  /** 自动回显:mount 与切文件即读取(读取中清错误/toast;迟到应答代不齐弃) */
  useEffect(() => {
    const gen = ++readGenRef.current;
    setContent('');
    setLoaded(false);
    setLoadError('');
    setSaveError('');
    setToast('');
    conn.settingsRaw('global', undefined, file).then(
      (v) => {
        if (readGenRef.current !== gen) return; // 陈旧代:文件已切走,弃——不置 loaded/不装内容
        setContent(v.content ?? ''); // null = 缺文件:空编辑器(JSONC 保真面由保存写盘建立)
        setLoaded(true);
      },
      (err: unknown) => {
        if (readGenRef.current !== gen) return; // 陈旧代:错误也不落(新代在途/已落)
        setLoadError(errText(err));
      },
    );
  }, [conn, file]);

  const read = (): void => {
    const gen = ++readGenRef.current;
    setLoadError('');
    setSaveError('');
    conn.settingsRaw('global', undefined, file).then(
      (v) => {
        if (readGenRef.current !== gen) return;
        setContent(v.content ?? '');
        setLoaded(true);
      },
      (err: unknown) => {
        if (readGenRef.current !== gen) return;
        setLoadError(errText(err));
      },
    );
  };

  const save = (): void => {
    if (saving || !loaded) return;
    setSaving(true);
    setSaveError('');
    conn.putSettingsRaw('global', undefined, file, content).then(
      () => {
        setSaving(false);
        setToast(t('Saved — applies to new sessions', '已保存：新建会话起'));
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
    <section className="sx-settings-form sx-settings-body" aria-label="settings pane 高级">
      <h2>高级(原始编辑·仅全局)</h2>
      {warnings.length > 0 && (
        <div className="sx-raw-warnings" role="alert">
          {warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}
      <div className="sx-card sx-raw-card">
        <div className="sx-raw-controls">
          <label>
            文件
            <Select
              ariaLabel="raw file"
              value={file}
              options={[
                { v: 'settings', l: 'settings.json' },
                { v: 'mcp', l: 'mcp.json' },
              ]}
              onChange={(v) => setFile(v as 'settings' | 'mcp')}
            />
          </label>
          <button type="button" onClick={read}>
            重新读取
          </button>
        </div>
        {loadError !== '' && <p className="home-error" role="alert">{loadError}</p>}
        <textarea
          aria-label="raw editor"
          className="sx-raw-editor"
          ref={editorRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={20}
          spellCheck={false}
          placeholder="读取后编辑;保存前服务端验证(JSONC 注释/未知键保真,畸形拒存)"
        />
        <div className="sx-save-bar">
          <button type="button" className="sx-settings-save" disabled={saving || !loaded} onClick={save}>
            {t('Verify & save', '验证并保存')}
          </button>
        </div>
        {saveError !== '' && <p className="home-error" role="alert">{saveError}</p>}
      </div>
      {toast !== '' && (
        <div className="sx-toast" role="status">
          {toast}
        </div>
      )}
    </section>
  );
}
