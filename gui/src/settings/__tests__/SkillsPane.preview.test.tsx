import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SkillsPane } from '../SkillsPane';
import type { SkillsPaneConn } from '../SkillsPane';
import type { SettingsView } from '../../connection';

/** 技能描述点击预览(2026-11-09 用户裁定):描述单行钮→弹窗渲染 SKILL.md(frontmatter 剥除,md 格式化),
 *  头部复制钮;Esc 关闭 */
describe('SkillsPane SKILL.md 预览弹窗', () => {
  it('点描述开弹窗:md 格式化渲染、frontmatter 不显、有复制钮;Esc 关闭', async () => {
    const asked: string[] = [];
    const conn: SkillsPaneConn = {
      skillsGroups: () => Promise.resolve({ groups: [{ source: 'user', skills: [{ id: 'demo', description: 'A demo skill', sourceDir: '/u/skills/demo' }] }] }),
      settings: () => Promise.resolve({ keys: [{ key: 'disabledSkills', value: null, source: 'default', envOverride: false }] } as unknown as SettingsView),
      putSettings: () => Promise.resolve(),
      skillBody: (dir) => {
        asked.push(dir);
        return Promise.resolve({ body: '---\nname: demo\n---\n# Demo Title\n\nhello **world**\n' });
      },
    };
    render(<SkillsPane conn={conn} root="" title="Skills" />);
    fireEvent.click(await screen.findByRole('button', { name: 'A demo skill' }));
    const dlg = await screen.findByRole('dialog', { name: 'demo' });
    await waitFor(() => expect(dlg.querySelector('h1')?.textContent).toBe('Demo Title'));
    expect(asked).toEqual(['/u/skills/demo']);
    expect(dlg.textContent).not.toContain('name: demo');
    expect(dlg.querySelector('strong')?.textContent).toBe('world');
    expect(screen.getByRole('button', { name: 'copy content' })).toBeDefined();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
