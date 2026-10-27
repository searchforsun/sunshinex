import type { CallToolResult, ImageContent, TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { WorkerClient } from './types';
import { TOOLS } from './tools';
import { shrinkToEdge, toPhysical, type ScreenMeta } from './scale';

/** 工具分发单点：CallToolRequest → 执行 → MCP CallToolResult。
 *
 *  观察三件（screenshot/uia_snapshot/window_list）+ 动作八件（click/type/key/scroll/drag/wait/wait_for/app）。
 *  - screenshot：region [l,t,r,b]（物理像素）→ 换算 x/y/w/h 下发 worker；全域则不传几何（worker 侧
 *    VirtualScreen 自算）。sent 尺寸（长边 1568 收缩）由 shrinkToEdge 预算后随参数下发（region 路径），
 *    worker 按 sent 尺寸缩放输出并回传实际记账（orig w/h + sent sentW/sentH）——**缩放置账（spec §5.2）
 *    ：成功截图置 server 会话态 lastMeta**，动作工具经 toPhysical 反算模型坐标。
 *  - 动作工具坐标反算单点：模型坐标（sent 空间）→ toPhysical 按 scale 反算 + originX/originY 区域偏移
 *    （region 截图非全屏原点形态，Task 19 钉死）→ 物理像素下发 worker；无 lastMeta 时 click/type/scroll/
 *    drag 一律拒绝并引导先 screenshot（动作环纪律：先见屏后动作）；key/wait/wait_for/app 无坐标不反算。
 *  - worker 级失败单点转 isError：worker.op reject（WorkerError——PS ok:false 回执/进程退出/close 后调用）
 *    在 dispatchTool 兜底捕获转 CallToolResult(isError:true)，不直穿成 JSON-RPC protocol error。
 *  worker 依赖注入（WorkerClient 接缝）——测试以 fake worker 驱动本函数全分支，不触真进程。 */

/** JPEG 压缩质量（0.85 → 8 进制无涉，PS 侧 EncoderParameter 收 [long]）——镜像主仓 IMAGE_JPEG_QUALITY；
 *  导出供 scale.test 跨包镜像对拍钉消费（D55：改此值不与主仓同改即测红）。 */
export const JPEG_QUALITY = 85;

/** uia_snapshot 行文本上限（spec §5.2：交互元素优先的行数组截到 300）。 */
const UIA_MAX_LINES = 300;

/** 最近一次成功截图的记账元数据（server 会话态，dispatch 模块单点持有）：
 *  scale 为 orig↔sent 尺寸账（toPhysical 反算用）；origin 为截图区域左上角物理坐标（sent (0,0) 的物理
 *  对应点——region 截图非全屏原点时动作反算需加此偏移）；cursor/foreground 为 worker 采集的观察快照。 */
export interface ShotMeta {
  scale: ScreenMeta;
  originX: number;
  originY: number;
  cursor?: { x: number; y: number };
  foreground?: string;
}

let lastMeta: ShotMeta | null = null;

/** 读最近一次截图记账（动作工具消费；无成功截图时为 null——动作工具据此报错引导先截图）。 */
export function lastShotMeta(): ShotMeta | null {
  return lastMeta;
}

/** 清会话态记账（仅测试缝：dispatch 模块级单点，测试据此与文件内用例顺序无关化）。 */
export function resetLastShotMetaForTest(): void {
  lastMeta = null;
}

/** worker screenshot 回执形态（worker.ps1.ts Invoke-Screenshot 的 result；cursor/foreground PS 侧好取即取）。 */
interface ShotResult {
  b64: string;
  x: number;
  y: number;
  w: number;
  h: number;
  sentW: number;
  sentH: number;
  cursor?: { x: number; y: number };
  foreground?: string;
}

/** 截图：无 region → 全域（worker 只收 quality，物理几何与 sent 尺寸由 worker 侧 VirtualScreen 自算——
 *  Node 不预知虚拟屏）；有 region → [l,t,r,b] 物理像素换算 x/y/w/h + shrinkToEdge 预算 sent 尺寸下发。
 *  记账一律以 worker 回传的实际输出尺寸为准（sentW/sentH 回声），lastMeta 随之置账。 */
async function runScreenshot(worker: WorkerClient, args: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof args.display === 'number') {
    return { content: [{ type: 'text', text: 'not implemented: display selection (region covers all displays)' }], isError: true };
  }
  const region = args.region;
  let params: Record<string, unknown>;
  if (region === null || region === undefined) {
    params = { quality: JPEG_QUALITY };
  } else {
    // 有限数校验用 Number.isFinite（Task 19 评审随手修：NaN 之外 Infinity/-Infinity 一并拒）
    if (!Array.isArray(region) || region.length !== 4 || region.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      return { content: [{ type: 'text', text: 'invalid region: expected [left, top, right, bottom] in physical pixels' }], isError: true };
    }
    const [l, t, r, b] = region as number[];
    const x = Math.round(Math.min(l, r));
    const y = Math.round(Math.min(t, b));
    const w = Math.max(1, Math.round(Math.abs(r - l)));
    const h = Math.max(1, Math.round(Math.abs(b - t)));
    const sent = shrinkToEdge(w, h);
    params = { x, y, w, h, sentW: sent.width, sentH: sent.height, quality: JPEG_QUALITY };
  }
  const res = await worker.op<ShotResult>('screenshot', params);
  const scale: ScreenMeta = { origWidth: res.w, origHeight: res.h, sentWidth: res.sentW, sentHeight: res.sentH };
  lastMeta = { scale, originX: res.x, originY: res.y, cursor: res.cursor, foreground: res.foreground };
  const metaText = JSON.stringify({ scale, cursor: res.cursor, foreground: res.foreground });
  const content: (ImageContent | TextContent)[] = [
    { type: 'image', data: res.b64, mimeType: 'image/jpeg' },
    { type: 'text', text: metaText },
  ];
  return { content };
}

/** uia_snapshot：scope null → 缺省 window；worker 行数组拼行文本，超 300 行截断附说明。 */
async function runUiaSnapshot(worker: WorkerClient, args: Record<string, unknown>): Promise<CallToolResult> {
  const scope = args.scope === 'desktop' ? 'desktop' : 'window';
  const res = await worker.op<{ lines?: unknown }>('uia_snapshot', { scope });
  const lines = Array.isArray(res.lines) ? res.lines.map(String) : [];
  if (lines.length === 0) return { content: [{ type: 'text', text: '(no elements found)' }] };
  const kept = lines.slice(0, UIA_MAX_LINES);
  let text = kept.join('\n');
  if (lines.length > kept.length) text += `\n[truncated] showing ${kept.length} of ${lines.length} lines`;
  return { content: [{ type: 'text', text }] };
}

/** window_list：worker 行数组（标题/pid/z序）拼行文本。 */
async function runWindowList(worker: WorkerClient): Promise<CallToolResult> {
  const res = await worker.op<{ lines?: unknown }>('window_list', {});
  const lines = Array.isArray(res.lines) ? res.lines.map(String) : [];
  const text = lines.length > 0 ? lines.join('\n') : '(no top-level windows)';
  return { content: [{ type: 'text', text }] };
}

export async function dispatchTool(worker: WorkerClient, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  if (!TOOLS.some((t) => t.name === name)) {
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
  }
  try {
    return await runTool(worker, name, args);
  } catch (err) {
    // worker 级失败单点（Task 19 评审 Minor 随手修）：WorkerError（PS ok:false 回执/进程退出/close 后
    // 调用）与其余执行异常统一转 isError 文本回执（MCP 工具执行错误语义，模型可见可换策略）——
    // 不让 reject 直穿成 JSON-RPC protocol error（那会污染协议层且模型拿不到可读原因）。
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `tool execution failed: ${msg}` }], isError: true };
  }
}

/** 工具分派表（前置 unknown 校验后必中其一；default 不可达兜底）。 */
function runTool(worker: WorkerClient, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case 'screenshot':
      return runScreenshot(worker, args);
    case 'uia_snapshot':
      return runUiaSnapshot(worker, args);
    case 'window_list':
      return runWindowList(worker);
    case 'click':
      return runClick(worker, args);
    case 'type':
      return runType(worker, args);
    case 'key':
      return runKey(worker, args);
    case 'scroll':
      return runScroll(worker, args);
    case 'drag':
      return runDrag(worker, args);
    case 'wait':
      return runWait(worker, args);
    case 'wait_for':
      return runWaitFor(worker, args);
    case 'app':
      return runApp(worker, args);
    default:
      return Promise.resolve({ content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true });
  }
}

/* ===== 动作工具公共面（Task 20） ===== */

/** 模型坐标（sent 空间）→ 物理屏幕坐标单点：toPhysical 按 scale 反算后加 origin 偏移——region 截图
 *  非全屏原点时 sent(0,0) 对应物理 originX/originY（Task 19 钉的 ShotMeta 形态），缺此偏移必点错屏。 */
function remapToPhysical(meta: ShotMeta, x: number, y: number): { x: number; y: number } {
  const p = toPhysical(x, y, meta.scale);
  return { x: p.x + meta.originX, y: p.y + meta.originY };
}

/** 无 lastMeta 统一拒绝文案（click/type/scroll/drag 共用）：引导先 screenshot 再动作——错误文案
 *  必含 "screenshot"（brief 钉的引导循环）。 */
function noScreenshotError(): CallToolResult {
  return {
    content: [{
      type: 'text',
      text: 'no screenshot on record: call screenshot first, then act using pixel coordinates from that image (action coordinates are remapped from the LAST screenshot)',
    }],
    isError: true,
  };
}

/** 参数不合法统一回执（isError，不触 worker）。 */
function invalid(msg: string): CallToolResult {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

/** 数值整形单点（主仓 null 口径）：undefined/null/非有限数 → 缺省；否则原值。 */
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 必填数值：非有限数返回 null（调用侧转 invalid）。 */
function requireNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** [x,y] 二维点校验：数组/长度 2/两元素均有限数；不合法返回 null。 */
function point2(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const a = requireNum(v[0]);
  const b = requireNum(v[1]);
  return a === null || b === null ? null : [a, b];
}

/** 文本回执糖（worker result JSON 序列化——小对象，模型可读可核对）。 */
function jsonResult(res: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(res) }] };
}

/** click：坐标反算后下发（SetCursorPos+SendInput）；button null→left（其余非枚举值拒绝）、clicks null→1（钳 1..3）。 */
async function runClick(worker: WorkerClient, args: Record<string, unknown>): Promise<CallToolResult> {
  const meta = lastShotMeta();
  if (meta === null) return noScreenshotError();
  const x = requireNum(args.x);
  const y = requireNum(args.y);
  if (x === null || y === null) return invalid('click: x and y must be finite numbers (pixel coordinates in the last screenshot)');
  let button: 'left' | 'right' | 'middle' = 'left';
  if (args.button === 'right' || args.button === 'middle') button = args.button;
  else if (args.button !== null && args.button !== undefined) return invalid(`click: invalid button ${JSON.stringify(args.button)} (expected left|right|middle or null)`);
  const clicks = Math.min(3, Math.max(1, Math.round(num(args.clicks, 1))));
  const phys = remapToPhysical(meta, x, y);
  const res = await worker.op<{ x: number; y: number; button: string; clicks: number }>('click', { x: phys.x, y: phys.y, button, clicks });
  return jsonResult(res);
}

/** type：文本直传（换行由 worker 侧转 Enter 键）；属拒绝名单（无 lastMeta 拒绝——先见屏后动作）。 */
async function runType(worker: WorkerClient, args: Record<string, unknown>): Promise<CallToolResult> {
  if (lastShotMeta() === null) return noScreenshotError();
  if (typeof args.text !== 'string') return invalid('type: text must be a string');
  const res = await worker.op<{ sent: number }>('type', { text: args.text });
  return { content: [{ type: 'text', text: `typed ${res.sent} characters into the focused window` }] };
}

/** key：组合键名数组（String 化+修剪，空项剔除；空数组拒绝）——VK 映射与按下/逆序抬起在 worker 侧。 */
async function runKey(worker: WorkerClient, args: Record<string, unknown>): Promise<CallToolResult> {
  const keys = Array.isArray(args.keys) ? args.keys.map((k) => String(k).trim()).filter((k) => k.length > 0) : [];
  if (keys.length === 0) return invalid('key: keys must be a non-empty array of key names, e.g. ["Ctrl","C"]');
  const res = await worker.op<{ keys: string[] }>('key', { keys });
  return { content: [{ type: 'text', text: `pressed ${res.keys.join('+')}` }] };
}

/** scroll：滚轮 ±amount×120（worker mouse_event）；无 lastMeta 拒绝（拒绝名单）；x/y 可选反算（须成对）。 */
async function runScroll(worker: WorkerClient, args: Record<string, unknown>): Promise<CallToolResult> {
  const meta = lastShotMeta();
  if (meta === null) return noScreenshotError();
  if (args.direction !== 'up' && args.direction !== 'down') return invalid('scroll: direction must be "up" or "down"');
  const amount = Math.min(50, Math.max(1, Math.round(num(args.amount, 1))));
  const x = requireNum(args.x);
  const y = requireNum(args.y);
  if ((x === null) !== (y === null)) return invalid('scroll: x and y must be given together (or both null to scroll at the current cursor position)');
  let params: Record<string, unknown> = { direction: args.direction, amount };
  if (x !== null && y !== null) {
    const phys = remapToPhysical(meta, x, y);
    params = { ...params, x: phys.x, y: phys.y };
  }
  const res = await worker.op<{ direction: string; amount: number }>('scroll', params);
  return jsonResult(res);
}

/** drag：from/to 两点各反算后下发（worker SetCursorPos 路径插值+左键按下/抬起）。 */
async function runDrag(worker: WorkerClient, args: Record<string, unknown>): Promise<CallToolResult> {
  const meta = lastShotMeta();
  if (meta === null) return noScreenshotError();
  const from = point2(args.from);
  const to = point2(args.to);
  if (from === null || to === null) return invalid('drag: from and to must each be a finite [x, y] pair (pixel coordinates in the last screenshot)');
  const p1 = remapToPhysical(meta, from[0], from[1]);
  const p2 = remapToPhysical(meta, to[0], to[1]);
  const res = await worker.op<{ from: number[]; to: number[]; steps: number }>('drag', { from: [p1.x, p1.y], to: [p2.x, p2.y] });
  return jsonResult(res);
}

/** wait：秒数（允许小数），0 下限、120 封顶（防误占 worker 串行队列）；Start-Sleep 在 worker 侧。 */
async function runWait(worker: WorkerClient, args: Record<string, unknown>): Promise<CallToolResult> {
  const s = requireNum(args.seconds);
  if (s === null || s < 0) return invalid('wait: seconds must be a non-negative finite number');
  const seconds = Math.min(120, s);
  const res = await worker.op<{ slept: number }>('wait', { seconds });
  return { content: [{ type: 'text', text: `waited ${res.slept}s` }] };
}

/** wait_for：worker 侧 UIA 文本轮询（250ms 步进）；mode null→appear（其余非枚举拒绝）、timeout null→10
 *  （下限 0.5、封顶 120）；超时回 isError 文本（含 foreground 现场）——引导模型换策略而非静默。 */
async function runWaitFor(worker: WorkerClient, args: Record<string, unknown>): Promise<CallToolResult> {
  const target = typeof args.target === 'string' ? args.target : '';
  if (target.trim().length === 0) return invalid('wait_for: target must be non-empty text to look for in the UIA tree');
  if (args.mode !== null && args.mode !== undefined && args.mode !== 'appear' && args.mode !== 'disappear') {
    return invalid(`wait_for: invalid mode ${JSON.stringify(args.mode)} (expected appear|disappear or null)`);
  }
  const mode = args.mode === 'disappear' ? 'disappear' : 'appear';
  const timeout = Math.min(120, Math.max(0.5, num(args.timeout, 10)));
  const res = await worker.op<{ found: boolean; mode: string; elapsed: number; foreground: string }>('wait_for', { target, mode, timeout });
  const where = ` (foreground: ${res.foreground === '' ? 'n/a' : res.foreground})`;
  if (!res.found) {
    const verb = mode === 'disappear' ? 'disappear' : 'appear';
    return { content: [{ type: 'text', text: `wait_for timeout after ${res.elapsed}s: '${target}' did not ${verb}${where}` }], isError: true };
  }
  const verb = mode === 'disappear' ? 'disappeared' : 'appeared';
  return { content: [{ type: 'text', text: `'${target}' ${verb} after ${res.elapsed}s${where}` }] };
}

/** app：launch=Start-Process（回 pid）；focus=按标题子串找窗口+SetForegroundWindow（回 focused/title，
 *  失败回 isError）。无坐标不反算。 */
async function runApp(worker: WorkerClient, args: Record<string, unknown>): Promise<CallToolResult> {
  if (args.action !== 'launch' && args.action !== 'focus') return invalid('app: action must be "launch" or "focus"');
  const target = typeof args.target === 'string' ? args.target : '';
  if (target.trim().length === 0) return invalid('app: target must be a non-empty app name or executable path (launch) / window title (focus)');
  if (args.action === 'launch') {
    const res = await worker.op<{ pid: number }>('app', { action: 'launch', target });
    return { content: [{ type: 'text', text: `launched ${target} (pid ${res.pid})` }] };
  }
  const res = await worker.op<{ focused: boolean; title: string }>('app', { action: 'focus', target });
  if (!res.focused) {
    return { content: [{ type: 'text', text: `could not bring "${res.title}" to the foreground (foreground lock)` }], isError: true };
  }
  return { content: [{ type: 'text', text: `focused "${res.title}"` }] };
}
