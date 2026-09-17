import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import { Harness } from '../harness';
import { TuiRuntime } from './runtime';

/** Task 5（规格 D 项）：/compact [focus] + 观测小件（自动压缩消息流留痕、轮首 miss 提示） */

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** usage 计数桩：首帧 (cache, prompt) 可编程，回传后走 done */
function usageOnce(cache: number, prompt: number): ModelAdapter {
  let asked = false;
  return {
    provider: 'usage-once-script',
    complete: async (
      _p: string,
      hooks?: { onUsage?: (t: number) => void; onCache?: (t: number) => void; onPrompt?: (t: number) => void },
    ) => {
      if (!asked) {
        asked = true;
        hooks?.onPrompt?.(prompt);
        hooks?.onCache?.(cache);
        hooks?.onUsage?.(120);
      }
      return '{"done":true,"reply":"ok"}';
    },
  };
}

test('Task5 /compact 带 focus：压缩照常且 focus 透传（摘要 prompt 含关注点）', async () => {
  const tmp = tmpdir('sunshinex-task5-focus-');
  try {
    const seen: string[] = [];
    const SUMMARY = '## Goal\n演示\n## Constraints\n只读\n## Progress\n已折叠\n## Verified\n回执一致\n## Open\n无\n## Rationale\n会话模型路径';
    const harness = new Harness({
      root: tmp,
      mode: 'dontAsk',
      model: {
        provider: 'openai',
        complete: async (p) => {
          seen.push(p);
          return p.includes('handoff summary') ? SUMMARY : '{"done":true,"reply":"ok"}';
        },
      },
    });
    harness.context.appendChain([
      { action: 'read', observation: 'Y'.repeat(2000) },
      { action: 'read', observation: 'Z'.repeat(2000) },
    ]);
    const fake: TuiRuntime = {
      harness,
      runTask: async () => ({ done: true, reply: 'ok', tokensUsed: 0, stopReason: 'done' }),
      runLoop: async () => {
        throw new Error('runLoop not exercised');
      },
    };
    const ctrl = new SessionController({ root: tmp, runtime: fake });
    await ctrl.submit('/compact 保留迁移细节');
    const texts = ctrl.getState().messages.filter((m) => m.role === 'system').map((m) => m.text).join('\n');
    assert.match(texts, /Compressed: \d+ summary chunks re-injected/, '压缩回执照常上屏');
    assert.equal(harness.context.chainView().length, 0, '链前缀已折叠');
    const summaryCall = seen.find((p) => p.includes('handoff summary'));
    assert.ok(summaryCall, '应发起摘要调用');
    assert.match(summaryCall, /保留迁移细节/, 'focus 应透传进摘要 prompt');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task5 /compact 无参：压缩照常，摘要 prompt 不含关注点段', async () => {
  const tmp = tmpdir('sunshinex-task5-nofocus-');
  try {
    const seen: string[] = [];
    const SUMMARY = '## Goal\n演示\n## Constraints\n只读\n## Progress\n已折叠\n## Verified\n回执一致\n## Open\n无\n## Rationale\n会话模型路径';
    const harness = new Harness({
      root: tmp,
      mode: 'dontAsk',
      model: {
        provider: 'openai',
        complete: async (p) => {
          seen.push(p);
          return p.includes('handoff summary') ? SUMMARY : '{"done":true,"reply":"ok"}';
        },
      },
    });
    harness.context.appendChain([{ action: 'read', observation: 'Y'.repeat(2000) }]);
    const fake: TuiRuntime = {
      harness,
      runTask: async () => ({ done: true, reply: 'ok', tokensUsed: 0, stopReason: 'done' }),
      runLoop: async () => {
        throw new Error('runLoop not exercised');
      },
    };
    const ctrl = new SessionController({ root: tmp, runtime: fake });
    await ctrl.submit('/compact');
    assert.match(ctrl.getState().messages.map((m) => m.text).join('\n'), /Compressed: \d+ summary chunks/);
    const summaryCall = seen.find((p) => p.includes('handoff summary'));
    assert.ok(summaryCall);
    assert.doesNotMatch(summaryCall, /Focus|关注点/, '无 focus 时不应出现关注点段');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task5 自动压缩完成 → 消息流留痕一条 Context compacted 系统消息', async () => {
  const tmp = tmpdir('sunshinex-task5-trace-');
  try {
    // 大观察驱动自动压缩：/goal·long-task 模板 maxTokens=1M → reactor 预算 total=剩余量，
    // 压缩线 = total − total/5（首 run ≈ 1M−200k = 800k）；大链行需越过该线（CJK 1:1 计权）
    const big = ('x'.repeat(180) + '\n').repeat(18000); // ≈ 3.24M chars ≈ 810k tokens，越过 800k 触发线
    const adapter = {
      provider: 'openai',
      complete: async (p: string) => (p.includes('handoff summary') ? '占位' : JSON.stringify({ tool: 'read', input: { path: 'a.txt' } })),
      completeStream: async (p: string, onDelta: (t: string) => void) => {
        const out = p.includes('handoff summary') ? '占位' : JSON.stringify({ done: true, reply: 'ok' });
        for (const ch of out) onDelta(ch);
        return out;
      },
    } as unknown as ModelAdapter;
    const ctrl = new SessionController({ root: tmp, model: adapter });
    ctrl.context.appendChain([{ action: 'seed', observation: big }]);
    await ctrl.submit('run');
    await ctrl.waitIdle();
    const trace = ctrl.getState().messages.filter((m) => m.role === 'system' && m.text.includes('Context compacted'));
    assert.equal(trace.length, 1, '自动压缩留痕恰一条');
    assert.match(trace[0].text, /ctx \d+ → \d+/, '留痕含水位 before → after');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task5 轮首首个 usage cache=0 且 prompt≥50k → 提示一次；同任务后续 usage 不再提示', async () => {
  const tmp = tmpdir('sunshinex-task5-miss1-');
  try {
    const ctrl = new SessionController({ root: tmp, model: usageOnce(0, 60_000) });
    await ctrl.submit('run');
    await ctrl.waitIdle();
    const hints = () => ctrl.getState().messages.filter((m) => m.role === 'system' && m.text.includes('endpoint cache'));
    assert.equal(hints().length, 1, '轮首 miss 应提示一次');
    // 同任务第二条 usage（数值变化才入分流）不再提示
    ctrl.onEventForTest({ type: 'usage', ts: Date.now(), payload: { turnTotal: 90_000, cacheHitTotal: 30_000, promptTotal: 90_000 } });
    assert.equal(hints().length, 1, '同任务第二次 usage 不再提示');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task5 promptTotal < 50k 不提示', async () => {
  const tmp = tmpdir('sunshinex-task5-miss2-');
  try {
    const ctrl = new SessionController({ root: tmp, model: usageOnce(0, 10_000) });
    await ctrl.submit('t1');
    await ctrl.waitIdle();
    const hints = () => ctrl.getState().messages.filter((m) => m.role === 'system' && m.text.includes('endpoint cache'));
    assert.equal(hints().length, 0, '低于阈值不提示');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Task5 新任务轮首重置判定：上轮提示过，本轮轮首 miss 可再提示', async () => {
  const tmp = tmpdir('sunshinex-task5-miss3-');
  try {
    let mode: 'low' | 'high' = 'high';
    const model: ModelAdapter = {
      provider: 'usage-toggle-script',
      complete: async (
        _p: string,
        hooks?: { onUsage?: (t: number) => void; onCache?: (t: number) => void; onPrompt?: (t: number) => void },
      ) => {
        if (mode === 'high') {
          hooks?.onPrompt?.(60_000);
          hooks?.onCache?.(0);
          hooks?.onUsage?.(120);
        } else {
          hooks?.onPrompt?.(10_000);
          hooks?.onCache?.(0);
          hooks?.onUsage?.(60);
        }
        return '{"done":true,"reply":"ok"}';
      },
    };
    const ctrl = new SessionController({ root: tmp, model });
    await ctrl.submit('t1');
    await ctrl.waitIdle();
    const hints = () => ctrl.getState().messages.filter((m) => m.role === 'system' && m.text.includes('endpoint cache'));
    assert.equal(hints().length, 1, '第一轮轮首 miss 提示一次');
    mode = 'low';
    await ctrl.submit('t2');
    await ctrl.waitIdle();
    assert.equal(hints().length, 1, '第二轮低于阈值不提示（判定已重置，不叠加）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
