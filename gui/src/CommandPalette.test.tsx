import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandPalette, filterCommands } from './CommandPalette';

const CMDS = ['/help', '/status', '/compact', '/context', '/plan', '/tasks'];
const DESC: Record<string, string> = { status: 'session summary', compact: 'compress', plan: 'plan first' };
const SUPPORTED = ['/status', '/compact', '/plan'];

describe('filterCommands 命令过滤(G10-C4)', () => {
  it('前缀优先于包含:c → 前缀组(compact/context)在前;status 无 c 不入', () => {
    const items = filterCommands(CMDS, DESC, 'c', SUPPORTED);
    expect(items.map((x) => x.cmd)).toEqual(['/compact']); // G14.160 context 不在 supported 已滤
  });
  it('G14.160 集外命令整体不展示(原置灰改为不列)', () => {
    expect(filterCommands(CMDS, DESC, '', SUPPORTED).map((x) => x.cmd)).toEqual([
      '/status', '/compact', '/plan',
    ]);
  });
  it('无匹配:空列表', () => {
    expect(filterCommands(CMDS, DESC, 'zzz', SUPPORTED)).toEqual([]);
  });
});

describe('CommandPalette 渲染(G10-C4)', () => {
  const items = filterCommands(CMDS, DESC, '', SUPPORTED);

  it('命令+描述渲染;G14.160 无 disabled 类(不可用命令已不列);已知命令描述走双语表(2026-11-11 GUI 语言权威,daemon 文本仅 unknown 回落)', () => {
    render(<CommandPalette items={items} active={0} onHover={() => {}} onPick={() => {}} />);
    expect(screen.getByText('/status')).toBeDefined();
    // 测试钉 en → status 命中 CMD_DESC 双语表 en 面(daemon desc 'session summary' 不再穿透)
    expect(screen.getByText('Session and ledger summary')).toBeDefined();
    expect(document.querySelectorAll('.cmd-item.disabled').length).toBe(0);
  });

  it('点选 ok 项回调 onPick', () => {
    const onPick = vi.fn();
    render(<CommandPalette items={items} active={0} onHover={() => {}} onPick={onPick} />);
    fireEvent.click(screen.getByRole('option', { name: /^\/status/ }));
    expect(onPick).toHaveBeenCalledWith(items.find((x) => x.cmd === '/status'));
  });
});
