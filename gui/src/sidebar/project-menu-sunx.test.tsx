import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setLanguage } from '../i18n';
import { SunxSection } from './project-menu-sunx';
import { RecentsSection } from './project-menu-recents';
import type { SessionRow } from '../connection';

// i18n 语言钉:断言走中文文案(pinned-section.test 同款先例)
setLanguage('zh');

/**
 * SUNX 过滤组(sunx P2 Task 7,spec §10+R10):侧栏视图过滤器——按 /sessions 行 kind==='sunx'
 * 聚合、按工作区分节,与工作区组/RECENTS 并存;空组整块不显;组头右侧看板钮(可选 guard——
 * onOpenBoard 未接线不渲染);条目点击=既有 attach 链。附会话行「编辑品性」菜单 gate
 * (仅 sunx 行渲染 ⋯ 钮,standard 行零菜单)。
 */

const FIXED_TS = 1_728_000_000_000;

function sunxRow(id: string, root: string, slug: string, over: Partial<SessionRow> = {}): SessionRow & { root: string; slug: string } {
  return {
    id,
    file: `${id}.jsonl`,
    updatedAt: FIXED_TS,
    firstUser: `sunx 会话 ${id}`,
    kind: 'sunx',
    root,
    slug,
    ...over,
  } as SessionRow & { root: string; slug: string };
}

function renderSection(
  rows: Array<SessionRow & { root: string; slug: string }> | null,
  over: Partial<Parameters<typeof SunxSection>[0]> = {},
) {
  return render(
    <SunxSection
      rows={rows}
      activeSessionId=""
      runningIds={new Set()}
      journalOfSession={new Map()}
      isUnseen={() => false}
      busy={false}
      onAttach={() => undefined}
      onArchiveRow={() => undefined}
      {...over}
    />,
  );
}

describe('SunxSection(侧栏 SUNX 过滤组)', () => {
  it('空组整块不显:rows 空列/装载中(null)都零渲染', () => {
    const empty = renderSection([]);
    expect(empty.container.querySelector('.sx-side-head')).toBeNull();
    empty.unmount();
    const loading = renderSection(null);
    expect(loading.container.querySelector('.sx-side-head')).toBeNull();
  });

  it('组头「SUNX」+按工作区分节(R10):两工作区各一小节头(目录名);行徽标在场', () => {
    const { container } = renderSection([
      sunxRow('j1', 'D:/w/alpha', 'alpha'),
      sunxRow('j2', 'D:/w/beta', 'beta'),
    ]);
    expect(screen.getByText('SUNX')).toBeDefined();
    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.getByText('beta')).toBeDefined();
    expect(container.querySelectorAll('.sx-sunx-badge').length).toBe(2); // SessionRow 徽标复用
    expect(screen.getByText('sunx 会话 j1')).toBeDefined();
    expect(screen.getByText('sunx 会话 j2')).toBeDefined();
  });

  it('条目点击=既有 attach 链(onAttach(root, journalId, updatedAt))', () => {
    const onAttach = vi.fn();
    renderSection([sunxRow('j9', 'D:/w/alpha', 'alpha')], { onAttach });
    fireEvent.click(screen.getByText('sunx 会话 j9'));
    expect(onAttach).toHaveBeenCalledWith('D:/w/alpha', 'j9', FIXED_TS);
  });

  it('组头看板钮:接线(onOpenBoard)时渲染,data-tip 双语无原生 title,点击上抛;未接线不渲染', () => {
    const onOpenBoard = vi.fn();
    const wired = renderSection([sunxRow('j1', 'D:/w/alpha', 'alpha')], { onOpenBoard });
    const btn = screen.getByRole('button', { name: 'sunx board' });
    expect(btn.getAttribute('data-tip')).toBe('Sunx 看板');
    expect(btn.querySelector('title')).toBeNull(); // data-tip 禁原生 title(铁律)
    fireEvent.click(btn);
    expect(onOpenBoard).toHaveBeenCalledTimes(1);
    wired.unmount();
    renderSection([sunxRow('j1', 'D:/w/alpha', 'alpha')]); // 未接线:钮不渲染(guard)
    expect(screen.queryByRole('button', { name: 'sunx board' })).toBeNull();
  });

  it('组头可折叠:点击组头 aria-expanded 翻转(同 PROJECTS/RECENTS 分区头语言)', () => {
    renderSection([sunxRow('j1', 'D:/w/alpha', 'alpha')]);
    const head = screen.getByText('SUNX').closest('.sx-side-head') as HTMLElement;
    expect(head.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
  });
});

/** RecentsSection props 最小装配(NewSunxDialog.test 同款) */
function recentsProps(
  recents: Array<SessionRow & { root: string; slug: string }>,
  onEditCharter?: (row: SessionRow & { root: string }) => void,
): Parameters<typeof RecentsSection>[0] {
  return {
    recentsOpen: true,
    onToggleRecents: () => undefined,
    onNewChat: () => undefined,
    onNewSunx: () => undefined,
    recents,
    recentLimit: 10,
    onShowMore: () => undefined,
    onCollapse: () => undefined,
    activeSessionId: '',
    runningIds: new Set<string>(),
    journalOfSession: new Map<string, string>(),
    isUnseen: () => false,
    busy: false,
    onAttach: () => undefined,
    onArchiveRow: () => undefined,
    pinnedIds: new Set<string>(),
    onPinRow: () => undefined,
    ...(onEditCharter !== undefined ? { onEditCharter } : {}),
  };
}

describe('会话行「编辑品性」菜单 gate(sunx P2 Task 7:仅 kind=sunx 行有行菜单)', () => {
  it('sunx 行渲染 ⋯ 钮,点击出菜单「编辑品性」,选择上抛整行;standard 行零 ⋯ 钮', () => {
    const onEditCharter = vi.fn();
    const row = (id: string, kind?: string) =>
      ({ id, file: `${id}.jsonl`, updatedAt: 1, title: `会话 ${id}`, root: 'D:/w', slug: 'w', ...(kind !== undefined ? { kind } : {}) }) as SessionRow & { root: string; slug: string };
    render(<RecentsSection {...recentsProps([row('j1', 'sunx'), row('j2')], onEditCharter)} />);
    // gate:仅 sunx 行有行菜单钮
    expect(screen.getByRole('button', { name: 'session actions j1' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'session actions j2' })).toBeNull();
    // 打开菜单→菜单项→上抛整行
    fireEvent.click(screen.getByRole('button', { name: 'session actions j1' }));
    const item = screen.getByRole('menuitem', { name: /编辑品性|Edit charter/ });
    fireEvent.click(item);
    expect(onEditCharter).toHaveBeenCalledTimes(1);
    expect((onEditCharter.mock.calls[0]![0] as { id: string }).id).toBe('j1');
  });

  it('宿主未接线 onEditCharter:sunx 行也不渲染 ⋯ 钮(可选 guard)', () => {
    const row = (id: string, kind?: string) =>
      ({ id, file: `${id}.jsonl`, updatedAt: 1, title: `会话 ${id}`, root: 'D:/w', slug: 'w', ...(kind !== undefined ? { kind } : {}) }) as SessionRow & { root: string; slug: string };
    render(<RecentsSection {...recentsProps([row('j1', 'sunx')])} />);
    expect(screen.queryByRole('button', { name: 'session actions j1' })).toBeNull();
  });
});
