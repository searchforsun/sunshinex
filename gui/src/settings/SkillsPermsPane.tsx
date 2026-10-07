import { useEffect, useState } from 'react';
import type { SettingsView, SkillsGroup } from '../connection';

/**
 * G8c T9 技能+权限面板(U-D12 只读 v1;导航「插件:技能」与「权限」两项同体渲染——
 * 上技能下权限两节,全只读):
 * - 上:conn.skillsGroups(root) 三源分组只读清单(组标 project/user/learned + 行 id +
 *   description;组内沿装载序,跨组不去重——多源同名两组各在是事实呈现)。
 * - 下:conn.settings(root) 的 permissions {merged, project, global} 三列只读表
 *   (deny/allow/additionalDirs 行,列头级别小徽标;merged=两级拼接去重视图态)。
 *   项目级不能解除全局 deny——展示即教育(编辑走「高级」原文)。
 */

/** 技能+权限面连接面(结构满足即收,App 传整只 Connection) */
export interface SkillsPermsPaneConn {
  skillsGroups(root?: string): Promise<{ groups: SkillsGroup[] }>;
  settings(root?: string): Promise<SettingsView>;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 三源组标文案(skills 专属 'user'/'learned' 两态不在 SettingsBadge 四态内——本地组标) */
const GROUP_LABEL: Record<SkillsGroup['source'], string> = { project: '项目', user: '用户', learned: '学习沉淀' };

/** 权限三列级别徽标文案 */
const PERM_LEVELS = ['merged', 'project', 'global'] as const;
const PERM_LABEL: Record<(typeof PERM_LEVELS)[number], string> = { merged: '合并', project: '项目', global: '全局' };

export interface SkillsPermsPaneProps {
  readonly conn: SkillsPermsPaneConn;
  /** 项目上下文('' = 仅全局:技能仅 user 组,permissions 仅全局面) */
  readonly root: string;
  /** 导航标题(aria-label/标题行——两导航项同体) */
  readonly title: string;
}

export function SkillsPermsPane({ conn, root, title }: SkillsPermsPaneProps): JSX.Element {
  const [groups, setGroups] = useState<SkillsGroup[] | null>(null);
  const [perms, setPerms] = useState<SettingsView['permissions'] | null>(null);
  const [skillsError, setSkillsError] = useState('');
  const [permsError, setPermsError] = useState('');
  const r = root === '' ? undefined : root;

  useEffect(() => {
    conn.skillsGroups(r).then(
      (v) => {
        setGroups(v.groups);
        setSkillsError('');
      },
      (err: unknown) => setSkillsError(errText(err)),
    );
    conn.settings(r).then(
      (v) => {
        setPerms(v.permissions);
        setPermsError('');
      },
      (err: unknown) => setPermsError(errText(err)),
    );
  }, [conn, r]);

  return (
    <section className="sx-settings-form" aria-label={`settings pane ${title}`}>
      <h2>{title}</h2>
      <h3>技能(三源分组,只读)</h3>
      {skillsError !== '' && <p className="home-error" role="alert">{skillsError}</p>}
      {groups === null && skillsError === '' && <p className="home-loading">加载技能清单…</p>}
      {groups !== null && groups.length === 0 && skillsError === '' && <p className="home-loading">无已装载技能。</p>}
      {groups !== null &&
        groups.map((g) => (
          <div key={g.source} className="sx-skills-group">
            <span className={`sx-skills-src sx-skills-src-${g.source}`}>{GROUP_LABEL[g.source]}</span>
            {g.skills.length === 0 ? (
              <p className="home-loading">(空)</p>
            ) : (
              <ul className="sx-skill-rows">
                {g.skills.map((sk) => (
                  <li key={sk.id} className="sx-skill-row">
                    <span className="sx-skill-id">{sk.id}</span>
                    {sk.description !== undefined && <span className="sx-skill-desc">{sk.description}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      <h3>权限(两级合并,只读)</h3>
      {permsError !== '' && <p className="home-error" role="alert">{permsError}</p>}
      {perms === null && permsError === '' && <p className="home-loading">加载权限…</p>}
      {perms !== null && (
        <div className="sx-perms-cols">
          {PERM_LEVELS.map((level) => (
            <div key={level} className="sx-perm-col">
              <span className={`sx-perm-level sx-perm-level-${level}`}>{PERM_LABEL[level]}</span>
              <dl className="sx-perm-rows">
                <dt>deny</dt>
                {perms[level].deny.length === 0 ? <dd className="sx-perm-empty">(空)</dd> : perms[level].deny.map((x) => <dd key={x} className="sx-perm-deny">{x}</dd>)}
                <dt>allow</dt>
                {perms[level].allow.length === 0 ? <dd className="sx-perm-empty">(空)</dd> : perms[level].allow.map((x) => <dd key={x} className="sx-perm-allow">{x}</dd>)}
                <dt>additionalDirs</dt>
                {perms[level].additionalDirs.length === 0 ? (
                  <dd className="sx-perm-empty">(空)</dd>
                ) : (
                  perms[level].additionalDirs.map((x) => <dd key={x}>{x}</dd>)
                )}
              </dl>
            </div>
          ))}
        </div>
      )}
      <p className="sx-perms-note">项目级不能解除全局 deny;编辑走「高级」原文编辑。</p>
    </section>
  );
}
