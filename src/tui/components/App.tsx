import * as React from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { ApprovalDecision } from '../../types';
import { SessionController, TuiState } from '../session';
import { BannerInfo, buildBannerInfo } from '../banner-info';
import { Banner } from './Banner';
import { MessageList } from './MessageList';
import { InputBox } from './InputBox';
import { TodoList } from './TodoList';
import { StatusBar } from './StatusBar';
import { Spinner } from './Spinner';

/** 审批键盘映射：y 放行一次 / a 本会话放行 / n 拒绝（纯函数，独立单测） */
export function approvalKeyToDecision(input: string): ApprovalDecision | undefined {
  if (input === 'y') return 'allow';
  if (input === 'a') return 'always';
  if (input === 'n') return 'deny';
  return undefined;
}

/** 斜杠命令清单（补全候选，顺序即 Tab 循环顺序） */
export const SLASH_COMMANDS = ['/help', '/new', '/compact', '/status', '/plan'];

/** 斜杠补全候选：按 buffer（已 trim）前缀匹配命令清单；非 / 前缀或无匹配返回空 */
export function slashCandidates(buffer: string): string[] {
  const t = buffer.trim();
  if (!t.startsWith('/')) return [];
  return SLASH_COMMANDS.filter((c) => c.startsWith(t));
}

/** 输入框占位文案（按会话状态分流；纯函数便于断言） */
export function inputPlaceholder(status: TuiState['status']): string {
  switch (status) {
    case 'awaiting-approval': return '等待审批：y 放行一次 / a 本会话放行 / n 拒绝';
    case 'awaiting-plan': return '计划待确认：y 执行 / n 放弃';
    case 'running': return '运行中…（输入将排队）';
    case 'error': return '上次任务出错；输入新任务继续';
    default: return '输入任务，Enter 发送 · /help 查看命令';
  }
}

/** Ink 渲染层（纯渲染 + 单一 useInput 键盘分发）：状态全量来自 controller 订阅 */
export function App({ controller, banner }: { controller: SessionController; banner?: BannerInfo }): JSX.Element {
  const [state, setState] = React.useState<TuiState>(controller.getState());
  const [buffer, setBuffer] = React.useState('');
  const [expandAll, setExpandAll] = React.useState(false);
  const [history, setHistory] = React.useState<string[]>([]);
  const [histIdx, setHistIdx] = React.useState(-1);
  React.useEffect(() => controller.onState(() => setState({ ...controller.getState() })), [controller]);
  const info = React.useMemo(() => banner ?? buildBannerInfo(), [banner]);
  const columns = useStdout().stdout?.columns ?? 80;

  useInput((input, key) => {
    if (key.ctrl && input === 'c') return; // 退出由入口层 SIGINT 统一处理
    if (state.status === 'awaiting-approval') {
      const d = approvalKeyToDecision(input);
      if (d) controller.resolveApproval(d);
      return;
    }
    if (state.status === 'awaiting-plan') {
      if (input === 'y') void controller.confirmPlan(true);
      if (input === 'n') void controller.confirmPlan(false);
      return;
    }
    if (key.tab) {
      // Tab 分流：/ 前缀 → 斜杠补全；否则 idle/error 态切换展开
      if (buffer.startsWith('/')) {
        const token = buffer.trim();
        const exactIdx = SLASH_COMMANDS.indexOf(token);
        if (exactIdx >= 0) {
          setBuffer(SLASH_COMMANDS[(exactIdx + 1) % SLASH_COMMANDS.length] + ' ');
        } else {
          const cands = slashCandidates(token);
          if (cands.length > 0) setBuffer(cands[0] + ' ');
        }
      } else if (state.status === 'idle' || state.status === 'error') {
        setExpandAll((e) => !e);
      }
      return;
    }
    if ((key.upArrow || key.downArrow) && (state.status === 'idle' || state.status === 'error') && !buffer.includes('\n')) {
      if (key.upArrow && history.length > 0 && histIdx !== 0) {
        const ni = histIdx === -1 ? history.length - 1 : histIdx - 1;
        setHistIdx(ni);
        setBuffer(history[ni]);
      } else if (key.downArrow && histIdx >= 0) {
        const ni = histIdx + 1;
        if (ni < history.length) {
          setHistIdx(ni);
          setBuffer(history[ni]);
        } else {
          setHistIdx(-1);
          setBuffer('');
        }
      }
      return;
    }
    if (key.return) {
      // 行尾单个反斜杠 = 续行（ink3 无法可靠检测 Shift+Enter，回退方案）
      if (buffer.endsWith('\\') && !buffer.endsWith('\\\\')) {
        setBuffer((b) => b.slice(0, -1) + '\n');
        return;
      }
      const text = buffer.trim();
      setBuffer('');
      setHistIdx(-1);
      if (text) {
        setHistory((h) => [...h.filter((x) => x !== text), text].slice(-100));
        controller.submit(text);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setBuffer((b) => b.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) setBuffer((b) => b + input);
  });

  return (
    <Box flexDirection="column">
      <Banner info={info} columns={columns} />
      <MessageList messages={state.messages} live={state.live} columns={columns} expandAll={expandAll} />
      {state.status === 'running' ? (
        <Spinner startedAt={state.metrics.turnStartedAt} tokens={state.metrics.turnTokens} />
      ) : null}
      {state.approval ? (
        <Box borderStyle="round" flexDirection="column" paddingX={1}>
          <Text bold>
            审批 {state.approval.id}（{state.approval.kind}）
          </Text>
          <Text>{state.approval.subject}</Text>
          <Text dimColor>y 放行一次 · a 本会话放行 · n 拒绝</Text>
        </Box>
      ) : null}
      <InputBox buffer={buffer} placeholder={inputPlaceholder(state.status)} active={state.status === 'idle' || state.status === 'error'} />
      <TodoList todos={state.todos} />
      <StatusBar metrics={state.metrics} status={state.status} todos={state.todos} model={info.model} />
    </Box>
  );
}
