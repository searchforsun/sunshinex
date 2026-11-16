import { AlarmClock, AppWindow, BookOpen, Bot, Brain, CalendarClock, ClipboardCheck, ClipboardList, FilePenLine, FileText, FolderSearch, GitBranch, GitMerge, Globe, Hourglass, Kanban, ListChecks, ListPlus, ListTodo, MessageCircleQuestion, NotebookPen, MousePointerClick, Package, PenLine, Puzzle, Radar, Search, Send, Sparkles, Square, SquareTerminal, Telescope, UserPlus, UsersRound, Wrench, type LucideIcon } from 'lucide-react';
import { COMPUTER_USE_PREFIX } from './computer-use-contract';
import { mcpToolParts } from './tool-entry-data';

/** 工具动词 → 图标(渲染面映射;md 形态不变,未知工具通用件);智能体团队工具专属图标(去扳手默认) */
const TOOL_ICONS: Record<string, LucideIcon> = {
  read: FileText, write: PenLine, edit: FilePenLine, exec: SquareTerminal, grep: Search, glob: FolderSearch,
  skill: Sparkles, webfetch: Globe, websearch: Telescope, memory: Brain, memory_write: Brain, todo_write: ListTodo,
  worktree: GitBranch, spawn: Bot, load_subagent: Bot, task_stop: Square, agent_team_task_stop: Square, task_wait: Hourglass, agent_team_task_wait: Hourglass, kb_search: BookOpen,
  // load_subagent 章程卡工具同 Bot(2026-11-05 更名;子智能体域,不受智能体团队控制)
  ask_question: MessageCircleQuestion, // G14.82:问询专属图标(不用扳手)
  exit_plan: NotebookPen, // 交稿行(2026-11-03 交稿协议):计划图标同 plan pill(2026-11-03 换 NotebookPen,与待办 ListTodo 区分)
  report_artifacts: Package, // 产物声明(2026-11-14 kind 化):图标对齐产物页签(tab 侧 Package 同件)
  load_agent_teams: UsersRound, // 智能体团队域(与八件套同族;同建队件;2026-11-05 更名自 team)
  create_agent_team_task: ListPlus, set_dependency: GitMerge, assign: UserPlus,
  // 建队/建成员同 UsersRound(2026-11-01 用户裁定:创建团队图标与创建成员一致)
  create_agent_team: UsersRound,
  create_agent_teammate: UsersRound,
  update_agent_team_task: ListChecks, get_agent_team_board: Kanban, probe: Radar,
  // sunx 编排/调度域(2026-11-15 用户实测「分派任的工具没有加上特殊的图标样式和 i18n」):
  // dispatch_task=Send(派发语义,与 send_agent_team_message 同族);task_status=ClipboardCheck
  // (台账窥视,与 get_task 的 ClipboardList 区分);定时族=闹钟/日历钟
  dispatch_task: Send, task_status: ClipboardCheck, schedule_wakeup: AlarmClock, schedule_task: CalendarClock,
  send_agent_team_message: Send,
  get_task: ClipboardList,
};

/** 工具行图标单点(原 ToolEntry 内联件平移,D62 批G):computer-use/browser/MCP 三分型 + 表驱动兜底 */
export function ToolIcon({ verb }: { verb: string }): JSX.Element {
  // computer-use 全族=鼠标点击件(2026-10-27 二次裁定:无专属色,className 留语义/查询锚)
  if (verb.startsWith(COMPUTER_USE_PREFIX)) {
    return <MousePointerClick size={14} strokeWidth={1.75} className="tool-icon-controlling" aria-hidden="true" />;
  }
  // 浏览器操作全族(browser-use 插件,工具名 browser_*)=浏览器窗件(2026-10-31 用户裁定:
  // 「换成浏览器相关的」——该插件即浏览器专用,通用拼图件不达意;AppWindow 与 webfetch 的
  // Globe 区分:一个是浏览器窗,一个是网页抓取)
  const mcp = mcpToolParts(verb);
  if (mcp !== null && mcp.tool.startsWith('browser_')) {
    return <AppWindow size={14} strokeWidth={1.75} className="tool-icon-browser" aria-hidden="true" />;
  }
  // MCP 工具=Puzzle 拼图件(业界 MCP 集成的通用视觉母题,区别于内置工具的扳手兜底)
  if (mcp !== null) return <Puzzle size={14} strokeWidth={1.75} aria-hidden="true" />;
  const Icon = TOOL_ICONS[verb] ?? Wrench;
  return <Icon size={14} strokeWidth={1.75} aria-hidden="true" />;
}
