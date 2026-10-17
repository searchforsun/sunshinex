import { useCallback, useState } from 'react';
import type { Connection } from '../../connection';
import type { ChatState } from '../../chat-reducer';
import { appendUserMessage, applyChatEvent } from '../../chat-reducer';

/** 队列面 hook（D32 批B 拆分自 Chat.tsx）：steering 排队 chips 的状态与动作——refreshQueued 快照
 *  回显、pauseAndSend「暂停当前轮并立即发送」、排队条目的本地增删与折叠。会话流可见化（setChat）
 *  与 @ 展开依赖由 Chat 注入；行为零变化（Chat.pause-send.test 为锚）。 */
export function useQueue(
  conn: Connection,
  sessionId: string,
  root: string | undefined,
  resolveFileRef: (name: string) => string | undefined,
  expandFileRefs: (text: string, root: string | undefined, resolve?: (name: string) => string | undefined) => string,
  setChat: React.Dispatch<React.SetStateAction<ChatState>>,
): {
  queued: Array<{ seq: number; text: string }>;
  setQueued: React.Dispatch<React.SetStateAction<Array<{ seq: number; text: string }>>>;
  queueFolded: boolean;
  setQueueFolded: React.Dispatch<React.SetStateAction<boolean>>;
  refreshQueued: () => void;
  pauseAndSend: (q: { seq: number; text: string }) => Promise<void>;
} {
  /** 排队插话 chips(G10-C4;snapshot.queued 回显,撤回即本地移除) */
  const [queued, setQueued] = useState<Array<{ seq: number; text: string }>>([]);
  /** G14.87 队列条折叠:折叠只留摘要行,不推高 dock(正文让位) */
  const [queueFolded, setQueueFolded] = useState(false);
  /** G14.83 队列操作后同步 daemon 快照(seq 会重排) */
  const refreshQueued = useCallback((): void => {
    conn.sessionSnapshot(sessionId).then(
      (s2) => setQueued(s2.queued ?? []),
      () => {},
    );
  }, [conn, sessionId]);
  /** G14.83 暂停当前轮并立即发送本条:撤队列→中断当前 run→等 idle→作为新任务提交。
   *  G14.89 本地回显用户气泡(与 submitText 同款)——submit 无回显帧时气泡不缺席 */
  const pauseAndSend = useCallback(
    async (q: { seq: number; text: string }): Promise<void> => {
      setQueued((qs) => qs.filter((x) => x.seq !== q.seq));
      await conn.cancelSteer(sessionId, q.seq).catch(() => {}); // 撤队列失败不阻断:条目已本地移除,重复撤幂等
      await conn.sessionInterrupt(sessionId).catch(() => {}); // 中断失败不阻断:下方 snapshot 等 idle 兜底,仍未停则 submit 409 倒 error 条
      for (let i = 0; i < 20; i += 1) {
        const snap = await conn.sessionSnapshot(sessionId).catch(() => undefined);
        if (snap !== undefined && snap.status === 'idle') break;
        await new Promise((r) => setTimeout(r, 150));
      }
      setChat((c) => appendUserMessage(c, q.text));
      await conn.sessionSubmit(sessionId, expandFileRefs(q.text, root, resolveFileRef)).catch((err: unknown) => {
        // 提交失败必须可见(409=上一 run 未及退出/网络失败)——静默即「暂停并发送」的消息无声丢失
        setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
      });
    },
    [conn, sessionId, root, resolveFileRef, expandFileRefs, setChat],
  );
  return { queued, setQueued, queueFolded, setQueueFolded, refreshQueued, pauseAndSend };
}
