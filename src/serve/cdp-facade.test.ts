import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import { BuiltinFacade } from './cdp-facade';

/** 假「真实 CDP 端点」:HTTP /json/list 双 target(GUI 自身=blocked + 侧栏 webview=allowed)
 *  + ws 端点回显 getTargets 应答/attachedToTarget 事件(含 blocked)/createTarget 应答 */
function startFakeReal(): Promise<{ httpPort: number; wsPort: number; stop: () => void }> {
  const targets = [
    { targetId: 'gui-1', type: 'page', url: 'http://127.0.0.1:57677/?token=x', title: 'Sunshinex' },
    { targetId: 'wv-7', type: 'webview', url: 'https://www.baidu.com/', title: '百度' },
  ];
  const httpSrv = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/json/list')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(targets));
      return;
    }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  httpSrv.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      let seq = 0;
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, unknown> };
        if (m.method === 'Target.getTargets') {
          ws.send(JSON.stringify({ id: m.id, result: { targetInfos: targets } }));
        } else if (m.method === 'Target.attachToTarget') {
          const sid = `fake.${++seq}.${m.params?.targetId}`;
          ws.send(JSON.stringify({ id: m.id, result: { sessionId: sid } }));
          ws.send(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: sid, targetInfo: targets.find(t => t.targetId === m.params?.targetId) ?? targets[0] } }));
        } else {
          ws.send(JSON.stringify({ id: m.id, result: {} }));
        }
      });
    });
  });
  return new Promise((resolve) => {
    httpSrv.listen(0, '127.0.0.1', () => {
      const addr = httpSrv.address() as { port: number };
      resolve({
        httpPort: addr.port,
        wsPort: addr.port, // ws 升级面与 HTTP 同端口(真实 CDP 同构)
        stop: () => { httpSrv.close(); wss.close(); },
      });
    });
  });
}

let facade: BuiltinFacade | undefined;
let fake: { httpPort: number; wsPort: number; stop: () => void } | undefined;
let tmpDir: string | undefined;

beforeEach(() => { facade = undefined; fake = undefined; });
afterEach(() => { facade?.stop(); fake?.stop(); if (tmpDir !== undefined) fs.rmSync(tmpDir, { recursive: true, force: true }); });

/** 装 DevToolsActivePort 指向假真实端点(首行=端口,次行=browser 路径,真实形态同构) */
const prepareEndpointFile = (): void => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-test-'));
  fs.writeFileSync(path.join(tmpDir, 'DevToolsActivePort'), `${fake!.httpPort}\n/devtools/browser\n`);
};

test('过滤闸:/json/list 摘 GUI 自身 target;ws getTargets 应答同滤;createTarget 拒面', async () => {
  fake = await startFakeReal();
  prepareEndpointFile();
  facade = new BuiltinFacade({ userDataDir: tmpDir!, localOriginPrefix: 'http://127.0.0.1:57677' });
  await facade.start();

  // HTTP 面(GUI /app/cdp-targets 消费形态):仅 webview
  const httpBase = facade.endpoint.replace(/^ws/, 'http').replace(/\/devtools\/browser$/, '');
  const list = JSON.parse(await (await fetch(`${httpBase}/json/list`)).text()) as Array<{ targetId?: string; url?: string }>;
  assert.equal(list.length, 1);
  assert.equal(list[0]!.targetId, 'wv-7');
  assert.equal((list[0] as { type?: string }).type, 'page');

  // ws 面:playwright getTargets 应答同滤
  const ws = new WebSocket(facade.endpoint);
  await new Promise((r) => ws.on('open', r));
  const pending = new Map<number, (v: any) => void>();
  let seq = 0;
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as { id?: number };
    if (typeof m.id === 'number' && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
  });
  const send = (method: string, params?: Record<string, unknown>): Promise<{ id: number; result?: Record<string, unknown>; error?: { message: string } }> => {
    const id = ++seq;
    return new Promise((resolve) => { pending.set(id, resolve as (v: any) => void); ws.send(JSON.stringify({ id, method, params })); });
  };
  const targets = await send('Target.getTargets');
  assert.equal((targets.result!.targetInfos as unknown[]).length, 1);
  assert.equal(((targets.result!.targetInfos as Array<{ targetId: string }>)[0]!).targetId, 'wv-7');
  // 侧栏 webview 对外改报 page(Playwright 只认 page,否则插件看不到侧栏页签)
  assert.equal(((targets.result!.targetInfos as Array<{ type: string }>)[0]!).type, 'page');
  // createTarget 拒面(页签生命周期归 GUI)
  const deny = await send('Target.createTarget', { url: 'https://example.com' });
  // 错误文案英文单语(§15:CDP 错误经 Playwright→MCP 工具结果回流进模型面)
  assert.match(String(deny.error!.message), /sidebar browser tabs are managed by the GUI/);
  ws.close();
});

test('closeTarget 交 GUI 关页签;Input.insertText 前后聚焦/归还侧栏 webview(未聚焦 guest 收不到文本)', async () => {
  fake = await startFakeReal();
  prepareEndpointFile();
  const closed: string[] = [];
  const focus: string[] = [];
  facade = new BuiltinFacade({
    userDataDir: tmpDir!,
    localOriginPrefix: 'http://127.0.0.1:57677',
    closeTab: (tid) => { closed.push(tid); return tid === 'wv-7'; },
    focusTab: (tid, phase) => { focus.push(`${phase}:${tid}`); return true; },
  });
  await facade.start();
  const ws = new WebSocket(facade.endpoint);
  await new Promise((r) => ws.on('open', r));
  const pending = new Map<number, (v: any) => void>();
  let seq = 0;
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as { id?: number };
    if (typeof m.id === 'number' && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
  });
  const send = (method: string, params?: Record<string, unknown>, sessionId?: string): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> => {
    const id = ++seq;
    return new Promise((resolve) => { pending.set(id, resolve as (v: any) => void); ws.send(JSON.stringify({ id, method, params, ...(sessionId !== undefined ? { sessionId } : {}) })); });
  };
  const ok = await send('Target.closeTarget', { targetId: 'wv-7' });
  assert.deepEqual(ok.result, { success: true });
  const bad = await send('Target.closeTarget', { targetId: 'nope' });
  assert.ok(bad.error !== undefined);
  assert.deepEqual(closed, ['wv-7', 'nope']);
  // attach 建立 sessionId→targetId 映射后,insertText 前聚焦、应答后归还
  const att = await send('Target.attachToTarget', { targetId: 'wv-7', flatten: true });
  const sid = String(att.result!.sessionId);
  await new Promise((r) => setTimeout(r, 20));
  const ins = await send('Input.insertText', { text: 'hi' }, sid);
  assert.ok(ins.error === undefined);
  assert.deepEqual(focus, ['begin:wv-7', 'end:wv-7']);
  ws.close();
});
