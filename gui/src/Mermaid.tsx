import { useEffect, useRef, useState } from 'react';

/**
 * Mermaid 图渲染(G10-C3c):懒加载 mermaid(代码分包,首块 mermaid 代码出现才拉);
 * 主题随 html[data-theme](MutationObserver 监听,切换即重渲);渲染失败/超时回落原文代码块
 * (会话流零阻塞,spec §10 降级纪律)。
 * G13 批次1:base 主题 + 主题变量取 app.css 令牌同值——dark 下不再出现 mermaid 默认亮底节点
 * (节点面=--surface-elevated/文字=--fg/连线=fg 50%),与流区底色同源。
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

function currentTheme(): keyof typeof MERMAID_VARS {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function Mermaid({ chart }: { chart: string }): JSX.Element {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const idRef = useRef(`mmd-${Math.random().toString(36).slice(2)}`);
  /** 主题切换触发器:data-theme 属性变化即重渲(否则图停留在旧配色直到 chart 变更) */
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    const obs = new MutationObserver(() => setThemeTick((v) => v + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: { ...MERMAID_VARS[currentTheme()] } });
        const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('mermaid timeout')), 5_000));
        const r = (await Promise.race([mermaid.render(idRef.current, chart), timeout])) as { svg: string };
        if (alive) setSvg(r.svg);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [chart, themeTick]);

  if (failed) return <pre className="mermaid-fallback">{chart}</pre>;
  if (svg === null) return <pre className="mermaid-pending">{chart}</pre>;
  return <div className="mermaid-svg" data-testid="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />;
}
