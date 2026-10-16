/**
 * G8c T8 来源徽标(SettingsShell 表单行消费;设置重构二轮):SettingsKeyRow.source 四态
 * effective 归因的渲染面——键名**后置**单色 hairline chip(env/project/global 三态文案,
 * default 隐藏不占位;前置圆点已移除——键名恒左对齐,色彩区分面撤销,title=来源说明 hover
 * 提示)。类名 sx-src-{source} 供测试与样式定位。纯展示组件,零状态。
 */

export type SettingsSource = 'env' | 'project' | 'global' | 'default';

/** 非默认三态的文案与说明(default 无徽标不载) */
const BADGES: Record<Exclude<SettingsSource, 'default'>, { text: string; title: string }> = {
  env: { text: 'env', title: '环境变量覆盖(优先级最高)' },
  project: { text: '项目', title: '项目级配置(项目 settings 文件)' },
  global: { text: '全局', title: '全局配置(用户级 settings 文件)' },
};

export interface SourceBadgeProps {
  readonly source: SettingsSource;
}

export function SourceBadge({ source }: SourceBadgeProps): JSX.Element {
  if (source === 'default') return <span className="sx-src-badge sx-src-default" />;
  const b = BADGES[source];
  return (
    <span className={`sx-src-badge sx-src-${source}`} data-tip={b.title}>
      {b.text}
    </span>
  );
}
