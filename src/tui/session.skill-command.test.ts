import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionController } from './session';
import { ScriptedAdapter, type ModelAdapter } from '../model/adapter';
import { textReplyToChatFace } from '../model/chat-stub';
import { resolveDataDir } from '../config/data-dir';
import { listSessions, parseJournalFile, reduceJournal } from './session-journal';

// 关断 learned 沉淀（控制面键 SUNSHINEX_LEARNED_SKILLS，env > 缺省 on）：本套件的成功任务
// 会经 settle 管线把 goal 沉淀为 learned 技能、写进数据目录，目录跨运行残留会污染
// skillCommandIds 清单断言；必须在任意 SessionController 构造前执行（判门是运行时求值）。
process.env.SUNSHINEX_LEARNED_SKILLS = 'off';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = tmpdir('sunshinex-sess-skillcmd-');
  try {
    await fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 每用例自钉数据目录（test-env.cjs 按文件共享 + 跨运行残留：/resume 候选与链计数断言均需用例级隔离；
 *  node:test 同文件顺序执行，进出恢复 env 不串扰邻用例） */
async function withIsolatedData(fn: (root: string) => Promise<void>): Promise<void> {
  const prev = process.env.SUNSHINEX_DATA_DIR;
  await withRoot(async (root) => {
    process.env.SUNSHINEX_DATA_DIR = path.join(root, 'data');
    try {
      await fn(root);
    } finally {
      if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;
      else process.env.SUNSHINEX_DATA_DIR = prev;
    }
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function sysTexts(ctrl: SessionController): string[] {
  return ctrl.getState().messages.filter((m) => m.role === 'system').map((m) => m.text);
}

/** 项目级技能夹具（.sunshinex/skills/<id>/SKILL.md，优先级链最高根；extraFm 可注 params 等前置） */
function writeSkill(root: string, id: string, name: string, description: string, extraFm = ''): void {
  const dir = path.join(root, '.sunshinex', 'skills', id);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', `name: ${name}`, `description: ${description}`, 'version: 1.0.0'];
  if (extraFm) lines.push(extraFm);
  lines.push('---', '', `Body of ${name}.`);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), lines.join('\n'));
}

/** 事件级 journal 读链（chain 事件逐条直写，链条目即观察面） */
function chainEntries(root: string): Array<{ action?: string; observation: string }> {
  const meta = listSessions(resolveDataDir(root))[0];
  if (!meta) return [];
  return reduceJournal(parseJournalFile(meta.file).events).chain;
}

function skillChainCount(root: string, id: string): number {
  return chainEntries(root).filter((s) => s.action === 'skill' && s.observation.includes(`(id=${id} v=`)).length;
}

/** 门控适配器（session.steer.test.ts 同款）：第 1 次模型调用阻塞在 gate 上，供「运行中拒绝」用例稳定挂起 */
function gatedAdapter(): { adapter: ModelAdapter; gate: { promise: Promise<void>; release: () => void } } {
  let release!: () => void;
  const gate = { promise: new Promise<void>((r) => { release = r; }), release };
  let calls = 0;
  const adapter: ModelAdapter = {
    provider: 'gated-skillcmd',
    chat: textReplyToChatFace(async () => {
      const i = calls++;
      if (i === 0) await gate.promise;
      return '{"done":true,"reply":"ok"}';
    }),
  };
  return { adapter, gate };
}

test('A1 裸形式：/<id> 仅加载——链尾追 + 回执；二次执行去重回执、链条目数不变', async () => {
  await withIsolatedData(async (root) => {
    writeSkill(root, 'hello-world', 'Hello World', 'Say hello');
    const ctrl = new SessionController({ root, model: new ScriptedAdapter(['{"done":true,"reply":"x"}']) });
    await ctrl.submit('/hello-world');
    assert.equal(ctrl.getState().status, 'idle');
    assert.equal(skillChainCount(root, 'hello-world'), 1, '链上出现技能条目');
    assert.ok(sysTexts(ctrl).some((x) => /Skill loaded: Hello World/.test(x)), '加载回执上屏');
    await ctrl.submit('/hello-world');
    assert.ok(sysTexts(ctrl).some((x) => /already loaded|已加载/.test(x)), '去重回执');
    assert.equal(skillChainCount(root, 'hello-world'), 1, '零重复注入');
  });
});

test('A2 带意图：/<id> <意图> 确定性加载 + 意图原样派发标准环', async () => {
  await withIsolatedData(async (root) => {
    writeSkill(root, 'hello-world', 'Hello World', 'Say hello');
    const ctrl = new SessionController({ root, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await ctrl.submit('/hello-world 修复登录页');
    await ctrl.waitIdle();
    assert.equal(ctrl.getState().status, 'idle');
    assert.equal(skillChainCount(root, 'hello-world'), 1, '技能正文入链');
    assert.ok(chainEntries(root).some((s) => s.action === 'task' && s.observation.includes('修复登录页')), '意图原样入任务链');
  });
});

test('A3 幂等：已加载态带意图——不重复注入、任务照常派发', async () => {
  await withIsolatedData(async (root) => {
    writeSkill(root, 'hello-world', 'Hello World', 'Say hello');
    const ctrl = new SessionController({ root, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    await ctrl.submit('/hello-world');
    await ctrl.submit('/hello-world 再跑一次');
    await ctrl.waitIdle();
    assert.equal(skillChainCount(root, 'hello-world'), 1, '技能条目仍一条');
    assert.ok(chainEntries(root).some((s) => s.action === 'task' && s.observation.includes('再跑一次')), '任务照常派发');
  });
});

test('A4 撞名内置：内置分支先行拦截，撞名技能仅可经 /skill 卡加载', async () => {
  await withIsolatedData(async (root) => {
    writeSkill(root, 'resume', 'Resume', 'fake resume skill');
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    await ctrl.submit('/resume');
    assert.equal(skillChainCount(root, 'resume'), 0, '零技能注入（内置语义）');
    assert.ok(sysTexts(ctrl).some((x) => /No saved sessions yet|暂无已保存会话/.test(x)), '走内置 /resume 分支');
    const p = ctrl.submit('/skill');
    await waitFor(() => ctrl.getState().status === 'awaiting-question');
    const q = ctrl.getState().question;
    assert.ok(q!.options.some((o) => o.label === 'Resume'), '/skill 卡仍列撞名技能');
    ctrl.resolveAskAnswer({ type: 'dismissed' });
    await p;
  });
});

test('A5 非法 id：字符集外不注册，输入统一无法识别', async () => {
  await withIsolatedData(async (root) => {
    writeSkill(root, 'Bad.Id', 'Bad', 'invalid id');
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    assert.ok(!ctrl.skillCommandIds().includes('Bad.Id'), '注册表排除非法 id');
    await ctrl.submit('/Bad.Id');
    assert.ok(sysTexts(ctrl).some((x) => x.includes('Unrecognized command')), '统一无法识别文案');
    assert.equal(chainEntries(root).filter((s) => s.action === 'skill').length, 0, '零注入');
  });
});

test('A6 PARAM_MISSING：warn 回执不派发', async () => {
  await withIsolatedData(async (root) => {
    writeSkill(root, 'greet', 'Greet', 'needs params', 'params: who');
    const ctrl = new SessionController({ root, model: new ScriptedAdapter(['{"done":true,"reply":"x"}']) });
    await ctrl.submit('/greet');
    const hit = sysTexts(ctrl).find((x) => x.includes('Skill load failed'));
    assert.ok(hit && hit.includes('SKILL_PARAM_MISSING'), '失败回执带错误码');
    assert.ok(!chainEntries(root).some((s) => s.action === 'task'), '不派发任务');
    assert.equal(skillChainCount(root, 'greet'), 0, '不部分加载');
  });
});

test('A7 运行中拒绝：挂起任务期间 /<id> 零副作用', async () => {
  await withIsolatedData(async (root) => {
    writeSkill(root, 'hello-world', 'Hello World', 'Say hello');
    const { adapter, gate } = gatedAdapter();
    const ctrl = new SessionController({ root, model: adapter });
    const run = ctrl.submit('先跑个任务');
    await waitFor(() => ctrl.getState().status === 'running');
    await ctrl.submit('/hello-world');
    assert.ok(sysTexts(ctrl).some((x) => /unavailable now|暂不能执行/.test(x)), '运行中 warn 回执');
    assert.equal(skillChainCount(root, 'hello-world'), 0, '零注入');
    gate.release();
    await run;
    assert.equal(ctrl.getState().status, 'idle');
  });
});

test('A8 /help 技能段：一行引导、内置清单零漂移', async () => {
  await withIsolatedData(async (root) => {
    const bare = new SessionController({ root, model: new ScriptedAdapter([]) });
    await bare.submit('/help');
    const bareText = sysTexts(bare).join('\n');
    assert.ok(bareText.includes('/init'), '内置清单在位');
    assert.match(bareText, /\/<skill-id>|\/<技能id>/, '技能直调引导行在位（空池同样展示）');
    writeSkill(root, 'hello-world', 'Hello World', 'Say hello nicely');
    const ctrl = new SessionController({ root, model: new ScriptedAdapter([]) });
    await ctrl.submit('/help');
    const text = sysTexts(ctrl).join('\n');
    assert.ok(!text.includes('/hello-world  Hello World'), '技能不再逐条罗列');
    assert.ok(text.includes('/new'), '内置清单仍在');
  });
});
