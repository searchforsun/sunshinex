import { useRef, useState } from 'react';

/**
 * 会话级操作失败提示 hook(2026-10-27 技术债轮 D53 批E 自 App.tsx 外提,行为零变化):
 * fork/rewind 等旁路操作失败经 sx-toast 底部浮出 3s 自隐(设置页同形态)——旁路失败此前
 * 零反馈,用户点「分叉/回到此轮」无响应会误以为成功(D30 可见化口径)。
 */
export function useOpError(): { opError: string; showOpError: (err: unknown) => void } {
  const [opError, setOpError] = useState('');
  const opErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showOpError = (err: unknown): void => {
    setOpError(err instanceof Error ? err.message : String(err));
    if (opErrorTimer.current !== null) clearTimeout(opErrorTimer.current);
    opErrorTimer.current = setTimeout(() => setOpError(''), 3_000);
  };
  return { opError, showOpError };
}
