import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ToolEntryView } from './ToolEntry';
import type { ChatEntry } from '../../chat-reducer';
import type { Connection } from '../../connection';
import { applyDeveloperMode } from '../../developer-mode';

/** 2026-11-26 用户裁定「发送消息后面跟上目标 sunx 蓝色名字，点击可以跳转到指定气泡。展开就是具体的
 *  sunx 信息」：send_sunx_messages 折叠行=动词+目标实例蓝色名（投递回执解析），点击回调带目标
 *  journalId+正文；展开体=目标 Sunx（名称+寻址 id）+正文。 */
beforeEach(() => applyDeveloperMode(true));
afterEach(() => applyDeveloperMode(false));

const conn = {} as Connection;

function sendEntry(resultText = 'message delivered to 李明 (jid-b) - run started'): ChatEntry {
  return {
    key: 'k9',
    kind: 'tool',
    md: '',
    name: 'send_sunx_messages',
    input: { to: 'jid-b', text: '乙已回执，收到甲的消息=是' },
    ...(resultText !== '' ? { result: { ok: true, text: resultText } } : {}),
  } as unknown as ChatEntry;
}

describe('发送 Sunx 消息行(目标蓝色名+气泡跳转+展开信息)', () => {
  it('折叠行=动词+目标实例名;点名字回调 (journalId, 正文)', () => {
    const onOpenSunxBubble = vi.fn();
    const r = render(<ToolEntryView entry={sendEntry()} conn={conn} sessionId="s" onOpenSunxBubble={onOpenSunxBubble} />);
    const summary = r.container.querySelector('.tool-summary')!;
    expect(summary.textContent).toContain('李明');
    expect(summary.textContent).not.toContain('乙已回执'); // 正文不进折叠行
    fireEvent.click(summary.querySelector('.tool-agent-link')!);
    expect(onOpenSunxBubble).toHaveBeenCalledWith('jid-b', '乙已回执，收到甲的消息=是');
  });

  it('展开体=目标 Sunx(名称+id)+正文(用户裁定「展开就是具体的 sunx 信息」)', () => {
    const r = render(<ToolEntryView entry={sendEntry()} conn={conn} sessionId="s" onOpenSunxBubble={() => undefined} />);
    fireEvent.click(r.container.querySelector('.tool-summary')!);
    const body = r.container.querySelector('.tool-md')?.textContent ?? '';
    expect(body).toMatch(/目标 Sunx|Target Sunx/);
    expect(body).toContain('李明 (jid-b)');
    expect(body).toContain('乙已回执，收到甲的消息=是');
  });

  it('回执未到(运行中):只显动词,不显 id/名字;无跳转通道时名字纯文本', () => {
    const running = { ...sendEntry(''), result: undefined, status: 'running' } as unknown as ChatEntry;
    const first = render(<ToolEntryView entry={running} conn={conn} sessionId="s" onOpenSunxBubble={() => undefined} />);
    const summary = first.container.querySelector('.tool-summary')!.textContent ?? '';
    expect(summary).not.toContain('jid-b');
    expect(summary).not.toContain('李明');
    first.unmount();
    // 无跳转通道：名字在但不可点
    const second = render(<ToolEntryView entry={sendEntry()} conn={conn} sessionId="s" />);
    expect(second.container.querySelector('.tool-summary')!.textContent).toContain('李明');
    expect(second.container.querySelector('.tool-summary .tool-agent-link')).toBeNull();
  });
});
