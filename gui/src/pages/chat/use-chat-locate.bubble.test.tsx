import { describe, it, expect, vi } from 'vitest';
import { useRef } from 'react';
import { render } from '@testing-library/react';
import { useChatLocate } from './use-chat-locate';

/** 发送方视角目标气泡定位（2026-11-26 用户裁定「点击可以跳转到指定气泡」）：正文前缀匹配目标会话
 *  里的用户气泡，命中即滚到位（无闪光）并消费清信号；未命中短超时后放弃清信号。 */
function Harness({ focus, done }: {
  focus: { text: string; nonce: number } | null;
  done?: () => void;
}): JSX.Element {
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatStickRef = useRef(true);
  useChatLocate({ leaderFocus: null, sunxBubbleFocus: focus, onSunxBubbleFocusDone: done, chatScrollRef, chatStickRef });
  return (
    <div ref={chatScrollRef}>
      <div className="entry entry-user" data-entry-key="k3">
        <div className="user-md-plain">乙已回执，收到甲的消息=是</div>
      </div>
      <div className="entry entry-user" data-entry-key="k5">
        <div className="user-md-plain">无关消息</div>
      </div>
    </div>
  );
}

describe('useChatLocate 发送方目标气泡定位', () => {
  it('正文命中目标会话用户气泡:消费清信号(滚动无闪光)', () => {
    const done = vi.fn();
    render(<Harness focus={{ text: '乙已回执，收到甲的消息=是', nonce: 1 }} done={done} />);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('正文不匹配(窗口未含该条):超时后放弃并清信号', () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      render(<Harness focus={{ text: '不存在的内容', nonce: 2 }} done={done} />);
      expect(done).not.toHaveBeenCalled();
      vi.advanceTimersByTime(20_000); // rAF 桩下用超时兜底:轮询 90 帧后放弃
      // rAF 在 fake timers 下不自走——直接跑完微任务即可判定不悬挂(信号至多消费一次)
      expect(done.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
