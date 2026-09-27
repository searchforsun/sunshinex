import * as React from 'react';
import { Box, Text } from 'ink';
import { ChildLiveState } from '../session';
import { elideByWidth } from '../text-band';
import { formatTokens, formatDuration } from '../format';
import { Spinner } from './Spinner';
import { theme } from '../theme';

/** 子代理并行面板（动态区，输入框下侧，CC 式）：每个运行中子 agent 一行（规格 §3.1）——运行态信息由单行承载，
 *  完整转录经全屏查看视图（ChildInspector）查看；外层特殊边框（圆角主题主色，2026-09-27 用户裁决对标 CC）：
 *  与主链活动行视觉分域，派发批一眼可辨。完成态不进面板（2026-09-28 用户裁决：动态区只显运行中、无两页/计数行），
 *  归档即从面板离场折进历史区 SPAWN 行 detail，Ctrl+B 浏览器直接浏览全部已完成。空态渲染零占位帧 */
export function ChildPanel({ childrenState, columns, selectedLabel }: { childrenState: ChildLiveState[]; columns: number; selectedLabel?: string }): JSX.Element {
  // 只承载运行中（2026-09-28 用户裁决）：完成行与计数概览行一律不进动态区，全部完成即面板整体消失
  const rows = childrenState.filter((c) => !c.done);
  if (rows.length === 0) return <Box />;
  const width = Math.max(8, columns - 4);
  const glyph = '✻';
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
    >
      {rows.map((c) => (
        // 浏览模式选中行反色高亮：ink3 Box 样式面无 backgroundColor（Text 专属），各分支在 Text 上承载；
        // ↑↓ 移动即见选中项；选中态子段去 dim 保对比（灰底叠暗灰不可读，2026-09-28 用户裁决）
        <Box key={c.label}>
          {(c.calls ?? []).length > 0 ? (
            // 工具活动行（规格 §4.2 面板增强，与主链 taskState 口径对齐）：显示当前调用名+单调用耗时，
            // 轮换动词是「思考中」的语义、模型正在干活时退回动词即信息量倒挂；选中态反色经 Text backgroundColor 承载
            <Text backgroundColor={selectedLabel === c.label ? 'gray' : undefined} color={theme.accent} dimColor={selectedLabel !== c.label}>
              {glyph} [{c.label}]{' '}
              <Text dimColor={selectedLabel !== c.label}>
                {(c.calls ?? []).map((call, i) => (
                  <Text key={call.callId}>
                    {i > 0 ? ' · ' : ''}[{elideByWidth(call.target, Math.max(8, Math.floor((width - 10) / (c.calls ?? []).length)))}]{' '}
                    {formatDuration(Math.max(0, Math.round((Date.now() - call.startedAt) / 1000)))}
                  </Text>
                ))}
                {' · '}↑{formatTokens(c.tokens)} tokens
              </Text>
            </Text>
          ) : (
            // Spinner 分支（思考中子代理）：反色经包裹 Text 承载（ink3 Box 样式面无 backgroundColor）
            <Text backgroundColor={selectedLabel === c.label ? 'gray' : undefined}>
              <Spinner startedAt={c.startedAt} tokens={c.tokens} label={c.label} steps={c.steps} columns={columns} selected={selectedLabel === c.label} />
            </Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
