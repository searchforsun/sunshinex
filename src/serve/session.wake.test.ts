import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionRuntime } from './session';
import type { DaemonFrame } from './daemon-wire';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';

/** 控制器级 bg-wake 端到端（bg-wake spec §9 宿主集成，批D）：不起 HTTP——直构 SessionRuntime
 *  （同 session.test.ts 直构形态：nextSeq/broadcast/mintPid 注入桩）。
 *  第一轮模型后台 exec 后收轮 → 任务终态经 harness wake 汇（批C）登记 → 空闲合批（缺省 1.5s）
 *  → 唤醒轮自动起跑：转录序 notice(wake)→run、两轮间无 user 条、通知文含 <task-notification> 与任务名。
 *  注：SessionController→SessionRuntime / ctl.kernel.state.entries→sessionKernel.replay() /
 *  ctl.current?.done→status() 轮询，均按预检裁定随 serve/session.ts 实际公开面适配；断言语义逐字保留 */

/** 轮询等待（同 session.test.ts 惯例）：20ms 片轮询直至 pred 为真，超时抛错——合批窗/后台退出时序
 *  不硬 sleep（预检裁定：waitFor 轮询代替固定 sleep） */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Ctx {
  session: SessionRuntime;
  frames: DaemonFrame[];
  tmp: string;
}

/** 装配样板（同 session.test.ts withSession）：SUNSHINEX_DATA_DIR 钉 tmp；broadcast 收集帧。
 *  finally 兜 teardown——断言失败也不留悬挂 run/唤醒 timer/事件循环 */
async function withSession(model: ModelAdapter, fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wakedaemon-'));
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  process.env.SUNSHINEX_DATA_DIR = path.join(tmp, 'data');
  let seq = 0;
  let pidSeq = 0;
  const frames: DaemonFrame[] = [];
  let session: SessionRuntime | undefined;
  try {
    session = new SessionRuntime({
      id: 's1',
      root: tmp,
      model,
      nextSeq: () => {
        seq += 1;
        return seq;
      },
      broadcast: (f) => frames.push(f),
      mintPid: () => `pt${(pidSeq += 1)}`,
    });
    await fn({ session, frames, tmp });
  } finally {
    await session?.teardown();
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // win32：收口后偶发目录锁（watcher/句柄迟滞），不挡断言
    }
  }
}

test('daemon 唤醒：空闲合批起轮 + 转录序 + 无 user 条', async () => {
  // 第一轮：模型先 exec(background) 再收轮；第二轮（唤醒轮）：正文收束。
  // 命令尾注 `# ping`：后台 exec 的任务名=purpose('ping')，而回执 label 列=命令原文——
  // 注释把任务名带进 label 列（预检裁定：断言 /ping/ 语义逐字，夹具随 receiptBody 实际形态适配）
  const model = new ScriptedAdapter([
    { content: '', toolCalls: [{ name: 'exec', args: { command: 'node -e "setTimeout(()=>process.exit(0),150)" # ping', kind: 'executes', background: true, purpose: 'ping' } }] },
    { content: 'first done', toolCalls: [] },
    { content: 'woken reply', toolCalls: [] },
  ]);
  await withSession(model, async (ctx) => {
    const ctl = ctx.session;
    const sub = ctl.submit('kick off bg work');
    assert.equal(sub.ok, true);
    await waitFor(() => ctl.status() === 'idle', 15_000); // 第一轮收束（模型已收轮，exec 后台在跑/已退出）
    // 唤醒轮自动起跑：exec 150ms 内退出 → 终态登记 → 空闲合批窗（缺省 1.5s）内 fire → submit(WAKE_GOAL)
    const entries = () => ctl.sessionKernel.replay(); // kernel 公开读口=sessionKernel.replay()（kernel 字段私有，预检裁定）
    await waitFor(() => entries().some((e) => e.kind === 'notice' && e.wake !== undefined), 10_000);
    await waitFor(() => ctl.status() === 'idle', 15_000); // 唤醒轮收束
    const ents = entries();
    const idx = ents.findIndex((e) => e.kind === 'notice' && e.wake !== undefined);
    assert.ok(idx > 0, '存在唤醒 notice 条');
    assert.equal(ents[idx + 1]?.kind, 'run'); // 转录序 notice→run
    const md = ents[idx]?.md ?? '';
    assert.match(md, /<task-notification>/);
    assert.match(md, /ping/); // 回执含任务名（receiptBody 的 label 列）
    assert.equal(ents.some((e) => e.kind === 'user' && e.ts >= (ents[idx]?.ts ?? 0) && (ents[idx + 1]?.ts ?? 0) >= e.ts), false, '唤醒轮无 user 条');
  });
});
