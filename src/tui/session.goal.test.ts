import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ModelAdapter, ScriptedAdapter } from '../model/adapter';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('/goal：修正环跑通——任务行入链带 /goal 标注（无模板名），终态回执四要素齐备', async () => {
  const tmp = tmpDir('sunshinex-goal1-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([{ content: '', toolCalls: [] }, { content: '', toolCalls: [{ id: 'call_0', name: 'submit_verdict', args: { passed: true, verdict: 'met', evidence: '已达成' } }] }]),
    });
    await ctrl.submit('/goal 修复构建（验收标准：t1=构建通过）');
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().status, 'idle');
    const chain = ctrl.context.chainView();
    assert.ok(
      chain.some((s) => s.action === 'task' && s.observation.includes('(/goal)')),
      '任务行入链且带 /goal 标注（写链面恒英文单语，标注单形态）',
    );
    assert.ok(
      !chain.some((s) => s.action === 'task' && s.observation.includes('test-loop')),
      '链行零模板名（模板为内部装配机制，用户面零暴露）',
    );
    const receipt = ctrl.getState().messages.map((m) => m.text).join('\n');
    assert.ok(ctrl.getState().messages.some((m) => /^✻ \/goal[:：]/.test(m.text)), '启动提示单行上屏');
    assert.match(receipt, /\/goal done|\/goal 完成/);
    assert.match(receipt, /✓ t1/);
    assert.match(receipt, /iteration\(s\)|轮/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/goal：判据未过回修一轮——修正要求走链行，修正轮结论入链', async () => {
  const tmp = tmpDir('sunshinex-goal2-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([
        { content: '第一版', toolCalls: [] },
        { content: '', toolCalls: [{ id: 'call_0', name: 'submit_verdict', args: { passed: false, verdict: 'not-yet', evidence: '不达标' } }] },
        { content: '第二版', toolCalls: [] },
        { content: '', toolCalls: [{ id: 'call_1', name: 'submit_verdict', args: { passed: true, verdict: 'met', evidence: '达标' } }] },
      ]),
    });
    await ctrl.submit('/goal 改进输出（验收标准：t1=输出正确）');
    await ctrl.waitIdle();
    const receipt = ctrl.getState().messages.map((m) => m.text).join('\n');
    assert.match(receipt, /\/goal done|\/goal 完成/);
    const chain = ctrl.context.chainView();
    assert.ok(chain.some((s) => s.action === 'deficit'), '修正要求走链行（主链追加纪律）');
    assert.ok(chain.some((s) => s.observation.includes('第二版')), '修正轮结论入链');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/goal：无参出用法提示——引擎零调用、链零写入、状态不动', async () => {
  const tmp = tmpDir('sunshinex-goal3-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    await ctrl.submit('/goal');
    const last = ctrl.getState().messages.at(-1)?.text ?? '';
    assert.match(last, /Usage: \/goal|用法：\/goal/);
    assert.equal(ctrl.context.chainView().length, 0);
    assert.equal(ctrl.getState().status, 'idle');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/goal：运行中拒绝，不打断当前任务', async () => {
  const tmp = tmpDir('sunshinex-goal6-');
  try {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const hangText = '{"done":true,"reply":"ok"}';
    const hang = {
      provider: 'hang',
      async complete() { await gate; return hangText; },
      async completeStream(_p: string, onDelta: (t: string) => void) {
        const text = await gate.then(() => hangText);
        for (const ch of text) onDelta(ch);
        return text;
      },
    } as unknown as ModelAdapter;
    const ctrl = new SessionController({ root: tmp, model: hang });
    const running = ctrl.submit('先跑一个普通任务'); // 不 await：挂起保持 running
    await new Promise((r) => setTimeout(r, 80)); // 等 submit 走进 runTask（模型调用挂起）
    await ctrl.submit('/goal 第二件事（验收标准：t1=x）');
    const last = ctrl.getState().messages.at(-1)?.text ?? '';
    assert.match(last, /unavailable now|暂不能执行/);
    assert.equal(ctrl.getState().status, 'running', '守卫只拒绝 /goal，不改变当前任务');
    release();
    await running;
    await ctrl.waitIdle();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/goal：/new 清链后空链起跑正常', async () => {
  const tmp = tmpDir('sunshinex-goal7-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([{ content: '', toolCalls: [] }, { content: '', toolCalls: [{ id: 'call_0', name: 'submit_verdict', args: { passed: true, verdict: 'met', evidence: 'ok' } }] }]),
    });
    await ctrl.submit('/new');
    assert.equal(ctrl.context.chainView().length, 0);
    await ctrl.submit('/goal 再来一件事（验收标准：t1=达成）');
    await ctrl.waitIdle();
    const chain = ctrl.context.chainView();
    assert.ok(
      chain.length > 1 && chain[0].observation.includes('(/goal)'),
      '空链起跑，任务行为链首（/goal 标注、无模板名）',
    );
    assert.match(
      ctrl.getState().messages.map((m) => m.text).join('\n'),
      /\/goal done|\/goal 完成/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/goal：自然语言目标（无内嵌验收标准段）跑通，不再空转失败', async () => {
  const tmp = tmpDir('sunshinex-goal8-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([{ content: '', toolCalls: [] }, { content: '', toolCalls: [{ id: 'call_0', name: 'submit_verdict', args: { passed: true, verdict: 'met', evidence: '对话里已自证' } }] }]),
    });
    await ctrl.submit('/goal 把 src/auth 的所有测试跑到全绿');
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().status, 'idle');
    const receipt = ctrl.getState().messages.map((m) => m.text).join('\n');
    assert.match(receipt, /\/goal done|\/goal 完成/);
    const chain = ctrl.context.chainView();
    assert.ok(chain.some((s) => s.action === 'task' && s.observation.includes('src/auth')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/goal：判据服务不可用 → paused 回执提示重跑续走', async () => {
  const tmp = tmpDir('sunshinex-goal9-');
  try {
    const respond = async (prompt: string): Promise<string> => {
      if (prompt.includes('acceptance judge')) throw new Error('ETIMEDOUT: judge endpoint unreachable');
      return '{"done":true,"reply":"完成"}';
    };
    const ctrl = new SessionController({
      root: tmp,
      model: {
        provider: 'flaky-judge',
        complete: respond,
        async chat() {
          await respond('acceptance judge');
          throw new Error('unreachable');
        },
      } as unknown as ModelAdapter,
    });
    await ctrl.submit('/goal 做事（验收标准：t1=达成）');
    await ctrl.waitIdle();
    const receipt = ctrl.getState().messages.map((m) => m.text).join('\n');
    assert.match(receipt, /Run \/goal again|重跑 \/goal/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/goal：--template 字样不解析，整体作为目标文本（D1 钉子：剥离等于行为上承认该语法仍存在）', async () => {
  const tmp = tmpDir('sunshinex-goal10-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter([{ content: '', toolCalls: [] }, { content: '', toolCalls: [{ id: 'call_0', name: 'submit_verdict', args: { passed: true, verdict: 'met', evidence: '已达成' } }] }]),
    });
    await ctrl.submit('/goal --template=code-review 审查输出（验收标准：t1=有结论）');
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().status, 'idle');
    const chain = ctrl.context.chainView();
    assert.ok(
      chain.some((s) => s.action === 'task' && s.observation.includes('--template=code-review')),
      '输入整体作为目标文本入链，不做静默剥离',
    );
    const receipt = ctrl.getState().messages.map((m) => m.text).join('\n');
    assert.match(receipt, /\/goal done|\/goal 完成/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
