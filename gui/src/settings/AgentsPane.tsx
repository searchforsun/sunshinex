import { useCallback, useEffect, useState } from 'react';
import type { AgentEntryView, AgentFrontmatterInput, AgentsView, BuiltinRole } from '../connection';
import { SourceBadge } from './SourceBadge';

/**
 * G8c T9 智能体面板:内建预设 + 两级注册清单 + agent.md 生成式增删改。
 * - mount 拉 conn.agentsView(root):builtins 四预设只读卡(role/name/framing 摘要)+
 *   entries 卡(id/name/description + 属性 chips:memory/isolation/executor + SourceBadge +
 *   shadowed 灰显「被项目遮蔽」+ bodyPreview 折叠)+ warnings 告警卡(畸形存量文件不抛死)。
 * - 「+ 新增」/卡「编辑」→ 表单(scope select(project/global)/id(新增可编辑,编辑只读——
 *   id 是目录名)/name/description/memory checkbox/isolation/executor/body textarea);
 *   「保存」=conn.putAgent({root?, scope, op:'upsert', id, frontmatter, body})→ 重拉。
 *   G8d-T3 全文装载:编辑钮先以 bodyPreview 播种(即时开表单),再 conn.agentBody(source,
 *   id, root) 拉正文全文升级播种——成功则截断守卫对该表单退役;失败回退 bodyPreview+行内提示
 *   (守卫保留为兜底——全文装载失败时防截断文写盘)。编辑卡守卫(G8c 终审 A):播种面触 200
 *   截断帽(=bodyPreview 预览切片)且未改写 → 阻断保存行内示错(防截断文写盘毁余文);已改写=
 *   有意重写放行,完整原文兜底走 agents/<id>/agent.md 直接编辑。
 *   frontmatter 缺省键不落(name 必填;空串可选键省略;memory 仅 true 落)——与 daemon
 *   「input 原文即请求体(缺省字段不落 JSON)」契约对齐。scope=project 需 root(无 root 时
 *   项目选项禁用——写面守卫,余走服务端 400 面行内示出)。
 * - 「删除」=putAgent op:'delete'(scope=卡 source;global 删无需 root)。
 */

/** putAgent 输入形(connection.ts 内联签名的结构等价声明——不引服务端类型) */
export interface PutAgentInput {
  root?: string;
  scope: 'project' | 'global';
  op: 'upsert' | 'delete';
  id: string;
  frontmatter?: AgentFrontmatterInput;
  body?: string;
}

/** 智能体面连接面(结构满足即收,App 传整只 Connection) */
export interface AgentsPaneConn {
  agentsView(root?: string): Promise<{ builtins: BuiltinRole[]; view: AgentsView }>;
  putAgent(input: PutAgentInput): Promise<void>;
  /** G8d-T3 正文全文(agent.md frontmatter 后正文;AgentsPane 编辑播种升级面) */
  agentBody(scope: 'project' | 'global', id: string, root?: string): Promise<{ body: string }>;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** id 安全面(daemon AGENT_ID_RE 同款:id 拼目录路径——路径分隔/点开头一律拒) */
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** daemon bodyPreview 截断帽(subagent.ts slice(0,200) 同款):长度触帽即原文可能被截——编辑守卫判据 */
const BODY_PREVIEW_CAP = 200;

/** 表单态(editing=true 时 id 锁定;seededBody=编辑播种的正文(bodyPreview 回退面/全文升级面)
 *  ——截断守卫比对基线;bodyFull=true 表示已升级全文装载,守卫对该表单退役) */
interface AgentFormState {
  scope: 'project' | 'global';
  readonly editing: boolean;
  readonly id: string;
  name: string;
  description: string;
  memory: boolean;
  isolation: string;
  executor: string;
  body: string;
  /** 编辑播种的正文原文——save 守卫判「用户是否已改写」的基线 */
  readonly seededBody: string;
  /** true = 正文已升级为 agent.md 全文(agentBody 成功)——无截断风险,守卫退役 */
  readonly bodyFull: boolean;
}

export interface AgentsPaneProps {
  readonly conn: AgentsPaneConn;
  /** 项目上下文('' = 仅全局——scope=project 禁选) */
  readonly root: string;
}

export function AgentsPane({ conn, root }: AgentsPaneProps): JSX.Element {
  const [data, setData] = useState<{ builtins: BuiltinRole[]; view: AgentsView } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState<AgentFormState | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const r = root === '' ? undefined : root;

  const load = useCallback((): void => {
    conn.agentsView(r).then(
      (v) => {
        setData(v);
        setLoadError('');
      },
      (err: unknown) => setLoadError(errText(err)),
    );
  }, [conn, r]);

  useEffect(() => {
    load();
  }, [load]);

  const save = (): void => {
    if (form === null || saving) return;
    const id = form.id.trim();
    const name = form.name.trim();
    if (form.editing === false && !AGENT_ID_RE.test(id)) {
      setFormError('id 须匹配 /^[A-Za-z0-9][A-Za-z0-9_-]*$/(用作目录名)');
      return;
    }
    if (name === '') {
      setFormError('name 必填(frontmatter 首键)');
      return;
    }
    /** G8c 终审 A 截断守卫(全文装载失败的兜底面):播种面是 bodyPreview(200 字切片)时,长度触帽
     *  即原文可能被截,未改正文(仍=播种值)直接保存会把截断文写盘毁掉余文;用户已改写(≠播种值)
     *  =有意重写放行。bodyFull(全文装载成功)无截断风险——守卫退役。 */
    if (form.editing && !form.bodyFull && form.seededBody.length >= BODY_PREVIEW_CAP && form.body === form.seededBody) {
      setFormError(`原文可能超过 ${BODY_PREVIEW_CAP} 字符已被预览截断——请改写完整正文后保存,或直接编辑 agents/${id}/agent.md 文件`);
      return;
    }
    /** 缺省字段不落请求体:可选键空串省略、memory 仅 true 落(daemon 单行 KV 词法约束) */
    const frontmatter: AgentFrontmatterInput = { name };
    if (form.description.trim() !== '') frontmatter.description = form.description.trim();
    if (form.memory) frontmatter.memory = true;
    if (form.isolation.trim() !== '') frontmatter.isolation = form.isolation.trim();
    if (form.executor.trim() !== '') frontmatter.executor = form.executor.trim();
    setSaving(true);
    setFormError('');
    conn.putAgent({ root: form.scope === 'project' ? root : undefined, scope: form.scope, op: 'upsert', id, frontmatter, body: form.body }).then(
      () => {
        setSaving(false);
        setForm(null);
        load(); // 保存后重拉(两级清单+遮蔽重算)
      },
      (err: unknown) => {
        setSaving(false);
        setFormError(errText(err)); // 400 校验面原文行内
      },
    );
  };

  const remove = (entry: AgentEntryView): void => {
    conn.putAgent({ root: entry.source === 'project' ? root : undefined, scope: entry.source, op: 'delete', id: entry.id }).then(
      () => load(),
      (err: unknown) => setLoadError(errText(err)),
    );
  };

  /** G8d-T3 全文装载:agentBody(source,id,root) 成功 → 正文升级全文(用户已动手改写则不覆盖,
   *  以其输入为准);失败 → 回退预览态(bodyPreview 已播种)+ 行内提示(截断守卫兜底生效)。 */
  const seedFullBody = (entry: AgentEntryView): void => {
    conn.agentBody(entry.source, entry.id, root === '' ? undefined : root).then(
      ({ body }) => {
        setForm((f) =>
          f !== null && f.editing && f.id === entry.id && f.scope === entry.source && f.body === f.seededBody
            ? { ...f, body, seededBody: body, bodyFull: true }
            : f,
        );
      },
      (err: unknown) => {
        // 晚到的装载失败不覆盖其后已示出的保存面错误(截断守卫/服务端 400)——仅空错误位时落
        const msg = `正文全文装载失败,已回退预览:${errText(err)}`;
        setFormError((prev) => (prev === '' ? msg : prev));
      },
    );
  };

  const scopeTag = (source: AgentEntryView['source']): string => (source === 'project' ? '项目' : '全局');

  return (
    <section className="sx-settings-form" aria-label="settings pane 智能体">
      <h2>智能体</h2>
      {root === '' && <p className="home-loading">未选择项目:清单为仅全局视图(scope=项目需项目上下文)。</p>}
      {loadError !== '' && <p className="home-error" role="alert">{loadError}</p>}
      {data === null && loadError === '' && <p className="home-loading">加载智能体清单…</p>}
      {data !== null && (
        <>
          <h3>内建角色(只读)</h3>
          <ul className="sx-agent-builtins">
            {data.builtins.map((b) => (
              <li key={b.role} className="sx-agent-builtin">
                <div className="sx-agent-head">
                  <span className="sx-agent-id">{b.role}</span>
                  <span className="sx-agent-name">{b.name}</span>
                </div>
                <p className="sx-agent-desc">{b.framing}</p>
              </li>
            ))}
          </ul>
          <h3>已注册(agents 目录)</h3>
          {data.view.entries.length === 0 && <p className="home-loading">无自定义智能体。</p>}
          <ul className="sx-agent-list">
            {data.view.entries.map((e) => (
              <li key={`${e.source}:${e.id}`} className={`sx-agent-card${e.shadowed ? ' shadowed' : ''}`}>
                <div className="sx-agent-head">
                  <span className="sx-agent-id">{e.id}</span>
                  <span className="sx-agent-name">{e.name}</span>
                  <SourceBadge source={e.source} />
                  {e.shadowed && <span className="sx-shadow-tag">被项目遮蔽</span>}
                </div>
                {e.description !== undefined && <p className="sx-agent-desc">{e.description}</p>}
                <div className="sx-agent-chips">
                  {e.memory === true && <span className="sx-chip">memory</span>}
                  {e.isolation !== undefined && <span className="sx-chip">{`isolation:${e.isolation}`}</span>}
                  {e.executor !== undefined && <span className="sx-chip">{`executor:${e.executor}`}</span>}
                </div>
                <details className="sx-agent-body">
                  <summary>正文</summary>
                  <pre>{e.bodyPreview}</pre>
                </details>
                <div className="sx-card-actions">
                  <button
                    type="button"
                    aria-label={`编辑 ${e.id}(${scopeTag(e.source)})`}
                    onClick={() => {
                      setForm({
                        /** 编辑卡 scope 预选 = 卡 source(可切——项目覆盖全局是合法形) */
                        scope: e.source,
                        editing: true,
                        id: e.id,
                        name: e.name,
                        description: e.description ?? '',
                        memory: e.memory === true,
                        isolation: e.isolation ?? '',
                        executor: e.executor ?? '',
                        body: e.bodyPreview,
                        seededBody: e.bodyPreview,
                        bodyFull: false,
                      });
                      setFormError('');
                      seedFullBody(e); // G8d-T3:全文装载升级(失败回退预览+行内提示)
                    }}
                  >
                    编辑
                  </button>
                  <button type="button" aria-label={`删除 ${e.id}(${scopeTag(e.source)})`} onClick={() => remove(e)}>
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {data.view.warnings.map((w) => (
            <p key={w} className="sx-agent-warn" role="alert">
              {w}
            </p>
          ))}
        </>
      )}
      {form !== null && (
        <form
          className="sx-card-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <h3>{form.editing ? `编辑 ${form.id}` : '新增智能体'}</h3>
          <label>
            层级
            <select aria-label="agent scope" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as AgentFormState['scope'] })}>
              <option value="project" disabled={root === ''}>
                项目{root === '' ? '(需项目上下文)' : ''}
              </option>
              <option value="global">全局</option>
            </select>
          </label>
          <label>
            id
            <input aria-label="agent id" value={form.id} readOnly={form.editing} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="writer" />
          </label>
          <label>
            name
            <input aria-label="agent name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            description
            <input aria-label="agent description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <label className="sx-check-row">
            <input type="checkbox" aria-label="agent memory" checked={form.memory} onChange={(e) => setForm({ ...form, memory: e.target.checked })} />
            memory(自有记忆)
          </label>
          <label>
            isolation
            <input aria-label="agent isolation" value={form.isolation} onChange={(e) => setForm({ ...form, isolation: e.target.value })} />
          </label>
          <label>
            executor
            <input aria-label="agent executor" value={form.executor} onChange={(e) => setForm({ ...form, executor: e.target.value })} />
          </label>
          <label>
            正文(agent.md body)
            <textarea aria-label="agent body" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={4} />
          </label>
          {formError !== '' && <p className="home-error" role="alert">{formError}</p>}
          <div className="sx-card-actions">
            <button type="submit" disabled={saving}>
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
      <button
        type="button"
        className="sx-add-button"
        onClick={() => {
          setForm({ scope: root === '' ? 'global' : 'project', editing: false, id: '', name: '', description: '', memory: false, isolation: '', executor: '', body: '', seededBody: '', bodyFull: false });
          setFormError('');
        }}
      >
        + 新增
      </button>
    </section>
  );
}
