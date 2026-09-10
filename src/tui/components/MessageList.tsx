import * as React from 'react';
import { Box, Text } from 'ink';
import { ChatItem, LiveBlock } from '../session';
import { bandLines } from '../text-band';
import { ToolRow } from './ToolRow';
import { MarkdownText } from './MarkdownText';

/** 消息区：用户整行底色带（无标签）/ 助手 Markdown 排版 / 工具两行 / 思考折叠行 / 系统 ! 行 / 计划步骤行 + 实时区 */
export function MessageList({ messages, live, columns, expandAll }: { messages: ChatItem[]; live?: LiveBlock; columns: number; expandAll: boolean }): JSX.Element {
  if (messages.length === 0 && !live) {
    return <Text dimColor>SunshineX TUI — 输入任务或 /help 查看命令</Text>;
  }
  return (
    <Box flexDirection="column">
      {messages.map((m, i) => (
        <Box key={i} marginBottom={1}>
          <MessageRow item={m} columns={columns} expandAll={expandAll} />
        </Box>
      ))}
      {live ? <LiveArea live={live} columns={columns} /> : null}
    </Box>
  );
}

function MessageRow({ item, columns, expandAll }: { item: ChatItem; columns: number; expandAll: boolean }): JSX.Element {
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
}

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

/** 实时区：答复草稿走 Markdown 排版（未闭合块由解析器降级）；思考滚动只显示末尾 6 行（避免长思考撑爆视口） */
function LiveArea({ live, columns }: { live: LiveBlock; columns: number }): JSX.Element {
  if (live.kind === 'reply') return <MarkdownText text={live.text} columns={columns} />;
  const tail = live.text.split('\n').slice(-6).map((l) => `✻ ${l}`).join('\n');
  return <Text dimColor italic>{tail}</Text>;
}
