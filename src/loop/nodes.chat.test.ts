import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'node:assert/strict';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import type { ChatRequest, ChatResult } from '../types';

/**
 * T5（原生 function calling 迁移）独立小调用 tools 面红灯：
 * 四个独立一次性调用（不进主链、不上下文连续）从 complete(prompt) 文本协议迁到 chat({messages,tools})，
 * 判据回喂/tool_result 观察行语义保持：
 * ①判据评估（loop judge）——submit_verdict 三值经 tools 字段强约束；判据观察回喂 role:user tool_observation
 * ②压缩摘要（summarizer）——函数出牌
 * ③记忆提取（memory extractor）——结构化 items；门禁「provider==='openai'」改「具备 tools 面」（Stub/Scripted 静默跳过语义保持）
 * ④learned 提炼（learned-extract）——结构化 refined
 * 共同不变量：失败/空产出/畸形回退路径逐字节保持（fail-bounded 不变）
 */

/** 脚本化 chat 桩：按脚本逐轮出牌，记录请求（messages/tools）供断言 */
class ChatScriptStub implements ModelAdapter {
  readonly provider = 'openai';
  private i = 0;
  readonly requests: ChatRequest[] = [];
  constructor(private steps: ChatResult[]) {}
  async complete(): Promise<string> {
    throw new Error('complete must not be called on the chat path');
  }
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(req);
    const s = this.steps[Math.min(this.i, this.steps.length - 1)];
    this.i += 1;
    return s;
  }
  async chatStream(req: ChatRequest, onDelta: (t: string) => void): Promise<ChatResult> {
    const r = await this.chat(req);
    for (const ch of r.content) onDelta(ch);
    return r;
  }
}

test('判据评估走 tools 字段（submit_verdict 结构化出牌，零文本协议解析）', async () => {
  const stub = new ChatScriptStub([
    {
      finish: 'tool_calls',
      content: '',
      toolCalls: [
        {
          id: 'call_0',
          name: 'submit_verdict',
          argsJson: JSON.stringify({ passed: true, verdict: 'met', evidence: 'reply shows the fix' }),
        },
      ],
    },
  ]);
  const { modelJudge } = await import('./nodes');
  const outcome = await modelJudge(stub, { id: 'c1', desc: 'bug is fixed' }, 'fix the bug', 'fixed it');
  assert.equal(outcome.kind, 'judged');
  if (outcome.kind !== 'judged') return;
  assert.equal(outcome.result.passed, true);
  assert.equal(outcome.result.verdict, undefined); // verdict 仅 impossible 落盘（既有裁决），met 由 passed 推导
  // tools 字段含 submit_verdict 结构化声明（parameters 强约束三值）
  const names = (stub.requests[0].tools ?? []).map((t) => t.function.name);
  assert.deepEqual(names, ['submit_verdict']);
});

test('记忆提取门禁改为「具备 tools 面」判定（Stub/Scripted 静默跳过语义保持）', async () => {
  const { settleMemory } = await import('../harness/memory/extractor');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t5-mem-'));
  try {
    // ScriptedAdapter 不具备真实 tools 面（provider 门禁）→ 静默零提取零调用
    const scripted = new ScriptedAdapter(['not used']);
    const saved = await settleMemory({ goal: 'g', reply: 'r', model: scripted, root });
    assert.deepEqual(saved, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('压缩摘要走 chat 面（tools 字段 submit_summary）', async () => {
  const stub = new ChatScriptStub([
    {
      finish: 'tool_calls',
      content: '',
      toolCalls: [
        {
          id: 'call_0',
          name: 'submit_summary',
          argsJson: JSON.stringify({
            goal: 'fix the bug',
            constraints: 'keep API stable',
            progress: 'root cause found',
            verified: 'test passes',
            open: 'none',
            rationale: 'minimal fix',
          }),
        },
      ],
    },
  ]);
  const { summarizeWithModel } = await import('../harness/context/summarizer');
  const summary = await summarizeWithModel(stub, [{ id: 'c1', summary: 'line1', type: 'history', priority: 1 }], 100);
  assert.ok(summary, 'summary must be produced from structured submit_summary');
  assert.match(summary!, /fix the bug/);
  const names = (stub.requests[0].tools ?? []).map((t) => t.function.name);
  assert.deepEqual(names, ['submit_summary']);
});

test('learned 提炼走 chat 面（tools 字段 submit_refined_skill）', async () => {
  const stub = new ChatScriptStub([
    {
      finish: 'tool_calls',
      content: '',
      toolCalls: [
        {
          id: 'call_0',
          name: 'submit_refined_skill',
          argsJson: JSON.stringify({
            skill: {
              name: 'fix-flaky-tests',
              description: 'Stabilize flaky async tests by pinning data dirs',
              body: '## When to Use\nflaky tests\n## Procedure\npin dirs\n## Pitfalls\nshared dirs race\n## Verification\nrerun 10x',
            },
          }),
        },
      ],
    },
  ]);
  const { extractLearnedSkill } = await import('../harness/skills/learned-extract');
  const out = await extractLearnedSkill(stub, { goal: 'g', reply: 'r', outcome: 'done', digest: 'd' });
  assert.ok(out?.skill, 'refined skill must be produced');
  assert.equal(out!.skill!.name, 'fix-flaky-tests');
  const names = (stub.requests[0].tools ?? []).map((t) => t.function.name);
  assert.deepEqual(names, ['submit_refined_skill']);
});

test('记忆提取走 chat 面（tools 字段 submit_memory_items，五重闸门不变）', async () => {
  const stub = new ChatScriptStub([
    {
      finish: 'tool_calls',
      content: '',
      toolCalls: [
        {
          id: 'call_0',
          name: 'submit_memory_items',
          argsJson: JSON.stringify({
            items: [
              { type: 'project', description: 'T1 committed', content: `Param declarations landed in ${'2026-09-20'} commit` },
            ],
          }),
        },
      ],
    },
    { finish: 'stop', content: '', toolCalls: [] },
  ]);
  const { settleMemory } = await import('../harness/memory/extractor');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-t5-mem2-'));
  try {
    const saved = await settleMemory({ goal: 'g', reply: 'r', model: stub, root });
    assert.equal(saved.length, 1, 'one item must be admitted');
    const names = (stub.requests[0].tools ?? []).map((t) => t.function.name);
    assert.deepEqual(names, ['submit_memory_items']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
