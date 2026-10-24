import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionRuntime } from './session';
import type { DaemonFrame } from './daemon-wire';
import type { SessionRuntimeOpts } from './session';
import { ScriptedAdapter } from '../model/adapter';
import type { ModelAdapter } from '../model/adapter';
import * as runtimeMod from '../session/runtime';
import type { KernelRuntime } from '../session/runtime';
import type { RunOutcome } from '../types';

/** serve plan-arm e2e（spec §5.1-5.2,阶段三 Task 9）：mode='plan' 即 armed——submit 入口拦截转
 *  planFlow（接缝同构 TUI startPlanFlow）;挂起表新增 kind='plan-approval'（payload 计划书+items）,
 *  批准/拒绝决策经挂起表回执 API（resolvePendingPlanApproval）直驱。批准落 acceptEdits 自动解除
 *  arm;拒绝保持 armed,3 轮超限收尾不执行;中断=拒绝回填（TUI approval.ts 语义对齐）产物不注入。
 *  内核档恒三档（arm 在 serve 包装层——构造时 mode:'plan' 传给 serve 会话,装配映射自动落内核
 *  acceptEdits,Task 3 契约）。直构形态（同 session.test.ts 装配样板,不经 GuiDaemon）。 */

/** 轮询等待（同 session.test.ts 惯例）：20ms 片轮询直至 pred 为真,超时抛错;what=超时归因标签 */
async function waitFor(pred: () => boolean, timeoutMs: number, what = '条件'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时: ' + what);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface Ctx {
  session: SessionRuntime;
  frames: DaemonFrame[];
  tmp: string;
}

/** 装配样板（与 session.test.ts withSession 同源实名）：SUNSHINEX_DATA_DIR 钉 tmp;nextSeq 本地计数器;
 *  broadcast 收集帧;extra 透传 mode:'plan'（arm 构造位）。finally 兜 teardown——断言失败也不留悬挂 run */
async function withSession(model: ModelAdapter, fn: (ctx: Ctx) => Promise<void>, extra?: Partial<SessionRuntimeOpts>): Promise<void> {
  const tmp = tmpdir('sunshinex-serve-plan-');
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
      ...(extra ?? {}),
    });
    await fn({ session, frames, tmp });
  } finally {
    await session?.teardown();
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** plan-approval 卡取数帮手：挂起表行 + 同 pid 广播帧（帧面/表面同源断言用） */
function planCard(s: SessionRuntime, frames: DaemonFrame[]): { pid: string; doc: string; items: string[] } {
  const row = s.pendingSnapshot().find((r) => r.kind === 'plan-approval');
  assert.ok(row, '挂起表应有 plan-approval 行');
  const frame = frames.filter((f) => f.kind === 'plan-approval').at(-1) as { pid: string; req: { doc: string; items: string[] } } | undefined;
  assert.ok(frame, '应有 plan-approval 广播帧');
  assert.equal(frame.pid, row.pid, '帧与表同 pid（daemon 级铸造票据）');
  const req = frame.req as { doc: string; items: string[] };
  return { pid: row.pid, doc: req.doc, items: req.items };
}

function chainOf(s: SessionRuntime): Array<{ action?: string; observation: string }> {
  return s.runtime.harness.context.chainView() as unknown as Array<{ action?: string; observation: string }>;
}

test('serve plan-arm：提交→规划(read-only)→挂起卡→批准→acceptEdits→执行;再提交走普通任务(arm 解除判别)', async () => {
  const model = new ScriptedAdapter([
    '{"done":true,"reply":"# 计划\\n背景说明\\n1. 唯一步骤"}', // 规划包(todos 空→正文编号行兜底)
    '{"done":true,"reply":"唯一步骤 完成"}', // 执行包
  ]);
  await withSession(
    model,
    async (ctx) => {
      assert.equal(ctx.session.snapshotResponse().mode, 'plan', '构造位:arm 预备');
      assert.deepEqual(ctx.session.submit('做一件事'), { ok: true });
      // 规划轮在途:running(单 run 锁);卡到达后放行锁——idle 时刻合法是批准续段 setMode 的前置
      await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000);
      const card = planCard(ctx.session, ctx.frames);
      assert.match(card.doc, /# 计划/, '卡携带计划书全文');
      assert.match(card.doc, /背景说明/, '计划书正文段落随卡(payload 非仅编号行)');
      assert.deepEqual(card.items, ['唯一步骤'], 'todos 空→正文编号行兜底为 items');
      assert.equal(ctx.session.status(), 'idle', '卡挂起期锁已放行(idle)——批准续段 setMode 合法性');
      // 流程在途提交契约:卡挂起期(armed+idle+planFlowRunning)提交 409 不排队——单流程在途,裁决走回执端点
      assert.deepEqual(ctx.session.submit('并发提交'), { ok: false, status: 409, error: 'plan flow in progress' }, '流程在途提交拒且不排队');
      // kind 错配路由=404 面:approval 回执打到 plan 卡不命中
      assert.equal(ctx.session.resolvePendingApproval(card.pid, 'deny'), false, 'approval 回执错打 plan 卡=kind 错配 false(404 面)');
      // 批准决策经挂起表回执 API 直驱（决策进 settle 后:续段脱离 submit 半径后台续跑——
      // 等待锚=批准续段的可观测终态,而非 status idle[卡挂起期本就 idle,zero-wait 即真,测不到续段]）
      assert.equal(ctx.session.resolvePendingPlanApproval(card.pid, { approved: true }), true, '批准回执命中');
      assert.equal(ctx.session.resolvePendingPlanApproval(card.pid, { approved: true }), false, '重复回执 false(已删表)');
      await waitFor(() => ctx.session.status() === 'idle' && ctx.session.snapshotResponse().mode === 'acceptEdits', 10_000, '批准落档+执行收尾');
      assert.equal(ctx.session.snapshotResponse().mode, 'acceptEdits', '批准后档位自动落工作区编辑(arm 解除)');
      assert.equal(ctx.session.runtime.harness.security.mode, 'acceptEdits', '内核 guard 基档真切换(重建 runtime 装配映射)');
      const chain = chainOf(ctx.session);
      const planIdx = chain.findIndex((st) => st.action === 'plan');
      assert.ok(planIdx >= 0, '计划书应入链(ChainAction plan,批准后一次)');
      assert.ok(chain[planIdx]!.observation.includes('# 计划'), '计划书全文随行入链');
      const stepIdx = chain.findIndex((st) => st.action === 'task' && st.observation.includes('Current instruction: 唯一步骤'));
      assert.ok(stepIdx > planIdx, '计划书行先于执行指令行入链(执行段经同链读到计划书)');
      assert.ok(chain.some((st) => st.action === 'reply' && st.observation.includes('唯一步骤 完成')), '执行段 run 结论入链(reactor 会话作用域回写)');
      // arm 解除判别:再提交不再走 planFlow——普通任务直跑(零新卡,档位不动)
      assert.deepEqual(ctx.session.submit('再来一件事'), { ok: true });
      await waitFor(() => ctx.session.status() === 'idle', 10_000);
      assert.equal(ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), false, '解除后提交零计划卡');
      assert.equal(ctx.session.snapshotResponse().mode, 'acceptEdits', '解除后提交档位不动');
    },
    { mode: 'plan' },
  );
});

test('serve plan-arm：拒绝附反馈→revising→3 轮超限保持 armed 不执行', async () => {
  const model = new ScriptedAdapter([
    '{"done":true,"reply":"# 计划一\\n1. 步骤A"}',
    '{"done":true,"reply":"# 计划二\\n1. 步骤B"}',
    '{"done":true,"reply":"# 计划三\\n1. 步骤C"}',
  ]);
  await withSession(
    model,
    async (ctx) => {
      assert.deepEqual(ctx.session.submit('g'), { ok: true });
      for (let i = 0; i < 3; i++) {
        await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000);
        const card = planCard(ctx.session, ctx.frames);
        assert.equal(ctx.session.resolvePendingPlanApproval(card.pid, { approved: false, feedback: `fb${i}` }), true, `第 ${i + 1} 轮拒绝回执命中`);
        if (i < 2) await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval' && r.pid !== card.pid), 10_000, `第 ${i + 2} 轮新卡`);
      }
      // 超限收尾的可观测锚=exhausted 如实回执（notice 事件面）——status idle 在卡挂起期本就为真,
      // 测不到流程收束（planFlowRunning 复位不可外窥,回执帧即收束序的发射点）
      await waitFor(
        () => ctx.frames.some((f) => f.kind === 'event' && f.e.type === 'notice' && String(f.e.text ?? '').includes('Plan rejected 3 times')),
        10_000,
        '超限如实回执',
      );
      await waitFor(() => ctx.session.status() === 'idle', 10_000);
      assert.equal(ctx.session.snapshotResponse().mode, 'plan', '拒绝不解除 arm(超限收尾保持 armed)');
      const chain = chainOf(ctx.session);
      assert.ok(chain.every((st) => st.action !== 'task'), '超限不执行任何步骤(链上零执行指令行)');
      assert.ok(!chain.some((st) => st.action === 'plan'), '未批准不注入计划书行');
      // armed 判别:超限后再提交仍走 planFlow(armed 语义=mode==='plan' 即拦截)
      assert.deepEqual(ctx.session.submit('再规划'), { ok: true });
      await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000, 'armed 再提交入规划流程');
      const card2 = planCard(ctx.session, ctx.frames);
      ctx.session.resolvePendingPlanApproval(card2.pid, { approved: false });
      await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval' && r.pid !== card2.pid), 10_000, '修订轮新卡');
      // 收尾:中断在途流程(teardown 前不留悬挂 run;中断不解除 arm 已由第三例专钉)
      assert.deepEqual(ctx.session.interrupt(), { ok: true });
      await waitFor(() => ctx.session.status() === 'idle' && ctx.session.pendingSnapshot().length === 0, 10_000, '中断收尾');
      assert.equal(ctx.session.snapshotResponse().mode, 'plan', '再拒仍保持 armed');
    },
    { mode: 'plan' },
  );
});

test('serve plan-arm：等待批准中中断——拒绝回填走 aborted,产物不注入不执行;手动切档解除 arm', async () => {
  const model = new ScriptedAdapter([
    '{"done":true,"reply":"# 计划\\n1. 步骤A"}',
    '{"done":true,"reply":"新任务完成"}',
  ]);
  await withSession(
    model,
    async (ctx) => {
      assert.deepEqual(ctx.session.submit('做一件事'), { ok: true });
      await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000);
      planCard(ctx.session, ctx.frames);
      // 中断(TUI approval.ts 语义对齐):挂卡=拒绝回填,流程凭中止信号走 aborted——产物不注入执行不启动
      assert.deepEqual(ctx.session.interrupt(), { ok: true }, '挂卡期 interrupt 受理(流程在途)');
      await waitFor(
        () => ctx.frames.some((f) => f.kind === 'event' && f.e.type === 'notice' && String(f.e.text ?? '').includes('Planning interrupted')),
        10_000,
        '中断如实回执',
      );
      await waitFor(() => ctx.session.status() === 'idle' && ctx.session.pendingSnapshot().length === 0, 10_000, '中断收尾');
      assert.equal(ctx.session.snapshotResponse().mode, 'plan', '中断不解除 arm');
      assert.ok(!chainOf(ctx.session).some((st) => st.action === 'plan'), '中断路径产物不注入链(rider:signal 边界)');
      assert.ok(ctx.frames.some((f) => f.kind === 'event' && f.e.type === 'notice' && String(f.e.text ?? '').includes('Planning interrupted')), '中断如实回执(notice 事件面)');
      // 手动切档解除(arm 三解除路径之三):idle 下 setMode 真切换,armed 拦截随之解除
      assert.equal(await ctx.session.setMode('acceptEdits'), 'ok');
      assert.equal(ctx.session.snapshotResponse().mode, 'acceptEdits');
      assert.deepEqual(ctx.session.submit('新任务'), { ok: true });
      await waitFor(() => ctx.session.status() === 'idle', 10_000);
      assert.equal(ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), false, '切档后提交零计划卡');
      assert.ok(chainOf(ctx.session).some((st) => st.observation.includes('新任务完成')), '切档后提交走普通任务');
    },
    { mode: 'plan' },
  );
});

test('serve plan-arm：挂卡期切档(disarm)=中止在途流程——卡被拒+aborted 收尾+后续提交走普通任务(终审修复)', async () => {
  const model = new ScriptedAdapter([
    '{"done":true,"reply":"# 计划\\n1. 步骤A"}', // 规划包
    '{"tool":"write","input":{"path":"after-disarm.txt","content":"ok"},"done":false}', // 普通任务:acceptEdits 域内写直放
    '{"done":true,"reply":"普通任务完成"}',
  ]);
  await withSession(
    model,
    async (ctx) => {
      assert.deepEqual(ctx.session.submit('做一件事'), { ok: true });
      await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000);
      planCard(ctx.session, ctx.frames);
      assert.equal(ctx.session.status(), 'idle', '前提:卡挂起期锁已放行(idle)——旧形态在此 setMode 即孤儿化在途流程');
      // 挂卡期切档(disarm)：先中止在途流程(挂卡拒绝回填+信号中止+有界等收束)再实切——
      // 旧形态只查 idle 即实切,旧卡续段与新提交并发跑、revising 的 read-only 覆盖拒用户写
      assert.equal(await ctx.session.setMode('acceptEdits'), 'ok', 'disarm 受理(idle 面)');
      await waitFor(
        () => ctx.frames.some((f) => f.kind === 'event' && f.e.type === 'notice' && String(f.e.text ?? '').includes('Planning interrupted')),
        10_000,
        '流程 aborted 如实回执',
      );
      await waitFor(() => ctx.session.pendingSnapshot().length === 0, 10_000, '挂卡被拒清表');
      assert.equal(ctx.session.snapshotResponse().mode, 'acceptEdits', 'disarm 实切');
      assert.ok(!chainOf(ctx.session).some((st) => st.action === 'plan'), '中止路径产物不注入链(不执行)');
      // disarm 后提交走普通任务:不再 409、不进 planFlow 零新卡;acceptEdits 域内写直放——
      // 若流程孤儿化续跑(read-only 覆盖在座/并发竞写),此写即被拒或文件不落盘
      assert.deepEqual(ctx.session.submit('普通任务'), { ok: true }, 'disarm 后普通提交直受理');
      await waitFor(() => ctx.session.status() === 'idle', 10_000, '普通任务收尾');
      assert.equal(ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), false, '零新计划卡(无并发无泄漏)');
      assert.ok(fs.existsSync(path.join(ctx.tmp, 'after-disarm.txt')), 'acceptEdits 域内写落盘(read-only 覆盖零泄漏)');
      assert.ok(chainOf(ctx.session).some((st) => st.observation.includes('普通任务完成')), '普通任务执行入链');
    },
    { mode: 'plan' },
  );
});

test('serve plan-arm：执行段中断检查在循环顶——被跳过步骤的指令行不入链(竞窗:步骤完成后信号落地,终审修复)', async () => {
  const model = new ScriptedAdapter([
    '{"done":true,"reply":"# 计划\\n1. 步骤A\\n2. 步骤B"}', // 规划包:两步
    '{"done":true,"reply":"步骤A 完成"}', // 执行包 A
    '{"done":true,"reply":"步骤B 完成"}', // 执行包 B(竞窗中止后不应到达)
  ]);
  // 竞窗注入:包装 createKernelRuntime(批准续段 setMode 换新运行时,实例级补丁会被甩掉——包装工厂两层
  // 全拦截)。runTask 返回后(reactor 末次信号检查已过、stopReason 仍 done)信号才落地:第 1 次调用=
  // 规划轮,第 2 次=执行段步骤 A——此刻 interrupt,复现「上一步完成后中断」的真实窗口
  const origCreate = runtimeMod.createKernelRuntime;
  let calls = 0;
  let sessionRef: SessionRuntime | undefined;
  (runtimeMod as unknown as { createKernelRuntime: typeof origCreate }).createKernelRuntime = (...args: Parameters<typeof origCreate>) => {
    const rt = origCreate(...args);
    const origRun = rt.runTask.bind(rt);
    (rt as unknown as { runTask: unknown }).runTask = (goal: string, opts?: Parameters<KernelRuntime['runTask']>[1]): Promise<RunOutcome> =>
      (origRun(goal, opts) as Promise<RunOutcome>).then((r) => {
        calls += 1;
        if (calls === 2 && sessionRef !== undefined) {
          assert.deepEqual(sessionRef.interrupt(), { ok: true }, '竞窗中止受理(执行段在途)');
        }
        return r;
      });
    return rt;
  };
  try {
    await withSession(
      model,
      async (ctx) => {
        sessionRef = ctx.session;
        assert.deepEqual(ctx.session.submit('做一件事'), { ok: true });
        await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000);
        const card = planCard(ctx.session, ctx.frames);
        assert.equal(ctx.session.resolvePendingPlanApproval(card.pid, { approved: true }), true, '批准回执命中');
        // 等待锚=批准续段的可观测里程碑:卡挂起期 status 恒 idle(锁已放行),idle 不可作收尾判据——
        // 先等 disarm 实切(mode 翻转=续段已过 setMode),再等执行段首步起跑(Step 1/2 notice)与
        // 竞窗中止落地(wrapper calls=2,即步骤 A 的 runTask 已返回),小窗让收尾微任务排空
        await waitFor(() => ctx.session.snapshotResponse().mode === 'acceptEdits', 10_000, '批准落档实切');
        await waitFor(() => ctx.frames.some((f) => f.kind === 'event' && f.e.type === 'notice' && String(f.e.text ?? '').includes('Step 1/2')), 10_000, '执行段首步起跑');
        await waitFor(() => calls >= 2, 10_000, '步骤 A run 返回(竞窗中止落地)');
        await new Promise((r) => setTimeout(r, 100)); // 收尾微任务排空窗
        const chain = chainOf(ctx.session);
        assert.ok(chain.some((st) => st.action === 'task' && st.observation.includes('步骤A')), '步骤 A 指令行入链(已执行)');
        assert.ok(!chain.some((st) => st.action === 'task' && st.observation.includes('步骤B')), '被跳过步骤 B 的指令行不入链(检查在循环顶)');
        assert.equal(
          ctx.frames.some((f) => f.kind === 'event' && f.e.type === 'notice' && String(f.e.text ?? '').includes('Step 2/2')),
          false,
          '被跳过步骤不再发 Step 2/2 起跑通知(旧形态通知先行于中断检查)',
        );
      },
      { mode: 'plan' },
    );
  } finally {
    (runtimeMod as unknown as { createKernelRuntime: typeof origCreate }).createKernelRuntime = origCreate;
  }
});
