import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, ExternalLink, Globe, Lock, MonitorSmartphone, RotateCw } from 'lucide-react';
import type { TabParams } from './tab-state';
import { t } from '../i18n';
import { openExternalUrl } from '../ui-util';

/**
 * G8d Web 标签体(T4)——G14.6 对齐 VSCode Simple Browser(用户裁定:用 vscode 原生浏览器组件
 * 形态):工具行 = ‹ 前进/后退 › + ↻ 刷新 + 锁图标 URL 框(VSCode zh 占位「输入网址后回车」)
 * + ↗ 外开;空态 = 居中地球 + 「浏览器 / 粘贴或输入 URL 以打开网页。」(VSCode zh 同文案)。
 * 历史栈导航(back/forward 走 urls[index]),iframe 语义保持:key=url#nonce 强制重挂(刷新/
 * 导航均重载)、sandbox 四值、title=active。外开 window.open(_blank+noopener)。
 * G14.2xx 浏览器原生标签形:页内导航/取到页名经 onMeta 回写标签 params(url/pageTitle)——
 * 标签条标题与判重键随页演进(多 Web 标签并存,每标签显网页名);G14.158 宽度比/适应窗口
 * 控件退役(与缩放 −/%/+ 重复,后者即浏览器原生缩放)。
 * G14.2xx 自由尺寸(设备模拟形,用户裁定):工具行 ⇄ 钮开/关——开=iframe 按「宽 × 高」px 定渲染
 * 视口,缩放下拉(适应窗口=等比缩到面板内/50%~200%)整体缩放(浏览器设备模拟同构);
 * 关=流式宽 + 缩放 −/%/+。
 */

export interface WebTabProps {
  /** daemon 连接(2026-10-25 页名/站标服务端代取——iframe 跨域拒访,fetchWebMeta 尽力而为) */
  readonly conn: import('../connection').Connection;
  /** 开档参数:url 可选(带 url 开档即直开;「+」菜单裸开 = 空态引导面) */
  readonly params: TabParams;
  /** 标签实例 uid(回写寻址) */
  readonly uid: string;
  /** 元数据回写(url/pageTitle/pageIcon 合并进标签 params;registry 绑定 sessionId,App 落 tab-state) */
  readonly onMeta: (uid: string, patch: { url?: string; pageTitle?: string; pageIcon?: string }) => void;
}

/** url 规范化:去首尾空白;无 :// 前缀(无 scheme)补 https:// */
export function normalizeWebUrl(raw: string): string {
  const t = raw.trim();
  return t.includes('://') ? t : `https://${t}`;
}

/** 页名推导:url → host(剥 www.;解析失败退原文)——标签条标题兜底/导航回写共用 */
export function webPageName(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

/** 自由尺寸缩放档(适应窗口外固定倍率;浏览器设备模拟同款档位) */
const DEVICE_SCALES = [50, 75, 100, 125, 150, 200] as const;

/** 历史栈导航状态:urls + 当前位次(back/forward 移位,导航截尾追加) */
interface WebHistory {
  urls: string[];
  index: number;
}

export function WebTab({ conn, params, uid, onMeta }: WebTabProps): JSX.Element {
  const [nav, setNav] = useState<WebHistory>(() => {
    const raw = (params.url ?? '').trim();
    return raw === '' ? { urls: [], index: -1 } : { urls: [normalizeWebUrl(raw)], index: 0 };
  });
  const [input, setInput] = useState(params.url ?? '');
  /** 刷新 bump:入 iframe key —— 变更即强制重挂(= 重新加载) */
  const [nonce, setNonce] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  /** G14.2xx 自由尺寸(设备模拟):开关/宽高 px(缺省=面板现尺寸)/适应窗口|固定倍率 */
  const [deviceMode, setDeviceMode] = useState(false);
  const [devW, setDevW] = useState<number | null>(null);
  const [devH, setDevH] = useState<number | null>(null);
  const [devFit, setDevFit] = useState(true);
  const [devZoom, setDevZoom] = useState(1);
  /** 缩放档弹层开合(项目弹层形,原生 select 退役) */
  const [scaleOpen, setScaleOpen] = useState(false);
  /** 宽高编辑草稿(提交于 blur/Enter——受控钳制会打断键入) */
  const [wDraft, setWDraft] = useState<string | null>(null);
  const [hDraft, setHDraft] = useState<string | null>(null);
  /** 面板内容区实时尺寸(适应窗口比例/自由尺寸缺省值的输入;RO 随拖栏/折叠即时跟) */
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [wrapSize, setWrapSize] = useState({ w: 0, h: 0 });

  const active = nav.index >= 0 ? (nav.urls[nav.index] ?? null) : null;
  /** meta 回写竞态守卫(async 应答 vs 已导航):恒指最新 active(渲染期直写,MessageList propsRef 手法) */
  const activeRef = useRef<string | null>(active);
  activeRef.current = active;

  // 历史位移(back/forward)时输入框随 active 同步(VSCode 同形)
  useEffect(() => {
    if (active !== null) setInput(active);
  }, [active]);

  // 面板尺寸观测:wrap 仅 active 在场时挂载,挂/卸随导航重接
  useEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r !== undefined) setWrapSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [active === null]);

  // 视口 px 缺省=16:9 标准档 1280×720(开启时定格,此后只随手动输入变——不随侧栏宽度漂移);
  // 侧栏拖宽只影响呈现:适应窗口态经 RO 重算倍率刚好占满,固定倍率态超出走滚动
  const deviceW = devW ?? 1280;
  const deviceH = devH ?? 720;
  const fitScale =
    deviceW > 0 && deviceH > 0 && wrapSize.w > 0 ? Math.min(wrapSize.w / deviceW, wrapSize.h / deviceH) : 1;
  const deviceScale = devFit ? fitScale : devZoom;

  // 缩放档弹层点外即收(面板内点按任意处;菜单行在 anchor 内不触发)
  useEffect(() => {
    if (!scaleOpen) return;
    const close = (e: PointerEvent): void => {
      if (e.target instanceof Element && !e.target.closest('.sx-web-dev-anchor')) setScaleOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [scaleOpen]);

  const navigate = (): void => {
    if (input.trim() === '') return;
    const url = normalizeWebUrl(input);
    setNav((n) => {
      const urls = [...n.urls.slice(0, n.index + 1), url];
      return { urls, index: urls.length - 1 };
    });
    setNonce((v) => v + 1); // 同址重输也重载
    setInput(url);
    onMeta(uid, { url, pageTitle: webPageName(url) }); // 标签条标题/判重键随导航演进(页名 onLoad 再精化)
  };

  const back = (): void => setNav((n) => (n.index > 0 ? { ...n, index: n.index - 1 } : n));
  const forward = (): void => setNav((n) => (n.index < n.urls.length - 1 ? { ...n, index: n.index + 1 } : n));
  const reload = (): void => setNonce((v) => v + 1);
  // 2026-10-25 用户报障:window.open 在 Electron 里只开自家子窗,不是系统默认浏览器——
  // openExternalUrl 单点(桌面壳走 preload 桥 shell.openExternal,OS 默认浏览器承接;浏览器态回落 window.open)
  const openExternal = (): void => {
    if (active !== null) openExternalUrl(active);
  };

  /** 页名/站标精化(2026-10-25 用户报障「页签只显 host+地球,应显网页标题+站标」):跨域帧
   *  contentDocument 拒访(syncPageTitle 恒空),改 daemon /web/meta 服务端代取——title+favicon
   *  尽力而为,失败退 host/地球。竞态守卫:回写前校验 active 仍为发起时的 url(导航/重载作废) */
  const syncPageMeta = (url: string): void => {
    conn
      .fetchWebMeta(url)
      .then((meta) => {
        if (activeRef.current !== url) return; // 已导航/刷新:过期应答弃
        onMeta(uid, {
          ...(meta.title !== '' ? { pageTitle: meta.title } : {}),
          ...(meta.icon !== '' ? { pageIcon: meta.icon } : {}),
        });
      })
      .catch(() => undefined);
  };

  /** 页名精化:load 后取 document.title(跨域帧不可读,SecurityError 静默)——空/失败退 host;
   *  2026-10-25 起站标/页名以服务端代取为主(上方 syncPageMeta),本函数保留同源帧的即时页名 */
  const syncPageTitle = (): void => {
    if (active === null) return;
    const url = active;
    syncPageMeta(url);
    let title = '';
    try {
      title = frameRef.current?.contentDocument?.title?.trim() ?? '';
    } catch {
      title = ''; // 跨域:contentDocument 拒访
    }
    if (title !== '') onMeta(uid, { pageTitle: title });
  };

  /** 宽高草稿提交:非法/过小丢弃;≥16 取整生效 */
  const commitDim = (draft: string | null, apply: (n: number) => void): void => {
    if (draft === null) return;
    const n = Number(draft);
    if (Number.isFinite(n) && n >= 16) apply(Math.round(n));
  };

  return (
    <div className="sx-web-tab" aria-label="web tab">
      <div className="sx-web-bar">
        <button
          type="button"
          className="sx-web-nav"
          aria-label={t('Back', '后退')}
          data-tip={t('Back', '后退')}
          disabled={nav.index <= 0}
          onClick={back}
        >
          <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="sx-web-nav"
          aria-label={t('Forward', '前进')}
          data-tip={t('Forward', '前进')}
          disabled={nav.index >= nav.urls.length - 1}
          onClick={forward}
        >
          <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="sx-web-nav"
          aria-label={t('Reload', '刷新')}
          data-tip={t('Reload', '刷新')}
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
          aria-label={t('Open in system browser', '在系统浏览器打开')}
          data-tip={t('Open in system browser', '在系统浏览器打开')}
          disabled={active === null}
          onClick={openExternal}
        >
          <ExternalLink size={13} strokeWidth={1.75} aria-hidden="true" />
        </button>
        {deviceMode &&
          /* G14.2xx 自由尺寸:宽 × 高 px + 缩放下拉(适应窗口/固定倍率)——设备模拟同构。
             非自由尺寸=纯浏览器形态,无缩放面(G14.2xx:−/%/+ 退役) */
          (
            <>
              <input
                className="sx-web-dev-input"
                aria-label={t('Viewport width (px)', '视口宽(px)')}
                value={wDraft ?? String(deviceW)}
                onChange={(e) => setWDraft(e.target.value)}
                onBlur={() => {
                  commitDim(wDraft, setDevW);
                  setWDraft(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    commitDim(wDraft, setDevW);
                    setWDraft(null);
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
              <span className="sx-web-dev-x">×</span>
              <input
                className="sx-web-dev-input"
                aria-label={t('Viewport height (px)', '视口高(px)')}
                value={hDraft ?? String(deviceH)}
                onChange={(e) => setHDraft(e.target.value)}
                onBlur={() => {
                  commitDim(hDraft, setDevH);
                  setHDraft(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    commitDim(hDraft, setDevH);
                    setHDraft(null);
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
              <div className="sx-web-dev-anchor">
              <button
                type="button"
                className="sx-web-dev-btn"
                aria-label={t('Scale', '缩放')}
                aria-expanded={scaleOpen}
                onClick={() => setScaleOpen((v) => !v)}
              >
                {devFit ? t('Fit window', '适应窗口') : `${Math.round(devZoom * 100)}%`}
                <ChevronDown size={11} strokeWidth={1.75} aria-hidden="true" />
              </button>
              {scaleOpen && (
                <div className="sx-web-dev-menu" role="menu" aria-label={t('Scale', '缩放')}>
                  <button
                    type="button"
                    role="menuitem"
                    className={devFit ? 'active' : undefined}
                    onClick={() => {
                      setDevFit(true);
                      setScaleOpen(false);
                    }}
                  >
                    {t('Fit window', '适应窗口')}
                  </button>
                  {DEVICE_SCALES.map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      role="menuitem"
                      className={!devFit && Math.abs(devZoom - pct / 100) < 1e-6 ? 'active' : undefined}
                      onClick={() => {
                        setDevFit(false);
                        setDevZoom(pct / 100);
                        setScaleOpen(false);
                      }}
                    >
                      {pct}%
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
        {/* G14.2xx 自由尺寸开关(设备模拟形):开=缺省 16:9 标准档 1280×720 定格为视口 px(此后
            只随输入变,不随侧栏漂移)+缩放下拉;关=流式+缩放钮 */}
        <button
          type="button"
          className={`sx-web-nav${deviceMode ? ' active' : ''}`}
          aria-label={t('Custom size', '自由尺寸')}
          data-tip={t('Custom viewport size', '自由尺寸(定宽高渲染)')}
          onClick={() => {
            if (!deviceMode) {
              if (devW === null) setDevW(1280);
              if (devH === null) setDevH(720);
            }
            setDeviceMode(!deviceMode);
          }}
        >
          <MonitorSmartphone size={13} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {/* 缩放结构恒在场(未开页同样显示目标区域——自由尺寸空态=视口框内引导面) */}
      <div className={`sx-web-frame-wrap${deviceMode ? ' device' : ''}`} ref={wrapRef}>
        <div
          className={`sx-web-scaler${deviceMode ? ' device' : ''}`}
          style={
            deviceMode
              ? { width: Math.round(deviceW * deviceScale), height: Math.round(deviceH * deviceScale) }
              : { width: '100%', height: '100%' }
          }
        >
          <div
            style={{
              width: deviceMode ? deviceW : '100%',
              height: deviceMode ? deviceH : '100%',
              transform: deviceMode ? `scale(${deviceScale})` : undefined,
              transformOrigin: 'top left',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--surface)',
            }}
          >
            {active === null ? (
              <div className="sx-web-empty">
                <Globe size={56} strokeWidth={1} aria-hidden="true" />
                <p className="sx-web-empty-title">{t('Browser', '浏览器')}</p>
                <p className="sx-web-empty-hint">{t('Paste or type a URL to open a page.', '粘贴或输入 URL 以打开网页。')}</p>
              </div>
            ) : (
              <iframe
                key={`${active}#${nonce}`}
                ref={frameRef}
                className="sx-web-frame"
                title={active}
                src={active}
                sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
                onLoad={syncPageTitle}
                style={{ width: '100%', height: '100%', border: 'none', background: 'var(--surface-code)' }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
