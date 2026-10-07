import { encIn, encResize, decFrame } from './pty-codec';
import type { PtyFrame } from './pty-codec';

/**
 * G8b pty 裸 WS 客户端(事件化):daemon pty 专用 WS 的 gui 侧薄封装。鉴权走唯一子协议
 * `bearer.<token>`(浏览器 WebSocket 不能自定义请求头,与主事件 WS connection.ts 同款);
 * 收帧 decFrame → onFrame;状态机 connecting → open → closed 三态单向,无自动重连——
 * 重连=新实例(attach 即 replay 补窗,T3 语义),dispose 幂等,closed 后迟到事件/send 全静默。
 * url 由调用方传全(含 ws(s) 前缀转换与 /session/:id/pty/:ptyId 路径):connection.ts 的
 * wsUrl 是 /events 专用模块私 helper 不通用,http→ws 装配归上层(T6)。
 * wsFactory 缺省=真 WebSocket(addEventListener 适配 on(ev,cb) 面);注入桩=可测。
 */

export type PtySocketState = 'connecting' | 'open' | 'closed';

/** wsFactory 产出的最小 WS 形(send/close/on 三法——PtySocket 只消费这面) */
export interface PtySocketWs {
  send(s: string): void;
  close(): void;
  on(ev: string, cb: (arg?: unknown) => void): void;
}

export interface PtySocketOpts {
  url: string;
  token: string;
  onFrame(f: PtyFrame): void;
  onState(s: PtySocketState): void;
  wsFactory?: (url: string, protocol: string) => PtySocketWs;
}

/** 缺省工厂:真 WebSocket,唯一子协议 bearer.<token>;addEventListener 适配 on(ev,cb) */
function defaultWsFactory(url: string, protocol: string): PtySocketWs {
  const ws = new WebSocket(url, [protocol]);
  return {
    send: (s: string): void => {
      ws.send(s);
    },
    close: (): void => {
      ws.close();
    },
    on: (ev: string, cb: (arg?: unknown) => void): void => {
      ws.addEventListener(ev, (e: Event): void => cb(e));
    },
  };
}

/** message 事件载荷取 string data(MessageEvent.data;非 string 的二进制面 → null 吞) */
function dataOf(arg: unknown): string | null {
  if (typeof arg === 'object' && arg !== null && 'data' in arg) {
    const d = (arg as { data: unknown }).data;
    if (typeof d === 'string') return d;
  }
  return null;
}

export class PtySocket {
  private readonly ws: PtySocketWs;
  private readonly emitFrame: (f: PtyFrame) => void;
  private readonly emitState: (s: PtySocketState) => void;
  private st: PtySocketState = 'connecting';

  constructor(opts: PtySocketOpts) {
    this.emitFrame = opts.onFrame;
    this.emitState = opts.onState;
    this.emitState('connecting'); // 初始态即报(连接层惯例:消费者免另查 state)
    this.ws = (opts.wsFactory ?? defaultWsFactory)(opts.url, `bearer.${opts.token}`);

    this.ws.on('open', () => {
      if (this.st !== 'connecting') return; // dispose 后迟到 open 忽略
      this.st = 'open';
      this.emitState('open');
    });
    this.ws.on('message', (arg?: unknown) => {
      if (this.st !== 'open') return; // 未建立/已关不投帧
      const raw = dataOf(arg);
      if (raw === null) return;
      const f = decFrame(raw);
      if (f === null) return; // 坏帧吞(协议外/半截 JSON——含 T3 未知 ptyId 的 error 面之前的脏数据)
      this.emitFrame(f);
    });
    this.ws.on('close', () => {
      if (this.st === 'closed') return; // dispose 已收口,不再回放
      this.st = 'closed';
      this.emitState('closed'); // server 侧关(exit 后 close(1000)/error 后 close(1008)/掉线)
    });
  }

  get state(): PtySocketState {
    return this.st;
  }

  /** 输入下发:非 open 态静默丢(连接前/关闭后调用无炸) */
  sendInput(data: string): void {
    if (this.st !== 'open') return;
    this.ws.send(encIn(data));
  }

  /** 尺寸下发:同 sendInput 守卫 */
  resize(cols: number, rows: number): void {
    if (this.st !== 'open') return;
    this.ws.send(encResize(cols, rows));
  }

  /** 显式关(幂等):先置 closed 再 close 底层——迟到 close 事件被态守卫吞,onState 恰一次 */
  dispose(): void {
    if (this.st === 'closed') return;
    this.st = 'closed';
    this.ws.close();
    this.emitState('closed');
  }
}
