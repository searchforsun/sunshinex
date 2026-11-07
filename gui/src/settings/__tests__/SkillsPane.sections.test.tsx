import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SkillsPane } from '../SkillsPane';
import type { SkillsPaneConn } from '../SkillsPane';
import type { SkillsGroup, SettingsView } from '../../connection';

/** 分节展示桩测(2026-11-07 用户裁定「用不同的开头分组分开展示」):project/user/learned 各成节,
 *  节头=来源标签(+项目名)+条数;节序 project→user→learned;'all' 视图同 id 跨项目两节并存 */

type SkillsRow = SkillsGroup['skills'][number];
const row = (id: string, over: Partial<SkillsRow> = {}): SkillsRow => ({ id, ...over });

const connOf = (groups: SkillsGroup[]): SkillsPaneConn => ({
  skillsGroups: () => Promise.resolve({ groups }),
  settings: () =>
    Promise.resolve({
      keys: [{ key: 'disabledSkills', value: null, source: 'default', envOverride: false }],
    } as unknown as SettingsView),
  putSettings: () => Promise.resolve(),
});

describe('SkillsPane 分节展示', () => {
  it('多来源分组成节:节头标签+条数,节序 project→user→learned;跨项目同名各节并存', async () => {
    const { container } = render(
      <SkillsPane
        conn={connOf([
          { source: 'user', skills: [row('g-skill', { sourceDir: '/u/skills/g-skill' })] },
          { source: 'project', project: 'proj-a', skills: [row('test-skill', { sourceDir: '/a/.sunshinex/skills/test-skill' }), row('only-a', { sourceDir: '/a/.sunshinex/skills/only-a' })] },
          { source: 'project', project: 'proj-b', skills: [row('test-skill', { sourceDir: '/b/.sunshinex/skills/test-skill' })] },
          { source: 'learned', project: 'proj-a', skills: [row('learned-settle', { sourceDir: '/a/.data/skills/learned-settle' })] },
        ])}
        root="/w/proj"
        title="Skills"
      />,
    );
    await screen.findAllByText('test-skill'); // 清单落定后再数节头(findAllBy* 匹配一个即返回,会抢在异步前)
    const heads = screen.getAllByRole('heading').filter((h) => h.tagName === 'H3');
    expect(heads.map((h) => h.textContent)).toEqual([
      'Project · proj-a2 skills', // textContent=标签+条数 span 拼接
      'Project · proj-b1 skills',
      'Global1 skills',
      'Learned · proj-a1 skills',
    ]);
    // 项目节与学习节同项目名各一节(jsdom region 角色检索不可靠,按节类名计数)
    expect(container.querySelectorAll('.sx-skill-section')).toHaveLength(4);
  });

  it('搜索/来源过滤后空节不渲染', async () => {
    render(
      <SkillsPane
        conn={connOf([
          { source: 'user', skills: [row('alpha', { description: 'Alpha', sourceDir: '/u/skills/alpha' })] },
          { source: 'learned', skills: [row('beta', { description: 'Beta', sourceDir: '/l/skills/beta' })] },
        ])}
        root="/w/proj"
        title="Skills"
      />,
    );
    await screen.findAllByText('alpha');
    expect(screen.getByText('Global')).toBeDefined();
    expect(screen.getByText('Learned')).toBeDefined();
    // 按 id 搜 beta:alpha 所在 Global 节无匹配 → 整节消失
    const search = screen.getByLabelText('Search');
    fireEvent.change(search, { target: { value: 'beta' } });
    await waitFor(() => expect(screen.queryByText('Global')).toBeNull()); // 搜索 200ms 防抖后重滤,空节消失
    expect(screen.getByText('Learned')).toBeDefined();
  });
});
