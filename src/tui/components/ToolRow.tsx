import * as React from 'react';
import { Text } from 'ink';
import { ChatItem } from '../session';

/** 工具两行：调用行 ⏺ VERB target（暗灰）；结果行 ⎿ ✓/✗ summary（绿/红） */
export function ToolRow({ item }: { item: ChatItem }): JSX.Element {
  if (item.kind === 'call') {
    return <Text color="gray">⏺ {item.text}</Text>;
  }
  return (
    <Text color={item.ok ? 'green' : 'red'}>
      {'  ⎿ '}
      {item.ok ? '✓' : '✗'} {item.text}
    </Text>
  );
}
