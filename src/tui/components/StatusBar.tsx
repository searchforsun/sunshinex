import { t } from '../../i18n';
import { Text, useStdout } from 'ink';
import { SessionStatus, StatusMetrics } from '../session';
import { ReasoningEffort } from '../../types';
import { formatTokens } from '../format';
import { displayWidth, elideByWidth } from '../text-band';

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

/** 状态栏段降级适配（纯函数，导出供钉测试）：head/tail 恒保留（↑tokens / 状态词），mid 各段自带
 *  ' · ' 前缀、prio 大者先离场；丢尽仍超宽对残余整行硬省略——恒 1 行。
 *  动机（2026-10-02「流式极小闪动」收尾）：状态栏原是裸 Text 自然折行，段多时（ctx+turns+model+
 *  effort+cache+状态词）折到第 2 行即击穿 App previewCap 的 chrome 实账 +1，动态帧触顶 rows 走
 *  ink3 clearTerminal 整屏重放路径（闪屏源）；恒 1 行后实账精确、该路径结构性不可达 */
export function fitStatusLine(
  head: string,
  mids: readonly { text: string; prio: number }[],
  tail: string,
  columns: number,
): string {
  const budget = Math.max(8, columns - 1);
  const kept = mids.map((m) => ({ ...m }));
  const line = (): string => head + kept.map((m) => m.text).join('') + tail;
  // 丢段序 = prio 降序（信息价值最低者先离场）；幸存段保持原渲染序
  const dropOrder = [...kept].sort((a, b) => b.prio - a.prio);
  for (const victim of dropOrder) {
    if (displayWidth(line()) <= budget) break;
    const idx = kept.indexOf(victim);
    if (idx >= 0) kept.splice(idx, 1);
  }
  const out = line();
  return displayWidth(out) <= budget ? out : elideByWidth(out, budget);
}

/** 底部状态栏：tokens · 上下文占用 · 模型名 · 缓存命中率 · 状态词（待办进度由 TodoList 面板单点承载，此处不冗余重复） */
export function StatusBar({
  metrics,
  status,
  model,
  effort,
  context,
}: {
  metrics: StatusMetrics;
  status: SessionStatus;
  model?: string;
  /** 思考强度（/model-effort 会话切换；undefined = 适配器 cfg/env 缺省，该段不显示） */
  effort?: ReasoningEffort;
  /** 上下文占用水位：used=当前上下文估算 tokens，window=配置窗口（SUNSHINEX_CONTEXT_WINDOW）；未配置不显示该段 */
  context?: { used: number; window: number };
}): JSX.Element {
  // 缓存命中率 = 会话累计 Σcached/Σprompt（一位小数）：跨任务不清零，轮首 miss 只稀释不砸零；零样本 0%（不除零）
  const total = metrics.sessionPromptTokens;
  const cachePct = total > 0 ? ((metrics.sessionCacheTokens / total) * 100).toFixed(1) : '0';
  // 上下文占用 = 估算水位 / 配置窗口；分母缺失（未配置窗口）时百分比无意义，整段不显示
  // 与 cache 段同一口径：零水位显 0、其余一位小数——1M 窗口下整数百分比几乎恒为 0%，看不出真实水位
  const ctxPct = context && context.window > 0 && context.used > 0 ? ((context.used / context.window) * 100).toFixed(1) : '0';
  // 恒 1 行装配（fitStatusLine 钉）：prio 大者先丢——effort → model → turns/steps → cache → ctx（ctx 最后丢：溢出护栏信号）
  const columns = useStdout().stdout?.columns ?? 80;
  const line = fitStatusLine(
    ` ↑${formatTokens(metrics.sessionTotalTokens)} tokens`,
    [
      ...(context ? [{ text: ' · ctx ' + formatTokens(context.used) + '/' + formatTokens(context.window) + ' (' + ctxPct + '%)', prio: 1 }] : []),
      ...(metrics.sessionTurns > 0 ? [{ text: ` · ${metrics.sessionTurns} turns · ${metrics.sessionSteps} steps`, prio: 3 }] : []),
      ...(model ? [{ text: ` · ${model}`, prio: 4 }] : []),
      ...(effort ? [{ text: ` · effort ${effort}`, prio: 5 }] : []),
      { text: ` · cache ${cachePct}%`, prio: 2 },
    ],
    ` · ${statusLabel(status)}`,
    columns,
  );
  return (
    <Text dimColor>
      {line}
    </Text>
  );
}
