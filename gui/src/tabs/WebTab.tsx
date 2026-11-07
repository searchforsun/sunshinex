import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bug, ChevronDown, ExternalLink, Globe, Lock, MonitorSmartphone, MoreHorizontal, MousePointerClick, RotateCw } from 'lucide-react';
import type { TabParams } from './tab-state';
import { t } from '../i18n';
import { zoomScale } from '../ui-zoom';
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

/** 元素拾取脚本(2026-11-04 元素选取面):注入页内——悬停高亮/点击捕获/Escape 取消;
 *  回传 {url,title,path,html}(html 截 2000 字防大 DOM 灌会话);capture 阶段拦截页面自身点击 */
const PICK_ELEMENT_JS = String.raw`
(() => new Promise((resolve) => {
  const mark = '__sx_pick';
  document.getElementById(mark)?.remove();
  const style = document.createElement('style');
  style.id = mark;
  style.textContent = '.__sx_pick_hover{outline:2px solid #22d3ee !important;outline-offset:1px !important;cursor:crosshair !important}';
  document.head.appendChild(style);
  let last = null;
  const cleanup = () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    if (last) last.classList.remove('__sx_pick_hover');
    style.remove();
  };
  const onMove = (e) => {
    e.stopPropagation();
    if (last && last !== e.target) last.classList.remove('__sx_pick_hover');
    last = e.target;
    last.classList.add('__sx_pick_hover');
  };
  const describe = (el) => {
    let path = el.tagName.toLowerCase();
    if (el.id) path += '#' + el.id;
    else if (el.className && typeof el.className === 'string') path += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    return { url: location.href, title: document.title, path, html: (el.outerHTML || '').slice(0, 2000) };
  };
  const onClick = (e) => {
    e.preventDefault(); e.stopPropagation();
    cleanup();
    resolve(describe(e.target));
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); cleanup(); resolve(null); }
  };
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
}))`;

export interface WebTabProps {
  /** daemon 连接(2026-10-25 页名/站标服务端代取——iframe 跨域拒访,fetchWebMeta 尽力而为) */
  readonly conn: import('../connection').Connection;
  /** 开档参数:url 可选(带 url 开档即直开;「+」菜单裸开 = 空态引导面) */
  readonly params: TabParams;
  /** 标签实例 uid(回写寻址) */
  readonly uid: string;
  /** 元数据回写(url/pageTitle/pageIcon 合并进标签 params;registry 绑定 sessionId,App 落 tab-state) */
  readonly onMeta: (uid: string, patch: { url?: string; pageTitle?: string; pageIcon?: string }) => void;
  /** 关闭本页签(模型 browser_tabs close 经 facade→壳→此处) */
  readonly onClose?: () => void;
  /** webview 分区(浏览器页签池按会话下发:persist:sx-<浏览器键>/草稿内存分区);缺省共用旧分区 */
  readonly partition?: string;
  /** 切到本页签(agent 正在驱动本页) */
  readonly onActivate?: () => void;
  /** 工作区根(2026-11-01 CDP 形态:内置浏览器端点发现按数据目录解析;缺省=纯 iframe 形态) */
  readonly root?: string;
}

// normalizeWebUrl/webPageName 拆至 tab-meta.ts(2026-10-26 二期分包:registry 同步层消费纯函数,
// WebTab 体 lazy 化)——此处再导出保既有消费面零迁移
export { normalizeWebUrl, webPageName } from './tab-meta';
import { normalizeWebUrl, webPageName } from './tab-meta';

/** Electron webview 标签方法面(M1 内置浏览器融合:真实嵌入页面——点击/输入/滚轮原生,截屏
 *  映射画布退役;壳侧 webviewTag:true + will-attach-webview 安全纪律) */
interface WvElement extends HTMLElement {
  loadURL(url: string): void;
  /** 页内执行(2026-11-04 元素选取模式:注入拾取脚本,Promise 回传选中元素数据/Escape=null) */
  executeJavaScript?(code: string, userGesture?: boolean): Promise<unknown>;
  goBack(): void;
  goForward(): void;
  reload(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  setZoomFactor(factor: number): void;
  getWebContentsId(): number;
}

/** 自由尺寸缩放档(适应窗口外固定倍率;浏览器设备模拟同款档位) */
const DEVICE_SCALES = [50, 75, 100, 125, 150, 200] as const;

/** 历史栈导航状态:urls + 当前位次(back/forward 移位,导航截尾追加) */
interface WebHistory {
  urls: string[];
  index: number;
}

/** 常驻池在应用根,App 每次渲染都会带着新闭包回调重渲全部 web 页签——回调一律经 ref 读最新值,
 *  比较时只看数据 props,数据未变即跳过整棵子树 */
function sameWebTabData(a: WebTabProps, b: WebTabProps): boolean {
  return a.conn === b.conn && a.params === b.params && a.uid === b.uid && a.root === b.root && a.partition === b.partition;
}

export const WebTab = memo(WebTabImpl, sameWebTabData);

function WebTabImpl({ conn, params, uid, onMeta, root, onClose, onActivate, partition }: WebTabProps): JSX.Element {
  // 内置浏览器融合(M1,2026-11-01 用户裁定「自由使用浏览器,插件打开的也是普通页签」):
  // root 在场(会话绑定档)=Electron webview **真实嵌入页面**——点击/输入/滚轮原生,截屏映射
  // 画布退役;root 缺省(欢迎页裸开)=纯 iframe 形态不变。自动化(M2)经壳内 CDP facade 附加
  // 同一 webview,模型打开的页签=用户眼前的页签
  const builtin = root !== undefined;
  const wvRef = useRef<WvElement | null>(null);
  /** 模型关页:主进程下发 guest webContents id,是本页签的 webview 即关闭自身 */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;
  useEffect(() => {
    const bridge = (window as unknown as { sunshinexWindow?: { onActivateWebContents?: (cb: (id: number) => void) => () => void } }).sunshinexWindow?.onActivateWebContents;
    if (!builtin || bridge === undefined) return;
    return bridge((id) => {
      try {
        if (wvRef.current?.getWebContentsId() === id) onActivateRef.current?.();
      } catch { /* 未 attach */ }
    });
  }, [builtin]);
  useEffect(() => {
    const bridge = window.sunshinexWindow?.onCloseWebContents;
    if (!builtin || bridge === undefined) return;
    return bridge((id) => {
      try {
        if (wvRef.current?.getWebContentsId() === id) onCloseRef.current?.();
      } catch { /* webview 未 attach:getWebContentsId 抛错,非本页签 */ }
    });
  }, [builtin]);
  /** 模型文本输入:guest 只在宿主 webview 元素有焦点时收文本——begin 记下原焦点并聚焦 webview,
   *  end 若焦点仍在 webview 则归还(用户在输入框打字不被长时间抢走) */
  useEffect(() => {
    const bridge = (window as unknown as { sunshinexWindow?: { onFocusWebContents?: (cb: (id: number, phase: 'begin' | 'end') => void) => () => void } }).sunshinexWindow?.onFocusWebContents;
    if (!builtin || bridge === undefined) return;
    let prev: Element | null = null;
    return bridge((id, phase) => {
      const wv = wvRef.current;
      try {
        if (wv === null || wv.getWebContentsId() !== id) return;
      } catch {
        return;
      }
      if (phase === 'begin') {
        if (document.activeElement !== wv) prev = document.activeElement;
        wv.focus();
      } else {
        if (prev instanceof HTMLElement && document.activeElement === wv) prev.focus();
        prev = null;
      }
    });
  }, [builtin]);
  /** 首个导航目标(null=未开页,空态引导面);后续导航经 loadURL 驱动,不改 src(防重挂) */
  const [wvTarget, setWvTarget] = useState<string | null>(
    builtin ? (params.url === 'about:blank' ? 'about:blank' : params.url !== undefined && params.url !== '' ? normalizeWebUrl(params.url) : null) : null,
  );
  /** webview 实时态:当前 URL/后退前进可用性/缩放(did-navigate 族事件随动) */
  const [wvUrl, setWvUrl] = useState('');
  const [wvCanBack, setWvCanBack] = useState(false);
  const [wvCanFwd, setWvCanFwd] = useState(false);
  const [nav, setNav] = useState<WebHistory>(() => {
    const raw = (params.url ?? '').trim();
    return raw === '' ? { urls: [], index: -1 } : { urls: [normalizeWebUrl(raw)], index: 0 };
  });
  const [input, setInput] = useState(params.url === 'about:blank' ? '' : (params.url ?? ''));
  /** 刷新 bump:入 iframe key —— 变更即强制重挂(= 重新加载) */
  const [nonce, setNonce] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  /** G14.2xx 自由尺寸(设备模拟):开关/宽高 px(缺省=面板现尺寸)/适应窗口|固定倍率。
   *  2026-11-01 用户裁定 CDP 镜像档**缺省开**(镜像即固定视口语义,尺寸面直接可见可填) */
  const [deviceMode, setDeviceMode] = useState(true);
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
  const scalerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);

  const active = nav.index >= 0 ? (nav.urls[nav.index] ?? null) : null;
  /** meta 回写竞态守卫(async 应答 vs 已导航):恒指最新 active(渲染期直写,MessageList propsRef 手法) */
  const activeRef = useRef<string | null>(active);
  activeRef.current = active;

  // 视口 px 缺省=16:9 标准档 1280×720(开启时定格,此后只随手动输入变——不随侧栏宽度漂移);
  // 侧栏拖宽只影响呈现:适应窗口态重算倍率刚好占满,固定倍率态超出走滚动
  const deviceW = devW ?? 1280;
  const deviceH = devH ?? 720;
  /** scale 计算入参镜像(propsRef 手法,activeRef 同款):RO 回调读 ref 免闭包陈旧 */
  const scaleInputsRef = useRef({ deviceMode, deviceW, deviceH, devFit, devZoom });
  scaleInputsRef.current = { deviceMode, deviceW, deviceH, devFit, devZoom };
  /** 视口缩放直写(2026-11-04 用户实测「从最小宽度放大延迟/宽间隙」根修):原链 RO→setWrapSize→
   *  React 提交——React 18 非事件上下文更新走 Scheduler 宏任务,提交可落 paint 后,连续拖宽下
   *  scaler 每帧慢一拍=盒子滞后边界(宽侧栏时 scaler 高度约束尺寸不随宽变,故「顺滑」无感;
   *  从最小宽度放大时盒子逐帧膨胀,滞后即宽间隙)。现 RO 回调(paint 前阶段)与测量同帧直写 DOM。
   *  zoom 契约:gBCR 视觉 px /zoomScale 落本地,再减 wrap 8px×2 padding(=contentRect 口径) */
  const applyScale = (): void => {
    const wrap = wrapRef.current;
    const scaler = scalerRef.current;
    const inner = innerRef.current;
    if (wrap === null || scaler === null || inner === null) return;
    const inp = scaleInputsRef.current;
    if (!inp.deviceMode) {
      inner.style.transform = '';
      return;
    }
    const z = zoomScale();
    const b = wrap.getBoundingClientRect();
    const w = b.width / z - 16;
    const h = b.height / z - 16;
    if (!(w > 0) || !(h > 0)) return; // 隐藏态(切签 display:none)保上次值
    const fit = Math.min(w / inp.deviceW, h / inp.deviceH);
    const scale = inp.devFit ? fit : inp.devZoom;
    scaler.style.width = `${Math.round(inp.deviceW * scale)}px`;
    scaler.style.height = `${Math.round(inp.deviceH * scale)}px`;
    inner.style.transform = `scale(${scale})`;
  };
  // 尺寸入参/档位变化即重算(RO 只管容器尺寸);mount 同步一帧(paint 前生效)
  useLayoutEffect(applyScale, [deviceMode, deviceW, deviceH, devFit, devZoom]);

  // 历史位移(back/forward)时输入框随 active 同步(VSCode 同形)
  useEffect(() => {
    if (active !== null) setInput(active);
  }, [active]);

  // 面板尺寸观测:wrap 仅 active 在场时挂载,挂/卸随导航重接
  useEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    const ro = new ResizeObserver(() => applyScale());
    ro.observe(el);
    return () => ro.disconnect();
  }, [active === null]);

  /** webview 事件挂接(M1/M2):**ref 回调**形态——元素挂载瞬间即挂事件并补读当前 URL
   *  (effect 形态会在 webview src 自动加载后才挂,did-navigate/页名首拍必丢,实测
   *  「只有第一个页签有名字,其余页签无名」即此);did-navigate 族 → URL/后退前进态/
   *  地址栏回显/标签页名回写;page-title-updated → 真页名 */
  const uidRef = useRef(uid);
  uidRef.current = uid;
  const onMetaRef = useRef(onMeta);
  onMetaRef.current = onMeta;
  const connRef = useRef(conn);
  connRef.current = conn;
  /** 已挂事件的拆除面(元素卸载/换挂时执行) */
  const detachWvRef = useRef<(() => void) | null>(null);
  // 身份恒定(useCallback 零依赖,入参经 ref 读):回调 ref 每渲染换新=React 每次提交先 null 后元素
  // 重调一遍——getURL/canGoBack/canGoForward/getTitle 皆 Electron 同步 IPC(实测单次至 ~30ms,常驻池
  // 多 webview 叠加每渲染上百 ms),且事件监听只增不拆无限累积
  const attachWv = useCallback((el: HTMLElement | null): void => {
    detachWvRef.current?.();
    detachWvRef.current = null;
    wvRef.current = el as WvElement | null;
    if (el === null) return;
    const wv = el as WvElement & {
      addEventListener(type: string, fn: (ev: Event & { title?: string; favicons?: string[] }) => void): void;
      removeEventListener(type: string, fn: (ev: Event & { title?: string; favicons?: string[] }) => void): void;
      getTitle?: () => string;
    };
    // 页名/站标以 webview 自身事件为准:dom-ready 晚于 page-title-updated,回写时取 getTitle()
    // 而非 host,否则真页名被 host 覆盖(实测页签只剩「baidu.com」)
    // 站标兜底:page-favicon-updated 可能早于挂接/恢复页签时不再触发——换站点时经 daemon
    // /web/meta 代取一次;事件到达即以事件为准(faviconSeen),代取应答不覆盖
    let navHost = '';
    let faviconSeen = false;
    const onNav = (): void => {
      const u = wv.getURL();
      setWvUrl(u);
      setWvCanBack(wv.canGoBack());
      setWvCanFwd(wv.canGoForward());
      if (u !== '' && u !== 'about:blank') {
        setInput(u);
        const t = typeof wv.getTitle === 'function' ? wv.getTitle().trim() : '';
        onMetaRef.current(uidRef.current, { url: u, pageTitle: t !== '' && t !== u ? t : webPageName(u) });
        const host = webPageName(u);
        if (host !== navHost) {
          navHost = host;
          faviconSeen = false;
          connRef.current
            .fetchWebMeta(u)
            .then((meta) => {
              if (!faviconSeen && navHost === host && meta.icon !== '') onMetaRef.current(uidRef.current, { pageIcon: meta.icon });
            })
            .catch(() => undefined);
        }
      }
    };
    const onTitle = (ev: Event & { title?: string }): void => {
      const title = ev.title;
      if (typeof title === 'string' && title !== '') onMetaRef.current(uidRef.current, { pageTitle: title });
    };
    const onFavicon = (ev: Event & { favicons?: string[] }): void => {
      const icon = ev.favicons?.[0];
      if (typeof icon === 'string' && icon !== '') {
        faviconSeen = true;
        onMetaRef.current(uidRef.current, { pageIcon: icon });
      }
    };
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-navigate-in-page', onNav);
    wv.addEventListener('dom-ready', onNav);
    wv.addEventListener('page-title-updated', onTitle);
    wv.addEventListener('page-favicon-updated', onFavicon);
    detachWvRef.current = () => {
      wv.removeEventListener('did-navigate', onNav);
      wv.removeEventListener('did-navigate-in-page', onNav);
      wv.removeEventListener('dom-ready', onNav);
      wv.removeEventListener('page-title-updated', onTitle);
      wv.removeEventListener('page-favicon-updated', onFavicon);
    };
    try {
      if (typeof wv.getURL === 'function') onNav(); // 挂上即补读(事件早于挂接的首拍在此补偿);jsdom 无方法跳过
    } catch { /* 尽力 */ }
  }, []);

  // 缩放档弹层点外即收(面板内点按任意处;菜单行在 anchor 内不触发)
  useEffect(() => {
    if (!scaleOpen) return;
    const close = (e: PointerEvent): void => {
      if (e.target instanceof Element && !e.target.closest('.sx-web-dev-anchor')) setScaleOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [scaleOpen]);

  /** ⋯ 更多操作菜单(2026-10-31):开关态+点外即收(同缩放档收口,锚共类);调试项=桌面壳
   *  openDevtools 桥在场才渲染(旧壳/浏览器态自动隐) */
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (e: PointerEvent): void => {
      if (e.target instanceof Element && !e.target.closest('.sx-web-dev-anchor')) setMoreOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [moreOpen]);
  const devtoolsBridge = window.sunshinexWindow?.openDevtools;
  /* 元素选取模式(2026-11-04 用户裁定「选中元素发到会话,补页签 id/网址等元数据」):
     注入拾取脚本→悬停高亮→点击捕获(定位路径+outerHTML 片段)+页元数据,Escape 取消;
     DevTools 开着也能用(不走其选中态,通道独立)。两入口:发主对话(事件通道)/发辅助会话 */
  /* 2026-11-04 CDP Overlay inspect 改宗+交互简化(用户裁定):工具条独立钮(自由尺寸前,检视中
     active 态)→原生高亮+showInfo 信息条→点击直投主对话;点网页外/Esc 自动退出 */
  const [pickState, setPickState] = useState<'idle' | 'picking' | 'failed'>('idle');
  /** 桥面拾取在途态(订阅回调寻址;refs 免闭包陈旧) */
  const pickWcRef = useRef(0);
  const pickViaBridgeRef = useRef(false);
  /** 拾取结果直投主对话(2026-11-04 用户裁定「点击后自动放到主对话框,不用再次点击」:选择卡
   *  两段式退役)——⟦token⟧ 简标识落 composer(内容入账本发送期展开) */
  const insertPicked = (el: { wcId: number; url: string; title: string; path: string; html: string }): void => {
    const content = [
      '```browser-element',
      `页签 #${el.wcId}`,
      `标题: ${el.title}`,
      `网址: ${el.url}`,
      `定位: ${el.path}`,
      '---',
      el.html,
      '```',
    ].join('\n');
    const token = `⟦   网页#${el.wcId.toString(36)} · ${el.path}⟧`;
    window.dispatchEvent(new CustomEvent('sunshinex:insert-ref', { detail: { kind: 'ref', token, content } }));
  };
  const exitPick = (): void => {
    pickViaBridgeRef.current = false;
    void window.sunshinexWindow?.pickElementStop?.(pickWcRef.current);
    setPickState('idle');
  };
  /** 桥面拾取结果订阅:节点点击=直投主对话收口;null=Esc 取消。mount 级订阅一次,wcId 寻址判非本页忽略 */
  useEffect(() => {
    const sub = window.sunshinexWindow?.onPickNode;
    if (sub === undefined) return;
    return sub((wcId, info) => {
      if (pickViaBridgeRef.current !== true || pickWcRef.current !== wcId) return;
      exitPick();
      if (info !== null && info.html !== '') insertPicked({ wcId, url: info.url, title: info.title, path: info.path, html: info.html });
    });
  }, []);
  // 点击非网页区=自动退出(2026-11-04 用户裁定):host DOM 事件不经 webview,网页内点击被
  // inspect 模式拦截不冒泡到宿主——picking 期宿主任一 pointerdown 即页外,捕获段先于 UI 处理
  useEffect(() => {
    if (pickState !== 'picking' || pickViaBridgeRef.current !== true) return;
    const onDown = (): void => exitPick();
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [pickState]);
  // 卸载兜底:拾取在途即退(检视态悬着+debugger 挂着都不可残留)
  useEffect(
    () => () => {
      if (pickViaBridgeRef.current) void window.sunshinexWindow?.pickElementStop?.(pickWcRef.current);
    },
    [],
  );
  const pickElement = async (): Promise<void> => {
    const wv = wvRef.current;
    if (wv === null) return;
    if (pickState === 'picking') {
      // 检视中再点=取消(2026-11-04 用户裁定:按钮开合态随检视,选中/点外/Esc/再点均收)
      exitPick();
      return;
    }
    const failHint = (): void => {
      // 2026-11-04 用户裁定:失败提示=通知框形态,3s 自愈回落,不常驻
      setPickState('failed');
      window.setTimeout(() => setPickState((c) => (c === 'failed' ? 'idle' : c)), 3000);
    };
    const bridge = window.sunshinexWindow?.pickElementStart;
    if (bridge !== undefined && wv.executeJavaScript !== undefined) {
      // 桌面壳桥面(2026-11-04 用户裁定「任何页面都能选取,参考开源实现」):CDP Overlay inspect=
      // DevTools 检视同源——原生蓝框+showInfo 信息条+点击拦截在浏览器层,不注脚本,
      // 任意 CSP/框架页面可用(注入版被页面环境卡死即此弃因)。结果经 onPickNode 回投
      let wcId = 0;
      try {
        wcId = wv.getWebContentsId();
      } catch {
        failHint();
        return;
      }
      setPickState('picking');
      pickWcRef.current = wcId;
      pickViaBridgeRef.current = true;
      const r = await bridge(wcId).catch(() => ({ ok: false, error: 'bridge failed' }));
      if (r.ok !== true) {
        pickViaBridgeRef.current = false;
        failHint();
      }
      return;
    }
    // 注入兜底(纯浏览器 iframe 态/旧壳):原 executeJavaScript 拾取脚本,同样直投主对话
    if (wv.executeJavaScript === undefined) return;
    let wcId = 0;
    try {
      wcId = wv.getWebContentsId();
    } catch {
      failHint();
      return;
    }
    setPickState('picking');
    try {
      const picked = (await wv.executeJavaScript(PICK_ELEMENT_JS, true)) as { url: string; title: string; path: string; html: string } | null;
      setPickState('idle');
      if (picked === null || picked.html === '') return; // Esc 取消
      insertPicked({ wcId, url: picked.url, title: picked.title, path: picked.path, html: picked.html });
    } catch {
      failHint(); // 注入失败可见化(导航中/CSP/页环境异常)
    }
  };

  const navigate = (): void => {
    if (input.trim() === '') return;
    const url = normalizeWebUrl(input);
    if (builtin) {
      // webview 档:已挂载经 loadURL 驱动(不换 src 防重挂);未挂载置 wvTarget 走初值渲染
      setWvTarget((prev) => (prev === null ? url : prev));
      setInput(url);
      setWvUrl(url); // 即时回显(did-navigate 事件后由 getURL 权威覆盖;外开钮即刻可用)
      if (wvTarget !== null) wvRef.current?.loadURL(url);
      onMetaRef.current(uid, { url, pageTitle: webPageName(url) });
      return;
    }
    setNav((n) => {
      const urls = [...n.urls.slice(0, n.index + 1), url];
      return { urls, index: urls.length - 1 };
    });
    setNonce((v) => v + 1); // 同址重输也重载
    setInput(url);
    onMetaRef.current(uid, { url, pageTitle: webPageName(url) }); // 标签条标题/判重键随导航演进(页名 onLoad 再精化)
  };

  const back = (): void => {
    if (builtin) { wvRef.current?.goBack(); return; }
    setNav((n) => (n.index > 0 ? { ...n, index: n.index - 1 } : n));
  };
  const forward = (): void => {
    if (builtin) { wvRef.current?.goForward(); return; }
    setNav((n) => (n.index < n.urls.length - 1 ? { ...n, index: n.index + 1 } : n));
  };
  const reload = (): void => {
    if (builtin) { wvRef.current?.reload(); return; }
    setNonce((v) => v + 1);
  };
  // 2026-10-25 用户报障:window.open 在 Electron 里只开自家子窗,不是系统默认浏览器——
  // openExternalUrl 单点(桌面壳走 preload 桥 shell.openExternal,OS 默认浏览器承接;浏览器态回落 window.open)
  const openExternal = (): void => {
    const target = builtin ? (wvUrl !== '' ? wvUrl : null) : active;
    if (target !== null) openExternalUrl(target);
  };

  /** 页名/站标精化(2026-10-25 用户报障「页签只显 host+地球,应显网页标题+站标」):跨域帧
   *  contentDocument 拒访(syncPageTitle 恒空),改 daemon /web/meta 服务端代取——title+favicon
   *  尽力而为,失败退 host/地球。竞态守卫:回写前校验 active 仍为发起时的 url(导航/重载作废) */
  const syncPageMeta = (url: string): void => {
    conn
      .fetchWebMeta(url)
      .then((meta) => {
        if (activeRef.current !== url) return; // 已导航/刷新:过期应答弃
        onMetaRef.current(uid, {
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
    if (title !== '') onMetaRef.current(uid, { pageTitle: title });
  };

  /** 宽高草稿提交:非法/过小丢弃;≥16 取整生效 */
  const commitDim = (draft: string | null, apply: (n: number) => void): void => {
    if (draft === null) return;
    const n = Number(draft);
    if (Number.isFinite(n) && n >= 16) apply(Math.round(n));
  };

  /** 视口边角拖拽调尺寸(2026-11-06 用户裁定:上下左右+四角手柄,最小 320):
   *  拖动位移 ÷ 当前倍率 = 设备 px 增量,直接写 devW/H——顶行宽高输入框(显 deviceW/H)与
   *  视口盒实时同步。适应窗口态开拖先定格当前倍率(fit 恒占满面板会吞掉尺寸变化),
   *  之后同固定倍率档;zoom 契约:pointer 坐标 /zoomScale 归一后再算增量 */
  const MIN_DIM = 320;
  /** 拖拽在途方向(渲染全屏遮罩):webview 的 guest 页面会吞掉其上方指针事件,宿主 window
   *  监听收不到 move=拖到网页内即断触(2026-11-07 实测);遮罩挡在 webview 前承接整段拖拽 */
  const [resizeDir, setResizeDir] = useState<'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | null>(null);
  const dragViewport = (e: React.PointerEvent<HTMLDivElement>, dir: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const scaler = scalerRef.current;
    if (scaler === null) return;
    const rect = scaler.getBoundingClientRect();
    const scale = rect.width / deviceW;
    if (!(scale > 0)) return;
    const z = zoomScale();
    if (devFit) {
      setDevFit(false);
      setDevZoom(scale);
    }
    const startX = e.clientX / z;
    const startY = e.clientY / z;
    const startW = deviceW;
    const startH = deviceH;
    setResizeDir(dir);
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX / z - startX;
      const dy = ev.clientY / z - startY;
      let w = startW;
      let h = startH;
      if (dir.includes('e')) w = Math.round(startW + dx / scale);
      if (dir.includes('w')) w = Math.round(startW - dx / scale);
      if (dir.includes('s')) h = Math.round(startH + dy / scale);
      if (dir.includes('n')) h = Math.round(startH - dy / scale);
      setDevW(Math.max(MIN_DIM, Math.min(12000, w)));
      setDevH(Math.max(MIN_DIM, Math.min(12000, h)));
    };
    const up = (): void => {
      setResizeDir(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  return (
    <div className="sx-web-tab" aria-label="web tab">
      <div className="sx-web-bar">
        <button
          type="button"
          className="sx-web-nav"
          aria-label={t('Back', '后退')}
          data-tip={t('Back', '后退')}
          disabled={builtin ? !wvCanBack : nav.index <= 0}
          onClick={back}
        >
          <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="sx-web-nav"
          aria-label={t('Forward', '前进')}
          data-tip={t('Forward', '前进')}
          disabled={builtin ? !wvCanFwd : nav.index >= nav.urls.length - 1}
          onClick={forward}
        >
          <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="sx-web-nav"
          aria-label={t('Reload', '刷新')}
          data-tip={t('Reload', '刷新')}
          disabled={builtin ? wvTarget === null : active === null}
          onClick={reload}
        >
          <RotateCw size={13} strokeWidth={1.75} aria-hidden="true" />
        </button>
        {/* 2026-11-07 用户裁定:−/%/+ webview 内容缩放钮撤下——非自由尺寸=侧栏真实尺寸无缩放;
            缩放语义单点收敛到自由尺寸行的「倍率」下拉(视口显示倍率,不改页内 ppi) */}
        <div className="sx-web-url-box">
          <Lock size={11} strokeWidth={1.75} aria-hidden="true" />
          <input
            className="sx-web-url"
            aria-label="web url input"
            value={builtin ? (input !== '' && input !== wvUrl ? input : (wvUrl || input)) : input}
            placeholder={t('Type a URL and press Enter', '输入网址后回车')}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') navigate();
            }}
          />
        </div>
        {/* ⋯ 更多操作菜单(2026-10-31 用户裁定:外链钮升级为菜单钮——在默认浏览器打开+打开
            调试工具;两项均需已输入网址;调试项仅桌面壳在场(旧壳无 openDevtools 桥自动隐)) */}
        <div className="sx-web-dev-anchor">
          <button
            type="button"
            className={`sx-web-nav${moreOpen ? ' active' : ''}`}
            aria-label={t('More actions', '更多操作')}
            data-tip={t('More actions', '更多操作')}
            aria-expanded={moreOpen}
            onClick={(e) => {
              e.stopPropagation();
              setMoreOpen((v) => !v);
            }}
          >
            <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {moreOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 24, background: 'transparent' }} onClick={() => setMoreOpen(false)} />
              <div className="sx-web-dev-menu sx-web-more-menu" role="menu" aria-label={t('More actions', '更多操作')} style={{ zIndex: 25 }}>
                <button
                  type="button"
                  role="menuitem"
                  disabled={builtin ? wvUrl === '' : active === null}
                  onClick={() => {
                    openExternal();
                    setMoreOpen(false);
                  }}
                >
                  <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
                  {t('Open in system browser', '在默认浏览器中打开')}
                </button>
                {devtoolsBridge !== undefined && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={builtin ? wvUrl === '' : active === null}
                    onClick={() => {
                      // 2026-11-04 用户裁定:DevTools 只挂内置浏览器页签(webview 的 guest wc),
                      // 不落桌面端主窗;id 缺席(iframe 态/旧壳)由壳侧回退主窗
                      devtoolsBridge(wvRef.current?.getWebContentsId?.());
                      setMoreOpen(false);
                    }}
                  >
                    <Bug size={12} strokeWidth={1.75} aria-hidden="true" />
                    {t('Open DevTools', '打开调试工具')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        {/* 元素拾取独立钮(2026-11-04 用户裁定:从 ⋯ 菜单抽出置自由尺寸前;检视中=active 态,
            选中/点外/Esc/再点均收——状态机见 pickElement/exitPick);仅桥面在场渲染(新壳) */}
        {builtin && window.sunshinexWindow?.pickElementStart !== undefined && (
          <button
            type="button"
            className={`sx-web-nav${pickState === 'picking' ? ' active' : ''}`}
            aria-label={t('Pick element', '选取元素')}
            aria-pressed={pickState === 'picking'}
            data-tip={t('Pick element', '选取元素')}
            onClick={() => void pickElement()}
          >
            <MousePointerClick size={13} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
        {/* G14.2xx 自由尺寸开关(设备模拟形):开=缺省 16:9 标准档 1280×720 定格为视口 px(此后
            只随输入变,不随侧栏漂移)+缩放下拉;关=流式+缩放钮。开关留条上;宽高/缩放控件
            2026-10-31 用户裁定移至独立一行(不挤网址右侧) */}
        <button
          type="button"
          className={`sx-web-nav${deviceMode ? ' active' : ''}`}
          aria-label={t('Custom size', '自由尺寸')}
          data-tip={t('Custom size', '自由尺寸')}
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
      {deviceMode && (
        <div className="sx-web-dev-row">
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
        </div>
      )}
      {/* 缩放结构恒在场(未开页同样显示目标区域——自由尺寸空态=视口框内引导面) */}
      <div className={`sx-web-frame-wrap${deviceMode ? ' device' : ''}`} ref={wrapRef}>
        <div
          ref={scalerRef}
          className={`sx-web-scaler${deviceMode ? ' device' : ''}`}
          style={deviceMode ? undefined : { width: '100%', height: '100%' }}
        >
          <div
            ref={innerRef}
            style={{
              width: deviceMode ? deviceW : '100%',
              height: deviceMode ? deviceH : '100%',
              transformOrigin: 'top left',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--surface)',
            }}
          >
            {builtin ? (
              wvTarget === null ? (
                <div className="sx-web-empty">
                  <Globe size={56} strokeWidth={1} aria-hidden="true" />
                  <p className="sx-web-empty-title">{t('Browser', '浏览器')}</p>
                  <p className="sx-web-empty-hint">{t('Paste or type a URL to open a page.', '粘贴或输入 URL 以打开网页。')}</p>
                </div>
              ) : (
                /* M1 真实嵌入页面:partition 持久化登录态(独立于应用会话);弹窗放行由壳侧
                   setWindowOpenHandler 外开承接;无 node/无壳 API(will-attach-webview 纪律) */
                <webview
                  ref={attachWv}
                  src={wvTarget}
                  partition={partition ?? 'persist:sx-builtin'}
                  /* 缺 allowpopups 时 Electron 在 setWindowOpenHandler 之前就吞掉弹窗(_blank/window.open
                   * 全静默);放开后主进程 handler 恒 deny 原生窗,只转发 http(s) 开新侧栏页签 */
                  allowpopups="true"
                  style={{ width: '100%', height: '100%', border: 'none', background: 'var(--surface-code)' }}
                />
              )
            ) : active === null ? (
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
          {/* 视口边角拖拽手柄(2026-11-06 用户裁定:四边+四角 8 向;拖动实时改视口 px,顶行尺寸同步) */}
          {(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const).map((dir) => (
            <div key={dir} className={`sx-web-rz sx-web-rz-${dir}`} onPointerDown={(e) => dragViewport(e, dir)} aria-hidden="true" />
          ))}
        </div>
      </div>
      {pickState === 'failed' && (
        <div className="sx-web-pickhint err" role="alert">
          {t('Element picking unavailable on this page', '当前页面无法选取元素')}
        </div>
      )}
      {/* 拖拽遮罩:挡住 webview 吞事件(拖到网页内断触根因),光标随拖拽方向轴 */}
      {resizeDir !== null && (
        <div
          className="sx-web-rz-overlay"
          style={{ cursor: resizeDir === 'n' || resizeDir === 's' ? 'ns-resize' : resizeDir === 'e' || resizeDir === 'w' ? 'ew-resize' : resizeDir === 'ne' || resizeDir === 'sw' ? 'nesw-resize' : 'nwse-resize' }}
        />
      )}
    </div>
  );
}
