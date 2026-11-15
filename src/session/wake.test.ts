import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { wakeOfRun, resolveWakeName, toWakeRefs, buildWakeNotification, WakeController, WAKE_GOAL, buildScheduleWakeNotification, scheduledWakeOfRun, SCHEDULE_WAKE_TAG, buildSessionRestoredNotification, sessionRestoredOfRun, SESSION_RESTORED_TAG, RESTORED_WAKE_GOAL } from './wake';
import type { WakeControllerOpts, WakeTaskInput } from './wake';
import { isQuietNotice } from './entry';
import type { KernelEntry } from './entry';

const run = (seq: number): KernelEntry => ({ seq, ts: 1, kind: 'run', md: '' });

describe('wakeOfRun', () => {
  const notice = (seq: number, wake?: KernelEntry['wake']): KernelEntry => ({ seq, ts: 1, kind: 'notice', md: 'x', ...(wake !== undefined ? { wake } : {}) });
  test('run 的直接前驱是唤醒 notice → 返回其 wake', () => {
    const refs = [{ id: 'a' }];
    assert.equal(wakeOfRun([notice(1, refs), run(2)], 1), refs);
  });
  test('前驱是普通 notice / 中间隔条目 / run 在首位 → undefined', () => {
    assert.equal(wakeOfRun([notice(1), run(2)], 1), undefined);
    assert.equal(wakeOfRun([notice(1, [{ id: 'a' }]), run(2), run(3)], 2), undefined);
    assert.equal(wakeOfRun([run(1)], 0), undefined);
  });
});

describe('resolveWakeName', () => {
  const t = { kind: 'exec' as const, label: 'pnpm build', title: undefined as string | undefined };
  test('exec：有 purpose 用 purpose，无 purpose 无名（label 是命令原文永不上屏）', () => {
    assert.equal(resolveWakeName({ ...t, title: '构建前端' }, false), '构建前端');
    assert.equal(resolveWakeName(t, false), undefined);
  });
  test('subagent：title ?? label；label 为回退段 subagent 视为无名', () => {
    assert.equal(resolveWakeName({ kind: 'subagent', label: 'doc-writer', title: undefined }, false), 'doc-writer');
    assert.equal(resolveWakeName({ kind: 'subagent', label: 'subagent', title: undefined }, false), undefined);
  });
  test('板任务：板名优先，无板名无名（label 是板 id 不是人读名）', () => {
    assert.equal(resolveWakeName({ kind: 'subagent', label: 'task-t3', title: undefined }, true, '修复登录'), '修复登录');
    assert.equal(resolveWakeName({ kind: 'subagent', label: 'task-t3', title: undefined }, true), undefined);
  });
});

describe('toWakeRefs', () => {
  test('多任务全量转 refs；板任务板名解析键=台账 label(dispatchTag 形态)而非账本 id——遗留 task-tN 形态', () => {
    const keys: string[] = [];
    const refs = toWakeRefs(
      [
        { id: 'x1', kind: 'exec', label: 'pnpm build', title: '构建前端' },
        // 板台账行账本 id=slug-时间戳-随机尾形态，宿主锚定正则只认 dispatchTag 形态——解析键必须走 label
        { id: 'task-t3-20261114T091530Z-ab12', kind: 'subagent', label: 'task-t3', boardDispatch: true },
      ],
      (key) => {
        keys.push(key);
        return key === 'task-t3' ? '修复登录' : undefined;
      },
    );
    assert.deepEqual(keys, ['task-t3']); // 接缝钉死：boardTitleOf 收 label(dispatchTag)，不是账本完整 id
    assert.deepEqual(refs, [
      { id: 'x1', name: '构建前端' },
      { id: 'task-t3-20261114T091530Z-ab12', board: true, boardRef: 'task-t3', name: '修复登录' },
    ]);
  });

  test('板任务：新方言板 id 原样透传（label=完整板 id，直接命中宿主 board.tasks 键）', () => {
    const refs = toWakeRefs(
      [{ id: 'task-loginfix-9k2f', kind: 'subagent', label: 'task-loginfix-9k2f', boardDispatch: true }],
      (key) => (key === 'task-loginfix-9k2f' ? '修复登录' : undefined),
    );
    assert.deepEqual(refs, [
      { id: 'task-loginfix-9k2f', board: true, boardRef: 'task-loginfix-9k2f', name: '修复登录' },
    ]);
  });

  test('exec 与板任务同 id 串共存：exec 名走 title、板名走 label(dispatchTag)，两本账互不串扰', () => {
    const same = 'task-t3-20261114T091530Z-ab12';
    const refs = toWakeRefs(
      [
        { id: same, kind: 'exec', label: 'pnpm build', title: '构建前端' },
        { id: same, kind: 'subagent', label: 'task-t3', boardDispatch: true },
      ],
      (key) => (key === 'task-t3' ? '修复登录' : undefined),
    );
    assert.deepEqual(refs, [
      { id: same, name: '构建前端' },
      { id: same, board: true, boardRef: 'task-t3', name: '修复登录' },
    ]);
  });
});

describe('buildWakeNotification', () => {
  test('通知文 = 标签定性 + 逐任务回执 + 收尾指令，包裹 task-notification', () => {
    const md = buildWakeNotification([{ id: 'a' }, { id: 'b' }], (id) => `receipt(${id})`);
    assert.match(md, /^<task-notification>\nAutomated notice, not a user message/);
    assert.match(md, /receipt\(a\)\nreceipt\(b\)/);
    assert.match(md, /Continue any work that was waiting on this result; if nothing remains, reply briefly\.\n<\/task-notification>$/);
    assert.ok(WAKE_GOAL.length > 0);
  });
});

describe('buildScheduleWakeNotification', () => {
  test('通知文 = 标签定性 + note 正文 + 收尾指令（P2 Task 3 裁定模板逐字）', () => {
    const md = buildScheduleWakeNotification('check the oven');
    assert.ok(md.startsWith(SCHEDULE_WAKE_TAG));
    assert.match(md, /^<schedule-wake>\nScheduled wake \(not a user message\): check the oven\n/);
    assert.match(md, /Continue toward your outstanding goals; if nothing remains, reply briefly\.$/);
    assert.equal(md.includes('fired late'), false, '准点（无 lateMs）不注明延迟');
  });

  test('错过注明延迟：lateMs 超过宽限即尾插迟到行；宽限内（准点抖动）不注', () => {
    const late = buildScheduleWakeNotification('n', 5_000);
    assert.match(late, /This wake fired late by 5s; handle accordingly\./);
    const jitter = buildScheduleWakeNotification('n', 40);
    assert.equal(jitter.includes('fired late'), false, '40ms 在宽限内=准点');
  });

  test('isQuietNotice 含 <schedule-wake> 前缀（安静清单扩展——机制通知对用户零信息量不显示）', () => {
    assert.equal(isQuietNotice(buildScheduleWakeNotification('x')), true);
    assert.equal(isQuietNotice('ask p1 answered'), true, '既有安静清单不受扰');
    assert.equal(isQuietNotice('user visible notice'), false);
  });
});

// ═══ 恢复唤醒轮（2026-11-15 sunx P2 Task 5,R9）：通知文模板/配对/安静清单——e2e 在 serve/session.wake ═══

describe('buildSessionRestoredNotification / sessionRestoredOfRun（R9）', () => {
  const notice = (seq: number, over: Partial<KernelEntry> = {}): KernelEntry => ({ seq, ts: 1, kind: 'notice', md: 'x', ...over });

  test('通知文模板逐字：定性说明+打断清单（title/id+终态）+素材列（title+askedBy 归因）+重估指令', () => {
    const md = buildSessionRestoredNotification(
      [
        { name: 'Write the docs', id: 'task-t1', status: 'cancelled' },
        { name: 'old fork', id: 'exec-1', status: 'stopped' },
      ],
      [{ title: 'Which port?', askedBy: { label: 'asker', taskId: 'exec-1' } }, { title: '主链直问', askedBy: { label: 'user' } }],
    );
    assert.match(md, /^<session-restored>\nSession restored after a daemon restart \(not a user message\)\.\n/);
    assert.ok(md.startsWith(SESSION_RESTORED_TAG), '构建端标签常量同源（与 isQuietNotice 过滤端单一引用）');
    assert.match(md, /Dispatched tasks interrupted by the restart:\n- Write the docs \(task-t1\): cancelled\n- old fork \(exec-1\): stopped\n/);
    assert.match(md, /Unanswered questions left pending:\n- Which port\? \(asked by asker, task exec-1\)\n- 主链直问 \(asked by user\)\n/);
    assert.match(md, /Re-read the board and ledger, decide what to re-dispatch, and report to the user what was lost\.$/);
    assert.equal(isQuietNotice(md), true, '安静清单：<session-restored> 前缀同源标签');
  });

  test('空节省略（触发条件保证至少一节在场）；askedBy.taskId 缺席不注 task 段', () => {
    const onlyMaterials = buildSessionRestoredNotification([], [{ title: 'Q?' }]);
    assert.equal(onlyMaterials.includes('Dispatched tasks interrupted'), false, '打断清单空=整节省略');
    assert.match(onlyMaterials, /Unanswered questions left pending:\n- Q\?\nRe-read the board and ledger/, 'askedBy 缺席=裸 title（收尾指令紧随）');
    const onlyInterrupted = buildSessionRestoredNotification([{ name: 'n', id: 'i', status: 'cancelled' }], []);
    assert.equal(onlyInterrupted.includes('Unanswered questions'), false, '素材空=整节省略');
    assert.equal(isQuietNotice(buildSessionRestoredNotification([], [])), true, '空列不破安静清单');
  });

  test('run 的直接前驱是携 restored 标记的 notice → true；schedule/wake/普通 notice 不串（三词汇零交集）', () => {
    assert.equal(sessionRestoredOfRun([notice(1, { restored: true }), run(2)], 1), true);
    assert.equal(sessionRestoredOfRun([notice(1, { schedule: true }), run(2)], 1), false, '定时唤醒不串');
    assert.equal(sessionRestoredOfRun([notice(1, { wake: [{ id: 'a' }] }), run(2)], 1), false, '任务唤醒不串');
    assert.equal(sessionRestoredOfRun([notice(1), run(2)], 1), false, '普通 notice 不配对');
    assert.equal(sessionRestoredOfRun([notice(1, { restored: true }), run(2), run(3)], 2), false, '中间隔条作废');
    assert.equal(RESTORED_WAKE_GOAL, 'Re-read the board and ledger, decide what to re-dispatch, and report to the user what was lost.', 'goal 与通知文收尾指令同义（观测标签）');
  });
});

// 显示前缀「定时唤醒」钉测随 scheduledWakePrefix 删除迁显示层（GUI chat-reducer/RunEntryView 两态钉——
// fix round 2：纯件零 i18n 导入钉 46fa519d，文案归 UI 层）
describe('scheduledWakeOfRun', () => {
  const notice = (seq: number, over: Partial<KernelEntry> = {}): KernelEntry => ({ seq, ts: 1, kind: 'notice', md: 'x', ...over });
  const run = (seq: number): KernelEntry => ({ seq, ts: 1, kind: 'run', md: '' });

  test('run 的直接前驱是携 schedule 标记的 notice → true；普通 notice / wake notice / 隔条 → false', () => {
    assert.equal(scheduledWakeOfRun([notice(1, { schedule: true }), run(2)], 1), true);
    assert.equal(scheduledWakeOfRun([notice(1), run(2)], 1), false, '普通 notice 不配对');
    assert.equal(scheduledWakeOfRun([notice(1, { wake: [{ id: 'a' }] }), run(2)], 1), false, '任务唤醒 notice 不串（两词汇零交集）');
    assert.equal(scheduledWakeOfRun([notice(1, { schedule: true }), run(2), run(3)], 2), false, '中间隔条作废');
    assert.equal(scheduledWakeOfRun([run(1)], 0), false);
  });
});

describe('WakeController.consumeChain（定时唤醒计入连续上限，P2 Task 3）', () => {
  const task = (over: Partial<WakeTaskInput> = {}): WakeTaskInput => ({
    id: 't1', kind: 'exec', label: 'l', status: 'done', ownerRun: 'main', ...over,
  });

  test('计一并返 true；与任务唤醒同账本；触顶 false+onLimit；markUserActivity/reset 归零', async () => {
    let limits = 0;
    let fired = 0;
    const c = new WakeController({
      busy: () => false,
      receipted: () => false,
      fire: () => {
        fired += 1;
        return true;
      },
      batchMs: 5,
      maxChain: 2,
      onLimit: () => {
        limits += 1;
      },
    });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    assert.equal(c.consumeChain(), true, 'chain=1');
    c.onTaskFinished(task({ id: 'a' }));
    await sleep(20);
    assert.equal(c.onTurnEnded('done'), true, '任务唤醒照常（chain=2）');
    assert.equal(c.consumeChain(), false, '触顶：定时唤醒被上限拦下');
    assert.equal(limits, 1);
    c.markUserActivity();
    assert.equal(c.consumeChain(), true, '用户消息归零后放行');
    c.reset();
    assert.equal(c.consumeChain(), true, 'reset 归零后放行');
  });
});

describe('WakeController', () => {
  const task = (over: Partial<WakeTaskInput> = {}): WakeTaskInput => ({
    id: 't1', kind: 'exec', label: 'l', status: 'done', ownerRun: 'main', ...over,
  });
  const mk = (over: Partial<WakeControllerOpts> = {}) => {
    const fired: WakeTaskInput[][] = [];
    const c = new WakeController({ busy: () => false, receipted: () => false, fire: (ts) => { fired.push(ts); return true; }, batchMs: 10, ...over });
    return { c, fired };
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('登记条件：stopped 不登记、fork 归属不登记、重复 id 去重；板任务纳入', async () => {
    const { c, fired } = mk();
    c.onTaskFinished(task({ status: 'stopped' }));
    c.onTaskFinished(task({ ownerRun: 'fork:x' }));
    c.onTaskFinished(task({ boardDispatch: true, ownerRun: 'fork:y' })); // 板任务纳入（三次裁定）
    c.onTaskFinished(task());
    c.onTaskFinished(task());
    await sleep(30);
    assert.equal(fired.length, 1);
    assert.equal(fired[0]?.length, 2); // exec + board 各一
  });

  test('busy 时入 pending；轮收束取走起轮；interrupted 保留', () => {
    let busy = true;
    const { c, fired } = mk({ busy: () => busy });
    c.onTaskFinished(task());
    assert.equal(fired.length, 0);
    busy = false;
    assert.equal(c.onTurnEnded('done'), true);
    assert.equal(fired.length, 1);
    c.onTaskFinished(task({ id: 't2' }));
    assert.equal(c.onTurnEnded('interrupted'), false); // §10-1 默认保留
    assert.equal(fired.length, 1);
    assert.equal(c.onTurnEnded('done'), true);
    assert.equal(fired.length, 2);
  });

  test('receipted 剔除：全部已消费则不起轮', async () => {
    const seen = new Set(['t1']);
    const { c, fired } = mk({ receipted: (id) => seen.has(id) });
    c.onTaskFinished(task({ id: 't1' }));
    await sleep(30);
    assert.equal(fired.length, 0);
  });

  test('fire 未受理（false）回队，下次轮收束重试', async () => {
    let accept = false;
    const c = new WakeController({ busy: () => false, receipted: () => false, fire: () => accept, batchMs: 5 });
    c.onTaskFinished(task({ id: 'a' }));
    await sleep(20);
    assert.equal(c.onTurnEnded('done'), false); // 未受理，回队
    accept = true;
    assert.equal(c.onTurnEnded('done'), true); // 回队后受理
  });

  test('连续唤醒计满 onLimit 后丢弃；markUserActivity 重置计数', async () => {
    let limits = 0;
    const c = new WakeController({ busy: () => false, receipted: () => false, fire: () => true, batchMs: 5, maxChain: 1, onLimit: () => { limits += 1; } });
    c.onTaskFinished(task({ id: 'a' }));
    await sleep(20);
    assert.equal(c.onTurnEnded('done'), true); // chain=1
    c.onTaskFinished(task({ id: 'b' }));
    await sleep(20);
    assert.equal(c.onTurnEnded('done'), false); // 触顶丢弃
    assert.equal(limits, 1);
    c.markUserActivity(); // 用户消息插入 → 计数归零
    c.onTaskFinished(task({ id: 'c' }));
    await sleep(20);
    assert.equal(c.onTurnEnded('done'), true);
    assert.equal(limits, 1);
  });

  test('reset(ignoreIds) 会话换新屏蔽集：被屏 id 不起轮，其余正常；无参 reset 清空屏蔽集', async () => {
    const { c, fired } = mk();
    c.reset(['a']); // 会话换新：旧会话在跑任务 id 进屏蔽集（timer/pending/chain/waking 一并清）
    c.onTaskFinished(task({ id: 'a' })); // 旧会话任务日后终态 → 屏蔽，不登记不起轮
    await sleep(30);
    assert.equal(fired.length, 0);
    c.onTaskFinished(task({ id: 'b' })); // 新会话任务正常登记起轮
    await sleep(30);
    assert.equal(fired.length, 1);
    assert.deepEqual(fired[0]?.map((t) => t.id), ['b']);
    c.reset(); // 无参=清空屏蔽集（daemon disposeRuntime 既有调用零变化）
    c.onTaskFinished(task({ id: 'a' }));
    await sleep(30);
    assert.equal(fired.length, 2); // 'a' 重新可登记
    assert.deepEqual(fired[1]?.map((t) => t.id), ['a']);
  });
});
