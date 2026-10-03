import { textReplyToChatFace } from '../../model/chat-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLanguage, setLanguage } from '../../i18n';
import { ContextChunk, estimateTokens } from './window';
import { isModelSummarizer, summarizeWithModel, trimToTokenBudget } from './summarizer';
import { buildSummaryPrompt } from '../prompts/summarizer';
import type { ModelAdapter } from '../../model/adapter';

function chunk(summary: string, type = 'history'): ContextChunk {
  return { id: summary.slice(0, 8), summary, type, priority: 1 };
}

const SIX_HEADINGS = ['## Goal', '## Constraints', '## Progress', '## Verified', '## Open', '## Rationale'];
const MARKER = 'handoff summary';

test('buildSummaryPrompt：六节标题 + 材料行 + 预算约束（en 缺省）', () => {
  const p = buildSummaryPrompt([chunk('旧上下文要点 a b c'), chunk('工具结果 x y z', 'result')], 2000);
  for (const h of SIX_HEADINGS) assert.ok(p.includes(h), `缺节标题 ${h}`);
  assert.ok(p.includes('- [history] 旧上下文要点 a b c'), '材料行应含类型与摘要');
  assert.ok(p.includes('- [result] 工具结果 x y z'));
  assert.ok(p.includes('2000'), '预算约束应注入目标 token 数');
  assert.ok(p.includes(MARKER), '固定标记供测试桩区分压缩调用');
  assert.match(p, /keep concrete facts/, '具体性条款在场：不可再生事实不得抽象化');
  assert.match(p, /cite where the full record lives/, '省略细节时必须留归档指针（写链面兜底）');
});

test('buildSummaryPrompt：语言轴不再影响提示词（zh 下仍英文单语）', () => {
  const prev = getLanguage();
  setLanguage('zh');
  try {
    const p = buildSummaryPrompt([chunk('材料')], 500);
    assert.ok(p.includes(MARKER));
    const template = p.split('Selected context:')[0];
    assert.ok(!/[\u4e00-\u9fff]/.test(template), 'zh 语言下模板段仍英文单语（§15：提示词恒英文；材料行是数据）');
    for (const h of SIX_HEADINGS) assert.ok(p.includes(h), '节名恒定英文（解析锚点）');
  } finally {
    setLanguage(prev);
  }
});

test('trimToTokenBudget：预算内原样返回；超预算二分截断至预算内且确定性', () => {
  assert.equal(trimToTokenBudget('abcd', 10), 'abcd');
  const long = 'x'.repeat(400); // ≈100 tokens
  const out = trimToTokenBudget(long, 50);
  assert.equal(out.length, 200, 'ASCII 4:1 → 50 tokens 恰 200 字符');
  assert.equal(out, trimToTokenBudget(long, 50), '同输入同输出（确定性）');
});

test('summarizeWithModel：成功返回模型正文（chat 面 submit_summary 六要素重组），prompt 含模板与材料', async () => {
  let seen = '';
  const model: ModelAdapter = {
    provider: 'openai',
    
    chat: async (req) => {
      seen = req.messages.map((m) => (m.role === 'user' ? m.content : '')).join('\n');
      const items = { goal: '完成压缩', constraints: '', progress: '', verified: '', open: '待验收', rationale: '' };
      return { finish: 'tool_calls', content: '', toolCalls: [{ id: 'call_0', name: 'submit_summary', argsJson: JSON.stringify(items) }] };
    },
  };
  const out = await summarizeWithModel(model, [chunk('材料 abc def')], 2000);
  assert.ok(out !== null && out.includes('## Goal') && out.includes('完成压缩'));
  assert.ok(out.includes('## Open') && out.includes('待验收'));
  assert.ok(seen.includes('## Rationale') && seen.includes('材料 abc def'));
});

test('summarizeWithModel：空输出与抛错一律 null（回退信号）', async () => {
  const nullStub = { provider: 'openai',  chat: async () => ({ finish: 'tool_calls', content: '', toolCalls: [] }) } as unknown as ModelAdapter;
  const boomStub = { provider: 'openai',  chat: async () => { throw new Error('boom'); } } as unknown as ModelAdapter;
  assert.equal(await summarizeWithModel(nullStub, [chunk('a b c d')], 100), null);
  assert.equal(await summarizeWithModel(boomStub, [chunk('a b c d')], 100), null);
});

test('summarizeWithModel：超预算正文确定性截断至预算内', async () => {
  const model = {
    provider: 'openai',
    
    chat: async () => ({ finish: 'tool_calls', content: '', toolCalls: [{ id: 'call_0', name: 'submit_summary', argsJson: JSON.stringify({ goal: 'y'.repeat(400), constraints: '', progress: '', verified: '', open: '', rationale: '' }) }] }),
  } as unknown as ModelAdapter;
  const out = await summarizeWithModel(model, [chunk('a b c d')], 50);
  assert.ok(out !== null && out.length <= 200);
  assert.ok(estimateTokens(out) <= 50);
});

test('summarizeWithModel：空选中块零模型调用直接 null', async () => {
  let calls = 0;
  const model = { provider: 'openai', chat: textReplyToChatFace(async () => { calls++; return 'x'; }) };
  assert.equal(await summarizeWithModel(model, [], 100), null);
  assert.equal(calls, 0);
});

test('isModelSummarizer：声明能力位（真实模型）才走模型摘要（J2 能力位门禁）', () => {
  assert.equal(isModelSummarizer(undefined), false);
  assert.equal(isModelSummarizer({ provider: 'stub', chat: textReplyToChatFace(async () => '' )}), false);
  assert.equal(isModelSummarizer({ provider: 'scripted', chat: textReplyToChatFace(async () => '' )}), false);
  // 字符串探针退役：provider === 'openai' 但未声明能力位（测试桩形态）不再命中
  assert.equal(isModelSummarizer({ provider: 'openai', chat: async () => ({ finish: 'stop', content: '', toolCalls: [] }) }), false);
  // 能力位缺 chat 函数面：双门不满足，不命中
  assert.equal(isModelSummarizer({ provider: 'openai', capabilities: { chat: true } } as unknown as ModelAdapter), false);
  assert.equal(isModelSummarizer({ provider: 'openai', capabilities: {}, chat: async () => ({ finish: 'stop', content: '', toolCalls: [] }) }), false);
  // J2 主证（钉）：任意供应商的假适配器只要声明能力位即走模型路径——新真实 provider 零代码接入，静默退化消除
  assert.equal(isModelSummarizer({ provider: 'other-vendor', capabilities: { chat: true }, chat: async () => ({ finish: 'stop', content: '', toolCalls: [] }) }), true);
});
