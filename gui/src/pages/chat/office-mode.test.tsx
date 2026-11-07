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
import { taskNameResolverOf } from './use-chat-derived';

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

  it('发送给 leader 两模式都显 leader 链接,点开智能体团队定位单队', () => {
    for (const mode of ['code', 'office'] as const) {
      act(() => applyUiMode(mode));
      const opened: string[] = [];
      const r = render(
        <>
          <ToolEntryView entry={tool('m1', 'send_agent_team_message', { to: 'leader', text: 'done' })} conn={conn} sessionId="s" onOpenTask={(x) => opened.push(x)} teams={[{ teamId: 'team-1', name: 'squad' }]} />
          <ToolEntryView entry={tool('m2', 'send_agent_team_message', { to: 'leader', text: 'done' })} conn={conn} sessionId="s" onOpenTask={(x) => opened.push(x)} teams={[{ teamId: 'team-1', name: 'squad' }]} />
        </>,
      );
      const links = r.container.querySelectorAll('.tool-agent-link');
      expect([...links].map((l) => l.textContent!.trim())).toEqual(['leader', 'leader']);
      fireEvent.click(links[0]!);
      expect(opened).toEqual(['team:team-1']);
      r.unmount();
    }
  });

  it('加载智能体团队/子智能体/技能:办公模式显示名称', () => {
    act(() => applyUiMode('office'));
    const r = render(
      <>
        <ToolEntryView entry={tool('l1', 'load_agent_teams', { id: 'fullstack' })} conn={conn} sessionId="s" />
        <ToolEntryView entry={tool('l2', 'load_subagent', { id: 'reviewer' })} conn={conn} sessionId="s" />
        <ToolEntryView entry={tool('l3', 'skill', { id: 'web-testing' })} conn={conn} sessionId="s" />
      </>,
    );
    const rows = r.container.querySelectorAll('.entry-tool');
    expect(rows[0]!.textContent).toContain('fullstack');
    expect(rows[1]!.textContent).toContain('reviewer');
    expect(rows[2]!.textContent).toContain('web-testing');
    expect(r.container.querySelector('.tool-chev')).toBeNull();
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

describe('具名后台命令(exec purpose,2026-11-07 用户裁定)', () => {
  it('办公模式等待行:只列具名后台命令与子智能体,都可点(前者定位后台任务页签,后者开转录页);命令原文任务隐去;全无名只显「等待了任务」', () => {
    act(() => applyUiMode('office'));
    const ref = (id: string): { name: string; prompt?: string; kind?: 'exec' } | undefined =>
      id === 'bg-dev' ? { name: '启动开发服务器', kind: 'exec' } : id === 'bg-agent' ? { name: 'Researcher', prompt: 'dig' } : undefined;
    const tasks: string[] = [];
    const agents: string[] = [];
    const r = render(
      <>
        <ToolEntryView entry={tool('a', 'task_wait', { taskIds: ['bg-dev', 'bg-anon', 'bg-agent'] })} conn={conn} sessionId="s" onOpenTask={(id) => tasks.push(id)} onOpenAgent={(l) => agents.push(l)} taskNameOf={(id) => id} taskAgentOf={ref} />
        <ToolEntryView entry={tool('c', 'task_wait', { taskIds: ['bg-anon'] })} conn={conn} sessionId="s" onOpenTask={(id) => tasks.push(id)} taskNameOf={(id) => id} taskAgentOf={ref} />
      </>,
    );
    const rows = r.container.querySelectorAll('.entry-tool');
    expect(rows[0]!.textContent).toBe('Wait for task启动开发服务器, Researcher'); // bg-anon(命令原文)隐去
    const links = rows[0]!.querySelectorAll<HTMLElement>('.tool-agent-link');
    expect(links.length).toBe(2);
    fireEvent.click(links[0]!);
    fireEvent.click(links[1]!);
    expect(tasks).toEqual(['bg:bg-dev']);
    expect(agents).toEqual(['Researcher']);
    expect(rows[1]!.textContent).toBe('Waited for tasks');
  });
});

describe('编程模式等待行显 exec 任务名(2026-11-07)', () => {
  it('后台命令有描述即显描述(不显命令原文),点击定位后台任务页签', () => {
    const entries = [
      { key: 'k1', kind: 'tool', md: '', name: 'exec', input: { purpose: '启动开发服务器', command: 'npm run dev', background: true }, result: { ok: true, text: 'task dev-1 started (output: x)' } },
    ] as unknown as ChatEntry[];
    const tasks: string[] = [];
    const r = render(<ToolEntryView entry={tool('w', 'task_wait', { taskIds: ['dev-1'] })} conn={conn} sessionId="s" onOpenTask={(id) => tasks.push(id)} taskNameOf={taskNameResolverOf(entries, undefined)} />);
    const link = r.container.querySelector<HTMLElement>('.tool-agent-link')!;
    expect(link.textContent).toBe('启动开发服务器');
    expect(r.container.textContent).not.toContain('npm run dev');
    fireEvent.click(link);
    expect(tasks).toEqual(['bg:dev-1']);
  });
});
