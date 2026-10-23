import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import type { Connection } from '../connection';
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

type TaskRow = {
  id: string;
  kind: string;
  label: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  outputTail?: string;
  outputTruncated?: boolean;
};
type MemoryRow = { slug: string; type: string; created: string; modified: string; description: string; body: string };

function useFetch<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    fn().then(
      (d) => {
        if (alive) {
          setData(d);
          setError('');
        }
      },
      (err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((v) => v + 1) };
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
  const { data, error, reload } = useFetch<CtxBreakdown>(() => conn.sessionContext(sessionId), [conn, sessionId]);
  return (
    <div className="insight-tab">
      <div className="insight-bar">
        <button type="button" className="sx-changes-act" aria-label="refresh" data-tip={t('Refresh', '刷新')} onClick={reload}>
          <RefreshCw size={13} strokeWidth={1.75} />
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
 *  不区分用户输入(turnGoal 退役)——单行=状态图标+运行时长+命令(一行省略)+创建时间;
 *  点击展开命令详情与结果(服务端输出尾读,结果区最大高度内部滚动)。运行中时长 1s 实时跳 */
export function BgTasksTab({ conn, sessionId }: { conn: Connection; sessionId: string }): JSX.Element {
  const { data, error, reload } = useFetch<TaskRow[]>(() => conn.sessionTasks(sessionId), [conn, sessionId]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // 运行时长实时:有 running 任务才起 1s 定时器(终态行用 endedAt 恒定,零无谓重渲染)
  const [now, setNow] = useState(Date.now());
  const hasRunning = (data ?? []).some((r) => r.status === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunning]);
  const toggle = (id: string): void =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
          <RefreshCw size={13} strokeWidth={1.75} />
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
            const dur = fmtDur((r.endedAt ?? now) - r.startedAt);
            return (
              <section key={r.id} className="tb-card">
                <button type="button" className="todo-card-head" aria-expanded={open} onClick={() => toggle(r.id)}>
                  {/* 2026-10-24 用户裁定:状态点与全项目同款(tb-status-dot)——灰转圈=running,
                   *  蓝点=done,红点=failed,灰点=stopped */}
                  <span className={`tb-status-dot bg-${r.status}`} aria-hidden="true" />
                  <span className="todo-card-goal bg-cmd" data-tip={r.label}>{r.label}</span>
                  <span className="bg-dur" data-tip={t('Elapsed', '运行时长')}>{dur}</span>
                  <span className="todo-card-time">{shortStampMs(r.startedAt)}</span>
                </button>
                {open && (
                  <div className="bg-detail">
                    <div className="bg-detail-row">
                      <span className="bg-detail-key">{t('Command', '命令')}</span>
                      <span className="bg-detail-val bg-detail-mono">{r.label}</span>
                    </div>
                    {r.outputTail !== undefined && r.outputTail !== '' && (
                      <div className="bg-detail-row bg-detail-col">
                        <span className="bg-detail-key">{t('Result', '结果')}</span>
                        <pre className="bg-output">
                          {r.outputTail}
                          {r.outputTruncated === true && `\n…${t('output truncated (showing last 4KB)', '输出已截断(仅示末 4KB)')}`}
                        </pre>
                      </div>
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
 *  G14.147 对标 diff 页交互:行点击展开详情(全文),删除=图标钮(单行 Trash/批量带计数) */
export function MemoryTab({ conn, root }: { conn: Connection; root: string }): JSX.Element {
  const fetcher = useCallback(() => conn.memoryList(root), [conn, root]);
  const { data, error, reload } = useFetch<MemoryRow[]>(fetcher, [conn, root]);
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const remove = (slugs: string[]): void => {
    if (slugs.length === 0 || root === '') return;
    setDeleting(true);
    conn
      .removeMemory(root, slugs)
      .then(() => {
        setSelected((s) => s.filter((x) => !slugs.includes(x)));
        if (expandedSlug !== null && slugs.includes(expandedSlug)) setExpandedSlug(null);
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
          <RefreshCw size={13} strokeWidth={1.75} />
        </button>
        {selected.length > 0 && (
          <button
            type="button"
            className="sx-changes-act"
            aria-label="delete selected"
            data-tip={`${t('Delete selected', '删除所选')} (${selected.length})`}
            disabled={deleting || root === ''}
            onClick={() => remove(selected)}
          >
            <Trash2 size={13} strokeWidth={1.75} />
            <span className="mem-count">{selected.length}</span>
          </button>
        )}
      </div>
      {error !== '' && <p className="home-error" role="alert">{error}</p>}
      {root === '' && <p className="insight-empty">{t('Select a project to view memory', '选择项目后可查看记忆')}</p>}
      {root !== '' && data !== null && data.length === 0 && <p className="insight-empty">{t('No persistent memory yet', '暂无持久记忆')}</p>}
      {root !== '' && data !== null && data.length > 0 && (
        <ul className="mem-list">
          {data.map((m) => (
            <li key={m.slug} className={`mem-row${expandedSlug === m.slug ? ' open' : ''}`}>
              <div className="mem-rowline">
                <label className="mem-check">
                  <input
                    type="checkbox"
                    checked={selected.includes(m.slug)}
                    onChange={(e) =>
                      setSelected((s) => (e.target.checked ? [...s, m.slug] : s.filter((x) => x !== m.slug)))
                    }
                  />
                </label>
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
                  className="sx-changes-act mem-del"
                  aria-label={`delete ${m.slug}`}
                  data-tip={t('Delete', '删除')}
                  disabled={deleting}
                  onClick={(e) => {
                    e.stopPropagation();
                    remove([m.slug]);
                  }}
                >
                  <Trash2 size={13} strokeWidth={1.75} />
                </button>
              </div>
              {expandedSlug === m.slug && (
                <div className="mem-detail">
                  <div className="mem-meta">{m.type} · {t('created', '创建')} {m.created.slice(0, 10)}</div>
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
