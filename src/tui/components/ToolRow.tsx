import * as React from 'react';
import { Box, Text } from 'ink';
import { ChatItem } from '../session';

/**
 * 工具行：调用行 ⏺ [VERB] target（工具名高亮）；结果行 ⎿ ✓/✗。
 * 展开（实时/历史/翻阅选中）态直接展示完整 observation，摘要不重复上屏；
 * 仅翻阅视口折叠块显示摘要与 [Tab 展开] 提示。
 */
export function ToolRow({ item, collapsed }: { item: ChatItem; collapsed: boolean }): JSX.Element {
  if (item.kind === 'call') {
    const sp = item.text.indexOf(' ');
    const verb = sp > 0 ? item.text.slice(0, sp) : item.text;
    const target = sp > 0 ? item.text.slice(sp + 1) : '';
    return (
      <Text>
        <Text color="gray">⏺ </Text>
        <Text color="cyan" bold>
          [{verb}]
        </Text>
        {target ? <Text color="gray"> {target}</Text> : null}
      </Text>
    );
  }
  const hasDetail = item.detail !== undefined;
  const expanded = !collapsed && hasDetail;
  return (
    <Box flexDirection="column">
      <Text color={item.ok ? 'green' : 'red'}>
        {'  ⎿ '}
        {item.ok ? '✓' : '✗'}
        {expanded ? '' : ` ${item.text}`}
        {collapsed && hasDetail ? <Text dimColor> [Tab 展开]</Text> : null}
      </Text>
      {expanded && item.detail
        ? item.detail.split('\n').map((l, i) => (
            <Text key={i} dimColor>
              {'    ' + l}
            </Text>
          ))
        : null}
    </Box>
  );
}
