import * as React from 'react';
import { Box, Text } from 'ink';
import { ChatItem } from '../session';

/** 工具行：调用行 ⏺ [VERB] target（工具名高亮）；结果行 ⎿ ✓/✗ 摘要，可展开 detail 全文 */
export function ToolRow({ item, expandAll }: { item: ChatItem; expandAll: boolean }): JSX.Element {
  if (item.kind === 'call') {
    const sp = item.text.indexOf(' ');
    const verb = sp > 0 ? item.text.slice(0, sp) : item.text;
    const target = sp > 0 ? item.text.slice(sp + 1) : '';
    return (
      <Text>
        <Text color="gray">⏺ </Text>
        <Text color="cyan" bold>[{verb}]</Text>
        {target ? <Text color="gray"> {target}</Text> : null}
      </Text>
    );
  }
  const expanded = expandAll && item.detail !== undefined;
  const detailLines = expanded && item.detail ? item.detail.split('\n') : [];
  return (
    <Box flexDirection="column">
      <Text color={item.ok ? 'green' : 'red'}>
        {'  ⎿ '}
        {item.ok ? '✓' : '✗'} {item.text}
        {!expanded && item.detail !== undefined ? <Text dimColor> [Tab 展开]</Text> : null}
      </Text>
      {expanded
        ? detailLines.map((l, i) => (
            <Text key={i} dimColor>{'    ' + l}</Text>
          ))
        : null}
    </Box>
  );
}
