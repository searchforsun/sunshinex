import { useCallback, useMemo, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { applyChatEvent } from '../../chat-reducer';
import type { ChatEntry, ChatState } from '../../chat-reducer';
import { t } from '../../i18n';
import { notifyGitChanged } from './use-live-changes';
import type { ChatProps, RewindOps, RewindRequest } from './chat-types';

/**
 * 回退/派生轮寻址簇(Chat 外提,D62 批I):onForkRun=run 条目键→转录中的 1-based 轮次序位
 * (逐轮 fork 寻址,ref 镜像保引用恒稳——MessageList 组级 memo 判等不破);rewindOps=气泡回退
 * 操作面(用户消息按倒序寻址——转录可能只播种了尾窗,且轮内插入让 run 序≠锚点序;resend 文本
 * 在此展开:引用账本属当前 Chat,回退换座后新 Chat 查不到本卡新加的 @文件/片段);onTurnRestore=
 * 轮次 checkpoint 撤销通道(2026-11-10 用户裁定「每轮精确看到自己的改动、能撤销」,成功广播
 * git 变点同步审查页,失败落 error 条;App 未接通道/旧档缺 runSeq 时 RunChangesBar 内部自回退
 * 审查页/git restore 语义)。
 */
export function useChatUndo({ conn, sessionId, chatRef, entries, expandRefsRef, setChat, onFork, onRewind, onOpenTurnDiff }: {
  conn: ChatProps['conn'];
  sessionId: string;
  chatRef: { current: ChatState };
  entries: ChatEntry[];
  expandRefsRef: { current: (text: string) => string };
  setChat: Dispatch<SetStateAction<ChatState>>;
  onFork: ChatProps['onFork'];
  onRewind: ChatProps['onRewind'];
  onOpenTurnDiff: ChatProps['onOpenTurnDiff'];
}): { onForkRun: (runKey: string) => void; rewindOps: RewindOps | undefined; onTurnOpen: (run: number, path: string) => void; onTurnRestore: (run: number, paths: string[]) => Promise<Array<{ path: string; ok: boolean; stale?: boolean; noCheckpoint?: boolean }>> } {
  /** run 条目键→轮次序位(2026-11-04 逐轮 fork):run 在转录中的 1-based 序=daemon 轮锚点序
   *  (每轮一 task 行),宿主按此分档——点哪轮,fork 其上全部记录。ref 镜像保引用恒稳(MessageList
   *  组级 memo 判等不破) */
  const chatEntriesRef = useRef(entries);
  chatEntriesRef.current = entries;
  const onForkRef = useRef(onFork);
  onForkRef.current = onFork;
  const onForkRun = useCallback((runKey: string): void => {
    let n = 0;
    for (const e of chatEntriesRef.current) {
      if (e.kind !== 'run') continue;
      n += 1;
      if (e.key === runKey) {
        onForkRef.current?.(n);
        return;
      }
    }
  }, []);
  const onRewindRef = useRef(onRewind);
  onRewindRef.current = onRewind;
  const hasRewind = onRewind !== undefined;
  const rewindOps = useMemo<RewindOps | undefined>(() => {
    if (!hasRewind) return undefined;
    const fromEnd = (entry: ChatEntry): { userFromEnd: number } => {
      const users = chatEntriesRef.current.filter((e) => e.kind === 'user');
      return { userFromEnd: users.length - 1 - users.findIndex((e) => e.key === entry.key) };
    };
    const rewind = (req: RewindRequest): Promise<void> => onRewindRef.current?.(req) ?? Promise.resolve();
    return {
      busy: () => {
        const st = chatRef.current;
        return st.status === 'running' || st.entries.some((en) => en.kind === 'tool' && typeof en.name === 'string' && en.name.startsWith('/') && en.result === undefined);
      },
      planForEntry: (entry) => conn.restorePlan(sessionId, fromEnd(entry)),
      // 文本在此展开:引用账本属当前 Chat,回退换座后新 Chat 查不到本卡新加的 @文件/片段
      resendFrom: (entry, text, images, restoreFiles) => rewind({
        target: fromEnd(entry),
        restoreFiles,
        resend: { text: expandRefsRef.current(text), ...(images !== undefined ? { images } : {}) },
      }),
    };
  }, [hasRewind, conn, sessionId, chatRef, expandRefsRef]);

  /** 轮次 checkpoint 通道(2026-11-10 用户裁定「每轮精确看到自己的改动、能撤销」):
   *  文件名点击 → turndiff 页签(run+path 寻址,冻结轮 diff);撤销 → turn-restore(前像回写,
   *  staleness 逐路径回传;成功广播 git 变点同步审查页)。App 未接通道/旧档缺 runSeq 时
   *  RunChangesBar 内部自回退审查页/git restore 语义 */
  const onTurnOpen = useCallback((run: number, path: string) => { onOpenTurnDiff?.(run, path); }, [onOpenTurnDiff]);
  const onTurnRestore = useCallback((run: number, paths: string[]) =>
    conn.turnRestore(sessionId, run, paths).then(
      (r) => {
        if (r.results.some((x) => x.ok)) notifyGitChanged();
        return r.results;
      },
      (err: unknown) => {
        setChat((c) => applyChatEvent(c, { type: 'error', text: `${t('Revert failed', '撤销失败')}: ${err instanceof Error ? err.message : String(err)}`, ts: Date.now() }));
        return [];
      },
    ), [conn, sessionId, setChat]);
  return { onForkRun, rewindOps, onTurnOpen, onTurnRestore };
}
