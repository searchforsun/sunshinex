import type { Dispatch, SetStateAction } from 'react';
import type { ChatEntry, ChatState } from '../../chat-reducer';
import { t } from '../../i18n';
import { MessageList } from './MessageList';
import type { MessageListProps } from './MessageList';
import { SelActionsOverlay } from './SelActionsOverlay';
import type { ChatProps } from './chat-types';

/**
 * 转录区(Chat 外提,D62 批I):更早历史提示条(失败重试/加载中)+ 记忆/学习技能回显点击委托
 * (2026-10-31 用户裁定「点击打开侧栏对应页签」——notice 行 data-notice-tag/ref 由 EntryViews
 * 落 DOM,此处统一接管开页签+定位)+ 圈选操作浮层+消息流。MessageList 装配面整体平移,
 * callIdOf/onOpenTodos 两个内联适配器内化为本件局部(diff 寻址键/待办定位上抛)。
 */
export function ChatTranscript(props: Omit<MessageListProps, 'callIdOf' | 'onOpenTodos'> & {
  history: ChatState['history'];
  setChat: Dispatch<SetStateAction<ChatState>>;
  onOpenMemory: ChatProps['onOpenMemory'];
  onOpenLearned: ChatProps['onOpenLearned'];
  onOpenTab: ChatProps['onOpenTab'];
  onTodoLocate: ChatProps['onTodoLocate'];
  onSideAsk: ChatProps['onSideAsk'];
}): JSX.Element {
  const { history, setChat, onOpenMemory, onOpenLearned, onOpenTab, onTodoLocate, onSideAsk, entries, ...list } = props;
  /** G7 write 展开的 diff 寻址键:条目 callId 直取(无 callId 面 undefined——不拉 diff,恒单列现内容) */
  const callIdOf = (entry: ChatEntry): string | undefined => {
    const cid = entry.callId;
    return cid !== undefined && cid.length > 0 ? cid : undefined;
  };
  return (
    <>
      {history !== undefined && !history.complete && (

        <div className="chat-history-tip" role="status">

          {history.failed === true ? (

            <button

              type="button"

              className="chat-history-retry"

              onClick={() => setChat((c) => (c.history ? { ...c, history: { ...c.history, failed: false } } : c))}

            >

              {t('Older history failed to load — click to retry', '更早的会话加载失败——点击重试')}

            </button>

          ) : (

            t('Loading earlier history…', '正在加载更早的会话…')

          )}

        </div>

      )}
      {/* 记忆/学习技能回显点击委托(2026-10-31 用户裁定「点击打开侧栏对应页签」):notice 行
          data-notice-tag/ref 由 EntryViews 落 DOM,此处统一接管开页签+定位 */}
      <div
        style={{ display: 'contents' }}
        onClick={(e) => {
          const el = (e.target as HTMLElement).closest('[data-notice-tag]');
          if (el === null) return;
          const tag = el.getAttribute('data-notice-tag');
          const ref = el.getAttribute('data-notice-ref') ?? '';
          if (tag === 'memory') onOpenMemory?.(ref);
          if (tag === 'skills') onOpenLearned?.(ref !== '' ? ref : undefined);
        }}
      >
      <SelActionsOverlay
        containerRef={props.chatScrollRef}
        onInsert={(text, content) =>
          // 2026-11-07 串扰根修:kind:'ref' 通道(token+content 同投)——主对话私有账本收,
          // 规范化改名后 hover/展开不落全局注册表兜底(键跨会话共享会取到别会话同键内容)
          window.dispatchEvent(new CustomEvent('sunshinex:insert-ref', { detail: { kind: 'ref', token: text, content, target: 'main' } }))
        }
        onSideAsk={(text, content) => {
          // 2026-11-06 用户裁定 P5:辅助会话内圈选「辅助会话提问」=插入当前侧 composer(不另开新辅助);
          // 主对话语境=走 onSideAsk 开辅助草稿(App 路由)。
          // 2026-11-07 串扰根修:辅助语境广播改 kind:'ref' 通道(token+content 同投,接收面写私有
          // 账本);纯 text 广播只落文字不落账=规范化改名后 hover 落全局兜底取到别会话同键内容
          if (props.sideChat === true) {
            // sideId 作用域(2026-11-07 用户实测「A 会话截取,B 会话也多一枚」):广播只投本会话
            window.dispatchEvent(new CustomEvent('sunshinex:insert-ref', { detail: { kind: 'ref', token: text, content, target: 'side', sideId: props.sessionId } }));
            return;
          }
          onSideAsk?.(text, content);
        }}
      />
      <MessageList
        {...list}
        entries={entries}
        callIdOf={callIdOf}
        onOpenTodos={(todos) => {
          onOpenTab?.('tasks');
          onTodoLocate?.(todos);
        }}
      />
      </div>
    </>
  );
}
