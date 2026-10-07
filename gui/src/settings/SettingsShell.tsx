import { useEffect, useState } from 'react';
import type { WorkspaceRow } from '../connection';
import { SettingsForm, SETTINGS_PANES } from './SettingsForm';
import type { SettingsFormConn } from './SettingsForm';

/**
 * G8c T8 设置态壳:App settingsOpen 时整体替换三栏内容——左栏(顶栏「← 返回」+ 项目选择器
 * + 导航列表)+ 主区(所选面板 SettingsForm);右标签栏由 App 不渲染(设置态外置)。Esc 与
 * 返回钮同路径回会话态(document keydown——设置态独占窗,Chat 已卸载无冲突面)。
 * 项目选择器(aria-label="settings project"):空选项「(仅全局)」+ /workspaces 列表
 * (root 在场的组;Shell 自拉 conn.workspaces()),当前值 = settingsRoot(App 态——切换经
 * onRootChange 上抛,SettingsForm 随 root 重拉)。
 * 导航仅列已实现四面板(通用/上下文与限额/记忆/知识库与搜索;T9 扩全十项——禁用占位=死 UI
 * 违禁);选中态 activePane 本地 state(默认「通用」),主区 SettingsForm 以 key={pane.id}
 * 挂载(面板互切强制重挂——键集/输入值面整体复位)。
 */

/** 壳连接面:workspaces(项目选择器)+ 表单引擎三方法(结构满足即收,App 传整只 Connection) */
export interface SettingsShellConn extends SettingsFormConn {
  workspaces(): Promise<WorkspaceRow[]>;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface SettingsShellProps {
  readonly conn: SettingsShellConn;
  /** 项目上下文('' = 仅全局) */
  readonly root: string;
  readonly onRootChange: (root: string) => void;
  /** 「← 返回」/Esc:回会话态(App 侧关设置态) */
  readonly onBack: () => void;
}

export function SettingsShell({ conn, root, onRootChange, onBack }: SettingsShellProps): JSX.Element {
  const [rows, setRows] = useState<WorkspaceRow[] | null>(null);
  const [listError, setListError] = useState('');
  const [activePane, setActivePane] = useState(SETTINGS_PANES[0]!.id); // 默认「通用」

  useEffect(() => {
    conn.workspaces().then(
      (list) => {
        setRows(list);
        setListError('');
      },
      (err: unknown) => setListError(errText(err)),
    );
  }, [conn]);

  /** Esc → 回会话态(与返回钮同路径) */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onBack();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onBack]);

  const paneDef = SETTINGS_PANES.find((p) => p.id === activePane) ?? SETTINGS_PANES[0]!;

  return (
    <>
      <nav className="sx-menu" aria-label="settings">
        <header className="sx-menu-head sx-settings-head">
          <button type="button" className="sx-settings-back" onClick={onBack}>
            ← 返回
          </button>
          <span>设置</span>
        </header>
        <div className="sx-settings-project">
          <select aria-label="settings project" value={root} onChange={(e) => onRootChange(e.target.value)}>
            <option value="">(仅全局)</option>
            {rows?.map((row) =>
              row.root === undefined ? null : (
                <option key={row.slug} value={row.root}>
                  {row.slug}
                </option>
              ),
            )}
          </select>
          {listError !== '' && <p className="home-error" role="alert">{listError}</p>}
        </div>
        <ul className="sx-settings-nav">
          {SETTINGS_PANES.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={`sx-settings-nav-item${p.id === activePane ? ' active' : ''}`}
                aria-current={p.id === activePane ? 'true' : undefined}
                onClick={() => setActivePane(p.id)}
              >
                {p.title}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className="sx-main">
        <SettingsForm key={paneDef.id} conn={conn} root={root} pane={paneDef} />
      </main>
    </>
  );
}
