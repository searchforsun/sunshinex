import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { AgentTranscriptTab } from './AgentTranscriptTab';
import { applyAgentEvent, type AgentActivities } from './agent-activity';
import type { SessionEvent } from '../../../src/types';
import type { Connection } from '../connection';
import type { TaskBoardState } from '../projection';

/**
 * G14.2xx b 子代理转录页六项对标主对话的渲染锚:
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
      <AgentTranscriptTab label="an" conn={connStub} sessionId="s1" activities={runningActivities().an} board={boardStub} task="分析任务" />,
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
        label="an"
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
      <AgentTranscriptTab label="an" conn={connStub} sessionId="s1" activities={s.an} board={boardStub} task="分析任务" />,
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
      <AgentTranscriptTab label="an" conn={connStub} sessionId="s1" activities={s.an} board={boardStub} task="分析任务" />,
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
      <AgentTranscriptTab label="an" conn={connStub} sessionId="s1" activities={s.an} board={boardStub} task="分析任务" />,
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
      <AgentTranscriptTab label="an" conn={connStub} sessionId="s1" activities={s.an} board={boardStub} task="分析任务" />,
    );
    const sealedAssistant = [...container.querySelectorAll('.entry-assistant')].find((el) => el.textContent?.startsWith('第一轮结论'));
    expect(sealedAssistant).toBeDefined();
    expect(sealedAssistant!.querySelector('.run-footer')).not.toBeNull();
    const streamingAssistant = [...container.querySelectorAll('.entry-assistant')].find((el) => el.classList.contains('streaming'));
    expect(streamingAssistant).toBeDefined();
    expect(streamingAssistant!.querySelector('.run-footer')).toBeNull(); // 主对话运行中同款
  });

  it('轮折叠:sealed run 条 role=button 可点,点击后该轮工具/思考行隐藏(chevron 展开)', () => {
    let s: AgentActivities = {};
    s = applyAgentEvent(s, sub('model-start', 'an'));
    s = applyAgentEvent(s, sub('reasoning', 'an', '想想'));
    s = applyAgentEvent(s, sub('tool-call', 'an', 'read', { input: { path: 'c.ts' }, callId: 'c3', status: 'pending' }));
    s = applyAgentEvent(s, sub('tool-result', 'an', 'ok', { callId: 'c3', ok: true, tool: 'read' }));
    s = applyAgentEvent(s, sub('token', 'an', '结论'));
    s = applyAgentEvent(s, sub('done', 'an', '结论', { steps: 2, tokensUsed: 50 }));
    const { container } = render(
      <AgentTranscriptTab label="an" conn={connStub} sessionId="s1" activities={s.an} board={boardStub} task="分析任务" />,
    );
    const runRow = container.querySelector<HTMLElement>('.entry-run.sealed');
    expect(runRow).not.toBeNull();
    expect(runRow!.getAttribute('role')).toBe('button'); // 可点击(此前无 onToggle 恒只读)
    fireEvent.click(runRow!); // 折叠
    expect(container.querySelector('.seg-collapse.open')).toBeNull(); // 段收合(closed 态)
    const runRow2 = container.querySelector<HTMLElement>('.entry-run.sealed');
    fireEvent.click(runRow2!); // 再展开
    expect(container.querySelector('.seg-collapse.open')).not.toBeNull();
  });
});
