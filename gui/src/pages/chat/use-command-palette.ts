import { useCallback, useEffect, useState } from 'react';
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

/** 技能行数据（2026-11-05 用户裁定：技能回归 / 触发面板——插入引用行，非命令派发；
 *  三源合并去重同 + 面板技能区口径） */
export interface SkillRow {
  id: string;
  desc: string;
}

export function useCommandPalette(
  conn: Connection,
  /** 工作区 root（skills project 组源；缺省/空/'default' 只拉 user/learned——Chat 同款守卫） */
  root?: string,
): {
  cmdData: CmdData | null;
  setCmdData: React.Dispatch<React.SetStateAction<CmdData | null>>;
  cmdActive: number;
  setCmdActive: React.Dispatch<React.SetStateAction<number>>;
  skills: SkillRow[];
  /** 技能行现拉(2026-11-07 用户实测「+ 能实时加出来,/ 不实时」根修):装载原挂载只跑一次,
   *  运行中新装技能不上 / 面板——消费侧在 / 面板弹出时调用(与 + 面板每次现拉同口径) */
  reloadSkills: () => void;
} {
  /** 「/」命令面板(G10-C4):数据源 GET /commands;输入以 / 起手即开,焦点恒留 textarea */
  const [cmdData, setCmdData] = useState<CmdData | null>(null);
  const [cmdActive, setCmdActive] = useState(0);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  /** 命令面板数据源(G10-C4):GET /commands 单点(清单/描述/supported) */
  useEffect(() => {
    conn.commands().then(setCmdData, () => setCmdData(null));
  }, [conn]);
  /** 技能行(2026-11-05):GET /settings/skills 三源去重合并(与 + 面板技能区同款投影);
   *  失败静默空列(面板仅少技能组,不拖垮命令清单) */
  const reloadSkills = useCallback((): void => {
    if (typeof conn.skillsGroups !== 'function') return; // 桩面缺法即空技能行(+面板同款守卫)
    const refRoot = root !== undefined && root !== '' && root !== 'default' ? root : undefined;
    conn.skillsGroups(refRoot).then(
      (r) => {
        const seen = new Set<string>();
        const rows: SkillRow[] = [];
        for (const g of r.groups) {
          for (const s of g.skills) {
            if (seen.has(s.id)) continue;
            seen.add(s.id);
            rows.push({ id: s.id, desc: s.description ?? s.name ?? '' });
          }
        }
        setSkills(rows);
      },
      () => setSkills([]),
    );
  }, [conn, root]);
  useEffect(reloadSkills, [reloadSkills]);
  return { cmdData, setCmdData, cmdActive, setCmdActive, skills, reloadSkills };
}

/** slash 面板令牌清单(2026-11-05 用户二次裁定:行中 / 也要弹——仅技能池,行首=命令+技能;
 *  kind='skill',G14.213 纯文本语义:Enter 有参=普通发送落软引用,不回命令通道;点击/Tab=
 *  补全 `/id `)。命令在前技能在后,各自按命中位排序;无匹配=空(面板自动关) */
export function slashItemsFor(
  data: { commands: string[]; descriptions: Record<string, string>; supported: string[] } | null,
  token: { query: string; atStart: boolean } | null,
  skills: SkillRow[] = [],
): CmdItem[] {
  if (token === null) return [];
  const q = token.query.toLowerCase();
  const skillItems = skills
    .map((s) => ({ cmd: `/${s.id}`, name: s.id, desc: s.desc, idx: s.id.toLowerCase().indexOf(q), ok: true, kind: 'skill' as const }))
    .filter((x) => x.idx >= 0)
    .sort((a, b) => a.idx - b.idx);
  if (!token.atStart) return skillItems; // 行中 = 仅技能池(命令面板只在行首)
  if (data === null) return skillItems; // 命令清单未达,技能照弹
  return [...filterCommands(data.commands, data.descriptions, token.query, data.supported), ...skillItems];
}
