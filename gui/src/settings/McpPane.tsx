import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import type { McpRow, McpProbeResult } from '../connection';
import { SourceBadge } from './SourceBadge';

/**
 * G8c T9 MCP 面板 → 2026-10-26 四轮改版(用户裁定):
 * ①状态圆点:挂载即逐台真探测——绿=连接正常(可列工具),红=连接失败,灰=探测中/整机停用;
 *   身份不符(serverInfo.name ≠ 配置键)降级为软提示行,不再算失败(主流服务器常态,装配面同门)。
 * ②探测结果内联工具清单:工具数+逐工具开关(disabledTools 短名过滤,装配期不注册即模型不可见)。
 * ③整机开关(enabled):关=装配跳过(guard 名单同步剔除);开关变更「新会话生效」(mcpServers 是
 *   Harness 构造期快照,daemon.ts 装配链注释)。
 * ④JSON 编辑:添加/编辑打开 mcp.json 兼容片段编辑窗(`{ "<name>": {command|url|headers|env|…} }`),
 *   预填取自 raw 原文(值不打码——GET 视图 env/headers 折键名会丢值);保存=读 raw→改单键→PUT raw
 *   (validateMcpRawContent 同门校验)。所有结构化变更(开关/删除/编辑)一律走 raw 读改写——
 *   旧 putMcpServers 整块替换会丢其他行的 env/headers 值(视图打码不可知),raw 路径根治;
 *   文件含注释/畸形 JSON → 行内报错引流高级 raw 编辑(与 daemon 409 同口径)。
 * 写面恒项目级(root='' 只读);全局卡只读不变。
 */

/** MCP 面连接面(结构满足即收,App 传整只 Connection);settingsRaw/putSettingsRaw 签名与 RawPane
 *  同宽(file: 'settings'|'mcp'——SettingsShell 同时 extends 两面,窄化会撞签名) */
export interface McpPaneConn {
  mcpServers(root?: string): Promise<{ servers: McpRow[] }>;
  mcpProbe(root: string | undefined, name: string): Promise<McpProbeResult>;
  settingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp'): Promise<{ content: string | null }>;
  putSettingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp', content: string): Promise<void>;
}


/** 状态点三态:ok=绿(连接正常)/err=红(连接失败)/probe=灰(探测中)/off=灰环(整机停用,不探测) */
type McpDotState = 'ok' | 'err' | 'probe' | 'off';

const ADD_TEMPLATE = `{
  "new-server": {
    "command": "npx",
    "args": ["-y", "mcp-server"]
  }
}`;

export interface McpPaneProps {
  readonly conn: McpPaneConn;
  /** 项目上下文('' = 仅全局——写面禁用,读面省参) */
  readonly root: string;
}

export function McpPane({ conn, root }: McpPaneProps): JSX.Element {
  const [servers, setServers] = useState<McpRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  /** 探测结果按名落位(卡内状态点+工具清单);HTTP 层失败也归一为 ok:false 行内呈现 */
  const [probes, setProbes] = useState<Record<string, McpProbeResult>>({});
  const [probing, setProbing] = useState<string[]>([]);
  /** JSON 编辑窗:editing=原卡 name(重命名=新键替换旧键);null=添加 */
  const [jsonEd, setJsonEd] = useState<{ editing: string | null } | null>(null);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [saving, setSaving] = useState(false);
  const r = root === '' ? undefined : root;

  const load = useCallback((): void => {
    conn.mcpServers(r).then(
      (v) => {
        setServers(v.servers);
        setLoadError('');
      },
      (err: unknown) => setLoadError(errText(err)),
    );
  }, [conn, r]);

  useEffect(() => {
    load();
  }, [load]);

  const probe = useCallback(
    (name: string): void => {
      setProbing((p) => (p.includes(name) ? p : [...p, name]));
      conn.mcpProbe(r, name).then(
        (res) => {
          setProbing((p) => p.filter((n) => n !== name));
          setProbes((prev) => ({ ...prev, [name]: res }));
        },
        (err: unknown) => {
          setProbing((p) => p.filter((n) => n !== name));
          setProbes((prev) => ({ ...prev, [name]: { ok: false, error: errText(err) } }));
        },
      );
    },
    [conn, r],
  );

  /** 挂载自动探测(状态圆点数据源):每名一次,重拉清单不重探(手动「测试连接」可重探) */
  const autoProbed = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (servers === null) return;
    for (const s of servers) {
      if (s.enabled === false || autoProbed.current.has(s.name)) continue;
      autoProbed.current.add(s.name);
      probe(s.name);
    }
  }, [servers, probe]);

  /** raw 读改写单点:读项目 mcp.json 原文→mutator 改 mcpServers→PUT raw(严格 JSON 校验+原子写)。
   *  注释/畸形文件在此抛错(friendly 文案),由调用方行内示出——引流高级 raw 编辑 */
  const mutateProjectMcp = useCallback(
    async (mutate: (srv: Record<string, unknown>) => void): Promise<void> => {
      const { content } = await conn.settingsRaw('project', root, 'mcp');
      let doc: Record<string, unknown> = {};
      if (content !== null) {
        try {
          const parsed: unknown = JSON.parse(content);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>;
        } catch {
          throw new Error(t('mcp.json contains comments or invalid JSON — use the Advanced raw editor', 'mcp.json 含注释或非法 JSON——请用「高级」raw 编辑'));
        }
      }
      const empty = Object.create(null) as Record<string, unknown>;
      const srv: Record<string, unknown> =
        doc.mcpServers !== null && typeof doc.mcpServers === 'object' && !Array.isArray(doc.mcpServers)
          ? (doc.mcpServers as Record<string, unknown>)
          : empty;
      mutate(srv);
      doc.mcpServers = srv;
      await conn.putSettingsRaw('project', root, 'mcp', `${JSON.stringify(doc, null, 2)}\n`);
    },
    [conn, root],
  );

  /** 写回收口单点(2026-10-27 技术债轮 G7:整机开关/逐工具开关/删除三处同构块收敛):saving 门→
   *  结构化写→成功后重拉清单(可选 after 钩子先行);失败 saving 复位+行内错误条 */
  const runWrite = (mutate: (srv: Record<string, unknown>) => void, after?: () => void): void => {
    setSaving(true);
    void mutateProjectMcp(mutate)
      .then(() => {
        setSaving(false);
        after?.();
        load();
      })
      .catch((err: unknown) => {
        setSaving(false);
        setLoadError(errText(err));
      });
  };

  /** 整机开关(写 enabled 显式布尔;root='' 与全局卡禁用) */
  const toggleServer = (s: McpRow): void => {
    if (root === '' || s.source !== 'project' || saving) return;
    const next = s.enabled === false;
    runWrite((srv) => {
      const e = srv[s.name];
      if (e !== null && typeof e === 'object' && !Array.isArray(e)) {
        (e as Record<string, unknown>).enabled = next;
      }
    }, () => {
      // 开关即时反馈:probes 保留(重探测可手动);autoProbed 放行重探
      autoProbed.current.delete(s.name);
    });
  };

  /** 逐工具开关:disabledTools 短名增删,空数组整键移除(文件干净) */
  const toggleTool = (s: McpRow, tool: string): void => {
    if (root === '' || s.source !== 'project' || saving) return;
    const cur = new Set(s.disabledTools ?? []);
    if (cur.has(tool)) cur.delete(tool);
    else cur.add(tool);
    runWrite((srv) => {
      const e = srv[s.name];
      if (e !== null && typeof e === 'object' && !Array.isArray(e)) {
        const o = e as Record<string, unknown>;
        if (cur.size === 0) delete o.disabledTools;
        else o.disabledTools = [...cur].sort();
      }
    });
  };

  const remove = (name: string): void => {
    if (root === '' || saving) return;
    runWrite((srv) => {
      delete srv[name];
    });
  };

  /** JSON 编辑窗打开:预填取 raw 原文该卡条目(值不打码;全局卡/无 root 禁用,添加给模板) */
  const openJson = async (s: McpRow | null): Promise<void> => {
    if (root === '') return;
    setJsonError('');
    if (s === null) {
      setJsonEd({ editing: null });
      setJsonText(ADD_TEMPLATE);
      return;
    }
    try {
      const { content } = await conn.settingsRaw('project', root, 'mcp');
      let entry: unknown;
      if (content !== null) {
        const doc = JSON.parse(content) as { mcpServers?: Record<string, unknown> };
        entry = doc?.mcpServers?.[s.name];
      }
      setJsonEd({ editing: s.name });
      setJsonText(JSON.stringify({ [s.name]: entry ?? { command: '' } }, null, 2));
    } catch {
      // raw 不可解析(注释/畸形):给模板兜底,保存时会再报同错——提示用户走高级 raw
      setJsonEd({ editing: s.name });
      setJsonText(JSON.stringify({ [s.name]: { command: '' } }, null, 2));
      setJsonError(t('mcp.json could not be parsed for prefill (comments?) — the editor starts from a template; saving preserves other entries via raw rewrite', 'mcp.json 预填失败(可能含注释)——编辑窗从模板起步;保存经 raw 改写保留其他条目'));
    }
  };

  /** JSON 保存:严格解析→单键(=服务器名)→形态门(command/url 至少其一)→raw 改单键落盘。
   *  编辑期改名=新键换旧键;其余条目原文保留(env/headers 零丢失) */
  const saveJson = (): void => {
    if (jsonEd === null || saving) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      setJsonError(t(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`, `JSON 非法: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setJsonError(t('Expected an object: { "<name>": { … } }', '应为对象形态: { "<名称>": { … } }'));
      return;
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length !== 1) {
      setJsonError(t('Exactly one server entry expected (top-level key = server name)', '只能有一个服务器条目(顶层键=服务器名)'));
      return;
    }
    const [name, cfg] = entries[0]!;
    if (name.trim() === '') {
      setJsonError(t('Server name must be non-empty', '服务器名不能为空'));
      return;
    }
    if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
      setJsonError(t('Server config must be an object', '服务器配置必须是对象'));
      return;
    }
    const c = cfg as Record<string, unknown>;
    if (typeof c.command !== 'string' && typeof c.url !== 'string') {
      setJsonError(t('Config needs "command" (stdio) or "url" (http/sse)', '配置需要 "command"(stdio) 或 "url"(http/sse)'));
      return;
    }
    setSaving(true);
    setJsonError('');
    const oldName = jsonEd.editing;
    mutateProjectMcp((srv) => {
      if (oldName !== null && oldName !== name) delete srv[oldName]; // 改名=换键
      srv[name] = cfg;
    })
      .then(() => {
        setSaving(false);
        setJsonEd(null);
        autoProbed.current.delete(name);
        load();
      })
      .catch((err: unknown) => {
        setSaving(false);
        setJsonError(errText(err));
      });
  };

  const dotOf = (s: McpRow): McpDotState => {
    if (s.enabled === false) return 'off';
    if (probing.includes(s.name)) return 'probe';
    const res = probes[s.name];
    if (res === undefined) return 'probe';
    return res.ok ? 'ok' : 'err';
  };

  return (
    <section className="sx-settings-form" aria-label="settings pane MCP">
      <h2>{t('MCP servers', 'MCP 服务器')}</h2>
      {loadError !== '' && <p className="home-error" role="alert">{loadError}</p>}
      {servers === null && loadError === '' && <p className="home-loading">{t('Loading MCP servers…', '加载 MCP 清单…')}</p>}
      {servers !== null && servers.length === 0 && loadError === '' && <p className="home-loading">{t('No MCP servers.', '无 MCP 服务器。')}</p>}
      {servers !== null && servers.length > 0 && (
        <ul className="sx-mcp-list">
          {servers.map((s) => {
            const res = probes[s.name];
            const dot = dotOf(s);
            const enabled = s.enabled !== false;
            return (
              <li key={`${s.source}:${s.name}`} className={`sx-mcp-card${s.shadowed ? ' shadowed' : ''}${enabled ? '' : ' disabled'}`}>
                <div className="sx-mcp-head">
                  <span className={`sx-mcp-dot ${dot}`} aria-hidden="true" data-tip={t('Connected', '连接正常')} />
                  <span className="sx-mcp-name">{s.name}</span>
                  <SourceBadge source={s.source} />
                  {s.shadowed && <span className="sx-shadow-tag">{t('Shadowed by project', '被项目遮蔽')}</span>}
                  {/* 整机开关(用户裁定②):绿=启用,灰=停用(enabled=false 装配跳过);仅项目卡可切 */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label={`${t('Enable', '启用')} ${s.name}`}
                    data-tip={root === '' || s.source !== 'project' ? t('Project-level write required', '需项目级写权限') : t('Takes effect on next session', '新会话生效')}
                    disabled={root === '' || s.source !== 'project' || saving}
                    className={`sx-mcp-switch${enabled ? ' on' : ''}`}
                    onClick={() => toggleServer(s)}
                  >
                    <span className="knob" aria-hidden="true" />
                  </button>
                </div>
                <dl className="sx-mcp-meta">
                  <dt>{t('Transport', '传输')}</dt>
                  <dd>{s.transport}</dd>
                  {s.command !== undefined && (
                    <>
                      <dt>{t('Command', '命令')}</dt>
                      <dd>
                        {s.command}
                        {s.args !== undefined && s.args.length > 0 ? ` ${s.args.join(' ')}` : ''}
                      </dd>
                    </>
                  )}
                  {s.url !== undefined && (
                    <>
                      <dt>URL</dt>
                      <dd>{s.url}</dd>
                    </>
                  )}
                  {s.envKeys.length > 0 && (
                    <>
                      <dt>{t('Env keys', '环境键')}</dt>
                      <dd>{s.envKeys.join(', ')}</dd>
                    </>
                  )}
                  {s.headerKeys.length > 0 && (
                    <>
                      <dt>{t('Header keys', '请求头')}</dt>
                      <dd>{s.headerKeys.join(', ')}</dd>
                    </>
                  )}
                </dl>
                <div className="sx-card-actions">
                  <button type="button" aria-label={`${t('Test connection', '测试连接')} ${s.name}`} disabled={probing.includes(s.name)} onClick={() => probe(s.name)}>
                    {t('Test connection', '测试连接')}
                  </button>
                  <button
                    type="button"
                    aria-label={`${t('Edit JSON', 'JSON 编辑')} ${s.name}(${s.source === 'project' ? t('Project', '项目') : t('Global', '全局')})`}
                    disabled={s.source !== 'project' || root === ''}
                    data-tip={s.source !== 'project' ? t('Global-level — edit via Advanced raw', '全局级经高级 raw 编辑') : undefined}
                    onClick={() => void openJson(s)}
                  >
                    {t('Edit JSON', 'JSON 编辑')}
                  </button>
                  <button
                    type="button"
                    aria-label={`${t('Delete', '删除')} ${s.name}(${s.source === 'project' ? t('Project', '项目') : t('Global', '全局')})`}
                    disabled={s.source !== 'project' || root === ''}
                    data-tip={s.source !== 'project' ? t('Global card not in project file (edit globally via Advanced)', '全局卡不在项目文件内(全局编辑走「高级」)') : undefined}
                    onClick={() => remove(s.name)}
                  >
                    {t('Delete', '删除')}
                  </button>
                </div>
                {res !== undefined &&
                  (res.ok ? (
                    <details className="sx-mcp-probe" open>
                      <summary>
                        {t(`Connected · ${res.tools.length} tools`, `连接正常 · 工具 ×${res.tools.length}`)}
                        {s.disabledTools !== undefined && s.disabledTools.length > 0 && (
                          <span className="sx-mcp-offcount">{t(` · ${s.disabledTools.length} disabled`, ` · 停用 ${s.disabledTools.length}`)}</span>
                        )}
                      </summary>
                      {res.note !== undefined && <p className="sx-mcp-note">{res.note}</p>}
                      <ul className="sx-mcp-tools">
                        {res.tools.map((tl) => {
                          const off = (s.disabledTools ?? []).includes(tl.name);
                          return (
                            <li key={tl.name} className="sx-mcp-tool">
                              <button
                                type="button"
                                role="switch"
                                aria-checked={!off}
                                aria-label={`${tl.name}`}
                                data-tip={tl.description !== undefined && tl.description !== '' ? tl.description : undefined}
                                disabled={root === '' || s.source !== 'project' || saving}
                                className={`sx-mcp-switch${off ? '' : ' on'}`}
                                onClick={() => toggleTool(s, tl.name)}
                              >
                                <span className="knob" aria-hidden="true" />
                              </button>
                              <span className={`sx-mcp-tool-name${off ? ' off' : ''}`}>{tl.name}</span>
                            </li>
                          );
                        })}
                      </ul>
                      {(root !== '' && s.source === 'project') && (
                        <p className="sx-mcp-hint">{t('Toggles take effect on next session', '开关变更对新会话生效')}</p>
                      )}
                    </details>
                  ) : (
                    <p className="home-error" role="alert">{res.error}</p>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
      {jsonEd !== null && (
        /* 2026-10-26 用户裁定改回:JSON 编辑原地内联显示(设置页流程内,不开模态);去蓝改灰保留
           (border-strong 描边卡+灰 hover),按钮沿设置页惯例左置 */
        <form
          className="sx-card-form"
          onSubmit={(e) => {
            e.preventDefault();
            saveJson();
          }}
        >
          <h3>{jsonEd.editing !== null ? t(`Edit ${jsonEd.editing} (JSON)`, `编辑 ${jsonEd.editing}(JSON)`) : t('Add server (project, JSON)', '添加服务器(项目级,JSON)')}</h3>
          <p className="sx-mcp-hint">
            {t('mcp.json-compatible fragment: top-level key = server name. Supported fields: command/args/env (stdio), url/transport/headers/env (http·sse), enabled, disabledTools.', 'mcp.json 兼容片段:顶层键=服务器名。支持字段:command/args/env(stdio)、url/transport/headers/env(http·sse)、enabled、disabledTools。')}
          </p>
          <textarea
            aria-label="mcp json editor"
            className="sx-mcp-json"
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            rows={16}
            spellCheck={false}
          />
          {jsonError !== '' && <p className="home-error" role="alert">{jsonError}</p>}
          <div className="sx-card-actions">
            <button type="submit" disabled={saving}>
              {t('Save', '保存')}
            </button>
            <button
              type="button"
              onClick={() => {
                setJsonEd(null);
                setJsonError('');
              }}
            >
              {t('Cancel', '取消')}
            </button>
          </div>
        </form>
      )}
      <button type="button" className="sx-add-button" disabled={root === ''} onClick={() => void openJson(null)}>
        {t('+ Add server', '+ 添加服务器')}
      </button>
    </section>
  );
}
