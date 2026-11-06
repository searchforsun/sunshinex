import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SkillsPane } from '../SkillsPane';
import type { SkillsPaneConn } from '../SkillsPane';
import type { SkillsGroup } from '../../connection';

/**
 * Task 25 SkillsPane 遮蔽标注桩测:conn 全桩(skillsGroups 单面,不出网),用例沿 task brief——
 * ①遮蔽标注渲染+gating(行带 shadowedBy 字段 → 卡灰显+「被 <来源> 同名技能遮蔽」角标+sourceDir
 *   tip;无字段卡零角标零灰显——gating 契约沿 T23);②跨组同 id 去重保持(先者胜),shadowedBy
 *   随保留行透出;③refreshTick 变化触发重拉;④工具栏合并项目下拉(2026-10-29 用户裁定:原
 *   「作用域下拉+项目筛选」语义重复合并为一个,提到最前——选项=全部项目|全局|注册项目;
 *   'all'(缺省)走 scope=all 数据路径且壳层不上抛(壳不下发 root,pane 自持拉取);全局/项目
 *   两态上抛同步壳 targetRoot 并按对应目标重拉;原独立项目筛选 Select 不再渲染;下拉定宽
 *   sx-dd-fixed——2026-10-29 用户裁定)。
 * 测试基准语言钉 en(test-setup G14.104),断言单语 en。
 */

type SkillsRow = SkillsGroup['skills'][number];

/** 行构造器:daemon GET /settings/skills 应答行的合法缺省,逐例覆写差面 */
const row = (id: string, over: Partial<SkillsRow> = {}): SkillsRow => ({ id, ...over });

/** conn 桩:skillsGroups 调用记录([root 归一 '', all]);首答 initial,重拉答 next;settings 桩
 *  (disabledSkills 键值可配)+ putSettings 调用记录(2026-11-07 加载开关面) */
const connOf = (
  initial: SkillsGroup[],
  opts: { next?: SkillsGroup[]; disabledSkills?: string; envOverride?: boolean } = {},
): { conn: SkillsPaneConn; calls: Array<[string, boolean]>; puts: Array<Record<string, string | number | null>> } => {
  const calls: Array<[string, boolean]> = [];
  const puts: Array<Record<string, string | number | null>> = [];
  let n = 0;
  let cur = opts.disabledSkills;
  return {
    conn: {
      skillsGroups(root?: string, all?: boolean) {
        calls.push([root ?? '', all === true]);
        return Promise.resolve({ groups: n++ === 0 || opts.next === undefined ? initial : opts.next });
      },
      settings() {
        return Promise.resolve({
          keys: [{ key: 'disabledSkills', value: cur ?? null, source: 'global', envOverride: opts.envOverride === true }],
        } as unknown as import('../../connection').SettingsView);
      },
      putSettings(_scope: 'project' | 'global', _root: string | undefined, updates: Record<string, string | number | null>) {
        puts.push(updates);
        const v = updates['disabledSkills'];
        cur = typeof v === 'string' ? v : undefined;
        return Promise.resolve();
      },
    } as SkillsPaneConn,
    calls,
    puts,
  };
};

/** 合并项目下拉触发钮(aria-label=Project,2026-10-29 合并裁定) */
const projectTrigger = (): HTMLButtonElement => screen.getByRole('button', { name: 'Project' }) as HTMLButtonElement;

describe('SkillsPane(遮蔽标注)', () => {
  it('遮蔽标注:行带 shadowedBy → 卡灰显+角标+sourceDir tip;无字段卡零角标零灰显(gating 契约);跨组同 id 去重保持(先者胜)', async () => {
    // user 行 alpha 带 shadowedBy(current root 链上被同名 project 技能遮蔽);project 组同名 alpha
    // 被去重滤除(先者=user 行胜)——保留行透出遮蔽标注;无字段行 solo 恒素卡
    const { conn, calls } = connOf([
      { source: 'user', skills: [row('alpha', { name: 'Alpha User', shadowedBy: 'project', sourceDir: '/u/.sunshinex/skills/alpha' })] },
      { source: 'project', project: 'proj', skills: [row('alpha', { name: 'Alpha Native' }), row('solo', { name: 'Solo' })] },
    ]);
    const { container } = render(<SkillsPane conn={conn} root="/w/proj" title="Skills" />);
    expect((await screen.findAllByText('alpha'))[0]).toBeDefined();
    expect(calls[0]).toEqual(['', true]); // 缺省 target='all' → scope=all 跨项目视图(壳层不下发 root)
    // 2026-11-07 用户裁定「项目名无法区分,需要绝对路径」:跨组不再按 id 去重——user alpha 与
    // project alpha 各一张卡(遮蔽标注仍随富化行表达优先级),solo 第三张
    expect(screen.getAllByText('alpha')).toHaveLength(2);
    const shadowed = container.querySelectorAll('.sx-skill-card.shadowed');
    expect(shadowed).toHaveLength(1);
    expect(shadowed[0].textContent).toContain('alpha');
    expect(screen.getByText('Shadowed by project skill')).toBeDefined(); // 角标(字段在场才渲染)
    // gating:无 shadowedBy 字段的卡零角标零灰显
    expect(screen.queryByText('Shadowed by user skill')).toBeNull();
    const soloCard = container.querySelectorAll('.sx-skill-card')[2];
    expect(soloCard.className).not.toContain('shadowed');
    // sourceDir 悬停 tip 随富化行透出(双卡取富化卡=首张);无字段行无 tip
    expect(screen.getAllByText('alpha')[0].getAttribute('data-tip')).toBe('/u/.sunshinex/skills/alpha');
    expect(screen.getByText('solo').getAttribute('data-tip')).toBeNull();
  });

  it('refreshTick 变化触发重拉(config-changed 外部改动信号)', async () => {
    const { conn, calls } = connOf([{ source: 'user', skills: [row('alpha')] }]);
    const { rerender } = render(<SkillsPane conn={conn} root="/w/proj" title="Skills" refreshTick={0} />);
    await screen.findByText('alpha');
    expect(calls).toEqual([['', true]]);
    rerender(<SkillsPane conn={conn} root="/w/proj" title="Skills" refreshTick={1} />);
    await waitFor(() => expect(calls).toEqual([['', true], ['', true]]));
  });

  it('工具栏合并项目下拉(2026-10-29 用户裁定:作用域下拉+项目筛选二合一,提到最前):全部项目(缺省,scope=all 数据路径,不上抛壳层)|全局|注册项目各走对应目标重拉;原独立项目筛选 Select 不再渲染;下拉定宽', async () => {
    const { conn, calls } = connOf([{ source: 'user', skills: [row('alpha')] }]);
    const raised: string[] = [];
    const scopeOptions = [
      { value: '', label: 'Global' },
      { value: '/w/proj', label: 'proj' },
      { value: '/w/other', label: 'other' },
    ];
    render(<SkillsPane conn={conn} root="/w/proj" title="Skills" scopeOptions={scopeOptions} onScopeChange={(v) => raised.push(v)} />);
    await screen.findByText('alpha');
    // 只读面:无添加钮;搜索入工具栏(SearchBar 统一入口)
    expect(screen.queryByRole('button', { name: '+ Add' })).toBeNull();
    expect(screen.getByLabelText('Search')).toBeDefined();
    // 原独立项目筛选 Select(aria-label=skills project)不再渲染;原 ScopeSelect(Settings scope)不再渲染
    expect(screen.queryByLabelText('skills project')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Settings scope' })).toBeNull();
    // 合并项目下拉:缺省当值=全部项目;定宽类挂包裹层(sx-dd-fixed)
    expect(projectTrigger().textContent).toContain('All projects');
    expect(projectTrigger().closest('.sx-dd')!.className).toContain('sx-dd-fixed');
    expect(calls).toEqual([['', true]]); // 缺省 scope=all 数据路径(不带 root)
    // 弹层选项=全部项目+全局+注册项目
    fireEvent.click(projectTrigger());
    expect(screen.getByRole('option', { name: 'All projects' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'Global' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'other' })).toBeDefined();
    // 选全局:上抛 ''(同步壳 targetRoot)+按全局目标重拉(仅 user 组,不带 all)
    fireEvent.click(screen.getByRole('option', { name: 'Global' }));
    expect(raised).toEqual(['']);
    await waitFor(() => expect(calls).toEqual([['', true], ['', false]]));
    expect(projectTrigger().textContent).toContain('Global');
    // 选注册项目:上抛 root 字符串+按该项目重拉(带 root,不带 all)
    fireEvent.click(projectTrigger());
    fireEvent.click(screen.getByRole('option', { name: 'other' }));
    expect(raised).toEqual(['', '/w/other']);
    await waitFor(() => expect(calls).toEqual([['', true], ['', false], ['/w/other', false]]));
  });

  it("选回'全部项目':壳层不上抛('all' 非壳 targetRoot 值——壳不下发 root,pane 自持 scope=all 拉取)+回落 scope=all 数据路径", async () => {
    const { conn, calls } = connOf([{ source: 'user', skills: [row('alpha')] }]);
    const raised: string[] = [];
    render(
      <SkillsPane
        conn={conn}
        root="/w/proj"
        title="Skills"
        scopeOptions={[
          { value: '', label: 'Global' },
          { value: '/w/proj', label: 'proj' },
        ]}
        onScopeChange={(v) => raised.push(v)}
      />,
    );
    await screen.findByText('alpha');
    fireEvent.click(projectTrigger());
    fireEvent.click(screen.getByRole('option', { name: 'Global' }));
    await waitFor(() => expect(calls).toEqual([['', true], ['', false]]));
    fireEvent.click(projectTrigger());
    fireEvent.click(screen.getByRole('option', { name: 'All projects' }));
    expect(raised).toEqual(['']); // 'all' 不上抛(壳层不感知)
    await waitFor(() => expect(calls).toEqual([['', true], ['', false], ['', true]])); // 回 scope=all 路径
    expect(projectTrigger().textContent).toContain('All projects');
  });

  it('加载开关(2026-11-07 用户裁定「项目标签换开关,默认开启」):卡片带 role=switch 默认开;关态随 disabled 标注;切换 PUT 全局档 disabledSkills(路径 CSV 落点);来源标签退役,路径行承担区分', async () => {
    const dirA = '/w/proj/.sunshinex/skills/test-skill';
    const dirB = '/other/.sunshinex/skills/test-skill';
    const { conn, puts } = connOf(
      [
        { source: 'project', project: 'proj', skills: [row('test-skill', { description: '演示', sourceDir: dirA })] },
        { source: 'project', project: 'other', skills: [row('test-skill', { description: '他项目同名', sourceDir: dirB, disabled: true })] },
      ],
      { disabledSkills: dirB },
    );
    const { container } = render(<SkillsPane conn={conn} root="/w/proj" title="Skills" />);
    // 同名两卡并存(路径身份),各带开关;默认开,disabled 行关
    await screen.findAllByText('test-skill');
    expect(screen.getAllByText('test-skill')).toHaveLength(2);
    const switches = screen.getAllByRole('switch', { name: 'Load skill test-skill' });
    expect(switches).toHaveLength(2);
    expect(switches[0].getAttribute('aria-checked')).toBe('true');
    expect(switches[1].getAttribute('aria-checked')).toBe('false');
    // 项目名标签退役;路径行在场(区分同名技能的唯一显示)
    expect(container.querySelectorAll('.sx-skill-src')).toHaveLength(0);
    expect(container.querySelectorAll('.sx-skill-dir')).toHaveLength(2);
    // 拨第一卡(开→关):PUT 全局档,updates=两路径 CSV(集合序不保证,按序无关比较)
    const csvOf = (v: unknown): string => String(v).split(',').map((x) => x.trim()).sort().join(',');
    fireEvent.click(switches[0]);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(csvOf(puts[0]['disabledSkills'])).toBe(csvOf(`${dirA},${dirB}`));
    // 落定后开关翻面(以 disabledDirs 权威源渲染,乐观即翻;回读对账同值)
    await waitFor(() => expect(switches[0].getAttribute('aria-checked')).toBe('false'));
    // 再拨回(关→开):CSV 只剩 dirB
    fireEvent.click(screen.getAllByRole('switch', { name: 'Load skill test-skill' })[0]);
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]['disabledSkills']).toBe(dirB);
  });

  it('开关默认开(无 disabledSkills 配置)且 env 覆盖行禁编', async () => {
    const { conn } = connOf([{ source: 'user', skills: [row('alpha', { sourceDir: '/u/skills/alpha' })] }], { envOverride: true });
    const { container } = render(<SkillsPane conn={conn} root="/w/proj" title="Skills" />);
    const sw = await screen.findByRole('switch', { name: 'Load skill alpha' });
    expect(sw.getAttribute('aria-checked')).toBe('true'); // 缺省=开启
    expect((sw as HTMLButtonElement).disabled).toBe(true); // env 覆盖=只读
    expect(container.querySelectorAll('.sx-skill-src')).toHaveLength(0);
  });
});
