import { describe, it, expect } from 'vitest';
import type { ChatEntry } from '../../chat-reducer';
import { dayUnitSpans, isSegmentEntry, prefixOffsets, sliceRange, unitEstimate } from './transcript-units';
import type { UnitSpan } from './transcript-units';

/** 2026-11-18 结构性改造第一层:转录块模型(纯投影)单测。
 *  块的划分口径必须与 DayGroupBlock 的节点装配循环逐条一致——否则虚拟窗口按块切片时会
 *  劈开工具折叠段/丢日分隔/多出旁白。 */

const e = (key: string, kind: ChatEntry['kind'], md = ''): ChatEntry => ({ key, kind, md, seq: 1, ts: 0 }) as unknown as ChatEntry;
const isCmd = (x: ChatEntry): boolean => x.kind === 'tool' && typeof x.name === 'string' && x.name.startsWith('/');
const officeHidden = (k: ChatEntry['kind'], md: string): boolean => k === 'notice' && md.startsWith('office:');

describe('转录块模型:块划分(镜像 DayGroupBlock 聚合规则)', () => {
  it('日分隔独立成块;命令/run/用户/正文各成单块', () => {
    const entries = [e('u1', 'user', 'hi'), e('r1', 'run'), e('c1', 'tool'), e('a1', 'assistant', 'ok')];
    // 命令三态行:tool + name 以 / 开头
    (entries[2] as unknown as { name: string }).name = '/plan';
    const spans = dayUnitSpans(0, 'd1', '1月10日', entries, new Set(), false, isCmd, officeHidden);
    expect(spans.map((s) => [s.kind, s.key, s.start, s.end])).toEqual([
      ['day', 'day:d1', 0, 0],
      ['user', 'u1', 0, 1],
      ['run', 'r1', 1, 2],
      ['cmd', 'c1', 2, 3],
      ['assistant', 'a1', 3, 4],
    ]);
  });

  it('连续工具/思考聚成一段;hidden 态相异处断段(运行中折叠留出的末条独立成段)', () => {
    const hidden = new Set(['t1', 'th1']);
    const entries = [e('t1', 'tool'), e('th1', 'thinking'), e('t2', 'tool'), e('u1', 'user', 'next')];
    const spans = dayUnitSpans(2, 'd2', '', entries, hidden, false, isCmd, officeHidden);
    expect(spans.map((s) => [s.kind, s.key, s.start, s.end])).toEqual([
      ['seg', 'seg:t1', 0, 2],
      ['seg', 'seg:t2', 2, 3],
      ['user', 'u1', 3, 4],
    ]);
    expect(spans[0]!.group).toBe(2);
  });

  it('折叠态正文/用户/旁白并入折叠段(与工具同段);notice 非折叠态独立成块', () => {
    const hidden = new Set(['t1', 'a1', 'n1', 't2']);
    const entries = [e('t1', 'tool'), e('a1', 'assistant', 'mid'), e('n1', 'notice', 'x'), e('t2', 'tool'), e('n2', 'notice', 'visible')];
    const spans = dayUnitSpans(0, 'd', '', entries, hidden, false, isCmd, officeHidden);
    expect(spans.map((s) => [s.kind, s.key, s.start, s.end])).toEqual([
      ['seg', 'seg:t1', 0, 4],
      ['assistant', 'n2', 4, 5],
    ]);
    expect(isSegmentEntry(entries[1]!, hidden)).toBe(true); // 折叠态 assistant 并入段
    expect(isSegmentEntry(entries[4]!, hidden)).toBe(false); // 可见 notice 独立
  });

  it('办公模式隐藏旁白整条跳过且不断段;无 label 不产日分隔块', () => {
    const entries = [e('t1', 'tool'), e('n1', 'notice', 'office:cfg'), e('t2', 'tool')];
    const spans = dayUnitSpans(1, 'none', '', entries, new Set(), true, isCmd, officeHidden);
    expect(spans).toHaveLength(1);
    expect([spans[0]!.kind, spans[0]!.start, spans[0]!.end]).toEqual(['seg', 0, 3]);
  });

  it('内容估算:正文按 md 长度放大、折叠段保持头行高度、用户气泡随文长增长(2026-11-19 冷开长帧轮)', () => {
    const long = 'x'.repeat(3000);
    const entries = [e('u1', 'user', long), e('a1', 'assistant', long), e('t1', 'tool', long)];
    const spans = dayUnitSpans(0, 'd', '', entries, new Set(['t1']), false, isCmd, officeHidden);
    const byKey = new Map(spans.map((s) => [s.key, s]));
    expect(byKey.get('a1')!.est!).toBeGreaterThan(150 + 1000); // 3000 字 ≫ 常数 150
    expect(byKey.get('u1')!.est!).toBeGreaterThan(96 + 500);
    expect(byKey.get('seg:t1')!.est).toBe(44); // 整段折叠=只有 Worked 头
    // 前缀和吃 est;实测值仍优先
    const off = prefixOffsets(spans, new Map());
    expect(off[2]! - off[1]!).toBe(byKey.get('a1')!.est);
    const off2 = prefixOffsets(spans, new Map([['a1', 42]]));
    expect(off2[2]! - off2[1]!).toBe(42);
  });
});

describe('转录块模型:高度前缀与视口切片', () => {
  const spans: UnitSpan[] = [
    { key: 'a', kind: 'day', group: 0, start: 0, end: 0, label: 'd' }, // 估算 46
    { key: 'b', kind: 'user', group: 0, start: 0, end: 1, label: '' }, // 估算 96(实测 200)
    { key: 'c', kind: 'seg', group: 0, start: 1, end: 3, label: '' }, // 实测 50
    { key: 'd', kind: 'assistant', group: 0, start: 3, end: 4, label: '', entryKind: 'assistant' }, // 估算 150
  ];

  it('实测优先、缺省估算;前缀和=块顶偏移', () => {
    const heights = new Map([['b', 200], ['c', 50]]);
    expect(prefixOffsets(spans, heights)).toEqual([0, 46, 246, 296, 446]);
    expect(prefixOffsets(spans, new Map())).toEqual([0, 46, 142, 186, 336]);
    expect(unitEstimate('assistant', 'notice')).toBe(48);
  });

  it('切片含 overscan;底部贴底时取尾部;视口上方块不挂', () => {
    const offsets = prefixOffsets(spans, new Map([['b', 200], ['c', 50]])); // [0,46,246,296,446]
    // 视口 100,滚动到 150:可见块 = b(46-246) 与 c(246-296);overscan 0
    expect(sliceRange(offsets, 150, 100, 0)).toEqual({ first: 1, last: 3 });
    // overscan 120:首块前探到 a(46+120>150→a 的 bottom 46 不大于 lo=30... lo=30 → a(bottom 46)>30 → first=0)
    expect(sliceRange(offsets, 150, 100, 120)).toEqual({ first: 0, last: 4 });
    // 贴底:scrollTop=346,视口 100 → 末块 d 覆盖 [296,446),top=346 落在 c 之后 → first=3
    expect(sliceRange(offsets, 346, 100, 0)).toEqual({ first: 3, last: 4 });
    // 顶部:scrollTop 0 → first=0,视口 100 只覆盖 a(0-46)与 b(46-246)→ 末块 2
    expect(sliceRange(offsets, 0, 100, 0)).toEqual({ first: 0, last: 2 });
  });

  it('空列表/单块边界', () => {
    expect(sliceRange([0], 0, 500, 0)).toEqual({ first: 0, last: 0 });
    const one = prefixOffsets([spans[1]!], new Map());
    expect(sliceRange(one, 0, 100, 0)).toEqual({ first: 0, last: 1 });
    expect(sliceRange(one, 900, 100, 0)).toEqual({ first: 0, last: 1 }); // 越界钳到唯一块
  });
});
