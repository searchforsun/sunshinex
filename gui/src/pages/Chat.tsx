import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import {
  ArrowDown, ArrowUp, ChevronDown, Folder,
  GripVertical, ListTodo, PanelRight, PenLine, ShieldCheck,
  Square, Trash2, ArrowUpToLine, CornerDownRight, Unlock
} from 'lucide-react';
import { applyChatEvent, appendUserMessage, initialChatState } from '../chat-reducer';
import type { ChatEntry, ChatState } from '../chat-reducer';
import { groupEntriesByDay } from '../chat-groups';
import { zoomScale } from '../ui-zoom';
import { ComposerCard } from '../composer/ComposerCard';
import { ComposerPlusPanel } from '../composer/ComposerPlusPanel';
import type { TaskBoardState } from '../projection';
import { CommandPalette, filterCommands } from '../CommandPalette';
import { ContextRing } from '../context-ring';
import { EffortChip, EffortSlider } from '../effort-slider';
import { fmtTokens as fmtTokensShared, pathBasename } from '../ui-util';
import type { CmdItem } from '../CommandPalette';
import type { Connection, ConnectionState, GuiApprovalReq, GuiAskReq, SnapshotResponse } from '../connection';
import type { SessionEvent, TodoItem } from '../../../src/types';
import { t } from '../i18n';

/**
 * T4δ Chat 页(G3 对话面会话化迁移):App 暂留的 G3 单页对话面(reducer/md 渲染/输入分流/Stop/
 * 状态条/播种门语义)整体迁入本组件,改会话维——动作走 :id(sessionSubmit/sessionSteer/
 * sessionInterrupt),基线经 conn.sessionSnapshot(sessionId) 播种;本地态(reducer 投影/输入/
 * 播种门)随组件销毁,App 以 key={sessionId} 挂载保证两会话先后打开互不串扰(无跨会话残留,
 * 不断连重连——连接生命周期在 App 壳)。
 *
 * 事件面经 App 壳转投(连接回调在 createConnection 装配时固定,Chat 无法自接):App 的 onEvent
 * 三参按 sessionRef 过滤本会话后经 sinkRef 投 `sink.on(e, seq)`;onReset(首连/重连同路径)投
 * `sink.reset()` → 本会话重播种(既有播种门语义:基线在途输入禁用,防本地回显被种子整替)。
 *
 * 每会话种子竞态缓冲(T3 收口):连接层抬基线(sessionSnapshot 应答抬高 lastSeqBySession)只在
 * HTTP 应答落定之后——seed 在途窗内到达的本会话帧已过连接层 seq 门,若直投 reducer 会被随后的
 * 种子整替清掉(丢帧),先缓冲;种子落定后以 seq ≤ snapshot.lastSeq 过滤(≤ 切割序者种子已含,
 * 再投即双应用)再依序投 reducer。G3 T3 连接层的单会话 armed/pending 语义在页内复刻(连接层
 * 已无 armed,页面自缓冲;reseed 时清缓冲重来,unmount 随组件销毁)。
 *
 * G4 挂起卡片区(转录上方固定区):App 的 onApproval/onAsk 经 sessionRef 过滤本会话后经 sink
 * 投递——ApprovalCard(kind/subject/reason + Allow/Deny/Always)/AskCard(question + 选项单/多选
 * + customIndex 自由输入 + Submit/Dismiss);回执走 conn.replyApproval/replyAsk(pid 契约:寻址
 * 用帧顶层 pid,非 req.id);卡列表 pid 管理——回执成功移,失败(404 已决)也移(不悬挂)。
 * 连接级 reset(重连)卡保留(daemon 未决重发被连接层 pid 去重);会话 reset 帧(resetSession)
 * 清卡(daemon 已 deny/dismissed 回填全部挂起)+清投影重播种。
 * G5 增两面:①顶栏 Delete(confirm → conn.deleteSession(sessionId) → onBack 回首页——Home
 * 行 Delete 以 journal id 寻址恒 404 退役,daemon 会话 id 才是回收端点的有效寻址);②status
 * 转 idle 清卡(effect 观察投影状态:run 收束 = daemon 已对本 run 挂起 deny 回填,本地卡随之
 * 清;reseed 后快照 status=idle 亦触发);③onSeeded(快照落定回调,App 借此取 snapshot.team
 * 存 App 态——事件流无 teammate 面,Board 侧栏的唯一来源)。
 * G7 增三面:①reseed 挂起卡重建——snapshot.pending 逐项 addCard({pid,kind,req})(req 透传
 * 落地,刷新/重连后卡内容可恢复;连接层 pid 去重拦了 daemon 重发帧,快照是唯一来源);②reseed
 * 时 toolInputs 清(旧投影 callId 配对残留不污染新投影);③write 条目展开接 conn.fetchDiff
 * (old/new 双列;404/失败退单列现内容)。unmount cleanup 增 seedGenRef++(G6 终审首优先):
 * 在途快照应答经 gen 失配早退,防陈旧 onSeeded 污染 App 态。
 * G8d T5 交互清单:①输入面 textarea 自增高(rows 随换行数 1-6 派生;Enter 提交 preventDefault,
 * Shift+Enter 换行走默认);②流式条末挂 span.sx-stream-cursor(闪灭动画在 app.css 特批小段);
 * ③状态条 tokens/steps 改图标+数字组(sx-stat 组类名+lucide Coins/Footprints,样式面归 G8e)。
 * G9 B3b(spec docs/superpowers/specs/2026-10-08-codex-desktop-1to1-design.md §3):用户条目
 * UserEntryView(memo)右对齐胶囊+hover 浮现复制(剥 `> ` 前缀写剪贴板,失败 1.5s 示「未复制」);
 * 条目按日分组(groupEntriesByDay 纯投影)跨日插居中日期分隔——每日组顶部一条,与 Codex 实机同形。
 */

/** App → Chat 事件转投面:Chat 装配期注册到 sinkRef(卸载注销 null)——连接层回调闭包固定,
 *  App 侧经 ref 转投免闭包陈旧 */
import { useCommandPalette } from './chat/use-command-palette';
import { useSessionEvents } from './chat/use-session-events';
import { ApprovalCard, AskCard, pickAnswered } from './chat/PendingCards';
import { atomicRange, expandFileRefs, fileHit, FilePalette, renderMentionSpans, splitMentionTokens, tokenDeleteRange, tokenGuardVerdict, tokenSpanAt } from './chat/mention';
export { atomicRange, expandFileRefs, fileHit, FilePalette, renderMentionSpans, renderUserMd, splitMentionTokens, tokenDeleteRange, tokenGuardVerdict, tokenSpanAt } from './chat/mention';
export type { MentionToken, TokenGuardVerdict } from './chat/mention';
export { buildMdComponents, buildUserMdComponents, keepUrl, mdComponentsPlain, MermaidBlock } from './chat/md-render';
import { baseModelName, ChatEntryView, RunEntryView, ThinkingEntryView, UserEntryView } from './chat/EntryViews';
export { baseModelName, ChatEntryView, CollapsibleBubble, ThinkingEntryView } from './chat/EntryViews';
import type { AskPick } from './chat/PendingCards';
import { useWorkspaceFiles } from './chat/use-workspace-files';
import { useQueue } from './chat/use-queue';
import { ToolEntryView, toolMdInfo } from './chat/ToolEntry';
export { ToolEntryView } from './chat/ToolEntry';
import { ToolSegBlock } from './chat/ToolGroups';
export type { TodoBatch } from './chat/ToolEntry';
import type { TodoBatch } from './chat/ToolEntry';
export interface ChatSink {
  /** 本会话帧(已过 App 侧 sessionId 过滤;seq 供种子竞态窗过滤) */
  on(e: SessionEvent, seq: number): void;
  /** 连接重置(首连/重连):清投影 + 本会话重播种(卡保留——挂起仍在 daemon 未决) */
  reset(): void;
  /** G4 审批挂起帧(已过 App 侧 sessionId 过滤;pid = 回执寻址键) */
  onApproval(pid: string, req: GuiApprovalReq): void;
  /** G4 问询挂起帧(同上) */
  onAsk(pid: string, req: GuiAskReq): void;
  /** G4 会话 reset 通知帧(本会话):清卡(daemon 已 deny/dismissed 回填) + 清投影重播种 */
  resetSession(): void;
}

export interface ChatProps {
  conn: Connection;
  /** 当前会话(:id 动作与播种的维) */
  sessionId: string;
  /** 连接状态机(App 壳单连接透传;composer 门:非 open 禁用) */
  connState: ConnectionState;
  /** 返回首页(App 路由回调;Chat 顶栏「返回首页」) */
  onBack(): void;
  /** App 持有的转投注册面(见 ChatSink) */
  sinkRef: MutableRefObject<ChatSink | null>;
  /** G5 快照落定回调(App 消费 snapshot.team 存态——Board 侧栏;可选防测试桩免配) */
  onSeeded?: (snap: SnapshotResponse) => void;
  /** G6 write 工具 path 按钮回调(App 切 Files tab 并带 initialPath;可选防测试桩免配)。G8d 起
   *  降为回退通道:callId 在场的 write 条目优先走 onOpenDiff(开 diff 标签),callId 缺场(种子
   *  条/无 callId 面)仍开文件标签预览 */
  onOpenFile?: (path: string) => void;
  /** G14.137 todo_write 清单上抛(App 存态喂任务标签会话待办区) */
  onTodos?: (todos: TodoItem[]) => void;
  /** G14.154 挂载即落的初始引用(文件选区「在辅助对话中提问」经 fork 参数携带) */
  initialInsert?: string;
  /** G8d write 条目 path 钮主通道:开 diff 标签(callId 寻址,App 接 openTabInSession('diff',
   *  {callId,path}));可选防测试桩免配——缺场时全部回落 onOpenFile */
  onOpenDiff?: (callId: string, path: string) => void;
  /** G14.171 spawn 行子代理名=蓝色链接:点开对应 agent 只读标签页(App 接 openTabInSession('agent',{label,agentTitle})) */
  onOpenAgent?: (label: string, agentTitle: string, task?: string) => void;
  /** G14.176 create_task 行任务名=蓝色链接:点开任务板并定位高亮对应卡(App 接 openTabInSession('agents')+focus 定位) */
  onOpenTask?: (taskRef: string) => void;
  /** G14.177 顶栏动态计数按钮:打开对应页签(待办=tasks/任务板=agents/后台任务=bgtasks) */
  onOpenTab?: (type: 'tasks' | 'agents' | 'bgtasks') => void;
  /** G14.172 task_wait 行任务名解析材料(任务板投影;App 注入会话板) */
  board?: TaskBoardState;
  /** G14.174 待办批次上抛(每批 todo_write 一卡:时间/关联轮次输入/条目;App 经 services 供待办页签) */
  onTodoBatches?: (batches: TodoBatch[]) => void;
  /** G14.174 关联轮次用户输入上抛(最近一条 user 行;任务板卡片头共用) */
  onTurnGoal?: (goal: string) => void;
  /** G10-C4 回到此轮(/rewind 底层):turn=anchors 1-based;App 接 rewindSession+重开;可选 */
  onRewind?: (turn: number) => void;
  /** G10-C4 分叉新会话(从最近任务轮;/fork 底层);App 接 forkSession+openSession;可选 */
  onFork?: () => void;
  /** G10 欢迎页接力:播种完成后提交的 welcome 目标(setWelcomeGoal 写入;提交即回调清位) */
  pendingGoal?: { root: string; goal: string };
  onPendingGoalDone?: () => void;
  /** 会话所属工作区 root(G10 项目条显示;default 会话='default') */
  root?: string;
  /** 标题落盘后上抛(G14.16:App bump recentVersion → 侧栏 RECENTS 即时同名) */
  onRenamed?: () => void;
  /** G14.28:右栏折叠时顶栏右侧示「展开侧栏」钮(折叠态不渲染 32px 细条) */
  showExpandSidebar?: boolean;
  onExpandSidebar?: () => void;
  /** G14.29 输入 /btw /side 拦截:开辅助对话旁路标签(不动 daemon 提交面) */
  onSideChat?: () => void;
  /** G14.148 /memory(-rm) 拦截:开记忆标签(GUI 的删除面;daemon 命令通道不支持 TUI 交互多选) */
  onOpenMemory?: () => void;
  /** G14.31 辅助对话全新视图:种子历史不落屏(上下文只在模型侧),开播即空会话观感 */
  freshView?: boolean;
  /** G14.32 顶栏定名(辅助对话):压过会话名回落链,不露注册 id */
  fixedTitle?: string;
  /** G14.213 滚动位存档键:journal 档案 id(稳定跨重挂/重启)。sessionId 是活动会话别名
   *  (每次重开经 newSession+attach 重新发号,s165→s167),按它存档永远失配;未配回落 sessionId */
  journalId?: string;
}


/** G6 工具条目结构面:tool-call 帧 payload.input 的本地暂存（chat-reducer 的 ChatEntry 只存 md
 *  两行文本,diff 展开需 input 原文——本组件 sink.on 面旁路暂存,按 callId 寻址配对条目 key） */
export interface ToolCallInfo {
  /** 工具规范名（事件 text——batch-runner emit 首参,如 'write'/'read'） */
  name: string;
  /** 调用入参原对象（payload.input;write 形态 {path, content} 现场核 builtin.ts） */
  input: Record<string, unknown>;
  /** tool-result 全文(sink.on 旁路暂存;乱序双到达合并;种子条无槽回落 md 首行) */
  result?: string;
}

/** G14.177 顶栏动态计数按钮(待办/任务/后台任务):转圈图标+数量;点击开对应页签。
 *  G14.213 原子化三改:①仅运行中显示(轮次收束即隐,待办是否完结无关);②侧栏展开不再隐藏
 *  (挂载点去掉 collapsed 门);③幽灵钮化——无底色、顶栏 hover 浮现,待办钮转圈绿色 */
function ChatDynButtons({ todoActive, taskActive, running, conn, sessionId, onOpenTab }: {
  todoActive: number;
  taskActive: number;
  running: boolean;
  conn: Connection;
  sessionId: string;
  onOpenTab?: (type: 'tasks' | 'agents' | 'bgtasks') => void;
}): JSX.Element | null {
  const [bgRunning, setBgRunning] = useState(0);
  useEffect(() => {
    // 测试桩/旧连接可能未实现 sessionTasks——探活失败静默零计数(按钮全隐,不炸树)
    if (typeof conn.sessionTasks !== 'function') return;
    let alive = true;
    const poll = (): void => {
      Promise.resolve()
        .then(() => conn.sessionTasks(sessionId))
        .then(
          (rows) => {
            if (alive) setBgRunning(rows.filter((r) => r.status === 'running').length);
          },
          () => undefined,
        )
          // 轮询失败按计数保持降级(顶栏徽标非权威数据,下一拍重拉)
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [conn, sessionId]);
  // G14.213 轮次收束即隐:running 熄灭按钮组整体不显(待办/任务是否完结无关)
  if (!running || (todoActive === 0 && taskActive === 0 && bgRunning === 0)) return null;
  return (
    <div className="chat-dyn-buttons" role="group" aria-label="live counters">
      {todoActive > 0 && (
        <button type="button" className="chat-dyn-btn todo" data-tip={t('Open todos', '打开待办')} onClick={() => onOpenTab?.('tasks')}>
          <span className="run-spinner" aria-hidden="true" />
          {t(`${todoActive} todos`, `${todoActive} 待办`)}
        </button>
      )}
      {taskActive > 0 && (
        <button type="button" className="chat-dyn-btn" data-tip={t('Open task board', '打开任务板')} onClick={() => onOpenTab?.('agents')}>
          <span className="run-spinner" aria-hidden="true" />
          {t(`${taskActive} tasks`, `${taskActive} 任务`)}
        </button>
      )}
      {bgRunning > 0 && (
        <button type="button" className="chat-dyn-btn" data-tip={t('Open background tasks', '打开后台任务')} onClick={() => onOpenTab?.('bgtasks')}>
          <span className="run-spinner" aria-hidden="true" />
          {t(`${bgRunning} background`, `${bgRunning} 后台任务`)}
        </button>
      )}
    </div>
  );
}




/** G14.133 审批模式三档统一图标(pill 与菜单同源——静态 Hand 两套渲染退役):
 *  plan=ListTodo / dontAsk=Unlock / manual=ShieldCheck */
export function ModeIcon({ mode, size = 13 }: { mode: 'dontAsk' | 'manual' | 'plan'; size?: number }): JSX.Element {
  const Icon = mode === 'plan' ? ListTodo : mode === 'manual' ? ShieldCheck : Unlock;
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" />;
}




/** tokens 格式:共享面迁移 ui-util.fmtTokens(G14.17)——本文件 re-export 保既有引用零迁移 */
function fmtTokens(n: number): string {
  return fmtTokensShared(n);
}



/** G14.212 会话滚动位存档(localStorage `sunshinex.chat-scroll`):id → { d: 距底 px, t: 时刻 }。
 *  非贴底(>80px,同贴底判定阈值)才记;贴底离开删档(再进照旧跳底)。内存单例跨 Chat 重挂载
 *  存活(key 换装即读),localStorage 节流落盘(冷却 800ms 直写+尾随写);容量封顶 100(超出丢
 *  最旧),存储满/禁用静默 */
const SCROLL_KEY = 'sunshinex.chat-scroll';
type ScrollMem = Record<string, { d: number; t: number }>;
let scrollMem: ScrollMem | null = null;
let scrollFlushAt = 0;
let scrollFlushTimer: ReturnType<typeof setTimeout> | null = null;
function scrollMemMap(): ScrollMem {
  if (scrollMem !== null) return scrollMem;
  try {
    const raw = localStorage.getItem(SCROLL_KEY);
    const obj = raw === null ? null : (JSON.parse(raw) as ScrollMem);
    scrollMem = obj !== null && typeof obj === 'object' ? obj : {};
  } catch {
    scrollMem = {};
  }
  return scrollMem;
}
function flushScrollMem(): void {
  if (scrollFlushTimer !== null) {
    clearTimeout(scrollFlushTimer);
    scrollFlushTimer = null;
  }
  scrollFlushAt = Date.now();
  if (scrollMem === null) return;
  try {
    const entries = Object.entries(scrollMem)
      .sort((a, b) => b[1].t - a[1].t)
      .slice(0, 100);
    localStorage.setItem(SCROLL_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* 存储满/禁用:静默 */
  }
}
function saveScrollPos(id: string, dist: number): void {
  const m = scrollMemMap();
  if (dist <= 0) delete m[id];
  else m[id] = { d: Math.round(dist), t: Date.now() };
  if (scrollFlushTimer !== null) return;
  if (Date.now() - scrollFlushAt > 800) flushScrollMem();
  else scrollFlushTimer = setTimeout(flushScrollMem, 800);
}
/** 存档读取:仅非贴底位(≤80px 视为贴底语义,回 null 走跳底) */
function peekScrollPos(id: string): number | null {
  const hit = scrollMemMap()[id];
  const out = hit !== undefined && hit.d > 80 ? hit.d : null;
  return out;
}

/** G14.95 slash 面板令牌解析:caret 前 /词。atStart=开头(命令+技能) / 中间(仅技能)。
 *  模块层导出(App 欢迎页 /命令 目标分流复用) */
export const slashTokenAt = (text: string, caret: number): { query: string; from: number; atStart: boolean } | null => {
  const m = /\/([\w-]*)$/.exec(text.slice(0, caret));
  if (m === null) return null;
  return { query: m[1] ?? '', from: m.index, atStart: m.index === 0 };
};

export function Chat({ conn, sessionId, connState, sinkRef, onSeeded, onOpenFile, onOpenDiff, onOpenAgent, onOpenTask, board, onFork, pendingGoal, onPendingGoalDone, root, onRenamed, showExpandSidebar, onExpandSidebar, onSideChat, freshView, fixedTitle, journalId, onTodos, onOpenMemory, initialInsert, onTodoBatches, onTurnGoal, onOpenTab }: ChatProps): JSX.Element {
  const [chat, setChat] = useState<ChatState>(initialChatState);
  /** G14.213 滚动位存档键:journal 档案 id(稳定)优先,缺省回落 sessionId(测试桩/旁路面) */
  const archiveKey = journalId !== undefined && journalId !== '' ? journalId : sessionId;


  /** G14.172 任务名映射(转录自建):create_task 行回执 `task tN created` → 标题——板投影是内存态
   *  (daemon 重启即空),历史会话的任务名只能从转录回执重建;task-tN 台账业务段一并入表 */
  const taskTitleMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of chat.entries) {
      if (e.kind !== 'tool') continue;
      const info = toolMdInfo(e.md);
      if (info === undefined || info.name !== 'create_task') continue;
      const title = typeof info.input.title === 'string' ? info.input.title.trim() : '';
      const created = /task (\S+) created/.exec(e.md);
      if (title !== '' && created !== null) {
        m.set(created[1]!, title);
        m.set(`task-${created[1]!}`, title);
      }
    }
    return m;
  }, [chat.entries]);

  /** G14.172 任务 id → 展示名单点:board 直查 → 转录映射(剥台账时间戳尾/剥 task- 前缀两级) → 短 id 兜底
   *  ——用户裁决「等待任务显示任务名称,不要用 id」 */
  const taskNameOf = useCallback(
    (id: string): string => {
      const probe = (cand: string): string | undefined => {
        const fromMap = taskTitleMap.get(cand);
        if (fromMap !== undefined) return fromMap;
        const t = board?.tasks[cand];
        return t !== undefined && t.title !== '' ? t.title : undefined;
      };
      if (taskTitleMap.has(id) || board?.tasks[id] !== undefined) {
        const hit = probe(id);
        if (hit !== undefined) return hit;
      }
      const short = id.replace(/-\d{8}T\d{6}Z-[0-9a-z]+$/i, '');
      return probe(short) ?? probe(short.replace(/^task-/, '')) ?? short;
    },
    [board, taskTitleMap],
  );
  const [input, setInput] = useState('');
  /** G10-C4 composer pills:会话权限态 + 模型信息(snapshot 回显,切换即乐观更新) */
  const [sessMode, setSessMode] = useState<'dontAsk' | 'manual' | 'plan'>('dontAsk');
  const [sessEffort, setSessEffort] = useState<string | undefined>(undefined);
  const [modelInfo, setModelInfo] = useState<{ current?: string; choices: Array<{ id: string; model: string; effort?: string }> } | null>(null);
  /** pill 开合('plus' = + 附加面板) */
  const [pillOpen, setPillOpen] = useState<'mode' | 'model' | 'plus' | null>(null);
  /** textarea 引用(+ 面板插入收口后焦点回输入框) */
  /** textarea 引用(+ 面板插入收口后焦点回输入框) */
  /** 流区贴底跟随(G13 反馈轮):滚动容器 ref + 「用户是否贴底」旁路 ref——贴底(含初始态)时
   *  每次渲染(流式 token/条目增删)自动归底;用户上翻超阈值即放手,再触底恢复跟随 */
  const chatScrollRef = useRef<HTMLElement | null>(null);
  // G14.212/G14.213 再进恢复上次浏览位:挂载读非贴底存档(距底 px,键=journalId 稳定身份)——
  // 存档位待恢复 + 贴底跟随挂起(stick 初值 false,每渲染归底 effect 让位;恢复后 onScroll 接管)。
  // 贴底离开无存档=照旧跳底
  const scrollRestoreRef = useRef<number | null>(peekScrollPos(archiveKey));
  const chatStickRef = useRef(scrollRestoreRef.current === null);
  /** G14.85 @ 工作区文件选择:文件清单懒加载(BFS 限深限数,跳噪声目录)+触发态 */
  const [filePal, setFilePal] = useState<{ query: string; from: number } | null>(null);
  const [filePalFiles, setFilePalFiles] = useState<string[]>([]);
  const [filePalActive, setFilePalActive] = useState(0);
  // G14.211 @ 面板点外即收:收口此前只有 Esc/改写输入两条路,焦点离开输入框后 Esc 不可达、
  // 点外无处理 = 面板滞留(「无法关闭」直感)。pointerdown 落 composer 卡外即收;面板行在
  // 卡内(overlays 锚卡根),选中点击不受影响
  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Element && !e.target.closest('.sx-composer')) setFilePal(null);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, []);
  /** G14.126 @文件名 记账:选中面板行时 basename → 相对路径(发送期展开解析第一优先) */
  const pickRelRef = useRef(new Map<string, string>());
  /** G14.213 IME 组合中标记:onSelect 归位在组合期跳过(防打断输入法) */
  const composingRef = useRef(false);
  /** 工作区文件索引 hook(D32 批B 数据部):装载/缓存/预热/解析器——记账表注入,pickRelRef 写入面留 UI */
  const { resolveFileRef, loadWorkspaceFiles } = useWorkspaceFiles(conn, sessionId, root, pickRelRef);
  /** 队列面 hook(D32 批B):排队 chips 状态/折叠/refreshQueued/pauseAndSend——会话流可见化与 @ 展开
   *  依赖注入（resolveFileRef 此处已完成声明）；行为零变化（Chat.pause-send.test 为锚） */
  const { queued, setQueued, queueFolded, setQueueFolded, refreshQueued, pauseAndSend } = useQueue(
    conn,
    sessionId,
    root,
    resolveFileRef,
    expandFileRefs,
    setChat,
  );
  const { cmdData, setCmdData, cmdActive, setCmdActive, skillCmds } = useCommandPalette(conn, sessionId);
  /** G14.95 slash 面板令牌解析:caret 前 /词。atStart=开头(命令+技能) / 中间(仅技能) */
  const slashItemsFor = (token: { query: string; atStart: boolean } | null): CmdItem[] => {
    if (token === null) return [];
    const q = token.query.toLowerCase();
    const cmds =
      token.atStart && cmdData !== null
        ? filterCommands(cmdData.commands, cmdData.descriptions, token.query, cmdData.supported)
        : [];
    const skills = skillCmds
      .filter((s) => q === '' || s.id.toLowerCase().startsWith(q) || s.id.toLowerCase().includes(q))
      .slice(0, 8)
      .map((s) => {
        const name = s.id;
        const idx = name.toLowerCase().indexOf(q);
        // G14.213 kind='skill':有参数已敲时 Enter 落纯文本发送,不走命令通道(daemon 已 400)
        return { cmd: `/${s.id}`, name, desc: s.description, idx: idx < 0 ? name.length : idx, ok: true, kind: 'skill' as const };
      });
    return [...cmds, ...skills];
  };
  /** 会话标题(G14.16/G14.17 统一流):单源=daemon 旁车 meta——rename 落盘、挂载 GET 回读,
   *  顶栏/侧栏/TUI 一名三处;零历史兼容(旧 localStorage 键不读不迁,旧会话删档重测)。
   *  缺省回落首条用户消息摘要,再落会话 id。点击标题即改 */
  const [title, setTitle] = useState<string | null>(null);
  const [titleLoaded, setTitleLoaded] = useState(false);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const firstUserText = (() => {
    const md = chat.entries.find((e) => e.kind === 'user')?.md ?? '';
    return md.startsWith('> ') ? md.slice(2) : md;
  })();
  const displayTitle = fixedTitle ?? title ?? (firstUserText !== '' ? firstUserText : sessionId);
  /** onRenamed 同步镜像(applyTitle 闭包经 ref 读,免依赖数组抖动) */
  const onRenamedRef = useRef(onRenamed);
  onRenamedRef.current = onRenamed;
  /** rename 单点(G14.16):乐观上屏 + 旁车落盘(静默降级——失败面下次挂载 GET 回读回真值) +
   *  侧栏刷新上抛 */
  const applyTitle = useCallback(
    (v: string): void => {
      setTitle(v);
                    // 改名失败=顶栏回落 daemon 权威名(下次快照刷新),不静默改写本地
      if (typeof conn.renameSession === 'function') void conn.renameSession(sessionId, v).catch(() => undefined);
      onRenamedRef.current?.();
    },
    [conn, sessionId],
  );
  const commitTitle = (): void => {
    setTitleEditing(false);
    const v = titleDraft.trim();
    if (v === '' || v === displayTitle) return;
    applyTitle(v);
  };
  /** 挂载回读(一次):服务端有名→采用;GET 落定前 titleLoaded 门关着——总结调用不抢跑,
   *  改名标题恒压过模型总结(免 GET/总结竞争互覆)。GET 未知会话 404 静默(Chat 仅挂于 live 会话) */
  useEffect(() => {
    if (typeof conn.getSessionTitle !== 'function') {
      setTitleLoaded(true);
      return;
    }
    let alive = true;
    conn.getSessionTitle(sessionId).then(
      ({ title: srv }) => {
        if (!alive) return;
        if (srv !== undefined && srv.trim() !== '') setTitle(srv);
        setTitleLoaded(true);
      },
      () => {
        if (alive) setTitleLoaded(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [conn, sessionId]);
  /** 模型总结(一次,回读落定后):无自定义名且有首条消息时调用,结果走 applyTitle 落盘统一流;
   *  失败静默回落摘要。tried 门:503 降级/竞争下不反复重发 */
  const summarizeTriedRef = useRef(false);
  useEffect(() => {
    if (!titleLoaded || title !== null || firstUserText === '' || summarizeTriedRef.current) return;
    if (typeof conn.sessionTitle !== 'function') return;
    summarizeTriedRef.current = true;
    let alive = true;
    conn.sessionTitle(sessionId, firstUserText).then(
      ({ title: gen }) => {
        if (!alive || gen.trim() === '') return;
        applyTitle(gen.trim());
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [conn, sessionId, firstUserText, title, titleLoaded, applyTitle]);
  /** G14.213 欢迎页接力取用(ref 跳板):事件 hook 的 reseed 闭包经此恒取最新 submitText。
   *  声明前置于事件 hook(deps 求值早于 submitText 定义);赋值仍在其定义处,首帧空档无消费路径 */
  const submitTextRef = useRef<(text: string) => Promise<void>>(() => Promise.resolve());
  /** 会话事件 hook(D32 批C):播种门/种子窗缓冲/挂起卡/事件分流 sink 装配 + G5 idle 清卡——
   *  投影态与队列/pill 设定器注入;行为零变化(Chat.test 为锚) */
  const { toolInputs, cards, seeding, sendApproval, sendAsk } = useSessionEvents({
    conn,
    sessionId,
    sinkRef,
    chat,
    freshView,
    pendingGoal,
    onPendingGoalDone,
    onSeeded,
    onTodos,
    initialInsert,
    setInput,
    setChat,
    setQueued,
    refreshQueued,
    setSessMode,
    setSessEffort,
    submitTextRef,
    flushScrollMem,
  });

  const running = chat.status === 'running';
  /** G14.63 运行状态行「本轮」口径:末个流式 run 的基线差值(会话累计−轮起点);无基线回退累计 */
  /** G14.80 未决问询卡:ask 挂起时输入框变为选择题表单 */
  const askCards = cards.filter((c) => c.kind === 'ask');
  /** G14.91 ask 作答态(dock 级统一提交):pid → {labels, custom};任一题未答不可提交 */
  const [askPicks, setAskPicks] = useState<Record<string, AskPick>>({});
  // 卡组更替(全答提交/跳过/回执移除)即清作答态,防陈旧 pid 累积
  useEffect(() => {
    if (askCards.length === 0) setAskPicks({});
  }, [askCards.length]);
  /** G14.88 审批卡 dock 化:挂起时 dock 变确认框(输入框/队列隐藏),确认后恢复——与 ask 同形 */
  const approvalCards = cards.filter((c) => c.kind === 'approval');
  const lastLiveRun = running
    ? [...chat.entries].reverse().find((e) => e.kind === 'run' && e.streaming === true)
    : undefined;
  const liveSteps = lastLiveRun?.stepsBase !== undefined ? Math.max(0, chat.steps - lastLiveRun.stepsBase) : chat.steps;
  const liveTokens = lastLiveRun?.tokensBase !== undefined ? Math.max(0, chat.tokens - lastLiveRun.tokensBase) : chat.tokens;
  /** G14.74 回到底部钮:非贴底即显(滚动 handler 里置态,值不变时 React 自动跳过重渲染) */
  const [atBottom, setAtBottom] = useState(scrollRestoreRef.current === null); // G14.212 恢复中非贴底:跳底钮即显
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  /** G6 工具条目 → input 暂存配对:条目 key `tool:<callId>`(重复 callId 的 `~n` 后缀剥掉;
   *  `tool:#`(无 callId 面)与播种条(`s<seq>`)不配对——快照 md 无 input,展开退 result 摘要) */
  const toolInfoOf = (entry: ChatEntry): ToolCallInfo | undefined => {
    if (!entry.key.startsWith('tool:') || entry.key.startsWith('tool:#')) return undefined;
    const cid = (entry.key.slice('tool:'.length).split('~')[0]) ?? '';
    return cid.length > 0 ? toolInputs[cid] : undefined;
  };

  /** G14.174 待办批次(每批 todo_write 一卡):时间 + 关联轮次用户输入 + 条目快照——
   *  从转录行重建(种子回放/live 两路同源),经 onTodoBatches 上抛供「待办」页签。
   *  G14.213 块移至 toolInfoOf 之后:input 两路解析(info=live 配对暂存优先,md 兜底)——
   *  此前只解析 md,TUI 流式面 tool 行 md 不带 JSON 输入,待办批次恒空(顶栏无计数/
   *  待办页签「暂无待办」),而工具行本体走 info 路径照常渲染清单 */
  const todoBatches = useMemo<TodoBatch[]>(() => {
    const out: TodoBatch[] = [];
    const strip = (md: string): string => md.replace(/^>\s?/, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
    let lastGoal = '';
    for (const e of chat.entries) {
      if (e.kind === 'user') lastGoal = strip(e.md);
      if (e.kind !== 'tool') continue;
      const info = toolInfoOf(e) ?? toolMdInfo(e.md);
      if (info === undefined || info.name !== 'todo_write') continue;
      const arr = Array.isArray(info.input.todos) ? (info.input.todos as Array<Record<string, unknown>>) : [];
      const items = arr
        .map((o) => ({
          text: String(o?.text ?? ''),
          status: (o?.status === 'completed' ? 'completed' : o?.status === 'in_progress' ? 'in_progress' : 'pending') as TodoBatch['items'][number]['status'],
        }))
        .filter((x) => x.text !== '');
      if (items.length === 0) continue;
      out.push({ key: e.key, ts: e.ts ?? 0, goal: lastGoal, items });
    }
    // G14.179 同清单合并:条目文本签名相同=同一份待办的进度推进(0/3→2/3→3/3 三卡即重复——
    // 用户裁决「同属一个不拆」),按签名只保留最新一批,按其时间正序输出
    const bySig = new Map<string, TodoBatch>();
    for (const b of out) {
      const sig = b.items.map((x) => x.text).join('\n');
      const prev = bySig.get(sig);
      if (prev === undefined || b.ts >= prev.ts) bySig.set(sig, b);
    }
    return [...bySig.values()].sort((a, b) => a.ts - b.ts);
  }, [chat.entries, toolInputs]);

  /** G14.177 顶栏动态计数:待办=末批(最新)未完成条目;任务板=pending+claimed 任务 */
  const todoActive = todoBatches.length > 0 ? todoBatches[todoBatches.length - 1]!.items.filter((x) => x.status !== 'completed').length : 0;
  const taskActive = board !== undefined ? Object.values(board.tasks).filter((x) => x.status === 'pending' || x.status === 'claimed').length : 0;

  /** G14.174 关联轮次用户输入(最近一条 user 行;md 链接折叠为标签文本——goal 供单行省略头) */
  const turnGoal = useMemo(() => {
    const strip = (md: string): string => md.replace(/^>\s?/, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
    for (let i = chat.entries.length - 1; i >= 0; i -= 1) {
      const e = chat.entries[i]!;
      if (e.kind === 'user') return strip(e.md);
    }
    return '';
  }, [chat.entries]);

  // 上报去重(性能面):entries 每 token 帧都换新引用——序列化签名不变就不上报,
  // 否则 App 级 setState 跟着每帧放大重渲染(稳定条 md 计数上涨,G14.174 回归)
  const batchSig = useMemo(() => JSON.stringify(todoBatches), [todoBatches]);
  const reportedBatchSig = useRef('');
  useEffect(() => {
    if (batchSig === reportedBatchSig.current) return;
    reportedBatchSig.current = batchSig;
    onTodoBatches?.(todoBatches);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchSig]);
  useEffect(() => {
    onTurnGoal?.(turnGoal);
  }, [turnGoal, onTurnGoal]);

  /** G7 write 展开的 diff 寻址键:条目 key 同 toolInfoOf 的剥法(`tool:` 前缀 + `~n` 后缀;
   *  种子条/无 callId 面 undefined——不拉 diff,恒单列现内容) */
  const callIdOf = (entry: ChatEntry): string | undefined => {
    if (!entry.key.startsWith('tool:') || entry.key.startsWith('tool:#')) return undefined;
    const cid = (entry.key.slice('tool:'.length).split('~')[0]) ?? '';
    return cid.length > 0 ? cid : undefined;
  };

  /** 模型 pill 数据源(G10-C4):挂载即拉(choices 空=不可切,钮隐藏) */
  useEffect(() => {
    conn.sessionModel(sessionId).then(
      (info) => setModelInfo({ current: info.current, choices: info.choices }),
      () => setModelInfo({ choices: [] }),
    );
  }, [conn, sessionId]);

  /** G14.18 上下文圆环数据:sessionContext 拉取单点——挂载/run 收尾(status 回 idle)/运行中
   *  4s 轮询/悬停展开(圆环 onOpen)四路触发;失败静默保旧值(圆环退化为 0 占用不扰流区)。
   *  G14.21 parts 透传:上下文构成逐段明细(弹层组成面) */
  const [ctxInfo, setCtxInfo] = useState<{ total: number; window: number; parts: Array<{ id: string; tokens: number; count: number }> } | null>(null);
  const refreshCtx = useCallback((): void => {
    if (typeof conn.sessionContext !== 'function') return;
    conn.sessionContext(sessionId).then(
      (b) => setCtxInfo({ total: b.total, window: b.window, parts: b.parts ?? [] }),
      () => undefined,
    );
  }, [conn, sessionId]);
  useEffect(() => {
    setCtxInfo(null);
    refreshCtx();
  }, [refreshCtx]);
  useEffect(() => {
    if (chat.status !== 'idle') return; // run 收尾刷新(运行中由下方轮询与悬停面覆盖)
    refreshCtx();
  }, [chat.status, refreshCtx]); // eslint-disable-line react-hooks/exhaustive-deps -- status 回 idle 即轮尾信号
  useEffect(() => {
    if (chat.status !== 'running') return;
    const iv = setInterval(refreshCtx, 4000);
    return () => clearInterval(iv);
  }, [chat.status, refreshCtx]);
  /** 会话任务轮数(run 条计数——圆环弹层「轮次」;回放种子条同口径) */
  const runCount = chat.entries.reduce((n, e) => (e.kind === 'run' ? n + 1 : n), 0);

  /** 流区贴底跟随(G13 反馈轮):贴底态下每次渲染(流式/条目增删/run 行)归底;上翻 >80px 放手,
   *  再触底恢复。useEffect 无依赖面=每渲染后跑,滚动判断在 onScroll 单点维护 */
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el !== null && chatStickRef.current) el.scrollTop = el.scrollHeight;
  });

  /** G14.212/G14.213 存档位恢复:种子落定(非 seeding 且条目非空)后 rAF 收敛滚动到存档距底位。
   *  内容尚不足高(mermaid/代码高亮等懒渲染还在撑)不硬落——clamp 会错落到顶;逐帧等到位再落,
   *  1.5s 超时按当时可达位兜底(贴底跟随已由 stick=false 挂起,等待期无人争滚动) */
  useEffect(() => {
    const d = scrollRestoreRef.current;
    if (d === null || seeding || chat.entries.length === 0) return;
    scrollRestoreRef.current = null;
    let raf = 0;
    const t0 = Date.now();
    const step = (): void => {
      const el = chatScrollRef.current;
      if (el === null) return;
      const max = el.scrollHeight - el.clientHeight;
      if (max < d && Date.now() - t0 < 1500) {
        raf = requestAnimationFrame(step);
        return;
      }
      el.scrollTop = Math.min(d, max);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [seeding, chat.entries.length]);

  /** G14.2xx mermaid 异步撑高补归底:图渲染落定是 Mermaid 组件内 state,不触发本组件重渲染,
   *  上方逐渲染归底收不到信号——监听落定广播,贴底态 rAF 合并补归底(进场多图连发只归一次) */
  useEffect(() => {
    let raf = 0;
    const onSettled = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = chatScrollRef.current;
        if (el !== null && chatStickRef.current) el.scrollTop = el.scrollHeight;
      });
    };
    window.addEventListener('sx-mermaid-settled', onSettled);
    return () => {
      window.removeEventListener('sx-mermaid-settled', onSettled);
      cancelAnimationFrame(raf);
    };
  }, []);


  /** G14.87 dock 高度实测驱动正文底部 padding:队列展开/textarea 增行使 dock 长高,
   *  固定 padding(132px)下 dock 会盖住正文尾行——ResizeObserver 把实测高度写进 .chat
   *  padding-bottom,正文整体上移不被遮;卸载复原 CSS 缺省 */
  const dockRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const chat = chatScrollRef.current;
    const dock = dockRef.current;
    if (chat === null || dock === null || typeof ResizeObserver === 'undefined') return; // jsdom 无 RO:测试态跳过
    const sync = (): void => {
      // dock 高是视觉 px(gBCR),padding 写本地空间=视觉/根放缩(ui-zoom.ts 契约)
      chat.style.paddingBottom = `calc(var(--thread-gutter) + ${Math.ceil(dock.getBoundingClientRect().height / zoomScale()) + 18}px)`;
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(dock);
    return () => {
      ro.disconnect();
      chat.style.paddingBottom = '';
    };
  }, []);

  /** pills/+ 面板外点收(面板内点与 + 钮自持——多选文件连续点选不闪收) */
  useEffect(() => {
    if (pillOpen === null) return;
    const onDown = (e: MouseEvent): void => {
      if (e.target instanceof Element) {
        if (e.target.closest('.sx-plus-panel') !== null || e.target.closest('.composer-plus-btn') !== null) return;
        if (pillOpen !== 'plus' && e.target.closest('.composer-pills') !== null) return;
        setPillOpen(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pillOpen]);

  /** G5 会话回收(daemon 会话 id 寻址):confirm → deleteSession → onBack 回首页;
   *  失败留在会话示错条(HTTP 409 running 等不静默) */
  /** G14.31 轮次折叠:collapsedRuns=被封段的 Worked 行 key 集;hiddenKeys=折叠区间内的
   *  工具/思考行 key(用户气泡/回复/旁白保留)。G14.73:隐藏条目保持挂载,渲染层包进
   *  seg-collapse 平滑容器(展开/收合高度过渡),不再瞬切。
   *  G14.136 折叠不显非最终正文:段内 sealed assistant 除末条(=最终回复)外一并随轮折叠
   *  (phase 叙述/中间解释默认不露),展开轮时照常可见 */
  const [collapsedRuns, setCollapsedRuns] = useState<ReadonlySet<string>>(new Set());
  const toggleRun = useCallback((key: string): void => {
    setCollapsedRuns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const hiddenKeys = useMemo(() => {
    const s = new Set<string>();
    let hide = false;
    /** 段内 sealed assistant 收集:段收口(run 再启/流尽)时除末条外入 hidden */
    let segAssistants: string[] = [];
    const closeSeg = (): void => {
      if (hide) for (let i = 0; i < segAssistants.length - 1; i += 1) s.add(segAssistants[i]!);
      segAssistants = [];
    };
    for (const e of chat.entries) {
      if (e.kind === 'run') {
        closeSeg();
        hide = collapsedRuns.has(e.key);
        continue;
      }
      if (e.kind === 'assistant') {
        if (e.streaming !== true) segAssistants.push(e.key); // 流式条即当前段末条(实况),不折
        continue;
      }
      if (e.kind === 'user') {
        closeSeg();
        continue;
      }
      if (hide && (e.kind === 'tool' || e.kind === 'thinking')) s.add(e.key);
    }
    closeSeg();
    return s;
  }, [chat.entries, collapsedRuns]);

  /** G14.48 展开/折叠不闪动:贴地(阅读位在底)→ 钉底,内容整体上移;未贴地 → 锚定被点行,
   *  内容整体下移——两侧永不同时动。capture 先于行内 toggle 记 preTop,动画收尾后再校正一次;
   *  原生 scroll-anchor 关闭(overflow-anchor:none)防与本校正互搏 */
  const onEntryToggleClick = useCallback((e: ReactMouseEvent<HTMLDivElement>): void => {
    const target = e.target instanceof Element ? e.target.closest('.thinking-summary, .tool-summary, .entry-run.sealed') : null;
    const row = target !== null ? target.closest('.entry') : null;
    const el = chatScrollRef.current;
    if (target === null || row === null || el === null) return;
    el.style.overflowAnchor = 'none'; // G14.211 校正窗口内关原生锚定(防互搏),收窗即还原恒 auto
    const preTop = row.getBoundingClientRect().top;
    const stick = chatStickRef.current;
    // G14.64:贴地时贯穿整个展开/收合动画(0.22s grid)逐帧钉底——单次校正会让视口随动画
    // 增高先下滑、兜底再上跳;未贴地锚定被点行(行自身展开,行顶不动,单次校正已足)
    const restore = (): void => {
      if (stick) {
        const t0 = performance.now();
        const pin = (): void => {
          el.scrollTop = el.scrollHeight;
          if (performance.now() - t0 < 300) requestAnimationFrame(pin);
        };
        requestAnimationFrame(pin);
        return;
      }
      if (!row.isConnected) return;
      el.scrollTop += (row.getBoundingClientRect().top - preTop) / zoomScale(); // gBCR 视觉差→scrollTop 本地空间
    };
    requestAnimationFrame(restore);
    if (!stick) setTimeout(restore, 240); // 0.22s grid 动画收尾后再校正一次(非贴地路径)
    setTimeout(() => { el.style.overflowAnchor = ''; }, 320);
  }, []);
  /** G14.211 entry 面回调稳定化(memo 生效前提):内联闭包每次渲染换新,任一 prop 变即
   *  全量 entry 重渲染——点一次文件=整列表闪帧(正文抖动源之一) */
  const onEntryOpenDiff = useCallback((p: string): void => { onOpenDiff?.('', p); }, [onOpenDiff]);
  const onEntryRestore = useCallback((p: string): void => {
    conn.restoreChange(sessionId, p).catch(() => {
      setChat((c) => applyChatEvent(c, { type: 'error', text: t('Revert failed', '撤销失败'), ts: Date.now() }));
    });
  }, [conn, sessionId]);

  /** §7 提交路径单点(idle→submit/running→steer/plan→/plan):composer 与编辑卡共用。
   *  本地回显新条,失败倒 error 条(既有逻辑)再 rethrow——编辑卡借 Promise 结果保卡保草稿
   *  (spec §9:提交失败草稿不丢);成功 resolve;空文本 resolve 忽略 */
  const submitText = useCallback(
    (text: string): Promise<void> => {
      // G14.124 @短写 → md 绝对链接(模型/正文/气泡统一 md 链接口径);命令面(/开头)不展开
      const expanded = expandFileRefs(text, root, resolveFileRef).trim();
      const trimmed = expanded.trim();
      if (trimmed === '') return Promise.resolve();
      // G14.29:/btw /side 输入拦截——开辅助对话旁路标签(Codex 同款;不占主链提交面)
      if (/^\/(btw|side)(\s|$)/.test(trimmed)) {
        onSideChat?.();
        return Promise.resolve();
      }
      // G14.89 运行中入队不本地回显:气泡等轮收束自动发送时由 submit 回显(队列语义=还没发生);
      // idle/plan 提交即发生,照旧回显
      if (!running) setChat((c) => appendUserMessage(c, trimmed));
      let req: Promise<void>;
      if (running) req = conn.sessionSteer(sessionId, trimmed).then(() => refreshQueued(), () => {});
      else if (sessMode === 'plan') req = conn.runCommand(sessionId, `/plan ${trimmed}`);
      else if (/^\/[a-z][\w-]*(\s|$)/i.test(trimmed)) {
        // G14.213 skills 回归纯文本:仅「daemon supported 清单内」的 / 词走命令通道,skills/
        // 未知名一律当普通文本提交(系统提示词 skills 清单含「/skill-id 引用优先加载」提示,
        // 模型自主判断)。此前一律先试命令通道、报文含 unsupported 才回落——daemon 现回 400
        // 报文不带该字样,回落失效直接倒错误条(「还是识别成命令了」)
        const word = (/^\/([a-z][\w-]*)/i.exec(trimmed)?.[1] ?? '').toLowerCase();
        const isCommand = cmdData?.supported.some((c) => c.toLowerCase() === `/${word}`) ?? false;
        if (isCommand) {
          req = conn
            .runCommand(sessionId, trimmed)
            .catch(async (err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              if (!/unsupported|400|bad request/i.test(msg)) throw err; // busy 等真实失败照常倒 error 条
              await conn.sessionSubmit(sessionId, trimmed); // 清单过期兜底:命令通道拒即回退纯文本
            })
            .then(() => undefined);
        } else req = conn.sessionSubmit(sessionId, trimmed);
      } else req = conn.sessionSubmit(sessionId, trimmed);
      return req.catch((err: unknown) => {
        setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
        throw err;
      });
    },
    [conn, sessionId, running, sessMode, root, resolveFileRef, cmdData],
  );
  /** G14.213 欢迎页接力取用(ref 跳板,声明前置于事件 hook):恒取最新 submitText */
  submitTextRef.current = submitText;

  /** Enter 分流:idle 提交 / running 插话;本地 user 回显(`> text`),失败倒 error 条 */
  const send = (): void => {
    const text = input.trim();
    if (text === '') return;
    setInput('');
    // fire-and-forget 语义不变:错误面已在 submitText 内倒 error 条;显式吞 rethrow——纯 `void`
    // 不消化 rejection,会留 unhandled rejection(改动前 rejection 被 req.catch 全消费)
      // 补全路径命令执行失败=无输出行(可重试);错误条可见化由主提交路径承担
    submitText(text).catch(() => undefined);
  };

  const interrupt = (): void => {
    void conn.sessionInterrupt(sessionId).catch((err: unknown) => {
      setChat((c) => applyChatEvent(c, { type: 'error', text: err instanceof Error ? err.message : String(err), ts: Date.now() }));
    });
  };

  /** §6 末条投影:各 run 段的末条 assistant 挂操作条。注意 run 条目在该段活动之前(reducer
   *  model-start 先插 run 条,token/thinking/tool 随后)——元数据向前取:run 边界收口时把上一段
   *  末条 sealed assistant 配给其前最近的已封段 run;流尾 assistant 且 status=idle 亦挂(防御面,
   *  种子历史无 run 条,元数据缺省省略)。
   *  memo 纪律(终审):仅各段末条携带 footerRun(条目引用——reducer 保条目引用,跨 token 帧恒稳定),
   *  其余条目 footerRun=undefined 恒稳定——流式零额外重渲染(传元素每帧新建击穿 memo,已废) */
  const runFooterByEntry = new Map<string, ChatEntry>();
  let lastSealedAssistant: ChatEntry | null = null;
  let pendingRun: ChatEntry | null = null;
  for (const e of chat.entries) {
    if (e.kind === 'run') {
      if (lastSealedAssistant !== null && pendingRun !== null) runFooterByEntry.set(lastSealedAssistant.key, pendingRun);
      lastSealedAssistant = null;
      pendingRun = e.streaming === true ? null : e;
    } else if (e.kind === 'assistant' && e.streaming !== true) {
      lastSealedAssistant = e;
    }
  }
  if (lastSealedAssistant !== null) {
    if (pendingRun !== null) runFooterByEntry.set(lastSealedAssistant.key, pendingRun);
    else if (chat.status === 'idle') runFooterByEntry.set(lastSealedAssistant.key, lastSealedAssistant);
  }

  /** G14.95 面板项(渲染期,光标位置):/ 令牌 → 面板项;空=面板不开(无匹配自动关) */
  const slashPanelItems: CmdItem[] | null = (() => {
    const caret = inputRef.current?.selectionStart ?? input.length;
    const items = slashItemsFor(slashTokenAt(input, caret));
    return items.length > 0 ? items : null;
  })();

  /** G14.95 输入框高亮层:token 着色 spans(与 textarea 同排版) */
  const renderHighlightSpans = (text: string): ReactNode => renderMentionSpans(text);
  /** G14.139 文件标签选区「添加到会话」:接收插入事件(文件图标+文件名(L30-L35) token 落输入框) */
  useEffect(() => {
    const onInsert = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ text?: string; rel?: string }>).detail;
      if (detail === undefined || typeof detail.text !== 'string' || detail.text === '') return;
      // G14.211 短写 token(@文件名:L):全相对路径入账本,发送期 expandFileRefs 据此展开
      if (typeof detail.rel === 'string' && detail.rel !== '') {
        const base = detail.rel.split(/[\\/]/).pop() ?? detail.rel;
        pickRelRef.current.set(base, detail.rel);
      }
      setInput((prev) => (prev.trim() === '' ? `${detail.text} ` : `${prev.replace(/\s+$/, '')} ${detail.text} `));
      inputRef.current?.focus();
      // G14.211 光标钉尾:focus 恢复的是 textarea 旧光标位(此前离开输入框时留在原处),
      // 渲染提交后一帧再设到末尾——否则光标落回旧位=token 中间(「不挨着文件」)
      requestAnimationFrame(() => {
        const ta = inputRef.current;
        if (ta !== null) ta.setSelectionRange(ta.value.length, ta.value.length);
      });
    };
    window.addEventListener('sunshinex:insert-ref', onInsert);
    return () => window.removeEventListener('sunshinex:insert-ref', onInsert);
  }, []);
  /** G14.135 输入区点击 @文件 token → 解析并开侧栏 file 标签(click 后 caret 已落在 textarea,
   *  按 token 区间命中判定;解析同发送期口径:记账/索引兜底/带目录直用) */
  const onInputClick = (): void => {
    const ta = inputRef.current;
    if (ta === null) return;
    const caret = ta.selectionStart ?? 0;
    // G14.213 点击落在 token 中间 → 光标钉 token 尾(file token 命中开标签的行为在先,不变)
    const span0 = tokenSpanAt(input, caret);
    if (span0 !== null) ta.setSelectionRange(span0[1], span0[1]);
    if (onOpenFile === undefined) return;
    let pos = 0;
    for (const tk of splitMentionTokens(input)) {
      const s = pos;
      const e = pos + tk.text.length;
      pos = e;
      if (tk.kind !== 'file' || caret <= s || caret > e) continue;
      const token = tk.text.slice(1);
      const anchor = /^(.*):(L\d+(?:-L\d+)?)$/.exec(token);
      const name = anchor !== null ? anchor[1] : token;
      const rel = resolveFileRef(pathBasename(name)) ?? (name.includes('/') ? name : undefined);
      if (rel !== undefined) onOpenFile(rel);
      return;
    }
  };

  return (
    <>
      <header className="chat-topbar">
        {fixedTitle === '' ? (
          // G14.32 辅助对话:顶栏无标题(标签页已具名,双显冗余)
          <span className="chat-title" />
        ) : titleEditing ? (
          <input
            className="chat-title-input"
            value={titleDraft}
            maxLength={40}
            autoFocus
            aria-label={t('Session title', '会话标题')}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTitle();
              if (e.key === 'Escape') setTitleEditing(false);
            }}
          />
        ) : (
          <span className="chat-title" data-tip={`${sessionId} · ${chat.tokens} tokens · ${chat.steps} steps${running ? ' · 运行中' : ''}`}>
            <button
              type="button"
              className="chat-title-btn"
              data-tip={t('Click to rename', '点击重命名')}
              onClick={() => {
                setTitleDraft(displayTitle);
                setTitleEditing(true);
              }}
            >
              <Folder size={14} strokeWidth={1.75} aria-hidden="true" />
              <span className="chat-title-text">{displayTitle}</span>
            </button>
            {/* G14.52:运行态圆点迁侧栏会话行左缘(顶栏不再双显) */}
          </span>
        )}
        <ChatDynButtons todoActive={todoActive} taskActive={taskActive} running={running} conn={conn} sessionId={sessionId} onOpenTab={onOpenTab} />
        {showExpandSidebar && (
          <button
            type="button"
            className="sx-iconbtn chat-expand"
            aria-label="expand sidebar"
            data-tip={t('Expand sidebar', '展开侧边栏')}
            onClick={onExpandSidebar}
          >
            <PanelRight size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </header>
      <main
        className="chat"
        aria-label="chat"
        ref={chatScrollRef}
        onClickCapture={onEntryToggleClick}
        onScroll={(e) => {
          const el = e.currentTarget;
          const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          chatStickRef.current = stick;
          setAtBottom(stick);
          // G14.213 容量守卫:内容高不足以形成有效滚动位(短会话/mermaid 换渲等瞬时塌陷)不记不删
          // ——防塌陷窗内的杂散 scroll 事件把非贴底存档误清(实测曾在浏览中途被清档)
          if (el.scrollHeight - el.clientHeight > 80) {
            saveScrollPos(archiveKey, stick ? 0 : el.scrollHeight - el.scrollTop - el.clientHeight); // 贴底删档/非贴底记距底位
          }
        }}
      >
        {chat.entries.length === 0 && (
          <div className="chat-empty" aria-label="chat empty">
            <div className="chat-empty-title">{t('Give sunshinex a task', '给 sunshinex 一个任务')}</div>
            <div className="chat-empty-hint">{t('Describe the goal: streaming replies, live tool runs, writes need approval', '描述目标即可:模型流式作答,工具实时执行,写操作需审批')}</div>
          </div>
        )}
        {/* 会话流按日分组:跨日插居中日期分隔(纯投影 groupEntriesByDay;无 ts 头组无标不渲染);
            G14.31 折叠轮:sealed run 头点击 → 其后工具/思考行隐藏(用户/回复/旁白保留) */}
        {groupEntriesByDay(chat.entries).flatMap((g) => {
          const nodes: ReactNode[] = [];
          if (g.label !== '') {
            nodes.push(
              <div key={`day:${g.key}`} className="chat-day-sep" role="separator" aria-label={g.label}>
                {g.label}
              </div>,
            );
          }
          /** G14.73:连续的折叠区条目(工具/思考)聚成一段,包进 seg-collapse 平滑容器——
           *  展开与收合都是 grid 高度过渡,不再瞬切;G14.215 段内工具行聚合(ToolSegBlock 抽件) */
          let seg: ChatEntry[] = [];
          const flushSeg = (): void => {
            if (seg.length === 0) return;
            const segEntries = seg;
            nodes.push(
              <ToolSegBlock
                key={`seg:${segEntries[0]!.key}`}
                seg={segEntries}
                closed={hiddenKeys.has(segEntries[0]!.key)}
                renderTool={(e2) => (
                  <ToolEntryView
                    key={e2.key}
                    entry={e2}
                    info={toolInfoOf(e2)}
                    conn={conn}
                    sessionId={sessionId}
                    callId={callIdOf(e2)}
                    onOpenFile={onOpenFile}
                    onOpenDiff={onOpenDiff}
                    onOpenAgent={onOpenAgent}
                    onOpenTask={onOpenTask}
                    taskNameOf={taskNameOf}
                  />
                )}
                renderThinking={(e2) => <ThinkingEntryView key={e2.key} entry={e2} />}
                renderAssistant={(e2) => <ChatEntryView key={e2.key} entry={e2} onOpenDiff={(p) => onOpenDiff?.('', p)} />}
              />,
            );
            seg = [];
          };
          for (const entry of g.entries) {
            // G14.136 折叠态的中间正文随工具/思考一起进 seg-collapse 平滑折叠
            if (entry.kind === 'tool' || entry.kind === 'thinking' || (entry.kind === 'assistant' && hiddenKeys.has(entry.key))) {
              seg.push(entry);
              continue;
            }
            flushSeg();
            if (entry.kind === 'run') {
              nodes.push(
                <RunEntryView
                  key={entry.key}
                  entry={entry}
                  collapsed={collapsedRuns.has(entry.key)}
                  onToggle={entry.streaming === true ? undefined : toggleRun}
                />,
              );
            } else if (entry.kind === 'user') {
              nodes.push(
                <UserEntryView
                  key={entry.key}
                  entry={entry}
                  onSend={submitText}
                  onOpenFile={onOpenFile} // G14.110 气泡内 @文件 token 点击开 file 标签
                />,
              );
            } else {
              nodes.push(
                <ChatEntryView
                  key={entry.key}
                  entry={entry}
                  footerRun={runFooterByEntry.get(entry.key)}
                  onOpenDiff={onEntryOpenDiff}
                  onRestore={onEntryRestore}
                  onFork={onFork}
                  onOpenFile={onOpenFile}
                />,
              );
            }
          }
          flushSeg();
          return nodes;
        })}
        {/* G14.52 运行状态行:常驻流区末行(圆圈+步数+tokens),轮次完成/停止即隐;
            原「尾参挂最后一个工具行」只在工具执行期可见且左缘随工具行缩进不齐——独立成行对齐 */}
        {running && (
          <div className="run-live-line" role="status" aria-label="run status">
            <span className="run-spinner" aria-hidden="true" />
            <span>{`${liveSteps} steps`}</span>
            <span>{fmtTokens(liveTokens)}</span>
          </div>
        )}
      </main>
      {/* G12 统一输入卡:与欢迎页同一份 ComposerCard(唯一差异:无项目选择条,.composer 只提供
       *  会话语境限宽贴底)。textarea 自增高 rows 随换行 1-6 派生;Enter 提交 / Shift+Enter 换行;
       *  发送/停止共用 32px 圆形实心钮(↑/■,aria-label send/stop 保查询性) */}
      <div className="chat-dock" ref={dockRef}>
        <div className="chat-dock-fade" aria-hidden="true" />
      {/* G14.88 审批挂起时队列条隐藏(dock 整体让位确认框),确认/拒绝后恢复 */}
      {queued.length > 0 && approvalCards.length === 0 && (
        <div className="steer-queue" aria-label="queued messages">
          {/* G14.87 折叠摘要行:嵌条头部(欢迎页 options-bar 同形),折叠只留此行不推高 dock */}
          <button
            type="button"
            className="steer-fold"
            aria-expanded={!queueFolded}
            onClick={() => setQueueFolded((v) => !v)}
          >
            <span>
              {t('Queued', '排队')} · {queued.length}
            </span>
            <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" className={queueFolded ? 'steer-fold-chev up' : 'steer-fold-chev'} />
          </button>
          {!queueFolded && (
        <div
          className="steer-list"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const from = Number(e.dataTransfer.getData('text/steer-seq'));
            const to = Number((e.target instanceof Element ? e.target.closest('[data-seq]') : null)?.getAttribute('data-seq') ?? NaN);
            if (Number.isNaN(from) || Number.isNaN(to) || from === to) return;
            setQueued((qs) => {
              const arr = [...qs];
              const [m] = arr.splice(from, 1);
              arr.splice(to, 0, m);
              return arr.map((x, i2) => ({ ...x, seq: i2 }));
            });
            conn.moveSteer(sessionId, from, to).then(refreshQueued, () => {});
          }}
        >
          {queued.map((q, i) => (
            <div
              key={q.seq}
              data-seq={i}
              className="steer-row"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/steer-seq', String(i));
                e.dataTransfer.effectAllowed = 'move';
              }}
            >
              <span className="steer-grip" data-tip={t('Drag to reorder', '拖拽调整排序')}>
                <GripVertical size={14} strokeWidth={1.75} aria-hidden="true" />
              </span>
              <span className="steer-row-text">{q.text}</span>
              <span className="steer-row-actions">
                <button
                  type="button"
                  className="steer-act"
                  data-tip={t('Pause current round and start next with this', '暂停当前轮次,直接开启下一轮发送本条')}
                  onClick={() => void pauseAndSend(q)}
                >
                  <ArrowUpToLine size={12} strokeWidth={1.75} aria-hidden="true" />
                  {t('Now', '立即')}
                </button>
                <button
                  type="button"
                  className="steer-act"
                  data-tip={t('Move to front, inject at next step', '提到队首,下一轮立即插入发送')}
                  onClick={() => {
                    conn.frontSteer(sessionId, q.seq).then(refreshQueued, () => {});
                  }}
                >
                  <CornerDownRight size={12} strokeWidth={1.75} aria-hidden="true" />
                  {t('Insert', '插入')}
                </button>
                <button
                  type="button"
                  className="steer-act steer-act-icon"
                  aria-label={t('Edit in input box', '放回输入框编辑')}
                  data-tip={t('Edit in input box', '放回输入框编辑')}
                  onClick={() => {
                    setQueued((qs) => qs.filter((x) => x.seq !== q.seq));
                    // cancel 失败=daemon 队列保留原条目,下次 refreshQueued 重拉自纠(行重现可再操作)
                    // 删除同理:本地即消,daemon 侧残留由 refreshQueued 重拉自纠
                    conn.cancelSteer(sessionId, q.seq).catch(() => {});
                    setInput(q.text);
                  }}
                >
                  <PenLine size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="steer-act steer-act-icon"
                  aria-label={t('Delete', '删除')}
                  data-tip={t('Delete', '删除')}
                  onClick={() => {
                    setQueued((qs) => qs.filter((x) => x.seq !== q.seq));
                    conn.cancelSteer(sessionId, q.seq).catch(() => {});
                  }}
                >
                  <Trash2 size={12} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </span>
            </div>
          ))}
        </div>
          )}
        </div>
      )}
        {!atBottom && (
          <button
            type="button"
            className="jump-down"
            aria-label="scroll to bottom"
            title={t('Scroll to bottom', '回到底部')}
            onClick={() => {
              const el = chatScrollRef.current;
              if (el !== null) el.scrollTo({ top: el.scrollHeight }); // G14.74:直接跳底(用户裁定)
            }}
          >
            <ArrowDown size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
        {approvalCards.length > 0 ? (
          /* G14.88:审批挂起时输入框变为确认框(与 ask 同形)——Allow/Deny/Always 回执后恢复输入框 */
          <div className="ask-dock">
            {approvalCards.map((c) => (
              <ApprovalCard key={c.pid} req={c.req} onDecision={(d) => sendApproval(c.pid, d)} />
            ))}
          </div>
        ) : askCards.length > 0 ? (
          /* G14.80/G14.91:ask_question 挂起时输入框变为选择题表单——卡列表纵排(单卡内选项自滚)+
             固定提交区(右下):多题任一未答不可提交;跳过=全部 dismissed;全部处理完恢复输入框 */
          <div className="ask-dock">
            <div className="ask-scroll">
              {askCards.map((c) => (
                <AskCard
                  key={c.pid}
                  req={c.req}
                  pick={askPicks[c.pid] ?? { labels: [], custom: '' }}
                  onPick={(patch) =>
                    setAskPicks((m) => {
                      const base = m[c.pid] ?? { labels: [], custom: '' };
                      return { ...m, [c.pid]: { ...base, ...patch } };
                    })
                  }
                />
              ))}
            </div>
            <div className="ask-actions">
              <button
                type="button"
                onClick={() => {
                  askCards.forEach((c) => sendAsk(c.pid, { type: 'dismissed' }));
                  setAskPicks({});
                }}
              >
                {t('Skip', '跳过')}
              </button>
              <button
                type="button"
                className="primary"
                disabled={!askCards.every((c) => pickAnswered(askPicks[c.pid]))}
                onClick={() => {
                  askCards.forEach((c) => {
                    const p = askPicks[c.pid];
                    const custom = p?.custom.trim() ?? '';
                    if (custom !== '') sendAsk(c.pid, { type: 'custom', text: custom });
                    else if ((p?.labels.length ?? 0) > 0) sendAsk(c.pid, { type: 'selected', labels: p!.labels });
                  });
                  setAskPicks({});
                }}
              >
                {t('Submit', '提交')}
              </button>
            </div>
          </div>
        ) : (
        <ComposerCard
          className="chat-composer"
          label="message input"
        value={input}
        rows={Math.min(6, Math.max(1, (input.match(/\n/g) ?? []).length + 1))}
        placeholder={running ? t('Insert into the running session…', '插入运行中会话…') : t('Give sunshinex a task…', '给 sunshinex 一个任务…')}
        disabled={connState !== 'open' || seeding}
        onChange={(v) => {
          setInput(v);
          // G14.124 面板跟随输入(光标前 @token 即开,裸 @ 也开);无匹配=渲染面自然关闭
          const caret = inputRef.current?.selectionStart ?? v.length;
          const m = /@([\w./:\\-]*)$/.exec(v.slice(0, caret));
          if (m !== null) {
            setFilePal({ query: m[1] ?? '', from: caret - (m[1]?.length ?? 0) - 1 });
            void loadWorkspaceFiles().then((files) => setFilePalFiles(files));
          } else if (filePal !== null) {
            setFilePal(null);
          }
        }}
        onKeyDown={(e) => {
          // G14.212 token 原子性:不可在 token 中间落字(字符键/空格/IME Process)——阻止并把
          // 光标钉到 token 尾,下一击落边界;边界编辑(:L 行锚续写)放行
          if ((e.key.length === 1 || e.key === 'Process') && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const taA = e.currentTarget as HTMLTextAreaElement;
            const cs = taA.selectionStart ?? input.length;
            const ce = taA.selectionEnd ?? cs;
            const [as, ae] = atomicRange(input, cs, ce);
            if (as !== cs || ae !== ce) {
              e.preventDefault();
              taA.setSelectionRange(ae, ae);
              return;
            }
          }
          // G14.213 ←/→ 单击跨整个 token(尾→头 / 头→尾,不逐字走进中间);有选区时原生移动
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            const taA = e.currentTarget as HTMLTextAreaElement;
            const c = taA.selectionStart ?? 0;
            const ce = taA.selectionEnd ?? c;
            if (c === ce) {
              const dir = e.key === 'ArrowLeft' ? -1 : 1;
              const nc = c + dir;
              if (nc >= 0 && nc <= taA.value.length) {
                const span = tokenSpanAt(taA.value, nc);
                if (span !== null) {
                  e.preventDefault();
                  const to = dir < 0 ? span[0] : span[1];
                  taA.setSelectionRange(to, to);
                }
              }
            }
          }
          if (e.key !== 'Process' && e.nativeEvent.isComposing !== true) composingRef.current = false; // 组合结束兜底复位(合成事件无 isComposing,取原生)
          // G14.148 /memory(-rm) 精确输入 + Enter → 开记忆标签(不进面板补全循环/命令通道;
          // TUI 交互多选在 GUI 的同位=记忆标签的勾选删除面)
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && /^\/memory(-rm)?\s*$/.test(input)) {
            e.preventDefault();
            setInput('');
            onOpenMemory?.();
            return;
          }
          // G14.156 @/技能 token 整体删除:无选区时 token 内 Backspace/Delete 整删不逐字符
          if (e.key === 'Backspace' || e.key === 'Delete') {
            const ta = e.currentTarget as HTMLTextAreaElement;
            const caret = ta.selectionStart ?? input.length;
            if (ta.selectionStart === ta.selectionEnd) {
              const range = tokenDeleteRange(input, caret, e.key);
              if (range !== null) {
                e.preventDefault();
                const [s, e2] = range;
                setInput((prev) => prev.slice(0, s) + prev.slice(e2));
                requestAnimationFrame(() => { inputRef.current?.setSelectionRange(s, s); });
                return;
              }
            }
          }
          // G14.85 @ 工作区文件选择:光标前 @token → 文件面板(方向循环/Enter 选中/Esc 关闭)
          // G14.121 token 兼容绝对路径(:\ /);选中插入绝对路径(底层索引统一绝对路径口径)
          // G14.211 面板活性=锚点仍在(input[filePal.from]==='@'):键面 preventDefault 直改
          // 输入(token 整删等)不触发 onChange,残锚面板在此收口——否则空输入仍按残 query
          // 命中旧文件,面板滞留且 Enter 可幽灵插入
          const taEl = e.currentTarget as HTMLTextAreaElement;
          const caret = taEl.selectionStart ?? input.length;
          const atMatch = /@([\w./:\\-]*)$/.exec(input.slice(0, caret));
          if (atMatch !== null) {
            setFilePal({ query: atMatch[1] ?? '', from: caret - (atMatch[1]?.length ?? 0) - 1 });
            void loadWorkspaceFiles().then((files) => setFilePalFiles(files));
          } else if (filePal !== null && input[filePal.from] !== '@') {
            setFilePal(null);
          }
          if (atMatch !== null || (filePal !== null && input[filePal.from] === '@')) {
            const items = filePalFiles.filter((f) => fileHit(f, filePal?.query ?? '')).slice(0, 12);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (items.length > 0) {
                setFilePalActive((a) => (e.key === 'ArrowDown' ? (a + 1) % items.length : (a - 1 + items.length) % items.length));
                setFilePal((fp) => fp ?? { query: '', from: 0 });
              }
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setFilePal(null);
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && items.length > 0) {
              e.preventDefault();
              const rel = items[Math.min(filePalActive, items.length - 1)];
              // G14.126 选中只插短写 @文件名(输入框显形=图标+文件名);相对路径记入账本,
              // 发送期 expandFileRefs 据此展开为 md 绝对链接;按 @token 区间替换
              const base = pathBasename(rel);
              pickRelRef.current.set(base, rel);
              const atFrom = filePal?.from ?? caret - (atMatch?.[1]?.length ?? 0) - 1;
              const atEnd = atFrom + 1 + (filePal?.query ?? '').length;
              setInput((prev) => prev.slice(0, atFrom) + `@${base} ` + prev.slice(Math.max(atEnd, atFrom)));
              setFilePal(null);
              return;
            }
          }
          // G14.95 / 面板:开头=命令+技能;中间=仅技能;无匹配(items 空)面板不开=自动关
          const slashToken = atMatch === null ? slashTokenAt(input, caret) : null;
          const slashItems = slashItemsFor(slashToken);
          if (slashToken !== null && slashItems.length > 0) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setCmdActive((a) => (e.key === 'ArrowDown' ? (a + 1) % slashItems.length : (a - 1 + slashItems.length) % slashItems.length));
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setCmdData(null); // 本次收起(重开输入 / 即回)
              return;
            }
            if (e.key === 'Tab') {
              e.preventDefault();
              const item = slashItems[cmdActive];
              if (item !== undefined) setInput((prev) => prev.slice(0, slashToken.from) + item.cmd + ' ' + prev.slice(caret));
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              const item: CmdItem | undefined = slashItems[cmdActive];
              // G14.213 命令项+参数已敲:整行直跑(supported 判定在清单);skill 项不在此列——
              // 落底部纯文本发送(daemon 已 400,skills 普通文本语义)
              if (item !== undefined && item.kind === 'cmd' && input.includes(' ') && item.ok && slashToken.atStart) {
                e.preventDefault();
                setInput('');
                conn.runCommand(sessionId, input).catch(() => {});
                return;
              }
              // 补全仅当 / 词尚未敲完(无参数);skill 项参数已敲同样落底部纯文本发送
              if (item !== undefined && !input.includes(' ')) {
                e.preventDefault();
                setInput((prev) => prev.slice(0, slashToken.from) + item.cmd + ' ' + prev.slice(caret)); // 补全,面板续开收参数
                return;
              }
            }
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault(); // 提交不分流换行进内容面(受控清空,防闪换行)
            send();
          }
        }}
        onBeforeInput={(e) => {
          // G14.212 token 原子性兜底面:键入/IME/粘贴/拖放的 beforeinput 部分命中 token 即拦
          // (插入=光标钉 token 尾;删除=扩整删)——keydown 网之外的编辑面在此收口
          const ev = e.nativeEvent as InputEvent;
          const ta = e.currentTarget;
          const s = ta.selectionStart ?? 0;
          const en = ta.selectionEnd ?? 0;
          const v = tokenGuardVerdict(input, s, en, ev.inputType ?? '');
          if (v.action === 'redirectEnd') {
            e.preventDefault();
            ta.setSelectionRange(v.to, v.to);
          } else if (v.action === 'splice') {
            e.preventDefault();
            setInput((prev) => prev.slice(0, v.s) + prev.slice(v.e));
            requestAnimationFrame(() => ta.setSelectionRange(v.s, v.s));
          }
        }}
        onPasteGuard={(e) => {
          const ta = e.currentTarget;
          const s = ta.selectionStart ?? 0;
          const en = ta.selectionEnd ?? 0;
          const [as, ae] = atomicRange(input, s, en);
          if (as !== s || ae !== en) {
            e.preventDefault();
            ta.setSelectionRange(ae, ae);
          }
        }}
        onCompositionGuard={(e) => {
          composingRef.current = true; // G14.213 组合中:onSelect 归位跳过
          const ta = e.currentTarget;
          const s = ta.selectionStart ?? 0;
          const en = ta.selectionEnd ?? 0;
          const [as, ae] = atomicRange(input, s, en);
          if (as !== s || ae !== en) e.preventDefault();
        }}
        onCompositionEndGuard={() => {
          composingRef.current = false;
        }}
        onSelectGuard={() => {
          // G14.213 光标不落 token 中间:↑↓/Home/End 等原生移动后的兜底归位(钉 token 尾;
          // ←→ 在 keydown 已跨 token);IME 组合中跳过防打断
          if (composingRef.current) return;
          const ta = inputRef.current;
          if (ta === null) return;
          const s = ta.selectionStart ?? 0;
          const en = ta.selectionEnd ?? 0;
          if (s !== en) return;
          const span = tokenSpanAt(ta.value, s);
          if (span !== null) ta.setSelectionRange(span[1], span[1]);
        }}
        overlays={
          // G14.121 @ 文件面板(此前数据链在而渲染面缺失——@ 弹窗从未出现的根因):命中才渲染;
          // G14.211 锚点校验:@ 已被整删/程序化改写后 filePal 残留,锚位不再是 '@' 即不渲染
          filePal !== null && input[filePal.from] === '@' && filePalFiles.some((f) => fileHit(f, filePal.query)) ? (
            <FilePalette
              items={filePalFiles.filter((f) => fileHit(f, filePal.query)).slice(0, 12)}
              active={Math.min(filePalActive, 11)}
              onHover={setFilePalActive}
              onPick={(p) => {
                // G14.126 选中只插短写 @文件名,相对路径记入账本(发送期展开)
                const base = pathBasename(p);
                pickRelRef.current.set(base, p);
                const atFrom = filePal.from;
                const atEnd = atFrom + 1 + filePal.query.length;
                setInput((prev) => prev.slice(0, atFrom) + `@${base} ` + prev.slice(Math.max(atEnd, atFrom)));
                setFilePal(null);
                inputRef.current?.focus();
                // G14.211 光标钉在插入 token 之后(@+名+空格右沿):面板行点击前 textarea 的
                // 旧光标位在 @query 内,focus 恢复旧位=落回 token 中间
                requestAnimationFrame(() => {
                  const ta = inputRef.current;
                  if (ta === null) return;
                  const to = Math.min(atFrom + base.length + 2, ta.value.length);
                  ta.setSelectionRange(to, to);
                });
              }}
            />
          ) : pillOpen === 'plus' ? (
            <ComposerPlusPanel
              conn={conn}
              sessionId={sessionId}
              root={root}
              onInsert={(text) => {
                setInput((v) => (v.trim() === '' ? text : `${v.replace(/\s+$/, '')} ${text}`));
                setPillOpen(null);
                inputRef.current?.focus();
              }}
            />
          ) : slashPanelItems !== null ? (
            (() => {
              const items = slashPanelItems;
              const active = Math.min(cmdActive, Math.max(0, items.length - 1));
              const pick = (item: CmdItem): void => {
                if (!item.ok) return;
                const tok = slashTokenAt(input, input.length);
                const from = tok !== null ? tok.from : input.length;
                const caret = inputRef.current?.selectionStart ?? input.length;
                setInput(input.slice(0, from) + item.cmd + ' ' + input.slice(caret));
              };
              return <CommandPalette items={items} active={active} onHover={setCmdActive} onPick={pick} />;
            })()
          ) : null
        }
        inputRef={inputRef}
        highlight={renderHighlightSpans(input)}
        onInputClick={onInputClick}
        onDropFile={(rel) => {
          // G14.144 拖入文件 → caret 处插 @文件名(短写,账本解析;G14.211 原 @全相对路径过长)
          const ta = inputRef.current;
          const pos = ta?.selectionStart ?? input.length;
          const base = rel.split(/[\\/]/).pop() ?? rel;
          pickRelRef.current.set(base, rel);
          setInput((prev) => prev.slice(0, pos) + `@${base} ` + prev.slice(pos));
          inputRef.current?.focus();
          // G14.211 光标钉在插入 token 之后(同 onPick:旧光标位恢复=token 中间)
          requestAnimationFrame(() => {
            const ta2 = inputRef.current;
            if (ta2 === null) return;
            const to = Math.min(pos + base.length + 2, ta2.value.length);
            ta2.setSelectionRange(to, to);
          });
        }}
        footLeft={
          <div className="composer-pills">
            {/* 与欢迎页同构(G12 三轮):+ 开附加面板(卡顶同宽浮层:命令/技能/文件) */}
            <button
              type="button"
              className="composer-pill composer-plus-btn"
              aria-label="add attachment"
              aria-expanded={pillOpen === 'plus'}
              data-tip={t('Add skills, commands or files', '添加技能、命令或文件')}
              onClick={() => setPillOpen((v) => (v === 'plus' ? null : 'plus'))}
            >
              +
            </button>
            {/* 审批模式:弹层锚按钮正上方(pill-anchor) */}
            <div className="pill-anchor">
              <button
                type="button"
                className="composer-pill"
                aria-label="session mode"
                aria-expanded={pillOpen === 'mode'}
                onClick={() => setPillOpen((v) => (v === 'mode' ? null : 'mode'))}
              >
                <ModeIcon mode={sessMode} />
                <span className="pill-label">{sessMode === 'plan' ? t('Plan mode', '计划模式') : sessMode === 'manual' ? t('Confirm changes', '变更确认') : t('Full access', '完全访问')}</span>
                <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
              {pillOpen === 'mode' && (
                <div className="sx-menu-pop pill-pop mode-pop" role="menu" aria-label="session mode menu">
                  {([
                    { m: 'plan' as const, label: t('Plan mode', '计划模式'), desc: t('Plan first — no changes until you approve', '先规划方案,经你确认后才执行'), icon: <ListTodo size={15} strokeWidth={1.75} aria-hidden="true" /> },
                    { m: 'dontAsk' as const, label: t('Full access', '完全访问'), desc: t('Full permissions — no confirmation prompts', '完全权限,操作不再逐一确认'), icon: <Unlock size={15} strokeWidth={1.75} aria-hidden="true" /> },
                    { m: 'manual' as const, label: t('Confirm changes', '变更确认'), desc: t('Writes and commands ask first', '写入与命令需逐一确认'), icon: <ShieldCheck size={15} strokeWidth={1.75} aria-hidden="true" /> },
                  ]).map((row, idx) => (
                    <div key={row.m} className="mode-pop-group">
                      {idx === 1 && <div className="mode-pop-sep" />}
                      <button
                        type="button"
                        role="menuitem"
                        className={`mode-item${sessMode === row.m ? ' active' : ''}`}
                        onClick={() => {
                          setPillOpen(null);
                          setSessMode(row.m);
                          conn.setSessionMode(sessionId, row.m).catch(() => {});
                        }}
                      >
                        <span className="mode-item-icon">{row.icon}</span>
                        <span className="mode-item-body">
                          <span className="mode-item-name">{row.label}</span>
                          <span className="mode-item-desc">{row.desc}</span>
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        }
        footRight={
          <div className="composer-pills composer-pills-right">
            {/* G14.18 上下文圆环:模型 pill 左侧,hover 弹上下文占用/构成明细/轮次步数/tokens/缓存 */}
            <ContextRing
              used={ctxInfo?.total ?? 0}
              window={ctxInfo?.window ?? 0}
              parts={ctxInfo?.parts ?? []}
              runs={runCount}
              steps={chat.steps}
              tokens={chat.tokens}
              cacheTokens={chat.cacheTokens}
              onOpen={refreshCtx}
            />
            {/* 模型 pill:显示实际模型名(剥 provider 前缀);菜单=模型列表+思考强度,锚按钮正上方,
                选中不收口(一连选模型+强度,外点/再点收) */}
            <div className="pill-anchor">
              <button
                type="button"
                className="composer-pill"
                aria-label="session model"
                aria-expanded={pillOpen === 'model'}
                onClick={() => setPillOpen((v) => (v === 'model' ? null : 'model'))}
              >
                <span className="pill-label">{baseModelName(modelInfo?.current)}</span>
                {/* 思考强度随名(G13 反馈轮):`模型 · effort` 同 pill,Codex 同形 */}
                <EffortChip effort={sessEffort ?? 'medium'} />
                <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
              {pillOpen === 'model' && (
                <div className="sx-menu-pop pill-pop pill-pop-right pill-pop-tall" role="menu" aria-label="session model menu">
                  {(modelInfo?.choices ?? []).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="menuitem"
                      className="sx-menuitem"
                      disabled={c.id === modelInfo?.current}
                      data-tip={c.id}
                      onClick={() => {
                        setModelInfo((m) => (m === null ? m : { ...m, current: c.id }));
                        // 源自带档位强度(G13 反馈轮):切换即随名展示(快照回显前先乐观落)
                        if (c.effort !== undefined) setSessEffort(c.effort);
                        conn.setSessionModel(sessionId, c.id).catch(() => {});
                      }}
                    >
                      {baseModelName(c.id)}
                    </button>
                  ))}
                  {/* G14.14:强度滑块与欢迎页同一渲染(EffortSlider 共享) */}
                  <EffortSlider
                    value={sessEffort ?? 'medium'}
                    onChange={(ev) => {
                      setSessEffort(ev);
                      conn.setSessionEffort(sessionId, ev).catch(() => {});
                    }}
                  />
                </div>
              )}
            </div>
            {/* G14.89 运行中输入框有内容 → 显示发送(入队)而非停止;空输入才是停止 */}
            {running && input.trim() === '' ? (
              <button type="button" className="send" aria-label="stop" data-tip={t('Stop', '停止')} onClick={interrupt}>
                <Square size={12} strokeWidth={2.5} aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="send tip-right"
                aria-label="send"
                data-tip={t('Send', '发送')}
                onClick={send}
                disabled={connState !== 'open' || seeding}
              >
                <ArrowUp size={16} strokeWidth={2.25} aria-hidden="true" />
              </button>
            )}
          </div>
          }
        />
        )
        }
      </div>
    </>
  );
}
