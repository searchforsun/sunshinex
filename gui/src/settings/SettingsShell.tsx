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
import { GlobalRulesPane } from './GlobalRulesPane';
import type { GlobalRulesPaneConn } from './GlobalRulesPane';
import { SkillsPane } from './SkillsPane';
import type { SkillsPaneConn } from './SkillsPane';
import { PermissionsPane } from './PermissionsPane';
import type { PermissionsPaneConn } from './PermissionsPane';
import { RawPane } from './RawPane';
import type { RawPaneConn } from './RawPane';
import { TeamsPane } from './TeamsPane';
import type { TeamsPaneConn } from './TeamsPane';
import { ShortcutsPane } from './ShortcutsPane';
import type { SettingsScope, ScopeOption } from './components';
import { defaultScopeOptions, scopeTargetLabel } from './components';
import type { WorkspaceRow } from '../connection';
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
 * 2026-10-29 用户裁定(作用域下拉改目标选择器):两选项「具体项目|全局」退役——下拉改
 * **目标选择器**:选项=「全局」+ 全部已注册项目(GET /workspaces 注册表,按项目名=basename
 * 排序;当前打开项目不在注册表仍补列),选哪个项目,资源页就读写哪个项目的配置(不再限
 * 于当前打开的会话项目)。壳层状态 targetRoot('' = 全局;缺省=当前打开项目 root)替换旧
 * scope 二值;下发给资源 pane 的换发内容=scope(按 targetRoot 推导)+ root=targetRoot +
 * scopeOptions(选项清单)+ onScopeChange(上抛新 targetRoot 字符串)——pane 读写逻辑零改动,
 * 仅壳层换发内容变。四 SettingsForm 简单页与权限/高级两页维持快照 root 语义(非资源页,不随
 * 下拉)。注册表拉取失败时保留缺省选项面(全局+当前打开项目),不阻塞设置态。
 * 2026-10-29 用户裁定(五条修正):①Skills 工具栏合并为**项目下拉**(全部项目|全局|项目们)
 * ——'all' 态壳层不感知(壳不下发 root,SkillsPane 自持 scope=all 拉取);全局/项目两态仍上抛
 * 同步本壳 targetRoot。④提供方页即全局(模型/提供方全局豁免)——本壳不再向 ProvidersPane
 * 下发 root/scope/选项面,页面工具栏只留新增钮。
 * 2026-11-04 agents-teams P1 Task 3:导航十二项——Integrations 组 agents 后插「智能体团队」
 * (TeamsPane,spec §6.2):teams 三端点(GET 清单/PUT op 写面/GET body 章程全文)接线,五件套
 * (root/scope/onScopeChange/scopeOptions/refreshTick.teams)下发同款,目标选择器状态留本壳。
 */

/** 壳连接面:全部面板连接面的并集(结构满足即收,App 传整只 Connection)。
 *  RawPaneConn 的 settings 以 Omit 剥除——SettingsFormConn 已供全量 SettingsView 形(其含可选
 *  warnings,结构满足 RawPane/PermissionsPane 的告警/权限子集面;接口 extends 同名成员须同一性,
 *  故在此收窄拼接)。T21 并入 config-changed 订阅面(ConfigChangedSource——顶栏 useConfigChanged
 *  的 conn 依赖;App 的 Connection 已供 onConfigChanged 注册点)。T26 并入 ProvidersPaneConn
 *  (providers 面扩 putProviderOp op 端点写面——旧形=SettingsFormConn 子集无需单列)。
 *  2026-10-29 目标选择器并入 workspaces()(GET /workspaces 注册表——五资源页作用域下拉的
 *  注册项目清单数据源;既有端点,零新造)。2026-11-04 agents-teams P1 Task 3 并入
 *  TeamsPaneConn(teams 三端点:teamsView/putTeamOp/teamBody——成员多选数据源复用
 *  AgentsPaneConn.agentsView) */
export interface SettingsShellConn extends SettingsFormConn, ProvidersPaneConn, McpPaneConn, PluginsPaneConn, AgentsPaneConn, TeamsPaneConn, SkillsPaneConn, PermissionsPaneConn, GlobalRulesPaneConn, ConfigChangedSource, Omit<RawPaneConn, 'settings'> {
  /** GET /workspaces:工作区注册表扫描(T2;行含 slug+root——root 缺档历史行不可选) */
  workspaces(): Promise<WorkspaceRow[]>;
}

/** 全十项导航(G10-C5 Codex 分组制:Personal/Coding/Integrations + 权限/高级殿后)。
 *  标题双语对(G14.213 设置面 i18n):渲染期 t() 求值——此前裸中文,壳层导航永不随语言切换 */
const SETTINGS_GROUPS: ReadonlyArray<{ readonly group: { readonly en: string; readonly zh: string } | ''; readonly items: ReadonlyArray<{ readonly id: string; readonly title: { readonly en: string; readonly zh: string } }> }> = [
  {
    group: { en: 'Personal', zh: '个人' },
    items: [
      { id: 'general', title: { en: 'General', zh: '通用' } },
      { id: 'providers', title: { en: 'Models & providers', zh: '模型与提供方' } },
      { id: 'shortcuts', title: { en: 'Shortcuts', zh: '快捷键' } },
    ],
  },
  {
    group: { en: 'Coding', zh: '编码' },
    items: [
      { id: 'limits', title: { en: 'Context & limits', zh: '上下文与限额' } },
      { id: 'memory', title: { en: 'Memory', zh: '记忆' } },
      { id: 'global-rules', title: { en: 'Global norms', zh: '全局规范' } },
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
      { id: 'teams', title: { en: 'Agent Teams', zh: '智能体团队' } },
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
  /** 指定落点面板(托盘「快捷键」直达):对象身份变化即切换,缺省=「通用」 */
  readonly requestedPane?: { readonly id: string };
}

export function SettingsShell({ conn, root, onBack, requestedPane }: SettingsShellProps): JSX.Element {
  const [activePane, setActivePane] = useState(requestedPane?.id ?? SETTINGS_NAV[0]!.id); // 默认「通用」
  useEffect(() => {
    if (requestedPane !== undefined) setActivePane(requestedPane.id);
  }, [requestedPane]);
  /** G14.213 语言切换 tick:SettingsForm 语言键保存 → onLanguageChanged → 本壳重渲染
   *  (t 非响应式——导航/分组/壳头等本组件的 t() 面不 tick 不翻面) */
  const [, setLangTick] = useState(0);
  /** 作用域目标选择器状态(2026-10-29 用户裁定,替换旧 scope 二值):targetRoot=当前目标
   *  项目 root('' = 全局;缺省=当前打开项目 root——root='' 时缺省全局)。root 维持快照语义
   *  (打开设置时的活动工作区,只读不改——仅作缺省目标与兜底) */
  const [targetRoot, setTargetRoot] = useState<string>(root);
  useEffect(() => {
    if (root === '') setTargetRoot(''); // root 快照变化兜底(理论不发生——防御面)
  }, [root]);
  /** 下拉选项清单(全局+全部注册项目按项目名;缺省面=全局+当前打开项目,注册表应答后替换;
   *  打开项目不在注册表仍补列并保持选中) */
  const [scopeOptions, setScopeOptions] = useState<readonly ScopeOption[]>(() => defaultScopeOptions(root));
  useEffect(() => {
    let alive = true;
    conn.workspaces().then(
      (rows) => {
        if (!alive) return;
        const seen = new Set<string>();
        const projects: ScopeOption[] = [];
        for (const row of rows as WorkspaceRow[]) {
          const r = row.root;
          if (r === undefined || r === '' || seen.has(r)) continue; // 历史无档行不可 attach——不列
          seen.add(r);
          projects.push({ value: r, label: scopeTargetLabel(r) });
        }
        projects.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)); // 按项目名(码点序)
        // 'default' 是欢迎页默认工作区的字面哨兵(锚点未解析前),真身=注册表里 sunshinex-default
        // 锚点行:映射过去并选中它,不另列一个名为 default 的伪项目
        if (root === 'default') {
          const anchor = projects.find((p) => p.label.startsWith('sunshinex-default'));
          if (anchor !== undefined) setTargetRoot((cur) => (cur === 'default' ? anchor.value : cur));
        } else if (root !== '' && !seen.has(root)) projects.push({ value: root, label: scopeTargetLabel(root) }); // 打开项目不在注册表:仍列入
        setScopeOptions([{ value: '', label: t('Global', '全局') }, ...projects]);
      },
      () => {
        /* 注册表拉取失败:保留缺省选项面(全局+当前打开项目)——不阻塞设置态 */
      },
    );
    return () => {
      alive = false;
    };
  }, [conn, root]);
  /** 换发取参单点:scope 按 targetRoot 推导('' = global);五资源 pane 的 onScopeChange 上抛
   *  新 targetRoot 字符串,回写后随 re-render 换发(pane 按新 root/scope 重拉) */
  const scope: SettingsScope = targetRoot === '' ? 'global' : 'project';
  const onTargetChange = (next: string): void => setTargetRoot(next);
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
   *  下发(pane 工具栏 ScopeSelect 上抛,状态回写本壳)。
   *  2026-10-29 目标选择器:五资源 pane 换发内容改 root=targetRoot + scope(按 targetRoot
   *  推导)+ scopeOptions(注册项目清单)+ onScopeChange(targetRoot 字符串)——pane 读写逻辑
   *  零改动;四 SettingsForm 简单页与权限/高级两页维持快照 root(非资源页,不随下拉) */
  const renderPane = (): JSX.Element => {
    const formDef = SETTINGS_PANES.find((p) => p.id === activePane);
    if (formDef !== undefined)
      return (
        <SettingsForm key={formDef.id} conn={conn} root={root} pane={formDef} scope={scope} refreshTick={refreshTick.settings} onLanguageChanged={() => setLangTick((v) => v + 1)} />
      );
    switch (activePane) {
      case 'providers':
        // 2026-10-29 用户裁定:提供方页即全局——不下发 root/scope/下拉选项(页面不再提供项目切换)
        return <ProvidersPane key="providers" conn={conn} refreshTick={refreshTick.providers} />;
      case 'mcp':
        return <McpPane key="mcp" conn={conn} root={targetRoot} scope={scope} onScopeChange={onTargetChange} scopeOptions={scopeOptions} refreshTick={refreshTick.mcp} />;
      case 'plugins':
        return <PluginsPane key="plugins" conn={conn} root={targetRoot} scope={scope} onScopeChange={onTargetChange} scopeOptions={scopeOptions} refreshTick={refreshTick.plugins} />;
      case 'agents':
        return <AgentsPane key="agents" conn={conn} root={targetRoot} scope={scope} onScopeChange={onTargetChange} scopeOptions={scopeOptions} refreshTick={refreshTick.agents} />;
      case 'global-rules':
        // 全局规范(2026-11-05):全局 SUNSHINE.md 编辑器——仅全局作用域,无 root/下拉
        return <GlobalRulesPane key="global-rules" conn={conn} refreshTick={refreshTick.sunshine} />;
      case 'teams':
        // agents-teams P1 Task 3:智能体团队面(TeamsPane 五件套下发同款——目标选择器状态留本壳)
        return <TeamsPane key="teams" conn={conn} root={targetRoot} scope={scope} onScopeChange={onTargetChange} scopeOptions={scopeOptions} refreshTick={refreshTick.teams} />;
      case 'skills':
        // 2026-10-29 用户裁定:Skills 工具栏合并为项目下拉(全部项目|全局|项目们)——'all' 态
        // 壳层不感知(pane 自持 scope=all 拉取,不上抛);全局/项目两态经 onScopeChange 同步本壳
        return <SkillsPane key="skills" conn={conn} root={targetRoot} title={t('Skills', '技能')} onScopeChange={onTargetChange} scopeOptions={scopeOptions} refreshTick={refreshTick.skills} />;
      case 'permissions':
        return <PermissionsPane key="permissions" conn={conn} root={root} title={t('Permissions', '权限')} scope={scope} refreshTick={refreshTick.permissions} />;
      case 'shortcuts':
        // 快捷键说明页(纯静态文档面,无连接面/读写)
        return <ShortcutsPane key="shortcuts" />;
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
        <header className="sx-menu-head sx-settings-head" data-drag-band>
          {/* 2026-10-29 用户裁定:返回钮套用侧栏目录视图返回钮同款样式槽(sx-new-chat=图标+文字胶囊) */}
          {/* 悬浮提示带键位:Esc 与本钮同路径回会话态(§快捷键说明页) */}
          <button type="button" className="sx-new-chat" onClick={onBack} aria-label="back to sessions" data-tip={`${t('Back', '返回')} · Esc`}>
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
      <main className="sx-main sx-settings-main">
        {/* 顶部遮盖条(2026-10-29 用户裁定「右侧设置正文顶部一行作为遮盖区,和主对话一样」):
            正文在视口内滚动,物理上进不了条区;空带兼窗拖拽 */}
        <div className="sx-settings-topbar" data-drag-band aria-hidden="true" />
        <div className="sx-settings-viewport">{renderPane()}</div>
      </main>
    </>
  );
}
