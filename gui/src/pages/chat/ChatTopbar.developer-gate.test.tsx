import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatTopbar } from './ChatTopbar';
import { applyDeveloperMode } from '../../developer-mode';
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

afterEach(() => applyDeveloperMode(false));

describe('顶栏动态计数按钮组(2026-11-17 裁定:普通态收起)', () => {
  it('普通态不渲染 live counters', () => {
    render(<ChatTopbar {...base} />);
    expect(screen.queryByRole('group', { name: 'live counters' })).toBeNull();
  });
  it('开发者模式照常渲染', () => {
    applyDeveloperMode(true);
    render(<ChatTopbar {...base} />);
    expect(screen.getByRole('group', { name: 'live counters' })).toBeTruthy();
  });
});
