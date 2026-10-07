import { useEffect, useState } from 'react';
import type { WorkspaceRow } from '../connection';
import { SettingsForm, SETTINGS_PANES } from './SettingsForm';
import type { SettingsFormConn } from './SettingsForm';
import { ProvidersPane } from './ProvidersPane';
import { McpPane } from './McpPane';
import type { McpPaneConn } from './McpPane';
import { AgentsPane } from './AgentsPane';
import type { AgentsPaneConn } from './AgentsPane';
import { SkillsPermsPane } from './SkillsPermsPane';
import type { SkillsPermsPaneConn } from './SkillsPermsPane';
import { RawPane } from './RawPane';
import type { RawPaneConn } from './RawPane';

/**
 * G8c T8/T9 设置态壳:App settingsOpen 时整体替换三栏内容——左栏(顶栏「← 返回」+ 项目
 * 选择器 + 导航列表)+ 主区(所选面板);右标签栏由 App 不渲染(设置态外置)。Esc 与返回
 * 钮同路径回会话态(document keydown——设置态独占窗,Chat 已卸载无冲突面)。
 * 项目选择器(aria-label="settings project"):空选项「(仅全局)」+ /workspaces 列表
 * (root 在场的组;Shell 自拉 conn.workspaces()),当前值 = settingsRoot(App 态——切换经
 * onRootChange 上抛,面板随 root 重拉)。
 * T9 导航扩全十项(spec §2.5 分组列示序):通用/模型与提供方/插件(技能·MCP·智能体)/
 * 上下文与限额/记忆/权限/知识库与搜索/高级——四简单面板走 SettingsForm(SETTINGS_PANES
 * 定义),五复杂面板各自组件(ProvidersPane/McpPane/AgentsPane/SkillsPermsPane/RawPane;
 * 「插件:技能」与「权限」两导航项同体渲染 SkillsPermsPane——上技能下权限,只读)。
 * 选中态 activePane 本地 state(默认「通用」),主区以 key={paneId} 挂载(面板互切强制
 * 重挂——键集/输入值面整体复位)。
 */

/** 壳连接面:workspaces(项目选择器)+ 全部面板连接面的并集(结构满足即收,App 传整只 Connection) */
export interface SettingsShellConn extends SettingsFormConn, McpPaneConn, AgentsPaneConn, SkillsPermsPaneConn, RawPaneConn {
  workspaces(): Promise<WorkspaceRow[]>;
}

/** 全十项导航(id=渲染分发键;列示序沿 spec §2.5 分组) */
const SETTINGS_NAV: ReadonlyArray<{ readonly id: string; readonly title: string }> = [
  { id: 'general', title: '通用' },
  { id: 'providers', title: '模型与提供方' },
  { id: 'skills', title: '插件:技能' },
  { id: 'mcp', title: 'MCP' },
  { id: 'agents', title: '智能体' },
  { id: 'limits', title: '上下文与限额' },
  { id: 'memory', title: '记忆' },
  { id: 'permissions', title: '权限' },
  { id: 'kb', title: '知识库与搜索' },
  { id: 'raw', title: '高级' },
];

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
  const [activePane, setActivePane] = useState(SETTINGS_NAV[0]!.id); // 默认「通用」

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

  /** 主区渲染分发:表单面板查 SETTINGS_PANES 定义,复杂面板各归其件(skills/permissions 同体) */
  const renderPane = (): JSX.Element => {
    const formDef = SETTINGS_PANES.find((p) => p.id === activePane);
    if (formDef !== undefined) return <SettingsForm key={formDef.id} conn={conn} root={root} pane={formDef} />;
    switch (activePane) {
      case 'providers':
        return <ProvidersPane key="providers" conn={conn} root={root} />;
      case 'mcp':
        return <McpPane key="mcp" conn={conn} root={root} />;
      case 'agents':
        return <AgentsPane key="agents" conn={conn} root={root} />;
      case 'skills':
      case 'permissions':
        return <SkillsPermsPane key={activePane} conn={conn} root={root} title={SETTINGS_NAV.find((n) => n.id === activePane)!.title} />;
      default:
        return <RawPane key="raw" conn={conn} root={root} />;
    }
  };

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
          {SETTINGS_NAV.map((p) => (
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
      <main className="sx-main">{renderPane()}</main>
    </>
  );
}
