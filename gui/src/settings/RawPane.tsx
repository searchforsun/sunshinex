import { useEffect, useRef, useState } from 'react';

/**
 * G8c T9 高级面板(原始编辑):scope select(project/global)+ file select(settings/mcp)+
 * 「读取」(conn.settingsRaw → textarea 等宽装载;content=null 缺文件=空态判据)+
 * 「验证并保存」(conn.putSettingsRaw → 成功 toast「已保存:新建会话起」/失败(400 带服务端
 * 解析错误原文)行内错误条)。textarea 受控;服务端验证拒存+原子写——GUI 不本地预解析
 * (parseSettingsFile 严格口径在服务端,原文保真是本面板价值)。
 * root=''(仅全局)时 scope=project 禁用(提示——scope=project 必带 root,服务端 400 面);
 * root 运行时变 ''(项目选择器切「仅全局」)而 scope 滞留 project → 自动回落 global(G8e-T2
 * 滞留根除,回未读取态)。
 * scope=global 时 root 定位面被服务端忽略,请求省参(不留空串伪参)。
 * 切 scope/file 即回未读取态:content/错误/toast 清 + 保存禁用(placeholder 提示先「读取」)——
 * 读取前的旧目标内容不跨目标写(部分方向能过服务端验证,守卫在 GUI 侧);在途读同款:切目标
 * 后迟到应答代不齐弃(G8e 终审 A,read 代守卫)。
 * G8d T5 告警透出:面板顶部渲染 GET /settings warnings(两级 settings.json 的未知/退役键
 * flatten 告警,服务端项目先行拼全局)——与所选 scope/file 无关的文件面体检,逐行 role=alert;
 * 拉取失败静默空(告警是增强面,不挡编辑主流程);root 切换重拉。
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
  /** 项目上下文('' = 仅全局——scope=project 禁选) */
  readonly root: string;
}

export function RawPane({ conn, root }: RawPaneProps): JSX.Element {
  /** 初始 scope:有项目上下文=project,仅全局=global(唯一可选) */
  const [scope, setScope] = useState<'project' | 'global'>(root === '' ? 'global' : 'project');
  const [file, setFile] = useState<'settings' | 'mcp'>('settings');
  const [content, setContent] = useState('');
  /** 未读取态判据:mount/切目标 即未读取(保存禁用,须先「读取」——陈旧内容不跨目标写) */
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  /** toast 3s 自隐句柄(连续保存重置;卸载兜底清) */
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** G8d T5 文件面告警(未知/退役键):拉取失败/无字段按空——增强面不挡编辑主流程 */
  const [warnings, setWarnings] = useState<string[]>([]);
  /** read 代计数(G8e 终审 A 在途竞态守卫,镜像 SettingsForm loadGenRef):发起新读/切目标
   *  (resetUnread)即递增;应答到达时代不齐 = 陈旧(目标已切走)——弃,不置 loaded/不装内容
   *  (慢读迟到不得把 A 目标内容落进 B 目标的未读取态——保存随 loaded 禁) */
  const readGenRef = useRef(0);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    conn.settings(root === '' ? undefined : root).then(
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
  }, [conn, root]);

  /** scope=global 恒省 root(服务端忽略定位面);scope=project 必带(禁选守卫在 select) */
  const rootArg = scope === 'project' ? root : undefined;

  /** 切目标(scope/file)回未读取态:content/错误/toast 全清——A 目标内容写进 B 目标是错向,
   *  部分 project↔global/settings↔mcp 方向还能过服务端验证,守卫必须在 GUI 侧 */
  const resetUnread = (): void => {
    readGenRef.current += 1; // 在途读作废:迟到应答代不齐即弃(切目标后不置 loaded)
    setContent('');
    setLoaded(false);
    setLoadError('');
    setSaveError('');
    setToast('');
  };

  /** G8e-T2 scope 回落:root 变 ''(仅全局)而 scope 滞留 'project' → 自动回落 'global'——
   *  project 选项已禁,滞留态 select 显禁值且读取/保存会带伪 root('' 串);回落即目标切换,
   *  同款回未读取态(陈旧内容不跨目标写) */
  useEffect(() => {
    if (root !== '' || scope !== 'project') return;
    setScope('global');
    resetUnread();
    // resetUnread 为渲染期重建的纯 setter 组合(无外部依赖),dep 面以 root/scope 转移为准
  }, [root, scope]);

  const read = (): void => {
    const gen = ++readGenRef.current;
    setLoadError('');
    setSaveError('');
    conn.settingsRaw(scope, rootArg, file).then(
      (v) => {
        if (readGenRef.current !== gen) return; // 陈旧代:目标已切走,弃——不置 loaded/不装内容
        setContent(v.content ?? ''); // null = 缺文件:空编辑器(JSONC 保真面由保存写盘建立)
        setLoaded(true);
      },
      (err: unknown) => {
        if (readGenRef.current !== gen) return; // 陈旧代:错误也不落(新代在途/已落)
        setLoadError(errText(err));
      },
    );
  };

  const save = (): void => {
    if (saving || !loaded) return;
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
      {warnings.length > 0 && (
        <div className="sx-raw-warnings" role="alert">
          {warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}
      <div className="sx-raw-controls">
        <label>
          层级
          <select
            aria-label="raw scope"
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as 'project' | 'global');
              resetUnread();
            }}
          >
            <option value="project" disabled={root === ''}>
              项目
            </option>
            <option value="global">全局</option>
          </select>
        </label>
        <label>
          文件
          <select
            aria-label="raw file"
            value={file}
            onChange={(e) => {
              setFile(e.target.value as 'settings' | 'mcp');
              resetUnread();
            }}
          >
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
      <button type="button" className="sx-settings-save" disabled={saving || !loaded} onClick={save}>
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
