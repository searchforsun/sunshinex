import { useEffect, useRef, useState, type RefObject } from 'react';
import { filterCommands } from '../CommandPalette';
import { slashTokenAt } from '../pages/Chat';
import type { WelcomeComposerConn } from './welcome-conn';

/** 欢迎页 / 命令面板数据簇（D62 批C，2026-11-07 自 WelcomeComposer 外提——行为零变化）：命令清单+技能
 *  清单（惰性拉取 5s 节流+项目切换强制重拉）+ 高亮/Esc 收起态 + 渲染期面板项派生。宿主只消费返回面。 */
export function useWelcomeSlash(conn: WelcomeComposerConn, picked: string, goal: string, goalRef: RefObject<HTMLTextAreaElement | null>) {
  /** G14.213 欢迎页 / 命令面板(与会话内同构):命令清单+技能(skillsGroups,无会话依赖) */
  const [welcomeCmdData, setWelcomeCmdData] = useState<{ commands: string[]; descriptions: Record<string, string>; supported: string[] } | null>(null);
  const [welcomeSkills, setWelcomeSkills] = useState<Array<{ id: string; desc: string }>>([]);
  const [welcomeCmdActive, setWelcomeCmdActive] = useState(0);
  const [welcomeSlashDismissed, setWelcomeSlashDismissed] = useState<string | null>(null);
  useEffect(() => {
    conn.commands().then(setWelcomeCmdData, () => setWelcomeCmdData(null));
  }, [conn]);
  /** G14.213 技能清单惰性拉取:敲 `/`/点开 + 面板起手拉(挂载即拉会污染 G8c skillsGroupsCalls 计数)。
   *  2026-10-31 用户裁定:主动触发即可拉最新清单,5s 节流防抖(时间戳闸替代单次布尔闸——
   *  首拉恒过,窗口内重复触发静默跳过) */
  const WELCOME_SKILLS_THROTTLE_MS = 5000;
  const welcomeSkillsAtRef = useRef(0);
  const fetchWelcomeSkills = (force = false): void => {
    if (!force && Date.now() - welcomeSkillsAtRef.current < WELCOME_SKILLS_THROTTLE_MS) return;
    welcomeSkillsAtRef.current = Date.now();
    conn.skillsGroups?.(picked).then(
      (r) => {
        const out: Array<{ id: string; desc: string }> = [];
        for (const g of r.groups) for (const s of g.skills) if (!out.some((x) => x.id === s.id)) out.push({ id: s.id, desc: s.description ?? '' });
        setWelcomeSkills(out);
      },
      () => undefined,
    );
  };
  // 项目切换/新建登记后静默重拉（2026-10-30 用户裁定「创建项目后该加载都要静默加载」）：已拉过清单时
  // 切到新项目（选中/新建/登记）即强制重拉该 root 的 skills（绕过 5s 节流——项目语义变更非防抖对象）；
  // 未拉过（还没敲 `/`）不拉，惰性口径与 G8c 计数污染防护不变（同 workspaceFiles 的 [picked] effect 对照口径）
  useEffect(() => {
    if (welcomeSkillsAtRef.current === 0) return;
    fetchWelcomeSkills(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);
  /** G14.213 欢迎页 / 面板项(渲染期,光标位置):行首 /token → 命令+技能;行中 → 仅技能池
   *  (2026-11-05 用户二次裁定与会话内同构);空=面板不开 */
  const welcomeSlashItems = (() => {
    const caret = goalRef.current?.selectionStart ?? goal.length;
    const tok = slashTokenAt(goal, caret);
    if (tok === null || welcomeCmdData === null || `/${tok.query}` === (welcomeSlashDismissed ?? '\u0000')) return null;
    const q = tok.query.toLowerCase();
    const skills = welcomeSkills
      .filter((s) => q === '' || s.id.toLowerCase().startsWith(q) || s.id.toLowerCase().includes(q))
      .slice(0, 8)
      .map((s) => {
        const idx = s.id.toLowerCase().indexOf(q);
        return { cmd: `/${s.id}`, name: s.id, desc: s.desc, idx: idx < 0 ? s.id.length : idx, ok: true, kind: 'skill' as const };
      });
    const cmds = tok.atStart && welcomeCmdData !== null ? filterCommands(welcomeCmdData.commands, welcomeCmdData.descriptions, tok.query, welcomeCmdData.supported) : [];
    const all = [...cmds, ...skills];
    return all.length > 0 ? all : null;
  })();
  return { welcomeCmdData, welcomeSkills, welcomeCmdActive, setWelcomeCmdActive, welcomeSlashDismissed, setWelcomeSlashDismissed, fetchWelcomeSkills, welcomeSlashItems };
}
