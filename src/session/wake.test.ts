import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { wakeOfRun, resolveWakeName, toWakeRefs, buildWakeNotification, WakeController, WAKE_GOAL } from './wake';
import type { WakeControllerOpts, WakeTaskInput } from './wake';
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
