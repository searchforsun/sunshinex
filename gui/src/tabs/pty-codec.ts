/**
 * G8b pty 帧编解码(纯函数,零依赖)——daemon pty 专用 WS(T3)线上协议的 gui 侧收发:
 * C→S `{"t":"in","b":base64}` / `{"t":"resize","cols":N,"rows":N}`
 * S→C `{"t":"replay"|"data","b"}` / `{"t":"exit","code"}` / `{"t":"error","message"}`
 * base64 必须走 TextEncoder/Decoder + btoa/atob 组合:btoa 直吃字符串按 latin1 码元编码,
 * 中文等多字节 UTF-8 直接抛 InvalidCharacterError——故先编 UTF-8 字节再逐字节拼二进制串
 * 喂 btoa;解码反向镜像。T3 增补语义:未知 ptyId 的 error 帧 + close 由 PtySocket 状态面
 * 承接,本层只管字面编解码。
 */

/** UTF-8 安全 base64 编码向:string → TextEncoder 字节 → 逐字节二进制串 → btoa */
function utf8ToB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * UTF-8 安全 base64 解码向:atob 二进制串 → 字节 → TextDecoder 还 string。
 * 坏 b64 由 atob 原样抛(调用方吞);坏 UTF-8 字节 TextDecoder 替换为 U+FFFD 不炸。
 */
export function b64ToUtf8(b: string): string {
  const bin = atob(b);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** C→S 输入帧:{"t":"in","b":base64}——键序 t,b 定死(测试面逐字断言) */
export function encIn(data: string): string {
  return JSON.stringify({ t: 'in', b: utf8ToB64(data) });
}

/** C→S 尺寸帧:{"t":"resize","cols":N,"rows":N} */
export function encResize(cols: number, rows: number): string {
  return JSON.stringify({ t: 'resize', cols, rows });
}

/** S→C 帧判别联合:b 载荷保持 base64 原样(解 UTF-8 归上层 b64ToUtf8) */
export type PtyFrame =
  | { t: 'replay' | 'data'; b: string }
  | { t: 'exit'; code: number }
  | { t: 'error'; message: string };

/**
 * S→C 帧解析:坏 JSON/非对象/未知 t(含 C→S 专属的 in/resize)/必填字段缺场或类型不符
 * → null(调用方吞);多余字段容忍(daemon 加字段不破 gui)。
 */
export function decFrame(raw: string): PtyFrame | null {
  let f: unknown;
  try {
    f = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof f !== 'object' || f === null) return null;
  const o = f as { t?: unknown; b?: unknown; code?: unknown; message?: unknown };
  if (o.t === 'replay' || o.t === 'data') {
    return typeof o.b === 'string' ? { t: o.t, b: o.b } : null;
  }
  if (o.t === 'exit') return typeof o.code === 'number' ? { t: 'exit', code: o.code } : null;
  if (o.t === 'error') return typeof o.message === 'string' ? { t: 'error', message: o.message } : null;
  return null;
}
