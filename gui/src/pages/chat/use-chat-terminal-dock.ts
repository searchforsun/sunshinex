import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { loadDockSession } from '../../tabs/terminal-dock';
import { useConfigChanged } from '../../settings/use-config-changed';
import { useDeveloperMode } from '../../developer-mode';
import type { ChatProps } from './chat-types';

/**
 * 终端下栏显隐簇(Chat 外提,D62 批I;2026-11-10 终端下栏):显能读 settings·terminalDock(on/off,
 * 缺省 on;use-chat-session-info 同款挂载拉取+config-changed 重拉),面板显隐本地态(入口钮切;
 * 设置翻 off 即卸载 dock)。开态与会话绑定(localStorage 会话键,重启/切会话各回各档);高度全局档
 * 经 dock 上报。测试桩/旁路面:无设置面即保缺省开。
 */
export function useChatTerminalDock({ conn, sessionId, root, sideChat }: {
  conn: ChatProps['conn'];
  sessionId: string;
  root: string | undefined;
  sideChat: boolean | undefined;
}): { dockOpen: boolean; setDockOpen: Dispatch<SetStateAction<boolean>>; dockHeight: number; setDockHeight: Dispatch<SetStateAction<number>>; terminalDockEnabled: boolean } {
  /** 终端下栏开态与会话绑定(localStorage 会话键,重启/切会话各回各档);高度全局档经 dock 上报 */
  const [dockOpen, setDockOpen] = useState(() => loadDockSession(sessionId).open);
  const [dockHeight, setDockHeight] = useState(260);
  useEffect(() => { setDockOpen(loadDockSession(sessionId).open); }, [sessionId]);
  /** 2026-11-17 用户裁定「非开发者模式下终端是关的」:普通态恒关(设置行同时隐藏),开发者模式才读 settings·terminalDock */
  const dev = useDeveloperMode();
  const [dockEnabled, setDockEnabled] = useState(true);
  const dockCfgTicks = useConfigChanged(conn);
  useEffect(() => {
    if (typeof conn.settings !== 'function') return; // 测试桩/旁路面:无设置面即保缺省开
    conn.settings(root).then(
      (view) => setDockEnabled(view.keys.find((k) => k.key === 'terminalDock')?.value !== 'off'),
      () => undefined,
    );
  }, [conn, root, dockCfgTicks.settings]);
  const terminalDockEnabled = dev && dockEnabled && sideChat !== true;
  return { dockOpen, setDockOpen, dockHeight, setDockHeight, terminalDockEnabled };
}
