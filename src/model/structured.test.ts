import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import { OpenAIAdapter, ResponseFormat } from './adapter';

/** 透传验证用最小 format（就地内联，model 层测试不反向依赖 harness 装配） */
const FORMAT: ResponseFormat = {
  type: 'json_schema',
  json_schema: { name: 'sunshinex_action', strict: false, schema: { type: 'object' } },
};

/** 本地请求体捕获 mock：按请求体 stream 字段分流 JSON / SSE 应答，转发真实外网 */
function startCapture(bodies: Record<string, unknown>[]): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        bodies.push(body);
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"done":true}' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [], usage: { total_tokens: 1 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: '{"done":true}' } }], usage: { total_tokens: 1 } }));
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}/v1`, close: () => srv.close() });
    });
  });
}

test('OpenAIAdapter.complete：显式下发 format 时请求体携带 response_format', async () => {
  const bodies: Record<string, unknown>[] = [];
  const srv = await startCapture(bodies);
  try {
    const a = new OpenAIAdapter({ provider: 'openai', baseURL: srv.url, apiKey: 'k' });
    await a.complete('p', undefined, FORMAT);
    assert.deepEqual(bodies[0].response_format, FORMAT, 'response_format 原样透传');
  } finally {
    srv.close();
  }
});

test('OpenAIAdapter.complete：未下发 format 请求体不含 response_format（既有形态零漂移）', async () => {
  const bodies: Record<string, unknown>[] = [];
  const srv = await startCapture(bodies);
  try {
    const a = new OpenAIAdapter({ provider: 'openai', baseURL: srv.url, apiKey: 'k' });
    await a.complete('p');
    assert.ok(!('response_format' in bodies[0]), '无 format 时不得携带 response_format 字段');
  } finally {
    srv.close();
  }
});

test('OpenAIAdapter.completeStream：format 随流式请求体下发且流式形态不变', async () => {
  const bodies: Record<string, unknown>[] = [];
  const srv = await startCapture(bodies);
  try {
    const a = new OpenAIAdapter({ provider: 'openai', baseURL: srv.url, apiKey: 'k' });
    const full = await a.completeStream('p', () => {}, undefined, { type: 'json_object' });
    assert.equal(full, '{"done":true}');
    assert.equal(bodies[0].stream, true);
    assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
  } finally {
    srv.close();
  }
});
