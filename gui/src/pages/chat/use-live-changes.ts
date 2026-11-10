/**
 * 轮尾改动条动态渲染(2026-11-07 用户裁定「配合 git 就和审查对上;git 已提交的就不显示,避免冲突
 * 错误;最好动态渲染」):Chat 持有本会话一份**当前** git 变动清单(与侧栏审查页同源
 * conn.sessionChanges),各轮汇总条只显示「本轮记录路径 ∩ 当前变动」,行数取当前 git 值——
 * 已提交/已撤销/已手工还原的文件自然退场;他会话同期改动混入属 git 口径固有,不另行剔除。
 *
 * 刷新时机:挂载/换会话、run 收尾(running→false)、窗口回焦、`sunshinex:git-changed` 事件
 * (撤销/审查页刷新与提交后广播)、可见期 10s 轮询(内置终端里手工 commit 等无事件面)。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export interface LiveChangeFile {
  path: string;
  status: string;
  added: number | null;
  deleted: number | null;
  newLines?: number;
}

/** undefined=首拉未落定(汇总条暂不渲染,免闪出已提交项);null=拉取失败(回落轮记录) */
export type LiveChanges = readonly LiveChangeFile[] | null | undefined;

export const LiveChangesContext = createContext<LiveChanges>(null);
export const useLiveChanges = (): LiveChanges => useContext(LiveChangesContext);

/** git 变动广播:撤销/提交/审查页刷新后发,各会话 Chat 重拉 */
export const GIT_CHANGED_EVENT = 'sunshinex:git-changed';
export function notifyGitChanged(): void {
  window.dispatchEvent(new Event(GIT_CHANGED_EVENT));
}

const POLL_MS = 10_000;

export function useLiveGitChanges(
  /** 返回 null=非 git 目录(2026-11-10:checkpoint 面 git 无关,改动卡回落轮记录原样)或拉取失败——
   *  live 缺场时 visibleRunChanges 回落轮记录,轮次数据仍可见 */
  fetcher: (() => Promise<{ files: LiveChangeFile[] } | null>) | undefined,
  sessionId: string,
  running: boolean,
  /** 会话内有轮改动记录才拉(无汇总条的会话/辅助对话零 git 开销) */
  enabled: boolean,
): LiveChanges {
  const [files, setFiles] = useState<LiveChanges>(undefined);
  const genRef = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const load = useCallback((): void => {
    const f = fetcherRef.current;
    if (f === undefined || sessionId === '' || !enabledRef.current) {
      setFiles(null);
      return;
    }
    const gen = ++genRef.current;
    f().then(
      (r) => {
        if (gen === genRef.current) setFiles(r === null ? null : r.files);
      },
      () => {
        if (gen === genRef.current) setFiles((prev) => (prev === undefined ? null : prev));
      },
    );
  }, [sessionId]);

  useEffect(() => {
    setFiles(undefined);
    load();
  }, [load, enabled]);

  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) load();
    wasRunning.current = running;
  }, [running, load]);

  useEffect(() => {
    if (!enabled) return;
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') load();
    };
    window.addEventListener('focus', load);
    window.addEventListener(GIT_CHANGED_EVENT, load);
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, POLL_MS);
    return () => {
      window.removeEventListener('focus', load);
      window.removeEventListener(GIT_CHANGED_EVENT, load);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [load, enabled]);

  return files;
}

/** 轮记录 ∩ 当前 git 变动:行数取当前值(与审查页一致);live=null(拉取失败)回落轮记录原样 */
export function visibleRunChanges<T extends LiveChangeFile>(recorded: readonly T[], live: LiveChanges): readonly LiveChangeFile[] {
  if (live === undefined) return [];
  if (live === null) return recorded;
  const now = new Map(live.map((f) => [f.path, f]));
  return recorded.flatMap((r) => {
    const cur = now.get(r.path);
    return cur !== undefined ? [cur] : [];
  });
}
