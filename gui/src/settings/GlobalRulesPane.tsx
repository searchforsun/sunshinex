import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { errText } from '../ui-util';

/**
 * 全局规范面板（2026-11-05 用户裁定，编码分组）——**形态对标「高级」raw 面**（sx-raw-card 卡、
 * sx-raw-editor 自增长编辑器 ≥320、sx-save-bar 保存、sx-toast 3s 自隐），零冗余说明文字。
 * 数据面：GET/PUT /settings/sunshine 读写全局 SUNSHINE.md（跨工作区个人标准，对标
 * ~/.claude/CLAUDE.md；路径/读/写单点在 harness/context/loader.ts，PUT 原子写）。
 * 回显面：mount/refreshTick 变化即自动重读（外部/他窗改动信号，watcher 'sunshine' 键）——
 * 重读以磁盘为准（本地未存编辑被磁盘值覆盖=「重新读取」同语义）。「保存」恒可（loaded 门），
 * 保存成功 toast「新建会话起」（stable segment 装配期语义）。
 */

/** 空文件示例占位（SUNSHINE.md=Markdown 规范条文，# 标题/条目行均司） */
const EXAMPLE = {
  en: `Example:\n# Conventions\n- Always respond in Chinese\n- Prefer small, reviewed changes`,
  zh: `示例:\n# 规范\n- 全程中文回复\n- 小步修改，逐条评审`,
};

/** raw 面连接面(结构满足即收,App 传整只 Connection) */
export interface GlobalRulesPaneConn {
  sunshineGet(): Promise<{ content: string; path: string; exists: boolean }>;
  sunshinePut(content: string): Promise<void>;
}

export interface GlobalRulesPaneProps {
  readonly conn: GlobalRulesPaneConn;
  /** config-changed 'sunshine' tick（壳下发）：变化即自动重读磁盘（外部/他窗改动信号） */
  readonly refreshTick?: number;
}

export function GlobalRulesPane({ conn, refreshTick }: GlobalRulesPaneProps): JSX.Element {
  const [content, setContent] = useState('');
  /** 未读取态判据（raw 同款）：mount/tick 重读在途保存禁用——陈旧内容不写 */
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** read 代计数（在途竞态守卫，镜像 SettingsForm loadGenRef）：tick 重读发起即递增，迟到应答弃 */
  const readGenRef = useRef(0);
  /** 编辑器自增长锚（raw 同款：高度随原文撑开，下限 320，滚动交外层面） */
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = editorRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight + 2, 320)}px`;
  }, [content]);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    },
    [],
  );

  /** 自动回显：mount 与 refreshTick 变化即重读（读中清错误/toast；迟到应答代不齐弃） */
  const read = useCallback((): void => {
    const gen = ++readGenRef.current;
    setLoadError('');
    setSaveError('');
    setToast('');
    conn.sunshineGet().then(
      (v) => {
        if (readGenRef.current !== gen) return;
        setContent(v.content ?? ''); // 缺文件 = 空编辑器（首存建档）
        setLoaded(true);
      },
      (err: unknown) => {
        if (readGenRef.current !== gen) return;
        setLoadError(errText(err));
      },
    );
  }, [conn]);

  useEffect(() => {
    read();
  }, [read, refreshTick]);

  const save = (): void => {
    if (saving || !loaded) return;
    setSaving(true);
    setSaveError('');
    conn.sunshinePut(content).then(
      () => {
        setSaving(false);
        setToast(t('Saved — applies to new sessions', '已保存：新建会话起'));
        if (toastTimer.current !== null) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(''), 3_000);
      },
      (err: unknown) => {
        setSaving(false);
        setSaveError(errText(err));
      },
    );
  };

  return (
    <section className="sx-settings-form sx-settings-body" aria-label="settings pane global rules">
      <h2>{t('Global norms (SUNSHINE.md)', '全局规范(SUNSHINE.md)')}</h2>
      <div className="sx-card sx-raw-card">
        <div className="sx-raw-controls">
          <button type="button" onClick={read}>
            {t('Reload', '重新读取')}
          </button>
        </div>
        {loadError !== '' && <p className="home-error" role="alert">{loadError}</p>}
        <textarea
          aria-label="global rules editor"
          className="sx-raw-editor"
          ref={editorRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={20}
          spellCheck={false}
          placeholder={t(EXAMPLE.en, EXAMPLE.zh)}
        />
        <div className="sx-save-bar">
          <button type="button" className="sx-settings-save" disabled={saving || !loaded} onClick={save}>
            {t('Save', '保存')}
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
