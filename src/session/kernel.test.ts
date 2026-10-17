import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionKernel } from './kernel';
import { applyEvent, initialKernelState } from './entry';
import type { KernelEntry } from './entry';
import type { SessionEvent } from '../types';

/**
 * SessionKernel 合并用例表(spec §7:三份投影的既有用例合并参数化——差异显式成行)。
 * 来源标注:①-⑧ = serve/transcript.test 平移;「gui·」= chat-reducer.test 语义;其余为并集新钉面。
 */

function ev(type: SessionEvent['type'], text?: string, payload?: Record<string, unknown>, ts = 4242): SessionEvent {
  return { type, ts, ...(text !== undefined ? { text } : {}), ...(payload !== undefined ? { payload } : {}) };
}

function pump(k: SessionKernel, ...events: SessionEvent[]): void {
  for (const e of events) k.pump(e);
}

/** reducer 纯件直驱(kernel 薄壳的等价断言捷径) */
function reduce(state: ReturnType<typeof initialKernelState>, ...events: SessionEvent[]): ReturnType<typeof initialKernelState> {
  let s = state;
  for (const e of events) s = applyEvent(s, e);
  return s;
}

test('① user+流式段+done:段边界落 assistant(G14.213),末段与 done 同文不重复;usage/route 不产条目', () => {
  const k = new SessionKernel();
  pump(k, ev('user', '把测试跑绿'), ev('token', '先跑'), ev('usage', undefined, { turnTotal: 1 }), ev('route', undefined, { tier: 'base' }), ev('token', '后查通过'), ev('done', '后查通过', { stopReason: 'done' }));
  const es = k.replay();
  assert.equal(es.length, 3, '流式段与终答各自入档;usage/route 非归档面事件不产条目');
  assert.equal(es[0]!.kind, 'user');
  assert.equal(es[0]!.md, '> 把测试跑绿');
  assert.equal(es[1]!.kind, 'assistant');
  assert.equal(es[1]!.md, '先跑');
  assert.equal(es[2]!.kind, 'assistant');
  assert.equal(es[2]!.md, '后查通过');
  assert.ok(es[0]!.seq < es[1]!.seq && es[1]!.seq < es[2]!.seq, 'seq 全局单调');
});

test('①b done 终答与开启段同文 → 不重复入档', () => {
  const k = new SessionKernel();
  pump(k, ev('token', '只有一段'), ev('done', '只有一段', { stopReason: 'done' }));
  const es = k.replay();
  assert.equal(es.length, 1);
  assert.equal(es[0]!.kind, 'assistant');
  assert.equal(es[0]!.md, '只有一段');
});

test('①c gui·model-start 开 run 条,done 封段:seconds 计 ts 差、steps/runSteps/tokens 透传、endedTs 回填', () => {
  const k = new SessionKernel();
  pump(
    k,
    ev('user', '写个函数'),
    ev('model-start', undefined, undefined, 1000),
    ev('token', '你好', undefined, 2000),
    ev('done', '你好', { steps: 12, runSteps: 3, tokensUsed: 8400, stopReason: 'done' }, 35_000),
  );
  const es = k.replay();
  assert.deepEqual(
    es.map((e) => e.kind),
    ['user', 'run', 'assistant'],
    '轮次顺序=[用户输入]→[run 条]→[终答](G14.22 同序)',
  );
  const run = es[1]!;
  assert.equal(run.md, '');
  assert.deepEqual(run.meta, { seconds: 34, steps: 12, runSteps: 3, tokens: 8400, endedTs: 35_000 });
  assert.equal(es[2]!.md, '你好', '终稿与流式段同文合并单条');
});

test('①d done 载荷 stopReason 非 done → meta.stopped(中断/失败收口显「已停止」)', () => {
  const k = new SessionKernel();
  pump(k, ev('model-start', undefined, undefined, 1000), ev('done', '', { stopReason: 'interrupted' }, 9000));
  const run = k.replay().find((e) => e.kind === 'run');
  assert.equal(run?.meta?.stopped, true);
  assert.equal(run?.meta?.seconds, 8);
});

test('①e gui·mergeFinal 前缀重叠取长:流式 acc 是终稿前缀 → 终稿为准不拼接', () => {
  const s = reduce(initialKernelState(), ev('token', 'abc'), ev('done', 'abcdef', { stopReason: 'done' }));
  assert.equal(s.entries.length, 1);
  assert.equal(s.entries[0]!.md, 'abcdef');
});

test('② tool-call+tool-result 同 callId:单条配对(name/result/input 全量随档)', () => {
  const k = new SessionKernel();
  k.pump(ev('tool-call', 'create_task', { callId: 'c1', input: { title: 'A' }, status: 'pending' }));
  assert.equal(k.replay().length, 1, 'call 先到:占位条先入');
  assert.equal(k.replay()[0]!.md, '● create_task\n⎿ …');
  k.pump(ev('tool-result', 'task t1 created\nboard: t1 pending', { callId: 'c1', ok: true, tool: 'create_task', status: 'completed' }));
  const es = k.replay();
  assert.equal(es.length, 1, '同 callId 配对归并为单条(不新增条目)');
  assert.equal(es[0]!.kind, 'tool');
  assert.equal(es[0]!.md, '● create_task\n⎿ task t1 created', 'result 只取首行');
  assert.equal(es[0]!.name, 'create_task');
  assert.deepEqual(es[0]!.input, { title: 'A' });
  assert.deepEqual(es[0]!.result, { text: 'task t1 created\nboard: t1 pending', ok: true });
  assert.equal(es[0]!.ts, 4242);
});

test('③ 乱序:result 先到 call 后到 → 按 callId 归位同条(name 回填,seq/ts 保持 result 到达位)', () => {
  const k = new SessionKernel();
  k.pump(ev('tool-result', 'file content here', { callId: 'x', ok: true, tool: 'read', status: 'completed' }, 100));
  assert.equal(k.replay().length, 1);
  assert.equal(k.replay()[0]!.md, '● …\n⎿ file content here');
  const seqBefore = k.replay()[0]!.seq;
  k.pump(ev('tool-call', 'read', { callId: 'x', input: { path: 'a.ts' }, status: 'pending' }, 200));
  const es = k.replay();
  assert.equal(es.length, 1, '后到 call 归位同条(不新增)');
  assert.equal(es[0]!.md, '● read\n⎿ file content here');
  assert.equal(es[0]!.name, 'read');
  assert.deepEqual(es[0]!.input, { path: 'a.ts' });
  assert.equal(es[0]!.seq, seqBefore, 'seq 保持 result 先行时刻');
  assert.equal(es[0]!.ts, 100);
});

test('④ 无 callId:FIFO 兜底——result 配最老未配对条,后来者保持占位', () => {
  const k = new SessionKernel();
  pump(k, ev('tool-call', 'read', { status: 'pending' }), ev('tool-call', 'grep', { status: 'pending' }), ev('tool-result', 'first result', { ok: true, status: 'completed' }));
  const es = k.replay();
  assert.equal(es.length, 2, '无 callId 不并条,各自占位');
  assert.equal(es[0]!.md, '● read\n⎿ first result', '无 callId result 归最老未配对条(FIFO)');
  assert.equal(es[1]!.md, '● grep\n⎿ …', '后来条保持占位');
});

test('⑤ call 未配对:占位条定格(result 永不到场不蒸发)', () => {
  const k = new SessionKernel();
  pump(k, ev('tool-call', 'bash', { callId: 'z', input: { command: 'ls' }, status: 'pending' }), ev('done', '收尾', { stopReason: 'done' }));
  const es = k.replay();
  assert.equal(es.length, 2);
  assert.equal(es[0]!.kind, 'tool');
  assert.equal(es[0]!.md, '● bash\n⎿ …');
  assert.equal(es[1]!.md, '收尾');
  assert.ok(es[0]!.seq < es[1]!.seq);
});

test('⑥ kind 扩:error→error(缺 text 回落);notice→notice;delegation-started/ended 零条目(G14.213);agent-message→[from → to] text', () => {
  const k = new SessionKernel();
  pump(
    k,
    ev('error', 'boom'),
    ev('error'),
    ev('notice', '技能已安装'),
    ev('delegation-started', undefined, { delegationId: 'd1', kind: 'subagent', label: 'build' }),
    ev('delegation-ended', undefined, { delegationId: 'd1', kind: 'subagent', label: 'build', status: 'done' }),
    ev('delegation-ended', undefined, { delegationId: 'd2', kind: 'graph-node', label: 'deploy', status: 'failed' }),
    ev('agent-message', undefined, { messageId: 'm1', from: 'lead', to: 'worker', text: '先跑测试' }),
  );
  const es = k.replay();
  assert.deepEqual(
    es.map((e) => e.kind),
    ['error', 'error', 'notice', 'notice'],
    '只产 error/notice 两 kind;delegation 状态不入转录(G14.213)',
  );
  assert.deepEqual(
    es.map((e) => e.md),
    ['boom', 'error', '技能已安装', '[lead → worker] 先跑测试'],
  );
  for (let i = 1; i < es.length; i++) assert.ok(es[i]!.seq > es[i - 1]!.seq, 'kind 扩条目共用同一 seq 单调序列');
});

test('⑥b notice 不做显示面过滤(G14.90/G14.106 是显示裁定——内核忠实归档,过滤归消费方)', () => {
  const k = new SessionKernel();
  pump(k, ev('notice', 'ask p1 answered'), ev('notice', '[memory] index changed: xxx'));
  assert.deepEqual(
    k.replay().map((e) => e.md),
    ['ask p1 answered', '[memory] index changed: xxx'],
  );
});

test('⑦ 上限 2000 丢最老(T5δ):压 2005 条 user/assistant 混合 → 恒 2000 且最老 5 条出档', () => {
  const k = new SessionKernel();
  for (let i = 0; i < 2005; i++) {
    if (i % 2 === 0) k.pump(ev('user', `goal-${i}`));
    else k.pump(ev('done', `reply-${i}`, { stopReason: 'done' }));
  }
  const es = k.replay();
  assert.equal(es.length, 2000, '超限丢最老,档面恒 2000');
  const mds = new Set(es.map((e) => e.md));
  for (let i = 0; i < 5; i++) {
    const oldestMd = i % 2 === 0 ? `> goal-${i}` : `reply-${i}`;
    assert.ok(!mds.has(oldestMd), `最老第 ${i} 条(${oldestMd})应已出档`);
  }
  assert.ok(mds.has('reply-5') && mds.has('> goal-6') && mds.has('reply-2003') && mds.has('> goal-2004'), '第 6 条起与最新条均在档');
  for (let i = 1; i < es.length; i++) assert.ok(es[i]!.seq > es[i - 1]!.seq, '裁后档内 seq 仍单调');
});

test('⑧ seed 播种同裁:注入 2005 条超限 → 恒 2000;后续 pump 续用同一上限;seed 不触发事件;seq 保留形态', () => {
  const events: string[] = [];
  const k = new SessionKernel({ onKernelEvent: (e) => events.push(e.t) });
  const batch: Array<Omit<KernelEntry, 'seq'>> = [];
  for (let i = 0; i < 2005; i++)
    batch.push({ ts: 100 + i, kind: i % 2 === 0 ? 'user' : 'assistant', md: i % 2 === 0 ? `> seed-goal-${i}` : `seed-reply-${i}` });
  k.seed(batch);
  let es = k.replay();
  assert.equal(es.length, 2000, '播种注入同样过 2000 上限');
  assert.equal(events.length, 0, 'seed 回种不触发内核事件(防装载双写)');
  assert.ok(es[0]!.seq >= 1 && es[es.length - 1]!.seq < 2006, 'seq 由内核续发(入参缺省形态)');
  const mds = new Set(es.map((e) => e.md));
  assert.ok(!mds.has('> seed-goal-0') && mds.has('seed-reply-5') && mds.has('> seed-goal-6'), '最老 5 条出档,第 6 条起在档');
  // seq 保留形态(v2 行与 live 同源):显式 seq 原样沿用,truncate 对位依赖
  const k2 = new SessionKernel();
  k2.seed([
    { seq: 3, ts: 1, kind: 'user', md: '> 一' },
    { seq: 7, ts: 2, kind: 'assistant', md: '答' },
  ]);
  k2.pump(ev('user', '二'));
  const es2 = k2.replay();
  assert.deepEqual(
    es2.map((e) => e.seq),
    [3, 7, 8],
    '显式 seq 沿用;后续条目自 max+1 续发',
  );
  k.pump(ev('done', 'post-seed reply', { stopReason: 'done' }));
  es = k.replay();
  assert.equal(es.length, 2000);
  assert.equal(es[es.length - 1]!.md, 'post-seed reply', '最新条在档');
  assert.equal(events.length, 1, 'pump 的新条目触发事件(播种后恢复正常落档)');
  assert.equal(events[0], 'seg-open');
  const mds2 = new Set(es.map((e) => e.md));
  assert.ok(!mds2.has('seed-reply-5'), '再压一条又丢一条最老');
  assert.ok(mds2.has('> seed-goal-6'), '次老条仍在档');
});

test('⑨ gui·thinking 秒:reasoning 段聚合,边界封段计秒(首尾 ts 差取整)', () => {
  const k = new SessionKernel();
  pump(k, ev('model-start', undefined, undefined, 500), ev('reasoning', '想', undefined, 1000), ev('reasoning', '思路', undefined, 2000), ev('notice', '边界', undefined, 8000));
  const es = k.replay();
  assert.deepEqual(
    es.map((e) => e.kind),
    ['run', 'thinking', 'notice'],
  );
  assert.equal(es[1]!.md, '想思路');
  assert.equal(es[1]!.seconds, 7);
  assert.equal(k.openSeg(), -1, '封段后无开启段');
});

test('⑨b thinking 无时刻差 → seconds 省略;token 到来先封思考段(思考先行)', () => {
  const k = new SessionKernel();
  pump(k, ev('reasoning', '想', undefined, 1000), ev('token', '正文', undefined, 1000), ev('done', '', { stopReason: 'done' }, 1000));
  const es = k.replay();
  assert.deepEqual(
    es.map((e) => e.kind),
    ['thinking', 'assistant'],
  );
  assert.equal(es[0]!.seconds, undefined);
  assert.equal(es[1]!.md, '正文');
});

test('⑩ run 内续轮 model-start 不重插 run 条(水位/游标单点)', () => {
  const k = new SessionKernel();
  pump(
    k,
    ev('model-start', undefined, undefined, 1000),
    ev('token', '一', undefined, 1100),
    ev('model-start', undefined, undefined, 2000),
    ev('token', '二', undefined, 2100),
    ev('done', '二', { stopReason: 'done' }, 3000),
  );
  const runs = k.replay().filter((e) => e.kind === 'run');
  assert.equal(runs.length, 1, 'model-start 每模型轮一次,run 条只在 run 边界开');
  assert.equal(runs[0]!.meta?.seconds, 2, 'seconds 自首个 model-start 起算');
});

test('⑪ runmeta 帧补全/覆盖 run 统计:steps/runSteps/tokens/cacheTokens/endedTs/changes 净化合入', () => {
  const k = new SessionKernel();
  pump(
    k,
    ev('model-start', undefined, undefined, 1000),
    ev('done', '答', { steps: 5, runSteps: 2, tokensUsed: 8000, stopReason: 'done' }, 2000),
    ev(
      'runmeta',
      undefined,
      {
        seconds: 14,
        steps: 5,
        runSteps: 2,
        tokens: 12_000,
        cacheTokens: 7,
        endedTs: 2500,
        changes: [
          { path: 'src/a.ts', status: 'modified', added: 3, deleted: 1 },
          { path: '', status: 'modified', added: 9, deleted: 9 },
          { path: 'new.ts', status: 'untracked', added: null, deleted: null, newLines: 12 },
        ],
      },
      2600,
    ),
  );
  const run = k.replay().find((e) => e.kind === 'run')!;
  assert.deepEqual(
    run.meta,
    {
      seconds: 14, // 帧覆盖 done 的 ts 差口径(权威统计晚到)
      steps: 5,
      runSteps: 2,
      tokens: 12_000,
      cacheTokens: 7,
      endedTs: 2500,
      changes: [
        { path: 'src/a.ts', status: 'modified', added: 3, deleted: 1 },
        { path: 'new.ts', status: 'untracked', added: null, deleted: null, newLines: 12 },
      ],
    },
    '帧字段覆盖;空 path 行丢弃;untracked 行数面保留',
  );
});

test('⑫ truncate:保留 seq<=upToSeq 前缀;序号不复用,后续条目续接单调序列', () => {
  const k = new SessionKernel();
  pump(k, ev('user', '一'), ev('done', '答一', { stopReason: 'done' }), ev('user', '二'), ev('done', '答二', { stopReason: 'done' }));
  const before = k.replay();
  assert.equal(before.length, 4);
  const cut = before[1]!.seq;
  k.truncate(cut);
  let es = k.replay();
  assert.deepEqual(
    es.map((e) => e.md),
    ['> 一', '答一'],
    '截断保留前缀',
  );
  k.pump(ev('user', '三'));
  es = k.replay();
  assert.equal(es.length, 3);
  assert.ok(es[2]!.seq > cut, 'truncate 后新条目 seq 续接(不复用被截号段)');
});

test('⑬ 段级事件面(v2 写者契约):seg-open open 标志/seg-update 回填/段闭合落终态;token 拼接零事件', () => {
  const events: Array<{ t: string; seq?: number; open?: boolean; kind?: string }> = [];
  const k = new SessionKernel({
    onKernelEvent: (e) => events.push(e.t === 'truncate' ? { t: e.t, seq: e.upToSeq } : e.t === 'steer' ? { t: e.t } : { t: e.t, seq: e.entry.seq, open: 'open' in e ? e.open : undefined, kind: e.entry.kind }),
  });
  pump(k, ev('user', '问'), ev('token', '答'));
  assert.deepEqual(
    events.map((e) => `${e.t}:${e.kind}:${e.open}`),
    ['seg-open:user:false', 'seg-open:assistant:true'],
    'user 即终态(open=false);正文开启段 open=true',
  );
  k.pump(ev('token', '案'));
  assert.equal(events.length, 2, 'token 并入开启段零事件(落档等闭合)');
  k.pump(ev('tool-call', 'read', { callId: 'c9' }));
  assert.equal(events.length, 4, 'tool-call 段边界:先发开启正文段闭合,再发工具条开启');
  assert.equal(events[2]!.t, 'seg-close');
  assert.equal(events[3]!.t, 'seg-open');
  k.pump(ev('tool-result', 'ok', { callId: 'c9', ok: true }));
  assert.equal(events.length, 5);
  assert.equal(events[4]!.t, 'seg-update', 'result 回填 → seg-update 行事件');
  k.pump(ev('done', '答案', { stopReason: 'done' }, 9999));
  assert.equal(events.length, 6);
  assert.equal(events[5]!.t, 'seg-open', 'done 无开启段:终答以闭合态直建(open=false,写者立即落行)');
  // truncate 事件
  k.truncate(0);
  assert.equal(events.length, 7);
  assert.equal(events[6]!.t, 'truncate');
});

test('⑭ reducer 纯件:applyEvent 零副作用(入参态不变)', () => {
  const s0 = initialKernelState();
  const s1 = applyEvent(s0, ev('token', 'x'));
  const s2 = applyEvent(s1, ev('tool-call', 'read', { callId: 'c' }));
  assert.equal(s0.entries.length, 0, '初始态不被扰动');
  assert.equal(s1.entries.length, 1);
  assert.equal(s2.entries.length, 2);
  assert.equal(s2.pending.length, 1);
});

test('⑮ 子代理事件另轨:payload.subagent 零条目(G8d 入口过滤单点)', () => {
  const k = new SessionKernel();
  pump(k, ev('token', '子代理正文', { subagent: 'w1' }), ev('tool-call', 'read', { callId: 's1', subagent: 'w1' }), ev('user', '主流'));
  const es = k.replay();
  assert.deepEqual(
    es.map((e) => e.kind),
    ['user'],
    '子代理事件不进主流转录',
  );
});

test('⓯ 等待队列(P5 内核化,spec §12):入队/编辑/重排/置首/撤回全操作——seq 位置重排、front 标记、变更即发 steer 整列事件', () => {
  const events: Array<{ t: string; items?: Array<{ seq: number; text: string; front: boolean }> }> = [];
  const k = new SessionKernel({ onKernelEvent: (e) => { if (e.t === 'steer') events.push({ t: e.t, items: e.items.map((x) => ({ ...x })) }); } });
  k.steerEnqueue('  一  '); // trim 入队
  k.steerEnqueue('二');
  k.steerEnqueue('   '); // 空白忽略
  assert.deepEqual(k.steerPendingItems(), [
    { seq: 0, text: '一', front: false },
    { seq: 1, text: '二', front: false },
  ]);
  assert.equal(events.length, 2, '空白入队零事件');
  assert.deepEqual(events[0]!.items, [{ seq: 0, text: '一', front: false }]);
  assert.ok(k.steerEditAt(1, '二改'), '编辑命中');
  assert.equal(k.steerEditAt(9, 'x'), false, '越界编辑 false');
  assert.ok(k.steerMove(1, 0), '重排');
  assert.ok(k.steerMoveToFront(1), '置首+front 标记');
  assert.deepEqual(k.steerPendingItems(), [
    { seq: 0, text: '一', front: true },
    { seq: 1, text: '二改', front: false },
  ]);
  assert.ok(k.steerRemoveAt(0), '撤回');
  assert.equal(k.steerRemoveAt(9), false, '越界撤回 false');
  assert.deepEqual(k.steerPendingItems(), [{ seq: 0, text: '二改', front: false }]);
  assert.equal(events.length, 6, '每次变更一事件(空白/越界零事件)');
  assert.deepEqual(events[events.length - 1]!.items, [{ seq: 0, text: '二改', front: false }], '事件=变更后整列快照');
});

test('⓯b 队列消费语义:steerDrain 仅取走 front 条(步边界注入);steerTakePending 全取(轮收束补跑);steerRestore 装载零事件', () => {
  const events: unknown[] = [];
  const k = new SessionKernel({ onKernelEvent: (e) => { if (e.t === 'steer') events.push(e); } });
  k.steerRestore([
    { seq: 0, text: '甲', front: false },
    { seq: 1, text: '乙', front: true },
    { seq: 2, text: '丙', front: false },
  ]);
  assert.equal(events.length, 0, '装载回种不发事件(防双写)');
  assert.deepEqual(k.steerDrain(), ['乙'], 'drain 只取置首');
  assert.deepEqual(k.steerPendingItems().map((x) => x.text), ['甲', '丙'], '普通条目留队并重排');
  assert.deepEqual(k.steerTakePending().map((x) => x.text), ['甲', '丙'], 'takePending 全取');
  assert.deepEqual(k.steerDrain(), []);
  assert.equal(k.steerPendingItems().length, 0);
});

test('⓯c 队列与转录互不扰动:steer 事件不产条目;pump 段面不受队列操作影响(G14.51 开启段保持)', () => {
  const k = new SessionKernel();
  pump(k, ev('user', '问'), ev('token', '答'));
  k.steerEnqueue('插话');
  const es = k.replay();
  assert.deepEqual(es.map((e) => e.kind), ['user', 'assistant'], '队列操作零转录条目');
  assert.equal(k.openSeg(), es[1]!.seq, '开启段游标不受扰');
  pump(k, ev('done', '答', { stopReason: 'done' }));
  assert.equal(k.replay().length, 2, '后续 done 仍正常闭合合并');
});
