import { useEffect, useRef, useState } from 'react';
import { watchThemeChange } from './theme';
import { currentPalette, mixHex } from './palette';
import type { Palette } from './palette';
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

/** 配色 → mermaid 主题色(mermaid 读不了 CSS 色变量,取值单源 palette.ts):画布=editor 底,
 *  节点/簇/连线按 fg 向画布混色分档(系数取自原暗/亮两套手调值,default 配色下近同值)。
 *  字族/字号运行时拼入——跟随字体预设(除浏览器外网页外全跟随)。 */
function mermaidColors(p: Palette): Record<string, string | boolean> {
  const { fg, editor } = p.tokens;
  const dark = p.mode === 'dark';
  const m = (t: number): string => mixHex(fg, editor, t);
  const node = m(dark ? 0.08 : 0.04);
  const border = m(dark ? 0.23 : 0.17);
  return {
    darkMode: dark,
    background: editor,
    primaryColor: node,
    primaryTextColor: fg,
    primaryBorderColor: border,
    secondaryColor: node,
    secondaryTextColor: fg,
    tertiaryColor: m(dark ? 0.04 : 0.013),
    lineColor: m(dark ? 0.61 : 0.64),
    textColor: fg,
    mainBkg: node,
    nodeBorder: border,
    clusterBkg: m(dark ? 0.04 : 0.013),
    clusterBorder: m(dark ? 0.135 : 0.1),
    edgeLabelBackground: editor,
  };
}

function mermaidThemeVars(): Record<string, string | boolean> {
  let uiFamily = '';
  try {
    uiFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim();
  } catch {
    /* 非浏览器守卫 */
  }
  return {
    ...mermaidColors(currentPalette()),
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
/** live 候选逐行回退上限(2026-11-07 用户报障「erDiagram 输出时露源码」):块作用域语法(erDiagram/
 *  classDiagram/stateDiagram 的 `{...}` 属性块、mindmap 缩进块)在块打开期间任何前缀都解析失败,
 *  只退一行=荒漠期图不生长。逐行回退到最近可解析边界(通常即上个块闭合点),图按「整块」生长,
 *  图型零清单;单窗至多 24 次失败试渲,失败=语法早退(毫秒级),节流兜 CPU */
const LIVE_RETREAT_MAX_LINES = 24;

export function mermaidCacheClear(): void {
  svgCache.clear();
  liveFrames.clear();
}

/** live 成图帧暂存(2026-10-30 用户报障「输出完时闪现源码再显示 svg」):围栏闭合时块由尾块迁头块
 *  重挂载,state 随旧实例丢;单槽缓存只在「最后一次 live 恰渲全文」时命中,末 token 与闭合落在同一
 *  节流窗内(常态)则未渲全文→新实例初始态落回软源码,正式渲落定才换图=闪。帧表 src→svg(FIFO 上限
 *  16),新实例按「已渲 src 是 chart 前缀且不短于其半」取最长帧作占位,正式渲落定即替换——过渡期恒有图 */
const liveFrames = new Map<string, string>();
const LIVE_FRAMES_MAX = 16;
function liveFrameSet(src: string, svg: string): void {
  liveFrames.delete(src);
  liveFrames.set(src, svg);
  while (liveFrames.size > LIVE_FRAMES_MAX) liveFrames.delete(liveFrames.keys().next().value as string);
}
function liveFrameFor(chart: string): string | null {
  let best: string | null = null;
  let bestLen = -1;
  for (const [src, svg] of liveFrames) {
    // 前缀命中即取最长(2026-11-07 撤半长条件):占位帧只与「露源码/中性占位」二选一,旧帧再陈旧也优;
    // 逐行回退后成功帧密集,陈旧窗本就大幅收窄
    if (src.length > bestLen && chart.startsWith(src)) {
      best = svg;
      bestLen = src.length;
    }
  }
  return best;
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
  const [svg, setSvg] = useState<string | null>(() => (draft ? null : svgCache.get(cacheKey(currentPalette().id, chart)) ?? liveFrameFor(chart)));
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
    const key = cacheKey(currentPalette().id, chart);
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
   *  即零闪替换。
   *  状态机与 token 解耦(2026-10-30 用户报障「每次只渲染一段、不往下长」根修):首版以 chart 为
   *  effect 依赖,每个 token 都清理上一实例——在途 render(几十到上百 ms)结果一律被丢,连续流式下
   *  几乎每次试渲都被下一 token 作废,只在流停顿时偶尔成图。现改:在途渲染不受 token 打断(结果是
   *  当前图的前缀,照样显示——单调生长);渲染/排程期间来的变化不打断,完成后按 chart 变化尾随再渲一次;
   *  节流计时不随 token 重排;只有围栏闭合/卸载/主题换挡才终止在途 */
  const liveDoneRef = useRef<string | null>(null);
  const liveCachedKeyRef = useRef<string | null>(null);
  const chartRef = useRef(chart);
  chartRef.current = chart;
  const liveRef = useRef({ active: false, running: false, timer: null as ReturnType<typeof setTimeout> | null });
  const liveSchedule = (): void => {
    const st = liveRef.current;
    if (!st.active) return;
    if (st.running || st.timer !== null) return; // 在途完成后按 chart 变化尾随;已排程者到期读最新 chart
    st.timer = setTimeout(() => {
      st.timer = null;
      void liveRun();
    }, Math.max(0, LIVE_RENDER_INTERVAL_MS - (Date.now() - liveLastRef.current)));
  };
  const liveRun = async (): Promise<void> => {
    const st = liveRef.current;
    st.running = true;
    liveLastRef.current = Date.now();
    const chartNow = chartRef.current;
    try {
      const mod = await mermaidReady;
      if (mod === undefined || !st.active) return;
      const mermaid = mod.default;
      mermaid.initialize(mermaidInitConfig());
      // 候选=全文 + 逐行回退(至多 LIVE_RETREAT_MAX_LINES):荒漠期(块作用域语法打开)一直退到最近
      // 可解析边界——通常即上个块闭合点,图按块生长;命中已渲帧(liveDoneRef)即止(所显已是该帧,更短无益)
      const rows = chartNow.split('\n');
      const candidates: string[] = [chartNow];
      const retreat = Math.min(LIVE_RETREAT_MAX_LINES, rows.length - 1);
      for (let k = 1; k <= retreat; k += 1) candidates.push(rows.slice(0, rows.length - k).join('\n'));
      for (const src of candidates) {
        if (src === liveDoneRef.current) return;
        liveSeqRef.current += 1;
        const liveId = `${idRef.current}-live${liveSeqRef.current}`;
        try {
          const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('mermaid timeout')), RENDER_TIMEOUT_MS));
          const r = (await Promise.race([mermaid.render(liveId, repairMermaid(src)), timeout])) as { svg: string };
          if (!st.active) return;
          liveDoneRef.current = src;
          liveFrameSet(src, r.svg);
          if (src === chartNow) {
            const key = cacheKey(currentPalette().id, src);
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
          if (!st.active) return; // 半截语法:静默试下一候选;全败保留上一帧
        }
      }
    } finally {
      st.running = false;
      if (st.active && chartRef.current !== chartNow) liveSchedule(); // 在途期间有新 token:尾随补渲最新帧
    }
  };
  // 生命周期:draft 期激活;闭合/卸载/主题换挡终止在途与排程(主题换挡随即重开并重渲——同源亦须换色)
  useEffect(() => {
    if (!draft) return;
    const st = liveRef.current;
    st.active = true;
    liveDoneRef.current = null;
    liveSchedule();
    return () => {
      st.active = false;
      if (st.timer !== null) {
        clearTimeout(st.timer);
        st.timer = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- themeTick/chart 为重渲信号,依赖面刻意收窄
  }, [draft, themeTick]);
  // token 到达:只排程(在途/已排程则合并),不打断在途渲染
  useEffect(() => {
    if (draft) liveSchedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chart 变更=重排程信号,liveSchedule 闭包自足
  }, [chart]);

  if (failed !== null) {
    return (
      <div className="mermaid-error" data-testid="mermaid-error">
        <div className="mermaid-error-msg">{failed}</div>
        <pre className="mermaid-fallback">{chart}</pre>
      </div>
    );
  }
  if (svg === null) {
    // 流式草稿(live 未成/半截语法)/ 正式成图在途:中性占位(2026-11-07 用户裁定撤软源码——源码任何
    // 窗口不再外露;成图即替换,失败态另有错误卡带源码供修复)
    return (
      <div className="mermaid-pending mermaid-draft" data-testid="mermaid-pending" aria-busy="true">
        {/* SVG 圆环(2026-11-07 实测:border 环在界面放缩栅格化下 24px 圆角方走样,SVG 路径不受累) */}
        <svg className="mermaid-pending-spin" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="mermaid-pending-spin-track" cx="12" cy="12" r="10" />
          <circle className="mermaid-pending-spin-arc" cx="12" cy="12" r="10" />
        </svg>
      </div>
    );
  }
  return <div className="mermaid-svg" data-testid="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />;
}
