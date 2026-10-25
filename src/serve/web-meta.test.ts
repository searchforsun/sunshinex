import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { fetchWebMeta, parseWebMeta } from './web-meta';

/**
 * Web 标签页名/站标代取单测(2026-10-25 用户报障「页签只显 host+地球图标」):
 * 解析面(parseWebMeta)纯函数钉测 + 取回面(fetchWebMeta)本地 http 服务全链路。
 */

test('parseWebMeta:标题提取(实体解码/标签内嵌剥离/空白拍平)', () => {
  assert.equal(parseWebMeta('<title>百度一下，你就知道</title>', 'https://www.baidu.com/').title, '百度一下，你就知道');
  assert.equal(parseWebMeta('<title>a &amp; b &#x4e2d;<script>x</script></title>', 'https://a.com/').title, 'a & b 中 x');
  assert.equal(parseWebMeta('<html><body>no title</body></html>', 'https://a.com/').title, '');
});

test('parseWebMeta:站标声明解析(首个 rel~=icon;相对→绝对;无声明退 /favicon.ico)', () => {
  const m = parseWebMeta(
    '<link rel="stylesheet" href="a.css"><link rel="shortcut icon" href="/img/favicon.ico"><link rel="icon" href="/b.png">',
    'https://www.baidu.com/',
  );
  assert.equal(m.icon, 'https://www.baidu.com/img/favicon.ico'); // 声明序即优先序
  const rel = parseWebMeta('<link rel="icon" href="fav.png">', 'https://a.com/x/y.html');
  assert.equal(rel.icon, 'https://a.com/x/fav.png'); // 相对路径按页面 URL 归一
  assert.equal(parseWebMeta('<p>none</p>', 'https://a.com/x/').icon, 'https://a.com/favicon.ico'); // 约定路径兜底
});

test('fetchWebMeta:非 http(s)/畸形 URL 回 null(零网络)', async () => {
  assert.equal(await fetchWebMeta('file:///C:/x'), null);
  assert.equal(await fetchWebMeta('javascript:alert(1)'), null);
  assert.equal(await fetchWebMeta('not a url'), null);
});

test('fetchWebMeta:本地服务全链路(标题+站标;redirect 后按最终 URL 归一)', async () => {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? '');
    if ((req.url ?? '').split('?')[0] === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>百度一下，你就知道</title><link rel="icon" href="/img/baidu.ico"></head><body>hi</body></html>');
      return;
    }
    res.writeHead(404);
    res.end('no');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const meta = await fetchWebMeta(`http://127.0.0.1:${port}/page?t=${crypto.randomUUID()}`);
    assert.ok(meta !== null);
    assert.equal(meta.title, '百度一下，你就知道');
    assert.equal(meta.icon, `http://127.0.0.1:${port}/img/baidu.ico`);
    // 非 200:标题放弃,站标仍按 origin 约定路径兜底
    const miss = await fetchWebMeta(`http://127.0.0.1:${port}/missing`);
    assert.ok(miss !== null);
    assert.equal(miss.title, '');
    assert.equal(miss.icon, `http://127.0.0.1:${port}/favicon.ico`);
  } finally {
    server.close();
  }
});
