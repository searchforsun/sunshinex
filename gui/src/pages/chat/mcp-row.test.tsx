import { describe, it, expect, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { ToolEntryView } from './ToolEntry';
import { ChatEntryView } from './EntryViews';
import { applyUiMode } from '../../ui-mode';
import type { ChatEntry } from '../../chat-reducer';
import type { Connection } from '../../connection';

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
