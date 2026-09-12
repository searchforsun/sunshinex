import * as React from 'react';
import { Box, Text } from 'ink';
import { TodoItem } from '../session';

/** 待办列表（输入框下侧常驻）：/plan 确认后逐项执行实时勾选——✓ 已完成 / ▸ 进行中 */
export function TodoList({ todos }: { todos: TodoItem[] }): JSX.Element | null {
  if (todos.length === 0) return null;
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text dimColor>待办 {todos.filter((t) => t.done).length}/{todos.length}</Text>
      {todos.map((t, i) =>
        t.done ? (
          <Text key={i} color="green">  ✓ {t.text}</Text>
        ) : (
          <Text key={i}>  ▸ {t.text}</Text>
        ),
      )}
    </Box>
  );
}
