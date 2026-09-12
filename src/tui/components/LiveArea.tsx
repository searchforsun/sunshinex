import * as React from 'react';
import { Box, Text } from 'ink';
import { LiveBlock } from '../session';

/** 思考实时滚动固定行数：块高恒定，增量到达时不再上下跳动 */
const THINK_TAIL_LINES = 6;
/** 答复流式预览固定行数：动态区帧高必须有界（超出终端高度即在滚动缓冲烙下重影），完整答复收束后一次性入档 */
const REPLY_PREVIEW_LINES = 8;

/**
 * 动态实时区：答复草稿以纯文本末 N 行预览（Markdown 排版在收束入档时定稿）；
 * 思考滚动固定 6 行（不足补空行，块高恒定不跳动）。
 */
export function LiveArea({ live }: { live: LiveBlock }): JSX.Element {
  if (live.kind === 'reply') {
    const lines = live.text.split('\n');
    const overflow = Math.max(0, lines.length - REPLY_PREVIEW_LINES);
    const tail = lines.slice(-REPLY_PREVIEW_LINES);
    return (
      <Box flexDirection="column">
        {overflow > 0 ? <Text dimColor>… 流式预览末 {REPLY_PREVIEW_LINES} 行（收束后完整入档）</Text> : null}
        {tail.map((l, i) => (
          <Text key={i}>{l}</Text>
        ))}
      </Box>
    );
  }
  const tail = live.text.split('\n').slice(-THINK_TAIL_LINES);
  while (tail.length < THINK_TAIL_LINES) tail.unshift('');
  return (
    <Box flexDirection="column">
      {tail.map((l, i) => (
        <Text key={i} dimColor italic>
          {l.length > 0 ? `✻ ${l}` : ' '}
        </Text>
      ))}
    </Box>
  );
}
