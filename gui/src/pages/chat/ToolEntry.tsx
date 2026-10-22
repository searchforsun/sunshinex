import { useEffect, useState } from 'react';
import { Check, ArrowRight, FileText, Wrench, PenLine, FilePenLine, SquareTerminal, Search, FolderSearch, ChevronRight, Sparkles, Globe, Telescope, Brain, ListTodo, GitBranch, Bot, Square, Hourglass, BookOpen, MessageCircleQuestion, ListPlus, GitMerge, UserPlus, Eye, ShieldCheck, XCircle, type LucideIcon } from 'lucide-react';
import { t } from '../../i18n';
import { highlightCode } from '../../highlight';
import { pathBasename } from '../../ui-util';
import type { ChatEntry } from '../../chat-reducer';
import type { Connection } from '../../connection';
import { DiffLines } from '../../diff-lines';
import { FileIcon } from '../../file-icon';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { keepUrl, mdComponentsPlain } from '../Chat';
import type { DiffResp } from '../../connection';

/** 工具动词 → 图标(渲染面映射;md 形态不变,未知工具通用件);G14.168 taskboard 六工具专属图标(去扳手默认) */
const TOOL_ICONS: Record<string, LucideIcon> = {
  read: FileText, write: PenLine, edit: FilePenLine, exec: SquareTerminal, grep: Search, glob: FolderSearch,
  skill: Sparkles, webfetch: Globe, websearch: Telescope, memory: Brain, memory_write: Brain, todo_write: ListTodo,
  worktree: GitBranch, spawn: Bot, task_stop: Square, task_wait: Hourglass, kb_search: BookOpen,
  ask_question: MessageCircleQuestion, // G14.82:问询专属图标(不用扳手)
  create_task: ListPlus, set_dependency: GitMerge, assign: UserPlus, // G14.168 看板工具
  review_task: Eye, gate_task: ShieldCheck, cancel_task: XCircle,
};

function ToolIcon({ verb }: { verb: string }): JSX.Element {
  const Icon = TOOL_ICONS[verb] ?? Wrench;
  return <Icon size={12} strokeWidth={1.75} aria-hidden="true" />;
}

export interface TodoBatch {
  key: string;
  ts: number;
  goal: string;
  items: Array<{ text: string; status: 'completed' | 'in_progress' | 'pending' }>;
}

/** 工具折叠行动词中文展示单点(en=现有字面,zh=本地化;未登记工具(MCP 引入等)回退原名)。
 *  G14.216 命名口径(用户裁定,替代 G14.213「两字优先」):自然两字且项目既定的保留不动——
 *  读取/写入/执行/查阅/查找/搜索/抓取/停止/取消/分派/复审/门审/提问(工作树为项目自然词);
 *  凑两字而失读性的展开为目标域词,与运行态标签(RUNNING_LABELS)同口径——加载技能、保存记忆、
 *  更新待办、等待任务、检索知识库、创建任务、设置依赖、分派子智能体 */
const TOOL_VERB_ZH: Record<string, string> = {
  read: '读取', write: '写入', edit: '编辑', exec: '执行', grep: '查阅', glob: '查找',
  skill: '加载技能', webfetch: '抓取', websearch: '搜索', memory_write: '保存记忆',
  todo_write: '更新待办', worktree: '工作树', spawn: '分派子智能体', task_stop: '停止',
  task_wait: '等待任务', kb_search: '检索知识库', ask_question: '提问',
  create_task: '创建任务', set_dependency: '设置依赖', assign: '分派',
  review_task: '复审', gate_task: '门审', cancel_task: '取消',
};
export function zhToolName(name: string): string {
  const zh = TOOL_VERB_ZH[name];
  return zh === undefined ? name : t(name, zh);
}

/** 折叠行目标字段(工具展示元数据同口径):各内置工具取其主字段;换行拍平,超长中段省略 */
export function toolTargetOf(name: string, input: Record<string, unknown>): string | undefined {
  const key =
    name === 'exec'
      ? 'command'
      : name === 'grep' || name === 'glob'
        ? 'pattern'
        : name === 'websearch'
          ? 'query'
          : name === 'webfetch'
            ? 'url'
            : name === 'skill'
              ? 'id'
              : 'path';
  const v = input[key];
  if (typeof v !== 'string' || v === '') return undefined;
  const flat = (v.split('\n')[0] ?? v).trim();
  if (flat.length <= 72) return flat;
  return `${flat.slice(0, 48)}…${flat.slice(-20)}`;
}

/** 各工具执行中标签(G14.13):「正在…」双语;未知工具回落 正在执行 */
const RUNNING_LABELS: Record<string, [string, string]> = {
  read: ['Reading file', '正在读取文件'],
  write: ['Writing file', '正在写入'],
  edit: ['Editing file', '正在编辑'],
  exec: ['Running command', '正在执行'],
  glob: ['Searching files', '正在搜索文件'],
  grep: ['Searching', '正在搜索'],
  skill: ['Loading skill', '正在加载技能'],
  webfetch: ['Fetching page', '正在抓取网页'],
  websearch: ['Searching the web', '正在搜索网页'],
  memory_write: ['Saving memory', '正在保存记忆'],
  spawn: ['Dispatching subagent', '正在分派子智能体'],
  task_wait: ['Waiting for tasks', '正在等待任务'],
  task_stop: ['Stopping task', '正在停止任务'],
  todo_write: ['Updating todos', '正在更新待办'],
  worktree: ['Preparing worktree', '正在准备工作树'],
  kb_search: ['Searching knowledge base', '正在检索知识库'],
  ask_question: ['Waiting for answer', '正在等待回答'],
  create_task: ['Creating task', '正在创建任务'],
  set_dependency: ['Setting dependency', '正在设置依赖'],
  assign: ['Assigning task', '正在分派任务'],
  review_task: ['Reviewing task', '正在复审任务'],
  gate_task: ['Gating task', '正在门审任务'],
  cancel_task: ['Cancelling task', '正在取消任务'],
};

/** G14.214 单 taskId 工具集合（折叠行/运行态带任务名；task_wait 已单列）：入参均含 taskId 字符串，
 *  折叠行默认分型只出动词（复审/停止…五连发无从分辨）——任务名经 taskNameOf 单点解析后跟行 */
const TASK_OP_TOOLS = new Set(['task_stop', 'review_task', 'gate_task', 'cancel_task', 'assign', 'set_dependency']);

/** G14.214 运行态动词对（拼接任务名替代泛文案，仿 spawn G14.166 先例）；折叠行动词走 zhToolName 既有映射 */
const TASK_OP_RUNNING: Record<string, [string, string]> = {
  task_stop: ['Stopping', '正在停止'],
  review_task: ['Reviewing', '正在复审'],
  gate_task: ['Gating', '正在门审'],
  cancel_task: ['Cancelling', '正在取消'],
  assign: ['Assigning', '正在分派'],
  set_dependency: ['Setting dependency of', '正在设置依赖'],
};

/** 文件行拆分(G14.8):basename + 所在目录(恒显,根目录 = './')——文件名后永远看得到位置 */
export function fileLabelOf(path: string): { base: string; dir: string } {
  const norm = path.replace(/\\/g, '/');
  const base = pathBasename(norm);
  const dir = norm.slice(0, norm.length - base.length);
  return { base, dir }; // 根目录文件 dir = ''(名称即相对路径,不重复显示)
}

/** write/edit 结果首行 `written/edited +3 -1` → diff stat 拆分(G14 底层同源;前缀无关,认 +N -M 形);无 stat 回空 */
export function writeStatOf(result: string): { added?: string; removed?: string } {
  const m = /\+(\d+) -(\d+)/.exec(result);
  return m === null ? {} : { added: `+${m[1]}`, removed: `-${m[2]}` };
}

/** G6 工具条目(折叠态一行/点击展开):write/edit 两件(call 名判定——事件 text 即
 *  注册名)展开接 G7 fetchDiff(oldStr=oldContent/newStr=newContent 双列;加载期先示右列现内容
 *  +加载标,404/失败退 input 侧兜底——write=newContent/edit=oldString→newString 替换对;
 *  快照种子条/无 callId 面恒兜底列)+ path 文本按钮(G8d 起
 *  callId 在场优先 onOpenDiff 开 diff 标签,缺场回落 onOpenFile 文件标签预览);其他工具展开
 *  Input/Output 双段(G11 §2:input JSON + result 全文,各段 280px 内滚)。P11 T7 字段单源:
 *  name/input/result/status 直映 entry 字段(旁路 info prop 随工具 input 暂存退役——G6 双通道
 *  归一),md 解析全数退役。折叠壳 grid 化(0fr→1fr 生长):展开面常挂 DOM,折叠仅 CSS 收起。 */
export function ToolEntryView({
  entry,
  conn,
  sessionId,
  callId,
  onOpenFile,
  onOpenDiff,
  onOpenAgent,
  onOpenTask,
  taskNameOf,
}: {
  entry: ChatEntry;
  conn: Connection;
  sessionId: string;
  callId?: string;
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (callId: string, path: string) => void;
  /** G14.171 spawn 行子智能体名=蓝色链接,点开对应 agent 只读标签页(App 注入 openTabInSession) */
  onOpenAgent?: (label: string, agentTitle: string, task?: string) => void;
  /** G14.176 create_task 行任务名=蓝色链接,点开任务板定位高亮对应卡(App 注入) */
  onOpenTask?: (taskRef: string) => void;
  /** G14.172 task_wait 行任务名解析(App 注入:board+转录映射单点;缺省显示原 id) */
  taskNameOf?: (id: string) => string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  /** G7 diff 拉取态:undefined=未拉/在途(null 前先示右列现内容);null=拉取失败(退单列现内容);
   *  对象=成功(diff2html 面板)。拉一次缓存——折叠再展开不重拉 */
  const [diff, setDiff] = useState<DiffResp | null | undefined>(undefined);
  // P11 T7 渲染中立:字段单源(entry.name/input/result/status 直映)——md 首行解析与旁路 info
  // 双通道全退役,渲染记号与截断全是本组件职责
  const toolName = entry.name ?? '';
  const input: Record<string, unknown> = entry.input ?? {};
  const resultText = entry.result?.full ?? entry.result?.text ?? '';
  const path = typeof input.path === 'string' && input.path !== '' ? input.path : undefined;
  const command = toolName === 'exec' && typeof input.command === 'string' && input.command !== '' ? input.command : undefined;
  const target = toolTargetOf(toolName, input);
  /** 文件写入/编辑分型(G14):折叠=文件名+相对路径+diff stat,展开=diff 面板;read 分型:整行=打开文件标签 */
  const isWrite = (toolName === 'write' || toolName === 'edit') && path !== undefined;
  const isRead = toolName === 'read' && path !== undefined && onOpenFile !== undefined;
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
  /** G14.172 task_wait 折叠行任务名(taskNameOf 单点解析;同名去重)——用户裁决「等待任务显示任务名称,不要用 id」 */
  const waitTaskNames = toolName === 'task_wait'
    ? [
        ...new Set(
          (Array.isArray(input.taskIds) ? (input.taskIds as unknown[]) : [])
            .filter((x): x is string => typeof x === 'string')
            .map((id) => (taskNameOf !== undefined ? taskNameOf(id) : id)),
        ),
      ]
    : [];
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
    // G14.2xx skill 运行态带技能名(与完成态「加载技能 xxx」同构,回溯前后显示一致)
    if (toolName === 'skill' && target !== undefined) return t(`Loading skill ${target}`, `正在加载技能 ${target}`);
    // G14.214 task_* 运行态带任务名——「正在复审 架构评审」替代泛文案（taskOpName 已在场即有值）
    const opPair = taskOpName !== undefined ? TASK_OP_RUNNING[toolName] : undefined;
    if (opPair !== undefined) return t(`${opPair[0]} ${taskOpName}`, `${opPair[1]} ${taskOpName}`);
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
  const hideTargetWhileRunning = executing && (toolName === 'spawn' || toolName === 'skill' || taskOpName !== undefined);
  const verbSpan = executing ? (
    // G14.88 纯流光文字(去工具图标+波纹框——双图标视感,用户裁定)
    <span className="tool-verb exec-running">
      <span className="exec-running-text">{runningLabel}</span>
    </span>
  ) : toolName === 'ask_question' ? (
    <span className="tool-verb">{t('ask', '提问')}</span>
  ) : toolName === 'todo_write' ? (
    <span className="tool-verb">{t('todo', '待办')}</span>
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
          {isWrite && onOpenFile !== undefined ? (
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
      ) : !hideTargetWhileRunning && toolName === 'create_task' ? (
        /* G14.168 折叠行带任务名;G14.176 任务名=蓝色链接,点开任务板定位高亮对应卡 */
        onOpenTask !== undefined && typeof input.title === 'string' && input.title !== '' ? (
          <span
            role="button"
            tabIndex={-1}
            className="tool-file-base tool-agent-link"
            data-tip={t('Open task board card', '在任务板中定位')}
            onClick={(e) => {
              e.stopPropagation();
              const created = /task (\S+) created/.exec(resultText);
              onOpenTask(created !== null ? created[1]! : (input.title as string));
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
              onOpenAgent(spawnAgentName, spawnAgentName, typeof input.prompt === 'string' ? input.prompt.slice(0, 2000) : undefined);
            }}
          >
            {' '}{spawnAgentName}
          </span>
        ) : (
          <span className="tool-file-base tool-cmd">{spawnAgentName !== '' ? ` ${spawnAgentName}` : ''}</span>
        )
      ) : !hideTargetWhileRunning && toolName === 'task_wait' ? (
        /* G14.167 折叠行带等待任务名(G14.172:任务板解析为任务名,不用 id;null=等全部在跑) */
        <span className="tool-file-base tool-cmd">
          {' '}
          {waitTaskNames.length > 0
            ? waitTaskNames.join(', ')
            : Array.isArray(input.taskIds)
              ? ''
              : t('all background tasks', '全部后台任务')}
        </span>
      ) : !hideTargetWhileRunning && taskOpName !== undefined ? (
        /* G14.214 task_* 折叠行带任务名(复审/停止/门审/取消/分派;set_dependency 双名「任务 ← 依赖目标」) */
        <span className="tool-file-base tool-cmd">
          {' '}{taskOpName}
          {taskOpDepName !== undefined && ` ← ${taskOpDepName}`}
        </span>
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
  if (toolName === 'todo_write') {
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
      onOpenDiff !== undefined && callId !== undefined ? '打开 diff 标签' : '在文件标签预览';
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
  } else if (toolName === 'skill') {
    body = (
      <div className="tool-md">
        <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={keepUrl} components={mdComponentsPlain}>{fullResult}</ReactMarkdown>
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
  } else if (command !== undefined) {
    body = (
      // G14.50:命令与输出合一区(终端形态:$ 行高亮 + 输出同块,不再分输入/输出两段)
      <div className="tool-exec">
        <pre className="tool-io-pre">
          <span className="exec-prompt" aria-hidden="true">$ </span>
          <code dangerouslySetInnerHTML={{ __html: highlightCode(command, 'cmd.sh') }} />
          {'\n'}
          {fullResult !== '' ? fullResult : t('(no result)', '(无结果)')}
        </pre>
      </div>
    );
  } else {
    body = <pre className="tool-io-pre">{fullResult !== '' ? fullResult : t('(no result)', '(无结果)')}</pre>;
  }

  return (
    <div className={`entry entry-tool${expanded ? ' open' : ''}`}>
      <button
        type="button"
        className="tool-summary"
        aria-expanded={isRead ? undefined : expanded}
        onClick={() => {
          if (isRead) onOpenFile?.(path!);
          else setExpanded((v) => !v);
        }}
      >
        <ToolIcon verb={toolName} />
        {collapsed}
        {!isRead && <ChevronRight className="tool-chev" size={12} strokeWidth={1.75} aria-hidden="true" />}
      </button>
      <div className={`tool-body${expanded ? ' open' : ''}`} aria-hidden={!expanded}>
        <div className="tool-body-inner">{body}</div>
      </div>
    </div>
  );
}
