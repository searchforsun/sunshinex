import { useEffect, useMemo, useRef } from 'react';
import type { BoardTeamRef, TaskBoardState } from '../../projection';
import type { ChatEntry, ChatState } from '../../chat-reducer';
import type { TodoBatch } from './ToolEntry';
import { mergeTodoBatches } from './tool-entry-data';

/** 派生投影面(D32 第六批批F-4 自 Chat.tsx 平移):任务名映射(G14.172)/待办批次
 *  (G14.174 重建+同清单合并)/关联轮次输入/顶栏动态计数/上抛去重 effects。全部纯投影,
 *  经 deps 注入 chat/board 与上抛回调;P11 T7 字段单源——工具条 name/input 直读内核条目
 *  (工具 input 旁路暂存与 md 首行解析双通道退役)。 */

/** G14.172 任务名映射(转录自建):create_agent_team_task 回执 `task tN created` → 标题——板投影是内存态
 *  (daemon 重启即空),历史会话的任务名只能从转录回执重建;task-tN 台账业务段一并入表。
 *  P11 T7:标题直读 entry.input(name/input 内核字段全量随档);P11 T8:任务 id 取 result
 *  回执文本(text 优先,full 兜底)——tool md 恒空,回执不再落 md。
 *  2026-10-25 后台 exec 命令映射:`task <id> started` / 超时转后台 `task <id> (output:` → 完整命令
 *  (input.command)——等待行显完整命令而非命令头标签(用户裁定「不要只显示命令头」)。
 *  G14.2xx b:抽纯函数单点——主对话 hook 与子智能体转录页(activities.chat.entries)同源消费 */
function taskTitleMapOf(entries: readonly ChatEntry[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of entries) {
    if (e.kind !== 'tool' || e.name !== 'create_agent_team_task') continue;
    const input = e.input ?? {};
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const receipt = e.result?.text ?? e.result?.full ?? '';
    // 名优先回执 `task "…" created (id=…)` 取 id=;旧形态 `task <id> created` 兜底
    const created = /id=([^\s);,]+)/.exec(receipt) ?? /task (\S+) created/.exec(receipt);
    if (title !== '' && created !== null) {
      m.set(created[1]!, title);
      m.set(`task-${created[1]!}`, title);
    }
  }
  for (const e of entries) {
    if (e.kind !== 'tool' || e.name !== 'exec') continue;
    // 任务名优先 purpose(2026-11-07 用户裁定「等待行显任务名称而非命令原文」),无则完整命令
    const command = execPurposeOf(e) ?? (typeof e.input?.command === 'string' ? e.input.command.trim().replace(/\s+/g, ' ') : '');
    if (command === '') continue;
    // 回执格式 2026-11-17 根治:裸 id 起头+「started in background/moved to background」(不再冠
    //   task 名词——模型照抄「task <id>」当 taskId 曾致 task_stop INVALID_ARG 误报重试);旧格式
    //   历史档 fallback 保留(旧转录回执仍是 task <id> started 旧形)——解析走 backgroundTaskIdOf 单点
    const taskId = backgroundTaskIdOf(e.result?.text ?? e.result?.full ?? '');
    if (taskId !== undefined) m.set(taskId, command);
  }
  // 后台 spawn:回执 id → 展示名=label ?? agent_id(CJK label 的 id 业务段会塌成
  // ASCII 碎片如「spawn」,短 id 兜底即误显「spawn」——须用转录名盖住)
  for (const e of entries) {
    if (e.kind !== 'tool' || e.name !== 'spawn') continue;
    const name = spawnNameOf(e.input);
    if (name === '') continue;
    const taskId = backgroundTaskIdOf(e.result?.text ?? e.result?.full ?? '');
    if (taskId !== undefined) m.set(taskId, name);
  }
  return m;
}

/** G14.172 任务 id → 展示名单点:board 直查 → 转录映射(剥台账时间戳尾/剥 task- 前缀两级) → 短 id 兜底
 *  ——用户裁决「等待任务显示任务名称,不要用 id」。
 *  G14.2xx b:纯函数单点(依赖入参 entries+board),主对话 hook 与子智能体转录页同源 */
export function taskNameResolverOf(entries: readonly ChatEntry[], board: TaskBoardState | undefined): (id: string) => string {
  const taskTitleMap = taskTitleMapOf(entries);
  return (id: string): string => {
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
  };
}

/** 后台任务 id → 子智能体(2026-11-07 办公模式等待行链接转录页):后台 spawn 回执 `task <id> started`
 *  → {名=label ?? agent_id, prompt};id 探测口径同 taskNameResolverOf(剥台账时间戳尾/task- 前缀) */
/** exec 条目的 purpose(任务名;空白折叠,null/空 → undefined) */
function execPurposeOf(e: ChatEntry): string | undefined {
  const v = e.input?.purpose;
  if (typeof v !== 'string') return undefined;
  const flat = v.trim().replace(/\s+/g, ' ');
  return flat === '' ? undefined : flat;
}

/** 后台回执 → 任务 id 单点（D97 收敛：started/moved 新旧形正则原文件内 4 处且备选分支集已漂移
 *  ——taskAgentResolverOf spawn 腿只认旧形）。统一全谱：新形裸 id 起头（started/moved in|to
 *  background，moved 负向 lookahead 排除旧形首词「command」），旧形历史档 fallback（task <id>
 *  started / command moved…task <id>）——全谱对旧形命中一致，新形即修复漂移面。未命中 undefined */
function backgroundTaskIdOf(receipt: string): string | undefined {
  const hit =
    /^(\S+) started in background/.exec(receipt) ??
    /task (\S+) started/.exec(receipt) ??
    /^(?!command )(\S+) moved to background/.exec(receipt) ??
    /command moved to background after timeout: task (\S+)/.exec(receipt);
  return hit !== null ? hit[1]! : undefined;
}

/** spawn 展示名派生单点（D97：label ?? agent_id trim 空守卫原两份逐字） */
function spawnNameOf(input: { label?: unknown; agent_id?: unknown } | undefined): string {
  const i = input ?? {};
  return (
    (typeof i.label === 'string' && i.label.trim() !== '' ? i.label.trim() : '')
    || (typeof i.agent_id === 'string' && i.agent_id.trim() !== '' ? i.agent_id.trim() : '')
  );
}

/** 等待行可显名的后台任务:子智能体(后台 spawn,可链接转录页)与具名 exec(purpose,纯文本——2026-11-07
 *  后台命令必须命名,办公模式等待行因此可显任务名;无名 exec 仍不显,以免露命令原文) */
type WaitTaskRef = { name: string; prompt?: string; kind?: 'exec' };

export function taskAgentResolverOf(entries: readonly ChatEntry[]): (id: string) => WaitTaskRef | undefined {
  const m = new Map<string, WaitTaskRef>();
  for (const e of entries) {
    if (e.kind !== 'tool' || e.name !== 'exec') continue;
    const name = execPurposeOf(e);
    if (name === undefined) continue;
    const taskId = backgroundTaskIdOf(e.result?.text ?? e.result?.full ?? '');
    if (taskId !== undefined) m.set(taskId, { name, kind: 'exec' });
  }
  for (const e of entries) {
    if (e.kind !== 'tool' || e.name !== 'spawn') continue;
    const input = e.input ?? {};
    const name = spawnNameOf(input);
    const taskId = backgroundTaskIdOf(e.result?.text ?? e.result?.full ?? '');
    if (name === '' || taskId === undefined) continue;
    m.set(taskId, { name, ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}) });
  }
  return (id: string) => {
    const short = id.replace(/-\d{8}T\d{6}Z-[0-9a-z]+$/i, '');
    return m.get(id) ?? m.get(short) ?? m.get(short.replace(/^task-/, ''));
  };
}

/** 队名解析:投影 teams 直查 → 转录 create_agent_team 回执映射 → 原 ref 兜底 */
export function teamNameResolverOf(
  entries: readonly ChatEntry[],
  teams: readonly BoardTeamRef[] | undefined,
): (ref: string) => string {
  const fromReceipt = new Map<string, string>();
  for (const e of entries) {
    if (e.kind !== 'tool' || e.name !== 'create_agent_team') continue;
    const input = e.input ?? {};
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const receipt = e.result?.text ?? e.result?.full ?? '';
    const idHit = /teamId=([^\s);,]+)/.exec(receipt);
    if (name === '') continue;
    if (idHit !== null) fromReceipt.set(idHit[1]!, name);
    fromReceipt.set(name, name);
  }
  return (ref: string): string => {
    if (ref === '') return ref;
    const hit = teams?.find((t) => t.teamId === ref || t.name === ref);
    if (hit !== undefined && hit.name !== '') return hit.name;
    return fromReceipt.get(ref) ?? ref;
  };
}

interface ChatDerivedDeps {
  readonly chat: ChatState;
  readonly board?: TaskBoardState;
  readonly teams?: readonly BoardTeamRef[];
  readonly onTodoBatches?: (batches: TodoBatch[]) => void;
}

/** 电脑控制指示判定面单点在 computer-use-contract(2026-10-27 技术债轮收敛:server 名/动作集与
 *  ToolEntry 图标前缀三方共用,原字面量复制改导入单点);原路径再导出保徽标测试与既有引用零迁移 */
import { isComputerUseControlTool } from './computer-use-contract';
export { isComputerUseControlTool };

export function useChatDerived(deps: ChatDerivedDeps): {
  taskNameOf: (id: string) => string;
  taskAgentOf: (id: string) => { name: string; prompt?: string; kind?: 'exec' } | undefined;
  teamNameOf: (ref: string) => string;
  todoBatches: TodoBatch[];
  /** 会话顶待办条显示闸:最近两个 run 内有 todo_write 才 true（用户裁定「最近两轮有触发改待办就显示」） */
  todoRecent: boolean;
  todoActive: number;
  /** 待办总数(2026-11-11 用户裁定「顶栏数量=完整数量」:末批 items 总数,不随完成收缩) */
  todoTotal: number;
  taskActive: number;
  /** 团队任务总数(同上口径) */
  taskTotal: number;
  /** 团队任务已完成数(顶栏 1/4 口径) */
  taskDone: number;
  /** 任一团队任务运行中 */
  taskRunning: boolean;
  /** 电脑控制徽标:控制类 computer-use 工具条在跑(顶栏「正在控制」判定) */
  computerUseActive: boolean;
} {
  const { chat, board, teams, onTodoBatches } = deps;
  /** P1 派生冻结:依赖改成员集键(structureVersion+seedGen 防重置等值碰撞)——纯内容帧
   *  (token/thinking delta)引用恒定,成员/种子变更才重算(下方 todoBatches 同口径) */
  const taskNameOf = useMemo(() => taskNameResolverOf(chat.entries, board), [chat.structureVersion, chat.seedGen, board]);
  const teamNameOf = useMemo(() => teamNameResolverOf(chat.entries, teams), [chat.structureVersion, chat.seedGen, teams]);
  const taskAgentOf = useMemo(() => taskAgentResolverOf(chat.entries), [chat.structureVersion, chat.seedGen]);
  /** G14.174 待办(2026-11-25 用户裁定「一个待办可以跨多个轮次:给待办一个标题参数,代替用户输入
   *  信息」):转录各批 todo_write 经 mergeTodoBatches 按**标题**归并——同标题跨轮更新=同一待办
   *  (进度推进/措辞改写收敛),不同标题=不同待办;goal/userKey(用户气泡回链)退役。
   *  P11 T7 字段单源:清单直读 entry.input.todos(内核条目 name/input 全量随档) */
  const todoBatches = useMemo<TodoBatch[]>(() => {
    const raw: TodoBatch[] = [];
    for (const e of chat.entries) {
      if (e.kind !== 'tool' || e.name !== 'todo_write') continue;
      const input = e.input ?? {};
      const arr = Array.isArray(input.todos) ? (input.todos as Array<Record<string, unknown>>) : [];
      const items = arr
        .map((o) => ({
          text: String(o?.text ?? ''),
          status: (o?.status === 'completed' ? 'completed' : o?.status === 'in_progress' ? 'in_progress' : 'pending') as TodoBatch['items'][number]['status'],
        }))
        .filter((x) => x.text !== '');
      if (items.length === 0) continue;
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      raw.push({ key: e.key, ts: e.ts ?? 0, updatedTs: e.ts ?? 0, ...(title !== '' ? { title } : {}), items });
    }
    return mergeTodoBatches(raw);
  }, [chat.structureVersion, chat.seedGen]);

  /** 会话顶待办条显示闸（用户裁定「顶部还是最近两轮有触发改待办就显示,显示时机不变」）:
   *  最近一批待办更新落在**最近两个 run** 内才显示——老待办不再常驻顶部;轮次口径=转录 run 条
   *  的序位（视图条目无 seq,取最后两个 run 的数组起点作闸）。 */
  const todoRecent = useMemo<boolean>(() => {
    const entries = chat.entries;
    let lastRunIdx = -1;
    let secondLastRunIdx = -1;
    for (let i = 0; i < entries.length; i += 1) {
      if (entries[i]!.kind === 'run') {
        secondLastRunIdx = lastRunIdx;
        lastRunIdx = i;
      }
    }
    if (lastRunIdx < 0) return false;
    const gate = secondLastRunIdx >= 0 ? secondLastRunIdx : lastRunIdx;
    return entries.slice(gate).some((e) => e.kind === 'tool' && e.name === 'todo_write');
  }, [chat.structureVersion, chat.seedGen]);

  /** 顶栏动态计数:待办=末批未完成条目;任务板=pending+running */
  const todoActive = todoBatches.length > 0 ? todoBatches[todoBatches.length - 1]!.items.filter((x) => x.status !== 'completed').length : 0;
  const todoTotal = todoBatches.length > 0 ? todoBatches[todoBatches.length - 1]!.items.length : 0;
  const boardTasks = board !== undefined ? Object.values(board.tasks) : [];
  const taskActive = boardTasks.filter((x) => x.status === 'pending' || x.status === 'running').length;
  const taskTotal = boardTasks.length;
  const taskRunning = boardTasks.some((x) => x.status === 'running');
  const taskDone = boardTasks.filter((x) => x.status === 'success').length;

  /** 电脑控制徽标(2026-10-27):运行轮内存在未收口的控制类 computer-use 工具条(pending/running)
   *  ——running 门使轮收束即隐(异常中断遗留的未决条不长久驻留);冻结键沿派生面同口径
   *  (成员/收口配对才重算,pending→running 翻转不改变判定结果) */
  const computerUseActive = useMemo(
    () =>
      chat.status === 'running' &&
      chat.entries.some((e) => e.kind === 'tool' && (e.status === 'pending' || e.status === 'running') && isComputerUseControlTool(e.name)),
    [chat.status, chat.structureVersion, chat.seedGen],
  );

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
  return { taskNameOf, taskAgentOf, teamNameOf, todoBatches, todoRecent, todoActive, todoTotal, taskActive, taskTotal, taskDone, taskRunning, computerUseActive };
}

/** §6 末条投影:各 run 段的末条 assistant 挂操作条。注意 run 条目在该段活动之前(reducer
 *  model-start 先插 run 条,token/thinking/tool 随后)——元数据向前取:run 边界收口时把上一段
 *  末条 sealed assistant 配给其前最近的已封段 run;流尾 assistant 且 status=idle 亦挂(防御面,
 *  种子历史无 run 条,元数据缺省省略)。
 *  memo 纪律(终审):仅各段末条携带 footerRun(条目引用——reducer 保条目引用,跨 token 帧恒稳定),
 *  其余条目 footerRun=undefined 恒稳定——流式零额外重渲染(传元素每帧新建击穿 memo,已废) */
export function runFooterMapOf(entries: ChatEntry[], status: ChatState['status']): ReadonlyMap<string, ChatEntry> {
  const runFooterByEntry = new Map<string, ChatEntry>();
  let lastSealedAssistant: ChatEntry | null = null;
  let pendingRun: ChatEntry | null = null;
  for (const e of entries) {
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
    else if (status === 'idle') runFooterByEntry.set(lastSealedAssistant.key, lastSealedAssistant);
  }
  return runFooterByEntry;
}

/** 2026-10-26 滚动卡点修复:runFooter 投影的引用稳定化——流式帧每帧换 entries,逐渲染 new Map 令
 *  组级 memo 比较器恒失配(整个可见窗 600 条每帧全重建);此包装在键值对浅等时复用旧 Map(条目
 *  引用由 reducer 保稳定,浅等=语义等值),配对真变(段收口/封条)才换身份。O(map) 每帧,可忽略 */
export function runFooterMapOfStable(prev: ReadonlyMap<string, ChatEntry>, entries: ChatEntry[], status: ChatState['status']): ReadonlyMap<string, ChatEntry> {
  const next = runFooterMapOf(entries, status);
  if (prev.size !== next.size) return next;
  for (const [k, v] of next) if (prev.get(k) !== v) return next;
  return prev;
}
