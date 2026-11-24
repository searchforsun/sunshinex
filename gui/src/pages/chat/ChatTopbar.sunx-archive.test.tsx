import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatTopbar } from './ChatTopbar';
import { SESSION_KIND_SUNX, type Connection } from '../../connection';
import { setLanguage } from '../../i18n';

// i18n 语言钉:断言走中文文案(project-menu-sunx.test 同款先例)
setLanguage('zh');

const conn = {} as Connection;
const base = {
  fixedTitle: 'demo sunx',
  titleEditing: false,
  titleDraft: '',
  setTitleDraft: () => undefined,
  commitTitle: () => undefined,
  setTitleEditing: () => undefined,
  displayTitle: 'demo sunx',
  sessionId: 's1',
  tokens: 0,
  steps: 0,
  running: false,
  conn,
  archived: false,
  onArchive: () => undefined,
  sessionKind: SESSION_KIND_SUNX,
};

function openSessionMenu(): void {
  fireEvent.click(screen.getByRole('button', { name: '会话操作' }));
}

/** 2026-11-24 用户实测三联修:①「归档怎么没有二次确认」——sunx-archive 菜单项对齐标准
 *  归档会话 askArchive 流(归档向先弹确认,撤销向直执行);确认文案随域=确认归档 Sunx。
 *  (「归档后没有生效/归档层找不到」两端在 ProjectMenu 事件联动+SunxSection 渲染面滤行,彼处有钉) */
describe('ChatTopbar 归档 Sunx 二次确认', () => {
  it('归档向:菜单点「归档 Sunx」不直执行,弹「确认归档 Sunx」;确认才 onArchive(true)', () => {
    const onArchive = vi.fn();
    render(<ChatTopbar {...base} onArchive={onArchive} />);
    openSessionMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '归档 Sunx' }));
    expect(onArchive).not.toHaveBeenCalled(); // 确认前零落库
    fireEvent.click(screen.getByRole('menuitem', { name: '确认归档 Sunx' }));
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onArchive).toHaveBeenCalledWith(true);
  });
  it('取消归档直执行(与标准归档会话同口径):archived 态点「取消归档 Sunx」即 onArchive(false),无确认弹窗', () => {
    const onArchive = vi.fn();
    render(<ChatTopbar {...base} archived onArchive={onArchive} />);
    openSessionMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '取消归档 Sunx' }));
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onArchive).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('menuitem', { name: '确认归档 Sunx' })).toBeNull();
  });
  it('确认文案随域:标准会话仍「确认归档」(与 sunx 变体区分)', () => {
    render(<ChatTopbar {...base} sessionKind={undefined} />);
    openSessionMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '归档会话' }));
    expect(screen.getByRole('menuitem', { name: '确认归档' })).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: '确认归档 Sunx' })).toBeNull();
  });
});
