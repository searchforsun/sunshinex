import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { runKbIndex } from './kb-index';
import type { CliArgs } from '../index';

/**
 * kb-index 子命令三态（D28）：未配置 → exit 1 + 缺失 env 引导（指向 MANUAL 第二节）；
 * 成功 → 统计上屏（backend/数据目录/块数）+ 索引落盘；非法目录 → exit 1。
 * embedding 走本地 OpenAI 兼容 mock（零外网，kb-wiring.test 同款协议形态）；
 * 进程内直跑命令函数（kb-wiring 的 process.env 夹具先例），console 捕获经临时换桩。
 */

const KB_ENV_KEYS = [
  'SUNSHINEX_EMBEDDING_BASE_URL', 'SUNSHINEX_EMBEDDING_API_KEY', 'SUNSHINEX_EMBEDDING_MODEL',
  'SUNSHINEX_BASE_URL', 'SUNSHINEX_API_KEY', 'SUNSHINEX_MODEL',
  'SUNSHINEX_KB_DATA_DIR', 'SUNSHINEX_KB_BACKEND',
] as const;

/** env 面换桩（undefined = 删除键）：finally 全量还原，防测试间泄漏 */
async function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of KB_ENV_KEYS) {
    saved[k] = process.env[k];
    const v = overrides[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const k of KB_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function kbArgs(positional: string[]): CliArgs {
  return { command: 'kb-index', positional, flags: {} };
}

/** console 临时换桩：收集输出行与命令返回时的 exitCode，finally 还原（进程内测试不向测试日志喷命令输出） */
async function captureConsole(fn: () => Promise<void>): Promise<{ out: string[]; err: string[]; exitCode: number | string | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  console.error = (...a: unknown[]) => void err.push(a.join(' '));
  console.warn = (...a: unknown[]) => void out.push(a.join(' '));
  const prevExit = process.exitCode ?? undefined;
  let observedExit: number | string | undefined;
  try {
    await fn();
    observedExit = process.exitCode ?? undefined;
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
    process.exitCode = prevExit;
  }
  return { out, err, exitCode: observedExit };
}

function startEmbedServer(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as { input: string[] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: body.input.map((t, i) => {
            const v = new Array(8).fill(0);
            for (const ch of t) v[(ch.codePointAt(0) ?? 0) % 8] += 1;
            return { index: i, embedding: v };
          }),
        }));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/v1`, close: () => srv.close() });
    });
  });
}

function writeDocs(): string {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbcli-docs-'));
  fs.writeFileSync(path.join(docs, 'a.md'), '采用分散部署策略。\n');
  return docs;
}

test('kb-index：未配置 → exit 1 + 指出缺失 env 并指向 MANUAL 第二节', async () => {
  const docs = writeDocs();
  // 显式清空继承面：EMBEDDING_* 与回退源 SUNSHINEX_* 主键一并清（空串/缺键都等价未配置）
  const cleared: Record<string, undefined> = {};
  for (const k of KB_ENV_KEYS) cleared[k] = undefined;
  await withEnv(cleared, async () => {
    const { err, exitCode } = await captureConsole(() => runKbIndex(kbArgs([docs])));
    assert.equal(exitCode, 1, '未配置应 exit 1');
    const text = err.join('\n');
    assert.ok(/SUNSHINEX_EMBEDDING_BASE_URL/.test(text), `应指出缺失 base url 键：${JSON.stringify(text)}`);
    assert.ok(/SUNSHINEX_EMBEDDING_MODEL/.test(text), '应指出缺失 model 键');
    assert.ok(/MANUAL\.md section 2/.test(text), '应指向 MANUAL 第二节');
  });
});

test('kb-index：配置齐全 → 统计上屏（backend/数据目录/块数）+ 索引落盘 + exit 0', async () => {
  const srv = await startEmbedServer();
  const docs = writeDocs();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbcli-data-'));
  try {
    await withEnv({
      SUNSHINEX_EMBEDDING_BASE_URL: srv.url,
      SUNSHINEX_EMBEDDING_API_KEY: 'k-test',
      SUNSHINEX_EMBEDDING_MODEL: 'embed-m',
      SUNSHINEX_KB_DATA_DIR: dataDir,
    }, async () => {
      const { out, exitCode } = await captureConsole(() => runKbIndex(kbArgs([docs])));
      assert.notEqual(exitCode, 1, '成功不得 exit 1');
      const text = out.join('\n');
      assert.ok(/Knowledge base index built: \d+ chunks/.test(text), `应上屏块数统计：${JSON.stringify(text)}`);
      assert.ok(text.includes('backend=local-json'), '应上屏 backend');
      assert.ok(text.includes(dataDir), '应上屏数据目录');
      assert.ok(fs.existsSync(path.join(dataDir, 'kb.vectors.json')), '索引应落盘');
    });
  } finally {
    srv.close();
  }
});

test('kb-index：非法目录 → exit 1 + Not a directory 错误上屏', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbcli-bad-'));
  await withEnv({
    SUNSHINEX_EMBEDDING_BASE_URL: 'http://127.0.0.1:9/v1',
    SUNSHINEX_EMBEDDING_API_KEY: 'k-test',
    SUNSHINEX_EMBEDDING_MODEL: 'embed-m',
    SUNSHINEX_KB_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbcli-baddata-')),
  }, async () => {
    const missing = path.join(root, 'no-such-dir');
    const { err, exitCode } = await captureConsole(() => runKbIndex(kbArgs([missing])));
    assert.equal(exitCode, 1, '非法目录应 exit 1');
    assert.ok(/Not a directory/.test(err.join('\n')), '应上屏 Not a directory');
  });
});
