import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { render } from '../test-ink';
import { StatusBar } from './StatusBar';
import { StatusMetrics, SessionStatus } from '../session';

function metrics(over: Partial<StatusMetrics>): StatusMetrics {
  return { turnStartedAt: 0, turnTokens: 1200, turnCacheTokens: 0, runs: 5, hitRate: 0.83, ...over };
}

function frameOf(m: StatusMetrics, model?: string, status: SessionStatus = 'idle'): string {
  const { lastFrame, unmount } = render(<StatusBar metrics={m} status={status} todos={[]} model={model} />);
  const f = lastFrame() ?? '';
  unmount();
  return f;
}

test('StatusBar：显示模型名', () => {
  const f = frameOf(metrics({}), 'glm-5.3-flash');
  assert.match(f, /glm-5\.3-flash/, '状态栏应显示模型名');
});

test('StatusBar：turnStartedAt>0 显示本轮耗时', () => {
  const f = frameOf(metrics({ turnStartedAt: Date.now() - 8300 }), 'm');
  assert.match(f, /\d+(\.\d+)?s/, '状态栏应显示耗时');
});

test('StatusBar：turnStartedAt=0 不显示耗时', () => {
  const f = frameOf(metrics({ turnStartedAt: 0 }), 'm');
  assert.ok(!f.match(/\ds\b/), '未运行不应显示耗时');
});

test('StatusBar：无 model 不显示模型段', () => {
  const f = frameOf(metrics({}));
  assert.ok(!f.includes('model'), '无模型名不显示 model 字样');
});

test('StatusBar：本轮缓存命中率取 prompt 缓存真实占比', () => {
  const f = frameOf(metrics({ turnTokens: 1000, turnCacheTokens: 640 }), 'm');
  assert.match(f, /缓存 64%/, '命中率应为命中 tokens / 本轮 tokens');
});
