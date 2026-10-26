import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchTool, lastShotMeta, resetLastShotMetaForTest } from '../src/dispatch';
import { WorkerError } from '../src/worker';
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

test('screenshot 非法入参：region 非 4 数/含非有限数/display 非 null → isError 且不触 worker', async () => {
  const h = fakeWorker(() => FULL_SHOT);
  const bad1 = await dispatchTool(h.worker, 'screenshot', { region: [1, 2, 3] });
  assert.equal(bad1.isError, true);
  const bad2 = await dispatchTool(h.worker, 'screenshot', { region: null, display: 1 });
  assert.equal(bad2.isError, true);
  // Task 19 评审随手修：Number.isFinite 收口——Infinity/ -Infinity 也拒（原 NaN-only 校验漏放行）
  const bad3 = await dispatchTool(h.worker, 'screenshot', { region: [0, 0, Infinity, 10] });
  assert.equal(bad3.isError, true);
  assert.equal(h.calls.length, 0);
});

/* ===== Task 20 动作工具 =====
 * 坐标反算基准（FULL_SHOT）：scale 3136x1568 → sent 1568x784（2x 反算）+ origin(-1920,0) 区域偏移——
 * 模型 (100,50) → 物理 (200+(-1920), 100) = (-1720,100)。各测试先 reset 会话态，与文件内顺序无关。 */

test('click：坐标按 lastMeta 反算物理值（scale+origin）下发；无 lastMeta 拒绝并引导先 screenshot', async () => {
  // 无 lastMeta：click/type/scroll/drag 一律拒绝（动作环纪律：先见屏后动作），文案引导先 screenshot
  resetLastShotMetaForTest();
  const h0 = fakeWorker(() => FULL_SHOT);
  for (const [name, args] of [
    ['click', { x: 1, y: 1 }],
    ['type', { text: 'hi' }],
    ['scroll', { direction: 'down', amount: 1 }],
    ['drag', { from: [0, 0], to: [1, 1] }],
  ] as const) {
    const r = await dispatchTool(h0.worker, name, { ...args });
    assert.equal(r.isError, true, `${name} should reject without lastMeta`);
    assert.match((r.content[0] as { text: string }).text, /screenshot/);
  }
  assert.equal(h0.calls.length, 0); // 拒绝路径不触 worker

  // 有 lastMeta：2x 反算 + origin 偏移；button/clicks null → 缺省 left/1（screenshot op 回 FULL_SHOT 置真账）
  const h = fakeWorker((op, params) => (op === 'screenshot' ? FULL_SHOT : params));
  await dispatchTool(h.worker, 'screenshot', {});
  const r = await dispatchTool(h.worker, 'click', { x: 100, y: 50, button: null, clicks: null });
  assert.equal(r.isError, undefined);
  assert.deepEqual(h.calls[1].params, { x: -1720, y: 100, button: 'left', clicks: 1 });
});

test('type/key：参数整形透传（text 直传；keys 数组 String 化+修剪空项）', async () => {
  const h = fakeWorker((op, params) => (op === 'screenshot' ? FULL_SHOT : params ?? { op }));
  await dispatchTool(h.worker, 'screenshot', {}); // type 属拒绝名单——须先有 lastMeta
  await dispatchTool(h.worker, 'type', { text: '你好 world' });
  assert.deepEqual(h.calls[1], { op: 'type', params: { text: '你好 world' } });
  await dispatchTool(h.worker, 'key', { keys: [' Ctrl ', 'c'] });
  assert.deepEqual(h.calls[2], { op: 'key', params: { keys: ['Ctrl', 'c'] } });
  const badKey = await dispatchTool(h.worker, 'key', { keys: [] });
  assert.equal(badKey.isError, true); // 空 keys 拒绝（schema minItems 1 的执行面）
});

test('scroll：有坐标反算下发/无坐标不带几何；direction/amount 整形', async () => {
  const h = fakeWorker((op) => (op === 'screenshot' ? FULL_SHOT : {}));
  await dispatchTool(h.worker, 'screenshot', {});
  await dispatchTool(h.worker, 'scroll', { direction: 'up', amount: null, x: null, y: null });
  assert.deepEqual(h.calls[1].params, { direction: 'up', amount: 1 });
  await dispatchTool(h.worker, 'scroll', { direction: 'down', amount: 3, x: 10, y: 20 });
  // 反算：toPhysical(10,20)=(20,40) + origin(-1920,0) = (-1900,40)
  assert.deepEqual(h.calls[2].params, { direction: 'down', amount: 3, x: -1900, y: 40 });
  const bad = await dispatchTool(h.worker, 'scroll', { direction: 'down', amount: 1, x: 10, y: null });
  assert.equal(bad.isError, true); // 坐标须成对
});

test('drag：from/to 两点各反算（scale+origin）下发', async () => {
  const h = fakeWorker((op) => (op === 'screenshot' ? FULL_SHOT : {}));
  await dispatchTool(h.worker, 'screenshot', {});
  await dispatchTool(h.worker, 'drag', { from: [0, 0], to: [100, 100] });
  assert.deepEqual(h.calls[1].params, { from: [-1920, 0], to: [-1720, 200] });
});

test('wait/wait_for/app：数值封顶与 null 缺省整形', async () => {
  const h = fakeWorker((op, params) => (op === 'screenshot' ? FULL_SHOT : op === 'wait_for' ? { found: true, mode: params.mode, elapsed: 0.3, foreground: '记事本' } : params));
  await dispatchTool(h.worker, 'wait', { seconds: 1.5 });
  assert.deepEqual(h.calls[0].params, { seconds: 1.5 });
  await dispatchTool(h.worker, 'wait_for', { target: '完成', mode: null, timeout: null });
  assert.deepEqual(h.calls[1].params, { target: '完成', mode: 'appear', timeout: 10 });
  await dispatchTool(h.worker, 'app', { action: 'focus', target: '记事本' });
  assert.deepEqual(h.calls[2].params, { action: 'focus', target: '记事本' });
});

test('wait_for 超时（found:false）→ isError 文本回执（引导模型换策略）', async () => {
  const h = fakeWorker(() => ({ found: false, mode: 'appear', elapsed: 10.01, foreground: '记事本' }));
  await dispatchTool(h.worker, 'screenshot', {});
  const r = await dispatchTool(h.worker, 'wait_for', { target: '保存', mode: 'appear', timeout: 10 });
  assert.equal(r.isError, true);
  assert.match((r.content[0] as { text: string }).text, /保存/);
  assert.match((r.content[0] as { text: string }).text, /10\.01/);
});

test('worker 级失败（WorkerError）单点转 isError CallToolResult（不直穿 JSON-RPC protocol error）', async () => {
  const h = fakeWorker(() => {
    throw new WorkerError('worker_op_failed', 'unknown key name: f13');
  });
  const r = await dispatchTool(h.worker, 'key', { keys: ['f13'] });
  assert.equal(r.isError, true);
  assert.match((r.content[0] as { text: string }).text, /unknown key name: f13/);
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
