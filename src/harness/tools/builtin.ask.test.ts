import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { builtinTools } from './builtin';
import { ToolRegistry } from '../tools';
import { SafetyChain } from '../security/chain';
import { SecurityGuard } from '../security/guard';
import { PolicyEngine } from '../security/policy';
import { ProcessSandbox } from '../security/sandbox';
import { DryRun } from '../security/dryrun';
import { toolCallLine } from '../../tui/tool-verbs';
import type { AskUserRequest, AskUserAnswer, AskUserSeam } from '../../types';

const OPTIONS2 = [{ label: 'Yes' }, { label: 'No' }];

function makeSafety(root: string, mode: 'manual' | 'dontAsk' | 'plan' = 'dontAsk'): SafetyChain {
  return new SafetyChain(new SecurityGuard(new PolicyEngine(), mode), new ProcessSandbox(), new DryRun(), root);
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function registryWithAsk(root: string, ask: AskUserSeam): { registry: ToolRegistry; safety: SafetyChain } {
  const safety = makeSafety(root);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root, undefined, undefined, undefined, undefined, undefined, undefined, ask)) registry.register(t);
  return { registry, safety };
}

test('ask_question：两态注册——第 9 参缺省不注册（清单零变化），注入 seam 即注册且类别为 ask', () => {
  const root = tmpDir('sunshinex-askq-reg-');
  try {
    const safety = makeSafety(root);
    const bare = new ToolRegistry();
    for (const t of builtinTools(safety, root)) bare.register(t);
    assert.equal(bare.get('ask_question'), undefined, '缺省不注册（两态不变式沿第 7/8 参先例）');

    const { registry } = registryWithAsk(root, async () => ({ type: 'dismissed' }));
    const tool = registry.get('ask_question');
    assert.ok(tool, '注入 seam 即注册');
    assert.equal(tool?.category, 'ask', '类别 ask：混批时整轮按序串行（reactor 执行面闸门判定键）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ask_question：入参钳制——空 question / options<2 / options>8 / 空 label 均报 INVALID_ARG', async () => {
  const root = tmpDir('sunshinex-askq-arg-');
  try {
    const { registry, safety } = registryWithAsk(root, async () => ({ type: 'dismissed' }));
    const cases: Record<string, unknown>[] = [
      { question: '', options: OPTIONS2 },
      { question: 'q' },
      { question: 'q', options: [{ label: 'only' }] },
      { question: 'q', options: Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` })) },
      { question: 'q', options: [{ label: 'a' }, { label: '  ' }] },
    ];
    for (const input of cases) {
      const r = await registry.execute('ask_question', input, safety);
      assert.equal(r.ok, false, JSON.stringify(input));
      if (!r.ok) assert.equal(r.error.code, 'INVALID_ARG', JSON.stringify(input));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ask_question：观察四态——answer / answers / custom / dismissed', async () => {
  const root = tmpDir('sunshinex-askq-obs-');
  try {
    const seen: AskUserRequest[] = [];
    let next: AskUserAnswer = { type: 'selected', labels: ['Yes'] };
    const seam: AskUserSeam = async (req) => { seen.push(req); return next; };
    const { registry, safety } = registryWithAsk(root, seam);

    const single = await registry.execute('ask_question', { question: 'Proceed?', options: OPTIONS2 }, safety);
    assert.ok(single.ok);
    if (single.ok) assert.equal(single.value.stdout, 'answer: Yes');

    next = { type: 'selected', labels: ['Yes', 'No'] };
    const multi = await registry.execute('ask_question', { question: 'q', options: OPTIONS2, multiple: true }, safety);
    assert.ok(multi.ok);
    if (multi.ok) assert.equal(multi.value.stdout, 'answers: Yes; No');

    next = { type: 'custom', text: '  hello world  ' };
    const custom = await registry.execute('ask_question', { question: 'q', options: OPTIONS2 }, safety);
    assert.ok(custom.ok);
    if (custom.ok) assert.equal(custom.value.stdout, 'custom: hello world', 'custom 文本 trim 后透传');

    next = { type: 'dismissed' };
    const gone = await registry.execute('ask_question', { question: 'q', options: OPTIONS2 }, safety);
    assert.ok(gone.ok);
    if (gone.ok) assert.equal(gone.value.stdout, 'user dismissed the question (no selection)');

    assert.equal(seen.length, 4, 'seam 每次调用都收到请求');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ask_question：allowCustom 合成 Other… 末项并携带 customIndex；multiple 缺省不下发', async () => {
  const root = tmpDir('sunshinex-askq-other-');
  try {
    let captured: AskUserRequest | undefined;
    const seam: AskUserSeam = async (req) => { captured = req; return { type: 'dismissed' }; };
    const { registry, safety } = registryWithAsk(root, seam);
    await registry.execute('ask_question', { question: 'q', options: OPTIONS2, allowCustom: true }, safety);
    assert.equal(captured?.options.length, 3, 'Other… 追加为末项');
    assert.equal(captured?.customIndex, 2);
    assert.equal(captured?.options[2].label, 'Other…');
    assert.equal(captured?.multiple, undefined, 'multiple 缺省不下发（请求字段最小化）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ask_question：三模式安全链放行——manual 免审批 / plan 允许澄清提问 / dontAsk 照常', () => {
  const root = tmpDir('sunshinex-askq-guard-');
  try {
    for (const mode of ['manual', 'plan', 'dontAsk'] as const) {
      const g = new SecurityGuard(new PolicyEngine(), mode).preToolUse('ask_question', { question: 'q', options: OPTIONS2 });
      assert.equal(g.allowed, true, `${mode} 下 ask_question 应放行（问询即通道本身）`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tool-verbs：ask_question → ASK + question 摘要', () => {
  const line = toolCallLine('ask_question', { question: 'Proceed with plan?' });
  assert.match(line, /ASK/);
  assert.match(line, /Proceed with plan\?/);
});
