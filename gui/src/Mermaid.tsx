import { useEffect, useRef, useState } from 'react';
import { currentTheme, watchThemeChange } from './theme';

/**
 * Mermaid 图渲染(G10-C3c):代码分包(不进主 bundle;G14.2xx 起模块加载即预取 chunk——
 * 会话进场首图免付 ~1s 等待,桌面本地资产不碍首屏);
 * 主题随 html[data-theme](MutationObserver 监听,切换即重渲);渲染失败/超时回落原文代码块
 * (会话流零阻塞,spec §10 降级纪律)。
 * G13 批次1:base 主题 + 主题变量取 app.css 令牌同值——dark 下不再出现 mermaid 默认亮底节点
 * (节点面=--surface-elevated/文字=--fg/连线=fg 50%),与流区底色同源。
 * G14.2xx 会话进场不割裂:①模块加载即预取 mermaid chunk(首图免在进场时付 ~1s 动态导入);
 * ②渲染缓存(主题+图源→svg)——重进会话/重挂载同步直出,不再「先代码块 1s 后弹图」;
 * ③渲染落定广播 sx-mermaid-settled——撑高发生在组件内 state,贴底跟随方(Chat)借此补归底。
 */

/** 两套主题变量(与 app.css :root / [data-theme='light'] 手工同值;mermaid 无法读 CSS 变量) */
const MERMAID_VARS = {
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
    fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    fontSize: '13px',
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
    fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    fontSize: '13px',
  },
} as const;

/** 模块预取:本模块随 Chat/Files 静态链加载,chunk 即刻在后台拉起(测试 mock 同经此路径);
 *  失败归一 undefined,由渲染处按错误回落 */
const mermaidReady: Promise<typeof import('mermaid') | undefined> = import('mermaid').catch(() => undefined);

/** 渲染缓存(主题+图源→svg):进程内存态;超上限整体清(图源重复率低,LRU 不值得) */
const svgCache = new Map<string, string>();
const cacheKey = (theme: string, chart: string): string => `${theme}\u0000${chart}`;
/** 测试钩子:缓存是模块态,用例间清空以复现 pending/现渲路径 */
const RENDER_TIMEOUT_MS = 5_000; // mermaid 渲染超时(D33 具名):到点回落原文代码块

export function mermaidCacheClear(): void {
  svgCache.clear();
}

/** G14.86 语法容错:未加引号的节点标签含 < / > / ? 时自动补双引号(模型产出高频病——
 *  裸标签遇 HTML 敏感字符 mermaid 解析必炸回退源码);已引号标签(含 <br>)不动 */
export function repairMermaid(chart: string): string {
  return chart.replace(
    /(\[\[|\[|\(|\(\()([^"[\()<>]*[<>?][^"[\()<>]*)(\]\]|\]|\)|\)\))/g,
    (_m, open, label, close) => `${open}"${label.trim().replace(/"/g, '#quot;')}"${close}`,
  );
}

export function Mermaid({ chart, onStatus }: { chart: string; onStatus?: (ok: boolean) => void }): JSX.Element {
  /** G14.2xx 缓存直出:命中即同步首绘(无 pending 态、无进场撑高跳变),未命中走异步现渲 */
  const [svg, setSvg] = useState<string | null>(() => svgCache.get(cacheKey(currentTheme(), chart)) ?? null);
  /** G14.94 渲染失败态:错误消息(红)+源代码同框——修复有据 */
  const [failed, setFailed] = useState<string | null>(null);
  const idRef = useRef(`mmd-${Math.random().toString(36).slice(2)}`);
  /** G14.2xx 流式静默:上一版成功图形(失败时不 clear,保图形在屏);稳定重试仍败才落错误态 */
  const lastGoodRef = useRef<{ chart: string; svg: string } | null>(null);
  /** 稳定判定窗:chart 停止变化达该时长后仍失败才示错(流式期间静默) */
  const STABLE_MS = 1200;
  /** 主题切换触发器:data-theme 属性变化即重渲(否则图停留在旧配色直到 chart 变更) */
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    return watchThemeChange(() => setThemeTick((v) => v + 1));
  }, []);

  /** G14.2xx 落定广播:svg/回落提交后发全局事件——撑高发生在组件内 state,不触发父流区
   *  重渲染,贴底跟随方(Chat)监听此事件补归底(会话进场多图连发由消费方 rAF 合并) */
  useEffect(() => {
    if (svg === null && failed === null) return;
    window.dispatchEvent(new Event('sx-mermaid-settled'));
  }, [svg, failed]);

  useEffect(() => {
    let alive = true;
    let abortedByStale = false; // G14.2xx 流式静默:chart 未稳定期间的失败不示错(静默重试,稳定后仍败才示错)
    const key = cacheKey(currentTheme(), chart);
    const cached = svgCache.get(key);
    if (cached !== undefined) {
      setSvg(cached);
      setFailed(null);
      onStatus?.(true);
      return () => {
        alive = false;
      };
    }
    // G14.2xx 去抖:流式期间 chart 每帧都在长,逐 token 重渲渲染成本高——静默期后统一尝试
    const debounce = window.setTimeout(run, 250);
    function run(): void {
      if (!alive) return;
      (async () => {
        try {
          const mod = await mermaidReady;
          if (mod === undefined) throw new Error('mermaid unavailable');
          const mermaid = mod.default;
          // look 钉 classic:v12 默认 neo 给节点画挤出式重影边(用户视为边框 bug)
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', look: 'classic', themeVariables: { ...MERMAID_VARS[currentTheme()] } });
          const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('mermaid timeout')), RENDER_TIMEOUT_MS));
          const r = (await Promise.race([mermaid.render(idRef.current, repairMermaid(chart)), timeout])) as { svg: string };
          if (alive) {
            if (svgCache.size >= 200) svgCache.clear();
            svgCache.set(key, r.svg);
            lastGoodRef.current = { chart, svg: r.svg };
            setSvg(r.svg);
            setFailed(null);
            onStatus?.(true); // G14.122 渲染成败上抛(消费方按态收放放大钮)
          }
        } catch (e) {
          if (!alive) return;
          onStatus?.(false);
          // G14.2xx 流式静默:不稳定期间的失败不示错、不清图形——上一版图保留在屏,源码静默兜底;
          // 稳定(STABLE_MS 内 chart 未再变)后重试一次,仍败才落错误态(真非法图才示错)
          if (lastGoodRef.current !== null) {
            setSvg(lastGoodRef.current.svg); // 保留上一版图形在屏
            return;
          }
          setSvg(null);
          window.setTimeout(() => {
            if (!alive || abortedByStale) return;
            abortedByStale = true;
            void (async () => {
              try {
                const mod = await mermaidReady;
                if (mod === undefined) throw new Error('mermaid unavailable');
                const mermaid = mod.default;
                mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', look: 'classic', themeVariables: { ...MERMAID_VARS[currentTheme()] } });
                const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('mermaid timeout')), RENDER_TIMEOUT_MS));
                const r = (await Promise.race([mermaid.render(idRef.current, repairMermaid(chart)), timeout])) as { svg: string };
                if (alive) {
                  svgCache.set(key, r.svg);
                  setSvg(r.svg);
                  lastGoodRef.current = { chart, svg: r.svg };
                  setFailed(null);
                  onStatus?.(true);
                }
              } catch (e2) {
                if (alive) {
                  const raw = e2 instanceof Error ? e2.message : String(e2);
                  setFailed(raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || 'render failed');
                  onStatus?.(false);
                }
              }
            })();
          }, STABLE_MS);
        }
      })();
    }
    return () => {
      alive = false;
      window.clearTimeout(debounce);
    };
  }, [chart, themeTick, onStatus]);

  if (failed !== null) {
    return (
      <div className="mermaid-error" data-testid="mermaid-error">
        <div className="mermaid-error-msg">{failed}</div>
        <pre className="mermaid-fallback">{chart}</pre>
      </div>
    );
  }
  if (svg === null) return <pre className="mermaid-pending">{chart}</pre>;
  return <div className="mermaid-svg" data-testid="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />;
}
