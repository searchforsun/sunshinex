import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { t } from '../i18n';
import { errText } from '../ui-util';
import type { McpRow, McpProbeResult, McpOpInput } from '../connection';
import { EditorDrawer, EmptyState, ErrorBanner, ResourceCard, SearchBar } from './components';
import type { SettingsScope } from './components';

/**
 * Task 22 McpPane 重构(Phase F 首面板,2026-10-28):一屏式卡片列表——写面全部走
 * PUT /settings/mcp/op 单条目操作端点(T15),原「整块 PUT /settings/mcp + raw 读改写
 * (mutateProjectMcp)+ 内联 JSON textarea 编辑窗」路径整体退役。
 *
 * 结构(T21 共享组件 verbatim 消费):顶栏 SearchBar(200ms 防抖过滤 name/command/url)
 * + 「+ Add」钮;主体 ul.sx-rc-list × ResourceCard(icon=探测状态点/title=名/subtitle=
 * 命令行|url/chips=transport+env·header 键+批准阀/badge=SourceBadge/开关=启停);
 * 添加/编辑 → EditorDrawer 右滑抽屉(名称/transport select/command|url/args 逐行
 * textarea/env 键值行)+「JSON 源码」高级折叠(展开即按当前表单预览;提交时非空则
 * JSON.parse+单条形状校验+与名称字段一致门,整条以 JSON 为准——隐藏值(headers/enabled/
 * disabledTools)由此保全)。
 *
 * 作用域语义(壳 ScopeSwitcher 下发):scope='project'(缺省,有 root 时)读两级清单
 * (GET 带 root,项目先全局后)——项目卡可写(op scope='project' 带 root),全局同名卡
 * 「被项目遮蔽」灰标+写钮全禁用(切全局作用域可编辑);scope='global' 读仅全局清单
 * (GET 省参)——全局卡可写(op scope='global' 省参 root)。root='' 恒强制 global。
 *
 * 批准阀(T15 approval 字段):项目卡 approval='pending' → warn 边框+「待审批」chip+
 * Approve/Deny 钮(op approve/deny,仅 project 合法——global 不过阀);'denied' →
 * 「已拒绝」chip+Approve 钮(复批互斥写面回收)。
 *
 * 值打码边界:GET 视图 env/headers 只回键名——表单编辑/逐工具开关改条目前经
 * settingsRaw 读原文条目作 seed(值保全预填;文件含注释/畸形时降级行视图字段起步,
 * 隐藏值丢失风险以抽屉内提示引流「JSON 源码」)。409(内容/写面错误,hint
 * 'use raw editor')与 400(HTTP 失败)统一 errText 行内 ErrorBanner 呈现。
 *
 * 探测面沿 2026-10-26 四轮改版保留:挂载即逐台真探测(绿/红/灰点,停用卡不探),
 * 手动「测试连接」可重探;探测结果内联工具清单(逐工具开关=disabledTools 短名增删,
 * seed 读改写+op add 落盘);开关变更「新会话生效」。config-changed 订阅:壳下发
 * refreshTick(mcp 资源计数)变化即重拉(外部改动信号,零轮询)。
 */

/** MCP 面连接面(结构满足即收,App 传整只 Connection);settingsRaw 签名与 RawPane
 *  同宽(file: 'settings'|'mcp'——SettingsShell 同时 extends 两面,同名成员须同一性;
 *  T22 起只读用于编辑 seed 预填,raw 写面路径已退役)。putMcpOp=T15 op 端点写面 */
export interface McpPaneConn {
  mcpServers(root?: string): Promise<{ servers: McpRow[] }>;
  mcpProbe(root: string | undefined, name: string): Promise<McpProbeResult>;
  putMcpOp(input: McpOpInput): Promise<void>;
  settingsRaw(scope: 'project' | 'global', root: string | undefined, file: 'settings' | 'mcp'): Promise<{ content: string | null }>;
}

/** 状态点三态:ok=绿(连接正常)/err=红(连接失败)/probe=灰(探测中)/off=灰环(整机停用,不探测) */
type McpDotState = 'ok' | 'err' | 'probe' | 'off';

/** 抽屉表单态(受控单对象;setForm 局部覆写) */
interface DrawerForm {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command: string;
  url: string;
  /** args 逐行:一行一个参数(空行滤除) */
  argsText: string;
  /** env 键值行(值面可编辑;键空行忽略) */
  envRows: Array<{ k: string; v: string }>;
  /** 「JSON 源码」高级折叠开合(受控——jsdom/键盘同径);非空即提交时整条以 JSON 为准 */
  jsonOpen: boolean;
  jsonText: string;
}

/** 抽屉会话态:add=新增;edit=编辑某卡(source=写作用域,original=改名换键的旧名)。
 *  seed=raw 原文该条目(编辑/逐工具开关的值保全底稿;null=不可得——行视图字段起步);
 *  seedRest=seed 中表单不建模的其余键(headers/enabled/disabledTools…,提交透传保全);
 *  seedNote=seed 不可得时的降级提示(引流「JSON 源码」) */
type DrawerState =
  | { mode: 'add'; source: 'project' | 'global' }
  | { mode: 'edit'; source: 'project' | 'global'; original: string; seed: Record<string, unknown> | null; seedRest: Record<string, unknown>; seedNote: string };

const EMPTY_FORM: DrawerForm = { name: '', transport: 'stdio', command: '', url: '', argsText: '', envRows: [], jsonOpen: false, jsonText: '' };

export interface McpPaneProps {
  readonly conn: McpPaneConn;
  /** 项目上下文('' = 无项目上下文——恒全局作用域) */
  readonly root: string;
  /** T21 设置壳注入:作用域(缺省按 root 推断——有 root 即 project,壳缺省同款) */
  readonly scope?: SettingsScope;
  /** T21 config-changed 订阅 tick(mcp 资源计数——外部改动信号,变化即重拉) */
  readonly refreshTick?: number;
}

export function McpPane({ conn, root, scope, refreshTick }: McpPaneProps): JSX.Element {
  const [servers, setServers] = useState<McpRow[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  /** 探测结果按名落位(卡内状态点+工具清单);HTTP 层失败也归一为 ok:false 行内呈现 */
  const [probes, setProbes] = useState<Record<string, McpProbeResult>>({});
  const [probing, setProbing] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [form, setForm] = useState<DrawerForm>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  /** 挂载自动探测去重面(状态圆点数据源):每名一次,重拉清单不重探;作用域切换经 fetchKey 复位放行重探 */
  const autoProbed = useRef<Set<string>>(new Set());

  /** 作用域裁定:壳下发优先,缺省按 root 推断(壳缺省同款——无 root 强制 global) */
  const myScope: SettingsScope = scope ?? (root === '' ? 'global' : 'project');
  /** 读面取参:project 作用域带 root(两级清单),global 作用域省参(仅全局清单) */
  const fetchRoot = myScope === 'project' && root !== '' ? root : undefined;

  const load = useCallback((): void => {
    conn.mcpServers(fetchRoot).then(
      (v) => {
        setServers(v.servers);
        setLoadError('');
      },
      (err: unknown) => setLoadError(errText(err)),
    );
  }, [conn, fetchRoot]);

  useEffect(() => {
    load();
  }, [load, refreshTick]); // refreshTick 变化=外部改动信号 → 重拉(config-changed 订阅消费面)

  /** 作用域/清单切换复位探测面(旧作用域的探测结果不串屏) */
  const fetchKey = fetchRoot ?? '';
  useEffect(() => {
    setProbes({});
    setProbing([]);
    autoProbed.current.clear();
  }, [fetchKey]);

  const probe = useCallback(
    (name: string): void => {
      setProbing((p) => (p.includes(name) ? p : [...p, name]));
      conn.mcpProbe(fetchRoot, name).then(
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
    [conn, fetchRoot],
  );

  /** 挂载自动探测(状态圆点数据源):每名一次,重拉清单不重探(手动「测试连接」可重探);
   *  作用域切换经 fetchKey 复位放行重探 */
  useEffect(() => {
    if (servers === null) return;
    for (const s of servers) {
      if (s.enabled === false || autoProbed.current.has(s.name)) continue;
      autoProbed.current.add(s.name);
      probe(s.name);
    }
  }, [servers, probe]);

  /** 写作用域守卫:项目卡=project 作用域且有 root;全局卡=global 作用域(被遮蔽卡只出现在
   *  project 视图,天然不可写)。不可写卡:开关不下发(无 switch)+ Edit/Delete disabled+tip */
  const canWrite = (s: McpRow): boolean =>
    s.source === 'project' ? myScope === 'project' && root !== '' : myScope === 'global';

  /** op 输入按卡作用域取参单点:project 带 root、global 省参(input 原文即请求体,不留空串伪参) */
  const opFor = (s: McpRow, op: McpOpInput['op'], server?: Record<string, unknown>): McpOpInput => ({
    op,
    scope: s.source,
    ...(s.source === 'project' ? { root } : {}),
    name: s.name,
    ...(server !== undefined ? { server } : {}),
  });

  /** op 写回收口单点:saving 门 → putMcpOp → 成功重拉(失败 saving 复位+行内错误条;
   *  409 hint 'use raw editor' 由 errText 呈现 status 行,引流 raw 编辑面) */
  const runOp = (input: McpOpInput): void => {
    if (saving) return;
    setSaving(true);
    setActionError('');
    conn
      .putMcpOp(input)
      .then(() => {
        setSaving(false);
        load();
      })
      .catch((err: unknown) => {
        setSaving(false);
        setActionError(errText(err));
      });
  };

  /** raw 原文条目读取(编辑 seed/逐工具开关底稿):content 缺/条目缺 → null;文件不可解析 →
   *  抛错(调用方行内呈报——引流「JSON 源码」/raw 编辑面) */
  const readSeedEntry = async (s: McpRow): Promise<Record<string, unknown> | null> => {
    const { content } = await conn.settingsRaw(s.source, s.source === 'project' ? root : undefined, 'mcp');
    if (content === null) return null;
    let doc: unknown;
    try {
      doc = JSON.parse(content);
    } catch {
      throw new Error(t('mcp.json contains comments or invalid JSON — masked values unavailable; use the JSON source panel', 'mcp.json 含注释或非法 JSON——打码值不可得;请用「JSON 源码」面板'));
    }
    const entry = (doc as { mcpServers?: Record<string, unknown> } | null)?.mcpServers?.[s.name];
    return entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? { ...(entry as Record<string, unknown>) } : null;
  };

  /** 抽屉打开(添加=空表单;编辑=raw seed 预填,值保全;seed 不可得降级行字段起步+提示) */
  const openDrawer = async (s: McpRow | null): Promise<void> => {
    setFormError('');
    if (s === null) {
      setForm(EMPTY_FORM);
      setDrawer({ mode: 'add', source: myScope });
      return;
    }
    let seed: Record<string, unknown> | null = null;
    let seedNote = '';
    try {
      seed = await readSeedEntry(s);
      if (seed === null) seedNote = t('Entry not found in file — starting from the list view fields', '文件内未找到该条目——以清单视图字段起步');
    } catch (err: unknown) {
      seedNote = errText(err);
    }
    const rest: Record<string, unknown> = { ...seed };
    for (const k of ['transport', 'command', 'url', 'args', 'env']) delete rest[k];
    setForm({
      name: s.name,
      transport: s.transport,
      command: seed !== null && typeof seed.command === 'string' ? seed.command : (s.command ?? ''),
      url: seed !== null && typeof seed.url === 'string' ? seed.url : (s.url ?? ''),
      argsText: (seed !== null && Array.isArray(seed.args) ? (seed.args as unknown[]).map(String) : (s.args ?? [])).join('\n'),
      envRows: Object.entries(
        seed !== null && seed.env !== null && typeof seed.env === 'object' && !Array.isArray(seed.env)
          ? (seed.env as Record<string, string>)
          : {},
      ).map(([k, v]) => ({ k, v: String(v) })),
      jsonOpen: false,
      jsonText: '',
    });
    setDrawer({ mode: 'edit', source: s.source, original: s.name, seed, seedRest: rest, seedNote });
  };

  /** 表单当前值 → server 条目对象(seedRest 透传保全表单外键;transport 显式;stdio=command、
   *  http/sse=url;args 逐行非空才落键;env 非空对才落键) */
  const buildServer = (seedRest: Record<string, unknown>): Record<string, unknown> => {
    const server: Record<string, unknown> = { ...seedRest, transport: form.transport };
    if (form.transport === 'stdio') {
      server.command = form.command;
      delete server.url;
    } else {
      server.url = form.url;
      delete server.command;
    }
    const args = form.argsText.split(/\r?\n/).map((a) => a.trim()).filter((a) => a !== '');
    if (args.length > 0) server.args = args;
    else delete server.args;
    const env: Record<string, string> = {};
    for (const r of form.envRows) {
      if (r.k.trim() !== '') env[r.k.trim()] = r.v;
    }
    if (Object.keys(env).length > 0) server.env = env;
    else delete server.env;
    return server;
  };

  /** 抽屉保存:add=op add;edit=op add(改名再 op remove 旧键——两段顺序落盘)。
   *  「JSON 源码」非空 → 整条以 JSON 为准(parse+单条对象+与名称一致门);否则表单组装 */
  const submitDrawer = (): void => {
    if (drawer === null || saving) return;
    const name = form.name.trim();
    if (name === '') {
      setFormError(t('Server name must be non-empty', '服务器名不能为空'));
      return;
    }
    let server: Record<string, unknown>;
    if (form.jsonText.trim() !== '') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(form.jsonText);
      } catch (e) {
        setFormError(t(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`, `JSON 非法: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setFormError(t('Expected an object: { "<name>": { … } }', '应为对象形态: { "<名称>": { … } }'));
        return;
      }
      const entries = Object.entries(parsed as Record<string, unknown>);
      if (entries.length !== 1) {
        setFormError(t('Exactly one server entry expected (top-level key = server name)', '只能有一个服务器条目(顶层键=服务器名)'));
        return;
      }
      const [key, cfg] = entries[0]!;
      if (key !== name) {
        setFormError(t('JSON entry key must match the Name field', 'JSON 条目键须与「名称」字段一致'));
        return;
      }
      if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
        setFormError(t('Server config must be an object', '服务器配置必须是对象'));
        return;
      }
      server = cfg as Record<string, unknown>;
    } else {
      if (form.transport === 'stdio' && form.command.trim() === '') {
        setFormError(t('stdio transport requires a command', 'stdio 传输需要命令'));
        return;
      }
      if (form.transport !== 'stdio' && form.url.trim() === '') {
        setFormError(t('http/sse transport requires a URL', 'http/sse 传输需要 URL'));
        return;
      }
      server = buildServer(drawer.mode === 'edit' ? drawer.seedRest : {});
    }
    setSaving(true);
    setFormError('');
    const scope = drawer.source;
    const rootArg = scope === 'project' ? root : undefined;
    conn
      .putMcpOp({ op: 'add', scope, ...(scope === 'project' ? { root: rootArg } : {}), name, server })
      .then(async () => {
        // 编辑改名=换键:新键落定后移除旧键(op 无原子改名——add/remove 两段)
        if (drawer.mode === 'edit' && drawer.original !== name) {
          await conn.putMcpOp({ op: 'remove', scope, ...(scope === 'project' ? { root: rootArg } : {}), name: drawer.original });
        }
      })
      .then(() => {
        setSaving(false);
        setDrawer(null);
        autoProbed.current.delete(name);
        load();
      })
      .catch((err: unknown) => {
        setSaving(false);
        setFormError(errText(err));
      });
  };

  /** 逐工具开关:disabledTools 短名增删(空数组整键移除)——seed 读改写值保全 → op add 落盘 */
  const toggleTool = (s: McpRow, tool: string): void => {
    if (!canWrite(s) || saving) return;
    setSaving(true);
    setActionError('');
    readSeedEntry(s)
      .then((seed) => {
        if (seed === null) throw new Error(t('Entry not found in file — edit via the JSON source panel', '文件内未找到该条目——请经「JSON 源码」面板编辑'));
        const cur = new Set(Array.isArray(seed.disabledTools) ? (seed.disabledTools as unknown[]).map(String) : (s.disabledTools ?? []));
        if (cur.has(tool)) cur.delete(tool);
        else cur.add(tool);
        if (cur.size === 0) delete seed.disabledTools;
        else seed.disabledTools = [...cur].sort();
        return conn.putMcpOp(opFor(s, 'add', seed));
      })
      .then(() => {
        setSaving(false);
        load();
      })
      .catch((err: unknown) => {
        setSaving(false);
        setActionError(errText(err));
      });
  };

  const dotOf = (s: McpRow): McpDotState => {
    if (s.enabled === false) return 'off';
    if (probing.includes(s.name)) return 'probe';
    const res = probes[s.name];
    if (res === undefined) return 'probe';
    return res.ok ? 'ok' : 'err';
  };

  /** 过滤面:name/command/url 大小写不敏感包含 */
  const needle = query.trim().toLowerCase();
  const visible = (servers ?? []).filter((s) =>
    needle === '' ? true : `${s.name} ${s.command ?? ''} ${s.url ?? ''}`.toLowerCase().includes(needle),
  );

  /** 卡副题:stdio=命令行(命令+args)/http·sse=url */
  const subtitleOf = (s: McpRow): string | undefined =>
    s.transport === 'stdio'
      ? s.command === undefined
        ? undefined
        : s.args !== undefined && s.args.length > 0
          ? `${s.command} ${s.args.join(' ')}`
          : s.command
      : s.url;

  /** 卡 chips:transport + env/header 键(值打码) + 停用工具计数 + 批准阀态 */
  const chipsOf = (s: McpRow): ReactNode => (
    <>
      <span className="sx-chip">{s.transport}</span>
      {s.envKeys.map((k) => (
        <span key={k} className="sx-chip">
          {k}
        </span>
      ))}
      {s.headerKeys.map((k) => (
        <span key={k} className="sx-chip">
          {k}
        </span>
      ))}
      {s.disabledTools !== undefined && s.disabledTools.length > 0 && (
        <span className="sx-chip">{t(`${s.disabledTools.length} tools disabled`, `停用工具 ×${s.disabledTools.length}`)}</span>
      )}
      {s.approval === 'pending' && <span className="sx-chip sx-mcp-gate">{t('Pending approval', '待审批')}</span>}
      {s.approval === 'denied' && <span className="sx-chip sx-mcp-denied">{t('Denied', '已拒绝')}</span>}
      {s.shadowed && <span className="sx-shadow-tag">{t('Shadowed by project', '被项目遮蔽')}</span>}
    </>
  );

  /** 折叠详情:元数据 dl + 探测结果(连通=工具清单逐工具开关;失败=行内报错) */
  const detailsOf = (s: McpRow): ReactNode => {
    const res = probes[s.name];
    const writable = canWrite(s);
    return (
      <>
        <dl className="sx-mcp-meta">
          <dt>{t('Transport', '传输')}</dt>
          <dd>{s.transport}</dd>
          {s.command !== undefined && (
            <>
              <dt>{t('Command', '命令')}</dt>
              <dd>{s.command}</dd>
            </>
          )}
          {s.args !== undefined && s.args.length > 0 && (
            <>
              <dt>{t('Arguments', '参数')}</dt>
              <dd>{s.args.join(' ')}</dd>
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
        {res !== undefined &&
          (res.ok ? (
            <div className="sx-mcp-probe-body">
              <p className="sx-mcp-probe-summary">{t(`Connected · ${res.tools.length} tools`, `连接正常 · 工具 ×${res.tools.length}`)}</p>
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
                        aria-label={tl.name}
                        data-tip={tl.description !== undefined && tl.description !== '' ? tl.description : undefined}
                        disabled={!writable || saving}
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
              {writable && <p className="sx-mcp-hint">{t('Toggles take effect on next session', '开关变更对新会话生效')}</p>}
            </div>
          ) : (
            <p className="home-error" role="alert">
              {res.error}
            </p>
          ))}
      </>
    );
  };

  return (
    <section className="sx-settings-form" aria-label="settings pane MCP">
      <h2>{t('MCP servers', 'MCP 服务器')}</h2>
      <div className="sx-mcp-toolbar">
        <SearchBar value={query} onChange={setQuery} placeholder={t('Search MCP servers', '搜索 MCP 服务器')} />
        <button type="button" className="sx-add-button" onClick={() => void openDrawer(null)}>
          {t('+ Add', '+ 添加')}
        </button>
      </div>
      {loadError !== '' && <ErrorBanner text={loadError} />}
      {actionError !== '' && <ErrorBanner text={actionError} />}
      {servers === null && loadError === '' && <EmptyState text={t('Loading MCP servers…', '加载 MCP 清单…')} />}
      {servers !== null && servers.length === 0 && <EmptyState text={t('No MCP servers.', '无 MCP 服务器。')} />}
      {servers !== null && servers.length > 0 && visible.length === 0 && <EmptyState text={t('No matches.', '无匹配结果。')} />}
      {visible.length > 0 && (
        <ul className="sx-rc-list">
          {visible.map((s) => {
            const writable = canWrite(s);
            const enabled = s.enabled !== false;
            const gate = s.source === 'project' && myScope === 'project' && (s.approval === 'pending' || s.approval === 'denied');
            const globalTip = t('Switch to Global scope to edit', '切到全局作用域可编辑');
            return (
              <ResourceCard
                key={`${s.source}:${s.name}`}
                icon={<span className={`sx-mcp-dot ${dotOf(s)}`} aria-hidden="true" data-tip={t('Connected', '连接正常')} />}
                title={s.name}
                subtitle={subtitleOf(s)}
                chips={chipsOf(s)}
                badge={{ source: s.source }}
                enabled={enabled}
                onToggle={writable ? () => runOp(opFor(s, enabled ? 'disable' : 'enable')) : undefined}
                actions={
                  <>
                    <button
                      type="button"
                      aria-label={`${t('Test connection', '测试连接')} ${s.name}`}
                      disabled={probing.includes(s.name)}
                      onClick={() => probe(s.name)}
                    >
                      {t('Test', '测试')}
                    </button>
                    {gate && (
                      <button type="button" aria-label={`${t('Approve', '批准')} ${s.name}`} disabled={saving} onClick={() => runOp(opFor(s, 'approve'))}>
                        {t('Approve', '批准')}
                      </button>
                    )}
                    {gate && s.approval === 'pending' && (
                      <button type="button" aria-label={`${t('Deny', '拒绝')} ${s.name}`} disabled={saving} onClick={() => runOp(opFor(s, 'deny'))}>
                        {t('Deny', '拒绝')}
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`${t('Edit', '编辑')} ${s.name}(${s.source === 'project' ? t('Project', '项目') : t('Global', '全局')})`}
                      disabled={!writable || saving}
                      data-tip={writable ? undefined : globalTip}
                      onClick={() => void openDrawer(s)}
                    >
                      {t('Edit', '编辑')}
                    </button>
                    <button
                      type="button"
                      aria-label={`${t('Delete', '删除')} ${s.name}(${s.source === 'project' ? t('Project', '项目') : t('Global', '全局')})`}
                      disabled={!writable || saving}
                      data-tip={writable ? undefined : globalTip}
                      onClick={() => runOp(opFor(s, 'remove'))}
                    >
                      {t('Delete', '删除')}
                    </button>
                  </>
                }
              >
                {detailsOf(s)}
              </ResourceCard>
            );
          })}
        </ul>
      )}
      {drawer !== null && (
        <EditorDrawer
          open
          title={drawer.mode === 'add' ? t('Add MCP server', '添加 MCP 服务器') : t(`Edit ${drawer.original}`, `编辑 ${drawer.original}`)}
          onClose={() => setDrawer(null)}
          onSubmit={submitDrawer}
        >
          {drawer.mode === 'edit' && drawer.seedNote !== '' && <p className="sx-mcp-hint">{drawer.seedNote}</p>}
          <p className="sx-mcp-hint">
            {t(
              'Env/header values are masked — saving rewrites the whole entry; use JSON source to preserve hidden values.',
              '环境变量/请求头值已打码——保存将整条改写;需保全隐藏值请用「JSON 源码」。',
            )}
          </p>
          <label className="sx-drawer-field">
            {t('Name', '名称')}
            <input aria-label={t('Name', '名称')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} spellCheck={false} />
          </label>
          <label className="sx-drawer-field">
            {t('Transport', '传输')}
            <select
              aria-label={t('Transport', '传输')}
              value={form.transport}
              onChange={(e) => setForm({ ...form, transport: e.target.value as DrawerForm['transport'] })}
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </select>
          </label>
          {form.transport === 'stdio' ? (
            <label className="sx-drawer-field">
              {t('Command', '命令')}
              <input aria-label={t('Command', '命令')} value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} spellCheck={false} />
            </label>
          ) : (
            <label className="sx-drawer-field">
              URL
              <input aria-label="URL" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} spellCheck={false} />
            </label>
          )}
          <label className="sx-drawer-field">
            {t('Arguments (one per line)', '参数(每行一个)')}
            <textarea
              aria-label={t('Arguments (one per line)', '参数(每行一个)')}
              value={form.argsText}
              onChange={(e) => setForm({ ...form, argsText: e.target.value })}
              rows={3}
              spellCheck={false}
            />
          </label>
          <div className="sx-drawer-field">
            {t('Env (key / value)', '环境变量(键/值)')}
            {form.envRows.map((r, i) => (
              <div key={i} className="sx-mcp-envrow">
                <input
                  aria-label={t('Env key', '环境键')}
                  value={r.k}
                  onChange={(e) => setForm({ ...form, envRows: form.envRows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)) })}
                  spellCheck={false}
                />
                <input
                  aria-label={t('Env value', '环境值')}
                  value={r.v}
                  onChange={(e) => setForm({ ...form, envRows: form.envRows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)) })}
                  spellCheck={false}
                />
                <button
                  type="button"
                  aria-label={`${t('Remove env row', '移除环境行')} ${i + 1}`}
                  onClick={() => setForm({ ...form, envRows: form.envRows.filter((_, j) => j !== i) })}
                >
                  ×
                </button>
              </div>
            ))}
            <button type="button" onClick={() => setForm({ ...form, envRows: [...form.envRows, { k: '', v: '' }] })}>
              {t('+ Add env', '+ 添加环境变量')}
            </button>
          </div>
          <details className="sx-rc-details sx-mcp-json-adv" open={form.jsonOpen}>
            <summary
              onClick={(e) => {
                // 受控开合(preventDefault 拦原生 toggle——jsdom/键盘同径);首次展开按当前表单
                // 预览单条 JSON(顶层键=名称——提交一致性门同源)
                e.preventDefault();
                const next = !form.jsonOpen;
                setForm((f) => ({
                  ...f,
                  jsonOpen: next,
                  jsonText:
                    next && f.jsonText.trim() === ''
                      ? JSON.stringify({ [f.name.trim() === '' ? 'new-server' : f.name.trim()]: buildServerForPreview(f, drawer) }, null, 2)
                      : f.jsonText,
                }));
              }}
            >
              {t('JSON source', 'JSON 源码')}
            </summary>
            <textarea
              aria-label={t('Server JSON', '服务器 JSON')}
              className="sx-mcp-json"
              value={form.jsonText}
              onChange={(e) => setForm({ ...form, jsonText: e.target.value })}
              rows={10}
              spellCheck={false}
            />
          </details>
          {formError !== '' && <ErrorBanner text={formError} />}
        </EditorDrawer>
      )}
    </section>
  );
}

/** JSON 源码首展预览:按当前表单组装单条对象(与提交组装同形;编辑态透传 seedRest 保全表单外键) */
function buildServerForPreview(f: DrawerForm, drawer: DrawerState | null): Record<string, unknown> {
  const server: Record<string, unknown> = { ...(drawer !== null && drawer.mode === 'edit' ? drawer.seedRest : {}), transport: f.transport };
  if (f.transport === 'stdio') {
    if (f.command.trim() !== '') server.command = f.command;
    delete server.url;
  } else {
    if (f.url.trim() !== '') server.url = f.url;
    delete server.command;
  }
  const args = f.argsText.split(/\r?\n/).map((a) => a.trim()).filter((a) => a !== '');
  if (args.length > 0) server.args = args;
  const env: Record<string, string> = {};
  for (const r of f.envRows) {
    if (r.k.trim() !== '') env[r.k.trim()] = r.v;
  }
  if (Object.keys(env).length > 0) server.env = env;
  return server;
}
