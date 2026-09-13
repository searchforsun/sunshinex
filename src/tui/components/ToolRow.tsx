import * as React from 'react';
import { Box, Text } from 'ink';
import { ChatItem } from '../session';
import { bandLines } from '../text-band';

/**
 * 工具行：调用行 ⏺ [VERB] target（工具名高亮）；结果行 ⎿ ✓/✗。
 * 默认折叠为单行摘要（首行截断）——执行细节不刷屏，全文经 Tab 展开打印查看；
 * Tab 展开打印（会话历史整段入缓冲）时以全展开形态渲染完整 observation。
 * detail 缺失时 text 即全部内容（≤200 字摘要），无折叠必要、直接展示。
 */
export function ToolRow({ item, columns, collapsed }: { item: ChatItem; columns: number; collapsed: boolean }): JSX.Element {
  if (item.kind === 'call') {
    const sp = item.text.indexOf(' ');
    const verb = sp > 0 ? item.text.slice(0, sp) : item.text;
    const target = sp > 0 ? item.text.slice(sp + 1) : '';
    return (
      <Text>
        <Text dimColor>⏺ </Text>
        <Text color="cyan">
          [{verb}]
        </Text>
        {target ? <Text color="gray"> {target}</Text> : null}
      </Text>
    );
  }
  const body = item.detail ?? item.text;
  const lines = body.split('\n');
  if (collapsed && item.detail) {
    // 行宽预算：前缀「  ⎿ ✓ 」6 列，摘要总长 ≤ 终端列宽（截断省略号保留首行内容语义）
    const budget = Math.max(16, columns - 6);
    const first = bandLines(lines[0], budget)[0];
    const clipped = first !== lines[0];
    return (
      <Text dimColor color={item.ok ? 'green' : 'red'}>
        {'  ⎿ '}
        {item.ok ? '✓' : '✗'}
        {` ${first}${clipped ? '…' : ''}`}
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      <Text dimColor color={item.ok ? 'green' : 'red'}>
        {'  ⎿ '}
        {item.ok ? '✓' : '✗'}
      </Text>
      {lines.map((l, i) => (
        <Text key={i} dimColor>
          {'    ' + l}
        </Text>
      ))}
    </Box>
  );
}
