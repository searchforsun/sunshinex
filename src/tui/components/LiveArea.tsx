import { Box, Text } from 'ink';
import { LiveBlock } from '../session';
import { wrapByWidth } from '../text-band';

/** 思考流滚动固定行数：块高恒定，增量到达时不再上下跳动（对标 Claude Code 思考滚动区） */
const THINK_TAIL_LINES = 6;

/**
 * 动态实时区（2026-09-30 markdansi 替换批次后仅承载思考流）：思考流滚动显示末 6 行
 * （按显示宽度折行取尾、不足补空行）——过程活性反馈，收束后折叠为摘要行。
 * 正文流式（reply）已改走 markdansi 流式通道——片段即时入档为 ansi 条目（历史区 Static 呈现）、
 * 未完结构尾段由 MessageList 的 MdBufferPreview 原文预览；旧 reply 预览窗
 * （tailReplyPreview 尾部窗口/包络 pad/committedLen 水位）随自研流式链整体退役，
 * MessageList 分流后到达此处的恒为 thinking 块。
 */
export function LiveArea({ live, columns }: { live: LiveBlock; columns: number }): JSX.Element {
  const wrapped = live.text.split('\n').flatMap((seg) => wrapByWidth(seg, Math.max(16, columns - 8)));
  const tail = wrapped.slice(-THINK_TAIL_LINES);
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
