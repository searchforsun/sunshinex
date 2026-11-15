import { describe, it, expect } from 'vitest';
import type { SessionRow } from '../connection';
import type { Delegation } from '../projection';
import { parseTabSession, ensureSession, openTab } from './tab-state';
import { TAB_REGISTRY, TAB_ICONS, registryProbe } from './registry';
import {
  sunxRowsOf, sunxCardOf, assembleSunxCards, aggregateSunxCards, sunxSectionsOf, sunxSnapOf,
  type SunxSnapSlice,
} from './sunx-board';

/**
 * SUNX 总览页数据面(sunx P2 Task 8,spec §17.3):
 * ① 页签注册——'sunxboard' 入注册表(单例/常量键)+盘档消毒白名单(kind 值 'sunx' 不是页签类型,
 *   恰是防语义混淆的钉面);旧档无此类型不炸不添。
 * ② 卡片组装——/sessions 行 kind==='sunx' 过滤 + snapshot 载荷映射(委派投影计数/挂起计数/
 *   最近活动);未挂载行(无 liveSessionId)零快照降级。
 * ③ 聚合条——卡片数据前端推导(运行中实例/在飞任务/待裁决),零新增后端。
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

const del = (id: string, status: Delegation['status'], over: Partial<Delegation> = {}): Delegation => ({
  id,
  kind: 'subagent',
  label: `agent ${id}`,
  status,
  startedAt: 500,
  ...over,
});

const snap = (delegations: Delegation[], pendingCount = 0, status: SunxSnapSlice['status'] = 'running'): SunxSnapSlice => ({
  status,
  delegations,
  pendingCount,
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

  it('旧档无此类型不炸不添:仅 legacy 类型照常解析', () => {
    const legacy = parseTabSession({
      tabs: [{ uid: 'tasks:', type: 'tasks', params: {}, createdAt: 1 }],
      activeUid: 'tasks:',
      collapsed: true,
      width: 520,
    });
    expect(legacy).not.toBeNull();
    expect(legacy!.tabs).toHaveLength(1);
    expect(legacy!.tabs.some((t) => t.type === 'sunxboard')).toBe(false);
  });
});

describe('卡片组装(kind 过滤/snapshot 载荷映射/计数推导)', () => {
  it('sunxRowsOf:kind==="sunx" 过滤 + updatedAt 新→旧', () => {
    const rows = [
      row('j1', { kind: 'sunx', updatedAt: 100 }),
      row('j2', { updatedAt: 200 }), // standard:滤除
      row('j3', { kind: 'sunx', updatedAt: 300 }),
      row('j4', { kind: 'exec', updatedAt: 400 }), // 他 kind:滤除
    ];
    const out = sunxRowsOf(rows);
    expect(out.map((r) => r.id)).toEqual(['j3', 'j1']);
  });

  it('sunxCardOf 快照映射:姓名 title→firstUser;在飞=未终态(running/paused);完成=done;待裁决=挂起行数;最近活动=最近委派', () => {
    const card = sunxCardOf(
      row('j1', { kind: 'sunx', title: '仓库管家', liveSessionId: 'sx1', updatedAt: 1_000, awaiting: true }),
      snap(
        [
          del('d1', 'running', { startedAt: 2_000 }),
          del('d2', 'paused', { startedAt: 3_000 }),
          del('d3', 'done', { startedAt: 4_000, endedAt: 4_500 }),
          del('d4', 'failed', { startedAt: 1_500, endedAt: 1_600 }),
          del('d5', 'failed', { title: '交付日报', startedAt: 1_000, endedAt: 5_000 }), // 最近(endedAt 最大;终态失败不进完成计)
        ],
        2,
      ),
    );
    expect(card.name).toBe('仓库管家');
    expect(card.live).toBe(true);
    expect(card.inFlight).toBe(2); // running+paused=未终态
    expect(card.done).toBe(1); // 严格 done(failed/skipped 不计完成)
    expect(card.pending).toBe(2);
    expect(card.pendingKnown).toBe(true);
    expect(card.awaiting).toBe(true);
    expect(card.lastActivity).toEqual({ ts: 5_000, label: '交付日报' }); // title 优先于 label
  });

  it('快照缺席降级:未挂载行(无 liveSessionId)计数归零/待裁决未知;lastActivity 回落行 updatedAt;无题回落 firstUser/空', () => {
    const card = sunxCardOf(row('j2', { kind: 'sunx', updatedAt: 7_000 }), null);
    expect(card.live).toBe(false);
    expect(card.inFlight).toBe(0);
    expect(card.done).toBe(0);
    expect(card.pending).toBe(0);
    expect(card.pendingKnown).toBe(false);
    expect(card.lastActivity).toEqual({ ts: 7_000, label: '' });
    expect(card.name).toBe('first j2'); // 无 title 回落 firstUser
    const unnamed = sunxCardOf(row('j3', { kind: 'sunx', firstUser: undefined }), null);
    expect(unnamed.name).toBe(''); // 组件回落「未命名 Sunx」
  });

  it('sunxSnapOf:SnapshotResponse 窄面投影(pending 缺席=0)', () => {
    expect(sunxSnapOf({ status: 'running', delegations: [del('d1', 'running')] })).toEqual({
      status: 'running',
      delegations: [del('d1', 'running')],
      pendingCount: 0,
    });
    expect(sunxSnapOf({ status: 'idle', delegations: [], pending: [{ pid: 'p1', kind: 'approval' }] }).pendingCount).toBe(1);
  });

  it('assembleSunxCards:按行组装,快照只对 live 行查询(snapOf 未挂载行零调用)', () => {
    const rows = [
      row('j1', { kind: 'sunx', liveSessionId: 'sx1', slug: 'alpha' }),
      row('j2', { kind: 'sunx', slug: 'beta' }), // 未挂载
    ];
    const asked: string[] = [];
    const cards = assembleSunxCards(rows, (liveId) => {
      asked.push(liveId);
      return snap([del('d1', 'running')], 1);
    });
    expect(asked).toEqual(['sx1']);
    expect(cards).toHaveLength(2);
    expect(cards[0]!.inFlight).toBe(1);
    expect(cards[1]!.inFlight).toBe(0);
  });
});

describe('聚合条(卡片数据前端推导,零新增后端)', () => {
  it('aggregateSunxCards:运行中=live 行数;在飞=逐卡求和;待裁决=已知挂起求和(未知不计)', () => {
    const cards = [
      sunxCardOf(row('j1', { kind: 'sunx', liveSessionId: 'sx1' }), snap([del('d1', 'running'), del('d2', 'done')], 2)), // 在飞 1
      sunxCardOf(row('j2', { kind: 'sunx', liveSessionId: 'sx2' }), snap([del('d3', 'paused'), del('d4', 'running')], 0)), // 在飞 2
      sunxCardOf(row('j3', { kind: 'sunx', awaiting: true }), null), // 未挂载但行级 awaiting:不进待裁决计数
    ];
    expect(aggregateSunxCards(cards)).toEqual({ running: 2, inFlight: 3, pending: 2 });
    expect(aggregateSunxCards([])).toEqual({ running: 0, inFlight: 0, pending: 0 });
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
