import * as React from 'react';
import { Box, Text } from 'ink';
import { TodoItem } from '../session';

/**
 * 待办列表（输入框下侧常驻）：/plan 确认后逐项执行实时勾选——✓ 已完成 / ▸ 进行中。
 * 运行中折叠为单行进度：帧高恒定（勾选推进只改行内容不增减行数），消除每步勾选引起的动态区高度跳动与局部闪动；
 * 收束后展开全量清单供回看。
 */
export function TodoList({ todos, running }: { todos: TodoItem[]; running?: boolean }): JSX.Element | null {
  if (todos.length === 0) return null;
  const done = todos.filter((t) => t.done).length;
  const current = todos.find((t) => !t.done);
  if (running) {
    return (
      <Box paddingLeft={1}>
        <Text dimColor>
          {'待办 ' + done + '/' + todos.length}
          {current ? ' · ▸ ' + current.text : ''}
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text dimColor>待办 {done}/{todos.length}</Text>
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
