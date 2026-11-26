import { describe, it, expect, vi } from 'vitest';
import { useRef } from 'react';
import { render } from '@testing-library/react';
import { useChatLocate } from './use-chat-locate';

/** 跨 Sunx 归因定位（2026-11-26 用户裁定「点击气泡上蓝色 sunx 名字定位到对应发送气泡的轮次中」）：
 *  信号命中本会话 → 滚到发送方 run 条目（data-entry-key=k<runSeq>）并闪光；一次性消费（onDone 清信号） */
function Harness({ focus, journalId, done }: {
  focus: { journalId: string; runSeq: number; nonce: number } | null;
  journalId?: string;
  done?: () => void;
}): JSX.Element {
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatStickRef = useRef(true);
  useChatLocate({ leaderFocus: null, sunxPeerFocus: focus, journalId, entriesTick: 1, onSunxPeerFocusDone: done, chatScrollRef, chatStickRef });
  return (
    <div ref={chatScrollRef}>
      <div className="entry entry-run" data-entry-key="k12" />
      <div className="entry entry-run" data-entry-key="k20" />
    </div>
  );
}

describe('useChatLocate 跨 Sunx 归因定位', () => {
  it('命中发送轮 run 行:闪光标记 + 撤贴底 + 消费清信号', () => {
    const done = vi.fn();
    const { container } = render(<Harness focus={{ journalId: 'j1', runSeq: 12, nonce: 1 }} journalId="j1" done={done} />);
    const row = container.querySelector('[data-entry-key="k12"]')!;
    expect(row.classList.contains('chat-locate-flash')).toBe(true);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('journalId 不匹配(别的会话)不动', () => {
    const done = vi.fn();
    const { container } = render(<Harness focus={{ journalId: 'j1', runSeq: 12, nonce: 1 }} journalId="j2" done={done} />);
    expect(container.querySelector('.chat-locate-flash')).toBeNull();
    expect(done).not.toHaveBeenCalled();
  });

  it('目标轮未挂载:短超时后放弃并清信号(不悬挂重复跳转)', () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      render(<Harness focus={{ journalId: 'j1', runSeq: 99, nonce: 1 }} journalId="j1" done={done} />);
      expect(done).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2500);
      expect(done).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
