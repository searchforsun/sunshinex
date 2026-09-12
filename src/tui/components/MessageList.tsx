import * as React from 'react';
import { Box, Text } from 'ink';
import { ChatItem, LiveBlock } from '../session';
import { bandLines } from '../text-band';
import { ToolRow } from './ToolRow';
import { MarkdownText } from './MarkdownText';

/** 视口渲染预算：ink3 逐帧全量重绘，帧高超过终端高度时会在滚动缓冲残留重复行——历史不删，仅当前视口渲染最近消息 */
const MAX_RENDERED_MESSAGES = 30;
/** 思考实时滚动固定行数：块高恒定，增量到达时不再上下跳动 */
const THINK_TAIL_LINES = 6;

/** 消息区：用户整行底色带（无标签）/ 助手 Markdown 排版 / 工具两行 / 思考折叠行 / 系统 ! 行 / 计划步骤行 + 实时区 */
export function MessageList({ messages, live, columns, expandAll }: { messages: ChatItem[]; live?: LiveBlock; columns: number; expandAll: boolean }): JSX.Element {
  if (messages.length === 0 && !live) {
    return <Text dimColor>SunshineX TUI — 输入任务或 /help 查看命令</Text>;
  }
  const overflow = Math.max(0, messages.length - MAX_RENDERED_MESSAGES);
  const shown = overflow > 0 ? messages.slice(-MAX_RENDERED_MESSAGES) : messages;
  return (
    <Box flexDirection="column">
      {overflow > 0 ? <Text dimColor>… 已滚出最早 {overflow} 条（仅视口渲染，历史保留）</Text> : null}
      {shown.map((m, i) => (
        <Box key={`${m.ts}-${i}`} marginBottom={1}>
          <MessageRow item={m} columns={columns} expandAll={expandAll} />
        </Box>
      ))}
      {live ? <LiveArea live={live} columns={columns} /> : null}
    </Box>
  );
}

/** 行级 memo：高频增量帧只重渲染受影响的行（messages append-only，item 引用稳定） */
const MessageRow = React.memo(function MessageRow({ item, columns, expandAll }: { item: ChatItem; columns: number; expandAll: boolean }): JSX.Element {
  if (item.role === 'user') {
    return (
      <Box flexDirection="column">
        {bandLines(item.text, columns).map((line, i) => (
          <Text key={i} backgroundColor="gray">{line}</Text>
        ))}
      </Box>
    );
  }
  if (item.role === 'assistant') return <MarkdownText text={item.text} columns={columns} />;
  if (item.role === 'system') return <Text color="yellow">! {item.text}</Text>;
  if (item.role === 'thinking') return <ThinkingRow item={item} expandAll={expandAll} />;
  if (item.role === 'step') return <Text color="cyan">▶ {item.text}</Text>;
  return <ToolRow item={item} expandAll={expandAll} />;
});

/** 思考行：折叠态 ✻ Thought for Ns（可展开全文） */
function ThinkingRow({ item, expandAll }: { item: ChatItem; expandAll: boolean }): JSX.Element {
  if (expandAll && item.detail) {
    return (
      <Box flexDirection="column">
        <Text dimColor italic>✻ {item.text}</Text>
        {item.detail.split('\n').map((l, i) => (
          <Text key={i} dimColor italic>{'    ' + l}</Text>
        ))}
      </Box>
    );
  }
  return (
    <Text dimColor italic>
      ✻ {item.text}
      {item.detail !== undefined ? <Text dimColor> [Tab 展开]</Text> : null}
    </Text>
  );
}

/** 实时区：答复草稿走 Markdown 排版（未闭合块由解析器降级）；思考滚动固定 6 行（不足补空行，块高恒定不跳动） */
function LiveArea({ live, columns }: { live: LiveBlock; columns: number }): JSX.Element {
  if (live.kind === 'reply') return <MarkdownText text={live.text} columns={columns} />;
  const tail = live.text.split('\n').slice(-THINK_TAIL_LINES);
  while (tail.length < THINK_TAIL_LINES) tail.unshift('');
  return (
    <Box flexDirection="column">
      {tail.map((l, i) => (
        <Text key={i} dimColor italic>{l.length > 0 ? `✻ ${l}` : ' '}</Text>
      ))}
    </Box>
  );
}
