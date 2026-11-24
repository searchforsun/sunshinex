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

/** 2026-11-25 用户裁定「归档 sunx 怎么会存在?只留归档会话」:顶栏「归档 Sunx/取消归档 Sunx」
 *  菜单项退役(手建 Sunx 归档唯一入口=侧栏 SUNX 组头归档层;通道会话走 归档会话)。本文件钉
 *  退役面:sunx 菜单零归档项+确认弹窗文案统一「确认归档」(随域变体文案随项一并退役)。 */
describe('ChatTopbar 归档 Sunx 项退役(2026-11-25)', () => {
  it('sunx 菜单零「归档 Sunx/取消归档 Sunx」项(归档唯一入口=SUNX 组头归档层)', () => {
    const onArchive = vi.fn();
    render(<ChatTopbar {...base} onArchive={onArchive} />);
    openSessionMenu();
    expect(screen.queryByRole('menuitem', { name: '归档 Sunx' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '取消归档 Sunx' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '确认归档 Sunx' })).toBeNull();
  });
  it('确认文案统一「确认归档」:标准会话归档向仍弹确认(随域变体随项退役)', () => {
    render(<ChatTopbar {...base} sessionKind={undefined} />);
    openSessionMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '归档会话' }));
    expect(screen.getByRole('menuitem', { name: '确认归档' })).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: '确认归档 Sunx' })).toBeNull();
  });
});
