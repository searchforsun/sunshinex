import { useEffect, useRef, useState } from 'react';
import { currentTheme, watchThemeChange } from './theme';
import { codeFontSize, codeFontFamily } from './font-preset';

/**
 * Mermaid 图渲染(G10-C3c):代码分包(不进主 bundle;G14.2xx 起模块加载即预取 chunk——
 * 会话进场首图免付 ~1s 等待,桌面本地资产不碍首屏);
 * 主题随 html[data-theme](MutationObserver 监听,切换即重渲);失败/超时回落原文代码块
 * (会话流零阻塞,spec §10 降级纪律)。
 * G13 批次1:base 主题 + 主题变量取 app.css 令牌同值——dark 下不再出现 mermaid 默认亮底节点
 * (节点面=--surface-elevated/文字=--fg/连线=fg 50%),与流区底色同源。
 * G14.2xx 会话进场不割裂:①模块加载即预取 mermaid chunk;②渲染缓存;③sx-mermaid-settled 广播。
 * 流式策略(2026-10-30 用户报障「mermaid 无法实时流式渲染」;推翻 10-31 零 render 策略——
 * 整图压到流末才现形,与流式体验相悖):围栏未闭合 draft=true → live 试渲——半截源码对
 * mermaid.render 节流尝试(首帧立即,后续 600ms 一发尾随;每次 chart 变化重排计时),成功即
 * 成图随流生长(sx-mermaid-settled 照常广播,贴底跟随不断链);失败=半截语法,静默回落软
 * 源码零错误面,下一帧重试。半截解析的代价由节流兜住。live 成图不进缓存(半截源码无复用
 * 价值),闭合后正式渲一次入缓存;渲染 id 每次自增,防与正式渲同 id 并发冲突。
 */

/** 两套主题色(与 app.css :root / [data-theme='light'] 手工同值;mermaid 无法读 CSS 色变量)。
 *  字族/字号运行时拼入——跟随字体预设(除浏览器外网页外全跟随)。 */
const MERMAID_COLORS = {
  dark: {
    darkMode: true,
    background: '#101010',
    primaryColor: '#212121',
    primaryTextColor: '#dfdfdf',
    primaryBorderColor: '#3f3f3f',
    secondaryColor: '#212121',
    secondaryTextColor: '#dfdfdf',
    tertiaryColor: '#181818',
    lineColor: '#8f8f8f',
    textColor: '#dfdfdf',
    mainBkg: '#212121',
    nodeBorder: '#3f3f3f',
    clusterBkg: '#181818',
    clusterBorder: '#2c2c2c',
    edgeLabelBackground: '#101010',
  },
  light: {
    darkMode: false,
    background: '#fcfcfc',
    primaryColor: '#f3f3f3',
    primaryTextColor: '#1a1c1f',
    primaryBorderColor: '#d5d5d5',
    secondaryColor: '#f3f3f3',
    secondaryTextColor: '#1a1c1f',
    tertiaryColor: '#f9f9f9',
    lineColor: '#6b6b6b',
    textColor: '#1a1c1f',
    mainBkg: '#f3f3f3',
    nodeBorder: '#d5d5d5',
    clusterBkg: '#f9f9f9',
    clusterBorder: '#e5e5e5',
    edgeLabelBackground: '#fcfcfc',
  },
} as const;

function mermaidThemeVars(): Record<string, string | boolean> {
  let uiFamily = '';
  try {
    uiFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim();
  } catch {
    /* 非浏览器守卫 */
  }
  return {
    ...MERMAID_COLORS[currentTheme()],
    fontFamily: uiFamily || codeFontFamily(),
    fontSize: `${codeFontSize()}px`,
  };
}

/** 模块预取:本模块随 Chat/Files 静态链加载,chunk 即刻在后台拉起(测试 mock 同经此路径);
 *  失败归一 undefined,由渲染处按错误回落 */
const mermaidReady: Promise<typeof import('mermaid') | undefined> = import('mermaid').catch(() => undefined);

/** 渲染缓存(主题+图源→svg):进程内存态;超上限整体清(图源重复率低,LRU 不值得) */
const svgCache = new Map<string, string>();
const cacheKey = (theme: string, chart: string): string => `${theme}\u0000${chart}`;
const RENDER_TIMEOUT_MS = 5_000;
/** 流式 live 试渲节流间隔:半截图随流成形的最大延迟上界(首帧不受限) */
const LIVE_RENDER_INTERVAL_MS = 600;

export function mermaidCacheClear(): void {
  svgCache.clear();
}

/** 渲染配置单点(live/正式两路同参)。suppressErrorRendering 必开(2026-10-30 用户报障「显示不出来了」
 *  根因):mermaid 12.1 render 在 body 上挂临时容器 #d<id> 作画,parse 失败时 throw 落在
 *  removeTempElements() 之前(draw 失败分支亦画完错误图直接 throw)——容器连同整张「Syntax error」
 *  错误图永久残留 body;live 试渲令半截失败高频,残留逐块撑高 body,正文被推出视口。开关令其失败
 *  即自清(错误面本就由本组件自绘,不依赖 mermaid 错误图) */
function mermaidInitConfig(): Parameters<typeof import('mermaid').default.initialize>[0] {
  return { startOnLoad: false, securityLevel: 'strict', theme: 'base', look: 'classic', suppressErrorRendering: true, themeVariables: mermaidThemeVars() };
}

/** 失败兜底清残留(与 suppressErrorRendering 双保险):mermaid 临时容器 #d<id>(sandbox 态 #i<id>);
 *  不动 #<id>——成图 svg 本身即以 id 落在本组件容器内 */
function removeMermaidTemp(id: string): void {
  document.getElementById(`d${id}`)?.remove();
  document.getElementById(`i${id}`)?.remove();
}

/** G14.86 语法容错:未加引号的节点标签含 < / > / ? 时自动补双引号(模型产出高频病——
 *  裸标签遇 HTML 敏感字符 mermaid 解析必炸回退源码);已引号标签(含 <br>)不动 */
export function repairMermaid(chart: string): string {
  return chart.replace(
    /(\[\[|\[|\(|\(\()([^"[\()<>]*[<>?][^"[\()<>]*)(\]\]|\]|\)|\)\))/g,
    (_m, open, label, close) => `${open}"${label.trim().replace(/"/g, '#quot;')}"${close}`,
  );
}

export function Mermaid({
  chart,
  onStatus,
  draft = false,
}: {
  chart: string;
  onStatus?: (ok: boolean, errorMsg?: string) => void;
  /** 围栏未闭合:流式 live 试渲(节流),失败静默回落软源码 */
  draft?: boolean;
}): JSX.Element {
  const [svg, setSvg] = useState<string | null>(() => (draft ? null : svgCache.get(cacheKey(currentTheme(), chart)) ?? null));
  const [failed, setFailed] = useState<string | null>(null);
  const idRef = useRef(`mmd-${Math.random().toString(36).slice(2)}`);
  const liveLastRef = useRef(0);
  const liveSeqRef = useRef(0);
  const [themeTick, setThemeTick] = useState(0);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => {
    const bump = (): void => setThemeTick((v) => v + 1);
    const unwatch = watchThemeChange(bump);
    const onFont = (): void => {
      svgCache.clear();
      bump();
    };
    window.addEventListener('sunshinex:font-preset', onFont);
    return () => {
      unwatch();
      window.removeEventListener('sunshinex:font-preset', onFont);
    };
  }, []);

  useEffect(() => {
    if (svg === null && failed === null) return;
    window.dispatchEvent(new Event('sx-mermaid-settled'));
  }, [svg, failed]);

  useEffect(() => {
    if (draft) return; // 流式草稿面由下方 live 试渲 effect 接管

    let alive = true;
    const key = cacheKey(currentTheme(), chart);
    const cached = svgCache.get(key);
    if (cached !== undefined) {
      setSvg(cached);
      setFailed(null);
      onStatusRef.current?.(true);
      return () => {
        alive = false;
      };
    }

    (async () => {
      try {
        const mod = await mermaidReady;
        if (mod === undefined) throw new Error('mermaid unavailable');
        if (!alive) return;
        const mermaid = mod.default;
        mermaid.initialize(mermaidInitConfig());
        const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('mermaid timeout')), RENDER_TIMEOUT_MS));
        const r = (await Promise.race([mermaid.render(idRef.current, repairMermaid(chart)), timeout])) as { svg: string };
        if (!alive) return;
        if (svgCache.size >= 200) svgCache.clear();
        svgCache.set(key, r.svg);
        setSvg(r.svg);
        setFailed(null);
        onStatusRef.current?.(true);
      } catch (e) {
        removeMermaidTemp(idRef.current);
        if (!alive) return;
        const raw = e instanceof Error ? e.message : String(e);
        const msg = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || 'render failed';
        setSvg(null);
        setFailed(msg);
        onStatusRef.current?.(false, msg);
      }
    })();

    return () => {
      alive = false;
    };
  }, [chart, themeTick, draft]);

  /** 流式 live 试渲(draft 期):半截源码节流 mermaid.render——成功成图随流生长,失败保留上一成图
   *  帧(无则软源码),零错误面。候选两级:全文优先(末行恰完整=零滞后),失败退掉末行再试(token 多停
   *  行中,半截末行是最常见失败因;滞后 ≤1 行)。同源去重免重渲;不报 onStatus(草稿期动作钮本就
   *  不挂)。全文成图单槽写缓存(旧槽即删,零污染):闭合时块由尾块迁头块重挂载,初始态命中缓存
   *  即零闪替换。每帧 chart 变化重排计时=带尾随的节流,流停后余量到期补渲最后一帧 */
  const liveDoneRef = useRef<string | null>(null);
  const liveCachedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    liveDoneRef.current = null; // 主题/字体换挡:同源也须重渲
  }, [themeTick]);
  useEffect(() => {
    if (!draft) return;
    let alive = true;
    const attempt = async (): Promise<void> => {
      liveLastRef.current = Date.now();
      const mod = await mermaidReady;
      if (!alive || mod === undefined) return;
      const mermaid = mod.default;
      mermaid.initialize(mermaidInitConfig());
      const nl = chart.lastIndexOf('\n');
      const candidates = nl > 0 ? [chart, chart.slice(0, nl)] : [chart];
      for (const src of candidates) {
        if (src === liveDoneRef.current) return;
        liveSeqRef.current += 1;
        const liveId = `${idRef.current}-live${liveSeqRef.current}`;
        try {
          const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('mermaid timeout')), RENDER_TIMEOUT_MS));
          const r = (await Promise.race([mermaid.render(liveId, repairMermaid(src)), timeout])) as { svg: string };
          if (!alive) return;
          liveDoneRef.current = src;
          if (src === chart) {
            const key = cacheKey(currentTheme(), src);
            if (liveCachedKeyRef.current !== null) svgCache.delete(liveCachedKeyRef.current);
            if (svgCache.size >= 200) svgCache.clear();
            svgCache.set(key, r.svg);
            liveCachedKeyRef.current = key;
          }
          setSvg(r.svg);
          setFailed(null);
          return;
        } catch {
          removeMermaidTemp(liveId);
          if (!alive) return; // 半截语法:静默试下一候选;全败保留上一帧
        }
      }
    };
    const timer = setTimeout(() => {
      void attempt();
    }, Math.max(0, LIVE_RENDER_INTERVAL_MS - (Date.now() - liveLastRef.current)));
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [chart, themeTick, draft]);

  if (failed !== null) {
    return (
      <div className="mermaid-error" data-testid="mermaid-error">
        <div className="mermaid-error-msg">{failed}</div>
        <pre className="mermaid-fallback">{chart}</pre>
      </div>
    );
  }
  if (svg === null) {
    // 流式草稿(live 未成/半截语法)/ 正式成图在途:软源码(无代码卡底)——成图即替换
    return (
      <pre className="mermaid-pending mermaid-draft" data-testid="mermaid-pending" aria-busy="true">
        {chart}
      </pre>
    );
  }
  return <div className="mermaid-svg" data-testid="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />;
}
