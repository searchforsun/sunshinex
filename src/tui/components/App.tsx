import * as React from 'react';
import { Box, Text, useInput } from 'ink';
import { ApprovalDecision } from '../../types';
import { SessionController, TuiState } from '../session';

/** 审批键盘映射：y 放行一次 / a 本会话放行 / n 拒绝（纯函数，独立单测） */
export function approvalKeyToDecision(input: string): ApprovalDecision | undefined {
  if (input === 'y') return 'allow';
  if (input === 'a') return 'always';
  if (input === 'n') return 'deny';
  return undefined;
}

const ROLE_TAG = {
  user: '你',
  assistant: '助手',
  tool: '工具',
  system: '系统',
} as const;

const ROLE_COLOR = {
  user: 'cyan',
  assistant: 'green',
  tool: 'gray',
  system: 'yellow',
} as const;

const STATUS_LABEL = {
  idle: '空闲',
  running: '运行中',
  'awaiting-approval': '等待审批',
  error: '出错',
} as const;

/** Ink 渲染层（纯渲染）：状态全量来自 controller 订阅，业务逻辑零本地 */
export function App({ controller }: { controller: SessionController }): JSX.Element {
  const [state, setState] = React.useState<TuiState>(controller.getState());
  const [buffer, setBuffer] = React.useState('');
  // ink3 挂载 react-reconciler@0.26（useSyncExternalStore 不可用），订阅走 useState 强刷（事件驱动，与节流帧解耦）
  React.useEffect(() => controller.onState(() => setState({ ...controller.getState() })), [controller]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') return; // 退出由入口层 SIGINT 统一处理
    if (state.status === 'awaiting-approval') {
      const d = approvalKeyToDecision(input);
      if (d) controller.resolveApproval(d);
      return;
    }
    if (key.return) {
      const text = buffer.trim();
      setBuffer('');
      if (text) controller.submit(text);
      return;
    }
    if (key.backspace || key.delete) {
      setBuffer((b) => b.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) setBuffer((b) => b + input);
  });

  const doneTodos = state.todos.filter((t) => t.done).length;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {state.messages.length === 0 ? (
          <Text dimColor>SunshineX TUI — 输入任务或 /help 查看命令</Text>
        ) : (
          state.messages.map((m, i) => (
            <Text key={i} color={ROLE_COLOR[m.role]}>
              [{ROLE_TAG[m.role]}] {m.text}
            </Text>
          ))
        )}
      </Box>
      {state.approval ? (
        <Box borderStyle="round" flexDirection="column" paddingX={1}>
          <Text bold>
            审批 {state.approval.id}（{state.approval.kind}）
          </Text>
          <Text>{state.approval.subject}</Text>
          <Text dimColor>y 放行一次 · a 本会话放行 · n 拒绝</Text>
        </Box>
      ) : null}
      <Text dimColor>
        [{STATUS_LABEL[state.status]}]{' '}
        {state.status === 'awaiting-approval' ? '按 y/a/n 裁决' : `> ${buffer}`}
        {state.todos.length > 0 ? ` · 待办 ${doneTodos}/${state.todos.length}` : ''}
      </Text>
    </Box>
  );
}
