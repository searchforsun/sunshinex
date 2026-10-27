import { Fragment, useCallback, useEffect, useState } from 'react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import type { PluginRow } from '../connection';
import { SourceBadge } from './SourceBadge';

/**
 * 2026-10-26 插件面(Task 12,spec §6 设置页「插件」pane):loadEffectivePlugins 两级清单的可视化
 * 卡列表——名称+版本+来源徽标(SourceBadge 扩 builtin/user 两态)+开关钮+描述行+贡献面行
 * (servers 名列表/skillsCount)+逐插件 warnings 行内告警条;pane 尾聚合装载告警(「N 条装载告警」
 * 展开——manifest 非法被跳过的插件唯一可见面,装载告警三出口之一)。config 展开区 v1 只读 JSON
 * 展示(configSchema 键说明+config 原值),无表单无添加——插件由目录扫描发现,非用户创建面。
 * 交互沿 MCP pane 裁定:写面恒项目级(root='' 只读,开关禁用+「选择项目」提示);platformSupported=
 * false 置灰+「平台不支持」标(装载层只标记不丢弃,装配跳过);开关=PUT settings 语义键(显式布尔,
 * 记录级整面替换)成功后重拉清单,生效语义=下次会话装配生效(沿 MCP「新会话生效」同口径);
 * 400/404/409 行内错误条(pane 顶 role=alert,沿 McpPane 错误条位)。
 */

/** 插件行类型随本 pane 再导出(brief 产出面;本体在 connection-types——Connection.plugins 应答同源) */
export type { PluginRow };

/** 插件面连接面(结构满足即收,App 传整只 Connection;root: string=项目上下文,'' = 仅全局) */
export interface PluginsPaneConn {
  plugins(root?: string): Promise<{ plugins: PluginRow[]; warnings?: string[] }>;
  putPlugin(root: string, id: string, patch: { enabled?: boolean }): Promise<void>;
}

export interface PluginsPaneProps {
  readonly conn: PluginsPaneConn;
  /** 项目上下文('' = 仅全局——写面禁用,读面省参) */
  readonly root: string;
}

export function PluginsPane({ conn, root }: PluginsPaneProps): JSX.Element {
  const [rows, setRows] = useState<PluginRow[] | null>(null);
  /** 装载聚合警告(pane 尾展开;可选防旧 daemon——GET 载荷恒带,结构面留宽) */
  const [viewWarnings, setViewWarnings] = useState<string[]>([]);
  const [loadError, setLoadError] = useState('');
  /** 在途开关的插件 id(逐卡禁用——与 McpPane saving 同语义) */
  const [savingId, setSavingId] = useState<string | null>(null);
  const r = root === '' ? undefined : root;

  const load = useCallback((): void => {
    conn.plugins(r).then(
      (v) => {
        setRows(v.plugins);
        setViewWarnings(v.warnings ?? []);
        setLoadError('');
      },
      (err: unknown) => setLoadError(errText(err)),
    );
  }, [conn, r]);

  useEffect(() => {
    load();
  }, [load]);

  /** 开关切换:PUT 语义键(显式布尔)成功后重拉;失败行内错误条(pane 顶,沿 McpPane 裁定) */
  const toggle = (p: PluginRow): void => {
    if (root === '' || !p.platformSupported || savingId !== null) return;
    setSavingId(p.id);
    conn.putPlugin(root, p.id, { enabled: !p.enabled }).then(
      () => {
        setSavingId(null);
        load();
      },
      (err: unknown) => {
        setSavingId(null);
        setLoadError(errText(err));
      },
    );
  };

  return (
    <section className="sx-settings-form" aria-label="settings pane plugins">
      <h2>{t('Plugins', '插件')}</h2>
      {loadError !== '' && <p className="home-error" role="alert">{loadError}</p>}
      {rows !== null && root !== '' && rows.length > 0 && (
        <p className="sx-mcp-hint">{t('Toggles take effect on next session', '开关变更对新会话生效')}</p>
      )}
      {rows === null && loadError === '' && <p className="home-loading">{t('Loading plugins…', '加载插件清单…')}</p>}
      {rows !== null && rows.length === 0 && loadError === '' && <p className="home-loading">{t('No plugins.', '无已装载插件。')}</p>}
      {rows !== null && rows.length > 0 && (
        <ul className="sx-mcp-list">
          {rows.map((p) => {
            const writable = root !== '' && p.platformSupported;
            return (
              <li key={p.id} className={`sx-mcp-card${p.platformSupported ? '' : ' disabled'}`}>
                <div className="sx-mcp-head">
                  <span className="sx-mcp-name">{p.name}</span>
                  <span className="sx-chip">v{p.version}</span>
                  <SourceBadge source={p.source} />
                  {/* 平台不支持:置灰卡+告警色标(开关恒禁用——装配面同门剔除) */}
                  {!p.platformSupported && <span className="sx-shadow-tag">{t('Platform not supported', '平台不支持')}</span>}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={p.enabled}
                    aria-label={`${t('Enable', '启用')} ${p.name}`}
                    data-tip={
                      root === ''
                        ? t('Project-level write required — select a project', '需项目级写权限——请先选择项目')
                        : !p.platformSupported
                          ? t('Platform not supported', '平台不支持')
                          : t('Takes effect on next session', '新会话生效')
                    }
                    disabled={!writable || savingId !== null}
                    className={`sx-mcp-switch${p.enabled ? ' on' : ''}`}
                    onClick={() => toggle(p)}
                  >
                    <span className="knob" aria-hidden="true" />
                  </button>
                </div>
                {p.description !== '' && <p className="sx-agent-desc">{p.description}</p>}
                <dl className="sx-mcp-meta">
                  <dt>ID</dt>
                  <dd>{p.id}</dd>
                  {p.servers.length > 0 && (
                    <>
                      <dt>{t('Servers', '服务器')}</dt>
                      <dd>{p.servers.join(', ')}</dd>
                    </>
                  )}
                  {p.skillsCount !== undefined && p.skillsCount > 0 && (
                    <>
                      <dt>{t('Skills', '技能')}</dt>
                      <dd>{t(`${p.skillsCount} skill(s)`, `技能 ×${p.skillsCount}`)}</dd>
                    </>
                  )}
                </dl>
                {/* config 展开区(v1 只读):configSchema 键说明 + config 原值 JSON(两者皆缺省不渲染) */}
                {(p.configSchema !== undefined || (p.config !== undefined && Object.keys(p.config).length > 0)) && (
                  <details className="sx-mcp-probe">
                    <summary>{t('Config (read-only)', '配置(只读)')}</summary>
                    {p.configSchema !== undefined && (
                      <dl className="sx-mcp-meta">
                        {Object.entries(p.configSchema).map(([k, s]) => (
                          <Fragment key={k}>
                            <dt>{k}</dt>
                            <dd>{s.description !== undefined ? `${s.type} — ${s.description}` : s.type}</dd>
                          </Fragment>
                        ))}
                      </dl>
                    )}
                    {p.config !== undefined && Object.keys(p.config).length > 0 && (
                      <pre className="sx-plugin-json">{JSON.stringify(p.config, null, 2)}</pre>
                    )}
                  </details>
                )}
                {/* 逐插件 warnings 行内告警条(manifest 解析告警原值——坏值键已告警忽略,插件仍列示) */}
                {p.warnings.length > 0 && (
                  <div role="alert">
                    {p.warnings.map((w, i) => (
                      <p key={i} className="sx-agent-warn">
                        {w}
                      </p>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {/* pane 尾聚合装载告警:整插件被跳过(manifest 非法等)在此展开原因——spec §6 异常可见性出口 */}
      {viewWarnings.length > 0 && (
        <details className="sx-mcp-probe">
          <summary>{t(`${viewWarnings.length} plugin load warning(s)`, `${viewWarnings.length} 条插件装载告警`)}</summary>
          {viewWarnings.map((w, i) => (
            <p key={i} className="sx-agent-warn">
              {w}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
