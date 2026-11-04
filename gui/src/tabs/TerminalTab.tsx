import '@xterm/xterm/css/xterm.css';
import { terminalFontSpec } from '../font-preset';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { PtySocket } from './PtySocket';
import { b64ToUtf8 } from './pty-codec';
import type { PtyFrame } from './pty-codec';
import { toWsUrl } from '../connection';
import type { Connection } from '../connection';
import { t } from '../i18n';
import type { TabParams } from './tab-state';

/**
 * G8b 终端标签体(T6 + 裁定修复):xterm ↔ pty 专用 WS 的会话内装配。mount 序:ptyIdFor
 * (uid) 记账命中 → **重挂重连**既有 pty(server 侧 close≠kill 存活,replay 帧环形缓冲恢复
 * 屏幕——切标签往返不换壳,spec U-D5「等同本地」底线);未命中 → openPty(sessionId,
 * 80, 24) → onPtyAllocated(uid, ptyId)(App 侧 ptyIdsRef 记账——关标签链 kill 的寻址键)
 * → jsdom 守卫(容器 clientWidth/Height=0 → 降级面,xterm 需真盒子量尺寸;真浏览器走
 * xterm)→ Terminal+FitAddon+PtySocket 装配。帧面:replay/data → term.write(b64→utf8);
 * exit → 退出提示写入 term + 退出态条;error → 行内错误条;WS closed(server 侧关且非卸载
 * dispose 致关,且非 exit 后正常收尾关——G8e 终审 C 抑制:横幅词不实,重连也必 404)→ term
 * 灰字断连提示一行·一次性(G8e-T2;重连=切标签往返 replay 恢复;jsdom 降级守卫互斥无测试面,
 * e2e/人审盖)。输入 term.onData → sendInput;
 * 尺寸 fit 后 socket.resize(term.cols, term.rows),ResizeObserver 随容器续跟。
 * 卸载 socket.dispose()+term.dispose() **不 kill**——pty 生命周期属标签不属渲染(App 关
 * 标签链单点 kill);重挂经 ptyIdFor 复用同一 pty。
 * pty WS 的 ws url 以 location.origin 换前缀构造——connection.ts 的 wsUrl 是 /events 专用
 * 模块私 helper 不通用;vite dev 的 VITE_SERVE_URL 异源直连场景归 G8b-e 记档承接。
 * token 取 localStorage 'sunshinex.token'(App 门面全路径持久化——URL/门面/既有,故
 * AppShell 在场必在;键字面与 App.TOKEN_STORAGE_KEY 同源,G8b-e 收口为共享常量)。
 */

export interface TerminalTabProps {
  readonly conn: Connection;
  /** 当前会话(:id 寻址维) */
  readonly sessionId: string;
  /** 标签参数(nonce 已被 registry 判重消费;cols/rows 为备用面——起步固定 80×24,fit 后校正) */
  readonly params: TabParams;
  /** 标签实例 uid(App 注入——pty 记账键) */
  readonly uid: string;
  /** pty 记账读取(App ptyIdsRef):命中 = 该标签 pty 存活未 kill——跳过 openPty 直连同
   *  ptyId 重连(replay 恢复屏幕);未命中 = 首挂,分配新 pty */
  readonly ptyIdFor: (uid: string) => string | undefined;
  /** pty 分配落定回传(App ptyIdsRef 记账;关标签 → killPty) */
  readonly onPtyAllocated: (uid: string, ptyId: string) => void;
  /** 2026-10-27 欢迎页全局草稿:draft=true = 不绑会话——分配走 /app/pty(root 直供 cwd),
   *  WS 寻址会话段用 '@welcome' 占位(serve 帧中继只按 ptyId 寻址,段不校验) */
  readonly draft?: boolean;
  readonly draftRoot?: string;
  /** 选区工具条·辅助会话(2026-11-03 用户裁定「终端选中后也能添加到会话/辅助会话」):缺省不渲染该动作 */
  readonly onSideAsk?: (text: string) => void;
}

/** xterm 主题:取 app.css 设计令牌字面值(G8a spec §3;G8d U-D21 青色重定——CSS 变量无法跨
 *  canvas 令牌面直引,sx- 伴生类与变量桥归 G8b-e)——bg=--bg-0 #0d1117 / fg=--fg-0 #e6edf3 /
 *  cursor=--accent #22d3ee / selection=--accent 25% 半透 rgba(34,211,238,0.25) */
const XTERM_THEME = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#22d3ee',
  selectionBackground: 'rgba(34, 211, 238, 0.25)',
} as const;

export function TerminalTab({ conn, sessionId, uid, params, ptyIdFor, onPtyAllocated, draft = false, draftRoot = '', onSideAsk }: TerminalTabProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  /** jsdom 守卫落定面:无布局 → 降级(降级时 pty 已分配记账,关标签链照常 kill) */
  const [fallback, setFallback] = useState(false);
  /** pty WS error 帧 / openPty HTTP 失败的行内错误条 */
  const [socketError, setSocketError] = useState<string | null>(null);
  /** exit 帧 code(退出态条;term 内另有换行提示) */
  const [exitCode, setExitCode] = useState<number | null>(null);
  /** 选区悬浮工具条(2026-11-03 用户裁定「终端选中后添加到会话/辅助会话」):xterm 选区非空即显,
   *  位置=mouseup 落点(相对容器);双动作=原文入主对话 composer(事件同 Files 页)/辅助会话提问 */
  const [selBar, setSelBar] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    let socket: PtySocket | null = null;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let observer: ResizeObserver | null = null;
    /** 卸载后迟到应答守卫:openPty 慢应答不落 state/不记账(cancelled 后分配的 pty 无消费面,
     *  服务侧归 owner teardown——关标签竞态的既定让步,brief fire-and-forget 语义);兼作卸载
     *  判据——cleanup 先置位再 socket.dispose(),卸载致关的 closed 回放被吞(断连提示不误报) */
    let cancelled = false;
    /** 断连提示一次性标志(G8e-T2):closed 只写一次,防重复 */
    let disconnectShown = false;
    /** exit 帧已达标志(G8e 终审 C):exit 后 server 侧 close(1000) 属正常退出收尾——退出语义
     *  已写 code 行+态条,「连接已断开」横幅词不实(pty 已死,重连也必 404);closed 跳过 */
    let exited = false;
    /** 选区工具条附加监听卸载钩子(mouseup;重连回退轮换 term 时换挂) */
    const cleanupExtra = { current: (null as unknown as (() => void) | null) };

    /** fit 后同步 pty 尺寸(装配尾一次 + ResizeObserver 每回调) */
    const syncSize = (): void => {
      if (term === null || socket === null || fit === null) return;
      try {
        fit.fit();
      } catch {
        return; // 容器 0 尺寸/未布局时 xterm fit 抛错——跳过本次,观察器下回调再试
      }
      socket.resize(term.cols, term.rows);
    };

    void (async (): Promise<void> => {
      try {
        // ① pty 定址:记账命中 → 重挂重连既有 pty(close≠kill 存活,replay 恢复屏幕——切标签
        //    往返/重进会话不换壳);未命中 → 盘档 params.ptyId(G14.2xx 分配即落参数,随 gui-state
        //    持久化)——浏览器刷新后凭档直连旧 pty,replay 重建屏幕;皆无 → 首挂分配+记账。
        //    盘档 ptyId 已死(daemon 重启/超时收尸)→ error 帧+close 且零数据帧 → 一次性回退新开
        let ptyId = ptyIdFor(uid) ?? params.ptyId;
        let reused = ptyId !== undefined; // 盘档/记账直连面:死档需回退
        for (;;) {
          if (cancelled) return;
          if (ptyId === undefined) {
            const allocated = draft ? await conn.openPtyAt(draftRoot, 80, 24) : await conn.openPty(sessionId, 80, 24);
            if (cancelled) return;
            ptyId = allocated.ptyId;
            onPtyAllocated(uid, ptyId);
            reused = false;
          }
          // ② jsdom 守卫:降级面(App.test 断言面;真浏览器 clientWidth>0 走 xterm)
          const container = containerRef.current;
          if (container === null || container.clientWidth === 0 || container.clientHeight === 0) {
            setFallback(true);
            return;
          }
          // ③ xterm + FitAddon + pty WS 装配
          const fontSpec = terminalFontSpec(); // 字体预设管线(2026-10-29 用户裁定「终端可控也跟随」):family=--font-mono 生效值,size=--f-code——canvas 接 CSS 变量字符串不解析,经 computed 取实值
          term = new Terminal({ theme: XTERM_THEME, fontFamily: fontSpec.family, fontSize: fontSpec.size });
          fit = new FitAddon();
          term.loadAddon(fit);
          term.open(container);
          let sawFrame = false; // replay/data 任一到达 = pty 活着(回退判据)
          let dead = false; // error 帧+closed = 档键已死(回退触发)
          socket = new PtySocket({
            url: `${toWsUrl(location.origin)}/session/${encodeURIComponent(draft ? '@welcome' : sessionId)}/pty/${encodeURIComponent(ptyId)}`,
            token: localStorage.getItem('sunshinex.token') ?? '',
            onFrame: (f: PtyFrame): void => {
              if (f.t === 'replay' || f.t === 'data') {
                sawFrame = true;
                term?.write(b64ToUtf8(f.b));
              } else if (f.t === 'exit') {
                sawFrame = true;
                exited = true; // 后续 close(1000) 属退出收尾,非断连——横幅抑制
                term?.write(`\r\n[${t(`Process exited with code ${f.code}`, `进程已退出 code ${f.code}`)}]`);
                setExitCode(f.code);
              } else if (f.t === 'error') {
                // 2026-11-04 用户裁定「重启后连报错条都不闪」:盘档直连且零数据帧=死档,静默回退
                // (error 条不亮);有回放=会话曾活,错误属运行期,照常显示
                if (reused && !sawFrame) dead = true;
                else setSocketError(f.message);
              }
            },
            // 状态面(G8e-T2 断连提示):server 侧关(error 后 close(1008)/掉线)且非卸载 dispose
            //  致关 → term 写一行灰色提示,一次性(disconnectShown 防重复)。cancelled 兼卸载判据:
            //  cleanup 先置位再 dispose,卸载致关的 closed 回放静默。exited:exit 后 close(1000) 属
            //  正常退出收尾,横幅词不实(重连也必 404)——跳过。重连语义既有——切标签往返即重挂
            //  重连(replay 恢复屏幕),提示语引导。jsdom 降级守卫互斥(xterm 路径无 jsdom 测试面),
            //  本分支归 e2e/人审盖
            onState: (s) => {
              if (s !== 'closed' || cancelled || exited) {
                if (reused && s === 'closed' && !cancelled) dead = true; // 复用面 close 即死档信号
                return;
              }
              if (disconnectShown || term === null) return;
              disconnectShown = true;
              term.write(`\r\n\x1b[90m[${t('Disconnected — reconnect to restore', '连接已断开——重连将恢复')}]\x1b[0m`);
            },
          });
          term.onData((d) => socket?.sendInput(d));
          // 选区工具条(2026-11-03):选区清空即隐;mouseup 落点定条位(容器相对坐标,钳制到容器内)
          const onMouseUp = (e: MouseEvent): void => {
            const sel = term?.getSelection() ?? '';
            if (sel.trim() === '') return;
            const rect = container.getBoundingClientRect();
            setSelBar({ x: e.clientX - rect.left, y: e.clientY - rect.top, text: sel.trim() });
          };
          container.addEventListener('mouseup', onMouseUp);
          term.onSelectionChange(() => {
            if ((term?.getSelection() ?? '').trim() === '') setSelBar(null);
          });
          const offMouseUp = (): void => container.removeEventListener('mouseup', onMouseUp);
          cleanupExtra.current = offMouseUp;
          syncSize();
          observer = new ResizeObserver(syncSize);
          observer.observe(container);
          if (!reused) return; // 首挂/记账重连:既有语义(断连提示一行,无回退面)
          // G14.2xx 复用面回退等待:死档(error/close 且零数据帧)→ 弃旧换新再来一轮;
          // 活档(replay 到达)或卸载 → 原地常驻。100ms 片轮询,卸载即出
          await new Promise<void>((r) => {
            const t = setInterval(() => {
              if (cancelled || dead || sawFrame || exited) {
                clearInterval(t);
                r();
              }
            }, 100);
          });
          if (cancelled || !dead || sawFrame || exited) return;
          setSocketError(null); // 回退新开=旧档报错已兑现(「pty not found」),新会话不应再背旧错条
          observer?.disconnect();
          socket?.dispose();
          term?.dispose();
          socket = null;
          term = null;
          observer = null;
          ptyId = undefined;
          // loop 继续:ptyId undefined → 走首挂分配(上轮) + onPtyAllocated 记账
        }
      } catch (err) {
        if (!cancelled) setSocketError(err instanceof Error ? err.message : String(err));
      }
    })();

    // 字体预设热更(2026-10-29 字体一致性面):预设切换重读 --font-mono/--f-code 热更选项,
    // canvas 度量随字变 → refit 重同步 pty 尺寸(不适配会错行)
    const onFontPreset = (): void => {
      if (term === null || fit === null) return;
      const spec = terminalFontSpec();
      term.options.fontFamily = spec.family;
      term.options.fontSize = spec.size;
      syncSize();
    };
    window.addEventListener('sunshinex:font-preset', onFontPreset);
    return () => {
      cancelled = true;
      window.removeEventListener('sunshinex:font-preset', onFontPreset);
      cleanupExtra.current?.();
      cleanupExtra.current = null;
      observer?.disconnect();
      socket?.dispose();
      term?.dispose(); // 不 killPty——kill 归 App 关标签链(pty 生命周期属标签不属渲染)
    };
    // ptyIdFor/onPtyAllocated 由 App useCallback 稳定注入(inline 箭头会令本 effect 随 App 重渲染重跑)
  }, [conn, sessionId, uid, ptyIdFor, onPtyAllocated]);

  if (fallback) return <div className="sx-pty-fallback">{t('Terminal rendering requires a real browser window', '终端渲染需要真浏览器窗口')}</div>;
  return (
    <div className="sx-pty" style={{ height: '100%' }}>
      {socketError !== null && <div className="sx-pty-error">{socketError}</div>}
      {exitCode !== null && <div className="sx-pty-exited">{t(`Process exited (code ${exitCode})`, `进程已退出(code ${exitCode})`)}</div>}
      {/* 高度链:.sx-tabbody(flex 定高)→ .sx-pty → 容器——sx-pty-* 样式归 G8b-e(app.css 冻结),
          FitAddon 量的是容器盒,须满高才可 fit */}
      <div ref={containerRef} className="sx-pty-term" style={{ height: '100%' }} />
      {selBar !== null && (
        <div
          className="files-selbar"
          style={{ position: 'absolute', top: Math.max(0, selBar.y - 34), left: Math.max(selBar.x - 40, 8) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            type="button"
            onClick={() => {
              // 2026-11-04 用户裁定:终端片段也走简标识芯片(⟦终端片段⟧),原文入账本发送期展开
              const token = '⟦终端片段⟧';
              window.dispatchEvent(new CustomEvent('sunshinex:insert-ref', { detail: { kind: 'ref', token, content: selBar.text } }));
              setSelBar(null);
            }}
          >
            {t('Add to current task', '添加到当前任务')}
          </button>
          {onSideAsk !== undefined && (
            <button
              type="button"
              onClick={() => {
                onSideAsk(selBar.text);
                setSelBar(null);
              }}
            >
              {t('Ask in side chat', '在辅助会话中提问')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
