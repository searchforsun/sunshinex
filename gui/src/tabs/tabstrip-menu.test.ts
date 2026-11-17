import { describe, it, expect } from 'vitest';
import { menuEntryVisible } from './TabStrip';

const o = (dev: boolean, showMore = false, welcomeOnly = false): { dev: boolean; showMore: boolean; welcomeOnly: boolean } => ({ dev, showMore, welcomeOnly });

describe('「+」菜单分层(2026-11-17 四常驻+更多|收起)', () => {
  it('普通态只露四常驻', () => {
    for (const id of ['tasks', 'artifacts', 'web', 'sidechat']) expect(menuEntryVisible(id, o(false))).toBe(true);
    for (const id of ['diff', 'plans', 'agents', 'bgtasks', 'memory', 'learned', 'terminal', 'sunxboard']) expect(menuEntryVisible(id, o(false))).toBe(false);
  });
  it('点更多后其余八项可见', () => {
    for (const id of ['diff', 'plans', 'agents', 'bgtasks', 'memory', 'learned', 'terminal', 'sunxboard']) expect(menuEntryVisible(id, o(false, true))).toBe(true);
  });
  it('开发者模式全平铺', () => {
    for (const id of ['diff', 'plans', 'agents', 'bgtasks', 'memory', 'learned', 'terminal', 'sunxboard', 'tasks', 'artifacts', 'web', 'sidechat']) expect(menuEntryVisible(id, o(true))).toBe(true);
  });
  it('欢迎页只开能落地的:普通=浏览器;开发者=浏览器+终端', () => {
    expect(menuEntryVisible('web', o(false, false, true))).toBe(true);
    expect(menuEntryVisible('terminal', o(false, false, true))).toBe(false);
    expect(menuEntryVisible('tasks', o(false, false, true))).toBe(false);
    expect(menuEntryVisible('terminal', o(true, false, true))).toBe(true);
    expect(menuEntryVisible('tasks', o(true, false, true))).toBe(false);
  });
});
