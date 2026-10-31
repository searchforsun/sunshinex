import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import type { Connection } from '../connection';

/**
 * Web 页签 CDP 形态(2026-11-01 用户裁定「浏览器改成 cdp 形式,去掉多余的内置浏览器」):插件
 * builtin 档在跑时,builtin-cdp.json(meta 由桥写,<dataDir>/plugins/browser-use/)在场即接管
 * 「浏览器」页签——Page.startScreencast 帧绘 canvas 实时镜像 + Input 鼠标回注 + Page.navigate,
 * 工具栏仍走 WebTab 原样式(后退/前进/刷新/地址条全部 CDP 化)。meta 不在场=普通 iframe 形态。
 * 端点发现经 /app/file scope=data(数据目录解析);断线自动重连(2s)。
 */

export interface CdpPage {
  /** idle=插件 builtin 未跑(回落 iframe);connecting/live/down=CDP 形态各态 */
  status: 'idle' | 'connecting' | 'live' | 'down';
  /** 导航(CDP Page.navigate;live 才生效) */
  navigate: (raw: string) => void;
  /** 刷新(CDP Page.reload) */
  reload: () => void;
  /** 当前页 URL(frameNavigated 随动) */
  url: string;
  /** 画布 ref(视图挂接) */
  canvasRef: React.RefObject<HTMLCanvasElement>;
  onMouse: (type: string, ev: React.MouseEvent<HTMLCanvasElement>) => void;
  /** 页面缩放(Emulation.setPageScaleFactor,内置浏览器原生能力):1=100% */
  zoom: number;
  setZoom: (f: number) => void;
  /** 视口尺寸(Emulation.setDeviceMetricsOverride——自由尺寸 W×H 下发到内置浏览器本体;
   *  null=清除覆盖回落默认视口) */
  setViewport: (w: number | null, h?: number) => void;
}

export function useCdpBuiltinPage(conn: Connection | null, root: string | undefined): CdpPage {
  const [status, setStatus] = useState<CdpPage['status']>('idle');
  const [url, setUrl] = useState('');
  const [zoomState, setZoomState] = useState(1);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scaleRef = useRef({ sx: 1, sy: 1 });
  const sendRef = useRef<((method: string, params?: Record<string, unknown>) => void) | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      while (alive) {
        if (root === undefined || conn === null) { await new Promise((r) => setTimeout(r, 2000)); continue; }
        let ws: string | undefined;
        try {
          const meta = await conn.appFile(root, 'plugins/browser-use/builtin-cdp.json', 'data');
          if (meta.type === 'file') {
            const parsed = JSON.parse(meta.content) as { ws?: string };
            if (typeof parsed.ws === 'string') ws = parsed.ws;
          }
        } catch { /* 未在跑 */ }
        if (!alive) return;
        if (ws === undefined) { setStatus('idle'); await new Promise((r) => setTimeout(r, 2000)); continue; }
        try {
          // 端点发现走 daemon 代理(渲染层直连 DevTools HTTP 面被 CORS 拦)
          const targets = await conn.cdpTargets(root);
          const page = (targets as Array<{ type?: string; webSocketDebuggerUrl?: string; url?: string }>).find((tg) => tg.type === 'page' && tg.webSocketDebuggerUrl !== undefined);
          if (page?.webSocketDebuggerUrl === undefined) throw new Error('no page target');
          if (!alive) return;
          await new Promise<void>((resolve) => {
            setStatus('connecting');
            let seq = 1;
            const sock = new WebSocket(page.webSocketDebuggerUrl!);
            const send = (method: string, params?: Record<string, unknown>): void => { sock.send(JSON.stringify({ id: seq++, method, params })); };
            sendRef.current = send;
            const cleanup = (): void => { sendRef.current = null; if (alive) setStatus('down'); resolve(); };
            sock.onopen = () => {
              setStatus('live');
              send('Page.enable');
              send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 });
            };
            sock.onmessage = (ev) => {
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
                  scaleRef.current = { sx: p.metadata.pageSize.width / Math.max(1, cv.clientWidth), sy: p.metadata.pageSize.height / Math.max(1, cv.clientHeight) };
                };
                img.src = `data:image/jpeg;base64,${p.data}`;
                send('Page.screencastFrameAck', { sessionId: p.sessionId });
              } else if (msg.method === 'Page.frameNavigated') {
                const u = (msg.params as { frame: { url?: string } }).frame.url;
                if (typeof u === 'string' && u !== 'about:blank') setUrl(u);
              }
            };
            sock.onclose = cleanup;
            sock.onerror = cleanup;
          });
          await new Promise((r) => setTimeout(r, 2000));
        } catch { if (alive) setStatus('down'); await new Promise((r) => setTimeout(r, 2000)); }
      }
    };
    void tick();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, root]);

  const zoomRef = useRef(1);
  const setZoom = (f: number): void => {
    const z = Math.min(3, Math.max(0.25, Math.round(f * 100) / 100));
    zoomRef.current = z;
    setZoomState(z);
    sendRef.current?.('Emulation.setPageScaleFactor', { pageScaleFactor: z });
  };
  return {
    status,
    url,
    zoom: zoomState,
    setZoom,
    canvasRef,
    navigate: (raw: string) => {
      const nav = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
      setUrl(nav);
      sendRef.current?.('Page.navigate', { url: nav });
    },
    reload: () => sendRef.current?.('Page.reload'),
    setViewport: (w: number | null, h?: number) => {
      if (w === null) sendRef.current?.('Emulation.clearDeviceMetricsOverride');
      else sendRef.current?.('Emulation.setDeviceMetricsOverride', { width: Math.round(w), height: Math.round(h ?? Math.round(w * 0.5625)), deviceScaleFactor: 0, mobile: false });
    },
    onMouse: (type: string, ev: React.MouseEvent<HTMLCanvasElement>) => {
      const send = sendRef.current;
      if (send === null) return;
      const rect = ev.currentTarget.getBoundingClientRect();
      const { sx, sy } = scaleRef.current;
      send('Input.dispatchMouseEvent', {
        type,
        x: (ev.clientX - rect.left) * sx,
        y: (ev.clientY - rect.top) * sy,
        button: ev.button === 2 ? 'right' : 'left',
        ...(type === 'mousePressed' || type === 'mouseReleased' ? { clickCount: 1 } : {}),
        ...(type === 'mouseWheel' ? { deltaY: (ev as unknown as { deltaY: number }).deltaY } : {}),
      });
    },
  };
}

/** CDP 页面画布(镜像+点击回注;工具栏由 WebTab 原工具栏承载) */
export function CdpPageView({ cdp }: { cdp: CdpPage }): JSX.Element {
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--surface-code)', display: 'flex', alignItems: cdp.status === 'live' ? 'flex-start' : 'center', justifyContent: 'center' }}>
      {cdp.status === 'live' ? (
        <canvas
          ref={cdp.canvasRef}
          style={{ maxWidth: '100%', display: 'inline-block' }}
          onMouseDown={(e) => cdp.onMouse('mousePressed', e)}
          onMouseUp={(e) => cdp.onMouse('mouseReleased', e)}
          onMouseMove={(e) => { if (e.buttons > 0) cdp.onMouse('mouseMoved', e); }}
          onWheel={(e) => cdp.onMouse('mouseWheel', e as unknown as React.MouseEvent<HTMLCanvasElement>)}
          onContextMenu={(e) => e.preventDefault()}
        />
      ) : (
        <span style={{ color: 'var(--fg-secondary)', fontSize: 12 }} role="status">
          {cdp.status === 'connecting' ? t('Connecting…', '连接中…') : cdp.status === 'down' ? t('Reconnecting…', '重连中…') : ''}
        </span>
      )}
    </div>
  );
}
