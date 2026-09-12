import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityGuard } from './guard';

test('WebFetch 闸门：URL 合法即可放行（无域名限制）', () => {
  const g = new SecurityGuard(undefined, 'dontAsk');
  assert.ok(g.preToolUse('WebFetch', { url: 'http://127.0.0.1:8080/x' }).allowed);
  assert.ok(g.preToolUse('WebFetch', { url: 'https://example.com/docs' }).allowed);
});

test('WebFetch 闸门：非法 scheme 拒绝', () => {
  const g = new SecurityGuard(undefined, 'dontAsk');
  assert.equal(g.preToolUse('WebFetch', { url: 'ftp://127.0.0.1/x' }).allowed, false);
});

test('WebFetch 闸门：URL 非法拒绝', () => {
  const g = new SecurityGuard(undefined, 'dontAsk');
  assert.equal(g.preToolUse('WebFetch', { url: 'not-a-url' }).allowed, false);
});

test('WebSearch 闸门：缺省端点放行（无域名限制）', () => {
  const g = new SecurityGuard(undefined, 'dontAsk');
  assert.ok(g.preToolUse('WebSearch', { query: '部署' }).allowed);
});

test('WebSearch 闸门：WEBSEARCH_ENDPOINT 覆盖后按新端点判界', () => {
  process.env.WEBSEARCH_ENDPOINT = 'http://127.0.0.1:9/search';
  try {
    const g = new SecurityGuard(undefined, 'dontAsk');
    assert.ok(g.preToolUse('WebSearch', { query: 'x' }).allowed);
  } finally {
    delete process.env.WEBSEARCH_ENDPOINT;
  }
});

test('WebSearch 闸门：覆盖端点非 http/https 拒绝', () => {
  process.env.WEBSEARCH_ENDPOINT = 'ftp://127.0.0.1/q';
  try {
    const g = new SecurityGuard(undefined, 'dontAsk');
    assert.equal(g.preToolUse('WebSearch', { query: 'x' }).allowed, false);
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
  const g = new SecurityGuard(undefined, 'dontAsk', ['fs']);
  assert.ok(g.preToolUse('mcp__fs__read', {}).allowed);
  assert.equal(g.preToolUse('mcp__other__call', {}).allowed, false);
});
