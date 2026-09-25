import * as React from 'react';
import { Box, Text } from 'ink';
import { ChildLine, ChildLiveState } from '../session';
import { formatTokens, formatDuration } from '../format';
import { wrapByWidth } from '../text-band';
import { t } from '../../i18n';

/** 全屏查看视图（规格 §3.3）：运行中实时流式 / 完成态 detail 回看双模式；
 *  整体渲染在动态区（有界=视口高度，取尾适配），主界面历史区 Static 零接触；
 *  头部状态行携带委派 prompt（规格 §4.2），Esc 退出提示常驻 */
export function ChildInspector(props: {
  child?: ChildLiveState;
  archived?: { label: string; lines: string[]; steps?: number; durationMs?: number };
  columns: number;
  rows: number;
}): JSX.Element {
  const { child, archived, columns, rows } = props;
  const label = child?.label ?? archived?.label ?? '';
  const steps = child?.steps ?? archived?.steps;
  const tokens = child?.tokens;
  const secs = child
    ? Math.max(0, Math.round((Date.now() - child.startedAt) / 1000))
    : archived?.durationMs !== undefined
      ? Math.round(archived.durationMs / 1000)
      : undefined;
  const body: { kind: ChildLine['kind']; text: string; ok?: boolean }[] = child
    ? child.transcript.map((l) => ({ ...l }))
    : (archived?.lines ?? []).map((l) =>
        l.startsWith('⎿ ')
          ? { kind: 'result' as const, text: l.slice(2).replace(/^[✓✗] /, ''), ok: !l.startsWith('⎿ ✗') }
          : { kind: 'text' as const, text: l },
      );
  const head =
    `✻ [${label}] ${t('subagent view', '子代理视图')}` +
    `${typeof steps === 'number' ? ` · step ${steps}` : ''}` +
    `${tokens !== undefined ? ` · ↑${formatTokens(tokens)} tokens` : ''}` +
    `${secs !== undefined ? ` · ${formatDuration(secs)}` : ''}` +
    ` · ${t('Esc exit', 'Esc 退出')}`;
  const width = Math.max(8, columns - 2);
  const bodyRows = Math.max(1, rows - 2);
  const wrapped = body.flatMap((l) => wrapByWidth(l.text, width).map((w) => ({ ...l, text: w })));
  const visible = wrapped.slice(-bodyRows);
  return (
    <Box flexDirection="column">
      <Text color="green" dimColor>
        {head}
        {child?.prompt ? `\n⏺ ${t('delegated prompt', '委派提示词')}：${child.prompt}` : ''}
      </Text>
      {visible.map((l, i) =>
        l.kind === 'result' ? (
          <Text key={i} dimColor>
            ⎿ {l.ok === false ? '✗' : '✓'} {l.text}
          </Text>
        ) : (
          <Text key={i}>{l.text}</Text>
        ),
      )}
    </Box>
  );
}
