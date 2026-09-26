import * as React from 'react';
import { Box, Text } from 'ink';
import { ChildLiveState } from '../session';
import { elideByWidth } from '../text-band';
import { formatTokens, formatDuration } from '../format';
import { Spinner } from './Spinner';

/** 子代理并行面板（动态区，输入框下侧，CC 式）：每个子 agent 一行（规格 §3.1）——运行态信息由单行承载，
 *  完整转录经全屏查看视图（ChildInspector）查看；单行恒定高度继承原「恒 4 行」防闪烁动机（规格 D5）；
 *  结束后由 session 归档进 spawn 调用行 detail（本组件即消失）。空态渲染零占位帧 */
export function ChildPanel({ childrenState, columns, selectedLabel }: { childrenState: ChildLiveState[]; columns: number; selectedLabel?: string }): JSX.Element {
  if (childrenState.length === 0) return <Box />;
  const width = Math.max(8, columns - 4);
  const glyph = '✻';
  return (
    <Box flexDirection="column">
      {childrenState.map((c) => (
        <Box key={c.label}>
          {c.done ? (
            // 完成态终标行：并行批早完成者即时定格（Spinner 停转），归档锚点在主链 tool-result、与兄弟面板解耦
            <Text backgroundColor={selectedLabel === c.label ? 'gray' : undefined} color="green" dimColor>✓ [{c.label}] done ({c.steps} steps · {formatDuration(Math.max(0, Math.round(((c.doneAt ?? Date.now()) - c.startedAt) / 1000)))} · ↑{formatTokens(c.tokens)} tokens)</Text>
          ) : (c.calls ?? []).length > 0 ? (
            // 工具活动行（规格 §4.2 面板增强，与主链 taskState 口径对齐）：显示当前调用名+单调用耗时，
            // 轮换动词是「思考中」的语义、模型正在干活时退回动词即信息量倒挂
            <Text color="green" dimColor>
              {glyph} [{c.label}]{' '}
              <Text dimColor>
                {(c.calls ?? []).map((call, i) => (
                  <Text key={call.callId}>
                    {i > 0 ? ' · ' : ''}[{elideByWidth(call.verb, Math.max(8, Math.floor((width - 10) / (c.calls ?? []).length)))}]{' '}
                    {formatDuration(Math.max(0, Math.round((Date.now() - call.startedAt) / 1000)))}
                  </Text>
                ))}
                {' · '}↑{formatTokens(c.tokens)} tokens
              </Text>
            </Text>
          ) : (
            <Spinner startedAt={c.startedAt} tokens={c.tokens} label={c.label} steps={c.steps} columns={columns} />
          )}
        </Box>
      ))}
    </Box>
  );
}
