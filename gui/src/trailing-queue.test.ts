import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTrailingQueue } from './trailing-queue';

/** P1 Task 8:App 级后台帧节流——100ms 窗合并尾随触发;flush 同步排空;dispose 弃投 */

afterEach(() => {
  vi.useRealTimers();
});

describe('createTrailingQueue', () => {
  it('100ms 窗内多次 push 合并为一次 apply(尾随)', () => {
    vi.useFakeTimers();
    const seen: number[][] = [];
    const q = createTrailingQueue<number>((xs) => seen.push([...xs]), 100);
    q.push(1);
    q.push(2);
    q.push(3);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([[1, 2, 3]]);
    q.push(4);
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([
      [1, 2, 3],
      [4],
    ]);
    q.dispose();
  });

  it('flush 同步排空(窗中途取权威终态);dispose 后窗尾不 apply;空缓冲 flush 零 apply', () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const q = createTrailingQueue<string>((xs) => seen.push(xs.join('|')), 100);
    q.push('a');
    q.flush();
    expect(seen).toEqual(['a']);
    // flush 已清在途 timer;再 push 起新窗,dispose 弃之——窗尾不 apply
    q.push('b');
    q.dispose();
    vi.advanceTimersByTime(200);
    expect(seen).toEqual(['a']);
    q.flush(); // dispose 后 flush 亦空转(空缓冲零 apply)
    expect(seen).toEqual(['a']);
  });

  it('dispose 弃缓冲清 timer 不 apply(卸载面)', () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const q = createTrailingQueue<number>((xs) => seen.push(...xs), 100);
    q.push(1);
    q.dispose();
    vi.advanceTimersByTime(200);
    expect(seen).toEqual([]);
    q.flush(); // dispose 后 flush 亦空转
    expect(seen).toEqual([]);
  });
});
