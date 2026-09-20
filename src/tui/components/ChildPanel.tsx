import * as React from 'react';
import { Box, Text } from 'ink';
import { ChildLiveState } from '../session';
import { wrapByWidth } from '../text-band';
import { Spinner } from './Spinner';

const TAIL_LINES = 3;

/** 子代理并行面板（动态区）：运行中实时流式尾，恒定 4 行/面板——动态区高度波动即整帧重排闪烁
 *  （TodoList/表格两先例），tail 轮转只换内容不增减行数（规格 D5）；不足 3 行补空行；
 *  结束后由 session 归档进 spawn 调用行 detail（本组件即消失）。空态渲染零占位帧 */
export function ChildPanel({ childrenState, columns }: { childrenState: ChildLiveState[]; columns: number }): JSX.Element {
  if (childrenState.length === 0) return <Box />;
  const width = Math.max(8, columns - 4);
  return (
    <Box flexDirection="column">
      {childrenState.map((c) => {
        // 尾流折行取尾：长流式行显示最新片段（LiveArea 同款口径，规格 G2）；
        // 空位以空格补足——ink 不渲染空串行，空串补位会塌行破坏「恒 4 行」不变量（规格 D5）
        const wrapped = c.tail.slice(-TAIL_LINES).flatMap((l) => wrapByWidth(l, width));
        const tail = wrapped.slice(-TAIL_LINES);
        const pad = Array.from({ length: TAIL_LINES - tail.length }, () => ' ');
        return (
          <Box key={c.label} flexDirection="column">
            <Spinner startedAt={c.startedAt} tokens={c.tokens} label={c.label} />
            {[...pad, ...tail].map((l, i) => (
              <Text key={i} dimColor>{l}</Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
