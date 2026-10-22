import { useEffect, useState } from 'react';
import { Folder, MoreHorizontal, PanelRight } from 'lucide-react';
import { t } from '../../i18n';
import type { Connection } from '../../connection';
import { SessionRowMenu } from '../../sidebar/session-row-menu';

/** 会话顶栏(D32 第六批批F-3 自 Chat.tsx 平移,行为零变化):标题(空/改/显三态,点击重命名)
 *  + 动态计数钮(待办/任务板)+ 侧栏展开钮。标题编辑态与草稿留宿主。
 *  批F-7d:ChatDynButtons 自宿主整迁本文件(唯一消费方,值回引环消解)。 */

/** G14.177 顶栏动态计数按钮(待办/任务/后台任务):转圈图标+数量;点击开对应页签。
 *  G14.213 原子化三改:①仅运行中显示(轮次收束即隐,待办是否完结无关);②侧栏展开不再隐藏
 *  (挂载点去掉 collapsed 门);③幽灵钮化——无底色。
 *  G14.2xx 用户裁定:常显(旧「顶栏 hover 浮现」退役);三钮图标统一灰色转圈(待办钮的绿对号
 *  退役——对号读作「已完成数」与计数语义相反;todoActive 本就是 in_progress+pending 之和) */
export function ChatDynButtons({ todoActive, taskActive, running, conn, sessionId, onOpenTab }: {
  todoActive: number;
  taskActive: number;
  running: boolean;
  conn: Connection;
  sessionId: string;
  onOpenTab?: (type: 'tasks' | 'agents' | 'bgtasks') => void;
}): JSX.Element | null {
  const [bgRunning, setBgRunning] = useState(0);
  useEffect(() => {
    // 测试桩/旧连接可能未实现 sessionTasks——探活失败静默零计数(按钮全隐,不炸树)
    if (typeof conn.sessionTasks !== 'function') return;
    let alive = true;
    const poll = (): void => {
      Promise.resolve()
        .then(() => conn.sessionTasks(sessionId))
        .then(
          (rows) => {
            if (alive) setBgRunning(rows.filter((r) => r.status === 'running').length);
          },
          () => undefined,
        )
          // 轮询失败按计数保持降级(顶栏徽标非权威数据,下一拍重拉)
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [conn, sessionId]);
  // G14.213 轮次收束即隐:running 熄灭按钮组整体不显(待办/任务是否完结无关)
  if (!running || (todoActive === 0 && taskActive === 0 && bgRunning === 0)) return null;

  return (
    <div className="chat-dyn-buttons" role="group" aria-label="live counters">
      {todoActive > 0 && (
        <button type="button" className="chat-dyn-btn todo" data-tip={t('Open todos', '打开待办')} onClick={() => onOpenTab?.('tasks')}>
          <span className="run-spinner" aria-hidden="true" />
          {t(`${todoActive} todos`, `${todoActive} 待办`)}
        </button>
      )}
      {taskActive > 0 && (
        <button type="button" className="chat-dyn-btn" data-tip={t('Open task board', '打开任务板')} onClick={() => onOpenTab?.('agents')}>
          <span className="run-spinner" aria-hidden="true" />
          {t(`${taskActive} tasks`, `${taskActive} 任务`)}
        </button>
      )}
      {bgRunning > 0 && (
        <button type="button" className="chat-dyn-btn" data-tip={t('Open background tasks', '打开后台任务')} onClick={() => onOpenTab?.('bgtasks')}>
          <span className="run-spinner" aria-hidden="true" />
          {t(`${bgRunning} background`, `${bgRunning} 后台任务`)}
        </button>
      )}
    </div>
  );
}
export interface ChatTopbarProps {
  readonly fixedTitle: string | undefined;
  readonly titleEditing: boolean;
  readonly titleDraft: string;
  readonly setTitleDraft: (v: string) => void;
  readonly commitTitle: () => void;
  readonly setTitleEditing: (v: boolean) => void;
  readonly displayTitle: string;
  readonly sessionId: string;
  readonly tokens: number;
  readonly steps: number;
  readonly running: boolean;
  readonly todoActive: number;
  readonly taskActive: number;
  readonly conn: Connection;
  readonly onOpenTab?: ((type: 'tasks' | 'agents' | 'bgtasks') => void);
  /** 归档态(2026-10-21):快照播种对齐——true 显徽标+撤销钮,false 显归档钮(确认 morph) */
  readonly archived: boolean;
  /** 归档/撤销归档上抛(落 conn.archiveSession;本地 archived 同步归宿主 Chat) */
  readonly onArchive: (archived: boolean) => void;
  readonly showExpandSidebar: boolean | undefined;
  readonly onExpandSidebar: (() => void) | undefined;
  /** 会话档身份(置顶档寻址——journalId 跨重启稳定) */
  readonly journalId?: string;
  /** 会话工作区根(置顶条目快照字段) */
  readonly root?: string;
}

export function ChatTopbar(props: ChatTopbarProps): JSX.Element {
  const { fixedTitle, titleEditing, titleDraft, setTitleDraft, commitTitle, setTitleEditing, displayTitle, sessionId, tokens, steps, running, todoActive, taskActive, conn, onOpenTab, archived, onArchive, journalId, root, showExpandSidebar, onExpandSidebar } = props;
  // ⋯ 会话操作菜单(2026-10-22 用户裁定:归档直连钮收敛为 ⋯ 弹窗——置顶⇄/归档⇄,运行中禁用)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [pinned, setPinned] = useState(false);
  const loadPinned = (): void => {
    if (journalId === undefined) return;
    conn.appPins().then(
      (r) => setPinned(r.pins.some((p) => p.id === journalId)),
      () => undefined,
    );
  };
  const togglePin = (): void => {
    if (journalId === undefined) return;
    conn.appPins().then(
      (r) => {
        const rest = r.pins.filter((p) => p.id !== journalId);
        const next = pinned ? rest : [...rest, { id: journalId, root: root ?? '', title: displayTitle, updatedAt: Date.now() }];
        setPinned(!pinned);
        void conn.saveAppPins(next).then(() => undefined, () => undefined);
      },
      () => undefined,
    );
  };
  const menuItems = [
    {
      id: 'pin',
      label: pinned ? t('Unpin session', '取消置顶会话') : t('Pin session', '置顶会话'),
      disabled: running,
      onSelect: () => {
        togglePin();
        loadPinned();
      },
    },
    {
      id: 'archive',
      label: archived ? t('Unarchive session', '取消归档会话') : t('Archive session', '归档会话'),
      disabled: running,
      onSelect: () => {
        if (archived) onArchive(false);
        else onArchive(true);
        loadPinned();
      },
    },
  ];
  return (
    <header className="chat-topbar">
        {fixedTitle === '' ? (
          // G14.32 辅助对话:顶栏无标题(标签页已具名,双显冗余)
          <span className="chat-title" />
        ) : titleEditing ? (
          <input
            className="chat-title-input"
            value={titleDraft}
            maxLength={40}
            autoFocus
            aria-label={t('Session title', '会话标题')}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTitle();
              if (e.key === 'Escape') setTitleEditing(false);
            }}
          />
        ) : (
          <span className="chat-title" data-tip={`${sessionId} · ${tokens} tokens · ${steps} steps${running ? ' · 运行中' : ''}`}>
            <button
              type="button"
              className="chat-title-btn"
              data-tip={t('Click to rename', '点击重命名')}
              onClick={() => {
                setTitleDraft(displayTitle);
                setTitleEditing(true);
              }}
            >
              <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
              <span className="chat-title-text">{displayTitle}</span>
            </button>
            {/* G14.52:运行态圆点迁侧栏会话行左缘(顶栏不再双显) */}
          </span>
        )}
        <ChatDynButtons todoActive={todoActive} taskActive={taskActive} running={running} conn={conn} sessionId={sessionId} onOpenTab={onOpenTab} />
        {/* ⋯ 会话操作钮(2026-10-22 用户裁定:归档直连钮收敛为 ⋯ 弹窗——置顶⇄/归档⇄,运行中禁用) */}
        <button type="button" className="sx-iconbtn" data-tip={t('Session actions', '会话操作')}
          aria-label={t('Session actions', '会话操作')}
          onClick={(e) => {
            e.stopPropagation();
            loadPinned();
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: Math.round(r.right), y: Math.round(r.bottom) });
          }}
        >
          <MoreHorizontal size={16} strokeWidth={1.75} />
        </button>
        {archived && <span className="sx-archived-badge">{t('Archived', '已归档')}</span>}
        {menu !== null && (
          <SessionRowMenu
            x={menu.x}
            y={menu.y}
            onClose={() => setMenu(null)}
            items={menuItems.map((it) => ({ ...it, disabled: it.disabled && running }))}
          />
        )}
        {showExpandSidebar && (
          <button
            type="button"
            className="sx-iconbtn chat-expand"
            aria-label="expand sidebar"
            data-tip={t('Expand sidebar', '展开侧边栏')}
            onClick={onExpandSidebar}
          >
            <PanelRight size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
    </header>
  );
}
