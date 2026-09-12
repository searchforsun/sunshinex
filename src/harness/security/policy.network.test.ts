import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityGuard } from './guard';

test('WebFetch 闸门：非法 scheme 拒绝', () => {
  const g = new SecurityGuard(undefined, 'dontAsk', ['127.0.0.1']);
  const d = g.preToolUse('WebFetch', { url: 'ftp://127.0.0.1/x' });
  assert.equal(d.allowed, false);
});

test('WebFetch 闸门：白名单内 http 域名放行', () => {
  const g = new SecurityGuard(undefined, 'dontAsk', ['127.0.0.1']);
  const d = g.preToolUse('WebFetch', { url: 'http://127.0.0.1:8080/x' });
  assert.ok(d.allowed);
});

test('WebFetch 闸门：URL 非法拒绝', () => {
  const g = new SecurityGuard(undefined, 'dontAsk', ['127.0.0.1']);
  const d = g.preToolUse('WebFetch', { url: 'not-a-url' });
  assert.equal(d.allowed, false);
});

test('WebSearch 闸门：端点主机在白名单放行，空名单全禁', () => {
  const g = new SecurityGuard(undefined, 'dontAsk', ['html.duckduckgo.com']);
  assert.ok(g.preToolUse('WebSearch', { query: '部署' }).allowed);
  const denied = new SecurityGuard(undefined, 'dontAsk', ['example.com']);
  assert.equal(denied.preToolUse('WebSearch', { query: '部署' }).allowed, false);
  assert.equal(new SecurityGuard(undefined, 'dontAsk').preToolUse('WebSearch', {}).allowed, false);
});

test('WebSearch 闸门：WEBSEARCH_ENDPOINT 覆盖后按新主机判界', () => {
  process.env.WEBSEARCH_ENDPOINT = 'http://127.0.0.1:9/search';
  try {
    const g = new SecurityGuard(undefined, 'dontAsk', ['127.0.0.1']);
    assert.ok(g.preToolUse('WebSearch', { query: 'x' }).allowed);
    const denied = new SecurityGuard(undefined, 'dontAsk', ['html.duckduckgo.com']);
    assert.equal(denied.preToolUse('WebSearch', { query: 'x' }).allowed, false);
  } finally {
    delete process.env.WEBSEARCH_ENDPOINT;
  }
});

test('mcp__ 工具闸门：服务器清单空 = 全禁（缺省安全）', () => {
  const g = new SecurityGuard(undefined, 'dontAsk');
  const d = g.preToolUse('mcp__fs__read', {});
  assert.equal(d.allowed, false);
});

test('mcp__ 工具闸门：已登记服务器放行，未登记拒绝', () => {
  const g = new SecurityGuard(undefined, 'dontAsk', [], ['fs']);
  assert.ok(g.preToolUse('mcp__fs__read', {}).allowed);
  assert.equal(g.preToolUse('mcp__other__call', {}).allowed, false);
});
