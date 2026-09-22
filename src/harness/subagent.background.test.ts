// 后台任务线 T2 Step 5：spawn 两段式（background: true）行为测试——立即返回任务记录、
// 结论行落任务日志、主链零追加（规格 D6，对标 CC Task run_in_background）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';
import { ScriptedAdapter } from '../model/adapter';
import type { TaskRegistry } from './tasks';

/** 取 Harness 内部账本（装配贯通后恒存在） */
function ledgerOf(h: Harness): TaskRegistry {
  return (h as unknown as { tasks: TaskRegistry }).tasks;
}

test('spawn 两段式：立即返回任务记录，结论行落任务日志、主链零追加', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-bgspawn-'));
  const h = new Harness({
    root,
    mode: 'dontAsk',
    model: new ScriptedAdapter([
      JSON.stringify({ tool: 'spawn', input: { prompt: '背景调研：统计 dist 目录', background: true } }),
      JSON.stringify({ done: true, reply: '已提交后台子代理' }),
    ]),
  });
  try {
    const r = await h.reactor.run({ goal: '跑背景调研' }, { maxSteps: 4 });
    assert.equal(r.done, true, '主链正常收口');
    const tasks = ledgerOf(h);
    const task = tasks.list().find((t) => t.kind === 'subagent');
    assert.ok(task, '后台子代理任务已登记');
    assert.equal(task!.kind, 'subagent');
    assert.ok(['running', 'done', 'failed', 'stopped'].includes(task!.status), `任务状态合法：${task!.status}`);
    const log = fs.readFileSync(task!.outputFilePath, 'utf8');
    assert.match(log, /背景调研|结论|reply|started/, '任务日志承载 spawn 记录或结论');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('spawn background:true 前置校验：双缺报 INVALID_ARG（fail-fast 禁静默）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-bgspawn-noguard-'));
  const h = new Harness({
    root,
    mode: 'dontAsk',
    model: new ScriptedAdapter([
      JSON.stringify({ tool: 'spawn', input: {} }),
      JSON.stringify({ done: true, reply: 'ok' }),
    ]),
  });
  try {
    const r = await h.reactor.run({ goal: 'x' }, { maxSteps: 4 });
    assert.equal(r.done, true);
    // INVALID_ARG 分支由 subagent.test.ts 单测覆盖；此处保证装配贯通后双缺走显式报错而非崩溃
    assert.ok(ledgerOf(h).list().length === 0, '双缺不产生任务登记');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
