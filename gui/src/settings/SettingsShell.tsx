import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { t } from '../i18n';
import { SettingsForm, SETTINGS_PANES } from './SettingsForm';
import type { SettingsFormConn } from './SettingsForm';
import { ProvidersPane } from './ProvidersPane';
import type { ProvidersPaneConn } from './ProvidersPane';
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
import type { SettingsScope } from './components';
import { useConfigChanged } from './use-config-changed';
import type { ConfigChangedSource } from './use-config-changed';

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
 * T21(2026-10-28 设置共享组件轮):scope 状态提升本壳('global'|'project',缺省 project、
 * 无 root 强制 global,root 快照语义不变),连同 config-changed 订阅 tick(useConfigChanged——
 * WS 帧按 resource 合并 200ms 递增,见 use-config-changed)经 props 下发各 pane(pane 侧可选
 * props,本任务零行为变化;T22 起逐页解构消费)。
 * 2026-10-29 用户裁定(工具栏三件套入页):壳顶 ScopeSwitcher 分段控件撤除——scope 切换面
 * 下沉为各资源页工具栏内联 ScopeSelect 下拉(五资源页:MCP/插件/Skills/智能体/提供方);
 * scope 状态仍留本壳统一持有,经 scope + onScopeChange 两 props 下发(pane 内下拉只上抛,
 * 状态回写本壳后随 re-render 回流)。原 T21 顶栏挂点移除,本壳其余职责不变。
 */

/** 壳连接面:全部面板连接面的并集(结构满足即收,App 传整只 Connection)。
 *  RawPaneConn 的 settings 以 Omit 剥除——SettingsFormConn 已供全量 SettingsView 形(其含可选
 *  warnings,结构满足 RawPane/PermissionsPane 的告警/权限子集面;接口 extends 同名成员须同一性,
 *  故在此收窄拼接)。T21 并入 config-changed 订阅面(ConfigChangedSource——顶栏 useConfigChanged
 *  的 conn 依赖;App 的 Connection 已供 onConfigChanged 注册点)。T26 并入 ProvidersPaneConn
 *  (providers 面扩 putProviderOp op 端点写面——旧形=SettingsFormConn 子集无需单列) */
export interface SettingsShellConn extends SettingsFormConn, ProvidersPaneConn, McpPaneConn, PluginsPaneConn, AgentsPaneConn, SkillsPaneConn, PermissionsPaneConn, ConfigChangedSource, Omit<RawPaneConn, 'settings'> {}

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
  /** T21 作用域状态提升(顶栏 ScopeSwitcher):缺省 project;无 root 强制 global(项目侧禁用,
   *  本处与回调双闸)。root 维持快照语义(打开设置时的活动工作区,只读不改) */
  const [scope, setScope] = useState<SettingsScope>(root === '' ? 'global' : 'project');
  useEffect(() => {
    if (root === '') setScope('global'); // root 快照变化兜底(理论不发生——防御面)
  }, [root]);
  const onScopeChange = (next: SettingsScope): void => {
    if (next === 'project' && root === '') return; // 无项目上下文:项目侧不可选
    setScope(next);
  };
  /** T21 config-changed 订阅:按 resource 合并 200ms 的 tick 计数——逐 pane 经 props 下发
   *  (pane 以自身 resource 的 tick 变化为外部改动信号触发重拉;T22 起逐页消费) */
  const refreshTick = useConfigChanged(conn);

  /** Esc → 回会话态(与返回钮同路径) */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onBack();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onBack]);

  /** 主区渲染分发:表单面板查 SETTINGS_PANES 定义,复杂面板各归其件(skills/permissions 同体)。
   *  T21:scope 与对应 resource 的 refreshTick 经 props 下发各 pane(可选 props——本任务 pane
   *  零行为变化,T22 起逐页解构消费;RawPane 全局/项目 raw 文件共用,下发 scope+root——T27 起
   *  project 作用域读写带 root 定位,global 省参)。2026-10-29:五资源页再加 onScopeChange
   *  下发(pane 工具栏 ScopeSelect 上抛,状态回写本壳) */
  const renderPane = (): JSX.Element => {
    const formDef = SETTINGS_PANES.find((p) => p.id === activePane);
    if (formDef !== undefined)
      return (
        <SettingsForm key={formDef.id} conn={conn} root={root} pane={formDef} scope={scope} refreshTick={refreshTick.settings} onLanguageChanged={() => setLangTick((v) => v + 1)} />
      );
    switch (activePane) {
      case 'providers':
        return <ProvidersPane key="providers" conn={conn} root={root} scope={scope} onScopeChange={onScopeChange} refreshTick={refreshTick.providers} />;
      case 'mcp':
        return <McpPane key="mcp" conn={conn} root={root} scope={scope} onScopeChange={onScopeChange} refreshTick={refreshTick.mcp} />;
      case 'plugins':
        return <PluginsPane key="plugins" conn={conn} root={root} scope={scope} onScopeChange={onScopeChange} refreshTick={refreshTick.plugins} />;
      case 'agents':
        return <AgentsPane key="agents" conn={conn} root={root} scope={scope} onScopeChange={onScopeChange} refreshTick={refreshTick.agents} />;
      case 'skills':
        return <SkillsPane key="skills" conn={conn} root={root} title={t('Skills', '技能')} scope={scope} onScopeChange={onScopeChange} refreshTick={refreshTick.skills} />;
      case 'permissions':
        return <PermissionsPane key="permissions" conn={conn} root={root} title={t('Permissions', '权限')} scope={scope} refreshTick={refreshTick.permissions} />;
      default:
        return <RawPane key="raw" conn={conn} root={root} scope={scope} />;
    }
  };

  return (
    <>
      {/* sx-settings-menu(2026-10-25 用户裁定):设置态菜单列随窗收窄可缩(flex 0 1 auto),
          下限=导航最长项「知识库与搜索」min-content——窄窗先压左栏到导航可读下限,右侧表单
          (240px 控件列)不再被挤压逐字断行;会话态菜单列保持 flex:none 拖宽钉值不受此影响 */}
      <nav className="sx-menu sx-settings-menu" aria-label={t('settings', '设置')}>
        <header className="sx-menu-head sx-settings-head">
          {/* 2026-10-29 用户裁定:返回钮套用侧栏目录视图返回钮同款样式槽(sx-new-chat=图标+文字胶囊) */}
          <button type="button" className="sx-new-chat" onClick={onBack} aria-label="back to sessions">
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>{t('Back', '返回')}</span>
          </button>
          <span>{t('Settings', '设置')}</span>
          {/* 2026-10-29 用户裁定:壳顶作用域分段控件撤除——切换面下沉五资源页工具栏 ScopeSelect
              (scope 状态仍本壳持有,经 scope+onScopeChange 下发,见 renderPane) */}
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
