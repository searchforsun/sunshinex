import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import { toWireMessages } from './wire';
import { OpenAIAdapter } from './adapter';
import type { ChatMessage } from '../types';

/** 图片载荷 wire 面：user.images（dataURL）→ OpenAI vision content 块数组；无图消息形态逐字节不变（回归钉子）。
 *  adapter 守卫：声明 supportsImages:false 的模型携带 images 请求 fail-fast（不打必败请求）——
 *  守卫放行面经本地端点钉（零外网依赖）：放行时端点收到 image_url 块，拒绝时端点零命中 */

const PNG = 'data:image/png;base64,aGVsbG8=';
const JPEG = 'data:image/jpeg;base64,aGVsbG8y';

test('toWireMessages：user.images → text+image_url 内容块数组（顺序保真）', () => {
  const msgs: ChatMessage[] = [{ role: 'user', content: '看这两张图', images: [PNG, JPEG] }];
  const wire = toWireMessages(msgs);
  assert.deepEqual(wire, [
    {
      role: 'user',
      content: [
        { type: 'text', text: '看这两张图' },
        { type: 'image_url', image_url: { url: PNG } },
        { type: 'image_url', image_url: { url: JPEG } },
      ],
    },
  ]);
});

test('toWireMessages：无图/纯文本消息形态零变化（回归钉子）', () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'plain' },
    { role: 'user', content: 'empty images', images: [] },
  ];
  assert.deepEqual(toWireMessages(msgs), [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'plain' },
    { role: 'user', content: 'empty images' },
  ]);
});

/** 本地 OpenAI 形端点：记录请求体、恒回最小合法 chat completion */
async function withLocalEndpoint(fn: (url: string, hits: { bodies: unknown[] }) => Promise<void>): Promise<void> {
  const hits: { bodies: unknown[] } = { bodies: [] };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as net.AddressInfo;
  try {
    await fn(`http://127.0.0.1:${addr.port}/v1`, hits);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('adapter 守卫：supportsImages:false 携带 images 即抛（端点零命中——不打必败请求）', async () => {
  await withLocalEndpoint(async (url, hits) => {
    const adapter = new OpenAIAdapter({ provider: 'openai', apiKey: 'k', model: 'text-only', baseURL: url, supportsImages: false });
    await assert.rejects(
      adapter.chat({ messages: [{ role: 'user', content: 'look', images: [PNG] }] }),
      /does not support image input/,
    );
    await assert.rejects(
      adapter.chatStream({ messages: [{ role: 'user', content: 'look', images: [PNG] }] }, () => {}),
      /does not support image input/,
    );
    assert.equal(hits.bodies.length, 0, '守卫拒绝路径零 HTTP 命中');
  });
});

test('adapter 守卫放行面：未声明（undefined）携带 images 透传 image_url 块到端点；声明 false 纯文本照常', async () => {
  await withLocalEndpoint(async (url, hits) => {
    const ok = new OpenAIAdapter({ provider: 'openai', apiKey: 'k', model: 'vision', baseURL: url });
    await ok.chat({ messages: [{ role: 'user', content: 'look', images: [PNG, JPEG] }] });
    assert.equal(hits.bodies.length, 1);
    const sent = (hits.bodies[0] as { messages: Array<{ content: unknown }> }).messages[0]!.content;
    assert.ok(Array.isArray(sent) && JSON.stringify(sent).includes('image_url'), '放行路径端点收到 image_url 块');

    const no = new OpenAIAdapter({ provider: 'openai', apiKey: 'k', model: 'text-only', baseURL: url, supportsImages: false });
    const r = await no.chat({ messages: [{ role: 'user', content: 'no images here' }] });
    assert.equal(r.content, 'ok', '纯文本请求不受守卫影响');
    assert.equal(hits.bodies.length, 2);
  });
});
