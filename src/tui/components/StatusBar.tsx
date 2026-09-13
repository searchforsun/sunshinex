import { t } from '../../i18n';
import * as React from 'react';
import { Text } from 'ink';
import { SessionStatus, StatusMetrics, TodoItem } from '../session';
import { formatTokens } from '../format';

/** 状态词（运行期求值：语言随 --language 装配后设定，禁止模块级 t() 冻结） */
function statusLabel(status: SessionStatus): string {
  const labels: Record<SessionStatus, [string, string]> = {
    idle: ['idle', '空闲'],
    running: ['running', '运行中'],
    'awaiting-approval': ['awaiting approval', '等待审批'],
    'awaiting-plan': ['awaiting plan', '待确认计划'],
    error: ['error', '出错'],
  };
  const [en, zh] = labels[status];
  return t(en, zh);
}

/** 底部状态栏：本轮 tokens · 上下文占用 · 耗时 · 模型名 · runs · 缓存命中率 · 待办进度 · 状态词（不重复活动行动画） */
export function StatusBar({
  metrics,
  status,
  todos,
  model,
  context,
}: {
  metrics: StatusMetrics;
  status: SessionStatus;
  todos?: TodoItem[];
  model?: string;
  /** 上下文占用水位：used=当前上下文估算 tokens，window=配置窗口（SUNSHINEX_CONTEXT_WINDOW）；未配置不显示该段 */
  context?: { used: number; window: number };
}): JSX.Element {
  const done = (todos ?? []).filter((t) => t.done).length;
  const elapsed = metrics.turnStartedAt > 0 ? ((Date.now() - metrics.turnStartedAt) / 1000).toFixed(1) + 's' : '';
  // 缓存命中率 = cached_tokens / prompt_tokens（分子分母同量纲；分母若混入输出 token 会系统性压低真实命中率），无 prompt 口径时回退会话级统计
  const hitPct = metrics.turnPromptTokens > 0 ? Math.round((metrics.turnCacheTokens / metrics.turnPromptTokens) * 100) : Math.round(metrics.hitRate * 100);
  // 上下文占用 = 估算水位 / 配置窗口；分母缺失（未配置窗口）时百分比无意义，整段不显示
  const ctxPct = context && context.window > 0 ? Math.round((context.used / context.window) * 100) : 0;
  return (
    <Text dimColor>
      {' '}↑{formatTokens(metrics.turnTokens)} tokens
      {context ? ' · ctx ' + formatTokens(context.used) + '/' + formatTokens(context.window) + ' (' + ctxPct + '%)' : ''}
      {elapsed ? ` · ${elapsed}` : ''}
      {model ? ` · model ${model}` : ''}
      {' · cache '}{hitPct}%
      {todos && todos.length > 0 ? ` · todo ${done}/${todos.length}` : ''} · {statusLabel(status)}
    </Text>
  );
}
