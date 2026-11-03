import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { browserHostMode, browserHostServer } from './browser-host';

const pluginDir = path.resolve(__dirname, '../../plugins/browser-use');
const hostBuilt = fs.existsSync(path.join(pluginDir, 'server', 'host.js'));

test('浏览器形态按运行环境定:serve=默认浏览器,其余非桌面=无头', () => {
  const prev = process.env.SUNSHINEX_HOST;
  try {
    delete process.env.SUNSHINEX_HOST;
    assert.equal(browserHostMode(), 'headless');
    process.env.SUNSHINEX_HOST = 'serve';
    assert.equal(browserHostMode(), 'default');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_HOST;
    else process.env.SUNSHINEX_HOST = prev;
  }
});

test('浏览器宿主:一进程服务多会话——同一宿主端口,URL 携带各自会话键/数据目录;MCP 握手出浏览器工具', { skip: !hostBuilt && 'plugins/browser-use/server/host.js 未构建(node plugins/browser-use/build.mjs)' }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-test-'));
  const placeholder = { name: 'browser-use', command: 'node', args: ['server/host.js'], cwd: pluginDir };
  try {
    const a = await browserHostServer(placeholder, { key: 'jid-a', seat: 'sun-1' }, dataDir);
    const b = await browserHostServer(placeholder, { key: 'jid-b', seat: 'sun-2' }, dataDir);
    assert.equal(a.transport, 'http');
    assert.equal(new URL(a.url!).port, new URL(b.url!).port, '同一宿主');
    assert.equal(new URL(a.url!).searchParams.get('key'), 'jid-a');
    assert.equal(new URL(b.url!).searchParams.get('key'), 'jid-b');
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(a.url!), { requestInit: { headers: a.headers! } }));
    const tools = await c.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'browser_navigate'));
    assert.ok(tools.tools.some((t) => t.name === 'browser_verify_text_visible'), 'testing 能力组常开');
    await c.close();
    const noAuth = await fetch(a.url!, { method: 'POST', body: '{}' });
    assert.equal(noAuth.status, 401);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
