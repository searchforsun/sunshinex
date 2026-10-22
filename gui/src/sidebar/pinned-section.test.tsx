import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setLanguage } from '../i18n';
import { PinnedSection } from './pinned-section';
import type { PinEntry } from './pin-store';

// i18n 语言钉:断言走中文 aria 名(setup 缺省 en,归档区测同款先例)
setLanguage('zh');

/** 置顶会话分组组件测(2026-10-21,GUI 专属置顶):「项目」上方不支持折叠分组,无钉不渲染;
 *  行=行首取消置顶(常驻)+标题+时间+行尾归档(确认 morph,点外部取消);行点击上抛打开 */

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
  it('组头「置顶」+行渲染:标题/时间/取消置顶钮/归档钮;空钉不渲染', () => {
    const { container } = renderSection();
    expect(screen.getByText('置顶')).toBeDefined(); // 组头(不支持折叠:无 chevron 无展开态)
    expect(screen.getByText('置顶会话')).toBeDefined();
    expect(screen.getByRole('button', { name: '取消置顶 j1' })).toBeDefined(); // 行首常驻
    expect(screen.getByRole('button', { name: '归档 j1' })).toBeDefined(); // 行尾
    expect(container.querySelectorAll('.sx-side-chev').length).toBe(0); // 无折叠 chevron(不支持折叠;换回可折叠实现即红)
  });

  it('行点击上抛 onOpenSession;取消置顶 stopPropagation 即时上抛', () => {
    const onOpenSession = vi.fn();
    const onUnpin = vi.fn();
    renderSection({ onOpenSession, onUnpin });
    fireEvent.click(screen.getByText('置顶会话'));
    expect(onOpenSession).toHaveBeenCalledWith('D:/w/p1', 'j1', 2);
    fireEvent.click(screen.getByRole('button', { name: '取消置顶 j1' }));
    expect(onUnpin).toHaveBeenCalledWith('j1');
    expect(onOpenSession).toHaveBeenCalledTimes(1); // stopPropagation
  });

  it('行尾归档:确认 morph,点外部取消后归档钮还原', () => {
    const onArchiveRow = vi.fn();
    renderSection({ onArchiveRow });
    fireEvent.click(screen.getByRole('button', { name: '归档 j2' }));
    expect(onArchiveRow).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '确认归档 j2' })).toBeDefined();
    fireEvent.mouseDown(document.body); // 行外点击取消(用户裁定)
    expect(screen.queryByRole('button', { name: '确认归档 j2' })).toBeNull();
    expect(screen.getByRole('button', { name: '归档 j2' })).toBeDefined();
  });

  it('空钉不渲染分组(宿主判空口径一致)', () => {
    const { container } = render(<PinnedSection pins={[]} busy={false} activeSessionId="" runningIds={new Set()} journalOfSession={new Map()} isUnseen={() => false} onOpenSession={() => {}} onUnpin={() => {}} onArchiveRow={() => {}} />);
    expect(container.querySelector('.sx-pin-list')).toBeNull();
  });

  it('已归档钉滤除(2026-10-23 用户裁定):命中行不渲染;全滤除整组不渲染', () => {
    const first = renderSection({ archivedIds: new Set(['j1']) });
    expect(screen.queryByText('置顶会话')).toBeNull(); // j1 已归档 → 整行滤除
    expect(screen.getByText('j2')).toBeDefined(); // 未归档钉照常
    expect(screen.getByRole('button', { name: '取消置顶 j2' })).toBeDefined();
    first.unmount();
    const second = renderSection({ archivedIds: new Set(['j1', 'j2']) });
    expect(second.container.querySelector('.sx-pin-list')).toBeNull(); // 全滤除 → 整组不渲染
  });
});
