import * as React from 'react';
import { Box, Text, useStdout } from 'ink';
import useInput, { RawKey } from './use-input';
import { ApprovalDecision } from '../../types';
import { SessionController, TuiState } from '../session';
import { splitRounds } from '../history-view';
import { BannerInfo, buildBannerInfo } from '../banner-info';
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
export const SLASH_COMMANDS = ['/help', '/init', '/new', '/compact', '/status', '/plan'];

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

/** Home/End 终端转义序列体：ink3 不解析这些功能键，按 ESC 剥离前后的两种形态识别（xterm 与应用模式两族） */
const HOME_SEQS = ['[H', 'OH', '[1~', '[7~'];
const END_SEQS = ['[F', 'OF', '[4~', '[8~'];

/** Ink 渲染层（纯渲染 + useInput 垫片键盘分发：垫片保留原始字节，退格/⌦ 经 key.raw 精确分流）：状态全量来自 controller 订阅 */
export function App({ controller, banner }: { controller: SessionController; banner?: BannerInfo }): JSX.Element {
  const [state, setState] = React.useState<TuiState>(controller.getState());
  const [buffer, setBuffer] = React.useState('');
  const [cursor, setCursor] = React.useState(0);
  const [review, setReview] = React.useState(false);
  const [reviewEnd, setReviewEnd] = React.useState(0);
  const [expandedRound, setExpandedRound] = React.useState(-1);
  const [history, setHistory] = React.useState<string[]>([]);
  const [histIdx, setHistIdx] = React.useState(-1);
  React.useEffect(() => controller.onState(() => setState({ ...controller.getState() })), [controller]);
  const info = React.useMemo(() => banner ?? buildBannerInfo(), [banner]);
  const columns = useStdout().stdout?.columns ?? 80;

  useInput((input: string, key: RawKey) => {
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

    const lastRoundIdx = splitRounds(state.messages).length - 1;

    // 历史翻阅模态：↑↓ 逐轮追踪（越过底部即回实时），Tab 展开视口末轮（同时仅一块），Esc 返回；
    // 其余按键先退出翻阅、再按普通输入处理，保证随手打字不被视图吞掉
    if (review) {
      if (key.upArrow) {
        setReviewEnd((e) => Math.max(0, e - 1));
        setExpandedRound(-1);
        return;
      }
      if (key.downArrow) {
        if (reviewEnd + 1 > lastRoundIdx) setReview(false);
        else {
          setReviewEnd(reviewEnd + 1);
          setExpandedRound(-1);
        }
        return;
      }
      if (key.tab) {
        setExpandedRound((x) => (x === -1 ? reviewEnd : -1));
        return;
      }
      if (key.escape) {
        setReview(false);
        setExpandedRound(-1);
        return;
      }
      setReview(false);
      setExpandedRound(-1);
    }

    // Tab 分流：/ 前缀 → 斜杠补全；否则空闲/出错态进入历史翻阅（视口停在最近 6 轮）
    if (key.tab) {
      if (buffer.startsWith('/')) {
        const token = buffer.trim();
        const exactIdx = SLASH_COMMANDS.indexOf(token);
        const next =
          exactIdx >= 0
            ? SLASH_COMMANDS[(exactIdx + 1) % SLASH_COMMANDS.length] + ' '
            : slashCandidates(token).length > 0
              ? slashCandidates(token)[0] + ' '
              : undefined;
        if (next !== undefined) {
          setBuffer(next);
          setCursor(next.length);
        }
      } else if ((state.status === 'idle' || state.status === 'error') && lastRoundIdx >= 0) {
        setReview(true);
        setReviewEnd(lastRoundIdx);
        setExpandedRound(-1);
      }
      return;
    }

    // Home/End/⌦：ink3 不解析这些功能键，按原始字节序列识别；Ctrl+A/E 惯例双轨
    const csi = key.raw.startsWith('\u001B') ? key.raw.slice(1) : '';
    if (HOME_SEQS.includes(csi)) {
      setCursor(0);
      return;
    }
    if (END_SEQS.includes(csi)) {
      setCursor(buffer.length);
      return;
    }
    if (csi === '[3~') {
      // ⌦ 前向删除：删光标处字符（与退格区分靠 ESC 序列）
      if (cursor < buffer.length) setBuffer((b) => b.slice(0, cursor) + b.slice(cursor + 1));
      return;
    }
    if (key.ctrl && (input === 'a' || input === 'e')) {
      setCursor(input === 'a' ? 0 : buffer.length);
      return;
    }

    // 光标左右移动（多行缓冲按扁平偏移跨行连续）
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(buffer.length, c + 1));
      return;
    }

    // ↑↓：单行缓冲回填输入历史（多行缓冲不劫持，留给后续行内导航）
    if ((key.upArrow || key.downArrow) && (state.status === 'idle' || state.status === 'error') && !buffer.includes('\n')) {
      if (key.upArrow && history.length > 0 && histIdx !== 0) {
        const ni = histIdx === -1 ? history.length - 1 : histIdx - 1;
        setHistIdx(ni);
        setBuffer(history[ni]);
        setCursor(history[ni].length);
      } else if (key.downArrow && histIdx >= 0) {
        const ni = histIdx + 1;
        if (ni < history.length) {
          setHistIdx(ni);
          setBuffer(history[ni]);
          setCursor(history[ni].length);
        } else {
          setHistIdx(-1);
          setBuffer('');
          setCursor(0);
        }
      }
      return;
    }
    if (key.return) {
      // 行尾单个反斜杠 = 续行（ink3 无法可靠检测 Shift+Enter，回退方案）
      if (buffer.endsWith('\\') && !buffer.endsWith('\\\\')) {
        setBuffer((b) => b.slice(0, -1) + '\n');
        setCursor(buffer.length);
        return;
      }
      const text = buffer.trim();
      setBuffer('');
      setCursor(0);
      setHistIdx(-1);
      if (text) {
        setHistory((h) => [...h.filter((x) => x !== text), text].slice(-100));
        controller.submit(text);
      }
      return;
    }
    if (key.backspace || key.delete) {
      if (key.raw === '\u001B[3~') {
        // ⌦ 前向删除：删光标处字符（ink3 原版 useInput 清空 input 无法与退格区分，走补丁版原始字节）
        if (cursor < buffer.length) setBuffer((b) => b.slice(0, cursor) + b.slice(cursor + 1));
        return;
      }
      // 退格（\u007F / Ctrl+H）：删光标前字符
      if (cursor > 0) {
        setBuffer((b) => b.slice(0, cursor - 1) + b.slice(cursor));
        setCursor((c) => Math.max(0, c - 1));
      }
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setBuffer((b) => b.slice(0, cursor) + input + b.slice(cursor));
      setCursor((c) => c + input.length);
    }
  });

  return (
    <Box flexDirection="column">
      <MessageList
        banner={info}
        messages={state.messages}
        live={state.live}
        columns={columns}
        review={review}
        reviewEnd={reviewEnd}
        expandedRound={expandedRound}
      />
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
      <InputBox
        buffer={buffer}
        cursor={cursor}
        placeholder={inputPlaceholder(state.status)}
        active={state.status === 'idle' || state.status === 'error'}
      />
      <TodoList todos={state.todos} />
      <StatusBar metrics={state.metrics} status={state.status} todos={state.todos} model={info.model} />
    </Box>
  );
}

