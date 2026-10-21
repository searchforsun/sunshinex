import { useEffect, useMemo, useRef } from 'react';
import type { TaskBoardState } from '../../projection';
import type { ChatEntry, ChatState } from '../../chat-reducer';
import type { TodoBatch } from './ToolEntry';

/** 派生投影面(D32 第六批批F-4 自 Chat.tsx 平移):任务名映射(G14.172)/待办批次
 *  (G14.174 重建+同清单合并)/关联轮次输入/顶栏动态计数/上抛去重 effects。全部纯投影,
 *  经 deps 注入 chat/board 与上抛回调;P11 T7 字段单源——工具条 name/input 直读内核条目
 *  (工具 input 旁路暂存与 md 首行解析双通道退役)。 */

/** G14.172 任务名映射(转录自建):create_task 回执 `task tN created` → 标题——板投影是内存态
 *  (daemon 重启即空),历史会话的任务名只能从转录回执重建;task-tN 台账业务段一并入表。
 *  P11 T7:标题直读 entry.input(name/input 内核字段全量随档);P11 T8:任务 id 取 result
 *  回执文本(text 优先,full 兜底)——tool md 恒空,回执不再落 md。
 *  G14.2xx b:抽纯函数单点——主对话 hook 与子代理转录页(activities.chat.entries)同源消费 */
function taskTitleMapOf(entries: readonly ChatEntry[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of entries) {
    if (e.kind !== 'tool' || e.name !== 'create_task') continue;
    const input = e.input ?? {};
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const created = /task (\S+) created/.exec(e.result?.text ?? e.result?.full ?? '');
    if (title !== '' && created !== null) {
      m.set(created[1]!, title);
      m.set(`task-${created[1]!}`, title);
    }
  }
  return m;
}

/** G14.172 任务 id → 展示名单点:board 直查 → 转录映射(剥台账时间戳尾/剥 task- 前缀两级) → 短 id 兜底
 *  ——用户裁决「等待任务显示任务名称,不要用 id」。
 *  G14.2xx b:纯函数单点(依赖入参 entries+board),主对话 hook 与子代理转录页同源 */
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

export interface ChatDerivedDeps {
  readonly chat: ChatState;
  readonly board?: TaskBoardState;
  readonly onTodoBatches?: (batches: TodoBatch[]) => void;
  readonly onTurnGoal?: (goal: string) => void;
}

/** 用户气泡 md → 单行纯文本:剥引用前缀与链接标记(待办批次 goal 与关联轮次 turnGoal 共用单点) */
const stripGoal = (md: string): string => md.replace(/^>\s?/, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();

export function useChatDerived(deps: ChatDerivedDeps): {
  taskNameOf: (id: string) => string;
  todoBatches: TodoBatch[];
  turnGoal: string;
  todoActive: number;
  taskActive: number;
} {
  const { chat, board, onTodoBatches, onTurnGoal } = deps;
  const taskNameOf = useMemo(() => taskNameResolverOf(chat.entries, board), [chat.entries, board]);
  /** G14.174 待办批次(每批 todo_write 一卡):时间 + 关联轮次用户输入 + 条目快照——
   *  从转录行重建(种子回放/live 两路同源),经 onTodoBatches 上抛供「待办」页签。
   *  P11 T7 字段单源:清单直读 entry.input.todos(内核条目 name/input 全量随档,旁路/md
   *  两路解析退役——live 流式面待办批次与种子回放同源不再有缺平面) */
  const todoBatches = useMemo<TodoBatch[]>(() => {
    const out: TodoBatch[] = [];
    let lastGoal = '';
    for (const e of chat.entries) {
      if (e.kind === 'user') lastGoal = stripGoal(e.md);
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
  }, [chat.entries]);

  /** G14.177 顶栏动态计数:待办=末批(最新)未完成条目;任务板=pending+claimed 任务 */
  const todoActive = todoBatches.length > 0 ? todoBatches[todoBatches.length - 1]!.items.filter((x) => x.status !== 'completed').length : 0;
  const taskActive = board !== undefined ? Object.values(board.tasks).filter((x) => x.status === 'pending' || x.status === 'claimed').length : 0;
  /** G14.174 关联轮次用户输入(最近一条 user 行;md 链接折叠为标签文本——goal 供单行省略头) */
  const turnGoal = useMemo(() => {
    for (let i = chat.entries.length - 1; i >= 0; i -= 1) {
      const e = chat.entries[i]!;
      if (e.kind === 'user') return stripGoal(e.md);
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
  return { taskNameOf, todoBatches, turnGoal, todoActive, taskActive };
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
