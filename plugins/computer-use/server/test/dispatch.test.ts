import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchTool, lastShotMeta } from '../src/dispatch';
import type { WorkerClient } from '../src/types';

/** fake worker 工厂（WorkerClient 接缝注入——createServer/dispatchTool 只依赖此接口，不触真进程）：
 *  按 op 回固定结果并记录每次 op 收到的 params（深拷贝快照，防实现侧原地改写干扰断言）。 */
function fakeWorker(reply: (op: string, params: Record<string, unknown>) => unknown) {
  const calls: { op: string; params: Record<string, unknown> }[] = [];
  const worker: WorkerClient = {
    op: async <T>(op: string, params: Record<string, unknown>) => {
      calls.push({ op, params: JSON.parse(JSON.stringify(params)) as Record<string, unknown> });
      return reply(op, params) as T;
    },
    close: async () => {},
  };
  return { worker, calls };
}

/** screenshot worker 侧回执样例：3136x1568 物理全域 → sent 1568x784（与 shrinkToEdge 一致）。 */
const FULL_SHOT = {
  b64: 'QQ==',
  x: -1920,
  y: 0,
  w: 3136,
  h: 1568,
  sentW: 1568,
  sentH: 784,
  cursor: { x: 10, y: 10 },
  foreground: 'Editor',
};

test('screenshot 全域：worker b64 → image content + scale 元数据文本 + lastMeta 缩放置账', async () => {
  const h = fakeWorker(() => FULL_SHOT);
  const r = await dispatchTool(h.worker, 'screenshot', {});
  const img = r.content[0] as { type: string; data: string; mimeType: string };
  assert.equal(img.type, 'image');
  assert.equal(img.data, 'QQ==');
  assert.equal(img.mimeType, 'image/jpeg');
  const meta = JSON.parse((r.content[1] as { type: string; text: string }).text) as {
    scale: { origWidth: number; origHeight: number; sentWidth: number; sentHeight: number };
    cursor?: { x: number; y: number };
    foreground?: string;
  };
  assert.equal(meta.scale.sentWidth, 1568);
  assert.equal(meta.scale.sentHeight, 784);
  assert.equal(meta.scale.origWidth, 3136);
  assert.deepEqual(meta.cursor, { x: 10, y: 10 });
  assert.equal(meta.foreground, 'Editor');
  // 全域截图：worker 只收 quality（物理全域与 sent 尺寸由 worker 侧 VirtualScreen 自算——Node 不预知虚拟屏）
  assert.deepEqual(h.calls[0], { op: 'screenshot', params: { quality: 85 } });
  // lastMeta 随成功截图置账（Task 20 动作反算数据面）：origin=worker 回传的物理区域原点
  assert.deepEqual(lastShotMeta(), {
    scale: { origWidth: 3136, origHeight: 1568, sentWidth: 1568, sentHeight: 784 },
    originX: -1920,
    originY: 0,
    cursor: { x: 10, y: 10 },
    foreground: 'Editor',
  });
});

test('screenshot region：[l,t,r,b] 换算物理 x/y/w/h 下发，sent 尺寸 shrinkToEdge 预算', async () => {
  const h = fakeWorker(() => ({ ...FULL_SHOT, x: 100, y: 200, w: 3200, h: 1568, sentW: 1568, sentH: 768 }));
  const r = await dispatchTool(h.worker, 'screenshot', { region: [100, 200, 3300, 1768], display: null });
  // 物理区域：w=3300-100=3200, h=1768-200=1568；sent=shrinkToEdge(3200,1568)={1568,768}（0.49 缩比）
  assert.deepEqual(h.calls[0].params, { x: 100, y: 200, w: 3200, h: 1568, sentW: 1568, sentH: 768, quality: 85 });
  const img = r.content[0] as { type: string };
  assert.equal(img.type, 'image');
  assert.equal(r.isError, undefined);
});

test('screenshot 非法入参：region 非 4 数/display 非 null → isError 且不触 worker', async () => {
  const h = fakeWorker(() => FULL_SHOT);
  const bad1 = await dispatchTool(h.worker, 'screenshot', { region: [1, 2, 3] });
  assert.equal(bad1.isError, true);
  const bad2 = await dispatchTool(h.worker, 'screenshot', { region: null, display: 1 });
  assert.equal(bad2.isError, true);
  assert.equal(h.calls.length, 0);
});

test('uia_snapshot：行文本原样拼接 + 300 行上限 + scope 缺省 window', async () => {
  const lines = Array.from({ length: 400 }, (_, i) => `[${i + 1}] Button '确定' (340,520,120x32) enabled`);
  const h = fakeWorker((op, params) => {
    assert.equal(op, 'uia_snapshot');
    assert.deepEqual(params, { scope: 'window' }); // args.scope 为 null → 缺省 window
    return { lines };
  });
  const r = await dispatchTool(h.worker, 'uia_snapshot', { scope: null });
  const text = (r.content[0] as { type: string; text: string }).text;
  const out = text.split('\n');
  assert.equal(out.length, 301); // 300 行 + 1 行截断说明
  assert.match(out[0]!, /^\[1\] Button '确定'/);
  assert.match(out[299]!, /^\[300\] Button/);
  assert.ok(out[300]!.includes('300') && out[300]!.includes('400'));
});

test('uia_snapshot scope=desktop 透传 worker；空结果兜底文案', async () => {
  const h = fakeWorker(() => ({ lines: [] }));
  await dispatchTool(h.worker, 'uia_snapshot', { scope: 'desktop' });
  assert.deepEqual(h.calls[0].params, { scope: 'desktop' });
  const r = await dispatchTool(h.worker, 'uia_snapshot', { scope: 'desktop' });
  assert.equal((r.content[0] as { text: string }).text.includes('no elements'), true);
});

test('window_list：worker 行数组 → 拼行文本（标题/pid/z序）', async () => {
  const h = fakeWorker(() => ({ lines: ["[1] 'Editor' pid=1234 foreground", "[2] 'Settings' pid=5678"] }));
  const r = await dispatchTool(h.worker, 'window_list', {});
  assert.deepEqual(h.calls[0], { op: 'window_list', params: {} });
  assert.equal((r.content[0] as { text: string }).text, "[1] 'Editor' pid=1234 foreground\n[2] 'Settings' pid=5678");
});

test('未登记工具仍走 unknown tool 错误（既有协议面不回退）', async () => {
  const h = fakeWorker(() => ({}));
  const r = await dispatchTool(h.worker, 'nope', {});
  assert.equal(r.isError, true);
  assert.equal((r.content[0] as { text: string }).text, 'unknown tool: nope');
});
