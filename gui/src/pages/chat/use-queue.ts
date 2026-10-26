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
  queued: Array<{ seq: number; text: string; images?: string[] }>;
  setQueued: React.Dispatch<React.SetStateAction<Array<{ seq: number; text: string; images?: string[] }>>>;
  queueFolded: boolean;
  setQueueFolded: React.Dispatch<React.SetStateAction<boolean>>;
  refreshQueued: () => void;
  pauseAndSend: (q: { seq: number; text: string; images?: string[] }) => Promise<void>;
} {
  /** 排队插话 chips(G10-C4;snapshot.queued 回显,撤回即本地移除);images=随行图片附件(快照直映) */
  const [queued, setQueued] = useState<Array<{ seq: number; text: string; images?: string[] }>>([]);
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
    async (q: { seq: number; text: string; images?: string[] }): Promise<void> => {
      setQueued((qs) => qs.filter((x) => x.seq !== q.seq));
      await conn.cancelSteer(sessionId, q.seq).catch(() => {}); // 撤队列失败不阻断:条目已本地移除,重复撤幂等
      await conn.sessionInterrupt(sessionId).catch(() => {}); // 中断失败不阻断:下方 snapshot 等 idle 兜底,仍未停则 submit 409 倒 error 条
      // 2026-10-26 立即暂停:run 信号已穿透前台阻塞面(exec 收割/模型中止/task_wait 穿透),
      // 收束通常亚秒;窗口放宽到 10s(40×250)覆盖在途模型调用收尾——旧 3s 窗在慢收尾下
      // 强行 submit 撞 409(「暂停并发送」反成错误条)。仍未 idle 则照旧 submit 面如实倒错
      for (let i = 0; i < 40; i += 1) {
        const snap = await conn.sessionSnapshot(sessionId).catch(() => undefined);
        if (snap !== undefined && snap.status === 'idle') break;
        await new Promise((r) => setTimeout(r, 250));
      }
      setChat((c) => appendUserMessage(c, q.text, undefined, q.images));
      await conn.sessionSubmit(sessionId, expandFileRefs(q.text, root, resolveFileRef), q.images).catch((err: unknown) => {
        // 提交失败必须可见(409=上一 run 未及退出/网络失败)——静默即「暂停并发送」的消息无声丢失
        setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
      });
    },
    [conn, sessionId, root, resolveFileRef, expandFileRefs, setChat],
  );
  return { queued, setQueued, queueFolded, setQueueFolded, refreshQueued, pauseAndSend };
}
