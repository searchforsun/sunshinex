import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer } from '../src/index';
import type { WorkerClient } from '../src/types';

/** 截图回执样例(同 dispatch.test FULL_SHOT 形态) */
const SHOT = { b64: 'QQ==', x: 0, y: 0, w: 1568, h: 784, sentW: 1568, sentH: 784, cursor: { x: 1, y: 1 }, foreground: 'Editor' };
const worker: WorkerClient = {
  op: async <T>(op: string, params: Record<string, unknown>) => (op === 'screenshot' ? SHOT : params) as T,
  close: async () => {},
};
const text = (r: unknown): string =>
  (((r as { content?: unknown }).content ?? []) as Array<{ type: string; text?: string }>).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');

test('HTTP 单进程多会话:最近截图坐标系与截图目录按会话隔离;共享 worker;无令牌 401', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-http-'));
  const srv = await startHttpServer(worker, 'tok');
  const connect = async (key: string): Promise<Client> => {
    const c = new Client({ name: key, version: '1' });
    const url = new URL(`http://127.0.0.1:${srv.port}/mcp?key=${key}&dataDir=${encodeURIComponent(dataDir)}`);
    await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer tok' } } }));
    return c;
  };
  try {
    const a = await connect('jid-a');
    const b = await connect('jid-b');
    const shot = await a.callTool({ name: 'screenshot', arguments: {} });
    const meta = JSON.parse(((shot.content as Array<{ type: string; text?: string }>)[1]!).text!) as { savedPath?: string };
    assert.ok(meta.savedPath !== undefined && meta.savedPath.includes('/plugins/computer-use/screenshots/jid-a/'), '截图落本会话目录');
    // B 未截图:动作被拒(A 的截图坐标系不串到 B)
    const bClick = await b.callTool({ name: 'click', arguments: { x: 10, y: 10, button: null, clicks: null } });
    assert.equal(bClick.isError, true);
    assert.match(text(bClick), /screenshot first/);
    const aClick = await a.callTool({ name: 'click', arguments: { x: 10, y: 10, button: null, clicks: null } });
    assert.equal(aClick.isError, undefined, 'A 有自己的截图记账,可动作');
    await a.close();
    await b.close();
    const noAuth = await fetch(`http://127.0.0.1:${srv.port}/mcp`, { method: 'POST', body: '{}' });
    assert.equal(noAuth.status, 401);
  } finally {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
