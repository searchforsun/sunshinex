import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setLanguage } from '../i18n';
import { ArchiveSection, type ArchivedRow } from './archive-group';

// i18n 语言钉:断言走中文 aria 名(setup 缺省 en,T6 Archived.test 同款先例)
setLanguage('zh');

/** 归档会话层组件测(2026-10-21 用户裁定:归档层整替侧栏下侧,无独立分组头——组头由
 *  ProjectsSection 归档模式承载「归档会话」+X):行=标题(无题回落 id)+来源 slug 两行式;
 *  hover 动作 [撤销归档][红删除→「确认」morph];行点击上抛 onOpenSession;动作钮 stopPropagation */

const rows: ArchivedRow[] = [
  { id: 'a1', slug: 'p1', root: 'D:/w/p1', title: '已归档会话', updatedAt: 2, archivedAt: 20 },
  { id: 'a2', slug: 'p2', root: 'D:/w/p2', updatedAt: 1, archivedAt: 10 },
];

function renderSection(over: Partial<Parameters<typeof ArchiveSection>[0]> = {}): void {
  render(
    <ArchiveSection
      rows={rows}
      busy={false}
      onOpenSession={() => {}}
      onUnarchive={() => {}}
      onDelete={() => {}}
      {...over}
    />,
  );
}

describe('ArchiveSection 归档会话层(侧栏整替面)', () => {
  it('行渲染:标题+末次活动时间 / 来源项目(目录名 basename);加载中/空态占位', () => {
    renderSection();
    expect(screen.getByText('已归档会话')).toBeDefined();
    expect(document.querySelector('.sx-archive-time')?.textContent).not.toBe(''); // 末次活动时间格
    expect(screen.getByText('p1')).toBeDefined(); // root basename(用户裁定「项目使用文件名」)
    expect(screen.getByText('a2')).toBeDefined(); // 无题回落 id
    expect(screen.getByText('p2')).toBeDefined();
  });

  it('尾部分页:默认 10 条上限+「显示更多」步进放行,放完钮消失', () => {
    const many: ArchivedRow[] = Array.from({ length: 12 }, (_, i) => ({
      id: `k${i}`, slug: 'p1', root: 'D:/w/p1', title: `归档 ${i}`, updatedAt: 1000 - i, archivedAt: 1000 - i,
    }));
    renderSection({ rows: many });
    expect(screen.getByText('归档 0')).toBeDefined();
    expect(screen.getByText('归档 9')).toBeDefined();
    expect(screen.queryByText('归档 10')).toBeNull(); // 上限 10
    expect(screen.getByRole('button', { name: '显示更多' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '显示更多' }));
    expect(screen.getByText('归档 11')).toBeDefined(); // 步进 10 全放行
    expect(screen.queryByRole('button', { name: '显示更多' })).toBeNull();
  });

  it('行点击上抛 onOpenSession(root, journalId, updatedAt);动作钮 stopPropagation 不触发', () => {
    const onOpenSession = vi.fn();
    const onUnarchive = vi.fn();
    renderSection({ onOpenSession, onUnarchive });
    fireEvent.click(screen.getByText('已归档会话'));
    expect(onOpenSession).toHaveBeenCalledWith('D:/w/p1', 'a1', 2);
    fireEvent.click(screen.getByRole('button', { name: '撤销归档 a1' }));
    expect(onUnarchive).toHaveBeenCalledWith('a1');
    expect(onOpenSession).toHaveBeenCalledTimes(1); // stopPropagation
  });

  it('红删除行内「确认」morph 后才 onDelete;点外部(mousedown 于行外)取消确认', () => {
    const onDelete = vi.fn();
    renderSection({ onDelete });
    fireEvent.click(screen.getByRole('button', { name: '删除 a2' }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '确认删除 a2' })).toBeDefined();
    fireEvent.mouseDown(document.body); // 行外点击:取消确认(用户裁定),还原删除钮
    expect(screen.queryByRole('button', { name: '确认删除 a2' })).toBeNull();
    expect(screen.getByRole('button', { name: '删除 a2' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '删除 a2' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除 a2' })); // 行内「确认」本体不受外部取消影响
    expect(onDelete).toHaveBeenCalledWith('a2');
  });

  it('加载中(rows=null)与空态(rows=[])占位', () => {
    const { rerender } = render(<ArchiveSection rows={null} busy={false} onOpenSession={() => {}} onUnarchive={() => {}} onDelete={() => {}} />);
    expect(screen.getByText('加载中…')).toBeDefined();
    rerender(<ArchiveSection rows={[]} busy={false} onOpenSession={() => {}} onUnarchive={() => {}} onDelete={() => {}} />);
    expect(screen.getByText('暂无归档会话')).toBeDefined();
  });
});
