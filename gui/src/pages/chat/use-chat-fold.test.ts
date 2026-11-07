import { describe, it, expect } from 'vitest';
import { collapsedHiddenKeys } from './use-chat-fold';
import type { ChatEntry } from '../../chat-reducer';

const e = (key: string, kind: ChatEntry['kind']): ChatEntry => ({ key, kind, md: '', ts: 0, seq: 0 } as unknown as ChatEntry);

describe('collapsedHiddenKeys 折叠区间边界', () => {
  it('user 条起新段:其后工具行不折进上一轮折叠区(2026-10-31「/compact 三态行不显示」钉)', () => {
    // 新开场后下一帧必先 model-start(=r2);前瞻见 run 即判定非轮内插入
    const entries = [e('r1', 'run'), e('t1', 'tool'), e('a1', 'assistant'), e('u2', 'user'), e('r2', 'run'), e('t2', 'tool')];
    const hidden = collapsedHiddenKeys(entries, new Set(['r1']));
    expect(hidden.has('t1')).toBe(true); // 上一轮工具行按折叠隐藏
    expect(hidden.has('u2')).toBe(false); // 终答后的新开场用户条可见
    expect(hidden.has('t2')).toBe(false); // 新 run 未折叠→其后工具可见
  });
  it('斜杠命令行=系统提示行,即便落在折叠区内也不隐藏(2026-10-31 裁定「不受工具折叠影响」)', () => {
    const cmd = { ...e('cmd', 'tool'), name: '/compact' } as ChatEntry;
    const hidden = collapsedHiddenKeys([e('r1', 'run'), e('t1', 'tool'), cmd], new Set(['r1']));
    expect(hidden.has('t1')).toBe(true);
    expect(hidden.has('cmd')).toBe(false);
  });
  it('轮内插入不上折叠行且不复位 hide:其后工具/成员消息仍折;终答后新开场不折', () => {
    const insert = e('u-ins', 'user');
    const peer = { ...e('msg', 'notice'), md: '[w1 → lead] 做完了' } as ChatEntry;
    const other = { ...e('n1', 'notice'), md: 'hello' } as ChatEntry;
    const entries = [
      e('r1', 'run'),
      e('t1', 'tool'),
      insert,
      peer,
      other,
      e('t2', 'tool'),
      e('a1', 'assistant'),
      e('u2', 'user'),
    ];
    const hidden = collapsedHiddenKeys(entries, new Set(['r1']));
    expect(hidden.has('t1')).toBe(true);
    expect(hidden.has('u-ins')).toBe(false); // 插入可见、不进折叠行
    expect(hidden.has('msg')).toBe(false); // 成员消息同插入:可见、不进折叠行
    expect(hidden.has('n1')).toBe(false); // 普通旁白保留
    expect(hidden.has('t2')).toBe(true); // 插入后工具仍折(不因插入复位 hide)
    expect(hidden.has('u2')).toBe(false);
  });
  it('记忆/技能沉淀旁白随工具进折叠行;普通 notice 保留', () => {
    const mem = { ...e('m1', 'notice'), md: '[memory] saved: foo-bar' } as ChatEntry;
    const skill = { ...e('s1', 'notice'), md: '[skills] learned: baz' } as ChatEntry;
    const memUp = { ...e('m2', 'notice'), md: '[memory] updated: foo-bar, qux' } as ChatEntry;
    const plain = { ...e('n1', 'notice'), md: 'hello' } as ChatEntry;
    const entries = [e('r1', 'run'), e('t1', 'tool'), mem, skill, memUp, plain, e('a1', 'assistant')];
    const hidden = collapsedHiddenKeys(entries, new Set(['r1']));
    expect(hidden.has('m1')).toBe(true);
    expect(hidden.has('s1')).toBe(true);
    expect(hidden.has('m2')).toBe(true);
    expect(hidden.has('n1')).toBe(false);
    expect(hidden.has('t1')).toBe(true);
  });
  it('正文后轮内插入:前瞻见后续工具→不上折叠行且后续工具仍折', () => {
    const entries = [
      e('r1', 'run'),
      e('t1', 'tool'),
      e('a1', 'assistant'),
      e('u-ins', 'user'),
      e('think', 'thinking'),
      e('t2', 'tool'),
      e('a2', 'assistant'),
    ];
    const hidden = collapsedHiddenKeys(entries, new Set(['r1']));
    expect(hidden.has('u-ins')).toBe(false);
    expect(hidden.has('t1')).toBe(true);
    expect(hidden.has('think')).toBe(true);
    expect(hidden.has('t2')).toBe(true);
    expect(hidden.has('a1')).toBe(true); // 中间正文随折
    expect(hidden.has('a2')).toBe(false); // 末条终答保留
  });
});

describe('collapsedHiddenKeys 运行中折叠(2026-11-07 用户裁定)', () => {
  const live = (key: string): ChatEntry => ({ ...e(key, 'run'), streaming: true } as ChatEntry);
  const streamingText = (key: string): ChatEntry => ({ ...e(key, 'assistant'), streaming: true } as ChatEntry);

  it('在途轮折叠:只留最后一条工具/思考行与最后一段正文(含流式终答),其余工具/思考/中间正文隐藏', () => {
    const entries = [live('r1'), e('th1', 'thinking'), e('a1', 'assistant'), e('t1', 'tool'), e('t2', 'tool'), e('th2', 'thinking'), e('a2', 'assistant'), e('t3', 'tool'), streamingText('a3')];
    const hidden = collapsedHiddenKeys(entries, new Set(['r1']));
    expect([...hidden].sort()).toEqual(['a1', 'a2', 't1', 't2', 'th1', 'th2']);
    expect(hidden.has('t3')).toBe(false); // 最后一条工具行
    expect(hidden.has('a3')).toBe(false); // 最后一段正文(流式中的终答)
  });

  it('在途轮尚无正文:只留最后一条工具/思考行;思考行也可作末条;未折叠零隐藏', () => {
    const entries = [live('r1'), e('t1', 'tool'), e('th1', 'thinking')];
    expect([...collapsedHiddenKeys(entries, new Set(['r1']))]).toEqual(['t1']);
    expect(collapsedHiddenKeys(entries, new Set()).size).toBe(0);
  });

  it('封段后回到常规折叠:工具/思考全收,只留终答', () => {
    const entries = [e('r1', 'run'), e('a1', 'assistant'), e('t1', 'tool'), e('a2', 'assistant')];
    expect([...collapsedHiddenKeys(entries, new Set(['r1']))].sort()).toEqual(['a1', 't1']);
  });

  it('轮内插入不截断在途轮的末条判定;斜杠命令行不算末条工具', () => {
    const cmd = { ...e('cmd', 'tool'), name: '/compact' } as ChatEntry;
    const entries = [live('r1'), e('t1', 'tool'), e('u-ins', 'user'), e('t2', 'tool'), cmd];
    const hidden = collapsedHiddenKeys(entries, new Set(['r1']));
    expect(hidden.has('t1')).toBe(true);
    expect(hidden.has('t2')).toBe(false);
    expect(hidden.has('u-ins')).toBe(false);
    expect(hidden.has('cmd')).toBe(false);
  });
});
