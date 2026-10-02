import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { ScriptedAdapter } from '../model/adapter';

/**
 * 回归（2026-09-25 用户截图「Subagent not found: null」）：
 * 模型按工具描述「null spawns an inline subagent」把 agent_id 写成字符串 "null"，
 * resolveSpawnSpec 将其视为有效 id → registry.resolve("null") 抛错 → 模型原样重试死循环。
 * 修法：可选点入参归一单点把 "null"/"undefined" 字面量字符串归一为 null，"null"+prompt 语义回到内联形态。
 */
test('agent_id 字符串 "null" 归一为内联 spawn（不抛 Subagent not found）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-spawn-nulllit-'));
  try {
    const model = new ScriptedAdapter([
      JSON.stringify({ tool: 'spawn', input: { prompt: '子任务：产出报告', agent_id: 'null', label: 'w' } }),
      JSON.stringify({ done: true, reply: '子任务报告' }),
      JSON.stringify({ done: true, reply: '主链完成' }),
    ]);
    const h = new Harness({ root: tmp, mode: 'dontAsk', model, learnSkills: false });
    const r = await h.reactor.run({ goal: '主任务' }, { maxSteps: 5 });
    const spawnRow = r.steps.find((s) => s.action === 'tool-result' && s.observation.includes('子任务报告'));
    assert.ok(spawnRow, `"null" agent_id 应回落内联形态完成派发，实际观察行：${JSON.stringify(r.steps.map((s) => s.observation))}`);
    assert.ok(!r.steps.some((s) => s.observation.includes('Subagent not found')), '不应出现 Subagent not found');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isolation 真 JSON null 归一为无隔离（不抛 INVALID_ARG "Unknown isolation: null"）——回归 2026-10-03 真机五连拒', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-spawn-nulliso-'));
  try {
    // schema 按仓内约定声明 isolation: enum ['worktree', null] 且 required——严格守约端点（DeepSeek V3.2）
    // 不请求隔离时必发字面 null；模型侧 JSON 原样携带真 null（非 "null" 字符串）
    const model = new ScriptedAdapter([
      JSON.stringify({ tool: 'spawn', input: { prompt: '子任务：产出报告', agent_id: 'null', label: 'w', isolation: null } }),
      JSON.stringify({ done: true, reply: '子任务报告' }),
      JSON.stringify({ done: true, reply: '主链完成' }),
    ]);
    const h = new Harness({ root: tmp, mode: 'dontAsk', model, learnSkills: false });
    const r = await h.reactor.run({ goal: '主任务' }, { maxSteps: 5 });
    assert.ok(
      !r.steps.some((s) => s.observation.includes('Unknown isolation')),
      `真 null isolation 应归一为无隔离完成派发，实际观察行：${JSON.stringify(r.steps.map((s) => s.observation))}`,
    );
    const spawnRow = r.steps.find((s) => s.action === 'tool-result' && s.observation.includes('子任务报告'));
    assert.ok(spawnRow, '归一后内联派发照常完成');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
