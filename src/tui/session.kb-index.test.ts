import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { SLASH_COMMANDS } from './slash-commands';
import { ScriptedAdapter } from '../model/adapter';

/**
 * /kb-index 斜杠命令（D28）：未配置 → 可读引导（缺失 env + MANUAL 第二节）；
 * 成功 → 进度/结果系统消息（对齐 /memory-gc 的会话内部任务先例）+ 会话内 kb_search 即时可检；
 * 非法目录 → 错误回执。embedding 走本地 OpenAI 兼容 mock（零外网，kb-wiring.test 同款协议形态）。
 * env 必须在 SessionController 构造前设置：会话装配（resolveKnowledgeBase）与 /kb-index 共用同一 env 面。
 */

const KB_ENV_KEYS = [
  'SUNSHINEX_EMBEDDING_BASE_URL', 'SUNSHINEX_EMBEDDING_API_KEY', 'SUNSHINEX_EMBEDDING_MODEL',
  'SUNSHINEX_BASE_URL', 'SUNSHINEX_API_KEY', 'SUNSHINEX_MODEL',
  'SUNSHINEX_KB_DATA_DIR', 'SUNSHINEX_KB_BACKEND',
] as const;

/** env 面换桩（undefined = 删除键），返回还原函数——会话装配与命令执行全程须保持桩态 */
function setKbEnv(overrides: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const k of KB_ENV_KEYS) {
    saved[k] = process.env[k];
    const v = overrides[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const k of KB_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
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

function tmpRoot(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sunshinex-kbslash-${tag}-`));
}

function writeDocs(): string {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbslash-docs-'));
  fs.writeFileSync(path.join(docs, 'a.md'), '采用分散部署策略。\n');
  return docs;
}

function systemText(ctrl: SessionController): string {
  return ctrl.getState().messages.filter((m) => m.role === 'system').map((m) => m.text).join('\n');
}

test('/kb-index：登记 SLASH_COMMANDS（/help 反向断言在 session.test 同源覆盖）', () => {
  assert.ok(SLASH_COMMANDS.includes('/kb-index'), '/kb-index 应登记斜杠命令清单');
});

test('/kb-index：未配置 → warn 级引导文案（缺失 env 键 + MANUAL 第二节）', async () => {
  const tmp = tmpRoot('off');
  const cleared: Record<string, undefined> = {};
  for (const k of KB_ENV_KEYS) cleared[k] = undefined;
  const restore = setKbEnv(cleared);
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    await ctrl.submit('/kb-index');
    const text = systemText(ctrl);
    assert.ok(/Knowledge base not configured/.test(text), `应有未配置引导：${JSON.stringify(text.slice(-300))}`);
    assert.ok(/SUNSHINEX_EMBEDDING_BASE_URL/.test(text), '应指出缺失 env 键');
    assert.ok(/MANUAL\.md section 2/.test(text), '应指向 MANUAL 第二节');
    const warn = ctrl.getState().messages.find((m) => m.role === 'system' && m.text.includes('Knowledge base not configured'));
    assert.equal(warn?.level, 'warn', 'warn 级回执');
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/kb-index：配置齐全 → 成功回执（backend/块数）+ 会话内 kb_search 即时可检（活性实例写入）', async () => {
  const srv = await startEmbedServer();
  const tmp = tmpRoot('ok');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbslash-data-'));
  const docs = writeDocs();
  const restore = setKbEnv({
    SUNSHINEX_EMBEDDING_BASE_URL: srv.url,
    SUNSHINEX_EMBEDDING_API_KEY: 'k-test',
    SUNSHINEX_EMBEDDING_MODEL: 'embed-m',
    SUNSHINEX_KB_DATA_DIR: dataDir,
  });
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    await ctrl.submit(`/kb-index ${docs}`);
    await ctrl.waitIdle();
    const text = systemText(ctrl);
    assert.ok(/Knowledge base index built: \d+ chunks/.test(text), `应上屏索引统计：${JSON.stringify(text.slice(-300))}`);
    assert.ok(text.includes('backend=local-json'), '应含 backend');
    // 活性实例钉子：索引发出后会话内 kb_search 立即可检（不经重启/重装配），命中带 file 下泄
    const h = ctrl.runtime.harness;
    const r = await h.tools.execute('kb_search', { query: '分散部署', topK: 3 }, h.safety);
    assert.ok(r.ok, `kb_search 应成功：${r.ok ? '' : r.error.code}`);
    if (r.ok) {
      const hits = JSON.parse(r.value.stdout) as Array<{ text: string; file?: string }>;
      assert.ok(hits.length >= 1 && hits[0].text.includes('分散部署'), '会话内应检索到新索引内容');
      assert.equal(hits[0].file, 'a.md', '命中应带来源 file');
    }
  } finally {
    restore();
    srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/kb-index：非法目录 → error 级回执（Not a directory）', async () => {
  const tmp = tmpRoot('bad');
  const restore = setKbEnv({
    SUNSHINEX_EMBEDDING_BASE_URL: 'http://127.0.0.1:9/v1',
    SUNSHINEX_EMBEDDING_API_KEY: 'k-test',
    SUNSHINEX_EMBEDDING_MODEL: 'embed-m',
    SUNSHINEX_KB_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-kbslash-baddata-')),
  });
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    await ctrl.submit(`/kb-index ${path.join(tmp, 'no-such-dir')}`);
    const hit = ctrl.getState().messages.find((m) => m.role === 'system' && m.text.includes('Not a directory'));
    assert.ok(hit, '应有 Not a directory 回执');
    assert.equal(hit.level, 'error', 'error 级回执');
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
