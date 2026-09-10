import * as React from 'react';
import { Box, Text } from 'ink';
import { ChatItem, LiveBlock } from '../session';
import { bandLines } from '../text-band';
import { ToolRow } from './ToolRow';

/** 消息区：用户整行底色带（无标签）/ 助手裸文本 / 工具两行 / 思考折叠行 / 系统 ! 行 / 计划步骤行 + 实时区 */
export function MessageList({ messages, live, columns }: { messages: ChatItem[]; live?: LiveBlock; columns: number }): JSX.Element {
  if (messages.length === 0 && !live) {
    return <Text dimColor>SunshineX TUI — 输入任务或 /help 查看命令</Text>;
  }
  return (
    <Box flexDirection="column">
      {messages.map((m, i) => (
        <Box key={i} marginBottom={1}>
          <MessageRow item={m} columns={columns} />
        </Box>
      ))}
      {live ? <LiveArea live={live} /> : null}
    </Box>
  );
}

function MessageRow({ item, columns }: { item: ChatItem; columns: number }): JSX.Element {
  if (item.role === 'user') {
    return (
      <Box flexDirection="column">
        {bandLines(item.text, columns).map((line, i) => (
          <Text key={i} backgroundColor="gray">{line}</Text>
        ))}
      </Box>
    );
  }
  if (item.role === 'assistant') return <Text>{item.text}</Text>;
  if (item.role === 'system') return <Text color="yellow">! {item.text}</Text>;
  if (item.role === 'thinking') return <Text dimColor italic>✻ {item.text}</Text>;
  if (item.role === 'step') return <Text color="cyan">▶ {item.text}</Text>;
  return <ToolRow item={item} />;
}

/** 实时区：答复草稿原样上屏；思考滚动只显示末尾 6 行（避免长思考撑爆视口） */
function LiveArea({ live }: { live: LiveBlock }): JSX.Element {
  if (live.kind === 'reply') return <Text>{live.text}</Text>;
  const tail = live.text.split('\n').slice(-6).map((l) => `✻ ${l}`).join('\n');
  return <Text dimColor italic>{tail}</Text>;
}
