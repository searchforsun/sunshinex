import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { setLanguage } from '../i18n';
import { PinnedSection } from './pinned-section';
import type { PinEntry } from './pin-store';

// i18n 语言钉:断言走中文 aria 名(setup 缺省 en,归档区测同款先例)
setLanguage('zh');

/** 置顶会话分组组件测(2026-10-22 ⋯ 菜单形态):「项目」上方不支持折叠分组,无钉不渲染;
 *  行=状态点+标题+时间+行尾 ⋯ 钮(hover 显形);⋯ 弹快捷菜单(取消置顶/归档会话,直执行);
 *  行点击上抛打开 */

const pins: PinEntry[] = [
  { id: 'j1', root: 'D:/w/p1', title: '置顶会话', updatedAt: 2 },
  { id: 'j2', root: 'D:/w/p2', title: 'j2', updatedAt: 1 },
];

function renderSection(over: Partial<Parameters<typeof PinnedSection>[0]> = {}) {
  return render(
    <PinnedSection
      pins={pins}
      busy={false}
      activeSessionId=""
      runningIds={new Set()}
      journalOfSession={new Map()}
      isUnseen={() => false}
      onOpenSession={() => {}}
      onUnpin={() => {}}
      onArchiveRow={() => {}}
      {...over}
    />,
  );
}

describe('PinnedSection 置顶分组(GUI 专属)', () => {
  it('组头「置顶」+行渲染:标题/时间/⋯ 钮;空钉不渲染', () => {
    const { container } = renderSection();
    expect(screen.getByText('置顶')).toBeDefined(); // 组头(不支持折叠:无 chevron 无展开态)
    expect(screen.getByText('置顶会话')).toBeDefined();
    expect((container.querySelector('.sx-pin-time') || { textContent: '' }).textContent !== '').toBe(true); // 时间列在
    expect(screen.getByRole('button', { name: '更多操作 j1' })).toBeDefined(); // ⋯ 钮
    expect(container.querySelectorAll('.sx-side-chev').length).toBe(0); // 无折叠 chevron(不支持折叠;换回可折叠实现即红)
  });

  it('行点击上抛 onOpenSession;⋯ 菜单取消置顶 stopPropagation 即时上抛', () => {
    const onOpenSession = vi.fn();
    const onUnpin = vi.fn();
    renderSection({ onOpenSession, onUnpin });
    fireEvent.click(screen.getByText('置顶会话'));
    expect(onOpenSession).toHaveBeenCalledWith('D:/w/p1', 'j1', 2);
    fireEvent.click(screen.getByRole('button', { name: '更多操作 j1' }));
    const menu = screen.getByRole('menu');
    fireEvent.click(within(menu).getByText('取消置顶'));
    expect(onUnpin).toHaveBeenCalledWith('j1');
    expect(onOpenSession).toHaveBeenCalledTimes(1); // stopPropagation
  });

  it('⋯ 菜单:归档会话项上抛 onArchiveRow(j2, true)', () => {
    const onArchiveRow = vi.fn();
    renderSection({ onArchiveRow });
    fireEvent.click(screen.getByRole('button', { name: '更多操作 j2' }));
    fireEvent.click(within(screen.getByRole('menu')).getByText('归档会话'));
    expect(onArchiveRow).toHaveBeenCalledWith('j2', true);
  });

  it('空钉不渲染分组(宿主判空口径一致)', () => {
    const { container } = render(<PinnedSection pins={[]} busy={false} activeSessionId="" runningIds={new Set()} journalOfSession={new Map()} isUnseen={() => false} onOpenSession={() => {}} onUnpin={() => {}} onArchiveRow={() => {}} />);
    expect(container.querySelector('.sx-pin-list')).toBeNull();
  });
});
