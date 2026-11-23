import { useCallback } from 'react';
import { t } from '../i18n';
import { useRawEditor } from '../use-raw-editor';

/**
 * 全局规范面板（2026-11-05 用户裁定，编码分组）——**形态对标「高级」raw 面**（sx-raw-card 卡、
 * sx-raw-editor 自增长编辑器 ≥320、sx-save-bar 保存、sx-toast 3s 自隐），零冗余说明文字。
 * 数据面：GET/PUT /settings/sunshine 读写全局 SUNSHINE.md（跨工作区个人标准，对标
 * ~/.claude/CLAUDE.md；路径/读/写单点在 harness/context/loader.ts，PUT 原子写）。
 * 回显面：mount/refreshTick 变化即自动重读（外部/他窗改动信号，watcher 'sunshine' 键）——
 * 重读以磁盘为准（本地未存编辑被磁盘值覆盖=「重新读取」同语义；原文保留在途换新）。
 * 「保存」恒可（loaded 门），保存成功 toast「新建会话起」（stable segment 装配期语义）。
 * 编辑器机制在 use-raw-editor 共享 hook（D92 收敛：与 RawPane 双写退役）。
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

interface GlobalRulesPaneProps {
  readonly conn: GlobalRulesPaneConn;
  /** config-changed 'sunshine' tick（壳下发）：变化即自动重读磁盘（外部/他窗改动信号） */
  readonly refreshTick?: number;
}

export function GlobalRulesPane({ conn, refreshTick }: GlobalRulesPaneProps): JSX.Element {
  const read = useCallback((): Promise<{ content: string | null }> => conn.sunshineGet(), [conn]);
  const write = useCallback((content: string): Promise<void> => conn.sunshinePut(content), [conn]);
  const ed = useRawEditor({ read, write, readDeps: [conn, refreshTick] }); // 无清场:原文保留在途换新

  return (
    <section className="sx-settings-form sx-settings-body" aria-label="settings pane global rules">
      <h2>{t('Global norms (SUNSHINE.md)', '全局规范(SUNSHINE.md)')}</h2>
      <div className="sx-card sx-raw-card">
        <div className="sx-raw-controls">
          <button type="button" onClick={ed.readNow}>
            {t('Reload', '重新读取')}
          </button>
        </div>
        {ed.loadError !== '' && <p className="home-error" role="alert">{ed.loadError}</p>}
        <textarea
          aria-label="global rules editor"
          className="sx-raw-editor"
          ref={ed.editorRef}
          value={ed.content}
          onChange={(e) => ed.setContent(e.target.value)}
          rows={20}
          spellCheck={false}
          placeholder={t(EXAMPLE.en, EXAMPLE.zh)}
        />
        <div className="sx-save-bar">
          <button type="button" className="sx-settings-save" disabled={ed.saving || !ed.loaded} onClick={ed.save}>
            {t('Save', '保存')}
          </button>
        </div>
        {ed.saveError !== '' && <p className="home-error" role="alert">{ed.saveError}</p>}
      </div>
      {ed.toast !== null && (
        <div className="sx-toast" role="status">
          {ed.toast}
        </div>
      )}
    </section>
  );
}
