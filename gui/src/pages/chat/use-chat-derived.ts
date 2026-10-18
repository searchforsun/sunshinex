import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { TaskBoardState } from '../../projection';
import type { ChatEntry, ChatState } from '../../chat-reducer';
import { toolMdInfo } from './ToolEntry';
import type { TodoBatch } from './ToolEntry';
import type { ToolCallInfo } from '../Chat';

/** 派生投影面(D32 第六批批F-4 自 Chat.tsx 平移,行为零变化):任务名映射(G14.172)/待办批次
 *  (G14.174 重建+同清单合并)/关联轮次输入/顶栏动态计数/上抛去重 effects。全部纯投影,
 *  经 deps 注入 chat/toolInputs/board 与上抛回调。 */
export interface ChatDerivedDeps {
  readonly chat: ChatState;
  readonly toolInputs: Record<string, ToolCallInfo>;
  readonly board?: TaskBoardState;
  readonly onTodoBatches?: (batches: TodoBatch[]) => void;
  readonly onTurnGoal?: (goal: string) => void;
}

export function useChatDerived(deps: ChatDerivedDeps): {
  taskNameOf: (id: string) => string;
  todoBatches: TodoBatch[];
  turnGoal: string;
  todoActive: number;
  taskActive: number;
} {
  const { chat, toolInputs, board, onTodoBatches, onTurnGoal } = deps;
  // G6 工具条目 → input 配对(P4:callId 直挂条目,旧 key 编码解码退役);旁路缺失时内核字段合成
  // (快照 name/input/result 全量随档——种子/重放条两路解析 info 而非退 md,旧档 md 裸行同活)
  const toolInfoOf = (entry: ChatEntry): ToolCallInfo | undefined => {
    const cid = entry.callId;
    const live = cid !== undefined && cid.length > 0 ? toolInputs[cid] : undefined;
    if (live !== undefined) return live;
    if (entry.input === undefined) return undefined;
    return {
      name: entry.name ?? '',
      input: entry.input,
      result: entry.result !== undefined ? (entry.result.full ?? entry.result.text) : '',
    };
  };
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
