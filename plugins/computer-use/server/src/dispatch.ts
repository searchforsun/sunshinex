import type { CallToolResult, ImageContent, TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { WorkerClient } from './types';
import { TOOLS } from './tools';
import { shrinkToEdge, type ScreenMeta } from './scale';

/** 工具分发单点：CallToolRequest → 执行 → MCP CallToolResult。
 *
 *  Task 19 观察三件落地（screenshot/uia_snapshot/window_list）；动作八件仍占位回执，随 Task 20 充实。
 *  - screenshot：region [l,t,r,b]（物理像素）→ 换算 x/y/w/h 下发 worker；全域则不传几何（worker 侧
 *    VirtualScreen 自算）。sent 尺寸（长边 1568 收缩）由 shrinkToEdge 预算后随参数下发（region 路径），
 *    worker 按 sent 尺寸缩放输出并回传实际记账（orig w/h + sent sentW/sentH）——**缩放置账（spec §5.2）
 *    ：成功截图置 server 会话态 lastMeta**，Task 20 动作工具经 toPhysical 反算模型坐标。
 *  - uia_snapshot/window_list：worker 行数组 → 拼行文本（uia 上限 300 行）。
 *  worker 依赖注入（WorkerClient 接缝）——测试以 fake worker 驱动本函数全分支，不触真进程。 */

/** JPEG 压缩质量（0.85 → 8 进制无涉，PS 侧 EncoderParameter 收 [long]）——镜像主仓 IMAGE_JPEG_QUALITY。 */
const JPEG_QUALITY = 85;

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

/** 读最近一次截图记账（Task 20 动作工具消费；无成功截图时为 null——动作工具据此报错引导先截图）。 */
export function lastShotMeta(): ShotMeta | null {
  return lastMeta;
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
    if (!Array.isArray(region) || region.length !== 4 || region.some((v) => typeof v !== 'number' || Number.isNaN(v))) {
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
  switch (name) {
    case 'screenshot':
      return runScreenshot(worker, args);
    case 'uia_snapshot':
      return runUiaSnapshot(worker, args);
    case 'window_list':
      return runWindowList(worker);
    default:
      return { content: [{ type: 'text', text: `not implemented: ${name}` }] }; // 动作八件随 Task 20 充实
  }
}
