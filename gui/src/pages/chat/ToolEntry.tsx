import { Fragment, memo, useEffect, useState } from 'react';
import { Check, ArrowRight, FileText, Wrench, PenLine, FilePenLine, SquareTerminal, Search, FolderSearch, ChevronRight, Sparkles, Globe, Telescope, Brain, ListTodo, ListChecks, Kanban, Radar, GitBranch, Bot, Square, Hourglass, BookOpen, MessageCircleQuestion, NotebookPen, ListPlus, GitMerge, UserPlus, UsersRound, Puzzle, AppWindow, MousePointerClick, Send, ClipboardList, type LucideIcon } from 'lucide-react';
import { t } from '../../i18n';
import { localizeNotice } from '../../i18n-notice';
import { highlightCommand, stripAnsi } from '../../highlight';
import { openExternalUrl } from '../../ui-util';
import type { ChatEntry } from '../../chat-reducer';
import type { Connection } from '../../connection';
import { DiffLines } from '../../diff-lines';
import { FileIcon } from '../../file-icon';
import { ImageLightbox } from '../../ImageLightbox';
import ReactMarkdown from 'react-markdown';
import { keepUrl, mdComponentsPlain, MD_REHYPE_PLUGINS, MD_REMARK_PLUGINS } from '../Chat';
import { COMPUTER_USE_PREFIX } from './computer-use-contract';
import type { DiffResp } from '../../connection';
import { mcpToolParts, MCP_TOOL_LABELS, zhToolName, toolTargetOf, RUNNING_LABELS, TASK_OP_TOOLS, TASK_OP_RUNNING, fileLabelOf, writeStatOf, parseWebSearchOutput } from './tool-entry-data';
import { ToolImageThumb, ReadImageBody } from './tool-entry-media';

/** 工具动词 → 图标(渲染面映射;md 形态不变,未知工具通用件);智能体团队工具专属图标(去扳手默认) */
const TOOL_ICONS: Record<string, LucideIcon> = {
  read: FileText, write: PenLine, edit: FilePenLine, exec: SquareTerminal, grep: Search, glob: FolderSearch,
  skill: Sparkles, webfetch: Globe, websearch: Telescope, memory: Brain, memory_write: Brain, todo_write: ListTodo,
  team: UsersRound, agent: Bot, // agents-teams P0 章程卡工具(team 与建队同件,agent 与分派子智能体同件)
  worktree: GitBranch, spawn: Bot, task_stop: Square, agent_team_task_stop: Square, task_wait: Hourglass, agent_team_task_wait: Hourglass, kb_search: BookOpen,
  ask_question: MessageCircleQuestion, // G14.82:问询专属图标(不用扳手)
  exit_plan: NotebookPen, // 交稿行(2026-11-03 交稿协议):计划图标同 plan pill(2026-11-03 换 NotebookPen,与待办 ListTodo 区分)
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
  taskNameOf,
  teamNameOf,
  teams,
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
  /** 2026-11-04 用户裁定:点「待办」字样打开侧栏待办页签并定位对应卡 */
  onOpenTodos?: (todos: Array<{ text: string; status: string }>) => void;
  /** G14.172 task_wait 行任务名解析(App 注入:board+转录映射单点;缺省显示原 id) */
  taskNameOf?: (id: string) => string;
  /** 队名解析(get_agent_team_board/create_agent_team;缺省显示原 ref) */
  teamNameOf?: (ref: string) => string;
  /** 会话团队清单(get_agent_team_board 单队回落队名) */
  teams?: readonly { teamId: string; name: string }[];
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
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
  /** G14.172 等待行任务名(taskNameOf 单点解析)——用户裁决「等待任务显示任务名称,不要用 id」;保留 id 供链接定位。
   *  task_wait=后台账本;agent_team_task_wait=板任务——点击路由前缀分立 */
  const waitTasks = toolName === 'task_wait' || toolName === 'agent_team_task_wait'
    ? (Array.isArray(input.taskIds) ? (input.taskIds as unknown[]) : [])
        .filter((x): x is string => typeof x === 'string' && x !== '')
        .map((id) => ({ id, name: taskNameOf !== undefined ? taskNameOf(id) : id }))
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
    if (toolName === 'send_agent_team_message' && messageTo !== '') return t(`Sending team message to ${messageTo}`, `正在发送团队消息给 ${messageTo}`);
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
  /** 展开面全文=resultText(entry.result full 全量观测优先,text 兜底——旁路 info 通道退役) */
  const fullResult = resultText;
  /** G14.82 ask_question 结构化问答体:问题+选项(✓ 选中)+用户回答(选/自定义/跳过),替代原始 I/O */
  const askInput: { question: string; options: Array<{ label: string; description?: string }> } | null =
    toolName === 'ask_question'
      ? (typeof input.question === 'string'
          ? {
              question: input.question,
              options: Array.isArray(input.options)
                ? input.options.map((o) => {
                    const ob = (o ?? {}) as { label?: unknown; description?: unknown };
                    const label = String(ob.label ?? '').trim();
                    const description = typeof ob.description === 'string' && ob.description.trim() !== '' ? ob.description.trim() : undefined;
                    return description !== undefined ? { label, description } : { label };
                  })
                : [],
            }
          : null)
      : null;
  const askAnswer = (() => {
    const r = fullResult.trim();
    if (r === '' || r === '…') return { kind: 'pending' as const };
    if (r.startsWith('answers: ')) return { kind: 'answers' as const, labels: r.slice(9).split('; ').map((x) => x.trim()) };
    if (r.startsWith('answer: ')) return { kind: 'answer' as const, labels: [r.slice(8).trim()] };
    if (r.startsWith('custom: ')) return { kind: 'custom' as const, text: r.slice(8).trim() };
    return { kind: 'dismissed' as const };
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
  const verbSpan = executing ? (
    // G14.88 纯流光文字(去工具图标+波纹框——双图标视感,用户裁定)
    <span className="tool-verb exec-running">
      <span className="exec-running-text">{runningLabel}</span>
    </span>
  ) : toolName === 'ask_question' ? (
    <span className="tool-verb">{t('ask', '提问')}</span>
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
      {t('todo', '待办')}
    </span>
  ) : toolName === 'spawn' ? (
    <span className="tool-verb">{t('spawn', '分派子智能体')}</span>
  ) : toolName === 'task_wait' ? (
    <span className="tool-verb">{t('task_wait', '等待任务')}</span>
  ) : (
    <span className="tool-verb">{zhToolName(toolName)}</span>
  );
  const collapsed = (
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
          {isWrite && stat.added !== undefined && <span className="tool-stat tool-stat-add">{' '}{stat.added}</span>}
          {isWrite && stat.removed !== undefined && <span className="tool-stat tool-stat-del">{' '}{stat.removed}</span>}
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
        /* 折叠行带收件人名(lead 纯文本;成员名可点开转录);正文进展开体 */
        messageTo !== '' && messageTo !== 'lead' && onOpenAgent !== undefined ? (
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
          <span className="tool-file-base tool-cmd">{messageTo !== '' ? ` ${messageTo}` : ''}</span>
        )
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

  /** 展开面主体(G14 分型):write/edit=行级 diff 面板;skill=md 正文;exec=$ 命令高亮+输出;
   *  todo_write=本地化清单(G14.138,daemon 英文结果不进展开面);其余=输出原文 */
  let body: JSX.Element;
  if (toolName === 'send_agent_team_message') {
    // 正文进工具井(.tool-md=surface-code 黑框,与 skill/ask 同面);回执次级灰跟在正文下
    body = (
      <div className="tool-md tool-msg">
        {messageText !== '' && <div className="tool-msg-body">{messageText}</div>}
        {resultText !== '' && <div className="tool-msg-receipt">{resultText}</div>}
        {messageText === '' && resultText === '' && <div className="tool-todo-empty">{t('(empty)', '（空）')}</div>}
      </div>
    );
  } else if (toolName === 'todo_write') {
    const arr = Array.isArray(input.todos) ? (input.todos as Array<Record<string, unknown>>) : [];
    body = (
      <div className="tool-todos" aria-label="todo list">
        {arr.length === 0 && <div className="tool-todo tool-todo-empty">{t('(empty list)', '（空清单）')}</div>}
        {arr.map((o, i) => {
          const st = (o ?? {}).status === 'completed' ? 'completed' : (o ?? {}).status === 'in_progress' ? 'in_progress' : 'pending';
          return (
            <div key={i} className={`tool-todo tool-todo-${st}`}>
              {/* G14.169 统一圆圈三态:完成=绿底√/进行=→/等待=虚线圈(用户裁决,替代 ☑◐☐ 字符) */}
              <span className={`todo-dot ${st}`} aria-hidden="true">
                {st === 'completed' && <Check size={9} strokeWidth={3} />}
                {st === 'in_progress' && <ArrowRight size={9} strokeWidth={3} />}
              </span>
              <span className="tool-todo-text">{typeof (o ?? {}).text === 'string' ? String((o ?? {}).text) : ''}</span>
            </div>
          );
        })}
      </div>
    );
  } else if (isWrite) {
    // 拦截态先行(2026-10-31 用户实测「守卫拦截了但没显示报错」):失败(write/edit 被拒/NOT_READ/
    // STALE_READ 等)渲染 err 色错误横幅替代 diff——尝试的替换对未落盘,当 diff 显是误导
    if (entry.result?.ok === false && !executing) {
      body = (
        <div className="tool-detail" role="alert">
          <div style={{ color: 'var(--err)', fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>✗ {resultText}</div>
        </div>
      );
    } else {
    // 快照兜底列(404/失败/加载期):write=整稿新内容(input.content);edit=本次替换对(oldString→newString)
    const fallbackOld = toolName === 'edit' && typeof input.oldString === 'string' ? input.oldString : undefined;
    const fallbackNew =
      toolName === 'edit'
        ? typeof input.newString === 'string'
          ? input.newString
          : ''
        : typeof input.content === 'string'
          ? input.content
          : '';
    const openDiff =
      onOpenDiff !== undefined && callId !== undefined && path !== undefined
        ? (): void => {
            onOpenDiff(callId, path);
          }
        : onOpenFile !== undefined && path !== undefined
          ? (): void => {
              onOpenFile(path);
            }
          : undefined;
    const openDiffTitle =
      onOpenDiff !== undefined && callId !== undefined ? t('Open diff tab', '打开 diff 标签') : t('Preview in file tab', '在文件标签预览');
    body = (
      <div className="tool-detail">
        {/* G14.51:自绘行级 diff;⇄ 开 diff 标签钮迁入(原 DiffPanel 角标钮,可及名=路径) */}
        <div className="tool-diffwrap">
          <DiffLines oldStr={diff?.oldContent ?? fallbackOld} newStr={diff !== null && diff !== undefined ? diff.newContent : fallbackNew} path={path} maxHeight={280} />
          {openDiff !== undefined && (
            <button
              type="button"
              className="tool-path"
              aria-label={path}
              data-tip={openDiffTitle}
              onClick={openDiff}
            >
              <span aria-hidden="true">⇄</span>
            </button>
          )}
        </div>
      </div>
    );
    }
  } else if (toolName === 'skill') {
    body = (
      <div className="tool-md">
        <ReactMarkdown remarkPlugins={MD_REMARK_PLUGINS} rehypePlugins={MD_REHYPE_PLUGINS} urlTransform={keepUrl} components={mdComponentsPlain}>{fullResult}</ReactMarkdown>
      </div>
    );
  } else if (toolName === 'ask_question' && askInput !== null) {
    const askQ = askInput;
    // G14.82:结构化问答体——问题+选项清单(✓ 用户所选/跳过态)+回答条,替代原始 I/O 文本块
    // G14.102 回答行去「✓ Answered」前缀:回答态只示回答内容(accent),skip 示「Skipped」(灰),
    // 自定义示输入内容;等待态保留 spinner+文案
    const answerRow =
      askAnswer.kind === 'answers' || askAnswer.kind === 'answer'
        ? { kind: 'answer' as const, text: askAnswer.labels.join('、') }
        : askAnswer.kind === 'custom'
          ? { kind: 'custom' as const, text: askAnswer.text }
          : askAnswer.kind === 'dismissed'
            ? { kind: 'dismissed' as const, text: t('Skipped', '已跳过') }
            : { kind: 'waiting' as const, text: t('Waiting for answer', '等待回答') };
    // G14.84/G14.102:展开体=问题(加重)+回答结果,普通展开区域包裹(选项清单挂起表单已示,不复读)
    body = (
      <div className="tool-md ask-record">
        <div className="ask-q">{askQ.question}</div>
        <div className={`ask-answer kind-${answerRow.kind}`}>
          {answerRow.kind === 'waiting' && <span className="run-spinner" aria-hidden="true" />}
          <span className="ask-answer-text">{answerRow.text}</span>
        </div>
      </div>
    );
  } else if (toolName === 'exit_plan') {
    // 交稿体（2026-11-03）：计划名(加重)+裁决状态行（ask-answer 同款三态面——等待态 spinner,
    // 终态显 decision 文本）;计划文件链接在场即附(点击开侧栏 file 页签)
    const planExecuting = entry.status === 'pending' || entry.status === 'running';
    body = (
      <div className="tool-md ask-record">
        {/* 2026-11-04 用户裁定:展开体计划名不可交互不蓝——plan-name-link 摘除 */}
        <div className="ask-q">{planName !== '' ? planName : t('Plan', '计划')}</div>
        <div className={`ask-answer ${planExecuting ? 'kind-waiting' : 'kind-answer'}`}>
          {planExecuting && <span className="run-spinner" aria-hidden="true" />}
          <span className="ask-answer-text">
            {planFilePath !== undefined && onOpenFile !== undefined ? (
              <span
                role="button"
                tabIndex={-1}
                className="tool-file-base tool-file-link"
                data-tip={t('Open plan file', '打开计划文件')}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenFile(planFilePath);
                }}
              >
                {t('Open plan file', '打开计划文件')}
              </span>
            ) : null}
            {planExecuting ? t('Awaiting user decision', '等待用户裁决') : fullResult !== '' ? localizeNotice(stripAnsi(fullResult)) : ''}
          </span>
        </div>
      </div>
    );
  } else if (command !== undefined) {
    body = (
      // G14.50:命令与输出合一区(终端形态:$ 行命令着色 + 输出同块次级灰——2026-10-25 用户裁定
      // 「结果再偏灰一点,方便区分命令行和结果」;输出剥 ANSI 转义(终端色码渲染即乱码))
      <div className="tool-exec">
        <pre className="tool-io-pre">
          <span className="exec-prompt" aria-hidden="true">$ </span>
          <code dangerouslySetInnerHTML={{ __html: highlightCommand(command) }} />
          {'\n'}
          <span className="exec-output">{fullResult !== '' ? stripAnsi(fullResult) : t('(no result)', '(无结果)')}</span>
        </pre>
      </div>
    );
  } else if (mcpToolParts(toolName) !== null) {
    // 2026-10-26 MCP 工具展开面(用户裁定「参数和返回值显示和其他工具一样」):server·tool 标识行 +
    // params JSON(入参全量,空参显 {})+ 返回值,终端块同形态($ 行/输出 的 MCP 对位)
    const mcp = mcpToolParts(toolName)!;
    const params = Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : '{}';
    body = (
      <div className="tool-exec">
        <pre className="tool-io-pre">
          <span className="exec-prompt" aria-hidden="true">mcp </span>
          <code>{mcp.server}</code>
          {' · '}
          <code>{mcp.tool}</code>
          {'\n'}
          <span className="exec-prompt" aria-hidden="true">params </span>
          <code>{params}</code>
          {'\n'}
          <span className="exec-output">{fullResult !== '' ? stripAnsi(fullResult) : t('(no result)', '(无结果)')}</span>
        </pre>
        {/* 回显带图(2026-10-30 用户裁定「回显也要显示截图的图片」):截屏类工具的截图在展开体
            结果后同样渲染——回显卡不只有参数/元数据,图片就近可看(缩略行同款,点击开灯箱) */}
        {entry.images !== undefined && entry.images.length > 0 && (
          <div className="tool-images">
            {entry.images.map((src, i) => (
              <ToolImageThumb key={`${i}:${src.slice(-24)}`} src={src} onOpen={setLightbox} />
            ))}
          </div>
        )}
      </div>
    );
  } else if (toolName === 'websearch') {
    // 2026-11-01 用户裁定「网址名做链接不显示 url,点击开系统默认浏览器」:websearch 输出结构化解析——
    // 标题=可点链接(preload 桥 shell.openExternal,OS 默认浏览器承接),URL 行不显示,摘要保留
    const hits = parseWebSearchOutput(fullResult);
    // 卡片四条(底色/圆角/内距/margin)走 tool-io-pre 类单点(tool-io.css,2026-11-02 技术债轮回归);
    // div 专属高度帽与字号行距内联保留
    body =
      hits.length > 0 ? (
        <div
          className="tool-io-pre"
          style={{ maxHeight: 280, overflow: 'auto', fontSize: 12.5, lineHeight: 1.6 }}
        >
            {hits.map((h) => (
              <div key={h.n} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 13 }}>
                  {h.n}.{' '}
                  <a
                    href={h.url}
                    style={{ color: 'var(--accent, #6ea8fe)' }}
                    onClick={(e) => {
                      e.preventDefault();
                      openExternalUrl(h.url);
                    }}
                  >
                    {h.title}
                  </a>
                </div>
                <div style={{ fontSize: 12, opacity: 0.75, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', paddingLeft: 14 }}>{h.snippet}</div>
              </div>
            ))}
        </div>
      ) : (
        <pre className="tool-io-pre">{fullResult !== '' ? stripAnsi(fullResult) : t('(no result)', '(无结果)')}</pre>
      );
  } else {
    body = <pre className="tool-io-pre">{fullResult !== '' ? stripAnsi(fullResult) : t('(no result)', '(无结果)')}</pre>;
  }

  return (
    <div className={`entry entry-tool${expanded ? ' open' : ''}`}>
      <button
        type="button"
        className="tool-summary"
        aria-expanded={isReadImage ? expanded : isRead ? undefined : expanded}
        onClick={() => {
          if (isRead && !isReadImage) onOpenFile?.(path!);
          else {
            setExpanded((v) => !v);
            window.dispatchEvent(new Event('sx-row-toggle')); // 贴地时展开/收起→滚动跟随(use-chat-scroll)
          }
        }}
      >
        <ToolIcon verb={toolName} />
        {collapsed}
        {(!isRead || isReadImage) && <ChevronRight className="tool-chev" size={12} strokeWidth={1.75} aria-hidden="true" />}
      </button>
      {/* 折叠壳外常驻图片缩略行退役(2026-10-31 用户裁定「去掉常驻显示的图片,保留内部的就可以」):
          截图只在展开体回显(ec9159c 面),折叠行不占版面;点击行展开即看 */}
      <div className={`tool-body${expanded ? ' open' : ''}`} aria-hidden={!expanded}>
        <div className="tool-body-inner">{isReadImage && path !== undefined ? <ReadImageBody path={path} /> : body}</div>
      </div>
      {lightbox !== undefined && <ImageLightbox src={lightbox} onClose={() => setLightbox(undefined)} />}
    </div>
  );
});

/** websearch stdout → 结构化条目(2026-11-01 展开面链接化):格式=「N. 标题⏎ 空格+URL⏎ 摘要(可多行)」,
 *  记录界=下一行「N. 」;不匹配整段返回空数组(退回原文展示) */
export { mcpToolParts, type TodoBatch, zhToolName, toolTargetOf, commandRunningLabel, fileLabelOf, writeStatOf, parseWebSearchOutput } from './tool-entry-data';
