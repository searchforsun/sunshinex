import * as React from 'react';
import { Text } from 'ink';
import { SessionStatus, StatusMetrics, TodoItem } from '../session';
import { formatTokens } from '../format';

export const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: '空闲',
  running: '运行中',
  'awaiting-approval': '等待审批',
  'awaiting-plan': '待确认计划',
  error: '出错',
};

/** 底部状态栏：本轮 tokens · 耗时 · 模型名 · runs · 上下文命中率 · 待办进度 · 状态词（不重复活动行动画） */
export function StatusBar({ metrics, status, todos, model }: { metrics: StatusMetrics; status: SessionStatus; todos?: TodoItem[]; model?: string }): JSX.Element {
  const done = (todos ?? []).filter((t) => t.done).length;
  const elapsed = metrics.turnStartedAt > 0 ? ((Date.now() - metrics.turnStartedAt) / 1000).toFixed(1) + 's' : '';
  // 缓存命中率：本轮有 usage 时取 prompt 缓存命中真实占比，否则回退会话级统计
  const hitPct = metrics.turnTokens > 0 ? Math.round((metrics.turnCacheTokens / metrics.turnTokens) * 100) : Math.round(metrics.hitRate * 100);
  return (
    <Text dimColor>
      {' '}↑{formatTokens(metrics.turnTokens)} tokens
      {elapsed ? ` · ${elapsed}` : ''}
      {model ? ` · model ${model}` : ''}
      {' · runs '}{metrics.runs} · 缓存 {hitPct}%
      {todos && todos.length > 0 ? ` · 待办 ${done}/${todos.length}` : ''} · {STATUS_LABEL[status]}
    </Text>
  );
}
