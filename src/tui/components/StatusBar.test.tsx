import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../test-ink';
import { StatusBar, fitStatusLine } from './StatusBar';
import { StatusMetrics, SessionStatus } from '../session';
import { setLanguage } from '../../i18n';
import { displayWidth } from '../text-band';

function metrics(over: Partial<StatusMetrics>): StatusMetrics {
  return { turnStartedAt: 0, turnTokens: 1200, turnPromptTokens: 1200, turnCacheTokens: 0, sessionCacheTokens: 0, sessionPromptTokens: 0, sessionTurns: 0, sessionSteps: 0, runs: 5, ctxUsed: 0, turnChildTokens: 0, sessionChildTokens: 0, sessionTotalTokens: 0, ...over };
}

function frameOf(m: StatusMetrics, model?: string, status: SessionStatus = 'idle', context?: { used: number; window: number }): string {
  const { lastFrame, unmount } = render(<StatusBar metrics={m} status={status} model={model} context={context} />);
  const f = lastFrame() ?? '';
  unmount();
  return f;
}

test('StatusBar：显示模型名', () => {
  const f = frameOf(metrics({}), 'glm-5.3-flash');
  assert.match(f, /glm-5\.3-flash/, '状态栏应显示模型名');
});

test('StatusBar：不显示耗时（耗时只在活动行展示，状态栏不冗余重复）', () => {
  assert.ok(!frameOf(metrics({ turnStartedAt: Date.now() - 8300 }), 'm').match(/\d+(\.\d+)?s\b/), '运行中状态栏不显示耗时');
  assert.ok(!frameOf(metrics({ turnStartedAt: 0 }), 'm').match(/\d+(\.\d+)?s\b/), '空闲状态栏不显示耗时');
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

test('StatusBar：↑tokens 为会话累计总量（主链+子代理、跨任务累计；非本轮口径）', () => {
  // 本轮 1200+2600、会话累计 2601k：显示应锚定会话累计口径，与本轮清零无关
  const f = frameOf(metrics({ turnTokens: 1200, turnChildTokens: 2_600, sessionTotalTokens: 2_601_000 }), 'm');
  assert.match(f, /↑2601k tokens/, '↑tokens = 会话累计总量（Σ主链+Σ子代理）');
});

test('StatusBar：↑tokens 会话累计与本轮瞬时值解耦（轮内早期累计远大于本轮）', () => {
  const f = frameOf(metrics({ turnTokens: 500, turnChildTokens: 0, sessionTotalTokens: 900_000 }), 'm');
  assert.match(f, /↑900k tokens/, '↑tokens 不随轮归零，跨任务持续累计');
});

test('StatusBar：ctx 水位与 cache 口径不受子代理 tokens 影响（维持仅主链）', () => {
  const f = frameOf(
    metrics({ turnChildTokens: 5_000_000, turnPromptTokens: 1000, sessionPromptTokens: 1000, sessionCacheTokens: 640 }),
    'm', 'idle', { used: 1000, window: 100_000 },
  );
  assert.match(f, /ctx 1\.0k\/100k \(\d+(\.\d+)?%\)/, 'ctx 维持主链口径');
  assert.match(f, /cache 64\.0%/, 'cache 维持主链口径（cached/prompt）');
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

test('StatusBar：恒 1 行段降级（2026-10-02「流式闪动」收尾钉）——超宽段按优先级离场（effort→model→turns→cache→ctx），tokens 与状态词恒保留，丢尽仍超宽整行省略', () => {
  const head = ' ↑1234k tokens';
  const mids = [
    { text: ' · ctx 456k/1M (45.6%)', prio: 1 },
    { text: ' · cache 78.9%', prio: 2 },
    { text: ' · 12 turns · 34 steps', prio: 3 },
    { text: ' · glm-9.9-pro-preview', prio: 4 },
    { text: ' · effort high', prio: 5 },
  ];
  const wide = fitStatusLine(head, mids, ' · 运行中', 125);
  assert.ok(wide.includes('effort high') && wide.includes('ctx 456k'), '宽屏（125 列）全段保留');
  const narrow = fitStatusLine(head, mids, ' · 运行中', 60);
  assert.ok(!narrow.includes('effort high'), 'effort 最先离场');
  assert.ok(!narrow.includes('glm-9.9'), 'model 次之');
  assert.ok(narrow.includes('↑1234k tokens') && narrow.includes('运行中'), 'head/tail 恒保留');
  assert.ok(displayWidth(narrow) <= 59, `降级后 ≤ 列宽-1（实际 ${displayWidth(narrow)}）`);
  const tiny = fitStatusLine(head, mids, ' · 运行中', 20);
  assert.ok(!tiny.includes('\n') && displayWidth(tiny) <= 19, '极窄整行省略仍恒 1 行');
});

test('StatusBar：渲染面窄终端恒 1 行——裸 Text 自然折行即击穿 App previewCap 的 chrome 实账（+1 行），动态帧触顶走 ink3 clearTerminal 整屏重放=闪屏源', () => {
  const m = metrics({ sessionTotalTokens: 1_234_567, sessionPromptTokens: 510_000, sessionCacheTokens: 500_000, sessionTurns: 12, sessionSteps: 34 });
  const one = render(
    <StatusBar metrics={m} status="running" model="glm-9.9-pro-preview" effort="high" context={{ used: 456_000, window: 1_000_000 }} />,
    40,
  );
  const f = one.lastFrame() ?? '';
  assert.equal(f.replace(/\n$/, '').split('\n').length, 1, '窄终端（40 列）状态栏不折行（恒 1 行）');
  assert.match(f, /↑/, 'tokens 段恒在场');
  one.unmount();
});
