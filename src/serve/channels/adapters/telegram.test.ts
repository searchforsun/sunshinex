/** telegram 适配器测试(spec 2026-11-21-channels §10)——全部经注入 fetchImpl/delayImpl,
 *  零真外连:①预录 getUpdates JSON 映射断言;②offset 推进(上批最大 update_id+1);
 *  ③sendMessage 请求形状(URL 含 token/body chat_id,text);④错误退避(fetch 抛错/HTTP 非 ok
 *  → delay(5000) 续轮,正常轮零间隔);⑤stop 退场(下一拍退出,health disconnected)。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramAdapter } from './telegram';
import type { ChannelConfig, InboundMessage } from '../model';

function cfg(): ChannelConfig {
  return { id: 'tg1', platform: 'telegram', enabled: true, root: '/w', mode: 'read-only', allow: { kind: 'all' } };
}

/** 200/JSON 响应(Node 内建 Response,零依赖) */
function jsonOk(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** 轮询等待条件成立(5ms 事件循环节拍),超时抛错——长轮询后台循环的确定性同步点 */
async function until(cond: () => boolean, label: string, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`until 超时: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 预录 getUpdates 第一批:私聊文本 + edited_message 变体(P0 忽略)+ 群聊 @bot + 群聊无 @(userDisplay 仅 username) */
const BATCH1 = {
  ok: true,
  result: [
    { update_id: 100, message: { message_id: 11, from: { id: 42, is_bot: false, first_name: 'Ada', username: 'ada_w' }, chat: { id: 42, type: 'private' }, date: 1700000000, text: 'hello bot' } },
    { update_id: 101, edited_message: { message_id: 11, from: { id: 42, is_bot: false, first_name: 'Ada' }, chat: { id: 42, type: 'private' }, date: 1700000000, edit_date: 1700000042, text: 'hello bot(改)' } },
    { update_id: 102, message: { message_id: 12, from: { id: 7, is_bot: false, first_name: 'Bob', username: 'bob_u' }, chat: { id: -100200, type: 'supergroup' }, date: 1700000001, text: '@sunshine_bot 帮我看下构建' } },
    { update_id: 103, message: { message_id: 13, from: { id: 9, is_bot: false, username: 'carol_u' }, chat: { id: -100200, type: 'supergroup' }, date: 1700000002, text: '普通群聊消息,没有 @ 机器人' } },
  ],
};

test('① 映射:预录 getUpdates → InboundMessage 字段全对(edited_message 忽略/私聊恒 atBot/群聊 @ 头部判定)', async () => {
  const got: InboundMessage[] = [];
  let getCalls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => { release = r; });
  const fetchImpl: typeof fetch = async () => {
    getCalls++;
    if (getCalls === 1) return jsonOk(BATCH1);
    await gate; // 第二拍挂起:测试 stop 后放行,避免循环空转
    return jsonOk({ ok: true, result: [] });
  };
  const ad = new TelegramAdapter(cfg(), { secret: 'SEC', ident: {}, fetchImpl }, async () => {});
  await ad.start((m) => got.push(m));
  await until(() => got.length === 3, 'sink 收满 3 条(edited_message 被忽略)');
  assert.equal(ad.health().connected, true);
  await ad.stop();
  release!();
  await until(() => ad.health().connected === false, '循环退场');
  assert.deepEqual(got[0], {
    channel: 'tg1', chatId: '42', chatKind: 'direct', userId: '42',
    userDisplay: 'Ada', msgId: '11', text: 'hello bot', atBot: true, raw: BATCH1.result[0],
  });
  assert.deepEqual(got[1], {
    channel: 'tg1', chatId: '-100200', chatKind: 'group', userId: '7',
    userDisplay: 'Bob', msgId: '12', text: '@sunshine_bot 帮我看下构建', atBot: true, raw: BATCH1.result[2],
  });
  assert.deepEqual(got[2], {
    channel: 'tg1', chatId: '-100200', chatKind: 'group', userId: '9',
    userDisplay: 'carol_u', msgId: '13', text: '普通群聊消息,没有 @ 机器人', atBot: false, raw: BATCH1.result[3],
  });
});

test('② offset 推进:第二轮 getUpdates URL 带 offset=上批最大 update_id+1', async () => {
  const urls: string[] = [];
  let getCalls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => { release = r; });
  const fetchImpl: typeof fetch = async (url) => {
    getCalls++;
    urls.push(String(url));
    if (getCalls === 1) return jsonOk({ ok: true, result: [{ update_id: 500 }, { update_id: 501 }] });
    await gate;
    return jsonOk({ ok: true, result: [] });
  };
  const ad = new TelegramAdapter(cfg(), { secret: 'T', ident: {}, fetchImpl }, async () => {});
  await ad.start(() => {});
  await until(() => getCalls === 2, '第二轮 getUpdates 发起');
  assert.ok(urls[0]!.includes('/botT/getUpdates'), 'URL 含 token 与 getUpdates');
  assert.ok(urls[0]!.includes('timeout=25') && urls[0]!.includes('offset=0'), '首拍 timeout=25&offset=0');
  assert.ok(urls[1]!.includes('offset=502'), '次拍 offset=max(500,501)+1');
  await ad.stop();
  release!();
});

test('③ send:请求 URL 含 token 与 sendMessage,body 为 {chat_id, text}', async () => {
  const posts: { url: string; init: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    posts.push({ url: String(url), init: init ?? {} });
    return jsonOk({ ok: true, result: { message_id: 1 } });
  };
  const ad = new TelegramAdapter(cfg(), { secret: 'TOK123', ident: {}, fetchImpl }, async () => {});
  await ad.send({ channelId: 'tg1', chatId: '-100200' }, { text: '你好' });
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.init.method, 'POST');
  assert.ok(posts[0]!.url.includes('/botTOK123/sendMessage'), 'URL 含 token 与 sendMessage');
  assert.deepEqual(JSON.parse(String(posts[0]!.init.body)), { chat_id: '-100200', text: '你好' });
});

test('④ 错误退避:fetch 抛错/HTTP 非 ok → delay(5000) 续轮,正常轮零间隔', async () => {
  const delays: number[] = [];
  const logs: string[] = [];
  let getCalls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => { release = r; });
  const fetchImpl: typeof fetch = async () => {
    getCalls++;
    if (getCalls === 1) throw new Error('network down'); // 抛错路径
    if (getCalls === 2) return new Response('boom', { status: 500 }); // HTTP 非 ok 路径
    await gate;
    return jsonOk({ ok: true, result: [] });
  };
  const ad = new TelegramAdapter(
    cfg(),
    { secret: 'T', ident: {}, fetchImpl, log: (s) => logs.push(s) },
    async (ms) => { delays.push(ms); },
  );
  await ad.start(() => {});
  await until(() => delays.length >= 2, '两次退避发生');
  assert.deepEqual(delays, [5000, 5000]); // 抛错与 HTTP 500 各退避一次 5000
  assert.equal(ad.health().connected, true, '退避中循环仍存活');
  assert.equal(getCalls, 3, '退避后续轮已发起(循环未被错误打断)');
  assert.ok(logs.some((s) => s.includes('5000') || s.includes('退避')), '错误路径有 log');
  await ad.stop();
  release!();
  await until(() => delays.length >= 3, '正常轮零间隔续拍');
  assert.deepEqual(delays, [5000, 5000, 0]);
});

test('⑤ stop 退场:置位后循环下一拍退出,不再发起新轮询,health disconnected', async () => {
  let getCalls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => { release = r; });
  const fetchImpl: typeof fetch = async () => {
    getCalls++;
    if (getCalls === 1) return jsonOk({ ok: true, result: [] });
    await gate; // 第二拍挂起:stop 后放行
    return jsonOk({ ok: true, result: [] });
  };
  const ad = new TelegramAdapter(cfg(), { secret: 'T', ident: {}, fetchImpl }, async () => {});
  await ad.start(() => {});
  await until(() => getCalls === 2, '循环已在第二拍挂起');
  assert.equal(ad.health().connected, true);
  await ad.stop();
  assert.equal(ad.health().connected, false, 'stop 即刻 disconnected');
  release!();
  await new Promise((r) => setTimeout(r, 30)); // 让出数拍,确认无新轮询
  assert.equal(getCalls, 2, '循环已退出,没有第三拍');
});
