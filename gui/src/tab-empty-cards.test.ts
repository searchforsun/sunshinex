import { describe, it, expect } from 'vitest';
import { emptyTabCardIds } from './App';

describe('空态快捷入口(2026-11-17 裁定)', () => {
  it('普通:欢迎页只浏览器;会话内浏览器+辅助对话', () => {
    expect(emptyTabCardIds(true, false)).toEqual(['web']);
    expect(emptyTabCardIds(false, false)).toEqual(['web', 'side']);
  });
  it('开发者:欢迎页终端+浏览器;会话内审查+浏览器+终端+辅助对话', () => {
    expect(emptyTabCardIds(true, true)).toEqual(['terminal', 'web']);
    expect(emptyTabCardIds(false, true)).toEqual(['diff', 'web', 'terminal', 'side']);
  });
});
