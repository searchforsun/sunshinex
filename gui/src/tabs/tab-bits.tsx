import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { t } from '../i18n';

/**
 * tabs 面板小件共用座（D93③ 收敛）：
 * - TabRefreshButton：面板刷新钮（sx-changes-act+RefreshCw，fetching 转圈态）——InsightTabs
 *   三面板/PlansTab（insight-bar 包裹面）与 SunxBoardTab（头栏裸位）五处同款；
 * - BoardEmptyState：board-empty-state 名片空态（title+hint 两行）——InsightTabs/PlansTab
 *   六处纯两行样板；带前置附件（如 SunxBoard 空态 SunxMark 名片标）的面板走 children 留座；
 * - useArmDelete：二段确认武装态（首击武装，3s 内再击执行，超时解除）——Memory/LearnedSkills
 *   删除行与 BgTasks 停止钮三处同语义（2026-11-02 用户裁定「点击按钮变红边框」）。
 */

export function TabRefreshButton({ onClick, fetching }: { onClick: () => void; fetching: boolean }): JSX.Element {
  return (
    <button type="button" className="sx-changes-act" aria-label="refresh" data-tip={t('Refresh', '刷新')} onClick={onClick}>
      <RefreshCw size={14} strokeWidth={1.75} className={fetching ? 'sx-fetching' : undefined} />
    </button>
  );
}

export function BoardEmptyState({ title, hint, children }: { title: string; hint: string; children?: React.ReactNode }): JSX.Element {
  return (
    <div className="board-empty-state" role="status">
      {children}
      <p className="board-empty-title">{title}</p>
      <p className="board-empty-hint">{hint}</p>
    </div>
  );
}

/** 二段确认武装态单点：armed=当前武装行 id（null=无）；arm(id) 武装（3s 超时自动解除），
 *  disarm() 手动解除（执行路径）。effect 计时随武装变更/卸载清理——BgTasks 停止钮原内联
 *  setTimeout 无清理面（卸载后仍走 setState）随单点消除。 */
export function useArmDelete(ms = 3000): { armed: string | null; arm: (id: string) => void; disarm: () => void } {
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (armed === null) return;
    const t = setTimeout(() => setArmed(null), ms);
    return () => clearTimeout(t);
  }, [armed, ms]);
  return { armed, arm: setArmed, disarm: (): void => setArmed(null) };
}
