import * as React from 'react';
import { Box, Text } from 'ink';
import { LiveBlock } from '../session';
import { bandLines } from '../text-band';

/** 答复流式预览固定行数：动态区帧高必须有界；已入档前缀由 committedLen 排除，预览只呈现生成中的未入档尾段 */
const REPLY_PREVIEW_LINES = 8;

/**
 * 动态实时区：流式正文按安全点切块增量入档（session.flushReply，段落边界优先、围栏不切、超长段兜底），
 * 此处仅预览未入档尾段（末 N 行），Markdown 排版在各块入档时定稿；
 * 思考固定单行末条增量——过程默认折叠，全文经翻阅可见。
 */
export function LiveArea({ live, columns }: { live: LiveBlock; columns: number }): JSX.Element {
  if (live.kind === 'reply') {
    const pending = live.text.slice(live.committedLen ?? 0);
    const lines = pending.split('\n');
    const overflow = Math.max(0, lines.length - REPLY_PREVIEW_LINES);
    const tail = lines.slice(-REPLY_PREVIEW_LINES);
    return (
      <Box flexDirection="column">
        {overflow > 0 ? <Text dimColor>… 上文已入档（滚动缓冲可回看）</Text> : null}
        {tail.map((l, i) => (
          <Text key={i}>{l}</Text>
        ))}
      </Box>
    );
  }
  const lastLine = live.text.split('\n').pop() ?? '';
  const line = bandLines(lastLine, Math.max(16, columns - 8))[0] ?? '';
  return (
    <Text dimColor italic>
      {line.length > 0 ? `✻ ${line}` : '✻ …'}
    </Text>
  );
}
