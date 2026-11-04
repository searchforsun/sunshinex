import { useEffect, useState } from 'react';
import { filterCommands } from '../../CommandPalette';
import type { CmdItem } from '../../CommandPalette';
import type { Connection } from '../../connection';

/** 「/」命令面板数据面（D32 批B 拆分自 Chat.tsx）：GET /commands 内置清单 +
 *  面板高亮游标。slashItemsFor 令牌解析与键盘导航的消费侧留在 Chat（渲染耦合），本 hook 只承载
 *  状态与装载。行为零变化（Chat.test 命令面板组为锚）。 */
export interface CmdData {
  commands: string[];
  descriptions: Record<string, string>;
  supported: string[];
}

export function useCommandPalette(conn: Connection): {
  cmdData: CmdData | null;
  setCmdData: React.Dispatch<React.SetStateAction<CmdData | null>>;
  cmdActive: number;
  setCmdActive: React.Dispatch<React.SetStateAction<number>>;
} {
  /** 「/」命令面板(G10-C4):数据源 GET /commands;输入以 / 起手即开,焦点恒留 textarea */
  const [cmdData, setCmdData] = useState<CmdData | null>(null);
  const [cmdActive, setCmdActive] = useState(0);
  /** 命令面板数据源(G10-C4):GET /commands 单点(清单/描述/supported) */
  useEffect(() => {
    conn.commands().then(setCmdData, () => setCmdData(null));
  }, [conn]);
  return { cmdData, setCmdData, cmdActive, setCmdActive };
}

/** slash 面板令牌清单:开头=内置命令清单(G10-C4 单一数据面),中间不弹(atStart 门),无匹配=空 */
export function slashItemsFor(
  data: { commands: string[]; descriptions: Record<string, string>; supported: string[] } | null,
  token: { query: string; atStart: boolean } | null,
): CmdItem[] {
  if (token === null) return [];
  if (!token.atStart || data === null) return [];
  return filterCommands(data.commands, data.descriptions, token.query, data.supported);
}
