import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Check, Copy, Database, Pause, Play, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { TipButton } from '../pages/chat/RunFooter';
import { useCopyFeedback } from '../use-copy-feedback';
import { MD_REHYPE_PLUGINS, MD_REMARK_PLUGINS, keepUrl } from '../pages/Chat';
import type { Connection, SessionTaskRow } from '../connection';
import { t } from '../i18n';
import { shortStampMs } from '../ui-util';

/**
 * G10-C6 右栏三面板(spec §7 映射:/context /tasks /memory 的 GUI 承载):
 * - ContextTab:上下文分段构成(结构化 parts,占比条)
 * - BgTasksTab:后台任务账本(/tasks 底层,与任务板分立——账本是 exec/spawn 运行面)
 * - MemoryTab:持久记忆清单(/memory 底层;删除钮走 /memory/rm)
 * 三者皆只读拉取 + 手动刷新;错误行内示出不静默。
 */

type CtxBreakdown = {
  parts: Array<{ id: string; tokens: number; count: number }>;
  chainByAction: Array<{ action: string; tokens: number }>;
  total: number;
  window: number;
  free: number;
};

type MemoryRow = { slug: string; type: string; created: string; modified: string; description: string; body: string };

function useFetch<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string; reload: () => void; fetching: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [fetching, setFetching] = useState(true);
  useEffect(() => {
    let alive = true;
    setFetching(true);
    fn().then(
      (d) => {
        if (alive) {
          setData(d);
          setError('');
          setFetching(false);
        }
      },
      (err: unknown) => {
        if (alive) {
          setError(err instanceof Error ? err.message : String(err));
          setFetching(false);
        }
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((v) => v + 1), fetching };
}

const pct = (tokens: number, total: number): string => `${Math.round((tokens / Math.max(1, total)) * 100)}%`;

/** 运行时长(m→mm:ss,h 进位 h:mm:ss;秒位定宽——tabular-nums 在 CSS 面) */
const fmtDur = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

/** 上下文面板:/context 结构化面——分段条 + 总量/窗口余量 */
export function ContextTab({ conn, sessionId }: { conn: Connection; sessionId: string }): JSX.Element {
  const { data, error, reload, fetching } = useFetch<CtxBreakdown>(() => conn.sessionContext(sessionId), [conn, sessionId]);
  return (
    <div className="insight-tab">
      <div className="insight-bar">
        <button type="button" className="sx-changes-act" aria-label="refresh" data-tip={t('Refresh', '刷新')} onClick={reload}>
          <RefreshCw size={13} strokeWidth={1.75} className={fetching ? 'sx-fetching' : undefined} />
        </button>
      </div>
      {error !== '' && <p className="home-error" role="alert">{error}</p>}
      {data !== null && (
        <>
          <p className="insight-summary">
            {data.total} / {data.window} tokens · {t('free', '余量')} {data.free}
          </p>
          <ul className="ctx-parts">
            {data.parts.map((p) => (
              <li key={p.id} className="ctx-part">
                <span className="ctx-part-id">{p.id}</span>
                <span className="ctx-part-bar">
                  <span className="ctx-part-fill" style={{ width: pct(p.tokens, data.total) }} />
                </span>
                <span className="ctx-part-num">{p.tokens}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** 后台任务面板:/tasks 账本行(exec 运行面,与任务板分立)。2026-10-24 用户裁定行制改版:
 *  单行=状态图标+运行时长+命令(一行省略)+创建时间。2026-10-31 用户裁定三改:①运行时长前移到
 *  状态图标后(与右缘创建时间在视觉轴上分开) ②展开详情摘「命令/结果」自解释标题,命令行右缘
 *  复制钮 ③运行中行暂停钮/暂停中恢复钮(hover 显现;exec 活账闭包,subagent/重放账 409 静默)。
 *  运行时长停表扣 pausedMs(暂停段不计时);点击展开命令详情与结果(服务端输出尾读,结果区最大
 *  高度内部滚动)。运行中时长 1s 实时跳 */
export function BgTasksTab({ conn, sessionId }: { conn: Connection; sessionId: string }): JSX.Element {
  const { data, error, reload, fetching } = useFetch<SessionTaskRow[]>(() => conn.sessionTasks(sessionId), [conn, sessionId]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // 复制回显(2026-10-31 用户裁定「与正文中复制按钮一致」):useCopyFeedback 单点+Check 图标交换
  // ——status=最近一次复制结果,ltRid 锚定到触发行(多行面板仅命中行显 √)
  const { status: copyStatus, copy: copyText } = useCopyFeedback();
  const copiedRowRef = useRef<string | null>(null);
  const copied = (id: string): boolean => copiedRowRef.current === id && copyStatus === 'ok';
  // 运行中时长实时:有 running 任务才起 1s 定时器(终态行用 endedAt 恒定,零无谓重渲染)
  const [now, setNow] = useState(Date.now());
  const hasRunning = (data ?? []).some((r) => r.status === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunning]);
  /** 运行时长停表(2026-10-31 暂停面):终态=endedAt;暂停中=pausedAt 冻结点;其余=now——均扣已折算暂停段 */
  const durOf = (r: SessionTaskRow): string =>
    fmtDur(Math.max(0, (r.endedAt ?? (r.status === 'paused' ? (r.pausedAt ?? now) : now)) - r.startedAt - (r.pausedMs ?? 0)));
  const toggle = (id: string): void =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const copyCmd = (id: string, label: string): void => {
    copiedRowRef.current = id;
    copyText(label);
  };
  const pauseTask = (e: React.MouseEvent, id: string, resume: boolean): void => {
    e.stopPropagation();
    (resume ? conn.taskResume(sessionId, id) : conn.taskPause(sessionId, id).catch(() => {}))
      .then(() => reload())
      .catch(() => {});
  };
  const rows = [...(data ?? [])].sort((a, b) => b.startedAt - a.startedAt);
  return (
    <div className="insight-tab">
      <div className="insight-bar">
        <button
          type="button"
          className="sx-changes-act"
          aria-label="refresh"
          data-tip={t('Refresh', '刷新')}
          onClick={reload}
        >
          <RefreshCw size={13} strokeWidth={1.75} className={fetching ? 'sx-fetching' : undefined} />
        </button>
      </div>
      {error !== '' && <p className="home-error" role="alert">{error}</p>}
      {data !== null && data.length === 0 && (
        <div className="board-empty-state" role="status">
          <p className="board-empty-title">{t('No background tasks', '暂无后台任务')}</p>
          <p className="board-empty-hint">{t('Background exec/spawn tasks will appear here.', '后台 exec/spawn 任务会显示在这里。')}</p>
        </div>
      )}
      {data !== null && data.length > 0 && (
        <div className="todo-cards" aria-label="background tasks">
          {rows.map((r) => {
            const open = expanded.has(r.id);
            return (
              <section key={r.id} className="tb-card">
                <div
                  className="todo-card-head"
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                  onClick={() => toggle(r.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggle(r.id);
                    }
                  }}
                >
                  {/* 2026-10-24 用户裁定:状态点与全项目同款(tb-status-dot)——灰转圈=running,
                   *  蓝点=done,红点=failed,灰点=stopped/paused(paused 静态灰点+时长冻结) */}
                  <span className={`tb-status-dot bg-${r.status === 'paused' ? 'stopped' : r.status}`} aria-hidden="true" />
                  {/* 运行时长前移到图标后(2026-10-31 用户裁定「或者运行时间显示在开头」),与右缘创建时间分轴 */}
                  <span className="bg-dur" data-tip={t('Elapsed', '运行时长')}>{durOf(r)}</span>
                  <span className="todo-card-goal bg-cmd" data-tip={r.label}>{r.label}</span>
                  {/* 暂停/恢复(2026-10-31):仅 exec 活账有闭包(daemon 409 静默兜旧档);hover 显现 */}
                  {r.status === 'running' && typeof conn.taskPause === 'function' && (
                    <button
                      type="button"
                      className="sx-changes-act bg-act"
                      aria-label={`pause ${r.id}`}
                      data-tip={t('Pause', '暂停')}
                      onClick={(e) => pauseTask(e, r.id, false)}
                    >
                      <Pause size={12} strokeWidth={1.75} />
                    </button>
                  )}
                  {r.status === 'paused' && typeof conn.taskResume === 'function' && (
                    <button
                      type="button"
                      className="sx-changes-act bg-act"
                      aria-label={`resume ${r.id}`}
                      data-tip={t('Resume', '恢复')}
                      onClick={(e) => pauseTask(e, r.id, true)}
                    >
                      <Play size={12} strokeWidth={1.75} />
                    </button>
                  )}
                  <span className="todo-card-time">{shortStampMs(r.startedAt)}</span>
                </div>
                {open && (
                  <div className="bg-detail">
                    {/* 2026-10-31 用户裁定:摘「命令/结果」自解释标题;复制钮与正文同款(TipButton+
                        Check 交换,点击显 √);span 承接 stopPropagation(防触发头行展开) */}
                    <div className="bg-cmd-row">
                      <span className="bg-cmd-text">{r.label}</span>
                      <span className="bg-copy" onClick={(e) => e.stopPropagation()}>
                        <TipButton
                          className="sx-changes-act"
                          label={`copy command ${r.id}`}
                          tip={copied(r.id) ? t('Copied', '已复制') : t('Copy command', '复制命令')}
                          icon={copied(r.id) ? <Check size={12} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={12} strokeWidth={1.75} aria-hidden="true" />}
                          onClick={() => copyCmd(r.id, r.label)}
                        />
                      </span>
                    </div>
                    {r.outputTail !== undefined && r.outputTail !== '' && (
                      <pre className="bg-output">
                        {r.outputTail}
                        {r.outputTruncated === true && `\n…${t('output truncated (showing last 4KB)', '输出已截断(仅示末 4KB)')}`}
                      </pre>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 记忆面板:/memory 清单(body 全文)+ /memory/rm 删除。
 *  G14.147 对标 diff 页交互:行点击展开详情(全文),删除=行尾图标单删。
 *  2026-10-31 用户裁定显示优化:①行图标=Database(与正文 [memory] 回显同件) ②「project · 创建」
 *  元信息行退役 ③详情=深色底固定高,过高纵向滚动 ④focus(memoryFocus 下发)展开并滚至对应行
 *  ⑤批量勾选入口退役(「去掉批量删除入口」)——单行删除二段确认保留 */
export function MemoryTab({ conn, root, focus }: { conn: Connection; root: string; focus?: { slug: string; nonce: number } }): JSX.Element {
  const fetcher = useCallback(() => conn.memoryList(root), [conn, root]);
  const { data, error, reload, fetching } = useFetch<MemoryRow[]>(fetcher, [conn, root]);
  const [deleting, setDeleting] = useState(false);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  /** 删除二段确认(共享 ConfirmDeleteButton 同语义):首击武装(红),3s 内再击执行,超时解除 */
  const [armSlug, setArmSlug] = useState<string | null>(null);
  useEffect(() => {
    if (armSlug === null) return;
    const t = setTimeout(() => setArmSlug(null), 3000);
    return () => clearTimeout(t);
  }, [armSlug]);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  useEffect(() => {
    if (focus === undefined || data === null) return;
    setExpandedSlug(focus.slug);
    const li = rowRefs.current.get(focus.slug);
    li?.scrollIntoView({ block: 'center' });
  }, [focus, data]);
  const remove = (slug: string): void => {
    if (root === '') return;
    setDeleting(true);
    conn
      .removeMemory(root, [slug])
      .then(() => {
        if (expandedSlug === slug) setExpandedSlug(null);
        reload();
      })
      .finally(() => setDeleting(false));
  };
  return (
    <div className="insight-tab">
      <div className="insight-bar">
        <button
          type="button"
          className="sx-changes-act"
          aria-label="refresh"
          data-tip={t('Refresh', '刷新')}
          onClick={reload}
        >
          <RefreshCw size={13} strokeWidth={1.75} className={fetching ? 'sx-fetching' : undefined} />
        </button>
      </div>
      {error !== '' && <p className="home-error" role="alert">{error}</p>}
      {root === '' && (
        <div className="board-empty-state" role="status">
          <p className="board-empty-title">{t('No project selected', '未选择项目')}</p>
          <p className="board-empty-hint">{t('Select a project to view memory', '选择项目后可查看记忆')}</p>
        </div>
      )}
      {root !== '' && data !== null && data.length === 0 && (
        <div className="board-empty-state" role="status">
          <p className="board-empty-title">{t('No persistent memory yet', '暂无持久记忆')}</p>
          <p className="board-empty-hint">{t('Memories saved by the agent will appear here.', '智能体保存的记忆会显示在这里。')}</p>
        </div>
      )}
      {root !== '' && data !== null && data.length > 0 && (
        <ul className="mem-list">
          {data.map((m) => (
            <li
              key={m.slug}
              className={`mem-row${expandedSlug === m.slug ? ' open' : ''}`}
              ref={(el) => {
                if (el !== null) rowRefs.current.set(m.slug, el);
                else rowRefs.current.delete(m.slug);
              }}
            >
              <div className="mem-rowline">
                {/* 行图标与正文 [memory] 回显同件(Database,2026-10-31 用户裁定「记忆的图标和
                    正文中的数据库图标一致」) */}
                <Database size={13} strokeWidth={1.75} aria-hidden="true" className="mem-icon" />
                <span
                  className="mem-body"
                  role="button"
                  tabIndex={0}
                  data-tip={m.description}
                  onClick={() => setExpandedSlug((s) => (s === m.slug ? null : m.slug))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setExpandedSlug((s) => (s === m.slug ? null : m.slug));
                  }}
                >
                  {m.description}
                </span>
                <span className="mem-date">{m.modified.slice(0, 10)}</span>
                <button
                  type="button"
                  className={`sx-changes-act mem-del${armSlug === m.slug ? ' arm' : ''}`}
                  aria-label={armSlug === m.slug ? `confirm delete ${m.slug}` : `delete ${m.slug}`}
                  data-tip={armSlug === m.slug ? t('Click again to confirm', '再次点击确认') : t('Delete', '删除')}
                  disabled={deleting}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (armSlug === m.slug) {
                      remove(m.slug);
                      setArmSlug(null);
                    } else {
                      setArmSlug(m.slug);
                    }
                  }}
                >
                  <Trash2 size={13} strokeWidth={1.75} />
                </button>
              </div>
              {expandedSlug === m.slug && (
                <div className="mem-detail">
                  {/* 2026-10-31 用户裁定:「project · 创建」元信息行退役;内容深色底+固定高滚动 */}
                  <pre className="mem-body-text">{m.body}</pre>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 学习技能面板(2026-10-31 用户裁定「侧栏增加学习技能页签,页签样式内容和记忆一致」):
 *  learned 源技能清单——行=Sparkles(与正文 [skills] 回显同件)+id+创建时间+删除(二段确认,
 *  与记忆行同语言;只作用于学习根 learnedSkillsDir,project/user 用户资产不可达);
 *  展开=深色底固定高纵md渲染(mem 同款类) */
export function LearnedSkillsTab({ conn, root }: { conn: Connection; root: string }): JSX.Element {
  const fetcher = useCallback(() => conn.skillsGroups(root), [conn, root]);
  const { data, error, reload, fetching } = useFetch(fetcher, [conn, root]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** 删除二段确认(与记忆行同语义):首击武装(红),3s 内再击执行,超时解除 */
  const [armId, setArmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (armId === null) return;
    const t = setTimeout(() => setArmId(null), 3000);
    return () => clearTimeout(t);
  }, [armId]);
  const learned = (data?.groups ?? []).filter((g) => g.source === 'learned').flatMap((g) => g.skills);
  const remove = (id: string): void => {
    if (root === '') return;
    setDeleting(true);
    conn.skillsRemove(root, id).then(reload).finally(() => setDeleting(false));
  };
  return (
    <div className="insight-tab">
      <div className="insight-bar">
        <button type="button" className="sx-changes-act" aria-label="refresh" data-tip={t('Refresh', '刷新')} onClick={reload}>
          <RefreshCw size={13} strokeWidth={1.75} className={fetching ? 'sx-fetching' : undefined} />
        </button>
      </div>
      {error !== '' && <p className="home-error" role="alert">{error}</p>}
      {root === '' && (
        <div className="board-empty-state" role="status">
          <p className="board-empty-title">{t('No project selected', '未选择项目')}</p>
          <p className="board-empty-hint">{t('Select a project to view learned skills', '选择项目后可查看学习技能')}</p>
        </div>
      )}
      {root !== '' && data !== null && learned.length === 0 && (
        <div className="board-empty-state" role="status">
          <p className="board-empty-title">{t('No learned skills yet', '暂无学习技能')}</p>
          <p className="board-empty-hint">{t('Skills the agent learns will appear here.', '智能体学到的技能会显示在这里。')}</p>
        </div>
      )}
      {learned.length > 0 && (
        <ul className="mem-list">
          {learned.map((s) => (
            <li key={s.id} className={`mem-row${expandedId === s.id ? ' open' : ''}`}>
              <div className="mem-rowline">
                <Sparkles size={13} strokeWidth={1.75} aria-hidden="true" className="mem-icon" />
                <span
                  className="mem-body"
                  role="button"
                  tabIndex={0}
                  data-tip={s.description}
                  onClick={() => setExpandedId((v) => (v === s.id ? null : s.id))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setExpandedId((v) => (v === s.id ? null : s.id));
                  }}
                >
                  {s.id}
                </span>
                {/* 创建时间(2026-10-31 用户裁定「显示创建时间等」):birthtime 回退 mtime,缺省不列 */}
                {s.createdMs !== undefined && <span className="mem-date">{new Date(s.createdMs).toISOString().slice(0, 10)}</span>}
                <button
                  type="button"
                  className={`sx-changes-act mem-del${armId === s.id ? ' arm' : ''}`}
                  aria-label={armId === s.id ? `confirm delete ${s.id}` : `delete ${s.id}`}
                  data-tip={armId === s.id ? t('Click again to confirm', '再次点击确认') : t('Delete', '删除')}
                  disabled={deleting}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (armId === s.id) {
                      remove(s.id);
                      setArmId(null);
                    } else {
                      setArmId(s.id);
                    }
                  }}
                >
                  <Trash2 size={13} strokeWidth={1.75} />
                </button>
              </div>
              {expandedId === s.id && (
                <div className="mem-detail">
                  {/* 2026-10-31 用户裁定:描述渲染后的 md(标题/列表/代码呈现,非裸文本) */}
                  <div className="mem-body-text mem-body-md">
                    <ReactMarkdown remarkPlugins={MD_REMARK_PLUGINS} rehypePlugins={MD_REHYPE_PLUGINS} urlTransform={keepUrl}>
                      {s.description ?? t('(no description)', '(无描述)')}
                    </ReactMarkdown>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
