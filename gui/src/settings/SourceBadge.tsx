/**
 * G8c T8 来源徽标(SettingsShell 表单行消费):SettingsKeyRow.source 四态 effective 归因的
 * 渲染面——env=橙点+「env」/project=蓝点+「项目」/global=灰点+「全局」/default=无徽标(渲染
 * 空 span,占位保行内布局稳定)。title=来源说明(hover 提示);类名 sx-src-{source} 供测试
 * 与样式定位。纯展示组件,零状态。
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
    <span className={`sx-src-badge sx-src-${source}`} title={b.title}>
      {b.text}
    </span>
  );
}
