import { Folder, PanelRight } from 'lucide-react';
import { t } from '../../i18n';
import type { Connection } from '../../connection';
// ChatDynButtons 值回引宿主(调用期解绑;Chat 内模块私有件,随顶栏消费面回引)
import { ChatDynButtons } from '../Chat';

/** 会话顶栏(D32 第六批批F-3 自 Chat.tsx 平移,行为零变化):标题(空/改/显三态,点击重命名)
 *  + 动态计数钮(待办/任务板)+ 侧栏展开钮。标题编辑态与草稿留宿主。 */
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
  readonly showExpandSidebar: boolean | undefined;
  readonly onExpandSidebar: (() => void) | undefined;
}

export function ChatTopbar(props: ChatTopbarProps): JSX.Element {
  const { fixedTitle, titleEditing, titleDraft, setTitleDraft, commitTitle, setTitleEditing, displayTitle, sessionId, tokens, steps, running, todoActive, taskActive, conn, onOpenTab, showExpandSidebar, onExpandSidebar } = props;
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
