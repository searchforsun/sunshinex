import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { SettingsForm, SETTINGS_PANES } from './SettingsForm';
import type { SettingsFormConn } from './SettingsForm';
import { ProvidersPane } from './ProvidersPane';
import { McpPane } from './McpPane';
import type { McpPaneConn } from './McpPane';
import { PluginsPane } from './PluginsPane';
import type { PluginsPaneConn } from './PluginsPane';
import { AgentsPane } from './AgentsPane';
import type { AgentsPaneConn } from './AgentsPane';
import { SkillsPane } from './SkillsPane';
import type { SkillsPaneConn } from './SkillsPane';
import { PermissionsPane } from './PermissionsPane';
import type { PermissionsPaneConn } from './PermissionsPane';
import { RawPane } from './RawPane';
import type { RawPaneConn } from './RawPane';

/**
 * G8c T8/T9 设置态壳(设置重构轮):App settingsOpen 时整体替换三栏内容——左栏(顶栏「← 返回」
 * + 导航列表)+ 主区(所选面板);右标签栏由 App 不渲染(设置态外置)。Esc 与返回钮同路径回
 * 会话态(document keydown——设置态独占窗,Chat 已卸载无冲突面)。
 * 顶部项目选择器与外观行已移除(设置重构轮):项目区分下沉到配置项——行首 SourceBadge 徽标
 * 逐项标示 effective 来源(env/项目/全局/缺省),改动逐项写回来源文件(表单引擎见 SettingsForm);
 * 外观主题移入「通用」首卡(ThemeRow)。root 为隐式项目上下文(App 快照打开设置时的活动工作区),
 * 只读不改——项目级行的读写锚,无顶部切换面。
 * T9 导航扩全十项(spec §2.5 分组列示序):通用/模型与提供方/上下文与限额/记忆/知识库与搜索/
 * 技能/MCP/智能体/权限/高级——四简单面板走 SettingsForm(SETTINGS_PANES 定义),五复杂
 * 面板各自组件(ProvidersPane/McpPane/AgentsPane/SkillsPane/PermissionsPane/RawPane;
 * 设置重构二轮起「技能」「权限」两导航项各自独立面板——原同体渲染致内容重复,已拆分)。
 * 2026-10-26 插件面:导航十一项——Integrations 组 MCP 后插「插件」(PluginsPane,spec §6)。
 * 选中态 activePane 本地 state(默认「通用」),主区以 key={paneId} 挂载(面板互切强制重挂——
 * 键集/输入值面整体复位)。
 */

/** 壳连接面:全部面板连接面的并集(结构满足即收,App 传整只 Connection)。
 *  RawPaneConn 的 settings 以 Omit 剥除——SettingsFormConn 已供全量 SettingsView 形(其含可选
 *  warnings,结构满足 RawPane/PermissionsPane 的告警/权限子集面;接口 extends 同名成员须同一性,
 *  故在此收窄拼接) */
export interface SettingsShellConn extends SettingsFormConn, McpPaneConn, PluginsPaneConn, AgentsPaneConn, SkillsPaneConn, PermissionsPaneConn, Omit<RawPaneConn, 'settings'> {}

/** 全十项导航(G10-C5 Codex 分组制:Personal/Coding/Integrations + 权限/高级殿后)。
 *  标题双语对(G14.213 设置面 i18n):渲染期 t() 求值——此前裸中文,壳层导航永不随语言切换 */
const SETTINGS_GROUPS: ReadonlyArray<{ readonly group: { readonly en: string; readonly zh: string } | ''; readonly items: ReadonlyArray<{ readonly id: string; readonly title: { readonly en: string; readonly zh: string } }> }> = [
  {
    group: { en: 'Personal', zh: '个人' },
    items: [
      { id: 'general', title: { en: 'General', zh: '通用' } },
      { id: 'providers', title: { en: 'Models & providers', zh: '模型与提供方' } },
    ],
  },
  {
    group: { en: 'Coding', zh: '编码' },
    items: [
      { id: 'limits', title: { en: 'Context & limits', zh: '上下文与限额' } },
      { id: 'memory', title: { en: 'Memory', zh: '记忆' } },
      { id: 'kb', title: { en: 'Knowledge & search', zh: '知识库与搜索' } },
    ],
  },
  {
    group: { en: 'Integrations', zh: '集成' },
    items: [
      { id: 'skills', title: { en: 'Skills', zh: '技能' } },
      { id: 'mcp', title: { en: 'MCP', zh: 'MCP' } },
      { id: 'plugins', title: { en: 'Plugins', zh: '插件' } },
      { id: 'agents', title: { en: 'Agents', zh: '智能体' } },
    ],
  },
  { group: '', items: [{ id: 'permissions', title: { en: 'Permissions', zh: '权限' } }, { id: 'raw', title: { en: 'Advanced', zh: '高级' } }] },
];
const SETTINGS_NAV = SETTINGS_GROUPS.flatMap((g) => g.items);

/** 错误文案归一:G8e-T2 抽共享 ui-util */

export interface SettingsShellProps {
  readonly conn: SettingsShellConn;
  /** 隐式项目上下文('' = 仅全局;App 快照打开设置时的活动工作区,无切换面) */
  readonly root: string;
  /** 「← 返回」/Esc:回会话态(App 侧关设置态) */
  readonly onBack: () => void;
}

export function SettingsShell({ conn, root, onBack }: SettingsShellProps): JSX.Element {
  const [activePane, setActivePane] = useState(SETTINGS_NAV[0]!.id); // 默认「通用」
  /** G14.213 语言切换 tick:SettingsForm 语言键保存 → onLanguageChanged → 本壳重渲染
   *  (t 非响应式——导航/分组/壳头等本组件的 t() 面不 tick 不翻面) */
  const [, setLangTick] = useState(0);

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
    if (formDef !== undefined)
      return <SettingsForm key={formDef.id} conn={conn} root={root} pane={formDef} onLanguageChanged={() => setLangTick((v) => v + 1)} />;
    switch (activePane) {
      case 'providers':
        return <ProvidersPane key="providers" conn={conn} root={root} />;
      case 'mcp':
        return <McpPane key="mcp" conn={conn} root={root} />;
      case 'plugins':
        return <PluginsPane key="plugins" conn={conn} root={root} />;
      case 'agents':
        return <AgentsPane key="agents" conn={conn} root={root} />;
      case 'skills':
        return <SkillsPane key="skills" conn={conn} root={root} title={t('Skills', '技能')} />;
      case 'permissions':
        return <PermissionsPane key="permissions" conn={conn} root={root} title={t('Permissions', '权限')} />;
      default:
        return <RawPane key="raw" conn={conn} />;
    }
  };

  return (
    <>
      {/* sx-settings-menu(2026-10-25 用户裁定):设置态菜单列随窗收窄可缩(flex 0 1 auto),
          下限=导航最长项「知识库与搜索」min-content——窄窗先压左栏到导航可读下限,右侧表单
          (240px 控件列)不再被挤压逐字断行;会话态菜单列保持 flex:none 拖宽钉值不受此影响 */}
      <nav className="sx-menu sx-settings-menu" aria-label={t('settings', '设置')}>
        <header className="sx-menu-head sx-settings-head">
          <button type="button" className="sx-settings-back" onClick={onBack}>
            {t('← Back', '← 返回')}
          </button>
          <span>{t('Settings', '设置')}</span>
        </header>
        <ul className="sx-settings-nav">
          {SETTINGS_GROUPS.map((g) => (
            <li key={g.group === '' ? 'plain' : g.group.en}>
              {g.group !== '' && <div className="sx-settings-group">{t(g.group.en, g.group.zh)}</div>}
              <ul className="sx-settings-group-items">
                {g.items.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className={`sx-settings-nav-item${p.id === activePane ? ' active' : ''}`}
                      aria-current={p.id === activePane ? 'true' : undefined}
                      onClick={() => setActivePane(p.id)}
                    >
                      {t(p.title.en, p.title.zh)}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </nav>
      <main className="sx-main sx-settings-main">{renderPane()}</main>
    </>
  );
}
