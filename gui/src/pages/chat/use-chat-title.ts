import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Connection } from '../../connection';
import type { ChatEntry } from '../../chat-reducer';

/** 会话标题子系统(D32 第六批批F-6 自 Chat.tsx 平移,行为零变化):daemon 旁车 meta 单源
 *  (挂载 GET 回读/模型总结一次/rename 乐观落盘)。编辑态与草稿返还宿主(顶栏消费)。 */
export function useChatTitle(deps: {
  readonly conn: Connection;
  readonly sessionId: string;
  readonly fixedTitle: string | undefined;
  readonly entries: ChatEntry[];
  readonly onRenamed?: () => void;
}): {
  titleEditing: boolean;
  setTitleEditing: Dispatch<SetStateAction<boolean>>;
  titleDraft: string;
  setTitleDraft: Dispatch<SetStateAction<string>>;
  commitTitle: () => void;
  displayTitle: string;
} {
  const { conn, sessionId, fixedTitle, entries, onRenamed } = deps;
/** 会话标题(G14.16/G14.17 统一流):单源=daemon 旁车 meta——rename 落盘、挂载 GET 回读,
 *  顶栏/侧栏/TUI 一名三处;零历史兼容(旧 localStorage 键不读不迁,旧会话删档重测)。
 *  缺省回落首条用户消息摘要,再落会话 id。点击标题即改 */
const [title, setTitle] = useState<string | null>(null);
const [titleLoaded, setTitleLoaded] = useState(false);
const [titleEditing, setTitleEditing] = useState(false);
const [titleDraft, setTitleDraft] = useState('');
const firstUserText = (() => {
  const md = entries.find((e) => e.kind === 'user')?.md ?? '';
  return md.startsWith('> ') ? md.slice(2) : md;
})();
const displayTitle = fixedTitle ?? title ?? (firstUserText !== '' ? firstUserText : sessionId);
/** onRenamed 同步镜像(applyTitle 闭包经 ref 读,免依赖数组抖动) */
const onRenamedRef = useRef(onRenamed);
onRenamedRef.current = onRenamed;
/** rename 单点(G14.16):乐观上屏 + 旁车落盘(静默降级——失败面下次挂载 GET 回读回真值) +
 *  侧栏刷新上抛 */
const applyTitle = useCallback(
  (v: string): void => {
    setTitle(v);
                  // 改名失败=顶栏回落 daemon 权威名(下次快照刷新),不静默改写本地
    if (typeof conn.renameSession === 'function') void conn.renameSession(sessionId, v).catch(() => undefined);
    onRenamedRef.current?.();
  },
  [conn, sessionId],
);
const commitTitle = (): void => {
  setTitleEditing(false);
  const v = titleDraft.trim();
  if (v === '' || v === displayTitle) return;
  applyTitle(v);
};
/** 挂载回读(一次):服务端有名→采用;GET 落定前 titleLoaded 门关着——总结调用不抢跑,
 *  改名标题恒压过模型总结(免 GET/总结竞争互覆)。GET 未知会话 404 静默(Chat 仅挂于 live 会话) */
useEffect(() => {
  if (typeof conn.getSessionTitle !== 'function') {
    setTitleLoaded(true);
    return;
  }
  let alive = true;
  conn.getSessionTitle(sessionId).then(
    ({ title: srv }) => {
      if (!alive) return;
      if (srv !== undefined && srv.trim() !== '') setTitle(srv);
      setTitleLoaded(true);
    },
    () => {
      if (alive) setTitleLoaded(true);
    },
  );
  return () => {
    alive = false;
  };
}, [conn, sessionId]);
/** 模型总结(一次,回读落定后):无自定义名且有首条消息时调用,结果走 applyTitle 落盘统一流;
 *  失败静默回落摘要。tried 门:503 降级/竞争下不反复重发 */
const summarizeTriedRef = useRef(false);
useEffect(() => {
  if (!titleLoaded || title !== null || firstUserText === '' || summarizeTriedRef.current) return;
  if (typeof conn.sessionTitle !== 'function') return;
  summarizeTriedRef.current = true;
  let alive = true;
  conn.sessionTitle(sessionId, firstUserText).then(
    ({ title: gen }) => {
      if (!alive || gen.trim() === '') return;
      applyTitle(gen.trim());
    },
    () => undefined,
  );
  return () => {
    alive = false;
  };
}, [conn, sessionId, firstUserText, title, titleLoaded, applyTitle]);
  return { titleEditing, setTitleEditing, titleDraft, setTitleDraft, commitTitle, displayTitle };
}
