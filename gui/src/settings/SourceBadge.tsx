/**
 * G8c T8 来源徽标(SettingsShell 表单行消费;设置重构二轮):SettingsKeyRow.source 四态
 * effective 归因的渲染面——键名**后置**单色 hairline chip(env/project/global 三态文案,
 * default 隐藏不占位;前置圆点已移除——键名恒左对齐,色彩区分面撤销,title=来源说明 hover
 * 提示)。类名 sx-src-{source} 供测试与样式定位。纯展示组件,零状态。
 */

import { t } from '../i18n';
export type SettingsSource = 'env' | 'project' | 'global' | 'default';

/** 非默认三态的文案与说明(default 无徽标不载;双语对渲染期 t() 求值——G14.213 设置面 i18n) */
const BADGES: Record<Exclude<SettingsSource, 'default'>, { en: string; zh: string; titleEn: string; titleZh: string }> = {
  env: { en: 'env', zh: 'env', titleEn: 'Overridden by env (highest priority)', titleZh: '环境变量覆盖(优先级最高)' },
  project: { en: 'Project', zh: '项目', titleEn: 'Project settings (project settings file)', titleZh: '项目级配置(项目 settings 文件)' },
  global: { en: 'Global', zh: '全局', titleEn: 'Global settings (user settings file)', titleZh: '全局配置(用户级 settings 文件)' },
};

export interface SourceBadgeProps {
  readonly source: SettingsSource;
}

export function SourceBadge({ source }: SourceBadgeProps): JSX.Element {
  if (source === 'default') return <span className="sx-src-badge sx-src-default" />;
  const b = BADGES[source];
  return (
    <span className={`sx-src-badge sx-src-${source}`} data-tip={t(b.titleEn, b.titleZh)}>
      {t(b.en, b.zh)}
    </span>
  );
}
