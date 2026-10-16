import { useEffect, useState } from 'react';
import type { SettingsView } from '../connection';

/**
 * G8c T9 权限面板(设置重构二轮,自 SkillsPermsPane 拆出——「技能」「权限」两导航项原同体
 * 渲染致内容重复;本面只承载权限):
 * - conn.settings(root) 的 permissions {merged, project, global} 三列只读表
 *   (deny/allow/additionalDirs 行,列头级别小徽标;merged=两级拼接去重视图态)。
 *   项目级不能解除全局 deny——展示即教育(编辑走「高级」原文)。
 */
export interface PermissionsPaneConn {
  settings(root?: string): Promise<SettingsView>;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 权限三列级别徽标文案 */
const PERM_LEVELS = ['merged', 'project', 'global'] as const;
const PERM_LABEL: Record<(typeof PERM_LEVELS)[number], string> = { merged: '合并', project: '项目', global: '全局' };

export interface PermissionsPaneProps {
  readonly conn: PermissionsPaneConn;
  /** 项目上下文('' = 仅全局:permissions 仅全局面) */
  readonly root: string;
  /** 导航标题(aria-label/标题行) */
  readonly title: string;
}

export function PermissionsPane({ conn, root, title }: PermissionsPaneProps): JSX.Element {
  const [perms, setPerms] = useState<SettingsView['permissions'] | null>(null);
  const [permsError, setPermsError] = useState('');
  const r = root === '' ? undefined : root;

  useEffect(() => {
    let alive = true;
    conn.settings(r).then(
      (v) => {
        if (!alive) return;
        setPerms(v.permissions);
        setPermsError('');
      },
      (err: unknown) => {
        if (alive) setPermsError(errText(err));
      },
    );
    return () => {
      alive = false;
    };
  }, [conn, r]);

  return (
    <section className="sx-settings-form sx-settings-body" aria-label={`settings pane ${title}`}>
      <h2>{title}</h2>
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
    </section>
  );
}
