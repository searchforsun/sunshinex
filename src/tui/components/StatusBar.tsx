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
    'awaiting-question': ['awaiting question', '待回答问询'],
    error: ['error', '出错'],
  };
  const [en, zh] = labels[status];
  return t(en, zh);
}

/** 底部状态栏：本轮 tokens · 上下文占用 · 模型名 · 缓存命中率 · 待办进度 · 状态词（耗时只在活动行显示，不冗余重复） */
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
  // 缓存命中率 = 会话累计 Σcached/Σprompt（一位小数）：跨任务不清零，轮首 miss 只稀释不砸零；零样本 0%（不除零）
  const total = metrics.sessionPromptTokens;
  const cachePct = total > 0 ? ((metrics.sessionCacheTokens / total) * 100).toFixed(1) : '0';
  // 上下文占用 = 估算水位 / 配置窗口；分母缺失（未配置窗口）时百分比无意义，整段不显示
  // 与 cache 段同一口径：零水位显 0、其余一位小数——1M 窗口下整数百分比几乎恒为 0%，看不出真实水位
  const ctxPct = context && context.window > 0 && context.used > 0 ? ((context.used / context.window) * 100).toFixed(1) : '0';
  return (
    <Text dimColor>
      {' '}↑{formatTokens(metrics.turnTokens)} tokens
      {context ? ' · ctx ' + formatTokens(context.used) + '/' + formatTokens(context.window) + ' (' + ctxPct + '%)' : ''}
      {metrics.sessionTurns > 0 ? ` · ${metrics.sessionTurns} turns · ${metrics.sessionSteps} steps` : ''}
      {model ? ` · ${model}` : ''}
      {' · cache '}{cachePct}%
      {todos && todos.length > 0 ? ` · todo ${done}/${todos.length}` : ''} · {statusLabel(status)}
    </Text>
  );
}
