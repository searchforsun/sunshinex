import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Lock, RotateCw } from 'lucide-react';
import type { TabParams } from './tab-state';
import { t } from '../i18n';

/**
 * G8d Web 标签体(T4)——G14.6 对齐 VSCode Simple Browser(用户裁定:用 vscode 原生浏览器组件
 * 形态):工具行 = ‹ 前进/后退 › + ↻ 刷新 + 锁图标 URL 框(VSCode zh 占位「输入网址后回车」)
 * + ↗ 外开;空态 = 居中地球 + 「浏览器 / 粘贴或输入 URL 以打开网页。」(VSCode zh 同文案)。
 * 历史栈导航(back/forward 走 urls[index]),iframe 语义保持:key=url#nonce 强制重挂(刷新/
 * 导航均重载)、sandbox 四值、title=active。外开 window.open(_blank+noopener)。
 */

export interface WebTabProps {
  /** 开档参数:url 可选(带 url 开档即直开;「+」菜单裸开 = 空态引导面) */
  readonly params: TabParams;
}

/** url 规范化:去首尾空白;无 :// 前缀(无 scheme)补 https:// */
export function normalizeWebUrl(raw: string): string {
  const t = raw.trim();
  return t.includes('://') ? t : `https://${t}`;
}

/** 历史栈导航状态:urls + 当前位次(back/forward 移位,导航截尾追加) */
interface WebHistory {
  urls: string[];
  index: number;
}

export function WebTab({ params }: WebTabProps): JSX.Element {
  const [nav, setNav] = useState<WebHistory>(() => {
    const raw = (params.url ?? '').trim();
    return raw === '' ? { urls: [], index: -1 } : { urls: [normalizeWebUrl(raw)], index: 0 };
  });
  const [input, setInput] = useState(params.url ?? '');
  /** 刷新 bump:入 iframe key —— 变更即强制重挂(= 重新加载) */
  const [nonce, setNonce] = useState(0);

  const active = nav.index >= 0 ? (nav.urls[nav.index] ?? null) : null;

  // 历史位移(back/forward)时输入框随 active 同步(VSCode 同形)
  useEffect(() => {
    if (active !== null) setInput(active);
  }, [active]);

  const navigate = (): void => {
    if (input.trim() === '') return;
    const url = normalizeWebUrl(input);
    setNav((n) => {
      const urls = [...n.urls.slice(0, n.index + 1), url];
      return { urls, index: urls.length - 1 };
    });
    setNonce((v) => v + 1); // 同址重输也重载
    setInput(url);
  };

  const back = (): void => setNav((n) => (n.index > 0 ? { ...n, index: n.index - 1 } : n));
  const forward = (): void => setNav((n) => (n.index < n.urls.length - 1 ? { ...n, index: n.index + 1 } : n));
  const reload = (): void => setNonce((v) => v + 1);
  const openExternal = (): void => {
    if (active !== null) window.open(active, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="sx-web-tab" aria-label="web tab">
      <div className="sx-web-bar">
        <button
          type="button"
          className="sx-web-nav"
          aria-label="后退"
          title={t('Back', '后退')}
          disabled={nav.index <= 0}
          onClick={back}
        >
          <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="sx-web-nav"
          aria-label="前进"
          title={t('Forward', '前进')}
          disabled={nav.index >= nav.urls.length - 1}
          onClick={forward}
        >
          <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="sx-web-nav"
          aria-label="刷新"
          title={t('Reload', '刷新')}
          disabled={active === null}
          onClick={reload}
        >
          <RotateCw size={13} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <div className="sx-web-url-box">
          <Lock size={11} strokeWidth={1.75} aria-hidden="true" />
          <input
            className="sx-web-url"
            aria-label="web url input"
            value={input}
            placeholder={t('Type a URL and press Enter', '输入网址后回车')}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') navigate();
            }}
          />
        </div>
        <button
          type="button"
          className="sx-web-nav"
          aria-label="外开"
          title={t('Open in system browser', '在系统浏览器打开')}
          disabled={active === null}
          onClick={openExternal}
        >
          <ExternalLink size={13} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {active === null ? (
        <div className="sx-web-empty">
          <Globe size={56} strokeWidth={1} aria-hidden="true" />
          <p className="sx-web-empty-title">{t('Browser', '浏览器')}</p>
          <p className="sx-web-empty-hint">{t('Paste or type a URL to open a page.', '粘贴或输入 URL 以打开网页。')}</p>
        </div>
      ) : (
        <iframe
          key={`${active}#${nonce}`}
          className="sx-web-frame"
          title={active}
          src={active}
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
        />
      )}
    </div>
  );
}
