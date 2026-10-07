import { describe, it, expect, beforeEach } from 'vitest';
import { encIn, encResize, decFrame, b64ToUtf8 } from './pty-codec';
import type { PtyFrame } from './pty-codec';
import { PtySocket } from './PtySocket';
import type { PtySocketState } from './PtySocket';

/**
 * G8b pty 客户端层桩测(T5):codec 纯测(UTF-8 中文/ANSI 转义回环 + enc 形状逐字断言 +
 * decFrame 四型/坏帧 null)+ PtySocket 状态机(wsFactory 注入 WsStub 驱动:
 * 构造即连/open→onState/帧→onFrame/坏帧吞/sendInput·resize 走 send/dispose 幂等)。
 * 真 WS 全链(subprotocol 鉴权/replay 重放)在 e2e 面走真 daemon,此处只测客户端纯逻辑。
 */

/** wsFactory 注入面最小桩:记录 url/protocol/send/close;测试驱动 openNow/recv/lose */
class WsStub {
  static instances: WsStub[] = [];
  readonly url: string;
  readonly protocol: string;
  readonly sent: string[] = [];
  closeCalls = 0;
  private readonly handlers = new Map<string, Array<(arg?: unknown) => void>>();
  constructor(url: string, protocol: string) {
    this.url = url;
    this.protocol = protocol;
    WsStub.instances.push(this);
  }
  send(s: string): void {
    this.sent.push(s);
  }
  close(): void {
    this.closeCalls++;
  }
  on(ev: string, cb: (arg?: unknown) => void): void {
    const list = this.handlers.get(ev);
    if (list === undefined) this.handlers.set(ev, [cb]);
    else list.push(cb);
  }
  private emit(ev: string, arg?: unknown): void {
    for (const cb of this.handlers.get(ev) ?? []) cb(arg);
  }
  openNow(): void {
    this.emit('open');
  }
  recv(raw: string): void {
    this.emit('message', { data: raw });
  }
  lose(): void {
    this.emit('close');
  }
}

const last = (): WsStub => WsStub.instances.at(-1)!;

interface Rig {
  sock: PtySocket;
  frames: PtyFrame[];
  states: PtySocketState[];
}
const URL = 'ws://127.0.0.1:7788/session/s1/pty/p-1';

/** 标准试件:桩工厂 + 帧态双录 */
function makeSocket(url = URL, token = 'tok-1'): Rig {
  const frames: PtyFrame[] = [];
  const states: PtySocketState[] = [];
  const sock = new PtySocket({
    url,
    token,
    onFrame: (f) => frames.push(f),
    onState: (s) => states.push(s),
    wsFactory: (u, p) => new WsStub(u, p),
  });
  return { sock, frames, states };
}

describe('pty-codec 纯函数(UTF-8 安全 base64 + 帧形状)', () => {
  it('encIn ASCII:形状逐字断言(键序 t,b)+ b64 已知向量 + 回环', () => {
    expect(encIn('hi')).toBe('{"t":"in","b":"aGk="}');
    expect(encIn('hello')).toBe('{"t":"in","b":"aGVsbG8="}');
    const f = JSON.parse(encIn('hello')) as { t: string; b: string };
    expect(f.t).toBe('in');
    expect(b64ToUtf8(f.b)).toBe('hello');
  });

  it('encIn 中文:UTF-8 多字节 b64 已知向量(5Lit5paH=「中文」)+ 回环——btoa 直吃必抛的面', () => {
    expect(JSON.parse(encIn('中文'))).toEqual({ t: 'in', b: '5Lit5paH' });
    expect(b64ToUtf8('5Lit5paH')).toBe('中文');
    const s = '中文终端·≈¥€';
    expect(b64ToUtf8((JSON.parse(encIn(s)) as { b: string }).b)).toBe(s);
  });

  it('encIn ANSI 转义序列回环:控制码与多字节共存(xterm 着色/清屏帧)', () => {
    const s = '\x1b[31m红字\x1b[0m\r\n\x1b[2J$ ';
    expect(b64ToUtf8((JSON.parse(encIn(s)) as { b: string }).b)).toBe(s);
  });

  it('encResize:形状逐字断言 {"t":"resize","cols":N,"rows":N}', () => {
    expect(encResize(120, 30)).toBe('{"t":"resize","cols":120,"rows":30}');
    expect(encResize(80, 24)).toBe('{"t":"resize","cols":80,"rows":24}');
  });

  it('decFrame 四型:replay/data(b)/exit(code)/error(message)', () => {
    expect(decFrame('{"t":"replay","b":"aGk="}')).toEqual({ t: 'replay', b: 'aGk=' });
    expect(decFrame('{"t":"data","b":"5Lit5paH"}')).toEqual({ t: 'data', b: '5Lit5paH' });
    expect(decFrame('{"t":"exit","code":0}')).toEqual({ t: 'exit', code: 0 });
    expect(decFrame('{"t":"error","message":"pty not found"}')).toEqual({ t: 'error', message: 'pty not found' });
    // 多余字段容忍(daemon 加字段不破 gui):只取所需面
    expect(decFrame('{"t":"data","b":"aGk=","x":1}')).toEqual({ t: 'data', b: 'aGk=' });
  });

  it('decFrame 坏面全 null:坏 JSON/非对象/未知 t/必填缺场或类型不符', () => {
    expect(decFrame('not json')).toBeNull();
    expect(decFrame('{"t":')).toBeNull();
    expect(decFrame('null')).toBeNull();
    expect(decFrame('42')).toBeNull();
    expect(decFrame('"data"')).toBeNull();
    expect(decFrame('[]')).toBeNull();
    // 未知 t(含 C→S 专属的 in/resize——S→C 面不合法)
    expect(decFrame('{"t":"in","b":"aGk="}')).toBeNull();
    expect(decFrame('{"t":"resize","cols":1,"rows":2}')).toBeNull();
    expect(decFrame('{"t":"unknown"}')).toBeNull();
    expect(decFrame('{}')).toBeNull();
    // 必填字段缺场/类型不符
    expect(decFrame('{"t":"data"}')).toBeNull();
    expect(decFrame('{"t":"data","b":123}')).toBeNull();
    expect(decFrame('{"t":"exit"}')).toBeNull();
    expect(decFrame('{"t":"exit","code":"0"}')).toBeNull();
    expect(decFrame('{"t":"error"}')).toBeNull();
    expect(decFrame('{"t":"error","message":42}')).toBeNull();
  });
});

describe('PtySocket 状态机(wsFactory 桩:三态单向 + 帧泵 + dispose 幂等)', () => {
  beforeEach(() => {
    WsStub.instances = [];
  });

  it('构造即连:wsFactory(url, "bearer.<token>") 单协议;初始态 connecting 即报', () => {
    const { sock, states } = makeSocket(URL, 'tok-9');
    const ws = last();
    expect(ws.url).toBe(URL);
    expect(ws.protocol).toBe('bearer.tok-9');
    expect(sock.state).toBe('connecting');
    expect(states).toEqual(['connecting']);
  });

  it('open 事件 → onState("open");S→C 四型帧 → onFrame 对应型;坏帧吞(不炸不投)', () => {
    const { sock, frames, states } = makeSocket();
    last().openNow();
    expect(sock.state).toBe('open');
    expect(states).toEqual(['connecting', 'open']);
    const ws = last();
    ws.recv('{"t":"replay","b":"aGk="}');
    ws.recv('{"t":"data","b":"5Lit5paH"}');
    ws.recv('{"t":"exit","code":127}');
    ws.recv('{"t":"error","message":"pty not found"}');
    expect(frames).toEqual([
      { t: 'replay', b: 'aGk=' },
      { t: 'data', b: '5Lit5paH' },
      { t: 'exit', code: 127 },
      { t: 'error', message: 'pty not found' },
    ]);
    const n = frames.length;
    ws.recv('garbage');
    ws.recv('{"t":"in","b":"aGk="}');
    ws.recv('null');
    expect(frames.length).toBe(n);
    expect(sock.state).toBe('open');
  });

  it('sendInput/resize 走 send:encIn 字串逐字(中文含多字节)/encResize 字串逐字', () => {
    const { sock } = makeSocket();
    const ws = last();
    sock.sendInput('before-open'); // 未 open 静默丢
    expect(ws.sent).toEqual([]);
    ws.openNow();
    sock.sendInput('中文');
    sock.resize(120, 30);
    expect(ws.sent).toEqual([encIn('中文'), '{"t":"resize","cols":120,"rows":30}']);
    expect(JSON.parse(ws.sent[0])).toEqual({ t: 'in', b: '5Lit5paH' });
  });

  it('dispose:close 调用 + onState("closed") 恰一次 + 二调幂等无炸', () => {
    const { sock, states } = makeSocket();
    const ws = last();
    ws.openNow();
    sock.dispose();
    expect(ws.closeCalls).toBe(1);
    expect(sock.state).toBe('closed');
    expect(states).toEqual(['connecting', 'open', 'closed']);
    sock.dispose(); // 幂等:不再 close、不再回放 onState
    expect(ws.closeCalls).toBe(1);
    expect(states).toEqual(['connecting', 'open', 'closed']);
    sock.sendInput('x'); // closed 后 send 静默丢
    sock.resize(80, 24);
    expect(ws.sent).toEqual([]);
  });

  it('dispose 后迟到 open/close 事件忽略:态不回退、onState 不再触发', () => {
    const { sock, states } = makeSocket();
    const ws = last();
    sock.dispose(); // connecting 面直接关
    expect(states).toEqual(['connecting', 'closed']);
    ws.openNow(); // 迟到 open(真 WS 不发生,守卫面)
    expect(sock.state).toBe('closed');
    ws.lose(); // dispose 已 close,迟到事件回放
    expect(states).toEqual(['connecting', 'closed']);
  });

  it('server 侧 close:onState("closed");其后迟到帧吞、send 静默', () => {
    const { sock, frames, states } = makeSocket();
    const ws = last();
    ws.openNow();
    ws.recv('{"t":"data","b":"aGk="}');
    ws.lose(); // exit/error 后 server close(1008/1000)同路径
    expect(sock.state).toBe('closed');
    expect(states).toEqual(['connecting', 'open', 'closed']);
    ws.recv('{"t":"data","b":"aGk="}');
    expect(frames).toEqual([{ t: 'data', b: 'aGk=' }]);
    sock.sendInput('late');
    expect(ws.sent).toEqual([]);
  });
});
