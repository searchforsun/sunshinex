import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModelSwitcher } from '../model/catalog';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import type { ModelChoice } from '../config/providers';
import type { DaemonFrame } from './daemon-wire';
import { SessionRuntime } from './session';

/** G10-C1b 运行中切换面:model switchTo 透传 + snapshot 回显 + mode 重建(idle)。 */

const CHOICES: ModelChoice[] = [
  { id: 'a/m1', provider: 'openai', model: 'm1', baseUrl: 'http://localhost:9' },
  { id: 'a/m2', provider: 'openai', model: 'm2', baseUrl: 'http://localhost:9' },
];

class FakeSwitcher extends ModelSwitcher {
  protected buildAdapter(): ModelAdapter {
    return new ScriptedAdapter(['{"done":true,"reply":"ok"}']);
  }
}

function makeSession(broadcasts?: DaemonFrame[]): SessionRuntime {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-g10-switch-'));
  const sw = new FakeSwitcher({
    default: new ScriptedAdapter(['{"done":true,"reply":"ok"}']),
    choices: CHOICES });
  return new SessionRuntime({
    id: 's1',
    root,
    model: sw,
    modelSwitcher: sw,
    nextSeq: (() => {
      let n = 0;
      return () => ++n;
    })(),
    broadcast: (frame) => broadcasts?.push(frame),
    mintPid: () => 'p1' });
}


/** 轮询判据（确定性等待,替代固定 sleep） */
async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  for (let i = 0; i < ms / 10 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), '条件超时未满足');
}

test('model 切换:switchTo 透传 + snapshot 回显;unknown id false 不动现状', () => {
  const s = makeSession();
  assert.equal(s.snapshotResponse().model, undefined); // 缺省主模型态
  assert.equal(s.setModel('a/m1'), true);
  assert.equal(s.snapshotResponse().model, 'a/m1');
  assert.equal(s.setModel('nope'), false);
  assert.equal(s.snapshotResponse().model, 'a/m1');
  assert.equal(s.setModel(undefined), true); // 回缺省主模型
  assert.equal(s.snapshotResponse().model, undefined);
});

test('模型切换系统提示延后显示(2026-11-23 用户二轮裁定「发出消息后才显示」):setModel 只记挂起,下一条用户消息发出才落转录面;试选切回作废;模型零感知(2026-11-24 三轮裁定)', async () => {
  const frames: DaemonFrame[] = [];
  const s = makeSession(frames);
  const notices = () => frames.filter((f) => f.kind === 'event' && f.e.type === 'notice');
  const chainText = (): string => JSON.stringify(s.runtime.harness.context.chainView());
  try {
    // 缺省主模型 → a/m1：只记挂起,不即时发（来回试选不产生提示）
    assert.equal(s.setModel('a/m1'), true);
    assert.equal(notices().length, 0, '切换当下零 notice');
    assert.equal(chainText().includes('Model switched'), false, '切换当下链上零说明行');
    // 同 id 重选/未知 id：挂起不变
    assert.equal(s.setModel('a/m1'), true);
    assert.equal(s.setModel('nope'), false);
    assert.equal(notices().length, 0);
    // a/m1 → a/m2 → 切回 a/m1：挂起作废（from=缺省,to 最终=a/m1=from → 整段试选零噪音）
    assert.equal(s.setModel('a/m2'), true);
    assert.equal(s.setModel('a/m1'), true);
    assert.equal(s.snapshotResponse().queuePaused === true, false, '占位断言防优化器剔除');
    // 发出消息（submit 用户路径）：挂起说明落转录面（链面不落——模型零感知）
    assert.deepEqual(s.submit('main task'), { ok: true });
    await waitFor(() => s.status() === 'idle');
    assert.equal(notices().length, 1, '发出消息才恰发一条 notice 事件');
    const first = notices()[0];
    assert.ok(first.kind === 'event' && first.e.type === 'notice');
    assert.equal(
      first.kind === 'event' && first.e.type === 'notice' ? first.e.text : '',
      'Model switched from default model to a/m1',
      '用户面 notice 事件（t() 双语单点;from=试选起点合并为一条）',
    );
    assert.equal(first.kind === 'event' ? first.e.payload?.modelSwitch : undefined, true, 'modelSwitch 标记（内核插到回显 user 条之前=提示在上）');
    assert.equal(chainText().includes('Model switched'), false, '链上零说明行——模型对切换零感知（2026-11-24 用户裁定）');
  } finally {
    void s.teardown().catch(() => undefined);
  }
});

test('模型切换系统提示时序:notice 帧先于本轮 run 帧（转录序=说明行在消息上方）', async () => {
  const frames: DaemonFrame[] = [];
  const s = makeSession(frames);
  try {
    assert.equal(s.setModel('a/m1'), true);
    assert.deepEqual(s.submit('main task'), { ok: true });
    await waitFor(() => s.status() === 'idle');
    // 帧序：说明 notice 先于本轮 run-open 帧（用户面转录序=说明行在消息上方;GUI 回显竞态由
    // 内核 modelSwitch 插入规则兜住——见 chat-reducer 同名测试）
    const idxNotice = frames.findIndex((f) => f.kind === 'event' && f.e.type === 'notice');
    const idxRun = frames.findIndex((f) => f.kind === 'event' && f.e.type === 'model-start');
    assert.ok(idxNotice >= 0, '说明 notice 帧应在场');
    assert.ok(idxRun > idxNotice, `说明 notice(${idxNotice}) 应先于本轮 run 帧(${idxRun})`);
  } finally {
    void s.teardown().catch(() => undefined);
  }
});

test('mode 切换:idle 下四值循环回显;snapshot.mode 随之(缺省 full-access=原 dontAsk 地位)', async () => {
  const s = makeSession();
  assert.equal(s.snapshotResponse().mode, 'full-access');
  assert.equal(await s.setMode('read-only'), 'ok');
  assert.equal(s.snapshotResponse().mode, 'read-only');
  assert.equal(await s.setMode('acceptEdits'), 'ok');
  assert.equal(s.snapshotResponse().mode, 'acceptEdits');
  assert.equal(await s.setMode('plan'), 'ok');
  assert.equal(s.snapshotResponse().mode, 'plan');
  assert.equal(await s.setMode('plan'), 'ok'); // 幂等
  assert.equal(s.snapshotResponse().mode, 'plan');
});

test('tier/effort 覆盖:合法值回显、default 清除、非法值 false 不动', () => {
  const s = makeSession();
  assert.equal(s.snapshotResponse().tier, undefined);
  assert.equal(s.setTier('large'), true);
  assert.equal(s.snapshotResponse().tier, 'large');
  assert.equal(s.setTier('huge'), false);
  assert.equal(s.snapshotResponse().tier, 'large');
  s.clearTier();
  assert.equal(s.snapshotResponse().tier, undefined);
  assert.equal(s.setEffort('high'), true);
  assert.equal(s.snapshotResponse().effort, 'high');
  assert.equal(s.setEffort('nope'), false);
  s.clearEffort();
  assert.equal(s.snapshotResponse().effort, undefined);
});

test('2026-11-03 轻量切档:运行中切真档不再 busy——guard 活改即时生效,后续工具按新档判决', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-lightswitch-'));
  // 门控适配器:r1=write(full-access 放行) → r2=write(等待门放行,此时已切 read-only→拒) → r3=done
  let round = 0;
  let release2: () => void = () => undefined;
  const gate2 = new Promise<void>((r) => { release2 = r; });
  const writeCall = (): { finish: 'tool_calls'; content: string; toolCalls: Array<{ id: string; name: string; argsJson: string }> } => ({
    finish: 'tool_calls',
    content: '',
    toolCalls: [{ id: `call_${round}`, name: 'write', argsJson: JSON.stringify({ path: 'mid-run.txt', content: 'x' }) }] });
  const model: ModelAdapter = {
    provider: 'gated',
    async chat() {
      round += 1;
      if (round === 1) return writeCall();
      if (round === 2) { await gate2; return writeCall(); }
      return { finish: 'stop', content: '收尾', toolCalls: [] };
    } } as unknown as ModelAdapter;
  const s = new SessionRuntime({
    id: 's1',
    root,
    model,
    nextSeq: (() => { let n = 0; return () => ++n; })(),
    broadcast: () => {},
    mintPid: () => 'p1' });
  const chainText = (): string => JSON.stringify(s.runtime.harness.context.chainView());
  try {
    assert.deepEqual(s.submit('写个文件'), { ok: true });
    // r1 write 执行完(全档放行,结果行入链)即切 read-only——确定性时序:先等结果行再切
    const deadline = Date.now() + 8000;
    while (!chainText().includes('mid-run.txt')) {
      if (Date.now() > deadline) throw new Error('waitFor 超时:r1 write 结果行');
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(await s.setMode('read-only'), 'ok', '运行中切真档受理(轻量直切,不再 busy)');
    assert.equal(s.runtime.harness.security.mode, 'read-only', 'guard 活改即时生效');
    release2(); // 放行 r2:同一 run 的下一个 write 按新档拒绝
    const deadline2 = Date.now() + 8000;
    while (!chainText().includes('COMMAND_DENIED')) {
      if (Date.now() > deadline2) throw new Error('waitFor 超时:r2 拒绝行');
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(s.snapshotResponse().mode, 'read-only');
    // 空闲恢复后切回 full-access
    const deadline3 = Date.now() + 8000;
    while (s.status() !== 'idle') {
      if (Date.now() > deadline3) throw new Error('waitFor 超时:run 收束');
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(await s.setMode('full-access'), 'ok');
    assert.equal(s.runtime.harness.security.mode, 'full-access');
  } finally {
    await s.teardown().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
