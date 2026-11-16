import { describe, it, expect } from 'vitest';
import type { SessionRow, SessionTaskRow } from '../connection';
import { parseTabSession, ensureSession, openTab } from './tab-state';
import { TAB_REGISTRY, TAB_ICONS, registryProbe } from './registry';
import {
  sunxCardOf, assembleSunxCards, aggregateSunxCards, sunxSectionsOf, sunxSnapOf, taskCountsOf,
  type SunxSnapSlice,
} from './sunx-board';

/**
 * SUNX 总览页数据面(sunx P2 Task 8,spec §17.3;2026-11-16 数据源根修+状态五桶化):
 * ① 页签注册——'sunxboard' 入注册表(单例/常量键)+盘档消毒白名单(kind 值 'sunx' 不是页签类型,
 *   恰是防语义混淆的钉面);旧档无此类型不炸不添。
 * ② 卡片组装——/sessions 行 kind==='sunx' 过滤 + 账本(sessionTasks 同源后台任务)与团队板任务
 *   五态计数(运行中/等待/完成/失败/已取消)+挂起段=等待确认;未挂载行(无 liveSessionId)零快照降级。
 * ③ 聚合条——卡片数据前端推导(运行中实例/任务五态/等待确认),零新增后端。
 */

const row = (id: string, over: Partial<SessionRow & { root: string; slug: string }> = {}): SessionRow & { root: string; slug: string } => ({
  id,
  file: `${id}.jsonl`,
  updatedAt: 1_000,
  firstUser: `first ${id}`,
  root: 'D:/w/alpha',
  slug: 'alpha',
  ...over,
} as SessionRow & { root: string; slug: string });

const led = (id: string, status: string, over: Partial<SessionTaskRow> = {}): SessionTaskRow => ({
  id,
  kind: 'subagent',
  label: `agent ${id}`,
  status,
  startedAt: 500,
  ...over,
} as SessionTaskRow);

const boardTask = (title: string, status: string, updatedAt?: number): { title: string; status: string; updatedAt?: number } => ({
  title, status, ...(updatedAt !== undefined ? { updatedAt } : {}),
});

const snap = (ledger: SessionTaskRow[], boardTasks: Array<{ title: string; status: string; updatedAt?: number }> = [], pendingCount = 0): SunxSnapSlice => ({
  ledger,
  boardTasks,
  pendingCount,
  awaitingKnown: true,
});

describe('sunxboard 页签注册(sunx P2 Task 8)', () => {
  it('注册表条目在场:单例+常量键 resolveKey;图标随表', () => {
    const entry = TAB_REGISTRY.find((e) => e.id === 'sunxboard');
    expect(entry).toBeDefined();
    expect(entry!.singleton).toBe(true);
    expect(entry!.resolveKey({})).toBe('');
    expect(TAB_ICONS.sunxboard).toBeDefined();
    expect(entry!.title({}).length).toBeGreaterThan(0);
  });

  it('单例判重:同型重开=聚焦既有不重复(uid 恒 sunxboard:)', () => {
    const probe = registryProbe();
    let s = ensureSession({}, 's1', probe);
    s = openTab(s, 's1', 'sunxboard', {}, probe);
    s = openTab(s, 's1', 'sunxboard', {}, probe);
    expect(s.s1.tabs).toHaveLength(1);
    expect(s.s1.tabs[0]!.uid).toBe('sunxboard:');
    expect(s.s1.activeUid).toBe('sunxboard:');
  });

  it('盘档消毒白名单含 sunxboard:sunxboard 页签随档保留;kind 值 "sunx" 不是页签类型(语义混淆防护)——拒', () => {
    const parsed = parseTabSession({
      tabs: [
        { uid: 'sunxboard:', type: 'sunxboard', params: {}, createdAt: 1 },
        { uid: 'bogus:', type: 'sunx', params: {}, createdAt: 2 },
      ],
      recentClosed: [{ type: 'sunxboard', params: {}, closedAt: 3, createdAt: 4 }],
      activeUid: 'sunxboard:',
      collapsed: false,
      width: 520,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.tabs.map((t) => t.type)).toEqual(['sunxboard']);
    expect(parsed!.recentClosed.map((c) => c.type)).toEqual(['sunxboard']);
    expect(parsed!.activeUid).toBe('sunxboard:');
  });
});

describe('任务五态计数(taskCountsOf:账本+团队板任务并入,2026-11-16 状态词汇对齐既有体系)', () => {
  it('账本态映射:running→运行中/done→完成/failed→失败/stopped→已取消(后台任务语义)', () => {
    expect(taskCountsOf(
      [led('a', 'running'), led('b', 'done'), led('c', 'failed'), led('d', 'stopped')],
      [],
    )).toEqual({ running: 1, pending: 0, done: 1, failed: 1, cancelled: 1 });
  });

  it('板任务态映射:pending→等待/running→运行中/success→完成/failed→失败/cancelled→已取消(团队板语义)', () => {
    expect(taskCountsOf([], [
      boardTask('评审', 'pending'), boardTask('实现', 'running'), boardTask('交付', 'success'),
      boardTask('校对', 'failed'), boardTask('旧稿', 'cancelled'),
    ])).toEqual({ running: 1, pending: 1, done: 1, failed: 1, cancelled: 1 });
  });

  it('双源并入:同桶求和(账本 fork 通道+板任务 target:team 通道)', () => {
    expect(taskCountsOf([led('a', 'running'), led('b', 'done')], [boardTask('评审', 'pending'), boardTask('修', 'running')]))
      .toEqual({ running: 2, pending: 1, done: 1, failed: 0, cancelled: 0 });
  });
});

describe('卡片组装(sunxCardOf/assembleSunxCards)', () => {
  it('sunxCardOf 五态映射:账本 stopped=已取消;板任务 pending=等待/success=完成;等待确认=挂起行数;最近活动=最近任务(title 优先)', () => {
    const card = sunxCardOf(
      row('j1', { kind: 'sunx', title: '仓库管家', liveSessionId: 'sx1', updatedAt: 1_000, awaiting: true }),
      snap(
        [
          led('l1', 'running', { startedAt: 2_000 }),
          led('l2', 'done', { startedAt: 4_000, endedAt: 4_500 }),
          led('l3', 'failed', { startedAt: 1_500, endedAt: 1_600 }),
          led('l4', 'stopped', { startedAt: 1_000, endedAt: 1_200 }),
        ],
        [boardTask('评审任务', 'pending', 3_000), boardTask('实现任务', 'success', 6_000)],
        2,
      ),
    );
    expect(card.name).toBe('仓库管家');
    expect(card.live).toBe(true);
    expect(card.tasks).toEqual({ running: 1, pending: 1, done: 2, failed: 1, cancelled: 1 });
    expect(card.awaiting).toBe(2);
    expect(card.awaitingKnown).toBe(true);
    expect(card.awaitingRow).toBe(true);
    expect(card.lastActivity).toEqual({ ts: 6_000, label: '实现任务' }); // updatedAt 最大;板任务 title
  });

  it('快照缺席降级:未挂载行(无 liveSessionId)五态归零/等待确认未知;lastActivity 回落行 updatedAt;无题回落 firstUser/空', () => {
    const card = sunxCardOf(row('j2', { kind: 'sunx', updatedAt: 7_000, awaiting: true }), null);
    expect(card.live).toBe(false);
    expect(card.tasks).toEqual({ running: 0, pending: 0, done: 0, failed: 0, cancelled: 0 });
    expect(card.awaiting).toBe(1); // 快照缺席=退行级 awaiting 布尔(徽标兜底)
    expect(card.awaitingKnown).toBe(false);
    expect(card.lastActivity).toEqual({ ts: 7_000, label: '' });
    expect(card.name).toBe('first j2'); // 无 title 回落 firstUser
    const unnamed = sunxCardOf(row('j3', { kind: 'sunx', firstUser: undefined }), null);
    expect(unnamed.name).toBe(''); // 组件回落「未命名 Sunx」
  });

  it('sunxSnapOf:board.tasks 结构面投影(title/status/updatedAt 窄化)+pending 缺席=0+账本随行', () => {
    const slice = sunxSnapOf(
      { status: 'running', board: { tasks: { t1: { id: 't1', title: '评审', status: 'pending', spec: '', teamId: 'tm', dependsOn: [] } }, seq: 1 }, pending: [{ pid: 'p1', kind: 'approval' }] } as unknown as Parameters<typeof sunxSnapOf>[0],
      [led('l1', 'running')],
    );
    expect(slice.ledger).toHaveLength(1);
    expect(slice.boardTasks).toEqual([{ title: '评审', status: 'pending', updatedAt: undefined }]);
    expect(slice.pendingCount).toBe(1);
    expect(sunxSnapOf({ status: 'idle', board: { tasks: {}, seq: 0 } } as unknown as Parameters<typeof sunxSnapOf>[0], []).pendingCount).toBe(0);
  });

  it('assembleSunxCards:按行组装,快照只对 live 行查询(snapOf 未挂载行零调用)', () => {
    const rows = [
      row('j1', { kind: 'sunx', liveSessionId: 'sx1', slug: 'alpha' }),
      row('j2', { kind: 'sunx', slug: 'beta' }), // 未挂载
    ];
    const asked: string[] = [];
    const cards = assembleSunxCards(rows, (liveId) => {
      asked.push(liveId);
      return snap([led('l1', 'running')], [], 1);
    });
    expect(asked).toEqual(['sx1']);
    expect(cards).toHaveLength(2);
    expect(cards[0]!.tasks.running).toBe(1);
    expect(cards[1]!.tasks.running).toBe(0);
  });
});

describe('聚合条(卡片数据前端推导,零新增后端)', () => {
  it('aggregateSunxCards:running=live 行数;五态逐卡求和;等待确认=已知挂起求和(未知不计)', () => {
    const cards = [
      sunxCardOf(row('j1', { kind: 'sunx', liveSessionId: 'sx1' }), snap([led('l1', 'running'), led('l2', 'done')], [], 2)),
      sunxCardOf(row('j2', { kind: 'sunx', liveSessionId: 'sx2' }), snap([led('l3', 'stopped'), led('l4', 'running')], [boardTask('评审', 'pending')], 0)),
      sunxCardOf(row('j3', { kind: 'sunx', awaiting: true }), null), // 未挂载但行级 awaiting:不进等待确认计数(未知不计)
    ];
    expect(aggregateSunxCards(cards)).toEqual({
      running: 2,
      tasks: { running: 2, pending: 1, done: 1, failed: 0, cancelled: 1 },
      awaiting: 2,
    });
    expect(aggregateSunxCards([])).toEqual({ running: 0, tasks: { running: 0, pending: 0, done: 0, failed: 0, cancelled: 0 }, awaiting: 0 });
  });

  it('sunxSectionsOf:按工作区分节(R10),首现保序;组内即卡片序', () => {
    const cards = assembleSunxCards(
      [
        row('j1', { kind: 'sunx', slug: 'beta', updatedAt: 300 }),
        row('j2', { kind: 'sunx', slug: 'alpha', updatedAt: 200 }),
        row('j3', { kind: 'sunx', slug: 'beta', updatedAt: 100 }),
      ],
      () => null,
    );
    const secs = sunxSectionsOf(cards);
    expect(secs.map((s) => s.slug)).toEqual(['beta', 'alpha']); // 行序新→旧的首现序
    expect(secs[0]!.cards.map((c) => c.journalId)).toEqual(['j1', 'j3']);
    expect(secs[0]!.root).toBe('D:/w/alpha');
  });
});
