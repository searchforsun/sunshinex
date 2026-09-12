import * as React from 'react';
import { Box, Text } from 'ink';
import { ChatItem } from '../session';
import { bandLines } from '../text-band';

/**
 * 工具行：调用行 ⏺ [VERB] target（工具名高亮）；结果行 ⎿ ✓/✗。
 * 默认折叠为单行摘要（首行 + 剩余行数 + Tab 翻阅提示）——执行细节不刷屏，全文经历史翻阅展开；
 * 仅翻阅视口选中轮渲染完整 observation（marker 行不重复 200 字摘要前缀）。
 * detail 缺失时 text 即全部内容（≤200 字摘要），无折叠必要、直接展示。
 */
export function ToolRow({ item, columns, collapsed, hint = 'Tab 翻阅' }: { item: ChatItem; columns: number; collapsed: boolean; hint?: string }): JSX.Element {
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
  const body = item.detail ?? item.text;
  const lines = body.split('\n');
  if (collapsed && item.detail) {
    // 行宽预算：前缀「  ⎿ ✓ 」6 列 + 尾缀提示「…（+N 行 · Tab 翻阅）」约 22–24 列，
    // 总长须 ≤ 终端列宽，否则 ink 折行把提示串截成两段
    const budget = Math.max(16, columns - 32);
    const first = bandLines(lines[0], budget)[0];
    const clipped = first !== lines[0];
    const more = lines.length - 1 + (clipped ? 1 : 0);
    return (
      <Text color={item.ok ? 'green' : 'red'}>
        {'  ⎿ '}
        {item.ok ? '✓' : '✗'}
        {` ${first}${clipped ? '…' : ''}`}
        {more > 0 ? <Text dimColor>（+{more} 行 · {hint}）</Text> : null}
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      <Text color={item.ok ? 'green' : 'red'}>
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
