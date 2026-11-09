import { Fragment, memo, useEffect, useState } from 'react';
import { FileText, Wrench, PenLine, FilePenLine, SquareTerminal, Search, FolderSearch, ChevronRight, Sparkles, Globe, Telescope, Brain, ListTodo, ListChecks, Kanban, Radar, GitBranch, Bot, Square, Hourglass, BookOpen, MessageCircleQuestion, NotebookPen, ListPlus, GitMerge, UserPlus, UsersRound, Puzzle, AppWindow, MousePointerClick, Send, ClipboardList, type LucideIcon } from 'lucide-react';
import { t } from '../../i18n';
import type { ChatEntry } from '../../chat-reducer';
import type { Connection } from '../../connection';
import { FileIcon } from '../../file-icon';
import { ImageLightbox } from '../../ImageLightbox';
import { COMPUTER_USE_PREFIX } from './computer-use-contract';
import type { DiffResp } from '../../connection';
import { mcpToolParts, MCP_TOOL_LABELS, zhToolName, toolTargetOf, toolPurposeOf, RUNNING_LABELS, TASK_OP_TOOLS, TASK_OP_RUNNING, fileLabelOf, writeStatOf } from './tool-entry-data';
import { ReadImageBody } from './tool-entry-media';
import { ToolEntryBody } from './tool-entry-body';
import { isOfficeStandaloneTool, useUiMode } from '../../ui-mode';
import { officeSingleLabel } from './office-summary';

/** 工具动词 → 图标(渲染面映射;md 形态不变,未知工具通用件);智能体团队工具专属图标(去扳手默认) */
const TOOL_ICONS: Record<string, LucideIcon> = {
  read: FileText, write: PenLine, edit: FilePenLine, exec: SquareTerminal, grep: Search, glob: FolderSearch,
  skill: Sparkles, webfetch: Globe, websearch: Telescope, memory: Brain, memory_write: Brain, todo_write: ListTodo,
  worktree: GitBranch, spawn: Bot, load_subagent: Bot, task_stop: Square, agent_team_task_stop: Square, task_wait: Hourglass, agent_team_task_wait: Hourglass, kb_search: BookOpen,
  // load_subagent 章程卡工具同 Bot(2026-11-05 更名;子智能体域,不受智能体团队控制)
  ask_question: MessageCircleQuestion, // G14.82:问询专属图标(不用扳手)
  exit_plan: NotebookPen, // 交稿行(2026-11-03 交稿协议):计划图标同 plan pill(2026-11-03 换 NotebookPen,与待办 ListTodo 区分)
  load_agent_teams: UsersRound, // 智能体团队域(与八件套同族;同建队件;2026-11-05 更名自 team)
  create_agent_team_task: ListPlus, set_dependency: GitMerge, assign: UserPlus,
  // 建队/建成员同 UsersRound(2026-11-01 用户裁定:创建团队图标与创建成员一致)
  create_agent_team: UsersRound,
  create_agent_teammate: UsersRound,
  update_agent_team_task: ListChecks, get_agent_team_board: Kanban, probe: Radar,
  send_agent_team_message: Send,
  get_task: ClipboardList,
};

/** 电脑控制类工具(2026-10-27 用户裁定):computer-use server 全族专属图标前缀(MousePointerClick,
 *  区别于通用 MCP 拼图件)——图标标类(含观察件),徽标标进行中的控制;特殊色只归顶栏徽标(2026-10-27
 *  二次裁定:工具行不用特殊色),className 留作语义/查询锚;前缀常量单点在 computer-use-contract
 *  (2026-10-27 技术债轮收敛,与徽标判定面/插件 manifest 三方同源,对拍钉锁镜像) */

/** MCP 工具名拆解单点(2026-10-26 用户裁定:MCP 工具行显业界通用图标+短工具名,参数/返回值同其他工具):
 *  登记名 `mcp__<server>__<tool>` → { server, tool };非 MCP 名返回 null。server 段取首个 `__` 前
 *  (server 键不含 `__`——配置名即文件/清单键),tool 段为余量(可含 `__`) */
function ToolIcon({ verb }: { verb: string }): JSX.Element {
  // computer-use 全族=鼠标点击件(2026-10-27 二次裁定:无专属色,className 留语义/查询锚)
  if (verb.startsWith(COMPUTER_USE_PREFIX)) {
    return <MousePointerClick size={12} strokeWidth={1.75} className="tool-icon-controlling" aria-hidden="true" />;
  }
  // 浏览器操作全族(browser-use 插件,工具名 browser_*)=浏览器窗件(2026-10-31 用户裁定:
  // 「换成浏览器相关的」——该插件即浏览器专用,通用拼图件不达意;AppWindow 与 webfetch 的
  // Globe 区分:一个是浏览器窗,一个是网页抓取)
  const mcp = mcpToolParts(verb);
  if (mcp !== null && mcp.tool.startsWith('browser_')) {
    return <AppWindow size={12} strokeWidth={1.75} className="tool-icon-browser" aria-hidden="true" />;
  }
  // MCP 工具=Puzzle 拼图件(业界 MCP 集成的通用视觉母题,区别于内置工具的扳手兜底)
  if (mcp !== null) return <Puzzle size={12} strokeWidth={1.75} aria-hidden="true" />;
  const Icon = TOOL_ICONS[verb] ?? Wrench;
  return <Icon size={12} strokeWidth={1.75} aria-hidden="true" />;
}

/** G6 工具条目(折叠态一行/点击展开):write/edit 两件(call 名判定——事件 text 即
 *  注册名)展开接 G7 fetchDiff(oldStr=oldContent/newStr=newContent 双列;加载期先示右列现内容
 *  +加载标,404/失败退 input 侧兜底——write=newContent/edit=oldString→newString 替换对;
 *  快照种子条/无 callId 面恒兜底列)+ path 文本按钮(G8d 起
 *  callId 在场优先 onOpenDiff 开 diff 标签,缺场回落 onOpenFile 文件标签预览);其他工具展开
 *  Input/Output 双段(G11 §2:input JSON + result 全文,各段 280px 内滚)。P11 T7 字段单源:
 *  name/input/result/status 直映 entry 字段(旁路 info prop 随工具 input 暂存退役——G6 双通道
 *  归一),md 解析全数退役。折叠壳 grid 化(0fr→1fr 生长):展开面常挂 DOM,折叠仅 CSS 收起。 */
/** P1 行级 memo(Task 3):entry 身份由 chat-reducer WeakMap 视图缓存保证(未变行引用恒定),
 *  MessageList 侧回调经 ref 稳定化——token 帧重渲染时本组件 props 全等即 bail-out,
 *  行体(含 exec 高亮 highlightCode 调用)零执行。导出名不变(AgentTranscriptTab 等消费面无感) */
export const ToolEntryView = memo(function ToolEntryView({
  entry,
  conn,
  sessionId,
  callId,
  onOpenFile,
  onOpenDiff,
  onOpenAgent,
  onOpenTodos,
  onOpenTask,
  onOpenLeader,
  taskNameOf,
  teamNameOf,
  teams,
  taskAgentOf,
}: {
  entry: ChatEntry;
  conn: Connection;
  sessionId: string;
  callId?: string;
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (callId: string, path: string) => void;
  /** G14.171 spawn 行子智能体名=蓝色链接,点开对应 agent 只读标签页(App 注入 openTabInSession) */
  onOpenAgent?: (label: string, agentTitle: string, task?: string) => void;
  /** 任务名/队名链接:`bg:` 前缀=后台任务账本行;`team:` 前缀开指定队卡;其余开板高亮(App openTaskFocus) */
  onOpenTask?: (taskRef: string) => void;
  /** 成员转录面:发给 leader 的消息行点击 leader → 主对话定位该消息气泡(2026-11-08;缺省=开队卡) */
  onOpenLeader?: (m: { text: string }) => void;
  /** 2026-11-04 用户裁定:点「待办」字样打开侧栏待办页签并定位对应卡 */
  onOpenTodos?: (todos: Array<{ text: string; status: string }>) => void;
  /** G14.172 task_wait 行任务名解析(App 注入:board+转录映射单点;缺省显示原 id) */
  taskNameOf?: (id: string) => string;
  /** 队名解析(get_agent_team_board/create_agent_team;缺省显示原 ref) */
  teamNameOf?: (ref: string) => string;
  /** 会话团队清单(get_agent_team_board 单队回落队名) */
  teams?: readonly { teamId: string; name: string }[];
  /** 后台任务 id → 子智能体(后台 spawn 回执映射;非子智能体任务=undefined)——办公模式等待行链接转录页 */
  taskAgentOf?: (id: string) => { name: string; prompt?: string; kind?: 'exec' } | undefined;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  /** 办公模式(ui-mode.ts):行不可展开(read 行整行开文件=跳转保留);文件行去 +/- 统计;非跳转行只显
   *  类动词头(「执行了命令」),命令/目标原文不显 */
  const office = useUiMode() === 'office';
  /** 2026-10-26 三期 §4.5:快照分页剥 result.full——展开且缺 full 时按 seq 单条拉观测端点;
   *  ''=已拉且无 full(回落 text),undefined=未拉。live 帧自带 full 不触发 */
  const [fetchedFull, setFetchedFull] = useState<string | undefined>(undefined);
  /** G7 diff 拉取态:undefined=未拉/在途(null 前先示右列现内容);null=拉取失败(退单列现内容);
   *  对象=成功(diff2html 面板)。拉一次缓存——折叠再展开不重拉 */
  const [diff, setDiff] = useState<DiffResp | null | undefined>(undefined);
  /** 工具结果图片查看浮层(2026-10-26 插件体系图片通道;组件自持——ToolEntryView 主对话/agents
   *  页签两消费面无差别直用,不依赖页级回调接线)。undefined=关;关闭即清(浮层卸载) */
  const [lightbox, setLightbox] = useState<string | undefined>(undefined);
  // P11 T7 渲染中立:字段单源(entry.name/input/result/status 直映)——md 首行解析与旁路 info
  // 双通道全退役,渲染记号与截断全是本组件职责
  const toolName = entry.name ?? '';
  const input: Record<string, unknown> = entry.input ?? {};
  const entrySeq = entry.key.startsWith('k') ? Number(entry.key.slice(1)) : NaN;
  useEffect(() => {
    if (!expanded || fetchedFull !== undefined) return;
    if (entry.result?.full !== undefined || !Number.isInteger(entrySeq) || entrySeq <= 0) return;
    if (typeof conn.fetchObservation !== 'function') return; // 测试桩/旧 daemon:优雅回落 text
    let alive = true;
    void conn.fetchObservation(sessionId, entrySeq).then(
      (o) => {
        if (alive) setFetchedFull(o.full ?? '');
      },
      () => {
        if (alive) setFetchedFull('');
      },
    );
    return () => {
      alive = false;
    };
  }, [expanded, entrySeq, fetchedFull, entry.result?.full, conn, sessionId]);
  const resultText = entry.result?.full ?? (expanded ? fetchedFull : undefined) ?? entry.result?.text ?? '';
  const path = typeof input.path === 'string' && input.path !== '' ? input.path : undefined;
  const command = toolName === 'exec' && typeof input.command === 'string' && input.command !== '' ? input.command : undefined;
  const target = toolTargetOf(toolName, input);
  /** 文件写入/编辑分型(G14):折叠=文件名+相对路径+diff stat,展开=diff 面板;read 分型:整行=打开文件标签 */
  const isWrite = (toolName === 'write' || toolName === 'edit') && path !== undefined;
  const isRead = toolName === 'read' && path !== undefined && onOpenFile !== undefined;
  /** read 图片分型(2026-10-27):结果只是 [image] 说明——行=可折叠展开(展开体重读图片显),
   *  普通 read 文件行维持「整行=打开文件标签」既有面 */
  const isReadImage = toolName === 'read' && path !== undefined && resultText.trim().startsWith('[image]');
  const fileLabel = path !== undefined ? fileLabelOf(path) : undefined;
  const stat = isWrite ? writeStatOf(resultText) : {};
  /** G14.171 spawn 子智能体名(label ?? agent_id)——运行态文案与折叠行链接共用 */
  const spawnAgentName =
    toolName === 'spawn'
      ? typeof input.label === 'string' && input.label !== ''
        ? input.label
        : typeof input.agent_id === 'string'
          ? input.agent_id
          : ''
      : '';
  /** create_agent_teammate 成员名(name 必填)——与 spawn 同款:运行态文案+折叠行蓝色链接 */
  const teammateName =
    toolName === 'create_agent_teammate' && typeof input.name === 'string' && input.name !== '' ? input.name : '';
  /** create_agent_team 队名——折叠行「创建智能体团队 {name}」;运行态同构 */
  const teamName =
    toolName === 'create_agent_team' && typeof input.name === 'string' && input.name !== '' ? input.name : '';
  /** exit_plan 交稿行（2026-11-03 交稿协议）：计划名+计划文件链接。path 只在回放合成链行（宿主 appendChain
   *  时入参 {name,path}）;live fork 帧入参是模型出牌原文 {name,doc} 无 path——链接降级纯文本,
   *  live 期点击入口归确认卡头链接（PlanCard） */
  const planName = toolName === 'exit_plan' && typeof input.name === 'string' && input.name !== '' ? input.name : '';
  const planFilePath = toolName === 'exit_plan' && path !== undefined && onOpenFile !== undefined ? path : undefined;
  /** send_agent_team_message 收件人与正文(展开体显示正文;折叠行只跟收件人名) */
  const messageTo =
    toolName === 'send_agent_team_message' && typeof input.to === 'string' && input.to !== '' ? input.to : '';
  const messageText =
    toolName === 'send_agent_team_message' && typeof input.text === 'string' ? input.text : '';
  /** 收件人=主会话 leader:点击开智能体团队定位该队(2026-11-07 用户裁定「发送团队消息两模式都可点」——
   *  成员收件人开其转录页) */
  const messageToLeader = messageTo === 'leader' || messageTo === 'lead'; // 旧档 to='lead' 显示归一 leader(2026-11-08 清残留)
  const messageToLabel = messageToLeader ? 'leader' : messageTo;
  /** G14.172 等待行任务名(taskNameOf 单点解析)——用户裁决「等待任务显示任务名称,不要用 id」;保留 id 供链接定位。
   *  task_wait=后台账本;agent_team_task_wait=板任务——点击路由前缀分立 */
  const waitTasks = toolName === 'task_wait' || toolName === 'agent_team_task_wait'
    ? (Array.isArray(input.taskIds) ? (input.taskIds as unknown[]) : [])
        .filter((x): x is string => typeof x === 'string' && x !== '')
        .map((id) => ({ id, name: taskNameOf !== undefined ? taskNameOf(id) : id }))
    : [];
  /** 办公模式 task_wait(2026-11-07 用户裁定):只显具名后台命令(exec purpose,链接开后台任务页签)与子智能体
   *  (链接开转录页),均在「等待任务」后列出;命令原文任务不显——全为无名时只显「等待了任务」 */
  const officeAgentWaits = office && toolName === 'task_wait' && taskAgentOf !== undefined
    ? waitTasks.flatMap((w) => {
        const a = taskAgentOf(w.id);
        return a !== undefined ? [{ ...a, id: w.id }] : [];
      })
    : [];
  /** get_agent_team_board 折叠行队名:回执 team=… 去重 → 队名解析;无 team 行且会话仅一队时回落该队 */
  const boardTeamRefs = (() => {
    if (toolName !== 'get_agent_team_board') return [] as Array<{ ref: string; name: string }>;
    const ids = [...new Set([...resultText.matchAll(/\bteam=([^\s\]]+)/g)].map((m) => m[1]!))];
    if (ids.length > 0) {
      return ids.map((id) => ({ ref: id, name: teamNameOf !== undefined ? teamNameOf(id) : id }));
    }
    if (teams !== undefined && teams.length === 1) {
      const only = teams[0]!;
      return [{ ref: only.teamId, name: only.name !== '' ? only.name : only.teamId }];
    }
    return [] as Array<{ ref: string; name: string }>;
  })();
  /** G14.214 task_* 折叠行/运行态任务名：input.taskId 经 taskNameOf 单点解析（board 直查→转录映射→短 id 兜底，
   *  与 task_wait G14.172 同口径）；set_dependency 额外解析 dependsOn（「任务 ← 依赖目标」双名）。
   *  缺 taskId/解析器（测试桩、种子条旧格式）不进该分型，回落默认动词行 */
  const taskOpName = (() => {
    if (!TASK_OP_TOOLS.has(toolName)) return undefined;
    const id = typeof input.taskId === 'string' && input.taskId !== '' ? input.taskId : undefined;
    if (id === undefined) return undefined;
    // task_stop 完成态优先取回执 label（后台任务 id 不在 board/转录面，taskNameOf 只剩短 id 兜底——
    // 回执行 `task <id> stopped (<label>)` 携带真实名）；未完成/无 label 落 taskNameOf 链
    if (toolName === 'task_stop') {
      const m = new RegExp(`task ${id} stopped \\((.*)\\)`).exec(resultText);
      if (m !== null && m[1] !== '') return m[1]!;
    }
    return taskNameOf !== undefined ? taskNameOf(id) : id;
  })();
  const taskOpDepName = (() => {
    if (toolName !== 'set_dependency') return undefined;
    const id = typeof input.dependsOn === 'string' && input.dependsOn !== '' ? input.dependsOn : undefined;
    if (id === undefined) return undefined;
    return taskNameOf !== undefined ? taskNameOf(id) : id;
  })();
  /** P11 全工具双态:executing 读三态 status(md 占位 `…` 判定退役)——pending/running=执行中
   *  (流光+「正在…」),done(缺省终态)=各型折叠行 */
  const executing = entry.status === 'pending' || entry.status === 'running';
  const runningLabel = (() => {
    // G14.166 spawn 运行态带子智能体名(label ?? agent_id)——「正在分派 架构分析」替代泛文案
    if (toolName === 'spawn' && spawnAgentName !== '') return t(`Dispatching ${spawnAgentName}`, `正在分派 ${spawnAgentName}`);
    if (toolName === 'create_agent_teammate' && teammateName !== '') return t(`Creating member ${teammateName}`, `正在创建团队成员 ${teammateName}`);
    if (toolName === 'create_agent_team' && teamName !== '') return t(`Creating team ${teamName}`, `正在创建智能体团队 ${teamName}`);
    if (toolName === 'send_agent_team_message' && messageTo !== '') return t(`Sending team message to ${messageToLabel}`, `正在发送团队消息给 ${messageToLabel}`);
    // create_agent_team_task 运行态带任务标题——「正在创建团队任务 …」,id 不进折叠行
    if (toolName === 'create_agent_team_task' && typeof input.title === 'string' && input.title !== '') {
      return t(`Creating team task ${input.title}`, `正在创建团队任务 ${input.title}`);
    }
    // G14.2xx skill 运行态带技能名(与完成态「加载技能 xxx」同构,回溯前后显示一致)
    if (toolName === 'skill' && target !== undefined) return t(`Loading skill ${target}`, `正在加载技能 ${target}`);
    // task_* 运行态带任务名——「正在更新 架构评审」替代泛文案（taskOpName 已在场即有值）
    const opPair = taskOpName !== undefined ? TASK_OP_RUNNING[toolName] : undefined;
    if (opPair !== undefined) return t(`${opPair[0]} ${taskOpName}`, `${opPair[1]} ${taskOpName}`);
    // exit_plan 运行态带计划名——「正在提交计划 重构认证模块」
    if (toolName === 'exit_plan' && planName !== '') return t('Presenting plan', '正在提交计划'); // 计划名归蓝链(2026-11-04 用户裁定「只显示蓝色」——折叠行名+链双显退役)
    // 2026-10-26 MCP 工具运行态带本地化工具名——「正在调用 截屏」(双语对随语言切换,与完成态同口径)
    const mcp = mcpToolParts(toolName);
    // 运行态带本地化工具名(2026-10-30 用户裁定;双语对渲染期求值)
    if (mcp !== null) {
      const pair = MCP_TOOL_LABELS[mcp.tool];
      return pair !== undefined
        ? t(`Calling ${pair.en}`, `正在调用 ${pair.zh}`)
        : t(`Calling ${mcp.tool}`, `正在调用 ${mcp.tool}`);
    }
    const pair = RUNNING_LABELS[toolName] ?? ['Running', '正在执行'];
    return t(pair[0], pair[1]);
  })();


  /** 展开且可寻址(callId 在场——无 callId 面不拉)即异步拉 diff;折叠即弃在途应答
   *  (面板已不在场),重展开重拉;已缓存(diff≠undefined)不重拉 */
  useEffect(() => {
    if (!expanded || isWrite !== true || diff !== undefined) return;
    if (callId === undefined && path === undefined) return; // 两无:无从寻快照(理论不可达)
    // G14.4:种子回放行无 callId——占位 id + path 随参,daemon 按 journal snapshots 行回退真 pre-image
    const cid = callId ?? 'replay';
    let alive = true;
    conn.fetchDiff(sessionId, cid, path).then(
      (d) => {
        if (alive) setDiff(d);
      },
      () => {
        if (alive) setDiff(null); // 404 无快照/会话已回收等——退单列现内容
      },
    );
    return () => {
      alive = false;
    };
  }, [expanded, isWrite, callId, diff, conn, sessionId]);

  /** 折叠行主体(G14 分型;2026-10-22 用户裁定:运行态=流光动词标签+目标内容同行——spawn/skill/
 *  taskOp 的流光标签已含目标名故不重示):文件工具=文件名+相对路径(+stat);exec=完整命令;其余=动词+目标 */
  const createTaskTitle = toolName === 'create_agent_team_task' && typeof input.title === 'string' ? input.title : '';
  const hideTargetWhileRunning = executing && (
    toolName === 'spawn' || toolName === 'create_agent_teammate' || toolName === 'create_agent_team'
    || toolName === 'send_agent_team_message'
    || (toolName === 'create_agent_team_task' && createTaskTitle !== '')
    || toolName === 'skill' || taskOpName !== undefined
  );
  /** 操作说明(模型自拟,对话语言):插件工具=整行标题替换工具名+参数;exec=描述头(编程模式附命令,
   *  办公模式只显描述);无说明回落既有分型 */
  const purpose = toolPurposeOf(toolName, input);
  const purposeHead = purpose !== undefined ? (
    executing ? (
      <span className="tool-verb exec-running">
        <span className="exec-running-text">{purpose}</span>
      </span>
    ) : (
      <span className="tool-verb tool-purpose">{purpose}</span>
    )
  ) : null;
  const verbSpan = purposeHead !== null ? purposeHead : executing ? (
    // G14.88 纯流光文字(去工具图标+波纹框——双图标视感,用户裁定)
    <span className="tool-verb exec-running">
      <span className="exec-running-text">{runningLabel}</span>
    </span>
  ) : toolName === 'ask_question' ? (
    <span className="tool-verb">{zhToolName(toolName)}</span>
  ) : toolName === 'todo_write' ? (
    <span
      className="tool-verb"
      role={onOpenTodos !== undefined ? 'button' : undefined}
      tabIndex={onOpenTodos !== undefined ? -1 : undefined}
      style={onOpenTodos !== undefined ? { cursor: 'pointer' } : undefined}
      data-tip={onOpenTodos !== undefined ? t('Locate in todos tab', '定位到待办页签') : undefined}
      onClick={(e) => {
        if (onOpenTodos === undefined) return;
        e.stopPropagation();
        const arr = Array.isArray(input.todos) ? (input.todos as Array<Record<string, unknown>>) : [];
        onOpenTodos(arr.map((o) => ({ text: String((o ?? {}).text ?? ''), status: String((o ?? {}).status ?? 'pending') })));
      }}
    >
      {zhToolName(toolName)}
    </span>
  ) : toolName === 'spawn' || (toolName === 'task_wait' && !office) ? (
    // 2026-11-05 用户裁定「动词在前,命名准确」:专用动词分支收敛 zhToolName 单点(EN 规范化标签,
    // 不再露原始名——ask/todo 两支保留自定义交互面,文字同源 zhToolName)
    <span className="tool-verb">{zhToolName(toolName)}</span>
  ) : office && !isOfficeStandaloneTool(toolName) && !(toolName === 'read' && path !== undefined) && officeAgentWaits.length === 0 ? (
    <span className="tool-verb">{officeSingleLabel(toolName)}</span>
  ) : (
    <span className="tool-verb">{zhToolName(toolName)}</span>
  );
  /** 办公模式非跳转行:动词头即全部(命令/目标原文不进折叠行) */
  const officeBare = office && !isOfficeStandaloneTool(toolName) && !(toolName === 'read' && path !== undefined) && officeAgentWaits.length === 0
    && toolName !== 'load_agent_teams' && toolName !== 'load_subagent' && toolName !== 'skill'; // 加载团队/子智能体/技能:保留名称(2026-11-07 用户裁定)
  // 只显说明:插件工具恒是;exec 仅办公模式(编程模式=说明头+命令明细,沿用下方命令分支)
  // 只显说明:插件/MCP 类恒是;exec 仅办公模式(编程=说明头+命令明细)。跳转保留集(spawn/团队/文件/
  // 计划/待办/问询/等待团队任务)不吞——行内链接是入口(2026-11-07 用户裁定「发送团队消息两模式都可点」)
  const purposeOnly = purpose !== undefined && !isOfficeStandaloneTool(toolName) && (toolName !== 'exec' || office);
  const collapsed = purposeOnly ? purposeHead : officeBare ? verbSpan : (
    <>
      {verbSpan}
      {path !== undefined && (isWrite || toolName === 'read') ? (
        <>
          {/* G14.4 行序:动词+文件图标+文件名+相对路径(+stat);结果不进折叠行 */}
          {' '}
          <FileIcon path={path} />
          {' '}
          {(isWrite || toolName === 'read') && onOpenFile !== undefined ? (
            <span
              role="button"
              tabIndex={-1}
              className="tool-file-base tool-file-link"
              data-tip={t('Open in file tab', '在文件标签预览')}
              onClick={(e) => {
                e.stopPropagation();
                onOpenFile(path);
              }}
            >
              {fileLabel!.base}
              {fileLabel!.dir !== '' && <span className="tool-file-rel">{' '}{fileLabel!.dir}</span>}
            </span>
          ) : (
            <>
              <span className="tool-file-base">{fileLabel!.base}</span>
              {fileLabel!.dir !== '' && <span className="tool-file-rel">{' '}{fileLabel!.dir}</span>}
            </>
          )}
          {isWrite && !office && stat.added !== undefined && <span className="tool-stat tool-stat-add">{' '}{stat.added}</span>}
          {isWrite && !office && stat.removed !== undefined && <span className="tool-stat tool-stat-del">{' '}{stat.removed}</span>}
        </>
      ) : !hideTargetWhileRunning && toolName === 'ask_question' ? (
        /* G14.82:折叠行直接示问题文本(问询即内容,非动词+目标) */
        <span className="tool-file-base tool-cmd">{' '}{typeof input.question === 'string' ? input.question : ''}</span>
      ) : !hideTargetWhileRunning && toolName === 'todo_write' ? (
        /* G14.138 折叠行本地化;G14.199 格式「待办 {完成}/{总数}」(对号去除,用户裁定) */
        (() => {
          const arr = Array.isArray(input.todos) ? (input.todos as Array<Record<string, unknown>>) : [];
          const done = arr.filter((o) => (o ?? {}).status === 'completed').length;
          return <span className="tool-file-base tool-cmd">{' '}{done}/{arr.length}</span>;
        })()
      ) : !hideTargetWhileRunning && toolName === 'exit_plan' ? (
        /* 交稿行（2026-11-03）：计划名蓝色链接开侧栏计划文件（planFilePath 在场=回放合成行;live fork 帧无
           path 降级纯文本,点击入口归确认卡头链接） */
        planName !== '' && planFilePath !== undefined && onOpenFile !== undefined ? (
          <span
            role="button"
            tabIndex={-1}
            className="tool-file-base tool-agent-link"
            data-tip={t('Open plan file', '打开计划文件')}
            onClick={(e) => {
              e.stopPropagation();
              onOpenFile(planFilePath);
            }}
          >
            {' '}{planName}
          </span>
        ) : planName !== '' ? (
          /* live 帧无 path(模型出牌原文 {name,doc};path 只在回放合成行)——点击经计划清单按名寻路
             (conn.sessionPlans,修订覆盖写=同会话单份,名命中即最新计划);测试桩无此法静默零操作 */
          <span
            role="button"
            tabIndex={-1}
            className="tool-file-base tool-agent-link"
            data-tip={t('Open plan file', '打开计划文件')}
            onClick={(e) => {
              e.stopPropagation();
              if (typeof conn.sessionPlans !== 'function') return;
              // 拉取失败（会话已回收/档读失）降级无操作——本组件无 op-error 通道（fetchDiff 404 退单列同款口径）；
              // 名未命中退开最新一份兜底（修订覆盖写=同会话单份）
              void conn.sessionPlans(sessionId).then((r) => {
                const hit = r.plans.find((pl) => pl.name === planName) ?? r.plans[0];
                if (hit !== undefined && onOpenFile !== undefined) onOpenFile(hit.path);
              }).catch(() => {});
            }}
          >
            {' '}{planName}
          </span>
        ) : null
      ) : !hideTargetWhileRunning && toolName === 'create_agent_team' ? (
        /* 折叠行「创建智能体团队 {name}」——队名蓝色链接开指定队卡 */
        teamName !== '' && onOpenTask !== undefined ? (
          <span
            role="button"
            tabIndex={-1}
            className="tool-file-base tool-agent-link"
            data-tip={t('Open this team', '打开该团队')}
            onClick={(e) => {
              e.stopPropagation();
              const idHit = /teamId=([^\s);,]+)/.exec(resultText);
              onOpenTask(`team:${idHit !== null ? idHit[1]! : teamName}`);
            }}
          >
            {' '}{teamName}
          </span>
        ) : (
          <span className="tool-file-base tool-cmd">{teamName !== '' ? ` ${teamName}` : ''}</span>
        )
      ) : !hideTargetWhileRunning && toolName === 'get_agent_team_board' ? (
        /* 看板后跟队名链接(回执 team= 解析);点开指定队卡;多链接均分省略 */
        boardTeamRefs.length > 0 && onOpenTask !== undefined ? (
          <span className="tool-link-list">
            {boardTeamRefs.map((team, i) => (
              <Fragment key={`${team.ref}:${i}`}>
                {i > 0 ? <span className="tool-link-sep" aria-hidden="true">, </span> : null}
                <span
                  role="button"
                  tabIndex={-1}
                  className="tool-file-base tool-agent-link tool-link-chip"
                  data-tip={t('Open this team', '打开该团队')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenTask(`team:${team.ref}`);
                  }}
                >
                  {team.name}
                </span>
              </Fragment>
            ))}
          </span>
        ) : boardTeamRefs.length > 0 ? (
          <span className="tool-file-base tool-cmd">{' '}{boardTeamRefs.map((x) => x.name).join(', ')}</span>
        ) : null
      ) : !hideTargetWhileRunning && toolName === 'create_agent_team_task' ? (
        /* 折叠行带任务名;任务名=蓝色链接,点开智能体团队定位高亮对应卡 */
        onOpenTask !== undefined && typeof input.title === 'string' && input.title !== '' ? (
          <span
            role="button"
            tabIndex={-1}
            className="tool-file-base tool-agent-link"
            data-tip={t('Locate in agent teams', '在智能体团队中定位')}
            onClick={(e) => {
              e.stopPropagation();
              // 回执名优先形态 `task "…" created (id=task-xxx)`——按 id= 取真 id,旧形态兜底
              const created = /id=(\S+)/.exec(resultText) ?? /task (\S+) created/.exec(resultText);
              const id = created !== null ? created[1]!.replace(/[);,].*$/, '') : (input.title as string);
              onOpenTask(id);
            }}
          >
            {' '}{input.title}
          </span>
        ) : (
          <span className="tool-file-base tool-cmd">
            {typeof input.title === 'string' ? ` ${input.title}` : ''}
          </span>
        )
      ) : !hideTargetWhileRunning && toolName === 'spawn' ? (
        /* G14.166 折叠行带子智能体名(G14.171:蓝色链接,点开对应 agent 只读标签页) */
        spawnAgentName !== '' && onOpenAgent !== undefined ? (
          <span
            role="button"
            tabIndex={-1}
            className="tool-file-base tool-agent-link"
            data-tip={t('View subagent', '查看子智能体')}
            onClick={(e) => {
              e.stopPropagation(); // 不触发行展开
              // 2026-10-25 用户裁定:任务说明禁止截断——开签 task 兜底仍传全量 prompt(与 harness
              // 现发的 taskBand 双通道;截断即「任务说明被拦腰砍」)
              onOpenAgent(spawnAgentName, spawnAgentName, typeof input.prompt === 'string' ? input.prompt : undefined);
            }}
          >
            {' '}{spawnAgentName}
          </span>
        ) : (
          <span className="tool-file-base tool-cmd">{spawnAgentName !== '' ? ` ${spawnAgentName}` : ''}</span>
        )
      ) : !hideTargetWhileRunning && toolName === 'create_agent_teammate' ? (
        /* 折叠行带成员名(蓝色链接同 spawn,点开对应 agent 只读标签页) */
        teammateName !== '' && onOpenAgent !== undefined ? (
          <span
            role="button"
            tabIndex={-1}
            className="tool-file-base tool-agent-link"
            data-tip={t('View member', '查看成员')}
            onClick={(e) => {
              e.stopPropagation(); // 不触发行展开
              onOpenAgent(teammateName, teammateName, typeof input.prompt === 'string' ? input.prompt : undefined); // 任务说明不截断(同 spawn,2026-10-25 裁定)
            }}
          >
            {' '}{teammateName}
          </span>
        ) : (
          <span className="tool-file-base tool-cmd">{teammateName !== '' ? ` ${teammateName}` : ''}</span>
        )
      ) : !hideTargetWhileRunning && toolName === 'send_agent_team_message' ? (
        /* 折叠行带收件人名:成员名点开其转录页;leader 点开智能体团队定位该队(单队会话直达队卡);正文进展开体 */
        messageToLeader && (onOpenLeader !== undefined || onOpenTask !== undefined) ? (
          <span
            role="button"
            tabIndex={-1}
            className="tool-file-base tool-agent-link"
            data-tip={onOpenLeader !== undefined ? t('Locate in main conversation', '在主对话中定位') : t('Open agent team', '在智能体团队中查看')}
            onClick={(e) => {
              e.stopPropagation();
              if (onOpenLeader !== undefined) onOpenLeader({ text: messageText });
              else onOpenTask?.(`team:${teams !== undefined && teams.length === 1 ? teams[0]!.teamId : ''}`);
            }}
          >
            {' '}{messageToLabel}
          </span>
        ) : messageTo !== '' && !messageToLeader && onOpenAgent !== undefined ? (
          <span
            role="button"
            tabIndex={-1}
            className="tool-file-base tool-agent-link"
            data-tip={t('View member', '查看成员')}
            onClick={(e) => {
              e.stopPropagation();
              onOpenAgent(messageTo, messageTo);
            }}
          >
            {' '}{messageTo}
          </span>
        ) : (
          <span className="tool-file-base tool-cmd">{messageTo !== '' ? ` ${messageToLabel}` : ''}</span>
        )
      ) : !hideTargetWhileRunning && officeAgentWaits.length > 0 ? (
        <span className="tool-link-list">
          {officeAgentWaits.map((a, i) => (
            <Fragment key={`${a.name}:${i}`}>
              {i > 0 ? <span className="tool-link-sep" aria-hidden="true">, </span> : null}
              {/* 具名后台命令(exec purpose)=链接开后台任务页签定位(编程模式同款);子智能体=链接开转录页 */}
              {a.kind === 'exec' && onOpenTask !== undefined ? (
                <span
                  role="button"
                  tabIndex={-1}
                  className="tool-file-base tool-agent-link tool-link-chip"
                  data-tip={t('Locate in background tasks', '在后台任务中定位')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenTask(`bg:${a.id}`);
                  }}
                >
                  {a.name}
                </span>
              ) : a.kind === 'exec' || onOpenAgent === undefined ? (
                <span className="tool-file-base tool-cmd">{a.name}</span>
              ) : (
              <span
                role="button"
                tabIndex={-1}
                className="tool-file-base tool-agent-link tool-link-chip"
                data-tip={t('View subagent', '查看子智能体')}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenAgent(a.name, a.name, a.prompt);
                }}
              >
                {a.name}
              </span>
              )}
            </Fragment>
          ))}
        </span>
      ) : !hideTargetWhileRunning && toolName === 'task_wait' ? (
        /* G14.167 折叠行带等待任务名(链接开后台任务页签定位行;null=等全部在跑);多链接均分省略 */
        waitTasks.length > 0 && onOpenTask !== undefined ? (
          <span className="tool-link-list">
            {waitTasks.map((task, i) => (
              <Fragment key={`${task.id}:${i}`}>
                {i > 0 ? <span className="tool-link-sep" aria-hidden="true">, </span> : null}
                <span
                  role="button"
                  tabIndex={-1}
                  className="tool-file-base tool-agent-link tool-link-chip"
                  data-tip={t('Locate in background tasks', '在后台任务中定位')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenTask(`bg:${task.id}`);
                  }}
                >
                  {task.name}
                </span>
              </Fragment>
            ))}
          </span>
        ) : (
          <span className="tool-file-base tool-cmd">
            {' '}
            {waitTasks.length > 0
              ? waitTasks.map((x) => x.name).join(', ')
              : Array.isArray(input.taskIds)
                ? ''
                : t('all background tasks', '全部后台任务')}
          </span>
        )
      ) : !hideTargetWhileRunning && toolName === 'agent_team_task_wait' ? (
        /* 板等待:链接开智能体团队定位对应任务卡(与 task_wait 后台账本分立) */
        waitTasks.length > 0 && onOpenTask !== undefined ? (
          <span className="tool-link-list">
            {waitTasks.map((task, i) => (
              <Fragment key={`${task.id}:${i}`}>
                {i > 0 ? <span className="tool-link-sep" aria-hidden="true">, </span> : null}
                <span
                  role="button"
                  tabIndex={-1}
                  className="tool-file-base tool-agent-link tool-link-chip"
                  data-tip={t('Locate in agent teams', '在智能体团队中定位')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenTask(task.id);
                  }}
                >
                  {task.name}
                </span>
              </Fragment>
            ))}
          </span>
        ) : (
          <span className="tool-file-base tool-cmd">
            {' '}
            {waitTasks.length > 0
              ? waitTasks.map((x) => x.name).join(', ')
              : Array.isArray(input.taskIds)
                ? ''
                : t('all board tasks', '全部团队任务')}
          </span>
        )
      ) : !hideTargetWhileRunning && taskOpName !== undefined ? (
        /* G14.214 task_* 折叠行带任务名(链接开板高亮;set_dependency 双名「任务 ← 依赖目标」);多链接均分省略。
         *  task_stop=后台账本(与 task_wait 同 bg: 前缀),其余板面工具开智能体团队 */
        onOpenTask !== undefined ? (
          <span className="tool-link-list">
            <span
              role="button"
              tabIndex={-1}
              className="tool-file-base tool-agent-link tool-link-chip"
              data-tip={toolName === 'task_stop'
                ? t('Locate in background tasks', '在后台任务中定位')
                : t('Locate in agent teams', '在智能体团队中定位')}
              onClick={(e) => {
                e.stopPropagation();
                const id = typeof input.taskId === 'string' ? input.taskId : taskOpName;
                onOpenTask(toolName === 'task_stop' ? `bg:${id}` : id);
              }}
            >
              {taskOpName}
            </span>
            {taskOpDepName !== undefined && (
              <>
                <span className="tool-link-sep" aria-hidden="true"> ← </span>
                <span
                  role="button"
                  tabIndex={-1}
                  className="tool-file-base tool-agent-link tool-link-chip"
                  data-tip={t('Locate in agent teams', '在智能体团队中定位')}
                  onClick={(e) => {
                    e.stopPropagation();
                    const id = typeof input.dependsOn === 'string' ? input.dependsOn : taskOpDepName;
                    onOpenTask(id);
                  }}
                >
                  {taskOpDepName}
                </span>
              </>
            )}
            {toolName === 'assign' && typeof input.assignee === 'string' && input.assignee !== '' && onOpenAgent !== undefined && (
              <>
                <span className="tool-link-sep" aria-hidden="true"> · </span>
                <span
                  role="button"
                  tabIndex={-1}
                  className="tool-file-base tool-agent-link tool-link-chip"
                  data-tip={t('View member', '查看成员')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenAgent(input.assignee as string, input.assignee as string);
                  }}
                >
                  {input.assignee as string}
                </span>
              </>
            )}
          </span>
        ) : (
          <span className="tool-file-base tool-cmd">
            {' '}{taskOpName}
            {taskOpDepName !== undefined && ` ← ${taskOpDepName}`}
          </span>
        )
      ) : command !== undefined ? (
        /* G14.50:展开态不重复命令文本(下方 $ 行已完整示出) */
        <span className="tool-file-base tool-cmd">{' '}{command}</span>
      ) : !hideTargetWhileRunning && target !== undefined ? (
        /* G14.168 目标字段(MCP 等未登记工具回退原名+目标) */
        <span className="tool-file-base tool-cmd">{' '}{target}</span>
      ) : null}
    </>
  );
  /** 办公模式不可展开:read 文件行整行跳转保留,其余点击无动作;ask_question 例外——展开体是
   *  问题/选项/回答(用户内容,无命令输出与 diff),办公模式同样需要回看(2026-11-09 用户裁定) */
  const officeExpandable = toolName === 'ask_question';
  const expandable = (!office || officeExpandable) && (!isRead || isReadImage);
  const bodyMounted = !office || officeExpandable;


  return (
    <div className={`entry entry-tool${expanded && bodyMounted ? ' open' : ''}`} data-tool={toolName || undefined} data-msg-to={messageToLeader ? 'leader' : messageTo !== '' ? messageTo : undefined} data-msg-text={messageText !== '' ? messageText : undefined}>
      <button
        type="button"
        className={`tool-summary${!expandable && !isRead ? ' tool-summary-static' : ''}`}
        aria-expanded={expandable ? expanded : undefined}
        onClick={() => {
          if (isRead && (!isReadImage || office)) onOpenFile?.(path!); // 办公模式读图行不可展开,整行开文件看图
          else if (!expandable) return;
          else {
            setExpanded((v) => !v);
            window.dispatchEvent(new Event('sx-row-toggle')); // 贴地时展开/收起→滚动跟随(use-chat-scroll)
          }
        }}
      >
        <ToolIcon verb={toolName} />
        {collapsed}
        {expandable && <ChevronRight className="tool-chev" size={12} strokeWidth={1.75} aria-hidden="true" />}
      </button>
      {/* 折叠壳外常驻图片缩略行退役(2026-10-31 用户裁定「去掉常驻显示的图片,保留内部的就可以」):
          截图只在展开体回显(ec9159c 面),折叠行不占版面;点击行展开即看 */}
      {/* 办公模式无展开体(命令/输出/diff 不入 DOM);ask 问答体例外 */}
      {bodyMounted && (
      <div className={`tool-body${expanded ? ' open' : ''}`} aria-hidden={!expanded}>
        <div className="tool-body-inner">
          {isReadImage && path !== undefined ? (
            <ReadImageBody path={path} />
          ) : (
            <ToolEntryBody
              entry={entry}
              toolName={toolName}
              input={input}
              executing={executing}
              resultText={resultText}
              isWrite={isWrite}
              diff={diff}
              path={path}
              callId={callId}
              onOpenDiff={onOpenDiff}
              onOpenFile={onOpenFile}
              planName={planName}
              planFilePath={planFilePath}
              command={command}
              messageText={messageText}
              onOpenImage={setLightbox}
            />
          )}
        </div>
      </div>
      )}
      {lightbox !== undefined && <ImageLightbox src={lightbox} onClose={() => setLightbox(undefined)} />}
    </div>
  );
});

/** websearch stdout → 结构化条目(2026-11-01 展开面链接化):格式=「N. 标题⏎ 空格+URL⏎ 摘要(可多行)」,
 *  记录界=下一行「N. 」;不匹配整段返回空数组(退回原文展示) */
export { mcpToolParts, type TodoBatch, zhToolName, toolTargetOf, commandRunningLabel, fileLabelOf, writeStatOf } from './tool-entry-data';
