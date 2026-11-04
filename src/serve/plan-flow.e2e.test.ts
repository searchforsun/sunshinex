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
import { SessionJournal } from '../tui/session-journal';

/** serve 计划模式 e2e（2026-11-03 无感化,ask_question 同构）：armed 提交=会话作用域 run（read-only
 *  覆盖在座）,exit_plan executor 弹卡阻塞等裁决（run 不收口——无感锚:挂卡期 status running）,
 *  裁决回执 → executor 恢复同 run 无感继续（批准=落档放权原地实施;重新计划带反馈=原地修订再出牌;
 *  空反馈=中断 run 放弃本轮）。2026-11-04 泛化:exit_plan 任何档可调（通用提案工具）——卡按钮集按
 *  当前档自适应（只读域三键选落档/可写域两键维持当前档）。轻量切档/运行中武装见 session-switch.test。 */

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

function planCard(s: SessionRuntime, frames: DaemonFrame[]): { pid: string; name?: string; path?: string; doc: string; items: string[] } {
  const row = s.pendingSnapshot().find((r) => r.kind === 'plan-approval');
  assert.ok(row, '挂起表应有 plan-approval 行');
  const frame = frames.filter((f) => f.kind === 'plan-approval').at(-1) as { pid: string; req: { name?: string; path?: string; doc: string; items: string[] } } | undefined;
  assert.ok(frame, '应有 plan-approval 广播帧');
  assert.equal(frame.pid, row.pid, '帧与表同 pid（daemon 级铸造票据）');
  return { pid: frame.pid, name: frame.req.name, path: frame.req.path, doc: frame.req.doc, items: frame.req.items };
}

function chainOf(s: SessionRuntime): Array<{ action?: string; observation: string }> {
  return s.runtime.harness.context.chainView() as unknown as Array<{ action?: string; observation: string }>;
}

test('serve 无感主链路：armed 提交→exit_plan 挂起(status 保持 running)→批准→同 run 无感实施→done', async () => {
  const model = new ScriptedAdapter([
    { toolCalls: [{ name: 'exit_plan', args: { name: '重构认证模块', doc: '# 重构认证模块\n1. 步骤A' } }] }, // 交稿挂起
    '{"tool":"write","input":{"path":"impl-a.txt","content":"A"},"done":false}', // 批准后同 run 无感实施
    '{"done":true,"reply":"实施完成"}',
  ]);
  await withSession(
    model,
    async (ctx) => {
      ctx.session.attachJournal(new SessionJournal(path.join(ctx.tmp, 'data'))); // 生产形态:attach 后落盘可达
      assert.deepEqual(ctx.session.submit('做一件事'), { ok: true });
      await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000);
      const card = planCard(ctx.session, ctx.frames);
      assert.equal(card.name, '重构认证模块', '卡带计划名');
      assert.ok(typeof card.path === 'string' && card.path.endsWith('.plan.md'), '卡带计划文件路径');
      assert.ok(fs.existsSync(card.path!), '计划书已落盘');
      assert.match(fs.readFileSync(card.path!, 'utf8'), /^# 重构认证模块/, '文件首行=计划名(无 H1 前置)');
      // 无感锚:挂卡阻塞期 run 不收口——status 保持 running(ask_question「等待回答」同观感)
      assert.equal(ctx.session.status(), 'running', '挂卡阻塞期界面保持运行中(无感)');
      assert.equal(ctx.session.resolvePendingPlanApproval(card.pid, { approved: true, mode: 'acceptEdits' }), true, '批准回执命中');
      // 同 run 无感继续:r2 写工具按已放权档位执行(write 落盘即证 guard 放权)
      await waitFor(() => ctx.session.status() === 'idle', 10_000, '同 run 实施+done 收束');
      assert.ok(fs.existsSync(path.join(ctx.tmp, 'impl-a.txt')), '批准后同 run 实施(write 落盘,guard 放权)');
      assert.equal(ctx.session.snapshotResponse().mode, 'acceptEdits', '批准落工作区编辑档');
      const chain = chainOf(ctx.session);
      const callIdx = chain.findIndex((st) => st.action === 'tool-call' && st.observation.includes('exit_plan'));
      assert.ok(callIdx >= 0, '交稿工具调用行在主链(会话作用域 run,回放天然可见)');
      assert.ok(chain.some((st) => st.action === 'tool-result' && st.observation.includes('plan approved')), '裁决结果回喂行在场');
      assert.ok(chain.some((st) => st.observation.includes('impl-a.txt')), '实施轨迹同链');
    },
    { mode: 'plan' },
  );
});

test('serve 无感：重新计划带反馈→executor 恢复原地修订→再次出牌新卡→批准实施', async () => {
  const model = new ScriptedAdapter([
    { toolCalls: [{ name: 'exit_plan', args: { name: '计划一', doc: '# 计划一\n1. 步骤A' } }] },
    { toolCalls: [{ name: 'exit_plan', args: { name: '计划二', doc: '# 计划二\n1. 步骤B' } }] }, // 修订后再次出牌
    '{"done":true,"reply":"实施完成"}',
  ]);
  await withSession(
    model,
    async (ctx) => {
      ctx.session.attachJournal(new SessionJournal(path.join(ctx.tmp, 'data')));
      assert.deepEqual(ctx.session.submit('做一件事'), { ok: true });
      await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000);
      const card1 = planCard(ctx.session, ctx.frames);
      assert.equal(ctx.session.resolvePendingPlanApproval(card1.pid, { approved: false, feedback: '改成步骤B' }), true, '带反馈重新计划回执命中');
      await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000, '修订后新卡');
      const card2 = planCard(ctx.session, ctx.frames);
      assert.ok(card2.pid !== card1.pid, '新卡新 pid');
      assert.equal(ctx.session.resolvePendingPlanApproval(card2.pid, { approved: true, mode: 'acceptEdits' }), true);
      await waitFor(() => ctx.session.status() === 'idle', 10_000, '批准后实施收束');
      const chain = chainOf(ctx.session);
      assert.equal(chain.filter((st) => st.action === 'tool-call' && st.observation.includes('exit_plan')).length, 2, '两次交稿调用行(修订环自然迭代)');
      assert.ok(chain.some((st) => st.observation.includes('re-plan requested')), '重新计划回喂行在场');
    },
    { mode: 'plan' },
  );
});

test('serve 无感：空反馈=放弃本轮——run 中断回输入态,arm 保持(2026-11-03 用户裁定)', async () => {
  const model = new ScriptedAdapter([
    { toolCalls: [{ name: 'exit_plan', args: { name: '计划X', doc: '# 计划X\n1. 步骤X' } }] },
    '{"done":true,"reply":"重新规划后实施"}',
  ]);
  await withSession(
    model,
    async (ctx) => {
      assert.deepEqual(ctx.session.submit('做一件事'), { ok: true });
      await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000);
      const card = planCard(ctx.session, ctx.frames);
      assert.equal(ctx.session.resolvePendingPlanApproval(card.pid, { approved: false }), true, '空反馈放弃回执命中');
      await waitFor(() => ctx.session.status() === 'idle', 10_000, '放弃本轮:run 中断回输入态');
      assert.equal(ctx.session.snapshotResponse().mode, 'plan', '放弃仍保持 armed(下条提交重新规划)');
      assert.equal(ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), false, '放弃不产修订轮新卡');
      assert.ok(!chainOf(ctx.session).some((st) => st.action === 'task' && st.observation.includes('步骤X')), '放弃不执行步骤(task 行)');
    },
    { mode: 'plan' },
  );
});
test('serve 泛化：非 armed 出牌=计划卡直出(可写域两键)——实施=维持当前档,同 run 无感实施', async () => {
  const model = new ScriptedAdapter([
    { toolCalls: [{ name: 'exit_plan', args: { name: '提案计划', doc: '# 提案计划\n1. 步骤W' } }] },
    '{"tool":"write","input":{"path":"direct-plan.txt","content":"ok"},"done":false}',
    '{"done":true,"reply":"实施完成"}',
  ]);
  await withSession(model, async (ctx) => {
    ctx.session.attachJournal(new SessionJournal(path.join(ctx.tmp, 'data')));
    assert.equal(ctx.session.snapshotResponse().mode, 'full-access', '前提:可写域(full-access),非 plan-arm');
    assert.deepEqual(ctx.session.submit('做一件事'), { ok: true });
    await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000, '计划卡直出(无切入预审批)');
    assert.equal(ctx.session.pendingSnapshot().some((r) => r.kind === 'approval'), false, '无切入审批卡(2026-11-04:卡本体即审批面)');
    assert.equal(ctx.session.status(), 'running', '挂卡期 run 不收口(ask 同观感)');
    const card = planCard(ctx.session, ctx.frames);
    assert.equal(ctx.session.resolvePendingPlanApproval(card.pid, { approved: true, mode: 'full-access' }), true, '实施(当前档)回执命中');
    await waitFor(() => ctx.session.status() === 'idle', 10_000, '批准后同 run 实施收束');
    assert.equal(ctx.session.snapshotResponse().mode, 'full-access', '可写域批准=维持当前档(无落档切换)');
    assert.ok(fs.existsSync(path.join(ctx.tmp, 'direct-plan.txt')), '同 run 无感实施(write 落盘)');
    const chain = chainOf(ctx.session);
    assert.ok(chain.some((st) => st.action === 'tool-result' && st.observation.includes('plan approved')), '批准回喂行在场');
  });
});

test('serve 交稿协议：exit_plan 漏 name=可空兜底——卡名从 goal 派生,交稿不硬失败(2026-11-03 实测根因)', async () => {
  const model = new ScriptedAdapter([
    { toolCalls: [{ name: 'exit_plan', args: { doc: '# 演示计划\n1. 步骤D' } }] },
    '{"done":true,"reply":"步骤D 完成"}',
  ]);
  await withSession(
    model,
    async (ctx) => {
      ctx.session.attachJournal(new SessionJournal(path.join(ctx.tmp, 'data')));
      assert.deepEqual(ctx.session.submit('给 demo.js 补一组验证用例并跑绿'), { ok: true });
      await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000);
      const frame = ctx.frames.filter((f) => f.kind === 'plan-approval').at(-1) as { pid: string; req: { name?: string; path?: string; doc: string } } | undefined;
      assert.equal(frame?.req.name, '给 demo.js 补一组验证用例并跑绿', '缺 name=卡名从 goal 派生(derivePlanName,交稿不硬失败)');
      assert.ok(fs.existsSync(frame?.req.path ?? ''), '计划书落盘(首行=派生名)');
    },
    { mode: 'plan' },
  );
});

test('serve 无感：挂卡期切档=弃卡+落新档;armed 再入→新目标→重新规划', async () => {
  const model = new ScriptedAdapter([
    { toolCalls: [{ name: 'exit_plan', args: { name: '重规划计划', doc: '# 重规划计划\n1. 步骤R' } }] }, // 交稿挂卡
    '{"tool":"write","input":{"path":"after-disarm.txt","content":"ok"},"done":false}', // disarm 后普通任务
    '{"done":true,"reply":"普通任务完成"}',
    { toolCalls: [{ name: 'exit_plan', args: { name: '再入计划', doc: '# 再入计划\n1. 步骤S' } }] }, // armed 再入重新规划
  ]);
  await withSession(
    model,
    async (ctx) => {
      assert.deepEqual(ctx.session.submit('做一件事'), { ok: true });
      await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000);
      planCard(ctx.session, ctx.frames);
      assert.equal(await ctx.session.setMode('acceptEdits'), 'ok', '挂卡期切真档受理(轻量直切)');
      await waitFor(() => ctx.session.pendingSnapshot().length === 0, 10_000, '挂卡被拒清表');
      await waitFor(() => ctx.session.status() === 'idle', 10_000, 'disarm 中止收尾(run 在途清零)');
      assert.equal(ctx.session.snapshotResponse().mode, 'acceptEdits', 'disarm 实切');
      assert.deepEqual(ctx.session.submit('普通任务'), { ok: true }, 'disarm 后普通提交直受理');
      await waitFor(() => ctx.session.status() === 'idle', 10_000, '普通任务收尾');
      assert.ok(fs.existsSync(path.join(ctx.tmp, 'after-disarm.txt')), 'acceptEdits 域内写落盘');
      assert.equal(await ctx.session.setMode('plan'), 'ok', 'armed 再入');
      assert.deepEqual(ctx.session.submit('再规划一件事'), { ok: true });
      await waitFor(() => ctx.session.pendingSnapshot().some((r) => r.kind === 'plan-approval'), 10_000, 'armed 提交入规划');
    },
    { mode: 'plan' },
  );
});
