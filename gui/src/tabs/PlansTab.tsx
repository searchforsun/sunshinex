import { useCallback } from 'react';
import { Clock, NotebookPen } from 'lucide-react';
import { t } from '../i18n';
import type { Connection } from '../connection';
import { shortStampMs } from '../ui-util';
import { useFetch } from '../use-fetch';
import { BoardEmptyState, TabRefreshButton } from './tab-bits';

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
  // 拉取骨架=useFetch 共享单点(D93②:InsightTabs 同构体收编;载荷投影 plans,nonce 语义与其余面板对齐)
  const fetcher = useCallback(() => conn.sessionPlans(sessionId).then((v) => v.plans), [conn, sessionId]);
  const { data, error, reload, fetching } = useFetch<PlanRow[]>(fetcher, [conn, sessionId], { refreshNonce });
  return (
    <div className="insight-tab">
      <div className="insight-bar">
        <TabRefreshButton onClick={reload} fetching={fetching} />
      </div>
      {error !== '' && <p className="home-error" role="alert">{error}</p>}
      {data !== null && data.length === 0 && (
        <BoardEmptyState title={t('No plans yet', '还没有计划')} hint={t('Plans presented by the agent (plan card) will appear here.', '智能体出牌的计划（计划卡）会显示在这里。')} />
      )}
      {data !== null && data.length > 0 && (
        <ul className="mem-list">
          {data.map((pl) => (
            <li key={pl.path} className="mem-row">
              <div className="mem-rowline">
                {/* 行图标与计划卡卡头/计划模式 pill 同件(NotebookPen)——「计划」视觉同族 */}
                <NotebookPen size={14} strokeWidth={1.75} aria-hidden="true" className="mem-icon" />
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
                <span className="mem-date"><Clock size={14} strokeWidth={1.75} aria-hidden="true" />{shortStampMs(pl.mtime)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
