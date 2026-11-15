// sunx 工具面（2026-11-15 sunx P1 Task 3）：dispatch_task / task_status 注册 + SUNX_FACE_TOOLS 白名单装配。
// 四面覆盖（brief Step 1）：①sunx 装配注册两件、白名单 derive 精确集合=常量（单点产出）；
// ②standard 装配基线不含两件（主链 face 零变化）；③内核运行时（createKernelRuntime）sunx face=白名单
// （模型 wire 工具恰七件 + 呈现表随 effective face）；④fork 子代 kind 继承（spec §17.2：sunx 派发的
// fork 子智能体稳定段与父逐字节同面——身份行随 Reactor kind 透传）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness, SUNX_FACE_TOOLS } from './index';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import { createKernelRuntime } from '../session/runtime';
import { TOOL_VERBS, toolCallLine } from '../tui/tool-verbs';
import type { ChatRequest } from '../types';

// 文件级数据目录钉定（沿 runtime.test.ts 先例）：单文件直跑时统一落本文件临时沙箱
const filePrevData = process.env.SUNSHINEX_DATA_DIR;
const fileDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-sunxface-data-'));
process.env.SUNSHINEX_DATA_DIR = fileDataDir;
test.after(() => {
  if (filePrevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
  else process.env.SUNSHINEX_DATA_DIR = filePrevData;
  fs.rmSync(fileDataDir, { recursive: true, force: true });
});

const mktmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** 包装探针适配器：记录每轮 chat 的 wire 工具名（面观测）+ 消息全文（稳定段观测），应答交基线脚本 */
function probeAdapter(base: ScriptedAdapter, seen: { prompts: string[]; toolNames: string[] }): ModelAdapter {
  return {
    provider: 'probe',
    chat: async (req: ChatRequest) => {
      seen.prompts.push(req.messages.map((m) => m.content).join('\n'));
      seen.toolNames.push(...(req.tools ?? []).map((t) => t.function.name));
      return base.chat(req);
    },
  };
}

test('sunx kind 装配：注册表含 dispatch/task_status；普通 kind 不含（主链基线不变）', () => {
  const tmp = mktmp('sunshinex-sunxface-asm-');
  let sunx: Harness | undefined;
  try {
    sunx = new Harness({ root: tmp, mode: 'full-access', kind: 'sunx', model: new ScriptedAdapter([]), learnSkills: false });
    assert.ok(sunx.tools.has('dispatch_task'), 'sunx 装配应注册 dispatch_task');
    assert.ok(sunx.tools.has('task_status'), 'sunx 装配应注册 task_status');
    assert.equal(sunx.tools.get('dispatch_task')?.display?.verb, 'DISPATCH', '分派动词呈现元数据');
    assert.equal(sunx.tools.get('task_status')?.display?.verb, 'TASK_STATUS', '窥视动词呈现元数据');
    const std = new Harness({ root: tmp, mode: 'full-access', model: new ScriptedAdapter([]), learnSkills: false });
    assert.equal(std.tools.has('dispatch_task'), false, 'standard 装配不得含 dispatch_task（普通 face 基线守护）');
    assert.equal(std.tools.has('task_status'), false, 'standard 装配不得含 task_status（普通 face 基线守护）');
    std.team.stopAll();
    std.tasks.stopAll();
  } finally {
    sunx?.team.stopAll();
    sunx?.tasks.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('sunx face 白名单精确集合：恰为 SUNX_FACE_TOOLS，derive({only}) 单点产出', () => {
  const tmp = mktmp('sunshinex-sunxface-set-');
  let h: Harness | undefined;
  try {
    h = new Harness({ root: tmp, mode: 'full-access', kind: 'sunx', model: new ScriptedAdapter([]), learnSkills: false });
    const face = h.tools.derive({ only: [...SUNX_FACE_TOOLS] });
    assert.deepEqual(
      face.list().map((t) => t.name).sort(),
      [...SUNX_FACE_TOOLS].sort(),
      `白名单派生面必须恰为 SUNX_FACE_TOOLS 七件（缺件=装配漏注册，多件=常量漂移）：实际 ${face.list().map((t) => t.name).join(', ')}`,
    );
  } finally {
    h?.team.stopAll();
    h?.tasks.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createKernelRuntime：sunx 主链 face=白名单派生——模型 wire 工具恰七件；呈现表随 effective face', async () => {
  const tmp = mktmp('sunshinex-sunxface-rt-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, '.data');
  try {
    const seen = { prompts: [] as string[], toolNames: [] as string[] };
    const rt = createKernelRuntime({
      root: tmp,
      kind: 'sunx',
      model: probeAdapter(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), seen),
    });
    const r = await rt.runTask('编排验收', { maxSteps: 2 });
    assert.equal(r.done, true);
    assert.deepEqual(
      [...new Set(seen.toolNames.flat())].sort(),
      [...SUNX_FACE_TOOLS].sort(),
      `loop 主链模型面必须恰见白名单七件：实际 ${seen.toolNames.flat().join(', ')}`,
    );
    // 呈现表随 effective face（setToolDisplayMeta(face.displayMeta())）：分派动词在册、执行面动词不在册
    assert.equal(toolCallLine('dispatch_task', {}), 'DISPATCH', '呈现层经注入表取分派动词');
    assert.equal(toolCallLine('task_status', {}), 'TASK_STATUS', '呈现层经注入表取窥视动词');
    assert.equal(TOOL_VERBS.has('DISPATCH'), true, 'sunx face 呈现动词集合含 DISPATCH');
    assert.equal(TOOL_VERBS.has('EXEC'), false, 'sunx face 不含执行面工具（exec 不在白名单）');
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createKernelRuntime：standard 主链 face 原样——wire 含 exec、零 dispatch_task/task_status', async () => {
  const tmp = mktmp('sunshinex-sunxface-rtstd-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, '.data');
  try {
    const seen = { prompts: [] as string[], toolNames: [] as string[] };
    const rt = createKernelRuntime({
      root: tmp,
      model: probeAdapter(new ScriptedAdapter(['{"done":true,"reply":"ok"}']), seen),
    });
    const r = await rt.runTask('普通验收', { maxSteps: 2 });
    assert.equal(r.done, true);
    const names = [...new Set(seen.toolNames.flat())];
    assert.ok(names.includes('exec'), 'standard 主链保持执行面（face 基线）');
    assert.equal(names.includes('dispatch_task'), false, 'standard 主链零 dispatch_task');
    assert.equal(names.includes('task_status'), false, 'standard 主链零 task_status');
    assert.equal(TOOL_VERBS.has('EXEC'), true, 'standard 呈现表回主链全量');
    assert.equal(TOOL_VERBS.has('DISPATCH'), false, 'standard 呈现表零分派动词');
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fork 子代 kind 继承：sunx 装配 fork child 稳定段带 Sunx 身份行；standard 装配不含（spec §17.2）', async () => {
  // sunx：父经 spawn 出牌 → fork 子 Reactor kind 随 deps 透传 → 子 prompt（稳定段）带 Sunx 身份行
  const tmp1 = mktmp('sunshinex-sunxface-forkkind-');
  try {
    const seen = { prompts: [] as string[], toolNames: [] as string[] };
    const h = new Harness({
      root: tmp1,
      mode: 'full-access',
      kind: 'sunx',
      learnSkills: false,
      model: probeAdapter(
        new ScriptedAdapter([
          JSON.stringify({ tool: 'spawn', input: { prompt: 'fork 任务', label: 'w' } }),
          JSON.stringify({ done: true, reply: 'child done' }),
          JSON.stringify({ done: true, reply: 'main done' }),
        ]),
        seen,
      ),
    });
    const r = await h.reactor.run({ goal: '主任务' }, { maxSteps: 5 });
    assert.equal(r.done, true, '主链正常收口');
    assert.ok(seen.prompts.length >= 3, `探针应捕获父/子两代 prompt：${seen.prompts.length}`);
    const childPrompt = seen.prompts[1] ?? '';
    assert.ok(childPrompt.includes('fork 任务'), '第 2 轮 prompt 应为 fork 子代（携带任务行）');
    assert.ok(childPrompt.includes('You are the Sunx orchestrator'), 'fork 子代稳定段必须带 Sunx 身份行（kind 经 SubagentRunnerDeps→child Reactor 透传，缺接线即回 SunshineX 身份行）');
    h.tasks.stopAll();
  } finally {
    fs.rmSync(tmp1, { recursive: true, force: true });
  }
  // standard 反向锚：fork 子代稳定段原样（零 Sunx 泄漏）
  const tmp2 = mktmp('sunshinex-sunxface-forkkind-std-');
  try {
    const seen = { prompts: [] as string[], toolNames: [] as string[] };
    const h = new Harness({
      root: tmp2,
      mode: 'full-access',
      learnSkills: false,
      model: probeAdapter(
        new ScriptedAdapter([
          JSON.stringify({ tool: 'spawn', input: { prompt: 'fork 任务', label: 'w' } }),
          JSON.stringify({ done: true, reply: 'child done' }),
          JSON.stringify({ done: true, reply: 'main done' }),
        ]),
        seen,
      ),
    });
    const r = await h.reactor.run({ goal: '主任务' }, { maxSteps: 5 });
    assert.equal(r.done, true);
    const childPrompt = seen.prompts[1] ?? '';
    assert.ok(childPrompt.includes('fork 任务'), '第 2 轮 prompt 应为 fork 子代');
    assert.ok(childPrompt.includes('You are the SunshineX agent'), 'standard fork 子代身份行原样');
    assert.ok(!childPrompt.includes('Sunx orchestrator'), 'standard fork 子代零 Sunx 章程泄漏');
    h.tasks.stopAll();
  } finally {
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});

test('呈现表去单例（P2 Task 1）：混合 kind 两次 assemble 各自返回各自 toolDisplay——互不覆盖', () => {
  const tmp = mktmp('sunshinex-sunxface-tooldisp-');
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, '.data');
  try {
    const model = new ScriptedAdapter(['{"done":true,"reply":"ok"}']);
    const rtSunx = createKernelRuntime({ root: tmp, kind: 'sunx', model });
    assert.equal(rtSunx.toolDisplay['dispatch_task']?.verb, 'DISPATCH', 'sunx 表=白名单面装配快照');
    assert.equal(rtSunx.toolDisplay['exec'], undefined, 'sunx 表零执行面');
    // standard 后装配：返回值各自持表（旧病灶=进程级单表末装配者胜——sunx 会话呈现回退大写原名）
    const rtStd = createKernelRuntime({ root: tmp, model });
    assert.equal(rtStd.toolDisplay['dispatch_task'], undefined, 'standard 表零分派件');
    assert.notEqual(rtStd.toolDisplay['exec'], undefined, 'standard 表含执行面');
    assert.equal(rtSunx.toolDisplay['dispatch_task']?.verb, 'DISPATCH', '去单例核心钉：两次 assemble 后 sunx 表仍持自身面');
    // 显式注入消费：toolCallLine 第三参按各自表出动词；进程级兜底已为末装配 standard 面（daemon 路径不再依赖全局）
    assert.equal(toolCallLine('dispatch_task', {}, rtSunx.toolDisplay), 'DISPATCH', '显式注入按 sunx 表取分派动词');
    assert.equal(toolCallLine('exec', { command: 'ls' }, rtStd.toolDisplay), 'EXEC ls', '显式注入按 standard 表取执行动词');
    assert.equal(toolCallLine('dispatch_task', {}), 'DISPATCH_TASK', '全局兜底=末装配 standard 面（大写原名 fallback），混合 kind 下不再作正确性依赖');
  } finally {
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
