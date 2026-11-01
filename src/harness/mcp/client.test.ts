import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentOf, execResultFromMcp, killProcessTree, McpHost } from './client';
import { CodedToolError, ToolRegistry } from '../tools';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

// 桩基建面取原模块对象：import * 命名空间在 TS CJS 编译下是 getter-only 副本（赋值抛「only a getter」），
// require 原模块后 defineProperty 覆写才可行——client.js 编译产物调用点动态取属性，补丁可见
const cp = require('node:child_process') as Record<string, unknown>;

test('mcp image content → ExecResult.images dataURL', async () => {
  // 经 makeTool 产出的 executor 间接钉测：构造最小 RegisteredTool 走 client 内部映射
  // 若 makeTool 未导出，则导出 contentOf 供测（export function contentOf）
  const r = contentOf([
    { type: 'text', text: 'shot taken' },
    { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
  ]);
  assert.equal(r.text, 'shot taken');
  assert.deepEqual(r.images, ['data:image/png;base64,aGVsbG8=']);
});
test('mcp 纯 text content 形态零变化（回归钉）', () => {
  const r = contentOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
  assert.equal(r.text, 'a\nb');
  assert.equal(r.images, undefined);
});
test('mcp 图片超 MAX_IMAGES 钳制', () => {
  const parts = Array.from({ length: 10 }, (_, i) => ({ type: 'image', data: String(i), mimeType: 'image/png' }));
  const r = contentOf(parts);
  assert.equal(r.images!.length, 8);
});
test('mcp isError 结果抛 CodedToolError 且 images 随行（失败语义保真，错误亦可带图）', () => {
  assert.throws(
    () => execResultFromMcp('mcp__fs__shot', { isError: true, content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] }),
    (e: unknown) =>
      e instanceof CodedToolError &&
      e.code === 'MCP_TOOL_ERROR' &&
      e.message === 'MCP tool returned an error: mcp__fs__shot' &&
      Array.isArray(e.images) &&
      e.images[0] === 'data:image/png;base64,aGVsbG8=',
  );
});
test('mcp 成功态映射：text 收 stdout、images 原样随行（execResultFromMcp 回归钉）', () => {
  const r = execResultFromMcp('mcp__fs__shot', {
    content: [{ type: 'text', text: 'done' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/jpeg' }],
  });
  assert.deepEqual(r, { exitCode: 0, stdout: 'done', stderr: '', timedOut: false, images: ['data:image/jpeg;base64,aGVsbG8='] });
});

// ===== Task 28 bug 钉测：close 路径按 pid 终结 Windows stdio 子进程树（防进程悬挂） =====

interface SpawnRec {
  cmd: string;
  args: string[];
  opts: unknown;
  unrefCalled: boolean;
}

/** 桩基建面：临时覆写 spawn / process.kill / process.platform，记录调用并在 fn 收束后原样还原。
 *  两个实测坑位：①内建模块须对 require 原模块对象 defineProperty 覆写（见 cp 取法注）；②helper 必须
 *  async 且 await fn 全程持桩——同步还原会让 McpHost.close 的续延（killProcessTree 排在 await
 *  client.close() 之后）在桩卸下后才跑，桩测落空且真 taskkill 误射随机 pid。 */
async function withStubs<T>(
  fn: (s: { spawns: SpawnRec[]; kills: [number, string][] }) => T | Promise<T>,
): Promise<T> {
  const spawns: SpawnRec[] = [];
  const kills: [number, string][] = [];
  const origSpawnDesc = Object.getOwnPropertyDescriptor(cp, 'spawn');
  const origKill = (process as unknown as { kill: unknown }).kill;
  const origPlatformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(cp, 'spawn', {
    value: (cmd: string, args: string[], opts: unknown) => {
      const rec: SpawnRec = { cmd, args, opts, unrefCalled: false };
      spawns.push(rec);
      return { on: () => {}, unref: () => { rec.unrefCalled = true; } };
    },
    configurable: true,
    writable: true,
  });
  (process as unknown as { kill: unknown }).kill = (pid: number, sig: string) => { kills.push([pid, sig]); };
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    return await fn({ spawns, kills });
  } finally {
    if (origSpawnDesc) Object.defineProperty(cp, 'spawn', origSpawnDesc);
    (process as unknown as { kill: unknown }).kill = origKill;
    if (origPlatformDesc) Object.defineProperty(process, 'platform', origPlatformDesc);
  }
}

test('killProcessTree Windows 走 taskkill /T /F 树终结且 unref 不挂事件循环', async () => {
  await withStubs(async ({ spawns }) => {
    killProcessTree(4242);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].cmd, 'taskkill');
    assert.deepEqual(spawns[0].args, ['/pid', '4242', '/T', '/F']);
    assert.deepEqual((spawns[0].opts as { stdio: string }).stdio, 'ignore');
    assert.equal(spawns[0].unrefCalled, true, 'taskkill 子进程须 unref——否则杀树工具自己挂住事件循环');
  });
});

test('killProcessTree POSIX 走 process.kill SIGTERM 兜底', async () => {
  await withStubs(async ({ kills, spawns }) => {
    // 在 win32 桩面上临时切 POSIX 分支（本机即 Windows，直接覆盖 platform 验证分支逻辑）
    const desc = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      killProcessTree(5150);
    } finally {
      if (desc) Object.defineProperty(process, 'platform', desc);
    }
    assert.deepEqual(kills, [[5150, 'SIGTERM']]);
    assert.equal(spawns.length, 0);
  });
});

test('killProcessTree spawn 失败静默（taskkill 不在等，兜底路径不计失败不崩进程）', async () => {
  const origSpawnDesc = Object.getOwnPropertyDescriptor(cp, 'spawn');
  const origPlatformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(cp, 'spawn', {
    value: () => { throw new Error('taskkill not found'); },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    assert.doesNotThrow(() => killProcessTree(9999));
  } finally {
    if (origSpawnDesc) Object.defineProperty(cp, 'spawn', origSpawnDesc);
    if (origPlatformDesc) Object.defineProperty(process, 'platform', origPlatformDesc);
  }
});

test('McpHost.close 在 SDK close 置空 pid 之后仍按捕获 pid 树终结（Task 28 回归钉：须在 close 前捕获）', async () => {
  await withStubs(async ({ spawns }) => {
    // 模拟 SDK 现场 StdioClientTransport：close() 内部先置空 _process → pid getter 随之为 null
    let closed = false;
    const transport = {
      get pid() { return closed ? null : 4242; },
    } as unknown as Transport;
    const fakeClient = { close: async () => { closed = true; } };
    const host = new McpHost([], new ToolRegistry());
    (host as unknown as { conns: Map<string, unknown> }).conns.set('plugin', {
      client: fakeClient,
      transport,
      config: { name: 'plugin', command: 'node' },
    });
    await host.close();
    assert.equal(closed, true, 'SDK client.close 仍须先走（协议层收口）');
    assert.equal(spawns.length, 1, 'SDK close 后须按「close 前捕获的 pid」树终结——若实现读的是 close 后的 pid getter（恒 null）则漏杀、进程悬挂复现');
    assert.deepEqual(spawns[0].args, ['/pid', '4242', '/T', '/F']);
  });
});

test('McpHost.close pid 不可得（http/sse 等非 stdio 传输）静默跳过树终结', async () => {
  await withStubs(async ({ spawns, kills }) => {
    const host = new McpHost([], new ToolRegistry());
    (host as unknown as { conns: Map<string, unknown> }).conns.set('http-srv', {
      client: { close: async () => {} },
      transport: {} as unknown as Transport,
      config: { name: 'http-srv', url: 'http://127.0.0.1:9/mcp' },
    });
    await assert.doesNotReject(() => host.close());
    assert.equal(spawns.length, 0);
    assert.equal(kills.length, 0);
  });
});

test('McpHost.close 撤销本次注册的全部工具——收口后注册表零 mcp 残留（收口幂等回归钉）', async () => {
  const registry = new ToolRegistry();
  const host = new McpHost([], registry);
  // 直注 registeredNames + 同名工具进注册表（registerTools 的注册账与撤销面以此字段为单点；
  // 连接/拉清单协议面不属本钉目标，经 close 真路径验证撤销动作本身）
  const fake = { name: 'mcp__plugin__act', description: 'x', category: 'external' as const, executor: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) };
  registry.register(fake);
  registry.register({ ...fake, name: 'mcp__plugin__observe' });
  (host as unknown as { registeredNames: Set<string> }).registeredNames = new Set(['mcp__plugin__act', 'mcp__plugin__observe']);
  await host.close();
  assert.equal(registry.list().filter((t) => t.name.startsWith('mcp__')).length, 0, 'close 后注册表不得残留 mcp__ 工具（残留即 guard 放行死连接工具）');
  assert.equal(registry.get('mcp__plugin__act'), undefined);
  // 幂等：二连 close 不抛、不误伤他具
  registry.register({ ...fake, name: 'builtin_read' });
  await assert.doesNotReject(() => host.close());
  assert.ok(registry.get('builtin_read'), '二次 close 不误撤销他方工具');
});

test('livenessCheck:server 进程死亡入失败名单触发重建判据(2026-11-01 用户裁定「每轮验证连通性」);http/sse 跳过', () => {
  const registry = new ToolRegistry();
  const host = new McpHost([{ name: 'dead', command: 'node', args: ['-e', 'process.exit(0)'] }], registry);
  // 直构死连接:pid=不存在的进程(SDK 场景=server 已崩/被杀,transport 进程对象已亡或 pid 失效)
  const fakeConn = { client: {}, transport: { pid: 999999999 }, config: { name: 'dead', command: 'node', args: [] } };
  (host as unknown as { conns: Map<string, unknown> }).conns.set('dead', fakeConn);
  host.livenessCheck();
  assert.equal(host.hasFailedServers(), true, '死亡 server 入失败名单(宿主重建判据)');
  // http/sse 传输跳过探活(无 pid 可靠语义,不误判)
  const host2 = new McpHost([{ name: 'web', transport: 'http', url: 'http://127.0.0.1:1' }], registry);
  const fake2 = { client: {}, transport: {}, config: { name: 'web', transport: 'http', url: 'http://127.0.0.1:1' } };
  (host2 as unknown as { conns: Map<string, unknown> }).conns.set('web', fake2);
  host2.livenessCheck();
  assert.equal(host2.hasFailedServers(), false, 'http/sse 跳过(不误判)');
});
