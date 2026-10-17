import { useEffect, useState } from 'react';
import type { Connection } from '../../connection';

/** 「/」命令面板数据面（D32 批B 拆分自 Chat.tsx）：GET /commands 清单 + 会话维技能命令清单 +
 *  面板高亮游标。slashItemsFor 令牌解析与键盘导航的消费侧留在 Chat（渲染耦合），本 hook 只承载
 *  状态与装载。行为零变化（Chat.test 命令面板组为锚）。 */
export interface CmdData {
  commands: string[];
  descriptions: Record<string, string>;
  supported: string[];
}

export function useCommandPalette(
  conn: Connection,
  sessionId: string,
): {
  cmdData: CmdData | null;
  setCmdData: React.Dispatch<React.SetStateAction<CmdData | null>>;
  cmdActive: number;
  setCmdActive: React.Dispatch<React.SetStateAction<number>>;
  skillCmds: Array<{ id: string; description: string }>;
} {
  /** 「/」命令面板(G10-C4):数据源 GET /commands;输入以 / 起手即开,焦点恒留 textarea */
  const [cmdData, setCmdData] = useState<CmdData | null>(null);
  const [cmdActive, setCmdActive] = useState(0);
  /** G14.95 技能命令清单(会话维):/ 面板混入技能项;中间 / 只弹技能 */
  const [skillCmds, setSkillCmds] = useState<Array<{ id: string; description: string }>>([]);
  useEffect(() => {
    (conn.skillCommands?.(sessionId) ?? Promise.resolve([])).then(setSkillCmds, () => setSkillCmds([]));
  }, [conn, sessionId]);
  /** 命令面板数据源(G10-C4):GET /commands 单点(清单/描述/supported) */
  useEffect(() => {
    conn.commands().then(setCmdData, () => setCmdData(null));
  }, [conn]);
  return { cmdData, setCmdData, cmdActive, setCmdActive, skillCmds };
}
