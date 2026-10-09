import { useCallback, useEffect, useState } from 'react';
import type { Connection } from '../connection';

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

type TaskRow = { id: string; kind: string; label: string; status: string; startedAt: number; exitCode?: number };
type MemoryRow = { slug: string; type: string; created: string; modified: string; description: string };

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

/** 上下文面板:/context 结构化面——分段条 + 总量/窗口余量 */
export function ContextTab({ conn, sessionId }: { conn: Connection; sessionId: string }): JSX.Element {
  const { data, error, reload } = useFetch<CtxBreakdown>(() => conn.sessionContext(sessionId), [conn, sessionId]);
  return (
    <div className="insight-tab">
      <div className="insight-bar">
        <button type="button" className="sx-web-reload" onClick={reload}>
          刷新
        </button>
      </div>
      {error !== '' && <p className="home-error" role="alert">{error}</p>}
      {data !== null && (
        <>
          <p className="insight-summary">
            {data.total} / {data.window} tokens · 余量 {data.free}
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

/** 后台任务面板:/tasks 账本行(exec/spawn 运行面,与任务板分立) */
export function BgTasksTab({ conn, sessionId }: { conn: Connection; sessionId: string }): JSX.Element {
  const { data, error, reload } = useFetch<TaskRow[]>(() => conn.sessionTasks(sessionId), [conn, sessionId]);
  return (
    <div className="insight-tab">
      <div className="insight-bar">
        <button type="button" className="sx-web-reload" onClick={reload}>
          刷新
        </button>
      </div>
      {error !== '' && <p className="home-error" role="alert">{error}</p>}
      {data !== null && data.length === 0 && <p className="insight-empty">暂无后台任务</p>}
      {data !== null && data.length > 0 && (
        <ul className="bgtask-list">
          {data.map((r) => (
            <li key={r.id} className={`bgtask-row bgtask-${r.status}`}>
              <span className="bgtask-label" title={r.id}>
                {r.label}
              </span>
              <span className="bgtask-status">{r.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 记忆面板:/memory 清单 + /memory/rm 删除 */
export function MemoryTab({ conn, root }: { conn: Connection; root: string }): JSX.Element {
  const fetcher = useCallback(() => conn.memoryList(root), [conn, root]);
  const { data, error, reload } = useFetch<MemoryRow[]>(fetcher, [conn, root]);
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="insight-tab">
      <div className="insight-bar">
        <button type="button" className="sx-web-reload" onClick={reload}>
          刷新
        </button>
        {selected.length > 0 && (
          <button
            type="button"
            className="sx-web-reload"
            disabled={deleting || root === ''}
            onClick={() => {
              setDeleting(true);
              conn
                .removeMemory(root, selected)
                .then(() => {
                  setSelected([]);
                  reload();
                })
                .finally(() => setDeleting(false));
            }}
          >
            删除({selected.length})
          </button>
        )}
      </div>
      {error !== '' && <p className="home-error" role="alert">{error}</p>}
      {root === '' && <p className="insight-empty">选择项目后可查看记忆</p>}
      {root !== '' && data !== null && data.length === 0 && <p className="insight-empty">暂无持久记忆</p>}
      {root !== '' && data !== null && data.length > 0 && (
        <ul className="mem-list">
          {data.map((m) => (
            <li key={m.slug} className="mem-row">
              <label className="mem-check">
                <input
                  type="checkbox"
                  checked={selected.includes(m.slug)}
                  onChange={(e) =>
                    setSelected((s) => (e.target.checked ? [...s, m.slug] : s.filter((x) => x !== m.slug)))
                  }
                />
              </label>
              <span className="mem-body" title={m.description}>
                {m.description}
              </span>
              <span className="mem-date">{m.modified.slice(0, 10)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
