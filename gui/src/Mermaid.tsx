import { useEffect, useRef, useState } from 'react';

/**
 * Mermaid 图渲染(G10-C3c):懒加载 mermaid(代码分包,首块 mermaid 代码出现才拉);
 * 主题随 html[data-theme];渲染失败/超时回落原文代码块(会话流零阻塞,spec §10 降级纪律)。
 */
export function Mermaid({ chart }: { chart: string }): JSX.Element {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const idRef = useRef(`mmd-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    let alive = true;
    const theme = document.documentElement.dataset.theme === 'light' ? 'default' : 'dark';
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme });
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
  }, [chart]);

  if (failed) return <pre className="mermaid-fallback">{chart}</pre>;
  if (svg === null) return <pre className="mermaid-pending">{chart}</pre>;
  return <div className="mermaid-svg" data-testid="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />;
}
