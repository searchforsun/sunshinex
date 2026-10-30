/** fork 零基线推进钉死（2026-10-31 session-snapshot-freeze spec §5）：子智能体经 spawn 工具跑一轮后，
 *  父会话漂移基线不得被子链消费前进（磁盘 diff 仍应全部报出）、主链不得被子链注入任何 drift notice 行、
 *  子链 seed/装配面亦零 notice 污染（seedHistory 装配路径不触 appendInstructionLine/checkConstantsDrift）。
 *  实现零改动——本文件纯钉死现状：红了即哪条路径让子链触达了 drift，按根因修。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import type { ChatRequest, ChatResult } from '../types';
import { Reactor, StepRecord } from './reactor';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { resolveDataDir } from '../config/data-dir';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { SafetyChain } from './security/chain';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { ProcessSandbox } from './security/sandbox';

const SPAWN_ENVELOPE = JSON.stringify({ tool: 'spawn', input: { prompt: '子任务：读一下现状', label: 'w' } });

/** 会话出生磁盘态：初始 SUNSHINE.md + 初始技能（构造 Harness 即捕获四基线=出生态） */
function seedBirthDisk(root: string): void {
  fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'rule A\n');
  const dir = path.join(root, '.sunshinex', 'skills', 'birth');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), ['---', 'name: Birth', 'description: birth skill', '---', 'body', ''].join('\n'));
}

/** 出生后磁盘突变：新增技能 + 修改 SUNSHINE.md（父链尚未消费——diff 应留存到父链首次指令落点） */
function mutateDisk(root: string): void {
  fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'rule A\nrule B\n');
  const dir = path.join(root, '.sunshinex', 'skills', 'newone');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), ['---', 'name: New One', 'description: brand new skill', '---', 'body', ''].join('\n'));
}

/** 提示词捕获包装件（子链装配面观察）：透传 ScriptedAdapter 出牌，同时记录每次请求的消息全文，
 *  供断言「子链 transcript/seed 零 drift notice」——装配路径若注入说明行必经 prompt 面 */
class CapturingAdapter implements ModelAdapter {
  readonly provider = 'capturing';
  readonly prompts: string[] = [];
  constructor(private readonly inner: ScriptedAdapter) {}
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.prompts.push(JSON.stringify(req));
    return this.inner.chat(req);
  }
  async chatStream(req: ChatRequest, onDelta: (t: string) => void): Promise<ChatResult> {
    const r = await this.chat(req);
    for (const ch of r.content) onDelta(ch);
    return r;
  }
}

test('fork 零基线推进：子链跑完父漂移基线不变、主链零 notice 污染、子链 seed 零 drift notice', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ctxsnap-fork-'));
  try {
    seedBirthDisk(tmp);
    const scripted = new ScriptedAdapter([
      SPAWN_ENVELOPE,
      JSON.stringify({ done: true, reply: '子任务报告' }),
      JSON.stringify({ done: true, reply: '主链完成' }),
    ]);
    const capturing = new CapturingAdapter(scripted);
    const h = new Harness({ root: tmp, mode: 'full-access', model: capturing, learnSkills: false });
    // 出生基线已捕获 → 磁盘突变（父链不消费，留给断言面）
    mutateDisk(tmp);
    // spawn 子智能体经 spawn 工具跑一轮 + 主链收束
    const r = await h.reactor.run({ goal: '主任务' }, { maxSteps: 5 });
    assert.equal(r.done, true, '主任务应正常收束（spawn 同步回流）');
    assert.ok(r.steps.some((s) => s.observation.includes('子任务报告')), '子报告应回流该轮观察（子链确实跑过）');

    // (a) 父漂移基线未被子链消费前进：checkConstantsDrift 仍报全部 diff（技能新增 + SUNSHINE 变更）
    const notices = h.context.checkConstantsDrift();
    assert.ok(
      notices.some((n) => n.startsWith('[skills] added:') && n.includes('newone')),
      `技能新增 diff 应仍报出（基线未被子链前进），实际：${JSON.stringify(notices)}`,
    );
    assert.ok(
      notices.some((n) => n.startsWith('SUNSHINE.md changed')),
      `SUNSHINE.md 变更 diff 应仍报出，实际：${JSON.stringify(notices)}`,
    );

    // (b) 主链零子链引入的 notice 行：整条链视图无 notice 动作、无 drift 文案
    const chain = h.context.chainView();
    const noticeRows = chain.filter((s) => s.action === 'notice');
    assert.deepEqual(noticeRows, [], `主链不得含 notice 行（子链零主链回写污染），实际：${JSON.stringify(noticeRows)}`);
    const chainText = JSON.stringify(chain);
    assert.ok(!chainText.includes('[skills]'), '主链不得含 [skills] 说明行');
    assert.ok(!chainText.includes('SUNSHINE.md changed'), '主链不得含 SUNSHINE.md changed 说明行');

    // (c) 子链 transcript/seed 零 drift notice：全部模型请求全文（含子链 seedHistory 装配面）不含说明文案
    assert.ok(capturing.prompts.length >= 2, '子链与主链各应至少发起一次模型调用');
    for (const p of capturing.prompts) {
      assert.ok(!p.includes('[skills] added'), '子链 seed 装配面不得含技能新增说明行');
      assert.ok(!p.includes('SUNSHINE.md changed'), '子链 seed 装配面不得含 SUNSHINE 漂移说明行');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fork 零基线推进(直驱等价钉)：子 Reactor scope=fork+seedHistory 装配不触 appendInstructionLine/父 checkConstantsDrift', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ctxsnap-fork2-'));
  try {
    seedBirthDisk(tmp);
    const context = new ContextManager(tmp, new FileStore(resolveDataDir(tmp)));
    mutateDisk(tmp);
    // 与 subagent.ts 同构的 seedHistory 直驱装配（基线=出生态，链空 → 步号自 1 起）
    const seedHistory: StepRecord[] = [
      { step: 1, action: 'role', observation: 'Role: tester' },
      { step: 2, action: 'task', observation: '子任务线' },
    ];
    const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'full-access'), new ProcessSandbox(), tmp);
    const registry = new ToolRegistry();
    for (const t of builtinTools(safety, tmp)) registry.register(t);
    const child = new Reactor({
      safety,
      registry,
      context,
      model: new ScriptedAdapter([JSON.stringify({ done: true, reply: '子结论' })]),
    });
    const out = await child.run({ goal: '子任务线' }, { maxSteps: 3, scope: 'fork', seedHistory });
    assert.equal(out.done, true);
    // 子链收束后：父漂移基线仍全量报出（fork 装配路径未消费基线）+ 子链零 notice 步
    const notices = context.checkConstantsDrift();
    assert.equal(notices.filter((n) => n.startsWith('[skills] added')).length, 1, '技能新增 diff 应仍报出');
    assert.equal(notices.filter((n) => n.startsWith('SUNSHINE.md changed')).length, 1, 'SUNSHINE 变更 diff 应仍报出');
    assert.ok(!out.steps.some((s) => s.action === 'notice'), '子链步骤不得含 notice 行');
    assert.ok(!JSON.stringify(out.steps).includes('SUNSHINE.md changed'), '子链步骤零 SUNSHINE 漂移文案');
    // fork 零主链回写不变量：context 链视图仍为空（seedHistory 只进子 prompt 面，不落主链）
    assert.deepEqual(context.chainView(), [], 'fork 直驱不得向主链回写任何链行');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
