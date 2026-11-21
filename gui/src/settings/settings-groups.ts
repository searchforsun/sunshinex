/**
 * 设置导航分组数据(2026-11-21 从 SettingsShell 抽出):壳层与全局搜索索引共用同一份
 * 面板清单/标题——settings-search 不再反向 import 组件模块,消除循环依赖。
 */
export interface SettingsGroupDef {
  readonly group: { readonly en: string; readonly zh: string } | '';
  readonly advanced?: boolean;
  readonly items: ReadonlyArray<{ readonly id: string; readonly title: { readonly en: string; readonly zh: string } }>;
}

export const SETTINGS_GROUPS: ReadonlyArray<SettingsGroupDef> = [
  {
    group: { en: 'Basics', zh: '基础' },
    items: [
      { id: 'general', title: { en: 'General', zh: '通用' } },
      { id: 'providers', title: { en: 'Models & providers', zh: '模型与提供方' } },
      { id: 'storage', title: { en: 'Storage', zh: '存储' } },
      { id: 'shortcuts', title: { en: 'Shortcuts', zh: '快捷键' } },
    ],
  },
  {
    group: { en: 'Context & memory', zh: '上下文与记忆' },
    advanced: true,
    items: [
      { id: 'limits', title: { en: 'Context & limits', zh: '上下文与限额' } },
      { id: 'memory', title: { en: 'Memory', zh: '记忆' } },
      { id: 'kb', title: { en: 'Knowledge & search', zh: '知识库与搜索' } },
      { id: 'global-rules', title: { en: 'Global norms', zh: '全局规范' } },
    ],
  },
  {
    group: { en: 'Execution & extensions', zh: '执行与扩展' },
    advanced: true,
    items: [
      { id: 'paths', title: { en: 'Paths & shell', zh: '路径与执行环境' } },
      { id: 'skills', title: { en: 'Skills', zh: '技能' } },
      { id: 'mcp', title: { en: 'MCP', zh: 'MCP' } },
      { id: 'plugins', title: { en: 'Plugins', zh: '插件' } },
    ],
  },
  {
    group: { en: 'Agents', zh: '智能体' },
    advanced: true,
    items: [
      { id: 'agents', title: { en: 'Agents', zh: '智能体' } },
      { id: 'teams', title: { en: 'Agent Teams', zh: '智能体团队' } },
    ],
  },
  {
    group: { en: 'System', zh: '系统' },
    advanced: true,
    items: [
      { id: 'permissions', title: { en: 'Permissions', zh: '权限' } },
      { id: 'raw', title: { en: 'Advanced', zh: '高级' } },
    ],
  },
];
