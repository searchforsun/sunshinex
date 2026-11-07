import { describe, it, expect, afterEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { ToolEntryView } from './ToolEntry';
import { ToolSegBlock } from './ToolGroups';
import { RunChangesBar } from './RunFooter';
import { ChatEntryView } from './EntryViews';
import { LiveChangesContext } from './use-live-changes';
import { applyUiMode } from '../../ui-mode';
import type { ChatEntry } from '../../chat-reducer';
import type { Connection } from '../../connection';

/** 办公模式(2026-11-07 用户裁定):工具行数量与编程模式一致、聚合组照常可展开;单个工具行不可展开细节、
 *  非跳转行只显动词头,文件行去 +/-;等待后台任务行普通任务无跳转、含子智能体链接转录页(团队任务保留);
 *  发送团队消息保留收件人链接;读图片行整行开文件;记忆/技能旁白与代码变动条隐藏 */

const conn = {} as Connection;
const tool = (key: string, name: string, input: Record<string, unknown>, text = 'ok'): ChatEntry =>
  ({ key, kind: 'tool', md: '', name, input, result: { ok: true, text } }) as unknown as ChatEntry;
const none = (): null => null;

afterEach(() => act(() => applyUiMode('code')));

describe('办公模式', () => {
  it('exec 行只显动词头、无展开体与 chevron;写入行保留文件名去 +/-', () => {
    act(() => applyUiMode('office'));
    const r = render(
      <>
        <ToolEntryView entry={tool('x', 'exec', { command: 'pnpm test --filter gui' })} conn={conn} sessionId="s" />
        <ToolEntryView entry={tool('w', 'write', { path: 'src/app.ts' }, 'wrote src/app.ts (+12 -3)')} conn={conn} sessionId="s" />
      </>,
    );
    const rows = r.container.querySelectorAll('.entry-tool');
    expect(rows[0]!.textContent).toBe('Ran a command');
    expect(rows[0]!.querySelector('.tool-chev')).toBeNull();
    expect(rows[0]!.querySelector('.tool-body')).toBeNull();
    expect(rows[1]!.textContent).toContain('app.ts');
    expect(rows[1]!.querySelector('.tool-stat')).toBeNull();
  });

  it('等待后台任务:普通任务只显「Waited for tasks」无链接;含子智能体则链接其转录页;团队任务等待保留链接', () => {
    act(() => applyUiMode('office'));
    const onOpenTask = (): void => undefined;
    const opened: string[] = [];
    const taskAgentOf = (id: string) => (id === 'bg-agent' ? { name: 'Researcher', prompt: 'dig' } : undefined);
    const r = render(
      <>
        <ToolEntryView entry={tool('a', 'task_wait', { taskIds: ['bg1'] })} conn={conn} sessionId="s" onOpenTask={onOpenTask} taskNameOf={() => 'build'} taskAgentOf={taskAgentOf} />
        <ToolEntryView entry={tool('c', 'task_wait', { taskIds: ['bg1', 'bg-agent'] })} conn={conn} sessionId="s" onOpenTask={onOpenTask} onOpenAgent={(label) => opened.push(label)} taskNameOf={(id) => id} taskAgentOf={taskAgentOf} />
        <ToolEntryView entry={tool('b', 'agent_team_task_wait', { taskIds: ['t1'] })} conn={conn} sessionId="s" onOpenTask={onOpenTask} taskNameOf={() => 'review'} />
      </>,
    );
    const rows = r.container.querySelectorAll('.entry-tool');
    expect(rows[0]!.textContent).toBe('Waited for tasks');
    expect(rows[0]!.querySelector('.tool-agent-link')).toBeNull();
    const agentLink = rows[1]!.querySelector('.tool-agent-link')!;
    expect(rows[1]!.textContent).toBe('Wait for taskResearcher');
    fireEvent.click(agentLink);
    expect(opened).toEqual(['Researcher']);
    expect(rows[2]!.querySelector('.tool-agent-link')!.textContent).toContain('review');
  });

  it('发送团队消息保留收件人链接;读图片行整行开文件', () => {
    act(() => applyUiMode('office'));
    const files: string[] = [];
    const r = render(
      <>
        <ToolEntryView entry={tool('m', 'send_agent_team_message', { to: 'Planner', text: 'hi' })} conn={conn} sessionId="s" onOpenAgent={() => undefined} />
        <ToolEntryView entry={tool('i', 'read', { path: 'shot.png' }, '[image] shot.png')} conn={conn} sessionId="s" onOpenFile={(p) => files.push(p)} />
      </>,
    );
    const rows = r.container.querySelectorAll('.entry-tool');
    expect(rows[0]!.querySelector('.tool-agent-link')!.textContent).toContain('Planner');
    fireEvent.click(rows[1]!.querySelector('.tool-summary')!);
    expect(files).toEqual(['shot.png']);
  });

  it('聚合组照常可展开,成员行数不变且成员行不可展开', () => {
    act(() => applyUiMode('office'));
    const seg = [tool('a', 'read', { path: 'a.ts' }), tool('b', 'grep', { pattern: 'x' }), tool('c', 'glob', { pattern: '*' })];
    const renderTool = (e: ChatEntry) => <ToolEntryView key={e.key} entry={e} conn={conn} sessionId="s" />;
    const r = render(<ToolSegBlock seg={seg} closed={false} renderTool={renderTool} renderThinking={none} renderAssistant={none} />);
    const head = r.container.querySelector('button.tool-group-head')!;
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(r.container.querySelectorAll('.entry-tool')).toHaveLength(3);
    expect(r.container.querySelector('.entry-tool .tool-chev')).toBeNull();
  });

  it('编程模式不变:命令原文+可展开', () => {
    const r = render(<ToolEntryView entry={tool('x', 'exec', { command: 'pnpm test' })} conn={conn} sessionId="s" />);
    expect(r.container.textContent).toContain('pnpm test');
    expect(r.container.querySelector('.tool-chev')).not.toBeNull();
  });

  it('记忆/技能旁白与代码变动条隐藏', () => {
    act(() => applyUiMode('office'));
    const note = render(<ChatEntryView entry={{ key: 'n', kind: 'notice', md: '[skills] learned: deploy' }} />);
    expect(note.container.textContent).toBe('');
    const f = { path: 'a.ts', status: 'modified', added: 1, deleted: 0 };
    const bar = render(
      <LiveChangesContext.Provider value={[f]}>
        <RunChangesBar changes={[f]} />
      </LiveChangesContext.Provider>,
    );
    expect(bar.container.querySelector('.run-changes')).toBeNull();
  });
});
