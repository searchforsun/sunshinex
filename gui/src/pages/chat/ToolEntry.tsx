import { useEffect, useState } from 'react';
import { Check, ArrowRight, FileText, Wrench, PenLine, SquareTerminal, Search, FolderSearch, ChevronRight, Sparkles, Globe, Telescope, Brain, ListTodo, GitBranch, Bot, Square, Hourglass, BookOpen, MessageCircleQuestion, ListPlus, GitMerge, UserPlus, Eye, ShieldCheck, XCircle, type LucideIcon } from 'lucide-react';
import { t } from '../../i18n';
import { highlightCode } from '../../highlight';
import { pathBasename } from '../../ui-util';
import type { ChatEntry } from '../../chat-reducer';
import type { Connection } from '../../connection';
import { DiffLines } from '../../diff-lines';
import { FileIcon } from '../../file-icon';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { keepUrl, mdComponentsPlain, type ToolCallInfo } from '../Chat';
import type { DiffResp } from '../../connection';

/** 工具动词 → 图标(渲染面映射;md 形态不变,未知工具通用件);G14.168 taskboard 六工具专属图标(去扳手默认) */
const TOOL_ICONS: Record<string, LucideIcon> = {
  read: FileText, write: PenLine, exec: SquareTerminal, grep: Search, glob: FolderSearch,
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



/** 工具条 md(`● [tool] name {json}\n⎿ result`)的渲染侧只读拆解——reducer 组装为 `● ` + 事件原文
 *  (batch-runner 行为 `[tool] name {json}`),两层前缀都剥;旧 journal `● name {json}` 同兼容 */
export function verbOf(md: string): string {
  const nl = md.indexOf('\n');
  let head = (nl > 0 ? md.slice(0, nl) : md).trim();
  if (head.startsWith('● ')) head = head.slice(2).trim();
  if (head.startsWith('[tool] ')) head = head.slice(7).trim();
  const sp = head.indexOf(' ');
  return sp > 0 ? head.slice(0, sp) : head;
}

export function resultOf(md: string): string {
  const m = md.indexOf('⎿ ');
  return m >= 0 ? md.slice(m + 2) : '';
}

export interface TodoBatch {
  key: string;
  ts: number;
  goal: string;
  items: Array<{ text: string; status: 'completed' | 'in_progress' | 'pending' }>;
}

/** 种子条工具信息还原:md 首行 `● [tool] name {json}` → {name, input}——种子回放无旁路 info,
 *  折叠行不再裸渲 JSON(与实时帧 `write path · 结果` 同形);参数段缺失/非 JSON 只出工具名 */
export function toolMdInfo(md: string): { name: string; input: Record<string, unknown> } | undefined {
  const nl = md.indexOf('\n');
  let head = (nl > 0 ? md.slice(0, nl) : md).trim();
  if (head.startsWith('● ')) head = head.slice(2).trim();
  if (head.startsWith('[tool] ')) head = head.slice(7).trim();
  const sp = head.indexOf(' ');
  const name = sp > 0 ? head.slice(0, sp) : head;
  if (name === '') return undefined;
  if (sp <= 0) return { name, input: {} };
  try {
    const parsed = JSON.parse(head.slice(sp + 1)) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { name, input: parsed as Record<string, unknown> };
    }
  } catch {
    // 参数段非 JSON:只出工具名,不裸渲参数原文
  }
  return { name, input: {} };
}

/** G14.168 工具折叠行动词中文展示单点(en=现有字面,zh=本地化;未登记工具(MCP 引入等)回退原名)。
 *  G14.213 两字优先:能两字表意的不用多字(查阅/查找/抓取/搜索/记忆/派生/停止/等待/检索/
 *  建单/依赖/分派/复审/门审/取消);工作树无自然两字,保留 */
const TOOL_VERB_ZH: Record<string, string> = {
  read: '读取', write: '写入', exec: '执行', grep: '查阅', glob: '查找',
  skill: '技能', webfetch: '抓取', websearch: '搜索', memory_write: '记忆',
  todo_write: '待办', worktree: '工作树', spawn: '派生', task_stop: '停止',
  task_wait: '等待', kb_search: '检索', ask_question: '提问',
  create_task: '建单', set_dependency: '依赖', assign: '分派',
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
  exec: ['Running command', '正在执行'],
  glob: ['Searching files', '正在搜索文件'],
  grep: ['Searching', '正在搜索'],
  skill: ['Loading skill', '正在加载技能'],
  webfetch: ['Fetching page', '正在抓取网页'],
  websearch: ['Searching the web', '正在搜索网页'],
  memory_write: ['Saving memory', '正在保存记忆'],
  spawn: ['Dispatching subagent', '正在分派子代理'],
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

/** 文件行拆分(G14.8):basename + 所在目录(恒显,根目录 = './')——文件名后永远看得到位置 */
export function fileLabelOf(path: string): { base: string; dir: string } {
  const norm = path.replace(/\\/g, '/');
  const base = pathBasename(norm);
  const dir = norm.slice(0, norm.length - base.length);
  return { base, dir }; // 根目录文件 dir = ''(名称即相对路径,不重复显示)
}

/** write 结果首行 `written +3 -1` → diff stat 拆分(G14 底层同源);无 stat 回空 */
export function writeStatOf(result: string): { added?: string; removed?: string } {
  const m = /\+(\d+) -(\d+)/.exec(result);
  return m === null ? {} : { added: `+${m[1]}`, removed: `-${m[2]}` };
}

/** G6 工具条目(折叠态一行/点击展开):write 工具(name==='write',call 名判定——事件 text 即
 *  注册名)展开接 G7 fetchDiff(oldStr=oldContent/newStr=newContent 双列;加载期先示右列现内容
 *  +加载标,404/失败退单列现内容——快照种子条/无 callId 面恒单列)+ path 文本按钮(G8d 起
 *  callId 在场优先 onOpenDiff 开 diff 标签,缺场回落 onOpenFile 文件标签预览);其他工具展开
 *  Input/Output 双段(G11 §2:input JSON + result 全文,各段 280px 内滚;result 旁路暂存,
 *  种子条回落 md 首行)。折叠壳 grid 化(0fr→1fr 生长):展开面常挂 DOM,折叠仅 CSS 收起。 */
export function ToolEntryView({
  entry,
  info,
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
  info?: ToolCallInfo;
  conn: Connection;
  sessionId: string;
  callId?: string;
  onOpenFile?: (path: string) => void;
  onOpenDiff?: (callId: string, path: string) => void;
  /** G14.171 spawn 行子代理名=蓝色链接,点开对应 agent 只读标签页(App 注入 openTabInSession) */
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
  const verb = verbOf(entry.md);
  const result = resultOf(entry.md);
  /** 折叠行动词/目标:旁路 info 优先,种子条回落 md 首行 JSON 还原——两路同形(`write path`) */
  const mdInfo = info ?? toolMdInfo(entry.md);
  const toolName = mdInfo !== undefined ? mdInfo.name : verb;
  const input = mdInfo?.input ?? {};
  const path = typeof input.path === 'string' && input.path !== '' ? input.path : undefined;
  const command = toolName === 'exec' && typeof input.command === 'string' && input.command !== '' ? input.command : undefined;
  const target = mdInfo !== undefined ? toolTargetOf(toolName, input) : undefined;
  /** write 分型(G14):折叠=文件名+相对路径+diff stat,展开=diff2html;read 分型:整行=打开文件标签 */
  const isWrite = toolName === 'write' && path !== undefined;
  const isRead = toolName === 'read' && path !== undefined && onOpenFile !== undefined;
  const fileLabel = path !== undefined ? fileLabelOf(path) : undefined;
  const stat = isWrite ? writeStatOf(result) : {};
  /** G14.171 spawn 子代理名(label ?? agent_id)——运行态文案与折叠行链接共用 */
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
  /** G14.13 全工具双态:结果未回(占位符 …)=执行中(波纹+「正在…」);结果已回=各型折叠行 */
  const executing = result === '…' || result === '';
  const runningLabel = (() => {
    // G14.166 spawn 运行态带子代理名(label ?? agent_id)——「正在分派 架构分析」替代泛文案
    if (toolName === 'spawn' && spawnAgentName !== '') return t(`Dispatching ${spawnAgentName}`, `正在分派 ${spawnAgentName}`);
    const pair = RUNNING_LABELS[toolName] ?? ['Running', '正在执行'];
    return t(pair[0], pair[1]);
  })();
  /** 展开面全文:旁路暂存优先,种子条 info 缺省回落 md 首行(skill 正文/长输出同源) */
  const fullResult = info?.result ?? result;
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

  /** 折叠行主体(G14 分型):文件工具=文件名+相对路径(+stat);exec=完整命令;skill=名;其余=动词+目标 */
  const collapsed = (
    <>
      {executing ? (
        <span className="tool-verb exec-running">
          {/* G14.88 纯流光文字(去工具图标+波纹框——双图标视感,用户裁定) */}
          <span className="exec-running-text">{runningLabel}</span>
        </span>
      ) : path !== undefined && (isWrite || toolName === 'read') ? (
        <>
          {/* G14.4 行序:工具图标(前置)+工具名+文件图标+文件名+相对路径(+stat);结果不进折叠行 */}
          <span className="tool-verb">{zhToolName(toolName)}</span>
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
      ) : toolName === 'ask_question' ? (
        /* G14.82:折叠行直接示问题文本(问询即内容,非动词+目标) */
        <>
          <span className="tool-verb">{t('ask', '提问')}</span>
          <span className="tool-file-base tool-cmd">{' '}{typeof input.question === 'string' ? input.question : ''}</span>
        </>
      ) : toolName === 'todo_write' ? (
        /* G14.138 折叠行本地化;G14.199 格式「待办 {完成}/{总数}」(对号去除,用户裁定) */
        (() => {
          const arr = Array.isArray(input.todos) ? (input.todos as Array<Record<string, unknown>>) : [];
          const done = arr.filter((o) => (o ?? {}).status === 'completed').length;
          return (
            <>
              <span className="tool-verb">{t('todo', '待办')}</span>
              <span className="tool-file-base tool-cmd">{` ${done}/${arr.length}`}</span>
            </>
          );
        })()
      ) : toolName === 'create_task' ? (
        /* G14.168 折叠行带任务名;G14.176 任务名=蓝色链接,点开任务板定位高亮对应卡 */
        <>
          <span className="tool-verb">{zhToolName('create_task')}</span>
          {onOpenTask !== undefined && typeof input.title === 'string' && input.title !== '' ? (
            <span
              role="button"
              tabIndex={-1}
              className="tool-file-base tool-agent-link"
              data-tip={t('Open task board card', '在任务板中定位')}
              onClick={(e) => {
                e.stopPropagation();
                const created = /task (\S+) created/.exec(result);
                onOpenTask(created !== null ? created[1]! : (input.title as string));
              }}
            >
              {' '}{input.title}
            </span>
          ) : (
            <span className="tool-file-base tool-cmd">
              {typeof input.title === 'string' ? ` ${input.title}` : ''}
            </span>
          )}
        </>
      ) : toolName === 'spawn' ? (
        /* G14.166 折叠行带子代理名(G14.171:蓝色链接,点开对应 agent 只读标签页) */
        <>
          <span className="tool-verb">{t('spawn', '分派子代理')}</span>
          {spawnAgentName !== '' && onOpenAgent !== undefined ? (
            <span
              role="button"
              tabIndex={-1}
              className="tool-file-base tool-agent-link"
              data-tip={t('Open subagent transcript', '打开子代理转录')}
              onClick={(e) => {
                e.stopPropagation(); // 不触发行展开
                onOpenAgent(spawnAgentName, spawnAgentName, typeof input.prompt === 'string' ? input.prompt.slice(0, 2000) : undefined);
              }}
            >
              {' '}{spawnAgentName}
            </span>
          ) : (
            <span className="tool-file-base tool-cmd">{spawnAgentName !== '' ? ` ${spawnAgentName}` : ''}</span>
          )}
        </>
      ) : toolName === 'task_wait' ? (
        /* G14.167 折叠行带等待任务名(G14.172:任务板解析为任务名,不用 id;null=等全部在跑) */
        <>
          <span className="tool-verb">{t('task_wait', '等待任务')}</span>
          <span className="tool-file-base tool-cmd">
            {' '}
            {waitTaskNames.length > 0
              ? waitTaskNames.join(', ')
              : Array.isArray(input.taskIds)
                ? ''
                : t('all background tasks', '全部后台任务')}
          </span>
        </>
      ) : command !== undefined ? (
        <>
          <span className="tool-verb">{t('exec', '执行')}</span>
          {/* G14.50:展开态不重复命令文本(下方 $ 行已完整示出) */}
          {!expanded && <span className="tool-file-base tool-cmd">{' '}{command}</span>}
        </>
      ) : (
        /* G14.168 动词中文展示单点(MCP 等未登记工具回退原名)+目标字段 */
        <span className="tool-verb">
          {zhToolName(toolName)}
          {target !== undefined ? ` ${target}` : ''}
        </span>
      )}
    </>
  );

  /** 展开面主体(G14 分型):write=diff2html;skill=md 正文;exec=$ 命令高亮+输出;
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
              {/* G14.169 统一圆圈三态:完成=蓝底√/进行=→/等待=虚线圈(用户裁决,替代 ☑◐☐ 字符) */}
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
    const fallbackNew = typeof input.content === 'string' ? input.content : '';
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
          <DiffLines oldStr={diff?.oldContent} newStr={diff !== null && diff !== undefined ? diff.newContent : fallbackNew} path={path} maxHeight={280} />
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
        data-tip={isRead ? t('Open in file tab', '在文件标签预览') : undefined}
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
