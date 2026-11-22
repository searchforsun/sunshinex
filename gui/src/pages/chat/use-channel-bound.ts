import { useEffect, useState } from 'react';
import type { ChannelBindingMsg } from '../../connection-api';

/**
 * 通道会话判定(2026-11-22 用户裁定「/new 会话提示显示成普通系统提示,不是欢迎页图标」):
 * journalId 命中绑定档 = 通道域会话——MessageList 空态据此走系统提示行分支(不走 hero)。
 * ChannelInfoBar 同判据自守卫渲染;本钩子供 Chat 层共享该布尔(拉取失败=非通道,静默降级;
 * conn 缺 channelBindings 方法(旧测试桩)同口径)。
 */
interface ChannelBoundConn {
  channelBindings?(): Promise<{ bindings: ChannelBindingMsg[] }>;
}

export function useIsChannelJournal(conn: ChannelBoundConn | null, journalId: string): boolean {
  const [bound, setBound] = useState(false);
  useEffect(() => {
    if (conn === null || journalId === '' || typeof conn.channelBindings !== 'function') {
      setBound(false);
      return;
    }
    let alive = true;
    conn.channelBindings().then(
      (r) => {
        if (alive) setBound(r.bindings.some((b) => b.journalId === journalId));
      },
      () => {
        if (alive) setBound(false); // 拉取失败=非通道口径(信息条整块 null 同语义)
      },
    );
    return () => {
      alive = false;
    };
  }, [conn, journalId]);
  return bound;
}
