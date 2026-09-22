import { t } from '../../i18n';
import * as React from 'react';
import { Box, Text } from 'ink';
import { TodoItem } from '../session';
import { wrapByWidth } from '../text-band';

/**
 * 待办列表（输入框下侧常驻），两种形态，行数均恒定（不构成动态区高度波动源）：
 * 紧凑（运行中默认）：单行「todo n/N · ▸ 当前进行项」，文字按终端宽截断——勾选推进只改内容不增减行数；
 * 展开（Tab 展开模式或任务收束后）：全量清单逐行 ✓ 已完成（绿）/ ▸ 进行中 / ○ 未开始（暗），行数 = 清单长度 + 1 恒定。
 */
export function TodoList({
  todos,
  expanded,
  columns,
}: {
  todos: TodoItem[];
  expanded: boolean;
  columns: number;
}): JSX.Element | null {
  if (todos.length === 0) return null;
  const done = todos.filter((td) => td.status === 'completed').length;
  const current = todos.find((td) => td.status === 'in_progress') ?? todos.find((td) => td.status === 'pending');
  if (!expanded && current) {
    const prefix = t(`todo ${done}/${todos.length} · ▸ `, `待办 ${done}/${todos.length} · ▸ `);
    const text = wrapByWidth(current.text, Math.max(8, columns - 16))[0] ?? current.text;
    return (
      <Box paddingLeft={1}>
        <Text>{prefix + text}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text dimColor>{t(`todo ${done}/${todos.length}`, `待办 ${done}/${todos.length}`)}</Text>
      {todos.map((item, i) =>
        item.status === 'completed' ? (
          <Text key={i} color="green">  ✓ {item.text}</Text>
        ) : item.status === 'in_progress' ? (
          <Text key={i}>  ▸ {item.text}</Text>
        ) : (
          <Text key={i} dimColor>  ○ {item.text}</Text>
        ),
      )}
    </Box>
  );
}
