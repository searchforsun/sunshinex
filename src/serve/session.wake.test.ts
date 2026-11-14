import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionRuntime } from './session';
import type { DaemonFrame } from './daemon-wire';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter, UsageHooks } from '../model/adapter';
import type { ChatRequest, ChatResult, SessionKind } from '../types';
import { wakeOfRun } from '../session/wake';
import { WAKE_HINT } from '../harness/tasks';

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
 *  finally 兜 teardown——断言失败也不留悬挂 run/唤醒 timer/事件循环。
 *  birth 选项（2026-11-15 sunx P1 Task 5）：kind/name/charter 直透 SessionRuntime 构造入参——
 *  sunx 唤醒闭环用例经同一装配样板铸 sunx 会话；缺席=standard 既有路径逐字节不变 */
async function withSession(
  model: ModelAdapter,
  fn: (ctx: Ctx) => Promise<void>,
  birth?: { kind?: SessionKind; name?: string; charter?: string },
): Promise<void> {
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
      ...(birth?.kind !== undefined ? { kind: birth.kind } : {}),
      ...(birth?.name !== undefined ? { name: birth.name } : {}),
      ...(birth?.charter !== undefined ? { charter: birth.charter } : {}),
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

// ═════════════════════════════════════════════════════════════════════════════
// sunx 唤醒闭环端到端（2026-11-15 sunx P1 Task 5，纯测试任务零生产改动）：kind:'sunx' 装配
// （SUNX_FACE_TOOLS 白名单七件含 dispatch_task/task_status）+ bg-wake 全链消费——
// 分派回执 taskId+WAKE_HINT（宿主闸① hint:true × 闸② 主链归属合成）→ 派发子代真跑（fork Reactor）
// → 台账终态 → WakeController 空闲合批（缺省 1.5s）→ 单条唤醒轮（notice→run 配对/wakeOfRun）。
// 驱动面全用既有原语：withSession 直构（本套件既有形态）+ waitFor 轮询（不发明新等待）；
// 子代时序确定性经测试闸门（subagent.spawn.test.ts 同款 gate 先例）——子代首轮挂闸、测试放闸
// 即「驱动后台任务先后 finish」；主链关键轮同样可挂闸（给「终态于运行中到达」「steer 入队于
// 唤醒轮在途」确定性窗口）。
//
// 主链/子代脚本路由（SunxRoutedAdapter）：harness 单模型——主链与派发子代共享同一 ModelAdapter，
// 脚本级路由键=请求 user 消息**整条**恰为派发简报 marker。依据：spec 只经子代 task 行进 user 消息面
// （resolveSpawnSpec taskLine=prompt 原文，buildMessages task 行=user 消息整条）；主链侧 marker 仅
// 出现在 [tool] 调用行（聚合为 assistant.tool_calls 参数，非 user 消息）、任务日志尾（spawn 行含
// prompt 原文，但只经唤醒 notice 的 note 行回流——同为**非整条**匹配）。故整条恰等匹配两轨互不串号，
// 子代各 marker 独立队列互不串号。
// ═════════════════════════════════════════════════════════════════════════════

/** 步骤两态：预制轮结果（stop/工具调用面）或函数轮（运行期求值——函数形态供脚本挂测试闸门与
 *  读台账真 id：task_status 窥视需真 taskId，静态脚本写不出动态 id） */
type SunxStep = ChatResult | ((io: SunxTestIo) => ChatResult | Promise<ChatResult>);

/** 脚本函数的运行期读口：台账 id 快照（分派回执的 taskId 动态铸造，窥视脚本经此取真值） */
interface SunxTestIo {
  taskIds(): string[];
}

/** 测试闸门：promise + 放闸（重复放闸幂等）——子代/主链关键轮挂闸，测试按序放行得确定性时序 */
interface SunxGate {
  readonly wait: Promise<void>;
  open(): void;
}

function gatedPair(): SunxGate {
  let open!: () => void;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open: () => open() };
}

const stop = (content: string): ChatResult => ({ finish: 'stop', content, toolCalls: [] });
const callOne = (name: string, args: Record<string, unknown>): ChatResult => ({
  finish: 'tool_calls',
  content: '',
  toolCalls: [{ id: 'call_0', name, argsJson: JSON.stringify(args) }],
});
const callMany = (...calls: Array<{ name: string; args: Record<string, unknown> }>): ChatResult => ({
  finish: 'tool_calls',
  content: '',
  toolCalls: calls.map((c, i) => ({ id: `call_${i}`, name: c.name, argsJson: JSON.stringify(c.args) })),
});

/** dispatch_task 出牌面（sunx 白名单件）：spec=marker 原文（路由键），label=台账任务名 */
const dispatch = (spec: string, label: string) => ({
  name: 'dispatch_task',
  args: { spec, label, agent_id: null, tier: null, isolation: null },
});

/** 双轨可编程适配器：主链一条脚本、派发子代按 marker 各一条队列（下标推进镜像 ScriptedAdapter.next：
 *  末步驻留防越界）。主链已消耗轮数外窥（mainCalls）供 waitFor 锚「某轮已在挂闸中」的确定性等待 */
class SunxRoutedAdapter implements ModelAdapter {
  readonly provider = 'scripted';
  mainCalls = 0;
  private readonly mainState = { i: 0 };
  private readonly childStates = new Map<string, { i: number }>();

  constructor(
    private readonly io: SunxTestIo,
    private readonly main: SunxStep[],
    private readonly children: Array<{ marker: string; steps: SunxStep[] }>,
  ) {}

  async chat(req: ChatRequest, hooks?: UsageHooks): Promise<ChatResult> {
    hooks?.onUsage?.(0);
    const marker = this.route(req);
    if (marker === undefined) {
      this.mainCalls += 1;
      return this.play(this.main, this.mainState);
    }
    let state = this.childStates.get(marker);
    if (state === undefined) {
      state = { i: 0 };
      this.childStates.set(marker, state);
    }
    return this.play(this.children.find((c) => c.marker === marker)!.steps, state);
  }

  async chatStream(req: ChatRequest, onDelta: (t: string) => void, hooks?: UsageHooks): Promise<ChatResult> {
    const r = await this.chat(req, hooks);
    for (const ch of r.content) onDelta(ch);
    return r;
  }

  /** 路由判定单点：某条 user 消息**整条**恰等某 marker → 该子代队列；否则主链 */
  private route(req: ChatRequest): string | undefined {
    for (const m of req.messages) {
      if (m.role !== 'user' || typeof m.content !== 'string') continue;
      const hit = this.children.find((c) => m.content === c.marker);
      if (hit !== undefined) return hit.marker;
    }
    return undefined;
  }

  private async play(queue: SunxStep[], state: { i: number }): Promise<ChatResult> {
    const step = queue[state.i] ?? stop('script exhausted');
    state.i = Math.min(state.i + 1, queue.length - 1); // 镜像 ScriptedAdapter.next：末步驻留
    if (typeof step === 'function') return await step(this.io);
    return step;
  }
}

/** 收口读面单点：唤醒 notice 条（wake 引用在场的机制条——ask 回执等普通 notice 天然不在列） */
function wakeNotices(ents: ReturnType<SessionRuntime['sessionKernel']['replay']>) {
  return ents.filter((e) => e.kind === 'notice' && e.wake !== undefined);
}

test('sunx 唤醒闭环：双 dispatch_task 回执 taskId+WAKE_HINT → 两任务先后 finish → 合批后单条唤醒轮', async () => {
  const gateAlpha = gatedPair();
  const gateBeta = gatedPair();
  let sess: SessionRuntime | undefined;
  const io: SunxTestIo = { taskIds: () => sess?.runtime.harness.tasks.list().map((t) => t.id) ?? [] };
  const model = new SunxRoutedAdapter(
    io,
    [
      callMany(dispatch('ALPHA-SPEC', 'alpha'), dispatch('BETA-SPEC', 'beta')), // 第一轮：并行两派发
      stop('first done'), // 派发轮收束后正文收轮（收轮等唤醒）
      stop('woken reply'), // 唤醒轮：终稿收束
    ],
    [
      { marker: 'ALPHA-SPEC', steps: [async () => { await gateAlpha.wait; return stop('alpha done'); }] },
      { marker: 'BETA-SPEC', steps: [async () => { await gateBeta.wait; return stop('beta done'); }] },
    ],
  );
  try {
    await withSession(
      model,
      async (ctx) => {
        sess = ctx.session;
        const ctl = ctx.session;
        const entries = () => ctl.sessionKernel.replay();
        assert.equal(ctl.sessionKind, 'sunx', 'sunx 会话出生装配');
        assert.equal(ctl.submit('sweep the workspace').ok, true);
        await waitFor(() => ctl.status() === 'idle', 15_000); // 第一轮收束（子代挂闸在跑）
        // 分派回执面：两条回执各含 taskId 与 WAKE_HINT（收轮等唤醒——「可选出路非指令」）
        const receipts = entries().filter(
          (e) => e.kind === 'tool' && e.result !== undefined && (e.result.full ?? e.result.text).startsWith('task '),
        );
        assert.equal(receipts.length, 2, '两条分派回执在转录面');
        const ledger = ctl.runtime.harness.tasks;
        const ids = ledger.list().map((t) => t.id).sort();
        assert.equal(ids.length, 2, '台账两任务');
        assert.ok(ledger.list().every((t) => t.ownerRun === 'main'), '分派恒主链归属（唤醒闸②）');
        for (const r of receipts) {
          const text = r.result!.full ?? r.result!.text;
          assert.match(text, /^task \S+ started \(output: /, '回执与 spawn 后台分支同形');
          assert.ok(text.includes(WAKE_HINT), '回执尾追 WAKE_HINT（宿主闸①×②合成）');
          assert.ok(ids.some((id) => text.includes(id)), '回执含台账 taskId');
        }
        // 驱动两后台任务先后 finish（done）：子代真跑——放闸 → 子 Reactor 终稿 → 结论落日志 → ledger.finish
        gateAlpha.open();
        await waitFor(() => ledger.list().some((t) => t.status === 'done'), 15_000);
        gateBeta.open();
        await waitFor(() => ledger.list().every((t) => t.status === 'done'), 15_000);
        // 合批窗（缺省 1.5s）内两终态并至 → 单条唤醒轮自动起跑并收束
        await waitFor(() => wakeNotices(entries()).length > 0, 10_000);
        await waitFor(() => ctl.status() === 'idle', 15_000);
        const ents = entries();
        const notices = wakeNotices(ents);
        assert.equal(notices.length, 1, '合批窗内两终态合并为一批：恰一条唤醒 notice');
        const idx = ents.indexOf(notices[0]!);
        assert.ok(idx > 0, '唤醒 notice 在场');
        assert.equal(ents[idx + 1]?.kind, 'run', '转录序 notice→run');
        const refs = wakeOfRun(ents, idx + 1);
        assert.ok(refs !== undefined && refs.length === 2, 'wakeOfRun 配对成立且两引用齐');
        assert.deepEqual(refs!.map((r) => r.id).sort(), ids, '唤醒引用=两台账 id');
        const md = notices[0]!.md;
        assert.match(md, /<task-notification>/, '模型面通知文（isQuietNotice 同源标签）');
        assert.ok(md.includes('alpha') && md.includes('beta'), '通知文含两任务回执（label 列）');
        assert.ok(ids.every((id) => md.includes(id)), '通知文含两任务回执（id 寻址）');
        assert.equal(
          ents.some((e) => e.kind === 'user' && e.ts >= notices[0]!.ts && (ents[idx + 1]?.ts ?? 0) >= e.ts),
          false,
          '唤醒轮无 user 条',
        );
        assert.equal(ctx.frames.some((f) => f.kind === 'event' && f.e.type === 'user'), false, '全程无 user 气泡帧（broadcastUserEcho 零调用）');
        assert.ok(ents.some((e) => e.kind === 'assistant' && e.md === 'woken reply'), '唤醒轮终稿收束（连续唤醒计数随 fire 推进的可观测面）');
      },
      { kind: 'sunx', name: '晨曦', charter: '以品性为纲：只编排，不亲做。' },
    );
  } finally {
    gateAlpha.open(); // 兜底放闸：断言失败也不留悬挂子 Reactor
    gateBeta.open();
  }
});

test('sunx 窥视消费与 steer 优先：task_status 窥视即消费不再唤醒；唤醒轮在途 steer 入队——用户轮先跑、pending 后补', async () => {
  const gateA = gatedPair(); // 窥视段子代：终态于主链运行中到达
  const gateB = gatedPair(); // steer 段子代 B：先终态者，起唤醒轮
  const gateC = gatedPair(); // steer 段子代 C：唤醒轮在途中终态者，pending 留存
  const mainGate = gatedPair(); // 主链第二轮挂闸：「任务终态于运行中到达」确定性窗口
  const wakeGate = gatedPair(); // 唤醒轮挂闸：「steer 入队于唤醒轮在途」确定性窗口
  let sess: SessionRuntime | undefined;
  const io: SunxTestIo = { taskIds: () => sess?.runtime.harness.tasks.list().map((t) => t.id) ?? [] };
  const model = new SunxRoutedAdapter(
    io,
    [
      callMany(dispatch('PEEK-SPEC', 'peek-a')), // ①第一轮：派发 A
      async () => {
        await mainGate.wait; // ②挂闸：测试在此窗内驱动 A 终态（busy→pending 留存）
        return callOne('task_status', { taskIds: io.taskIds() }); // ③续轮：窥视终态任务（消费）
      },
      stop('first turn done'), // ④轮收束 → 唤醒汇空批（已消费）→ 不触发
      callMany(dispatch('STEER-SPEC-B', 'steer-b'), dispatch('STEER-SPEC-C', 'steer-c')), // ⑤派发 B/C
      stop('second turn done'), // ⑥收轮等唤醒
      async () => {
        await wakeGate.wait; // ⑦B 的唤醒轮挂闸：测试在此窗内驱动 C 终态 + steer 入队
        return stop('woken for b');
      },
      stop('user turn ack'), // ⑧steer 续跑用户轮（先于 C 的唤醒）
      stop('woken for c'), // ⑨C 的唤醒轮（后补）
    ],
    [
      { marker: 'PEEK-SPEC', steps: [async () => { await gateA.wait; return stop('peek-a done'); }] },
      { marker: 'STEER-SPEC-B', steps: [async () => { await gateB.wait; return stop('b done'); }] },
      { marker: 'STEER-SPEC-C', steps: [async () => { await gateC.wait; return stop('c done'); }] },
    ],
  );
  try {
    await withSession(model, async (ctx) => {
      sess = ctx.session;
      const ctl = ctx.session;
      const entries = () => ctl.sessionKernel.replay();
      const ledger = () => ctl.runtime.harness.tasks;
      // ── 段1：窥视消费——终态任务被 task_status 回执面消费后不再唤醒 ──
      assert.equal(ctl.submit('collect and verify').ok, true);
      await waitFor(() => model.mainCalls === 2, 15_000); // 主链第二轮已在挂闸中
      gateA.open(); // 任务终态于运行中到达：onFinished→busy→pending 留存（无合批 timer）
      await waitFor(() => ledger().list().every((t) => t.status !== 'running'), 15_000);
      mainGate.open(); // 主链续轮：task_status 窥视终态任务
      await waitFor(() => ctl.status() === 'idle', 15_000);
      const peeked = ledger().list().map((t) => t.id);
      assert.equal(peeked.length, 1);
      assert.equal(ledger().isReceipted(peeked[0]!), true, 'task_status 终态行即 markReceipted（窥视即消费）');
      assert.ok(
        entries().some((e) => e.kind === 'tool' && e.result !== undefined && (e.result.full ?? '').includes('all target tasks finished')),
        '窥视回执在转录面',
      );
      assert.equal(wakeNotices(entries()).length, 0, '轮收束前已被窥视消费——唤醒汇空批不触发');
      await new Promise((r) => setTimeout(r, 2_200)); // 负向断言只能有界等待（合批窗 1.5s+裕量；waitFor 表达不了「不发生」）
      assert.equal(wakeNotices(entries()).length, 0, '消费后永不唤醒');
      // ── 段2：steer 优先与 pending 后补——唤醒轮在途入队，用户轮先跑、C 的唤醒轮后补 ──
      assert.equal(ctl.submit('handle the remaining items').ok, true);
      await waitFor(() => ctl.status() === 'idle', 15_000); // B/C 挂闸 running
      const idB = ledger().list().find((t) => t.label === 'steer-b')!.id;
      const idC = ledger().list().find((t) => t.label === 'steer-c')!.id;
      gateB.open(); // B 先终态：空闲合批窗开
      await waitFor(() => ledger().get(idB)?.status === 'done', 15_000);
      await waitFor(() => wakeNotices(entries()).length > 0, 10_000); // 唤醒轮（B）起跑
      await waitFor(() => model.mainCalls === 6, 15_000); // 唤醒轮模型轮已在挂闸中
      gateC.open(); // C 终态于唤醒轮在途：busy→pending 留存
      await waitFor(() => ledger().get(idC)?.status === 'done', 15_000);
      ctl.steer('actually also summarize the findings'); // 用户 steer 入队（唤醒轮在途）
      wakeGate.open(); // B 的唤醒轮收束 → steer 优先分支接管
      await waitFor(() => ctl.status() === 'idle', 15_000); // 用户轮与 C 的唤醒轮全部收束
      const ents = entries();
      const notices = wakeNotices(ents);
      assert.equal(notices.length, 2, 'B/C 各起一条唤醒轮（C 为用户轮后补发）');
      assert.deepEqual(notices[0]!.wake!.map((r) => r.id), [idB], '首唤醒轮=B（合批窗内单终态）');
      assert.deepEqual(notices[1]!.wake!.map((r) => r.id), [idC], '后补唤醒轮=pending 留存的 C');
      const steerUser = ents.find((e) => e.kind === 'user' && e.md === 'actually also summarize the findings');
      assert.ok(steerUser !== undefined, 'steer 续跑轮 user 条在转录');
      assert.ok(notices[0]!.ts < steerUser!.ts && steerUser!.ts < notices[1]!.ts, '用户轮先跑：夹在两唤醒轮之间');
      for (const n of notices) {
        const i = ents.indexOf(n);
        assert.equal(ents[i + 1]?.kind, 'run', '转录序 notice→run');
        assert.ok(wakeOfRun(ents, i + 1) !== undefined, 'wakeOfRun 配对成立');
      }
      assert.ok(
        ctx.frames.some((f) => f.kind === 'event' && f.e.type === 'user' && f.e.text === 'actually also summarize the findings'),
        'steer 续跑 user 回显帧（broadcastUserEcho）',
      );
      assert.ok(ents.some((e) => e.kind === 'assistant' && e.md === 'woken for c'), '后补唤醒轮终稿收束');
    }, { kind: 'sunx' });
  } finally {
    gateA.open();
    gateB.open();
    gateC.open();
    mainGate.open();
    wakeGate.open();
  }
});

test('sunx 子任务路由 ask：派发子智能体 ask_question → 主对话挂起卡（askedBy=子标签）→ 回答后子任务续跑并唤醒', async () => {
  let sess: SessionRuntime | undefined;
  const io: SunxTestIo = { taskIds: () => sess?.runtime.harness.tasks.list().map((t) => t.id) ?? [] };
  const model = new SunxRoutedAdapter(
    io,
    [
      callMany(dispatch('ASK-SPEC', 'asker')), // 派发子智能体
      stop('dispatched, standing by'), // 主链收轮（子代挂起卡在途）
      stop('resumed after sub answer'), // 唤醒轮：接续收束
    ],
    [
      {
        marker: 'ASK-SPEC',
        steps: [
          callOne('ask_question', {
            question: 'Which port should the service bind to?',
            options: [{ label: '3000' }, { label: '8080' }],
            multiple: null,
            allowCustom: true,
          }), // 子代路由 ask → 主对话挂起卡（阻塞等回答）
          stop('sub conclusion after answer'), // 回答后续跑到终态
        ],
      },
    ],
  );
  await withSession(model, async (ctx) => {
    sess = ctx.session;
    const ctl = ctx.session;
    const entries = () => ctl.sessionKernel.replay();
    assert.equal(ctl.submit('wire the service').ok, true);
    await waitFor(() => ctl.status() === 'idle', 15_000); // 主链收轮（子代在挂起卡上）
    // 主对话挂起卡到达（deps.ask 路由：askedBy 归因随请求透传）
    let askFrame: Extract<DaemonFrame, { kind: 'ask' }> | undefined;
    await waitFor(() => {
      if (askFrame === undefined) {
        const hit = ctx.frames.find((f): f is Extract<DaemonFrame, { kind: 'ask' }> => f.kind === 'ask');
        if (hit !== undefined) askFrame = hit;
      }
      return askFrame !== undefined;
    }, 15_000);
    const subTask = ctl.runtime.harness.tasks.list().find((t) => t.label === 'asker');
    assert.ok(subTask !== undefined, '派发台账任务在场');
    assert.equal(askFrame!.req.question, 'Which port should the service bind to?');
    assert.equal(askFrame!.req.askedBy?.label, 'asker', 'askedBy=子标签归因');
    assert.equal(askFrame!.req.askedBy?.taskId, subTask!.id, 'askedBy.taskId=派发台账 id');
    assert.ok(
      ctl.pendingSnapshot().some((p) => p.kind === 'ask' && p.pid === askFrame!.pid),
      '挂起表在册（daemon POST /ask/:pid/reply 寻址键）',
    );
    // 回答 → 子任务续跑到终态 → Sunx 被唤醒接续
    assert.equal(ctl.resolvePendingAsk(askFrame!.pid, { type: 'custom', text: 'bind 8080' }), true);
    await waitFor(() => ctl.runtime.harness.tasks.get(subTask!.id)?.status === 'done', 15_000);
    await waitFor(() => wakeNotices(entries()).length > 0, 10_000);
    await waitFor(() => ctl.status() === 'idle', 15_000);
    const ents = entries();
    const notices = wakeNotices(ents);
    assert.equal(notices.length, 1, '恰一条唤醒轮');
    assert.deepEqual(notices[0]!.wake!.map((r) => r.id), [subTask!.id], '唤醒引用=派发台账 id');
    assert.match(notices[0]!.md, /\(subagent\) done/, '回执=台账 subagent 终态行');
    assert.match(notices[0]!.md, /sub conclusion after answer/, '子任务结论经 receiptBody 进通知文（续跑到终态的证据）');
    const idx = ents.indexOf(notices[0]!);
    assert.equal(ents[idx + 1]?.kind, 'run', '转录序 notice→run');
    assert.ok(wakeOfRun(ents, idx + 1) !== undefined, 'wakeOfRun 配对成立');
    assert.equal(ctl.pendingSnapshot().length, 0, '回答后挂起卡清表');
    assert.ok(ents.some((e) => e.kind === 'assistant' && e.md === 'resumed after sub answer'), 'Sunx 唤醒接续收束');
  }, { kind: 'sunx' });
});

test('sunx 面隔离：同一派发轨迹跑 standard 会话——dispatch_task 不在面（TOOL_NOT_FOUND），零台账零唤醒面', async () => {
  const io: SunxTestIo = { taskIds: () => [] };
  const model = new SunxRoutedAdapter(
    io,
    [
      callMany(dispatch('ALPHA-SPEC', 'alpha'), dispatch('BETA-SPEC', 'beta')), // 与闭环用例同一 scripted 轨迹
      stop('cannot dispatch, replying plainly'),
    ],
    [], // 无子代：standard 面无分派件，派发不可达
  );
  await withSession(model, async (ctx) => {
    const ctl = ctx.session;
    const entries = () => ctl.sessionKernel.replay();
    assert.equal(ctl.sessionKind, undefined, 'standard 会话（kind 缺席）');
    assert.equal(ctl.submit('sweep the workspace').ok, true);
    await waitFor(() => ctl.status() === 'idle', 15_000);
    const ents = entries();
    const rejected = ents.filter(
      (e) => e.kind === 'tool' && e.result !== undefined && (e.result.full ?? e.result.text).includes('Tool not registered: dispatch_task'),
    );
    assert.equal(rejected.length, 2, '两笔分派均被面越界守护拒绝（INVALID 工具名路径）');
    assert.equal(ctl.runtime.harness.tasks.list().length, 0, '零台账：无任务被派发');
    const receiptText = ents
      .filter((e) => e.kind === 'tool' && e.result !== undefined)
      .map((e) => e.result!.full ?? e.result!.text)
      .join('\n');
    assert.ok(!receiptText.includes(WAKE_HINT), 'standard 面无 WAKE_HINT 回执（闸②主链归属面前先无分派件）');
    assert.equal(wakeNotices(ents).length, 0);
    await new Promise((r) => setTimeout(r, 2_200)); // 负向断言有界等待（合批窗 1.5s+裕量）
    assert.equal(ctl.status(), 'idle');
    assert.equal(wakeNotices(entries()).length, 0, '轨迹失败于工具不存在——永不唤醒');
  });
});
