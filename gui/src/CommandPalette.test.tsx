import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandPalette, filterCommands } from './CommandPalette';

const CMDS = ['/help', '/status', '/compact', '/context', '/plan', '/tasks'];
const DESC: Record<string, string> = { status: 'session summary', compact: 'compress', plan: 'plan first' };
const SUPPORTED = ['/status', '/compact', '/plan'];

describe('filterCommands 命令过滤(G10-C4)', () => {
  it('前缀优先于包含:c → 前缀组(compact/context)在前;status 无 c 不入', () => {
    const items = filterCommands(CMDS, DESC, 'c', SUPPORTED);
    expect(items.map((x) => x.cmd)).toEqual(['/compact', '/context']);
  });
  it('ok 标记随 supported 集(集外置灰)', () => {
    const items = filterCommands(CMDS, DESC, '', SUPPORTED);
    const byCmd = Object.fromEntries(items.map((x) => [x.cmd, x]));
    expect(byCmd['/status']!.ok).toBe(true);
    expect(byCmd['/help']!.ok).toBe(false);
    expect(byCmd['/tasks']!.ok).toBe(false);
  });
  it('无匹配:空列表', () => {
    expect(filterCommands(CMDS, DESC, 'zzz', SUPPORTED)).toEqual([]);
  });
});

describe('CommandPalette 渲染(G10-C4)', () => {
  const items = filterCommands(CMDS, DESC, '', SUPPORTED);

  it('命令+描述渲染;集外项 disabled 类', () => {
    render(<CommandPalette items={items} active={0} onHover={() => {}} onPick={() => {}} />);
    expect(screen.getByText('/status')).toBeDefined();
    expect(screen.getByText('session summary')).toBeDefined();
    expect(screen.getByRole('option', { name: /^\/help/ }).className).toContain('disabled');
  });

  it('点选 ok 项回调 onPick;置灰项不回调', () => {
    const onPick = vi.fn();
    render(<CommandPalette items={items} active={0} onHover={() => {}} onPick={onPick} />);
    fireEvent.click(screen.getByRole('option', { name: /^\/status/ }));
    expect(onPick).toHaveBeenCalledWith(items.find((x) => x.cmd === '/status'));
    fireEvent.click(screen.getByRole('option', { name: /^\/help/ }));
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});
