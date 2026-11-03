import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionRuntime } from './session';
import { runCommand } from './session-commands';
import { SessionJournal } from '../tui/session-journal';
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
      // 2026-11-03 修订:空反馈拒绝=放弃本轮（discarded）——流程收尾不烧修订轮（不产新卡）,武装保持。
      // （旧锚=无理由盲改一轮出新卡,正是本轮废除的浪费语义;带反馈的修订环由上文 i<2 轮钉住）
      assert.equal(ctx.session.resolvePendingPlanApproval(card2.pid, { approved: false }), true, '空反馈拒绝回执命中');
      await waitFor(
        () => ctx.frames.some((f) => f.kind === 'event' && f.e.type === 'notice' && String(f.e.text ?? '').includes('Plan discarded')),
        10_000,
        '放弃如实回执',
      );
      await waitFor(() => ctx.session.pendingSnapshot().length === 0, 10_000, '挂卡出清');
      assert.equal(ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), false, '放弃不产修订轮新卡');
      assert.equal(ctx.session.snapshotResponse().mode, 'plan', '放弃仍保持 armed（下条提交重新规划）');
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

// ---- 2026-11-03 修订（/plan 三态）——武装快路径 / replan / steer 分流 / 批准卡选档 / 命令通道 ----

test('serve /plan 三态：运行中武装不 busy——setMode(plan) 恒 ok,收口后提交转规划', async () => {
  const model = new ScriptedAdapter([
    '{"done":true,"reply":"普通任务完成"}', // 普通任务
    '{"done":true,"reply":"# 计划\\n1. 步骤X"}', // 规划包
  ]);
  await withSession(model, async (ctx) => {
    assert.equal(ctx.session.snapshotResponse().mode, 'full-access', '前提:缺省档非 plan');
    assert.deepEqual(ctx.session.submit('普通任务'), { ok: true });
    await waitFor(() => ctx.session.status() === 'running', 10_000);
    // 2026-11-03 武装快路径:运行中武装=置标记+落 meta,零重建零 busy（旧形态此处 'busy'→HTTP 409）
    assert.equal(await ctx.session.setMode('plan'), 'ok', '运行中武装不 busy');
    assert.equal(ctx.session.isPlanArmed(), true, '武装即刻成立(对下一次提交生效)');
    await waitFor(() => ctx.session.status() === 'idle', 10_000, '普通任务收口');
    assert.equal(ctx.session.isPlanArmed(), true, '收口后武装保持');
    assert.deepEqual(ctx.session.submit('规划这件事'), { ok: true });
    await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000, 'armed 提交入规划流程');
  });
});

test('serve /plan 三态：挂卡期 replan——旧卡撤+新目标新卡（不再 409,单槽不叠卡,中断文案抑制）', async () => {
  const model = new ScriptedAdapter([
    '{"done":true,"reply":"# 计划一\\n1. 步骤A"}',
    '{"done":true,"reply":"# 计划二\\n1. 步骤B"}',
  ]);
  await withSession(
    model,
    async (ctx) => {
      assert.deepEqual(ctx.session.submit('旧目标'), { ok: true });
      await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000);
      const card = planCard(ctx.session, ctx.frames);
      await ctx.session.replan('新目标');
      await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval' && r.pid !== card.pid), 10_000, 'replan 新卡');
      assert.equal(ctx.session.pendingSnapshot().filter((r) => r.kind === 'plan-approval').length, 1, '单槽:旧卡已撤不叠卡');
      assert.equal(ctx.session.resolvePendingPlanApproval(card.pid, { approved: true }), false, '旧卡已删表(回执=404 面)');
      assert.ok(
        !ctx.frames.some((f) => f.kind === 'event' && f.e.type === 'notice' && String(f.e.text ?? '').includes('Planning interrupted')),
        'replan 静默位:替换路径不落「规划已中断」双文案',
      );
      const frame = ctx.frames.filter((f) => f.kind === 'plan-approval').at(-1) as { req: { doc: string } } | undefined;
      assert.match(frame?.req.doc ?? '', /# 计划二/, '新卡携带新目标计划书');
    },
    { mode: 'plan' },
  );
});

test('serve /plan 三态：普通任务在途 /plan <目标> 命令=武装+入 steer 队列——收口后经 arm 拦截转规划', async () => {
  const model = new ScriptedAdapter([
    '{"done":true,"reply":"普通任务完成"}', // 普通任务
    '{"done":true,"reply":"# 计划\\n1. 步骤Y"}', // 规划包
  ]);
  await withSession(model, async (ctx) => {
    assert.deepEqual(ctx.session.submit('普通任务'), { ok: true });
    await waitFor(() => ctx.session.status() === 'running', 10_000);
    // 命令通道三分支之「在途」臂:旧形态返回 'busy'→HTTP 409;现=武装+入队,不中断在途工作
    assert.equal(await runCommand(ctx.session, '/plan 规划目标'), 'ok', '/plan 命令在运行态不再 busy');
    assert.equal(ctx.session.isPlanArmed(), true, '运行中武装生效');
    await waitFor(() => ctx.session.status() === 'idle', 10_000, '普通任务收口');
    // 队列补跑经 submit→arm 拦截转 planFlow（steer 消费路径既有语义,此处端到端钉住）
    await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000, '队列目标转规划');
  });
});

test('serve /plan 三态：批准卡三选——mode=full-access 落完全访问档(arm 解除,内核基档真切换)', async () => {
  const model = new ScriptedAdapter([
    '{"done":true,"reply":"# 计划\\n1. 步骤Z"}', // 规划包
    '{"done":true,"reply":"步骤Z 完成"}', // 执行包
  ]);
  await withSession(
    model,
    async (ctx) => {
      assert.deepEqual(ctx.session.submit('做一件事'), { ok: true });
      await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000);
      const card = planCard(ctx.session, ctx.frames);
      assert.equal(ctx.session.resolvePendingPlanApproval(card.pid, { approved: true, mode: 'full-access' }), true, '选完全访问批准');
      await waitFor(() => ctx.session.status() === 'idle' && ctx.session.snapshotResponse().mode === 'full-access', 10_000, 'full-access 落档+执行收尾');
      assert.equal(ctx.session.runtime.harness.security.mode, 'full-access', '内核 guard 基档真切换');
      const chain = chainOf(ctx.session);
      const planIdx = chain.findIndex((st) => st.action === 'plan');
      const stepIdx = chain.findIndex((st) => st.action === 'task' && st.observation.includes('Current instruction: 步骤Z'));
      assert.ok(planIdx >= 0 && stepIdx > planIdx, '链序红线不随选档变化(计划书行先于执行指令行)');
    },
    { mode: 'plan' },
  );
});

test('serve /plan 三态：命令通道裸 /plan=幂等武装+如实回执,/plan off=解除武装', async () => {
  const model = new ScriptedAdapter(['{"done":true,"reply":"普通任务完成"}']);
  await withSession(model, async (ctx) => {
    // 裸 /plan:首次=进入
    assert.equal(await runCommand(ctx.session, '/plan'), 'ok');
    assert.equal(ctx.session.isPlanArmed(), true, '裸 /plan 武装');
    assert.ok(
      ctx.frames.some((f) => f.kind === 'event' && f.e.type === 'tool-result' && String(f.e.text ?? '').includes('Plan mode on')),
      '武装回执(命令三态行 tool-result 载荷,非 notice 事件)',
    );
    // 重复发送:幂等不解除
    assert.equal(await runCommand(ctx.session, '/plan'), 'ok');
    assert.equal(ctx.session.isPlanArmed(), true, '重复 /plan 不解除(幂等)');
    // off:解除(闲置态,无流程在途)
    assert.equal(await runCommand(ctx.session, '/plan off'), 'ok');
    assert.equal(ctx.session.isPlanArmed(), false, '/plan off 解除武装');
    assert.equal(ctx.session.snapshotResponse().mode, 'acceptEdits', 'off 落工作区编辑档(disarm 缺省档)');
    // 解除后普通提交走普通任务
    assert.deepEqual(ctx.session.submit('普通任务'), { ok: true });
    await waitFor(() => ctx.session.status() === 'idle', 10_000);
    assert.equal(ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), false, '解除后提交零计划卡');
  });
});

// ---- 2026-11-03 交稿协议（exit_plan 终止型工具）——模型显式出牌交稿/落盘/合成链行/guard 拒绝/purge 无痕 ----

test('serve 交稿协议：exit_plan 终止规划 run——卡带计划名+plan.md 落盘,批准后合成链行 tool-call→tool-result→plan', async () => {
  const model = new ScriptedAdapter([
    { toolCalls: [{ name: 'exit_plan', args: { name: '重构认证模块', doc: '# 重构认证模块\n1. 步骤A' } }] }, // 交稿出牌（结构化步骤）
    '{"done":true,"reply":"步骤A 完成"}', // 执行包（终答=字符串 DSL 步）
  ]);
  await withSession(
    model,
    async (ctx) => {
      ctx.session.attachJournal(new SessionJournal(path.join(ctx.tmp, 'data'))); // 生产形态:daemon attach 后才受理提交（journalId 由此可得）
      assert.deepEqual(ctx.session.submit('做一件事'), { ok: true });
      await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000);
      const card = planCard(ctx.session, ctx.frames);
      const frame = ctx.frames.filter((f) => f.kind === 'plan-approval').at(-1) as { pid: string; req: { name?: string; path?: string; doc: string } } | undefined;
      assert.equal(frame?.req.name, '重构认证模块', '卡带计划名（exit_plan 出牌权威）');
      assert.ok(typeof frame?.req.path === 'string' && frame.req.path.endsWith('.plan.md'), '卡带计划文件绝对路径');
      assert.ok(fs.existsSync(frame.req.path!), '计划书已落盘');
      const planFileText = fs.readFileSync(frame.req.path!, 'utf8');
      assert.match(planFileText, /^# 重构认证模块/, '文件首行=计划名(H1 缺席时前置,用户裁定「计划文件要有计划名」)');
      assert.match(planFileText, /1\. 步骤A/, '计划书全文随行');
      assert.equal(ctx.session.status(), 'idle', '挂卡期锁已放行');
      assert.equal(ctx.session.resolvePendingPlanApproval(card.pid, { approved: true }), true);
      await waitFor(() => ctx.session.status() === 'idle' && ctx.session.snapshotResponse().mode === 'acceptEdits', 10_000, '批准落档+执行收尾');
      // 合成链行（回放权威）：tool-call(带 name/path)→tool-result(decision)→plan 行——链序红线不破
      const chain = chainOf(ctx.session);
      const callIdx = chain.findIndex((st) => st.action === 'tool-call' && st.observation.includes('exit_plan'));
      const resultIdx = chain.findIndex((st) => st.action === 'tool-result' && st.observation.includes('decision: implement via workspace edits'));
      const planIdx = chain.findIndex((st) => st.action === 'plan');
      assert.ok(callIdx >= 0 && resultIdx > callIdx && planIdx > resultIdx, '链序:交稿调用→裁决结果→计划书行');
      assert.match(chain[callIdx]!.observation, /重构认证模块/, '合成调用行携带计划名');
      assert.match(chain[callIdx]!.observation, /plan\.md/, '合成调用行携带计划文件路径');
      // 判别力锚:终止型交稿后规划 run 不再续轮（无二次模型调用——执行包只被批准续段消费）
      assert.equal(ctx.session.runtime.harness.security.mode, 'acceptEdits', '批准落工作区编辑档');
    },
    { mode: 'plan' },
  );
});

test('serve 交稿协议：exit_plan 漏 name=可空兜底——卡名从 goal 派生,交稿不硬失败(2026-11-03 实测根因)', async () => {
  const model = new ScriptedAdapter([
    { toolCalls: [{ name: 'exit_plan', args: { doc: '# 演示计划\n1. 步骤D' } }] }, // 漏 name 出牌(实测形态)
    '{"done":true,"reply":"步骤D 完成"}',
  ]);
  await withSession(
    model,
    async (ctx) => {
      ctx.session.attachJournal(new SessionJournal(path.join(ctx.tmp, 'data'))); // 生产形态:attach 后落盘可达
      assert.deepEqual(ctx.session.submit('给 demo.js 补一组验证用例并跑绿'), { ok: true });
      await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000);
      const frame = ctx.frames.filter((f) => f.kind === 'plan-approval').at(-1) as { pid: string; req: { name?: string; path?: string; doc: string } } | undefined;
      assert.equal(frame?.req.name, '给 demo.js 补一组验证用例并跑绿', '缺 name=卡名从 goal 派生(derivePlanName,交稿不硬失败)');
      assert.ok(fs.existsSync(frame?.req.path ?? ''), '计划书落盘(首行=派生名)');
    },
    { mode: 'plan' },
  );
});

test('serve 交稿协议：guard 非规划轮拒 exit_plan——普通任务调 exit_plan 被拒不终止,无计划卡', async () => {
  const model = new ScriptedAdapter([
    { toolCalls: [{ name: 'exit_plan', args: { name: '越权交稿', doc: '# 不该出现' } }] }, // 普通任务里出牌交稿
    '{"done":true,"reply":"普通任务完成"}', // 拒绝后模型自行收尾（终答=字符串 DSL 步）
  ]);
  await withSession(model, async (ctx) => {
    assert.equal(ctx.session.snapshotResponse().mode, 'full-access', '前提:非 plan-arm');
    assert.deepEqual(ctx.session.submit('普通任务'), { ok: true });
    await waitFor(() => ctx.session.status() === 'idle', 10_000, '普通任务收尾');
    assert.equal(ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), false, '拒绝不产计划卡(不终止 run)');
    const chain = chainOf(ctx.session);
    assert.ok(
      chain.some((st) => st.action === 'tool-result' && st.observation.includes('exit_plan is only available')),
      '拒绝观察行带出路提示(模型可自行调整)',
    );
    assert.ok(chain.some((st) => st.observation.includes('普通任务完成')), 'run 未被终止,模型收尾完成');
  });
});
