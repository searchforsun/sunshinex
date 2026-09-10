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

/** 底部状态栏：本轮 tokens · runs · 上下文命中率 · 待办进度 · 状态词（不重复活动行动画） */
export function StatusBar({ metrics, status, todos }: { metrics: StatusMetrics; status: SessionStatus; todos?: TodoItem[] }): JSX.Element {
  const done = (todos ?? []).filter((t) => t.done).length;
  return (
    <Text dimColor>
      {' '}↑{formatTokens(metrics.turnTokens)} tokens · runs {metrics.runs} · ctx 命中率 {Math.round(metrics.hitRate * 100)}%
      {todos && todos.length > 0 ? ` · 待办 ${done}/${todos.length}` : ''} · {STATUS_LABEL[status]}
    </Text>
  );
}
