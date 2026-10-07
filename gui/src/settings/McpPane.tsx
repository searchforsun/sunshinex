import { useCallback, useEffect, useState } from 'react';
import type { McpRow, McpRowInput, McpProbeResult } from '../connection';
import { SourceBadge } from './SourceBadge';

/**
 * G8c T9 MCP 面板:两级遮蔽清单 + 单台真探测 + 项目级整块写。
 * - mount 拉 conn.mcpServers(root) → 卡列表(name/transport/command+args 或 url/envKeys
 *   键名列表——值打码不回传/SourceBadge;shadowed 全局卡灰显+「被项目遮蔽」标)。
 * - 「测试连接」→ conn.mcpProbe(root, name) → 卡内结果行:ok:true → tools 名折叠列表;
 *   ok:false → error 文本(探测是诊断面,失败即结果——同为行内呈现)。
 * - 「+ 添加服务器」/卡「编辑」→ 受控表单(name/transport select(stdio/http/sse)/command+
 *   args(逗号分隔)/url/env(键=值 行编辑));「保存」=conn.putMcpServers(root, 新清单=
 *   现项目清单替换该名或追加)→ 重拉;400/409 行内错误条。
 * - 写面恒项目级(root 缺省禁写:添加/编辑/删除禁用+提示「选择项目」;全局卡编辑钮同禁——
 *   未遮蔽全局卡编辑=整块原样提交会静默消失、被遮蔽全局卡编辑=替换项目同名卡,均为错路径,
 *   title「全局级经高级 raw 编辑」引流;表单在途时 root 被清空→保存放行空 root 由服务端 400 示出)。
 *   编辑既有卡时 env 值不可知(视图打码)——env 文本域预填「KEY=」空值行提示重填;未填则该
 *   行 env 整体省略(daemon 接受可选 env;原文编辑面是无打码的兜底路径)。
 * - env 丢失确认门(G8c 终审 B):编辑卡原 env 键未全部重填(整块替换会把未重填键从 mcp.json
 *   删掉)→ 表单渲染确认 checkbox「确认移除未重填的 N 个 env 键」,未勾选保存钮 disabled
 *   (save 守卫拦 Enter 提交径);勾选=显式确认丢键放行。
 * - 删除=项目清单滤除该名后整块提交;全局卡(含被遮蔽)不在项目文件内——删除钮禁用。
 */

/** MCP 面连接面(结构满足即收,App 传整只 Connection) */
export interface McpPaneConn {
  mcpServers(root?: string): Promise<{ servers: McpRow[] }>;
  mcpProbe(root: string | undefined, name: string): Promise<McpProbeResult>;
  putMcpServers(root: string, servers: McpRowInput[]): Promise<void>;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 表单态(editing=原卡 name——name 是清单键,编辑期锁定防改名追加成双卡;origEnvKeys=编辑播种的
 *  原卡 env 键名——env 丢失确认门(G8c 终审 B)判据:整块替换写面会把未重填的键从 mcp.json 删掉) */
interface McpFormState {
  readonly editing: boolean;
  readonly name: string;
  transport: 'stdio' | 'http' | 'sse';
  command: string;
  args: string;
  url: string;
  env: string;
  /** 编辑卡原 env 键名(新增/原卡无 env = 空) */
  readonly origEnvKeys: readonly string[];
  /** 「确认移除未重填的 env 键」勾选态(有键将丢失时须显式勾选才可保存) */
  confirmEnvDrop: boolean;
}

const emptyForm = (): McpFormState => ({ editing: false, name: '', transport: 'stdio', command: '', args: '', url: '', env: '', origEnvKeys: [], confirmEnvDrop: false });

/** env 文本域 → 已重填键集(与 buildInput 同词法:空值行跳过——「KEY=」预填未重填即视同未覆盖) */
function filledEnvKeys(envText: string): Set<string> {
  const keys = new Set<string>();
  for (const line of envText.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    if (t.slice(eq + 1).trim() === '') continue;
    keys.add(t.slice(0, eq).trim());
  }
  return keys;
}

/** 现清单项目行 → 写面行(env 值打码不可知:省略 env 键,不写空值坏文件) */
function rowToInput(s: McpRow): McpRowInput {
  const out: McpRowInput = { name: s.name, transport: s.transport };
  if (s.command !== undefined) out.command = s.command;
  if (s.args !== undefined) out.args = [...s.args];
  if (s.url !== undefined) out.url = s.url;
  return out;
}

export interface McpPaneProps {
  readonly conn: McpPaneConn;
  /** 项目上下文('' = 仅全局——写面禁用,读面省参) */
  readonly root: string;
}

export function McpPane({ conn, root }: McpPaneProps): JSX.Element {
  const [servers, setServers] = useState<McpRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState<McpFormState | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  /** 探测结果按名落位(卡内结果行);HTTP 层失败也归一为 ok:false 行内呈现 */
  const [probes, setProbes] = useState<Record<string, McpProbeResult>>({});
  const [probing, setProbing] = useState<string[]>([]);
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

  const probe = (name: string): void => {
    setProbing((p) => [...p, name]);
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
  };

  /** 表单行 → McpRowInput(空字段省键;args 逗号分隔;env 逐行 K=V) */
  const buildInput = (f: McpFormState): McpRowInput | string => {
    const name = f.name.trim();
    if (name === '') return '名称不能为空';
    const out: McpRowInput = { name, transport: f.transport };
    if (f.transport === 'stdio') {
      const cmd = f.command.trim();
      if (cmd === '') return 'stdio 传输需要 command';
      out.command = cmd;
    } else {
      const url = f.url.trim();
      if (url === '') return `${f.transport} 传输需要 url`;
      out.url = url;
    }
    const args = f.args.split(',').map((a) => a.trim()).filter((a) => a !== '');
    if (args.length > 0) out.args = args;
    const env: Record<string, string> = {};
    for (const line of f.env.split('\n')) {
      const t = line.trim();
      if (t === '') continue;
      const eq = t.indexOf('=');
      if (eq <= 0) return `env 行格式应为 KEY=VALUE: ${t}`;
      const v = t.slice(eq + 1).trim();
      if (v === '') continue; // KEY= 或 KEY=空白:编辑预填的未重填提示行——空值条目跳过(daemon 原样写盘,{"KEY":""} 是坏文件)
      env[t.slice(0, eq).trim()] = v;
    }
    if (Object.keys(env).length > 0) out.env = env; // 全部空 → env 键整体省略
    return out;
  };

  /** 编辑卡将有丢失的原 env 键(env 文本域未重填值的键)——确认门渲染与 save 守卫共用 */
  const lostEnvKeys: readonly string[] = form === null ? [] : form.origEnvKeys.filter((k) => !filledEnvKeys(form.env).has(k));
  /** env 丢失确认门阻断态(G8c 终审 B):原卡有 env 键且将有键丢失且未勾选确认 */
  const envDropBlocked = form !== null && form.editing && form.origEnvKeys.length > 0 && lostEnvKeys.length > 0 && !form.confirmEnvDrop;

  const save = (): void => {
    if (form === null || saving) return; // root='' 在途表单不静默:空 root 放行,服务端 400 行内示出(AgentsPane 同口径)
    /** env 丢失确认门:钮已 disabled,此守卫拦表单 Enter 提交径(不勾选绝不放行丢键写盘) */
    if (envDropBlocked) {
      setFormError(`有 ${lostEnvKeys.length} 个原 env 键未重填,保存将从 mcp.json 移除——勾选下方确认项后方可保存`);
      return;
    }
    const input = buildInput(form);
    if (typeof input === 'string') {
      setFormError(input);
      return;
    }
    /** 新清单 = 现项目清单(编辑:替换该名;新增:追加)——全局卡不入(写面恒项目级) */
    const current = (servers ?? []).filter((s) => s.source === 'project').map(rowToInput);
    const next = form.editing ? current.map((s) => (s.name === form.name ? input : s)) : [...current, input];
    setSaving(true);
    setFormError('');
    conn.putMcpServers(root, next).then(
      () => {
        setSaving(false);
        setForm(null);
        load(); // 保存后重拉(两级遮蔽重算)
      },
      (err: unknown) => {
        setSaving(false);
        setFormError(errText(err)); // 400 形状/409 注释守卫原文行内
      },
    );
  };

  const remove = (name: string): void => {
    if (root === '') return;
    const next = (servers ?? []).filter((s) => s.source === 'project' && s.name !== name).map(rowToInput);
    conn.putMcpServers(root, next).then(
      () => load(),
      (err: unknown) => setLoadError(errText(err)),
    );
  };

  const scopeTag = (s: McpRow): string => (s.source === 'project' ? '项目' : '全局');

  return (
    <section className="sx-settings-form" aria-label="settings pane MCP">
      <h2>MCP 服务器</h2>
      {root === '' && <p className="home-loading">未选择项目:清单为仅全局视图,添加/编辑/删除需项目上下文(写面为项目级;全局编辑走「高级」)。</p>}
      {loadError !== '' && <p className="home-error" role="alert">{loadError}</p>}
      {servers === null && loadError === '' && <p className="home-loading">加载 MCP 清单…</p>}
      {servers !== null && servers.length === 0 && loadError === '' && <p className="home-loading">无 MCP 服务器。</p>}
      {servers !== null && servers.length > 0 && (
        <ul className="sx-mcp-list">
          {servers.map((s) => {
            const res = probes[s.name];
            return (
              <li key={`${s.source}:${s.name}`} className={`sx-mcp-card${s.shadowed ? ' shadowed' : ''}`}>
                <div className="sx-mcp-head">
                  <span className="sx-mcp-name">{s.name}</span>
                  <SourceBadge source={s.source} />
                  {s.shadowed && <span className="sx-shadow-tag">被项目遮蔽</span>}
                </div>
                <dl className="sx-mcp-meta">
                  <dt>传输</dt>
                  <dd>{s.transport}</dd>
                  {s.command !== undefined && (
                    <>
                      <dt>命令</dt>
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
                      <dt>环境键</dt>
                      <dd>{s.envKeys.join(', ')}</dd>
                    </>
                  )}
                </dl>
                <div className="sx-card-actions">
                  <button type="button" aria-label={`测试连接 ${s.name}`} disabled={probing.includes(s.name)} onClick={() => probe(s.name)}>
                    测试连接
                  </button>
                  <button
                    type="button"
                    aria-label={`编辑 ${s.name}(${scopeTag(s)})`}
                    disabled={s.source !== 'project' || root === ''}
                    title={s.source !== 'project' ? '全局级经高级 raw 编辑' : undefined}
                    onClick={() => {
                      setForm({
                        editing: true,
                        name: s.name,
                        transport: s.transport,
                        command: s.command ?? '',
                        args: s.args !== undefined ? s.args.join(', ') : '',
                        url: s.url ?? '',
                        /** env 值视图打码不可知——预填「KEY=」空值行提示重填(raw 面是原文兜底);
                          origEnvKeys 登记原键(env 丢失确认门判据) */
                        env: s.envKeys.map((k) => `${k}=`).join('\n'),
                        origEnvKeys: [...s.envKeys],
                        confirmEnvDrop: false,
                      });
                      setFormError('');
                    }}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    aria-label={`删除 ${s.name}(${scopeTag(s)})`}
                    disabled={s.source !== 'project' || root === ''}
                    title={s.source !== 'project' ? '全局卡不在项目文件内(全局编辑走「高级」)' : undefined}
                    onClick={() => remove(s.name)}
                  >
                    删除
                  </button>
                </div>
                {res !== undefined &&
                  (res.ok ? (
                    <details className="sx-mcp-probe">
                      <summary>{`连接正常 · 工具 ×${res.tools.length}`}</summary>
                      <ul>
                        {res.tools.map((t) => (
                          <li key={t.name}>{t.name}</li>
                        ))}
                      </ul>
                    </details>
                  ) : (
                    <p className="home-error" role="alert">{res.error}</p>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
      {form !== null && (
        <form
          className="sx-card-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <h3>{form.editing ? `编辑 ${form.name}` : '添加服务器(项目级)'}</h3>
          <label>
            名称
            <input aria-label="mcp name" value={form.name} readOnly={form.editing} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            传输
            <select aria-label="mcp transport" value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value as McpFormState['transport'] })}>
              <option value="stdio">stdio</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </select>
          </label>
          <label>
            command(stdio)
            <input aria-label="mcp command" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="npx" />
          </label>
          <label>
            args(逗号分隔)
            <input aria-label="mcp args" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} placeholder="-y, mcp-server" />
          </label>
          <label>
            url(http/sse)
            <input aria-label="mcp url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…" />
          </label>
          <label>
            env(逐行 KEY=VALUE)
            <textarea aria-label="mcp env" value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} rows={3} spellCheck={false} />
          </label>
          {form.editing && form.origEnvKeys.length > 0 && lostEnvKeys.length > 0 && (
            <label className="sx-check-row">
              <input
                type="checkbox"
                aria-label="confirm env drop"
                checked={form.confirmEnvDrop}
                onChange={(e) => setForm({ ...form, confirmEnvDrop: e.target.checked })}
              />
              {`确认移除未重填的 ${lostEnvKeys.length} 个 env 键`}
            </label>
          )}
          {formError !== '' && <p className="home-error" role="alert">{formError}</p>}
          <div className="sx-card-actions">
            <button type="submit" disabled={saving || envDropBlocked}>
              保存
            </button>
            <button
              type="button"
              onClick={() => {
                setForm(null);
                setFormError('');
              }}
            >
              取消
            </button>
          </div>
        </form>
      )}
      <button type="button" className="sx-add-button" disabled={root === ''} onClick={() => { setForm(emptyForm()); setFormError(''); }}>
        + 添加服务器
      </button>
    </section>
  );
}
