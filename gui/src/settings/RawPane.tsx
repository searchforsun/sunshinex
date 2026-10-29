import { useEffect, useRef, useState } from 'react';
import { Select } from './controls';
import { t } from '../i18n';
import { errText } from '../ui-util';
import type { SettingsScope } from './components';

/**
 * G8c T9 高级面板(设置重构轮:自动回显)——原文级编辑面:settings/mcp 双文件,按壳下发作
 * 用域取文(项目 `<root>/.sunshinex/` 侧或用户级;T27 解锁项目作用域——此前恒 'global',
 * 原文级项目编辑由本面承接;端点四象限既有,GUI 只差把 scope/root 传到)。scope 缺省
 * 'global'(无壳直挂面);project 必有 root(壳对无项目上下文强制 global——pane 不另设防,
 * 误用态服务端 400 兜底)。
 * 回显面:mount/切文件/切作用域即自动「读取」(不再要求先点读取——原「空 textarea + 手动
 * 读取」即「无法回显」观感);content=null(缺文件)=空态判据照旧。「重新读取」钮保留(编辑
 * 中途弃改回磁盘现值)。textarea 受控;服务端验证拒存+原子写——GUI 不本地预解析
 * (parseSettingsFile 严格口径在服务端,原文保真是本面板价值)。
 * 切文件即回未读取态:content/错误/toast 清 + 保存禁用,自动读取随即装新原文——A 文件内容
 * 不跨文件写(部分方向能过服务端验证,守卫在 GUI 侧);在途读同款:切文件/切作用域后迟到
 * 应答代不齐弃(read 代守卫,G8e 终审 A)。
 * G8d T5 告警透出:面板顶部渲染 GET /settings warnings(两级 settings.json 的未知/退役键
 * flatten 告警;root 省参=仅全局面,沿现状不随作用域扩拉)——逐行 role=alert;拉取失败静默
 * 空(告警是增强面,不挡编辑主流程);mount 拉一次。
 */

/** raw 面连接面(结构满足即收,App 传整只 Connection) */
export interface RawPaneConn {
  settingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp'): Promise<{ content: string | null }>;
  putSettingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp', content: string): Promise<void>;
  /** G8d T5 告警数据源:root 缺省 = 仅全局文件面(与 settings() 同裁定) */
  settings(root?: string): Promise<{ warnings?: string[] }>;
}


export interface RawPaneProps {
  readonly conn: RawPaneConn;
  /** T21 设置壳注入:作用域(顶栏 ScopeSwitcher;raw 双文件面——settings/mcp 各按作用域取文)
   *  可选,缺省 'global'(无壳直挂面);T27 起解构消费。refreshTick 不由壳下发(raw 跨
   *  settings+mcp 两资源——需要时本面自持 conn 调 useConfigChanged 自取) */
  readonly scope?: SettingsScope;
  /** T27 设置壳注入:隐式项目上下文('' = 仅全局;App 快照打开设置时的活动工作区)——
   *  project 作用域读写的定位锚;global 恒省参(服务端忽略定位面) */
  readonly root?: string;
}

export function RawPane({ conn, scope, root }: RawPaneProps): JSX.Element {
  /** 有效作用域/定位锚(每次渲染重算):scope 缺省 'global';project 需非空 root 才带定位
   *  (无 root 的 project 不可达——壳已强制 global;防御面兜底为省参,服务端 400 兜误用) */
  const effScope: SettingsScope = scope ?? 'global';
  const effRoot = effScope === 'project' && root !== undefined && root !== '' ? root : undefined;
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

  /** 自动回显:mount 与切文件/切作用域即读取(读取中清错误/toast;迟到应答代不齐弃) */
  useEffect(() => {
    const gen = ++readGenRef.current;
    setContent('');
    setLoaded(false);
    setLoadError('');
    setSaveError('');
    setToast('');
    conn.settingsRaw(effScope, effRoot, file).then(
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
  }, [conn, file, effScope, effRoot]);

  const read = (): void => {
    const gen = ++readGenRef.current;
    setLoadError('');
    setSaveError('');
    conn.settingsRaw(effScope, effRoot, file).then(
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
    conn.putSettingsRaw(effScope, effRoot, file, content).then(
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
    <section className="sx-settings-form sx-settings-body" aria-label="settings pane raw">
      <h2>{t('Advanced (raw editing)', '高级(原始编辑)')}</h2>
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
            {t('File', '文件')}
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
            {t('Reload', '重新读取')}
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
          placeholder={t('Read then edit; server-side validation before save (JSONC comments / unknown keys preserved; malformed rejected)', '读取后编辑;保存前服务端验证(JSONC 注释/未知键保真,畸形拒存)')}
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
