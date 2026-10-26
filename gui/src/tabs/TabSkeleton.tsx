import { t } from '../i18n';

/** 2026-10-26 二期分包:lazy 标签体加载骨架——标签体同构空态(标题行+shimmer 三行),与
 *  sx-tab-empty 视觉同族;Suspense fallback 消费(App tabbody 调用点) */
export function TabSkeleton(): JSX.Element {
  return (
    <div className="sx-tab-skeleton" aria-label={t('Loading tab', '标签加载中')} role="status">
      <div className="sx-tab-skeleton-title" />
      <div className="sx-tab-skeleton-row" />
      <div className="sx-tab-skeleton-row" />
      <div className="sx-tab-skeleton-row short" />
    </div>
  );
}
