import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatEntry } from '../../chat-reducer';
import type { ChatProps } from './chat-types';

export type DynBlockKind = 'todo' | 'plan' | 'task' | 'bg';

/**
 * 顶栏动态信息块簇(Chat 外提,D62 批I;2026-11-11 用户裁定「最近两轮中最后生效块」,中断轮额外
 * 回溯一轮):运行中=活值(转圈);收尾时把当前四类计数快照进历史(cap 2,最新在前,中断/跳过轮标记
 * interrupted);每类取「最近的非零值」——运行中优先,否则最近快照;0 不显示。
 * 计划块在轮出现标记(plan-approval 卡在场即置,轮开始清)+ 最近两轮快照(运行→收尾时捕获)。
 * 团队任务「最近一个版」计数(2026-11-11 用户裁定):最近两轮的 run 窗口内按 createdAt 归位,
 * 取最近一个有创建的窗口的任务数(一个版=一次编排创建的一批);捕获面与显示面共用。
 */
export function useChatDynBlocks({ entries, board, todoTotal, todoActive, taskDone, taskRunning, planCardCount, bgRunning, agentTeamsOn, running, sessionId, chatSteps, chatTokens }: {
  entries: ChatEntry[];
  board: ChatProps['board'];
  todoTotal: number;
  todoActive: number;
  taskDone: number;
  taskRunning: boolean;
  planCardCount: number;
  bgRunning: number;
  agentTeamsOn: boolean;
  running: boolean;
  sessionId: string;
  chatSteps: number;
  chatTokens: number;
}): { dynBlocks: Array<{ kind: DynBlockKind; count: number; done: number; state: 'running' | 'done' }>; liveSteps: number; liveTokens: number } {
  // 计划块在轮出现标记(plan-approval 卡在场即置,轮开始清)+ 最近两轮快照(运行→收尾时捕获)
  const sawPlanRef = useRef(false);
  const [runBlocksHistory, setRunBlocksHistory] = useState<Array<{ state: 'done' | 'interrupted'; blocks: Array<{ kind: DynBlockKind; count: number }> }>>([]);
  const sawPlanInRun = sawPlanRef.current ? true : false;
  if (planCardCount > 0) sawPlanRef.current = true;
  // 团队任务「最近一个版」计数(2026-11-11 用户裁定):最近两轮的 run 窗口内按 createdAt 归位,
  // 取最近一个有创建的窗口的任务数(一个版=一次编排创建的一批);捕获面与显示面共用
  const taskCount = useMemo(() => {
    const boardTasks = board !== undefined ? Object.values(board.tasks) : [];
    const runTsList = entries.filter((e) => e.kind === 'run' && (e.ts ?? 0) > 0).map((e) => e.ts!);
    const lastTwo = runTsList.slice(-2);
    for (let i = lastTwo.length - 1; i >= 0; i -= 1) {
      const from = lastTwo[i]!;
      const to = i + 1 < lastTwo.length ? lastTwo[i + 1]! : Number.MAX_SAFE_INTEGER;
      const c = boardTasks.filter((b) => (b.createdAt ?? 0) >= from && (b.createdAt ?? 0) < to).length;
      if (c > 0) return c;
    }
    return 0;
  }, [board, entries]);
  const wasRunningRef = useRef(false);
  const pendingCaptureRef = useRef(false);
  useEffect(() => {
    if (running) {
      if (!wasRunningRef.current) sawPlanRef.current = false; // 新轮开始清计划标记
      wasRunningRef.current = true;
      pendingCaptureRef.current = false;
      return;
    }
    if (wasRunningRef.current) {
      wasRunningRef.current = false;
      // 收尾即挂起捕获:转录空壳(conn 重建快照未回)时等转录到齐的 entries effect 再落
      pendingCaptureRef.current = true;
    }
  }, [running]);
  useEffect(() => {
    if (!pendingCaptureRef.current || running || entries.length === 0 || sessionId === '') return;
    pendingCaptureRef.current = false;
    const lastRun = [...entries].reverse().find((e) => e.kind === 'run');
    const state: 'done' | 'interrupted' = lastRun?.stopped === true ? 'interrupted' : 'done';
    const blocks: Array<{ kind: DynBlockKind; count: number; done?: number }> = [];
    if (todoTotal > 0) blocks.push({ kind: 'todo', count: todoTotal, done: todoTotal - todoActive });
    if (sawPlanRef.current) blocks.push({ kind: 'plan', count: 1, done: 0 });
    if (agentTeamsOn && taskCount > 0) blocks.push({ kind: 'task', count: taskCount, done: taskDone });
    if (blocks.length === 0) return;
    setRunBlocksHistory((h) => [{ state, blocks }, ...h].slice(0, 2)); // 最近两轮
  }, [running, entries, todoTotal, todoActive, taskCount, taskDone, sawPlanInRun, agentTeamsOn, sessionId]);
  // 顶栏动态信息块(2026-11-11 用户裁定「最近两轮中最后生效块」,中断轮额外回溯一轮):
  // 运行中=活值(转圈);收尾时把当前四类计数快照进历史(cap 2,最新在前,中断/跳过轮标记 interrupted);
  // 每类取「最近的非零值」——运行中优先,否则最近快照;0 不显示
  const dynBlocks = useMemo(() => {
    // 数量=完整数量(2026-11-11 用户裁定「4 个待办就一直显示 4 个」:总数不随完成收缩);
    // 待办/团队任务=「最近两轮的最近一个版」:团队任务按 createdAt 落进最近两轮的 run 窗口,
    // 取最近一个有创建的窗口计数(2026-11-11 用户裁定「一个版包裹,比较好区分」);
    // 后台任务特殊(用户裁定「只有运行中才显示,不管两轮」):有在跑的后台任务才显示,数量=在跑数
    const live: Array<{ kind: DynBlockKind; count: number; done: number; running: boolean }> = [];
    // 待办全完成即不转圈(2026-11-11 用户裁定「全部完成显示图标就可以」):运行中且有未完成项才算跑
    if (todoTotal > 0) live.push({ kind: 'todo', count: todoTotal, done: todoTotal - todoActive, running: running && todoActive > 0 });
    if (sawPlanInRun) live.push({ kind: 'plan', count: 1, done: 0, running: planCardCount > 0 });
    if (agentTeamsOn && taskCount > 0) live.push({ kind: 'task', count: taskCount, done: taskDone, running: taskRunning });
    if (bgRunning > 0) live.push({ kind: 'bg', count: bgRunning, done: 0, running: true });
    const byKind = new Map<string, { kind: DynBlockKind; count: number; done: number; state: 'running' | 'done' }>();
    for (const b of live) {
      const prev = byKind.get(b.kind);
      if (prev !== undefined && prev.state === 'running') continue; // 最近值优先,但运行态 sticky(任一快照在跑即算跑)
      byKind.set(b.kind, { kind: b.kind, count: b.count, done: b.done, state: b.running ? 'running' : 'done' });
    }
    return [...byKind.values()];
  }, [running, todoActive, todoTotal, sawPlanInRun, planCardCount, entries, board, taskRunning, bgRunning, agentTeamsOn, runBlocksHistory]);
  const lastLiveRun = running
    ? [...entries].reverse().find((e) => e.kind === 'run' && e.streaming === true)
    : undefined;
  const liveSteps = lastLiveRun?.stepsBase !== undefined ? Math.max(0, chatSteps - lastLiveRun.stepsBase) : chatSteps;
  const liveTokens = lastLiveRun?.tokensBase !== undefined ? Math.max(0, chatTokens - lastLiveRun.tokensBase) : chatTokens;
  return { dynBlocks, liveSteps, liveTokens };
}
