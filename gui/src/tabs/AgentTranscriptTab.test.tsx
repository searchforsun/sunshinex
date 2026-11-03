import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { AgentTranscriptTab } from './AgentTranscriptTab';
import { applyAgentEvent, type AgentActivities } from './agent-activity';
import type { SessionEvent } from '../../../src/types';
import type { Connection } from '../connection';
import type { TaskBoardState } from '../projection';

/**
 * G14.2xx b 子智能体转录页六项对标主对话的渲染锚:
 * - run 条分派 RunEntryView(streaming=运行态行;自带分割线,agent-thread-sep 双线退役)
 * - 底部 run-live-line(spinner+steps+tokens)running 时在场
 * - thinking 行渲染(reasoning 入投影后转录可见)
 * - read 工具行整行点击 → onOpenFile(回调链与主对话同构)
 * - 容器挂 .chat 类(间距系统同源)
 */

let ts = 0;
const ev = (type: SessionEvent['type'], text?: string, payload?: Record<string, unknown>): SessionEvent => ({ type, text, payload, ts: ++ts });
const sub = (type: SessionEvent['type'], label: string, text?: string, payload: Record<string, unknown> = {}): SessionEvent =>
  ev(type, text, { ...payload, subagent: label });

const connStub = (() => ({})) as unknown as Connection;
const boardStub = { tasks: {} } as unknown as TaskBoardState;

/** 运行中活动卡:model-start→reasoning→read 完成→token(正文流式;无 done=仍 running) */
function runningActivities(): AgentActivities {
  let s: AgentActivities = {};
  s = applyAgentEvent(s, sub('model-start', 'an'));
  s = applyAgentEvent(s, sub('reasoning', 'an', '先看目录'));
  s = applyAgentEvent(s, sub('tool-call', 'an', 'read', { input: { path: 'src/a.ts' }, callId: 'c1', status: 'pending' }));
  s = applyAgentEvent(s, sub('tool-result', 'an', 'file body', { callId: 'c1', ok: true, tool: 'read' }));
  s = applyAgentEvent(s, sub('token', 'an', '正文'));
  return s;
}

describe('AgentTranscriptTab 对标主对话', () => {
  it('run 条走 RunEntryView(运行态行在场)、无 agent-thread-sep、容器挂 .chat 类', () => {
    const { container } = render(
      <AgentTranscriptTab conn={connStub} sessionId="s1" activities={runningActivities().an} board={boardStub} task="分析任务" />,
    );
    expect(container.querySelector('.agent-thread-sep')).toBeNull(); // 双分割线退役
    expect(container.querySelector('.sx-agent-thread.chat')).not.toBeNull(); // 间距系统同源
    expect(container.querySelector('.entry-run.live')).not.toBeNull(); // 主对话同款运行态行
    expect(container.querySelector('.run-live-line')).not.toBeNull(); // 底部 spinner+steps+tokens
    expect(container.querySelector('.entry-thinking')).not.toBeNull(); // 思考行可见(reasoning 入投影)
    expect(container.querySelector('.entry-tool')).not.toBeNull();
  });

  it('read 工具行整行点击 → onOpenFile(主对话同款文件跳转)', () => {
    const onOpenFile = vi.fn();
    const { container } = render(
      <AgentTranscriptTab
        conn={connStub}
        sessionId="s1"
        activities={runningActivities().an}
        board={boardStub}
        task="分析任务"
        onOpenFile={onOpenFile}
      />,
    );
    const summary = container.querySelector<HTMLElement>('.entry-tool .tool-summary');
    expect(summary).not.toBeNull();
    fireEvent.click(summary!);
    expect(onOpenFile).toHaveBeenCalledWith('src/a.ts');
  });

  it('运行收束(done)后 run-live-line 熄灭、run 条转 sealed', () => {
    let s = runningActivities();
    s = applyAgentEvent(s, sub('done', 'an', '正文'));
    const { container } = render(
      <AgentTranscriptTab conn={connStub} sessionId="s1" activities={s.an} board={boardStub} task="分析任务" />,
    );
    expect(container.querySelector('.run-live-line')).toBeNull();
    expect(container.querySelector('.entry-run.sealed')).not.toBeNull();
  });

  it('复现:done 后末条 assistant 应挂 RunFooter(复制钮+steps+tokens+时间)', () => {
    let s: AgentActivities = {};
    s = applyAgentEvent(s, sub('model-start', 'an'));
    s = applyAgentEvent(s, sub('token', 'an', '结论全文'));
    s = applyAgentEvent(s, sub('done', 'an', '结论全文', { steps: 5, runSteps: 3, tokensUsed: 1234, stopReason: 'done' }));
    const { container } = render(
      <AgentTranscriptTab conn={connStub} sessionId="s1" activities={s.an} board={boardStub} task="分析任务" />,
    );
    const footers = container.querySelectorAll('.run-footer');
    expect(footers.length).toBeGreaterThan(0);
    expect(container.querySelector('.entry-assistant .run-footer')).not.toBeNull();
  });

  it('真实形态:思考尾段 done 收口+终稿 → 末条 assistant 挂 footer;统计面(steps/tokens)随 done 载荷在场', () => {
    let s: AgentActivities = {};
    s = applyAgentEvent(s, sub('model-start', 'an'));
    s = applyAgentEvent(s, sub('reasoning', 'an', '整理结论'));
    s = applyAgentEvent(s, sub('tool-call', 'an', 'read', { input: { path: 'b.ts' }, callId: 'c2', status: 'pending' }));
    s = applyAgentEvent(s, sub('tool-result', 'an', 'ok', { callId: 'c2', ok: true, tool: 'read' }));
    s = applyAgentEvent(s, sub('token', 'an', '最终结论'));
    s = applyAgentEvent(s, sub('done', 'an', '最终结论', { steps: 8, runSteps: 4, tokensUsed: 4200, stopReason: 'done' }));
    const { container } = render(
      <AgentTranscriptTab conn={connStub} sessionId="s1" activities={s.an} board={boardStub} task="分析任务" />,
    );
    const footer = container.querySelector('.entry-assistant .run-footer');
    expect(footer).not.toBeNull();
    expect(footer!.textContent).toContain('8'); // steps 统计
  });

  it('多轮:轮1 已封带 footer,轮2 进行中(新 run streaming)时轮1 footer 保留;轮2 末条流式无 footer', () => {
    let s: AgentActivities = {};
    s = applyAgentEvent(s, sub('model-start', 'an'));
    s = applyAgentEvent(s, sub('token', 'an', '第一轮结论'));
    s = applyAgentEvent(s, sub('done', 'an', '第一轮结论', { steps: 3, tokensUsed: 100 }));
    s = applyAgentEvent(s, sub('model-start', 'an')); // 轮2 开启
    s = applyAgentEvent(s, sub('token', 'an', '第二轮写一半'));
    const { container } = render(
      <AgentTranscriptTab conn={connStub} sessionId="s1" activities={s.an} board={boardStub} task="分析任务" />,
    );
    const sealedAssistant = [...container.querySelectorAll('.entry-assistant')].find((el) => el.textContent?.startsWith('第一轮结论'));
    expect(sealedAssistant).toBeDefined();
    expect(sealedAssistant!.querySelector('.run-footer')).not.toBeNull();
    const streamingAssistant = [...container.querySelectorAll('.entry-assistant')].find((el) => el.classList.contains('streaming'));
    expect(streamingAssistant).toBeDefined();
    expect(streamingAssistant!.querySelector('.run-footer')).toBeNull(); // 主对话运行中同款
  });

  it('消息气泡显示来源名，点击打开该智能体转录', () => {
    let s: AgentActivities = {};
    s = applyAgentEvent(s, ev('agent-message', undefined, { messageId: 'm1', from: 'w1', to: 'w2', text: '先看测试', teamId: 'team-a' }));
    s = applyAgentEvent(s, sub('step', 'w2', '', { messageId: 'm1', messageLine: 'w1: 先看测试', from: 'w1', to: 'w2', text: '先看测试', teamId: 'team-a' }));
    const onOpenAgent = vi.fn();
    const { container } = render(
      <AgentTranscriptTab conn={connStub} sessionId="s1" activities={s.w2} board={boardStub} onOpenAgent={onOpenAgent} />,
    );
    const bubbles = container.querySelectorAll('.agent-msg');
    expect(bubbles).toHaveLength(1);
    expect(container.querySelector('.agent-msg-from')?.textContent).toBe('w1');
    expect(bubbles[0]?.textContent).toContain('先看测试');
    expect(bubbles[0]?.classList.contains('entry-user-insert')).toBe(true);
    fireEvent.click(container.querySelector('.agent-msg-from')!);
    expect(onOpenAgent).toHaveBeenCalledWith('w1', 'w1');
  });

  it('inbox drain 的 messageLine 步单独成气泡，来源名可点', () => {
    const s = applyAgentEvent({}, sub('step', 'w2', '', { messageLine: 'lead: 去跑测试', from: 'lead', to: 'w2', text: '去跑测试', messageId: 'm9', teamId: 'team-a' }));
    const onOpenAgent = vi.fn();
    const { container } = render(
      <AgentTranscriptTab conn={connStub} sessionId="s1" activities={s.w2} board={boardStub} onOpenAgent={onOpenAgent} />,
    );
    const from = container.querySelector('.agent-msg-from');
    expect(from?.textContent).toBe('lead');
    fireEvent.click(from!);
    expect(onOpenAgent).toHaveBeenCalledWith('lead', 'lead');
  });

  it('轮折叠:sealed run 自动折叠(2026-10-24 裁定)——初始即收合,点击展开,再点收回', () => {
    let s: AgentActivities = {};
    s = applyAgentEvent(s, sub('model-start', 'an'));
    s = applyAgentEvent(s, sub('reasoning', 'an', '想想'));
    s = applyAgentEvent(s, sub('tool-call', 'an', 'read', { input: { path: 'c.ts' }, callId: 'c3', status: 'pending' }));
    s = applyAgentEvent(s, sub('tool-result', 'an', 'ok', { callId: 'c3', ok: true, tool: 'read' }));
    s = applyAgentEvent(s, sub('token', 'an', '结论'));
    s = applyAgentEvent(s, sub('done', 'an', '结论', { steps: 2, tokensUsed: 50 }));
    const { container } = render(
      <AgentTranscriptTab conn={connStub} sessionId="s1" activities={s.an} board={boardStub} task="分析任务" />,
    );
    const runRow = container.querySelector<HTMLElement>('.entry-run.sealed');
    expect(runRow).not.toBeNull();
    expect(runRow!.getAttribute('role')).toBe('button'); // 可点击(此前无 onToggle 恒只读)
    expect(container.querySelector('.seg-collapse.open')).toBeNull(); // 完成即自动折叠(初始收合态)
    fireEvent.click(runRow!); // 展开
    expect(container.querySelector('.seg-collapse.open')).not.toBeNull();
    const runRow2 = container.querySelector<HTMLElement>('.entry-run.sealed');
    fireEvent.click(runRow2!); // 再收合
    expect(container.querySelector('.seg-collapse.open')).toBeNull();
  });
});

describe('AgentTranscriptTab 任务定位(2026-11-03 用户裁定)', () => {
  it('focusTaskId 命中该任务气泡 scrollIntoView+focus-flash;换目标即换定位(闩按值,不重复拽同一条)', () => {
    const scrollSpy = vi.fn();
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = scrollSpy;
    // 成员连跑两任务:两条任务带(各以 Task <板id>: 开头),中间隔一个已封轮
    let s: AgentActivities = {};
    s = applyAgentEvent(s, sub('step', 'an', '', { taskBand: 'Task task-a-1111: A' + '\n' + 'spec a' }));
    s = applyAgentEvent(s, sub('token', 'an', 'A 完成'));
    s = applyAgentEvent(s, sub('done', 'an', 'A 完成', { steps: 2 }));
    s = applyAgentEvent(s, sub('step', 'an', '', { taskBand: 'Task task-b-2222: B' + '\n' + 'spec b' }));
    const base = { conn: connStub, sessionId: 's1', activities: s.an, board: boardStub };
    const { container, rerender, unmount } = render(<AgentTranscriptTab {...base} focusTaskId="task-b-2222" />);
    const bubbles = container.querySelectorAll<HTMLElement>('.child-user-entry');
    expect(bubbles.length).toBe(2);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(bubbles[1]!.classList.contains('focus-flash')).toBe(true);
    expect(bubbles[0]!.classList.contains('focus-flash')).toBe(false);
    // 同 agent 页签换任务重开(openTab 判重聚焦+params 刷新):定位目标切到 A
    rerender(<AgentTranscriptTab {...base} focusTaskId="task-a-1111" />);
    expect(scrollSpy).toHaveBeenCalledTimes(2);
    expect(bubbles[0]!.classList.contains('focus-flash')).toBe(true);
    // 同目标再渲染:闩生效,不重复滚动
    rerender(<AgentTranscriptTab {...base} focusTaskId="task-a-1111" />);
    expect(scrollSpy).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('目标气泡未出(任务未开跑)不滚动不闪光;任务带流入后命中', () => {
    const scrollSpy = vi.fn();
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = scrollSpy;
    let s: AgentActivities = {};
    s = applyAgentEvent(s, sub('step', 'an', '', { taskBand: 'Task task-a-3333: A' + '\n' + 'spec a' }));
    const base = { conn: connStub, sessionId: 's1', board: boardStub, task: '兜底' };
    const { container, rerender } = render(<AgentTranscriptTab {...base} activities={s.an} focusTaskId="task-b-4444" />);
    expect(scrollSpy).not.toHaveBeenCalled();
    expect(container.querySelector('.focus-flash')).toBeNull();
    // B 的任务带到达 → 命中
    s = applyAgentEvent(s, sub('step', 'an', '', { taskBand: 'Task task-b-4444: B' + '\n' + 'spec b' }));
    rerender(<AgentTranscriptTab {...base} activities={s.an} focusTaskId="task-b-4444" />);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('.child-user-entry.focus-flash')).toHaveLength(1);
  });
});
