import { useCallback, useEffect, useState } from 'react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import { ErrorBanner } from './components';

/**
 * 全局规范面板（2026-11-05 用户裁定，编码分组）：编辑全局 SUNSHINE.md（跨工作区个人标准，
 * 对标 ~/.claude/CLAUDE.md）——GET /settings/sunshine 装载原文+路径，PUT 原子写回；脏检查
 * （未改动禁存）、还原按钮、refreshTick 变化重拉（外部/他窗改动信号，watcher 'sunshine' 键）。
 * 编辑器 320px 固定高（与 TeamsPane 章程详情/编辑同款裁定）。仅全局作用域，无 root 参数。
 */
export interface GlobalRulesPaneConn {
  sunshineGet(): Promise<{ content: string; path: string; exists: boolean }>;
  sunshinePut(content: string): Promise<void>;
}

export function GlobalRulesPane({ conn, refreshTick }: { conn: GlobalRulesPaneConn; refreshTick?: number }): JSX.Element {
  const [origin, setOrigin] = useState(''); // 磁盘原文（脏检查基线；保存成功后同步）
  const [text, setText] = useState(''); // 编辑缓冲
  const [path, setPath] = useState('');
  const [exists, setExists] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    conn.sunshineGet().then(
      (r) => {
        setOrigin(r.content);
        setText(r.content);
        setPath(r.path);
        setExists(r.exists);
        setLoadError('');
      },
      (err: unknown) => setLoadError(errText(err)),
    );
  }, [conn]);

  useEffect(() => {
    load();
  }, [load, refreshTick]);

  const dirty = text !== origin;
  const save = (): void => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError('');
    conn.sunshinePut(text).then(
      () => {
        setSaving(false);
        setOrigin(text); // 基线推进（脏检查复位）
        setExists(true); // 首存即建档
      },
      (err: unknown) => {
        setSaving(false);
        setSaveError(errText(err));
      },
    );
  };

  return (
    <div className="sx-global-rules" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, color: 'var(--fg-secondary)' }}>
        {t('Global norms file', '全局规范文件')}：<code style={{ fontFamily: 'var(--font-mono)' }}>{path}</code>
        {!exists && <span style={{ marginLeft: 8 }}>{t('not created yet — saving creates it', '尚未创建——保存即建档')}</span>}
      </div>
      {loadError !== '' && <ErrorBanner text={loadError} />}
      {saveError !== '' && <ErrorBanner text={saveError} />}
      <textarea
        aria-label="global rules editor"
        className="sx-team-body-editor"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" onClick={save} disabled={!dirty || saving}>
          {saving ? t('Saving…', '保存中…') : t('Save', '保存')}
        </button>
        <button type="button" onClick={load} disabled={!dirty || saving}>
          {t('Revert', '还原')}
        </button>
        {dirty && <span style={{ fontSize: 12, color: 'var(--warn)' }}>{t('Unsaved changes', '有未保存修改')}</span>}
      </div>
    </div>
  );
}
