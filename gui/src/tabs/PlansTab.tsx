import { useCallback, useEffect, useState } from 'react';
import { Clock, NotebookPen, RefreshCw } from 'lucide-react';
import { t } from '../i18n';
import type { Connection } from '../connection';
import { shortStampMs, withMinSpin } from '../ui-util';

/**
 * 计划页签(2026-11-04 用户裁定「侧栏增加计划的页签,每个一行计划,有生成时间,点击打开指定文件」):
 * 数据目录 sessions/*.plan.md 清单(GET /session/:id/plans——每会话一份计划书,修订覆盖写,
 * mtime=末次生成时刻)。每行=计划名+生成时间,点击 onOpenFile 开侧栏原文(file 端点数据目录已放行,
 * 计划卡卡头链接同通路)。只读拉取+手动刷新;空态/错误行内示出不静默。
 */

type PlanRow = { name: string; path: string; mtime: number };

export function PlansTab({
  conn,
  sessionId,
  refreshNonce,
  onOpenFile,
}: {
  conn: Connection;
  sessionId: string;
  refreshNonce?: number;
  onOpenFile: (path: string) => void;
}): JSX.Element {
  const fetcher = useCallback(() => conn.sessionPlans(sessionId), [conn, sessionId]);
  const [data, setData] = useState<PlanRow[] | null>(null);
  const [error, setError] = useState('');
  const [fetching, setFetching] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((v) => v + 1), []);
  useEffect(() => {
    let alive = true;
    setFetching(true);
    withMinSpin(fetcher()).then(
      (d) => {
        if (alive) {
          setData(d.plans);
          setError('');
          setFetching(false);
        }
      },
      (e: unknown) => {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setFetching(false);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [fetcher, tick, refreshNonce]);
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
          <p className="board-empty-title">{t('No plans yet', '还没有计划')}</p>
          <p className="board-empty-hint">{t('Plans presented by the agent (plan card) will appear here.', '智能体出牌的计划（计划卡）会显示在这里。')}</p>
        </div>
      )}
      {data !== null && data.length > 0 && (
        <ul className="mem-list">
          {data.map((pl) => (
            <li key={pl.path} className="mem-row">
              <div className="mem-rowline">
                {/* 行图标与计划卡卡头/计划模式 pill 同件(NotebookPen)——「计划」视觉同族 */}
                <NotebookPen size={13} strokeWidth={1.75} aria-hidden="true" className="mem-icon" />
                <span
                  className="mem-body"
                  role="button"
                  tabIndex={0}
                  data-tip={pl.name}
                  onClick={() => onOpenFile(pl.path)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onOpenFile(pl.path);
                  }}
                >
                  {pl.name === '' ? t('Untitled plan', '未命名计划') : pl.name}
                </span>
                <span className="mem-date"><Clock size={11} strokeWidth={1.75} aria-hidden="true" />{shortStampMs(pl.mtime)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
