import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { render } from '../test-ink';
import { StatusBar } from './StatusBar';
import { StatusMetrics, SessionStatus } from '../session';
import { setLanguage } from '../../i18n';

function metrics(over: Partial<StatusMetrics>): StatusMetrics {
  return { turnStartedAt: 0, turnTokens: 1200, turnPromptTokens: 1200, turnCacheTokens: 0, sessionCacheTokens: 0, sessionPromptTokens: 0, sessionTurns: 0, sessionSteps: 0, runs: 5, ctxUsed: 0, ...over };
}

function frameOf(m: StatusMetrics, model?: string, status: SessionStatus = 'idle', context?: { used: number; window: number }): string {
  const { lastFrame, unmount } = render(<StatusBar metrics={m} status={status} todos={[]} model={model} context={context} />);
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

test('StatusBar：缓存命中率取 cached/prompt（分母不含输出 token）', () => {
  const f = frameOf(metrics({ turnTokens: 1300, sessionPromptTokens: 1000, sessionCacheTokens: 640 }), 'm');
  assert.match(f, /cache 64\.0%/, '命中率应为 cached_tokens / prompt_tokens，而非 cached/total');
});

test('StatusBar：cache 段为会话累计口径——取 session 累计、保留一位小数（轮首 miss 不砸零）', () => {
  // 本轮 0/29000（轮首 miss），会话累计 500k/510k：显示应锚定会话口径 98.0%，不受本轮清零影响
  const f = frameOf(metrics({ turnPromptTokens: 29_000, turnCacheTokens: 0, sessionPromptTokens: 510_000, sessionCacheTokens: 500_000 }), 'm');
  assert.match(f, /cache 98\.0%/, 'cache 段应显示会话累计命中率（Σcached/Σprompt，一位小数）');
});

test('StatusBar：会话无请求时分母为零，cache 显示 0% 不除零', () => {
  const f = frameOf(metrics({ sessionPromptTokens: 0, sessionCacheTokens: 0 }), 'm');
  assert.match(f, /cache 0%/, '零样本应显示 cache 0%');
});

test('StatusBar：会话累计保留一位小数（99.7% 形态对齐用户裁决）', () => {
  const f = frameOf(metrics({ turnPromptTokens: 0, turnCacheTokens: 0, sessionPromptTokens: 30_500, sessionCacheTokens: 29_000 }), 'm');
  assert.match(f, /cache 95\.1%/, '29000/30500 ≈ 95.082% → 95.1%');
});

test('StatusBar：配置窗口时显示上下文占用段（used/window 百分比，一位小数）', () => {
  const f = frameOf(metrics({ ctxUsed: 250_000 }), 'm', 'idle', { used: 250_000, window: 1_000_000 });
  assert.match(f, /ctx 250k\/1000k \(25\.0%\)/, '状态栏应显示 ctx 水位/窗口（百分比，一位小数）');
});

test('StatusBar：ctx 一位小数——1M 窗口下小水位不被整数四舍五入成 0%', () => {
  // 实际形态：3.2k/1000k = 0.32%；整数口径显示 (0%) 看不出水位，且与 cache 段一位小数口径不一致
  const f = frameOf(metrics({ ctxUsed: 3_200 }), 'm', 'idle', { used: 3_200, window: 1_000_000 });
  assert.match(f, /ctx 3\.2k\/1000k \(0\.3%\)/, '3.2k/1000k 应显示 0.3%');
});

test('StatusBar：ctx 零水位显示 (0%) 而非 (0.0%)（与 cache 零样本口径一致）', () => {
  const f = frameOf(metrics({}), 'm', 'idle', { used: 0, window: 1_000_000 });
  assert.match(f, /ctx 0\/1000k \(0%\)/, '零水位应显示 0%');
});

test('StatusBar：未配置窗口不显示上下文占用段', () => {
  const f = frameOf(metrics({}), 'm');
  assert.ok(!f.includes('上下文'), '无 context 时不得显示该段');
});

test('StatusBar：zh 语言状态词中文（idle→空闲；用后复原）', () => {
  setLanguage('zh');
  try {
    const f = frameOf(metrics({}), 'm', 'idle');
    assert.match(f, /空闲/, 'zh 下状态词应为中文');
    assert.ok(!/idle\b/.test(f), 'zh 下不得再出英文状态词');
  } finally {
    setLanguage('en');
  }
});

test('StatusBar：turns/steps 段（会话累计轮次与步数，固定复数形态）', () => {
  const f = frameOf(metrics({ sessionTurns: 1, sessionSteps: 30 }), 'm');
  assert.match(f, /1 turns · 30 steps/, '状态栏应显示 1 turns · 30 steps（用户裁决形态）');
});

test('StatusBar：模型段去掉 model 前缀字样（纯模型名，不带 provider）', () => {
  const f = frameOf(metrics({}), 'glm-5.3-flash');
  assert.ok(!f.includes('model '), '不得再显示 model 前缀字样');
  assert.match(f, /glm-5.3-flash/, '模型名保留');
});

test('StatusBar：全新会话（0 轮 0 步）不显示 turns/steps 段', () => {
  const f = frameOf(metrics({ sessionTurns: 0, sessionSteps: 0 }), 'm');
  assert.ok(!f.includes('turns'), '零样本不显示轮/步段');
});
