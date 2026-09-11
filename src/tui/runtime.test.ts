import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRuntime } from './runtime';
import { ScriptedAdapter } from '../model/adapter';
import { SessionEvent } from '../types';

test('createRuntime：事件贯通 + runTask 完成 + runs 账本落盘（会话同源）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt-'));
  try {
    const events: SessionEvent[] = [];
    const rt = createRuntime({
      root: tmp,
      model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']),
      onEvent: (e) => events.push(e),
    });
    const r = await rt.runTask('做一件事');
    assert.equal(r.done, true);
    assert.ok(events.some((e) => e.type === 'done'), 'done 事件应贯通到 TuiRuntime 注入者');
    assert.ok(events.some((e) => e.type === 'token'), 'token 事件应贯通');
    assert.equal(rt.harness.ledger.summary().runs, 1, '账本经 TUI run 同样落盘（会话同源）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createRuntime：manual 模式 + onApproval 脚本应答 → 非白名单命令放行一次', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt2-'));
  try {
    let asked = 0;
    const rt = createRuntime({
      root: tmp,
      mode: 'manual',
      model: new ScriptedAdapter([
        '{"tool":"exec","input":{"command":"touch tui-ok.txt"},"done":false}',
        '{"done":true,"reply":"ok"}',
      ]),
      onApproval: async () => {
        asked += 1;
        return 'allow';
      },
    });
    const r = await rt.runTask('跑个命令');
    assert.equal(r.done, true);
    assert.equal(asked, 1, '非白名单命令应走一次审批');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createRuntime：不传 onApproval 时 manual 保持阶段一拒绝语义（写命令被拒）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt3-'));
  try {
    const rt = createRuntime({
      root: tmp,
      mode: 'manual',
      model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']),
    });
    const r = await rt.runTask('只说不做');
    assert.equal(r.done, true);
    assert.ok(rt.harness.security, 'guard 门面可达（装配面存在）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createRuntime：model 透传到 harness.model（TUI 装配链不静默回落 stub）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt4-'));
  try {
    const m = new ScriptedAdapter(['{"done":true,"reply":"ok"}']);
    const rt = createRuntime({ root: tmp, model: m });
    assert.equal(rt.harness.model, m, '模型装配不得在接缝处丢失');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createRuntime：主链经 Loop——不做任何事也走长任务模板（iterations 可观测）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt5-'));
  try {
    const rt = createRuntime({ root: tmp, model: new ScriptedAdapter(['{"done":true,"reply":"ok"}']) });
    const r = await rt.runTask('做一件事');
    assert.equal(r.done, true);
    assert.equal(r.stopReason, 'done');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createRuntime：未完成时返回结构化 stopReason（不再只有 done=false）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-tuirt6-'));
  try {
    const rt = createRuntime({
      root: tmp,
      model: new ScriptedAdapter(['{"tool":"glob","input":{"pattern":"*"},"done":false}']),
    });
    const r = await rt.runTask('一直调工具', { maxSteps: 1 });
    assert.equal(r.done, false);
    assert.equal(r.stopReason, 'max-steps');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
