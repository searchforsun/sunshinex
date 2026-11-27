import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setLanguage } from '../i18n';
import { SunxSection } from './project-menu-sunx';
import { RecentsSection } from './project-menu-recents';
import type { SessionRow } from '../connection';

// i18n 语言钉:断言走中文文案(pinned-section.test 同款先例)
setLanguage('zh');

/**
 * SUNX 过滤组(sunx P2 Task 7,spec §10;2026-11-15 用户实测裁定改版):平铺单列——工作区分节头
 * 退役(「sunshinex-default」根标签行去掉),行布局与最近会话完全同款(recent-list/SessionRow,
 * 左对齐含状态图标);kind 徽标与会话行 ⋯「会话操作」菜单退役;空组常驻(组头+「暂无Sunx」);
 * 组头动作簇(数量/看板/排序/归档/新建,可选 guard);条目点击=attachSunx 链。
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

describe('SunxSection(侧栏 SUNX 过滤组;2026-11-15 平铺改版)', () => {
  it('SUNX 分组常驻(2026-11-15 用户裁定):rows 空列=组头+「暂无Sunx」空态行;装载中(null)瞬态零渲染', () => {
    const empty = renderSection([]);
    expect(empty.container.querySelector('.sx-side-head')).not.toBeNull(); // 组头恒显
    expect(screen.getByText('暂无Sunx')).toBeDefined(); // 空态行(recents no-sessions 同款)
    empty.unmount();
    const loading = renderSection(null);
    expect(loading.container.querySelector('.sx-side-head')).not.toBeNull(); // 装载中瞬态不闪占位
    expect(loading.container.querySelector('.no-sessions')).toBeNull();
  });

  it('平铺单列(2026-11-15 用户裁定:工作区分节头退役):两工作区行同列直出,零根标签行/零 Sunx 徽标', () => {
    const { container } = renderSection([
      sunxRow('j1', 'D:/w/alpha', 'alpha'),
      sunxRow('j2', 'C:/Users/x/AppData/Local/Temp/sunshinex-default', 'ws-sunshinex-default'),
    ]);
    expect(screen.getByText('SUNX')).toBeDefined();
    // 分节头退役:工作区名(basename)不再作为行间标签出现
    expect(screen.queryByText('alpha')).toBeNull();
    expect(screen.queryByText('sunshinex-default')).toBeNull();
    expect(container.querySelector('.sx-sunx-ws')).toBeNull(); // 旧分节头类名零残留
    // 行布局与通道/项目组同款:workspace 组行 + 组内 session-list/SessionRow;Sunx 徽标退役
    expect(container.querySelectorAll('.session-list .session-row').length).toBe(2);
    expect(container.querySelectorAll('.sx-sunx-badge').length).toBe(0);
    expect(screen.getByText('sunx 会话 j1')).toBeDefined();
    expect(screen.getByText('sunx 会话 j2')).toBeDefined();
  });

  it('群组行=通道组同构（2026-11-26 样式重做）：workspace-item/row、16px 群图标、> 贴群名右侧、动作簇在行尾', () => {
    const { container } = renderSection([sunxRow('j1', 'D:/w/alpha', 'alpha', { groupId: 'grp_a' })], {
      groups: [{ id: 'grp_a', name: '研发群' }],
      onOpenGroupChat: () => undefined,
      onNewSunxInGroup: () => undefined,
    });
    const item = container.querySelector('.workspace-item')!;
    expect(item.querySelector('.workspace-row')).not.toBeNull();
    const head = item.querySelector('.workspace-row > .workspace-toggle.sx-sunx-group-head')!;
    expect(head.querySelector('.sx-ws-folder svg')?.getAttribute('width')).toBe('16'); // 与项目/通道组图标同尺寸
    expect(head.querySelector('.ws-slug.sx-ws-name')?.textContent).toBe('研发群');
    const last = head.lastElementChild as HTMLElement; // > 在群名右侧（名称不定长，箭头贴名）
    expect(last.classList.contains('sx-side-chev')).toBe(true);
    expect(item.querySelector('.workspace-row > .ws-row-actions [aria-label="open group chat"]')).not.toBeNull();
    expect(item.querySelector('.workspace-row > .ws-row-actions [aria-label="new sunx in group"]')).not.toBeNull();
    // 群内会话仍在标准 session-list 中（与项目/通道组行同件）
    expect(item.querySelector('.sx-collapse .session-list .session-row')).not.toBeNull();
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

  it('排序钮 tooltip 走 i18n(2026-11-20 用户实测「排序不是 i18n」):data-tip=Sunx 排序,aria-label 留英文测试钩子', () => {
    const { container } = renderSection([sunxRow('j1', 'D:/w/alpha', 'alpha')]);
    const btn = container.querySelector('button[aria-label="sort sunx"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('data-tip')).toBe('Sunx 排序');
  });

  it('组头可折叠:点击组头 aria-expanded 翻转(同 PROJECTS/RECENTS 分区头语言)', () => {
    renderSection([sunxRow('j1', 'D:/w/alpha', 'alpha')]);
    const head = screen.getByText('SUNX').closest('.sx-side-head') as HTMLElement;
    expect(head.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
  });
});

/** 2026-11-24 用户实测「归档后直接在归档sunx中找不到了」根修:归档滤行从 useMenuSunx 移到本
 *  渲染面——行集与「归档 Sunx」层共源(ProjectMenu archiveRows sunx 分支取 archived===true),
 *  hook 层滤行=归档层断源恒「暂无归档 Sunx」。本组钉死:分组/计数只显未归档,归档行留行集 */
describe('归档行滤除(分组面)', () => {
  it('archived 行不进分组、不进计数 chip;未归档行原样', () => {
    const { container } = renderSection([
      sunxRow('j1', 'D:/w/alpha', 'alpha'),
      sunxRow('j2', 'D:/w/alpha', 'alpha', { archived: true }),
    ]);
    expect(screen.queryByText('sunx 会话 j2')).toBeNull(); // 归档行不出行
    expect(screen.getByText('sunx 会话 j1')).toBeDefined();
    expect(container.querySelectorAll('.session-list .session-row').length).toBe(1);
    const count = container.querySelector('.sx-sunx-count');
    expect(count?.textContent).toBe('1'); // 计数 chip 滤后口径
  });
  it('全组已归档=空态行「暂无Sunx」(行集仍有数据,归档层取数不断供)', () => {
    const { container } = renderSection([sunxRow('j2', 'D:/w/alpha', 'alpha', { archived: true })]);
    expect(screen.getByText('暂无Sunx')).toBeDefined();
    expect(container.querySelectorAll('.session-list .session-row').length).toBe(0);
    const count = container.querySelector('.sx-sunx-count');
    expect(count?.textContent).toBe('0');
  });
});

/** RecentsSection props 最小装配(NewSunxDialog.test 同款) */
function recentsProps(
  recents: Array<SessionRow & { root: string; slug: string }>,
): Parameters<typeof RecentsSection>[0] {
  return {
    recentsOpen: true,
    onToggleRecents: () => undefined,
    onNewChat: () => undefined,
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
  };
}

describe('会话行退役面(2026-11-15 用户裁定「Sunx 标签去掉」「会话操作这个入口应该去掉」)', () => {
  it('sunx 行与 standard 行同款:零 ⋯ 会话操作钮、零 Sunx 徽标(编辑 Sunx 唯一入口=顶栏菜单)', () => {
    const row = (id: string, kind?: string) =>
      ({ id, file: `${id}.jsonl`, updatedAt: 1, title: `会话 ${id}`, root: 'D:/w', slug: 'w', ...(kind !== undefined ? { kind } : {}) }) as SessionRow & { root: string; slug: string };
    const { container } = render(<RecentsSection {...recentsProps([row('j1', 'sunx'), row('j2')])} />);
    expect(screen.queryByRole('button', { name: 'session actions j1' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'session actions j2' })).toBeNull();
    expect(container.querySelectorAll('.sx-sunx-badge').length).toBe(0);
    // 归档确认 morph 钮仍在(行内唯一动作,与最近会话行同款)
    expect(screen.getAllByRole('button', { name: /^归档 / }).length).toBe(2);
  });
});
