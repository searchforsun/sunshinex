import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import type { Connection } from '../connection';

/**
 * 内置侧栏浏览器(2026-11-01 用户裁定 ABC 全做之三「内置浏览器」):直连插件 builtin 桥起的
 * Chromium CDP——Page.startScreencast 帧绘 canvas(实时镜像),鼠标/键盘经 Input.dispatch*
 * 回注(所见即所点,截图=browser_take_screenshot 同源画面);导航条 Page.navigate。
 * 端点发现:轮询 <dataDir>/plugins/browser-use/builtin-cdp.json(conn.appFile;桥写、插件档开启
 * builtin 才存在)→ {ws} → 浏览器 HTTP /json/list 取首个 page 目标 ws。断线自动重连(2s)。
 */
interface CdpPageConn {
  ws: WebSocket;
}

export function CdpBrowserTab({ conn, root }: { conn: Connection; root?: string }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pageWsRef = useRef<CdpPageConn | null>(null);
  const [status, setStatus] = useState<'waiting' | 'connecting' | 'live' | 'down'>('waiting');
  const [urlBar, setUrlBar] = useState('');
  const scaleRef = useRef({ sx: 1, sy: 1 });

  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      while (alive) {
        if (root === undefined) { await new Promise((r) => setTimeout(r, 2000)); continue; }
        // 1) 端点发现(尽力而为:meta 缺失=插件未开 builtin 档)
        let ws: string | undefined;
        try {
          const meta = await conn.appFile(root, 'plugins/browser-use/builtin-cdp.json');
          if (meta.type === 'file') {
            const parsed = JSON.parse(meta.content) as { ws?: string };
            if (typeof parsed.ws === 'string') ws = parsed.ws;
          }
        } catch { /* 未在跑 */ }
        if (!alive) return;
        if (ws === undefined) { setStatus('waiting'); await new Promise((r) => setTimeout(r, 2000)); continue; }
        // 2) page 目标(ws://host:port/... → http://host:port/json/list)
        try {
          const m = /^ws:\/\/([^/]+)\//.exec(ws);
          const base = m !== null ? `http://${m[1]}` : undefined;
          if (base === undefined) throw new Error('bad ws url');
          const targets = (await (await fetch(`${base}/json/list`)).json()) as Array<{ type?: string; webSocketDebuggerUrl?: string; url?: string }>;
          const page = targets.find((tg) => tg.type === 'page' && tg.webSocketDebuggerUrl !== undefined);
          if (page?.webSocketDebuggerUrl === undefined) throw new Error('no page target');
          if (!alive) return;
          setStatus('connecting');
          await attach(page.webSocketDebuggerUrl, page.url ?? '');
          // attach 常驻直至失败;失败后 2s 重走发现
          await new Promise<void>((resolve) => { pageWsRef.current !== null || resolve(); });
          await new Promise((r) => setTimeout(r, 2000));
        } catch { setStatus('down'); await new Promise((r) => setTimeout(r, 2000)); }
      }
    };
    const attach = (ep: string, initialUrl: string) =>
      new Promise<void>((resolve) => {
        setStatus('connecting');
        let seq = 1;
        const ws = new WebSocket(ep);
        const send = (method: string, params?: Record<string, unknown>): void => { ws.send(JSON.stringify({ id: seq++, method, params })); };
        const cleanup = (): void => { pageWsRef.current = null; if (alive) setStatus('down'); resolve(); };
        ws.onopen = () => {
          pageWsRef.current = { ws };
          setUrlBar(initialUrl);
          send('Page.enable');
          send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 });
          setStatus('live');
        };
        ws.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data)) as { method?: string; params?: Record<string, unknown> };
          if (msg.method === 'Page.screencastFrame' && canvasRef.current !== null) {
            const p = msg.params as { data: string; metadata: { pageSize: { width: number; height: number } }; sessionId: number };
            const img = new Image();
            img.onload = () => {
              const cv = canvasRef.current;
              if (cv === null) return;
              cv.width = p.metadata.pageSize.width;
              cv.height = p.metadata.pageSize.height;
              cv.getContext('2d')?.drawImage(img, 0, 0);
              scaleRef.current = { sx: p.metadata.pageSize.width / cv.clientWidth, sy: p.metadata.pageSize.height / cv.clientHeight };
            };
            img.src = `data:image/jpeg;base64,${p.data}`;
            send('Page.screencastFrameAck', { sessionId: p.sessionId });
          } else if (msg.method === 'Page.frameNavigated') {
            const u = (msg.params as { frame: { url?: string } }).frame.url;
            if (typeof u === 'string' && u !== 'about:blank') setUrlBar(u);
          }
        };
        ws.onclose = cleanup;
        ws.onerror = cleanup;
      });
    void tick();
    return () => {
      alive = false;
      if (retry !== undefined) clearTimeout(retry);
      pageWsRef.current?.ws.close();
      pageWsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, root]);

  /** 事件坐标换算(css px → 页面 px)后 CDP 回注 */
  const dispatchMouse = (type: string, ev: React.MouseEvent<HTMLCanvasElement>): void => {
    const w = pageWsRef.current;
    if (w === null) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const { sx, sy } = scaleRef.current;
    w.ws.send(JSON.stringify({ id: 0, method: `Input.dispatch${type === 'wheel' ? 'MouseEvent' : 'MouseEvent'}`, params: { type, x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy, button: ev.button === 2 ? 'right' : 'left', clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : undefined, deltaY: type === 'wheel' ? (ev as unknown as { deltaY: number }).deltaY : undefined } }));
  };
  const navigate = (raw: string): void => {
    const w = pageWsRef.current;
    if (w === null) return;
    const url = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
    w.ws.send(JSON.stringify({ id: 0, method: 'Page.navigate', params: { url } }));
  };

  return (
    <div className="sx-cdp-browser" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 6, padding: '4px 8px', alignItems: 'center', flex: 'none' }}>
        <span style={{ fontSize: 11, color: 'var(--fg-secondary)', flex: 'none' }}>{status === 'live' ? t('Live', '实时') : status === 'waiting' ? t('Waiting for builtin browser (enable builtin in 浏览器操作 plugin)', '等待内置浏览器(浏览器操作插件勾选 builtin)') : status === 'connecting' ? t('Connecting…', '连接中…') : t('Reconnecting…', '重连中…')}</span>
        <input
          value={urlBar}
          placeholder={t('Navigate…', '输入网址…')}
          onChange={(e) => setUrlBar(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') navigate(urlBar); }}
          style={{ flex: 1, minWidth: 0, background: 'var(--surface-soft)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '2px 8px', font: '12px var(--font-mono)' }}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--surface-code)', textAlign: 'center' }}>
        <canvas
          ref={canvasRef}
          style={{ maxWidth: '100%', display: 'inline-block', cursor: 'default' }}
          onMouseDown={(e) => dispatchMouse('mousePressed', e)}
          onMouseUp={(e) => dispatchMouse('mouseReleased', e)}
          onMouseMove={(e) => { if (e.buttons > 0) dispatchMouse('mouseMoved', e); }}
          onWheel={(e) => dispatchMouse('mouseWheel', e as unknown as React.MouseEvent<HTMLCanvasElement>)}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
    </div>
  );
}
