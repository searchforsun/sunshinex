import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GuiDaemon } from './daemon';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';

/**
 * G6 文件预览面测试：GET /session/:id/file?path= —— 判界内（相对/绝对）200 内容、`../` 逃逸 403、
 * 不存在/目录 404、>512KB 截断（truncated:true 且 content 恰 524288 字节）、二进制（首 8KB 含 \0）415、
 * 缺 path 400。额外信任根（additionalDirs）不测——单 root 判界即本端点口径。
 */

const AUTH = { authorization: 'Bearer test-token' } as Record<string, string>;

/** 预览上限(与 daemon 常量同值):512KB */
const MAX = 512 * 1024;

/** 环境隔离样板（同 daemon.workspace.test.ts 惯例）：钉 SUNSHINEX_PROJECTS_DIR 到本用例 tmp，
 *  focused 直跑不经 scripts/run-tests.js 预载，须自隔离 */
test('GET /session/:id/file:判界/404/415/截断/400 全分支', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-file-'));
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_PROJECTS_DIR = path.join(tmp, 'projects');
  delete process.env.SUNSHINEX_DATA_DIR;
  // 会话 root（root 内样例文件 + root 外逃逸靶）
  const root = path.join(tmp, 'root');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'hello.ts'), 'const x = 1;\n', 'utf8');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sub', 'note.md'), '# note\n', 'utf8');
  const daemon = new GuiDaemon({ model: new ScriptedAdapter(['{}']) as unknown as ModelAdapter });
  const handle = await daemon.start({ port: 0, token: 'test-token' });
  const base = `http://127.0.0.1:${handle.port}`;
  try {
    const r = await fetch(`${base}/session/new`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ root }),
    });
    assert.equal(r.status, 200, 'session/new 应 200');
    const { sessionId } = (await r.json()) as { sessionId: string };
    const file = async (q: string): Promise<Response> =>
      fetch(`${base}/session/${sessionId}/file?path=${encodeURIComponent(q)}`, { headers: AUTH });

    // —— 判界内:相对路径 200 内容,回执 path 为 resolve 归一后的绝对路径 ——
    let resp = await file('hello.ts');
    assert.equal(resp.status, 200, '相对路径判界内应 200');
    let body = (await resp.json()) as { path?: string; content: string; truncated?: boolean };
    assert.equal(body.content, 'const x = 1;\n');
    assert.equal(body.path, path.resolve(root, 'hello.ts'));
    assert.equal(body.truncated, undefined, '小文件不带 truncated');

    // —— 判界内:绝对路径 + 子目录相对路径 ——
    resp = await fetch(`${base}/session/${sessionId}/file?path=${encodeURIComponent(path.join(root, 'hello.ts'))}`, { headers: AUTH });
    assert.equal(resp.status, 200, '绝对路径判界内应 200');
    resp = await file('sub/note.md');
    body = (await resp.json()) as { content: string };
    assert.equal(body.content, '# note\n');

    // —— 越界:../ 逃逸出会话 root → 403 恒定文案 ——
    resp = await file('../outside.txt');
    assert.equal(resp.status, 403);
    assert.deepEqual(await resp.json(), { error: 'path outside trusted roots' });
    // 逃逸目标真实存在与否同拒(判界先于存在性)
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'out', 'utf8');
    resp = await file('../outside.txt');
    assert.equal(resp.status, 403, '逃逸到真实文件同样 403');

    // —— 不存在 / 目录 → 404 ——
    resp = await file('nope.ts');
    assert.equal(resp.status, 404);
    assert.deepEqual(await resp.json(), { error: 'not found' });
    resp = await file('sub');
    assert.equal(resp.status, 404, '目录 404(非文件)');

    // —— 二进制:首 8KB 含 \0 → 415(不回内容) ——
    const bin = Buffer.concat([Buffer.from('text\0binary'), Buffer.alloc(64, 1)]);
    fs.writeFileSync(path.join(root, 'blob.bin'), bin);
    resp = await file('blob.bin');
    assert.equal(resp.status, 415);
    assert.deepEqual(await resp.json(), { error: 'binary file' });

    // —— >512KB:读首 512KB + truncated:true(Ruling 1 修正——预览语义,不 413) ——
    const big = path.join(root, 'big.txt');
    fs.writeFileSync(big, 'x'.repeat(MAX + 10), 'utf8');
    resp = await file('big.txt');
    assert.equal(resp.status, 200);
    body = (await resp.json()) as { content: string; truncated?: boolean };
    assert.equal(body.truncated, true);
    assert.equal(body.content.length, MAX);
    assert.ok(body.content.split('').every((c) => c === 'x'), '截断内容为首段原文');
    // 恰 512KB(边界内):全文不截断
    fs.writeFileSync(path.join(root, 'exact.txt'), 'y'.repeat(MAX), 'utf8');
    resp = await file('exact.txt');
    assert.equal(resp.status, 200);
    body = (await resp.json()) as { content: string; truncated?: boolean };
    assert.equal(body.truncated, undefined, '恰在上限=不截断');
    assert.equal(body.content.length, MAX);

    // —— 缺 path query → 400 ——
    resp = await fetch(`${base}/session/${sessionId}/file`, { headers: AUTH });
    assert.equal(resp.status, 400);
    assert.deepEqual(await resp.json(), { error: 'path query param required' });

    // —— 仅 GET:POST 不命中路由(404 面回落,非 200) ——
    resp = await fetch(`${base}/session/${sessionId}/file?path=hello.ts`, { method: 'POST', headers: AUTH });
    assert.equal(resp.status, 404);

    // —— 鉴权:无 token 401 ——
    resp = await fetch(`${base}/session/${sessionId}/file?path=hello.ts`);
    assert.equal(resp.status, 401);

    // —— 未知会话 404 ——
    resp = await fetch(`${base}/session/s99/file?path=hello.ts`, { headers: AUTH });
    assert.equal(resp.status, 404);
  } finally {
    await handle.close();
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;
    else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
