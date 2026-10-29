import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SkillsPane } from '../SkillsPane';
import type { SkillsPaneConn } from '../SkillsPane';
import type { SettingsScope } from '../components';
import type { SkillsGroup } from '../../connection';

/**
 * Task 25 SkillsPane 遮蔽标注桩测:conn 全桩(skillsGroups 单面,不出网),用例沿 task brief——
 * ①遮蔽标注渲染+gating(行带 shadowedBy 字段 → 卡灰显+「被 <来源> 同名技能遮蔽」角标+sourceDir
 *   tip;无字段卡零角标零灰显——gating 契约沿 T23);②跨组同 id 去重保持(先者胜),shadowedBy
 *   随保留行透出;③refreshTick 变化触发重拉;④工具栏作用域下拉入页(2026-10-29 三件套:
 *   只读面=下拉+搜索无添加钮;切换只上抛不重拉——scope=all 全量视图不随壳作用域收窄)。
 * 测试基准语言钉 en(test-setup G14.104),断言单语 en。
 */

type SkillsRow = SkillsGroup['skills'][number];

/** 行构造器:daemon GET /settings/skills 应答行的合法缺省,逐例覆写差面 */
const row = (id: string, over: Partial<SkillsRow> = {}): SkillsRow => ({ id, ...over });

/** conn 桩:skillsGroups 调用记录([root 归一 '', all]);首答 initial,重拉答 next */
const connOf = (initial: SkillsGroup[], opts: { next?: SkillsGroup[] } = {}): { conn: SkillsPaneConn; calls: Array<[string, boolean]> } => {
  const calls: Array<[string, boolean]> = [];
  let n = 0;
  return {
    conn: {
      skillsGroups(root?: string, all?: boolean) {
        calls.push([root ?? '', all === true]);
        return Promise.resolve({ groups: n++ === 0 || opts.next === undefined ? initial : opts.next });
      },
    },
    calls,
  };
};

describe('SkillsPane(遮蔽标注)', () => {
  it('遮蔽标注:行带 shadowedBy → 卡灰显+角标+sourceDir tip;无字段卡零角标零灰显(gating 契约);跨组同 id 去重保持(先者胜)', async () => {
    // user 行 alpha 带 shadowedBy(current root 链上被同名 project 技能遮蔽);project 组同名 alpha
    // 被去重滤除(先者=user 行胜)——保留行透出遮蔽标注;无字段行 solo 恒素卡
    const { conn, calls } = connOf([
      { source: 'user', skills: [row('alpha', { name: 'Alpha User', shadowedBy: 'project', sourceDir: '/u/.sunshinex/skills/alpha' })] },
      { source: 'project', project: 'proj', skills: [row('alpha', { name: 'Alpha Native' }), row('solo', { name: 'Solo' })] },
    ]);
    const { container } = render(<SkillsPane conn={conn} root="/w/proj" title="Skills" />);
    expect(await screen.findByText('alpha')).toBeDefined();
    expect(calls[0]).toEqual(['/w/proj', true]); // scope=all 跨项目视图保持
    // 跨组同 id 去重:仅 user 行一张卡(先者胜),且它携带遮蔽标注
    expect(screen.getAllByText('alpha')).toHaveLength(1);
    const shadowed = container.querySelectorAll('.sx-skill-card.shadowed');
    expect(shadowed).toHaveLength(1);
    expect(shadowed[0].textContent).toContain('alpha');
    expect(screen.getByText('Shadowed by project skill')).toBeDefined(); // 角标(字段在场才渲染)
    // gating:无 shadowedBy 字段的卡零角标零灰显
    expect(screen.queryByText('Shadowed by user skill')).toBeNull();
    const soloCard = container.querySelectorAll('.sx-skill-card')[1];
    expect(soloCard.className).not.toContain('shadowed');
    // sourceDir 悬停 tip 随富化行透出;无字段行无 tip
    expect(screen.getByText('alpha').getAttribute('data-tip')).toBe('/u/.sunshinex/skills/alpha');
    expect(screen.getByText('solo').getAttribute('data-tip')).toBeNull();
  });

  it('refreshTick 变化触发重拉(config-changed 外部改动信号)', async () => {
    const { conn, calls } = connOf([{ source: 'user', skills: [row('alpha')] }]);
    const { rerender } = render(<SkillsPane conn={conn} root="/w/proj" title="Skills" refreshTick={0} />);
    await screen.findByText('alpha');
    expect(calls).toEqual([['/w/proj', true]]);
    rerender(<SkillsPane conn={conn} root="/w/proj" title="Skills" refreshTick={1} />);
    await waitFor(() => expect(calls).toEqual([['/w/proj', true], ['/w/proj', true]]));
  });

  it('工具栏作用域下拉入页(2026-10-29 三件套,只读面无添加钮):切换只上抛 onScopeChange,不重拉(scope=all 全量视图不随壳作用域收窄)', async () => {
    const { conn, calls } = connOf([{ source: 'user', skills: [row('alpha')] }]);
    const scopes: SettingsScope[] = [];
    render(<SkillsPane conn={conn} root="/w/proj" title="Skills" scope="project" onScopeChange={(s) => scopes.push(s)} />);
    await screen.findByText('alpha');
    expect(screen.queryByRole('button', { name: '+ Add' })).toBeNull(); // 只读面:无添加钮
    expect(screen.getByLabelText('Search')).toBeDefined(); // 搜索入工具栏(SearchBar 统一入口)
    expect(screen.getByRole('button', { name: 'Settings scope' }).textContent).toContain('This project');
    fireEvent.click(screen.getByRole('button', { name: 'Settings scope' }));
    fireEvent.click(screen.getByRole('option', { name: 'Global' }));
    expect(scopes).toEqual(['global']); // 只上抛(状态留壳层)
    expect(calls).toEqual([['/w/proj', true]]); // 不随壳作用域重拉(全量视图裁定)
  });
});
