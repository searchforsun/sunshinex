import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { resolveContextWindow } from './chat-model';
import { ScriptedAdapter } from '../model/adapter';
import { chainToHistoryItems, contextBreakdown } from '../harness/context';
import { estimateTokens } from '../harness/context/window';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 构成报表行取数：`  <label>  <tokens> tok  <pct>%` → tokens（千分位还原数值） */
function rowTokens(text: string, label: string): number {
  const m = new RegExp(`${label}\\s+([\\d,]+)\\s+tok`).exec(text);
  assert.ok(m, `报表应含 ${label} 行`);
  return Number(m[1].replace(/,/g, ''));
}

test('会话控制器：/context 输出各段大小与占窗口比例，链段与装配面口径一致', async () => {
  delete process.env.SUNSHINEX_CONTEXT_WINDOW;
  const tmp = tmpdir('sunshinex-ctx-');
  try {
    fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), '# 项目约定\n- 提交前跑全量测试\n');
    const skillDir = path.join(tmp, '.sunshinex', 'skills', 'demo-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: demo\nversion: 1.0.0\n---\n\nBody.');
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    const ctx = ctrl.runtime.harness.context;
    ctx.appendChain([
      { action: 'task', observation: 'Current instruction: 修一个bug' },
      { action: 'reply', observation: '已修复，测试全绿' },
    ]);
    await ctrl.submit('/context');
    const text = ctrl.getState().messages.filter((m) => m.role === 'system').map((m) => m.text).join('\n');
    assert.ok(/Context: [\d,]+ \/ 200,000 tokens \([\d.]+% used, [\d,]+ free\)/.test(text), '头行汇总（缺省窗口 200k）');
    for (const label of ['system prompt (stable)', 'instructions (SUNSHINE.md)', 'skills index', 'memory index', 'compacted summary', 'session chain']) {
      assert.ok(text.includes(label), `分段 ${label} 呈现`);
    }
    assert.ok(rowTokens(text, 'instructions \\(SUNSHINE\\.md\\)') > 0, 'SUNSHINE.md 两行指令计入指令段');
    assert.ok(rowTokens(text, 'skills index') > 0, '技能清单段计入');
    const expected = chainToHistoryItems(ctx.chainView()).reduce((s, i) => s + estimateTokens(i.content), 0);
    assert.equal(rowTokens(text, 'session chain'), expected, '链段=Σ estimateTokens(链行)（与 ctx 水位同口径）');
    assert.ok(text.includes('2 steps'), '链行数尾注');
    assert.ok(text.includes('task ×1') && text.includes('reply ×1'), '链内动作细分行');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话控制器：/context 只读钉——不消费待注入技能块、不写链、两次输出逐字节一致', async () => {
  const tmp = tmpdir('sunshinex-ctx-readonly-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    const ctx = ctrl.runtime.harness.context;
    ctx.setSkillBlock('demo skill body for pending injection');
    ctx.appendChain([{ action: 'task', observation: 'Current instruction: demo' }]);
    const chainBefore = ctx.chainView().length;
    await ctrl.submit('/context');
    const first = ctrl.getState().messages.filter((m) => m.role === 'system').at(-1)?.text ?? '';
    assert.ok(first.includes('skill block (pending)'), '待注入技能块呈现为独立分段');
    assert.equal(ctx.peekSkill(), 'demo skill body for pending injection', 'peek 不消费：技能块仍待下次装配注入');
    assert.equal(ctx.chainView().length, chainBefore, '观测不写链');
    await ctrl.submit('/context');
    const second = ctrl.getState().messages.filter((m) => m.role === 'system').at(-1)?.text ?? '';
    assert.equal(second, first, '相邻两次观测逐字节一致（纯函数，无时变字段）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveContextWindow（J6 双源收敛单点）：modelWindow 优先 > env 回退 > 未配置 0', () => {
  const prev = process.env.SUNSHINEX_CONTEXT_WINDOW;
  try {
    delete process.env.SUNSHINEX_CONTEXT_WINDOW;
    assert.equal(resolveContextWindow({}), 0, '未配置 = 0（状态栏 ctx 段不显示，缺省 0 语义不变）');
    process.env.SUNSHINEX_CONTEXT_WINDOW = '5000';
    assert.equal(resolveContextWindow({}), 5000, 'modelWindow 缺省回退 env 全局窗口');
    assert.equal(resolveContextWindow({ modelWindow: 128000 }), 128000, '/model 每模型窗口优先于 env');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_CONTEXT_WINDOW;
    else process.env.SUNSHINEX_CONTEXT_WINDOW = prev;
  }
});

test('会话控制器：/context 窗口分母随 SUNSHINEX_CONTEXT_WINDOW，带参形态统一无法识别', async () => {
  process.env.SUNSHINEX_CONTEXT_WINDOW = '5000';
  const tmp = tmpdir('sunshinex-ctx-window-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    await ctrl.submit('/context');
    const text = ctrl.getState().messages.filter((m) => m.role === 'system').map((m) => m.text).join('\n');
    assert.ok(text.includes('/ 5,000 tokens'), '窗口分母随配置');
    await ctrl.submit('/context extra');
    const warn = ctrl.getState().messages.find((m) => m.role === 'system' && m.text.includes('Unrecognized command'));
    assert.equal(warn?.level, 'warn', '带参形态统一无法识别（裸形式守卫）');
  } finally {
    delete process.env.SUNSHINEX_CONTEXT_WINDOW;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('构成口径自洽：TUI 分支输入与 contextBreakdown 纯函数一致（快照分段/压缩水位/peek 三源齐备）', async () => {
  const tmp = tmpdir('sunshinex-ctx-parts-');
  try {
    fs.writeFileSync(path.join(tmp, 'SUNSHINE.md'), '- 只有一行约定\n');
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    const ctx = ctrl.runtime.harness.context;
    ctx.appendChain([{ action: 'task', observation: 'Current instruction: x' }]);
    const parts = ctx.snapshotPartsView();
    assert.ok(parts.instructions.length > 0, '指令段非空（SUNSHINE.md 已写盘）');
    assert.deepEqual(
      [...parts.instructions, ...parts.skills, ...parts.memory].map((i) => i.content),
      ctx.snapshotView().map((i) => i.content),
      '分段展平与混合快照逐字节同源（分段只是观测切面，不改装配面）',
    );
    assert.equal(ctx.chainFromView(), 0, '未压缩水位 0');
    const b = contextBreakdown({
      stableSegment: ctrl.runtime.harness.reactor.stableSegment(),
      instructions: parts.instructions,
      skills: parts.skills,
      memory: parts.memory,
      compacted: ctx.compactedView(),
      chain: ctx.chainView(),
      skill: ctx.peekSkill(),
      window: 200_000,
      chainFrom: ctx.chainFromView(),
    });
    assert.ok(b.parts.every((p) => p.tokens >= 0) && b.total > 0, '分段全非负、总量非零');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
