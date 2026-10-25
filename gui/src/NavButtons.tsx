import { ArrowLeft, ArrowRight } from 'lucide-react';
import { t } from './i18n';
import type { NavControls } from './nav-history';

/**
 * 前进/后退钮对(应用级导航历史,浏览器形):会话顶栏最左与欢迎页浮出簇两处共用。
 * 禁用走全局 button:disabled 灰显;悬浮提示走 data-tip(§13.1 G14.66,图标钮必须提示)。
 */
export function NavButtons({ nav }: { nav: NavControls }): JSX.Element {
  return (
    <div className="sx-navbtns" role="group" aria-label="navigation history">
      <button type="button" className="sx-winbtn" aria-label="nav back" data-tip={t('Back', '后退')} disabled={!nav.canBack} onClick={nav.back}>
        <ArrowLeft size={15} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button type="button" className="sx-winbtn" aria-label="nav forward" data-tip={t('Forward', '前进')} disabled={!nav.canForward} onClick={nav.forward}>
        <ArrowRight size={15} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}
