import { describe, expect, it } from 'vitest';
import { splitMentionTokens } from './mention';

describe('$ / # 软引用 token（spec 2026-11-04 §3.1）', () => {
  it('$id 命中为 agent token（词边界）', () => {
    expect(splitMentionTokens('让 $devx 亲自写').find((t) => t.kind === 'agent')).toEqual({ text: '$devx', kind: 'agent' });
  });
  it('#id 命中为 team token', () => {
    expect(splitMentionTokens('#fullstack-delivery 交付这个特性').find((t) => t.kind === 'team')).toEqual({ text: '#fullstack-delivery', kind: 'team' });
  });
  it('# 后大写不命中（#L30 行锚不误伤）', () => {
    expect(splitMentionTokens('见 [a L30](./a.ts#L30) 与 #Title').every((t) => t.kind !== 'team' && t.kind !== 'agent')).toBe(true);
  });
  it('$var 粘贴文本不命中（需词边界起手）', () => {
    expect(splitMentionTokens('export PATH=$PATH/bin').every((t) => t.kind !== 'agent')).toBe(true);
  });
  it('同一消息多引用各自成 token', () => {
    const kinds = splitMentionTokens('#t1 加 $a1').filter((t) => t.kind === 'team' || t.kind === 'agent').map((t) => t.kind);
    expect(kinds).toEqual(['team', 'agent']);
  });
  it('既有 / 词法不回归(正则旗改动 i→显式 a-zA-Z 的等价钉)', () => {
    expect(splitMentionTokens('/cmd x').find((t) => t.text === '/cmd')).toEqual({ text: '/cmd', kind: 'cmd' });
    expect(splitMentionTokens('a /sk b').find((t) => t.text === '/sk')).toEqual({ text: '/sk', kind: 'skill' });
  });
});
