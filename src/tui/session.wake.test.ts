import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionController } from './session';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import type { KernelEntry } from '../session/entry';
import type { SessionKernel } from '../session/kernel';

/** 控制器级 bg-wake 端到端（bg-wake spec §9 宿主集成，批E——TUI 宿主）：直构 SessionController，
 *  装配段随 session.steer.test.ts（waitFor 20ms 轮询 + ctrl.submit 既有提交驱动口），断言语义随 brief 逐字。
 *  第一轮模型后台 exec 后收轮 → 任务终态经 harness wake 汇（批C）登记 → 空闲合批（缺省 1.5s）→
 *  唤醒轮自动起跑：转录序 notice(wake)→run、两轮间无 user 行、Spinner 前缀（state.wakePrefix）含任务名
 *  （purpose→WakeRef.name→wakePrefix——比 daemon 侧 /ping/ label 断言更强的显示面断言，预检裁定）。
 *  注：脚本化模型轮窗仅毫秒级（收口即回 idle），running 窗靠门控适配器驻留（沉淀管线收口说明轮
 *  也消耗脚本步——门控按请求内容（唤醒通知文标记）命中，不按调用序，管线轮永不被门）。 */

/** 轮询等待（同 session.steer.test.ts）：20ms 片轮询直至 pred 为真，超时抛错——合批窗/后台退出时序
 *  不硬 sleep（预检裁定：waitFor(status 翻转) 代替固定 sleep） */
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
}

/** kernel 条目读口：kernel 为控制器私有（TUI 既有测试面无公开转录读口）——测试侧窄类型透镜
 *  （session-journal.test 同款 as unknown as 惯例；daemon 侧对等读口为 sessionKernel.replay()） */
function kernelEntries(ctrl: SessionController): KernelEntry[] {
  return (ctrl as unknown as { kernel: SessionKernel }).kernel.replay();
}

/** 门控脚本适配器（session.steer.test.ts gatedAdapter 同族，按内容命中替代按调用序）：ScriptedAdapter
 *  步骤照常出牌，首个含 mark 串（唤醒通知文 '<task-notification>'，仅唤醒轮请求携带）的模型调用阻塞
 *  在 gate 上——测试借此在唤醒轮 running 窗稳定断言/插入穿插行（消除时序竞态） */
function gatedScripted(
  steps: Array<{ content?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }>,
  mark: string,
): { adapter: ModelAdapter; release: () => void } {
  const gate = deferred();
  let gated = false; // 一次性：只门首个命中请求（测试 2 的第二唤醒轮直接放行）
  const inner = new ScriptedAdapter(steps);
  const adapter: ModelAdapter = {
    provider: 'gated-wake',
    chat: async (req) => {
      if (!gated && req.messages.some((m) => typeof m.content === 'string' && m.content.includes(mark))) {
        gated = true;
        await gate.promise;
      }
      return inner.chat(req);
    },
  };
  return { adapter, release: () => gate.release() };
}

test('TUI 唤醒：空闲合批起轮 + 转录序 notice(wake)→run + 无 user 行', async () => {
  const tmp = tmpdir('sunshinex-sess-wake1-');
  try {
    // 第一轮：模型先 exec(background) 再收轮；第二轮（唤醒轮）：正文收束。
    // 睡眠 600ms（brief 夹具 150ms 的稳态化）：保证后台任务终态晚于第一轮收口——唤醒恒经合批窗起跑，
    // idle→running→idle 的观察序才有定义（预检裁定：装配段随既有文件适配，断言语义逐字）
    const { adapter, release } = gatedScripted([
      { content: '', toolCalls: [{ name: 'exec', args: { command: 'node -e "setTimeout(()=>process.exit(0),600)"', kind: 'executes', background: true, purpose: 'ping' } }] },
      { content: 'first done', toolCalls: [] },
      { content: 'woken reply', toolCalls: [] },
    ], '<task-notification>');
    const ctrl = new SessionController({ root: tmp, model: adapter });
    await ctrl.submit('kick off bg work'); // 既有提交驱动口（session.steer.test.ts 同形）
    await waitFor(() => ctrl.state.status === 'idle'); // 第一轮收束（后台 exec 在跑）
    await waitFor(() => ctrl.state.status === 'running', 10_000); // 唤醒轮起跑（合批窗；门控驻留 running 窗）
    assert.ok((ctrl.state.wakePrefix ?? '').includes('ping'), '唤醒轮标含任务名（purpose→WakeRef.name→wakePrefix，running 窗口内断言）');
    release(); // 放行唤醒轮模型调用
    await waitFor(() => ctrl.state.status === 'idle', 10_000); // 唤醒轮收束
    const entries = kernelEntries(ctrl);
    const idx = entries.findIndex((e) => e.kind === 'notice' && e.wake !== undefined);
    assert.ok(idx > 0);
    assert.equal(entries[idx + 1]?.kind, 'run');
    assert.equal(entries.filter((e) => e.kind === 'user' && e.seq > (entries[idx - 1]?.seq ?? 0) && e.seq < (entries[idx + 1]?.seq ?? 0)).length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('用户优先：唤醒 pending 在场时排队用户消息先跑', async () => {
  const tmp = tmpdir('sunshinex-sess-wake2-');
  try {
    // 第一轮起两个后台 exec：ping1（600ms，先终态触发唤醒轮#1）、ping2（3.5s，唤醒轮#1 在途期终态→登记 pending）。
    // 唤醒轮#1 的模型调用阻塞在 gate 上——在途窗稳定完成「排队用户消息 + 第二任务终态」两件插队事实
    const { adapter, release } = gatedScripted([
      { content: '', toolCalls: [
        { name: 'exec', args: { command: 'node -e "setTimeout(()=>process.exit(0),600)"', kind: 'executes', background: true, purpose: 'ping1' } },
        { name: 'exec', args: { command: 'node -e "setTimeout(()=>process.exit(0),3500)"', kind: 'executes', background: true, purpose: 'ping2' } },
      ] },
      { content: 'first woken', toolCalls: [] }, // 唤醒轮#1（gate 阻塞）
      { content: 'user round done', toolCalls: [] }, // drainQueue 补跑的用户轮
      { content: 'second woken', toolCalls: [] }, // 唤醒轮#2（用户轮收束续发）
    ], '<task-notification>');
    const ctrl = new SessionController({ root: tmp, model: adapter });
    await ctrl.submit('kick off bg work');
    await waitFor(() => ctrl.state.status === 'idle'); // 第一轮收束
    await waitFor(() => ctrl.state.status === 'running', 10_000); // 唤醒轮#1 起跑（合批窗；门控驻留）
    await ctrl.submit('User steer: check the README'); // 唤醒轮在途：静默入队（轮收束 drainQueue 先发用户行）
    await waitFor(() => ctrl.runtime.harness.tasks.list().filter((x) => x.status !== 'running').length >= 2, 10_000); // ping2 终态（唤醒轮在途=busy 留存 pending）
    release(); // 放行唤醒轮#1 → 收束 → drainQueue 用户行先行 → onTurnEnded 续发唤醒轮#2
    await ctrl.waitIdle(15_000);
    const entries = kernelEntries(ctrl);
    const notices = entries.filter((e) => e.kind === 'notice' && e.wake !== undefined);
    assert.equal(notices.length, 2, '两次唤醒轮（首任务起轮#1 + 用户轮收束续发#2）');
    const users = entries.filter((e) => e.kind === 'user');
    assert.ok(users.some((u) => u.seq > notices[0]!.seq && u.seq < notices[1]!.seq), '转录 user 条先于第二个 wake notice 条出现（drainQueue 用户优先）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('会话换新屏蔽：/new 后旧会话在跑后台任务终态不唤醒新会话', async () => {
  const tmp = tmpdir('sunshinex-sess-wake3-');
  try {
    // 后台 exec 睡 2.5s 跨 /new 存活（任务账本跨软重置不换 Map）：泄漏形态=旧任务日后终态
    // → onTaskFinished → 新会话起唤醒轮（通知讲的是新会话从未发起的任务）
    const model = new ScriptedAdapter([
      { content: '', toolCalls: [{ name: 'exec', args: { command: 'node -e "setTimeout(()=>process.exit(0),2500)"', kind: 'executes', background: true, purpose: 'stale' } }] },
      { content: 'first done', toolCalls: [] },
    ]);
    const ctrl = new SessionController({ root: tmp, model });
    await ctrl.submit('kick off bg work');
    await waitFor(() => ctrl.state.status === 'idle'); // 第一轮收束（后台 exec 仍在跑）
    await ctrl.submit('/new'); // 软重置（控制器既有 /new 入口）：换新内核 + 屏蔽在跑旧任务
    await waitFor(() => ctrl.runtime.harness.tasks.list().every((x) => x.status !== 'running'), 10_000); // 旧任务终态
    // 终态 + 合批窗（缺省 1.5s）余量后取样：泄漏形态的唤醒轮窗毫秒级、但 wake notice 条持久——取条断言
    await new Promise((r) => setTimeout(r, 2200));
    const entries = kernelEntries(ctrl); // 内核已随 /new 换新——读口即新会话转录
    assert.equal(entries.filter((e) => e.kind === 'notice' && e.wake !== undefined).length, 0, '新会话内核无 wake notice 条（旧任务终态被屏蔽集挡下）');
    assert.equal(ctrl.state.status, 'idle', 'status 保持 idle');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
