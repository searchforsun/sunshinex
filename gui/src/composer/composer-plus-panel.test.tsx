import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ComposerPlusPanel } from './ComposerPlusPanel';
import { applyDeveloperMode } from '../developer-mode';

const conn = {
  commands: () => Promise.resolve({ commands: ['/help'], descriptions: {}, supported: ['/help'] }),
  skillsGroups: () => Promise.resolve({ groups: [] }),
  tree: () => Promise.resolve({ entries: [] }),
} as unknown as Parameters<typeof ComposerPlusPanel>[0]['conn'];

describe('+ 面板分区收起(普通态)', () => {
  it('普通态命令分区收起,点「浏览命令与技能」展开', async () => {
    applyDeveloperMode(false);
    render(<ComposerPlusPanel conn={conn} onInsert={vi.fn()} />);
    expect(await screen.findByText('Browse commands & skills')).toBeDefined();
    expect(screen.queryByText('Commands')).toBeNull();
    fireEvent.click(screen.getByText('Browse commands & skills'));
    expect(await screen.findByText('Commands')).toBeDefined();
  });
  it('开发者模式全展开', async () => {
    applyDeveloperMode(true);
    render(<ComposerPlusPanel conn={conn} onInsert={vi.fn()} />);
    expect(await screen.findByText('Commands')).toBeDefined();
    applyDeveloperMode(false);
  });
  it('extraCommands 把群聊专用控制命令补入命令区', async () => {
    applyDeveloperMode(true);
    render(<ComposerPlusPanel conn={conn} onInsert={vi.fn()} extraCommands={['/stop', '/clear', '/continue']} />);
    expect(await screen.findByText('/stop')).toBeDefined();
    expect(screen.getByText('/clear')).toBeDefined();
    expect(screen.getByText('/continue')).toBeDefined();
    applyDeveloperMode(false);
  });
});
