import { describe, it, expect, afterEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { ToolEntryView } from './ToolEntry';
import { ChatEntryView } from './EntryViews';
import { applyUiMode } from '../../ui-mode';
import type { ChatEntry } from '../../chat-reducer';
import type { Connection } from '../../connection';
import { taskAgentResolverOf, taskNameResolverOf } from './use-chat-derived';

/** MCP 工具折叠行(2026-11-07 用户裁定):编程模式参数照常显示;办公模式只显名——内置电脑/浏览器工具=本地化名,
 *  接入第三方=「Ran 工具名」;阶段正文两种界面模式下正常显示 */

const conn = {} as Connection;
const mcp = (name: string, input: Record<string, unknown>): ChatEntry =>
  ({ key: name, kind: 'tool', md: '', name, input, result: { ok: true, text: 'ok' } }) as unknown as ChatEntry;

afterEach(() => act(() => applyUiMode('code')));

describe('MCP 工具行', () => {
  it('编程模式:参数照常显示(内置/第三方同)', () => {
    const r = render(
      <>
        <ToolEntryView entry={mcp('mcp__computer-use__screenshot', { display: null, region: null })} conn={conn} sessionId="s" />
        <ToolEntryView entry={mcp('mcp__weather__get_forecast', { city: 'Beijing' })} conn={conn} sessionId="s" />
      </>,
    );
    const rows = [...r.container.querySelectorAll('.entry-tool .tool-summary')].map((el) => el.textContent);
    expect(rows).toEqual(['Screenshot {"display":null,"region":null}', 'get_forecast {"city":"Beijing"}']);
  });

  it('办公模式:只显工具名不显参数,第三方显「Ran 工具名」', () => {
    act(() => applyUiMode('office'));
    const r = render(
      <>
        <ToolEntryView entry={mcp('mcp__computer-use__screenshot', { display: null, region: null })} conn={conn} sessionId="s" />
        <ToolEntryView entry={mcp('mcp__weather__get_forecast', { city: 'Beijing' })} conn={conn} sessionId="s" />
      </>,
    );
    const rows = [...r.container.querySelectorAll('.entry-tool .tool-summary')].map((el) => el.textContent);
    expect(rows).toEqual(['Screenshot', 'Ran get_forecast']);
  });

  it.each(['code', 'office'] as const)('%s 模式:阶段正文正常显示', (mode) => {
    act(() => applyUiMode(mode));
    const r = render(<ChatEntryView entry={{ key: 'p', kind: 'assistant', md: 'Taking a screenshot to read the screen.' }} />);
    expect(r.container.querySelector('.entry-assistant')!.textContent).toContain('Taking a screenshot to read the screen.');
  });
});

describe('内置插件操作说明 purpose(2026-11-07 用户裁定)', () => {
  it.each(['code', 'office'] as const)('%s 模式:有 purpose 即整行标题,替换工具名+参数;第三方 MCP 的 purpose 字段不当标题', (mode) => {
    act(() => applyUiMode(mode));
    const r = render(
      <>
        <ToolEntryView entry={mcp('mcp__computer-use__screenshot', { purpose: '截屏确认弹窗已关闭', display: null, region: null })} conn={conn} sessionId="s" />
        <ToolEntryView entry={mcp('mcp__browser-use__browser_navigate', { purpose: '  Open the\nlogin page ', url: 'https://x.test' })} conn={conn} sessionId="s" />
        <ToolEntryView entry={mcp('mcp__weather__get_forecast', { purpose: 'x', city: 'Beijing' })} conn={conn} sessionId="s" />
      </>,
    );
    const rows = [...r.container.querySelectorAll('.entry-tool .tool-summary')].map((el) => el.textContent);
    expect(rows[0]).toBe('截屏确认弹窗已关闭');
    expect(rows[1]).toBe('Open the login page'); // 空白折叠
    expect(rows[2]).not.toBe('x');
  });

  it('缺 purpose(旧档/模型漏传)回落工具名+参数', () => {
    const r = render(<ToolEntryView entry={mcp('mcp__computer-use__screenshot', { display: null })} conn={conn} sessionId="s" />);
    expect(r.container.querySelector('.tool-summary')!.textContent).toBe('Screenshot {"display":null}');
  });

  it('展开体不变:仍列 server·tool 与插件真实收到的参数(purpose 不进 params)', () => {
    const r = render(<ToolEntryView entry={mcp('mcp__computer-use__click', { purpose: '点击确定', x: 10, y: 20 })} conn={conn} sessionId="s" />);
    fireEvent.click(r.container.querySelector('.tool-summary')!);
    const body = r.container.querySelector('.tool-exec')!.textContent ?? '';
    expect(body).toContain('computer-use');
    expect(body).toContain('click');
    expect(body).toContain('"x": 10');
    expect(body).not.toContain('purpose');
  });
});

describe('exec 操作说明 purpose(2026-11-07 用户裁定)', () => {
  const exec = (input: Record<string, unknown>): ChatEntry =>
    ({ key: 'x', kind: 'tool', md: '', name: 'exec', input, result: { ok: true, text: 'ok' } }) as unknown as ChatEntry;
  const row = (input: Record<string, unknown>): string => {
    const r = render(<ToolEntryView entry={exec(input)} conn={conn} sessionId="s" />);
    const text = r.container.querySelector('.tool-summary')!.textContent ?? '';
    r.unmount();
    return text;
  };

  it('编程模式:有说明=说明+命令明细;无说明(null/缺省/空串)=执行+命令明细', () => {
    expect(row({ purpose: '查找切会话相关的提交', command: 'git log --oneline | grep switch' })).toBe('查找切会话相关的提交 git log --oneline | grep switch');
    expect(row({ purpose: null, command: 'git status' })).toBe('Exec git status');
    expect(row({ command: 'git status' })).toBe('Exec git status');
    expect(row({ purpose: '  ', command: 'ls' })).toBe('Exec ls');
  });

  it('办公模式:有说明只显说明(去掉命令明细);无说明照旧「执行了命令」', () => {
    act(() => applyUiMode('office'));
    expect(row({ purpose: '查找切会话相关的提交', command: 'git log --oneline' })).toBe('查找切会话相关的提交');
    expect(row({ purpose: null, command: 'git log --oneline' })).toBe('Ran a command');
  });
});

describe('后台 exec 任务名解析(purpose 优先,2026-11-07)', () => {
  const bg = (key: string, input: Record<string, unknown>, receipt: string): ChatEntry =>
    ({ key, kind: 'tool', md: '', name: 'exec', input, result: { ok: true, text: receipt } }) as unknown as ChatEntry;
  const entries = [
    bg('k1', { purpose: '启动开发服务器', command: 'npm run dev', background: true }, 'task dev-1 started (output: x)'),
    bg('k2', { purpose: null, command: 'sleep 99' }, 'command moved to background after timeout: task slp-2 (output: y)'),
    bg('k3', { purpose: '跑全量测试', command: 'pnpm test' }, 'command moved to background after timeout: task tst-3 (output: z)'),
  ];
  it('等待行名:有 purpose 显任务名,无则命令原文;办公模式解析只认具名任务', () => {
    const name = taskNameResolverOf(entries, undefined);
    expect(name('dev-1')).toBe('启动开发服务器');
    expect(name('slp-2')).toBe('sleep 99');
    expect(name('tst-3')).toBe('跑全量测试');
    const ref = taskAgentResolverOf(entries);
    expect(ref('dev-1')).toEqual({ name: '启动开发服务器', kind: 'exec' });
    expect(ref('tst-3')).toEqual({ name: '跑全量测试', kind: 'exec' });
    expect(ref('slp-2')).toBeUndefined();
  });
});
