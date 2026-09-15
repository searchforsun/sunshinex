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

test('/goal：修正环跑通——任务行入链带模板标注，终态回执四要素齐备', async () => {
  const tmp = tmpDir('sunshinex-goal1-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"修复完成"}', '{"passed":true,"evidence":"已达成"}']),
    });
    await ctrl.submit('/goal 修复构建（验收标准：t1=构建通过）');
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().status, 'idle');
    const chain = ctrl.context.chainView();
    assert.ok(
      chain.some((s) => s.action === 'task' && s.observation.includes('/goal · test-loop')),
      '任务行入链且带 /goal·模板 标注（缺省 test-loop）',
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
        '{"done":true,"reply":"第一版"}',
        '{"passed":false,"evidence":"不达标"}',
        '{"done":true,"reply":"第二版"}',
        '{"passed":true,"evidence":"达标"}',
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

test('/goal：未知模板报错列可选值，不入链', async () => {
  const tmp = tmpDir('sunshinex-goal4-');
  try {
    const ctrl = new SessionController({ root: tmp, model: new ScriptedAdapter([]) });
    await ctrl.submit('/goal 做事 --template=nope');
    const last = ctrl.getState().messages.at(-1)?.text ?? '';
    assert.match(last, /Unknown template: nope|未知模板：nope/);
    assert.match(last, /code-refactor/);
    assert.equal(ctrl.context.chainView().length, 0);
    assert.equal(ctrl.getState().status, 'idle');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/goal：--template 显式覆盖 code-review（agent→gate→check 判据通过）', async () => {
  const tmp = tmpDir('sunshinex-goal5-');
  try {
    const ctrl = new SessionController({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"审查结论：输出正确"}', '{"passed":true,"evidence":"已确认"}']),
    });
    await ctrl.submit('/goal --template=code-review 审查输出（验收标准：t1=有结论）');
    await ctrl.waitIdle();
    const chain = ctrl.context.chainView();
    assert.ok(
      chain.some((s) => s.action === 'task' && s.observation.includes('/goal · code-review')),
      '模板标注取显式覆盖值',
    );
    const receipt = ctrl.getState().messages.map((m) => m.text).join('\n');
    assert.match(receipt, /\/goal done|\/goal 完成/);
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
      model: new ScriptedAdapter(['{"done":true,"reply":"完成"}', '{"passed":true,"evidence":"ok"}']),
    });
    await ctrl.submit('/new');
    assert.equal(ctrl.context.chainView().length, 0);
    await ctrl.submit('/goal 再来一件事（验收标准：t1=达成）');
    await ctrl.waitIdle();
    const chain = ctrl.context.chainView();
    assert.ok(chain.length > 1 && chain[0].observation.includes('/goal · test-loop'), '空链起跑，任务行为链首');
    assert.match(
      ctrl.getState().messages.map((m) => m.text).join('\n'),
      /\/goal done|\/goal 完成/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
