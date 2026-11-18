import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCollapseTransition } from './use-collapse-transition';

/** 面板开合过渡(2026-11-18 用户裁定「展开和关闭要平滑」):关闭保留挂载一个过渡窗后再卸载,
 *  打开立即挂载;窗口期内重开则取消卸载 */

describe('useCollapseTransition', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('初始开:挂载、非收起中', () => {
    const { result } = renderHook(() => useCollapseTransition(true));
    expect(result.current).toEqual({ mounted: true, closing: false });
  });

  it('关闭:先挂载并标收起中,过渡窗走完才卸载', () => {
    const { result, rerender } = renderHook(({ open }) => useCollapseTransition(open, 200), { initialProps: { open: true } });
    rerender({ open: false });
    expect(result.current).toEqual({ mounted: true, closing: true });
    act(() => vi.advanceTimersByTime(199));
    expect(result.current.mounted).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toEqual({ mounted: false, closing: false });
  });

  it('过渡窗内重开:取消卸载,回到展开态', () => {
    const { result, rerender } = renderHook(({ open }) => useCollapseTransition(open, 200), { initialProps: { open: true } });
    rerender({ open: false });
    rerender({ open: true });
    expect(result.current).toEqual({ mounted: true, closing: false });
    act(() => vi.advanceTimersByTime(300));
    expect(result.current).toEqual({ mounted: true, closing: false });
  });

  it('初始关:根本不挂载', () => {
    const { result } = renderHook(() => useCollapseTransition(false));
    expect(result.current).toEqual({ mounted: false, closing: false });
  });
});
