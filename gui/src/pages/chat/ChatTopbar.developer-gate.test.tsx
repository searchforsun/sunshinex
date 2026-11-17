import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatTopbar } from './ChatTopbar';
import type { Connection } from '../../connection';

const conn = {} as Connection;
const base = {
  fixedTitle: undefined,
  titleEditing: false,
  titleDraft: '',
  setTitleDraft: () => undefined,
  commitTitle: () => undefined,
  setTitleEditing: () => undefined,
  displayTitle: 'demo',
  sessionId: 's1',
  tokens: 0,
  steps: 0,
  running: false,
  blocks: [{ kind: 'todo', state: 'done', done: 1, count: 2 }] as const,
  conn,
  archived: false,
  onArchive: () => undefined,
};

/** 2026-11-17 用户裁定「上面的状态普通模式下应该也显示,不然用户怎么去看当前状态」:
 *  计数按钮组=当前状态可视面,两模式都显示;空 blocks 自身不渲染 */
describe('顶栏动态计数按钮组(两模式常显)', () => {
  it('普通态(默认)渲染 live counters', () => {
    render(<ChatTopbar {...base} />);
    expect(screen.getByRole('group', { name: 'live counters' })).toBeTruthy();
  });
  it('空 blocks 不渲染', () => {
    render(<ChatTopbar {...base} blocks={[]} />);
    expect(screen.queryByRole('group', { name: 'live counters' })).toBeNull();
  });
});
