import { Fragment, useCallback, useEffect, useState } from 'react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import type { PermissionOpInput, SettingsView } from '../connection';
import type { SettingsScope } from './components';

/**
 * G8c T9 权限面板(设置重构二轮,自 SkillsPermsPane 拆出——「技能」「权限」两导航项原同体
 * 渲染致内容重复;本面只承载权限;T25 结构化增删升级):
 * - conn.settings(root) 的 permissions {merged, project, global} 三列。merged 恒**只读汇总**
 *   (两级拼接去重视图态——展示即教育:项目级不能解除全局 deny);project/global 两列的
 *   deny/allow/additionalDirs 三组各为 **chips 列表 + 输入行增删**(→ PUT /settings/permissions/
 *   op,T16 handler 两 scope 皆可写:project 带 root、global 省参;add 幂等去重/remove 缺失 409)。
 * - 去重门:输入空白/与既有 chip 重值 → Add 禁用(重值落盘是服务端幂等,门前置免无效往返)。
 * - root=''(仅全局上下文):project 列退只读(handler 对 scope=project 缺 root 400——不可写面
 *   不出编辑件),global 列照常。
 * - 错误面:装载错误(permsError)/操作错误(actionError 行内)二分;op saving 门沿 T22(串行
 *   防连点),成功重拉;409 hint 'use raw editor' 由 errText 呈现 status 行引流 raw 编辑面。
 * - refreshTick 变化=外部改动信号(config-changed 订阅)→ 重拉。
 */
export interface PermissionsPaneConn {
  settings(root?: string): Promise<SettingsView>;
  /** PUT /settings/permissions/op(T16 单条目操作端点,T25 GUI 消费) */
  putPermissionOp(input: PermissionOpInput): Promise<void>;
}

/** 权限三列级别徽标文案(标签渲染期 t() 求值——G14.213,模块常量不冻结文案) */
const PERM_LEVELS = ['merged', 'project', 'global'] as const;
const permLabel = (lv: (typeof PERM_LEVELS)[number]): string => (lv === 'merged' ? t('Merged', '合并') : lv === 'project' ? t('Project', '项目') : t('Global', '全局'));

/** permissions 三数组键(deny/allow/additionalDirs;daemon PermissionConfig 同序) */
const PERM_LISTS = ['deny', 'allow', 'additionalDirs'] as const;
type PermList = (typeof PERM_LISTS)[number];

export interface PermissionsPaneProps {
  readonly conn: PermissionsPaneConn;
  /** 项目上下文('' = 仅全局:permissions 仅全局面,project 列退只读) */
  readonly root: string;
  /** 导航标题(aria-label/标题行) */
  readonly title: string;
  /** T21 设置壳注入:作用域(顶栏 ScopeSwitcher)——可选,本任务零行为变化,T26 起解构消费 */
  readonly scope?: SettingsScope;
  /** T21 config-changed 订阅 tick(permissions 资源计数——外部改动信号,变化即重拉) */
  readonly refreshTick?: number;
}

export function PermissionsPane({ conn, root, title, refreshTick }: PermissionsPaneProps): JSX.Element {
  const [perms, setPerms] = useState<SettingsView['permissions'] | null>(null);
  const [permsError, setPermsError] = useState('');
  const [actionError, setActionError] = useState('');
  /** op 串行门(T22 同款):在途写禁后续 op,成功/失败复位 */
  const [saving, setSaving] = useState(false);
  /** 输入行草稿(键 `${level}:${list}` → 值;成功即清该行) */
  const [draft, setDraft] = useState<Record<string, string>>({});
  const r = root === '' ? undefined : root;

  const load = useCallback((): (() => void) => {
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

  useEffect(() => load(), [load, refreshTick]); // refreshTick 变化=外部改动信号 → 重拉(config-changed 订阅消费面)

  /** 写面守卫:global 恒可写(handler 两 scope 皆可写);project 需项目上下文(op 必带 root) */
  const canWrite = (level: Exclude<(typeof PERM_LEVELS)[number], 'merged'>): boolean => level === 'global' || root !== '';

  /** op 写回收口单点(saving 门 → putPermissionOp → 成功重拉/失败行内错误条;saving 复位):
   *  input 原文即请求体——project 带 root、global 省参不留空串伪参(putMcpOp 同款) */
  const runOp = (op: PermissionOpInput['op'], level: Exclude<(typeof PERM_LEVELS)[number], 'merged'>, list: PermList, value: string): void => {
    if (saving) return;
    setSaving(true);
    setActionError('');
    conn
      .putPermissionOp({ op, scope: level, ...(level === 'project' ? { root } : {}), list, value })
      .then(() => {
        setSaving(false);
        if (op === 'add') setDraft((d) => ({ ...d, [`${level}:${list}`]: '' })); // 草稿清空(成功才清,失败保留可改再发)
        load();
      })
      .catch((err: unknown) => {
        setSaving(false);
        setActionError(errText(err));
      });
  };

  /** 输入行提交:trim 后空白不发;重值门前置已拦(Add disabled)——此处幂等兜底 */
  const addValue = (level: Exclude<(typeof PERM_LEVELS)[number], 'merged'>, list: PermList): void => {
    const value = (draft[`${level}:${list}`] ?? '').trim();
    if (value === '' || perms === null || perms[level][list].includes(value)) return;
    runOp('add', level, list, value);
  };

  return (
    <section className="sx-settings-form sx-settings-body" aria-label={`settings pane ${title}`}>
      <h2>{title}</h2>
      {permsError !== '' && <p className="home-error" role="alert">{permsError}</p>}
      {perms === null && permsError === '' && <p className="home-loading">{t('Loading permissions…', '加载权限…')}</p>}
      {perms !== null && (
        <div className="sx-perms-cols">
          {PERM_LEVELS.map((level) => {
            const editable = level !== 'merged' && canWrite(level);
            return (
              <div key={level} className="sx-perm-col">
                <span className={`sx-perm-level sx-perm-level-${level}`}>{permLabel(level)}</span>
                <dl className="sx-perm-rows">
                  {PERM_LISTS.map((list) => {
                    const values = perms[level][list];
                    const dk = `${level}:${list}`;
                    const trimmed = (draft[dk] ?? '').trim();
                    const dup = values.includes(trimmed);
                    return (
                      <Fragment key={list}>
                        <dt>{list}</dt>
                        <dd>
                          {values.length === 0 ? (
                            <span className="sx-perm-empty">{t('(empty)', '(空)')}</span>
                          ) : level === 'merged' ? (
                            // merged 只读汇总:逐值一行(deny/allow 沿既有红绿着色)
                            values.map((x) => (
                              <span key={x} className={`sx-perm-merged-row ${list === 'deny' ? 'sx-perm-deny' : list === 'allow' ? 'sx-perm-allow' : ''}`}>
                                {x}
                              </span>
                            ))
                          ) : (
                            <span className="sx-agent-chips sx-perm-chips">
                              {values.map((x) => (
                                <span key={x} className={`sx-chip ${list === 'deny' ? 'sx-perm-deny' : list === 'allow' ? 'sx-perm-allow' : ''}`}>
                                  <span className="sx-perm-chip-text">{x}</span>
                                  {editable && (
                                    <button
                                      type="button"
                                      className="sx-perm-chip-x"
                                      aria-label={`${t('remove', '移除')} ${list} (${level}) ${x}`}
                                      disabled={saving}
                                      onClick={() => runOp('remove', level, list, x)}
                                    >
                                      ×
                                    </button>
                                  )}
                                </span>
                              ))}
                            </span>
                          )}
                          {editable && (
                            <span className="sx-card-actions sx-perm-addrow">
                              <input
                                type="text"
                                className="sx-setting-input"
                                aria-label={t(`add ${list} (${level})`, `添加 ${list} (${level})`)}
                                placeholder={t('Permission rule…', '权限规则…')}
                                value={draft[dk] ?? ''}
                                disabled={saving}
                                spellCheck={false}
                                onChange={(e) => setDraft((d) => ({ ...d, [dk]: e.target.value }))}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') addValue(level, list); // Enter=提交(同 + Add)
                                }}
                              />
                              <button
                                type="button"
                                aria-label={t(`+ Add ${list} (${level})`, `+ 添加 ${list} (${level})`)}
                                disabled={saving || trimmed === '' || dup}
                                onClick={() => addValue(level, list)}
                              >
                                +
                              </button>
                            </span>
                          )}
                        </dd>
                      </Fragment>
                    );
                  })}
                </dl>
              </div>
            );
          })}
        </div>
      )}
      {actionError !== '' && <p className="home-error" role="alert">{actionError}</p>}
    </section>
  );
}
