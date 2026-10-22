import { useCallback, useEffect, useRef, useState } from 'react';

/** 复制回显自动回 idle 时长（六处手写统一前值：✓ 可辨识又不恋屏的最短确认窗） */
export const COPY_RESET_MS = 1500;

export type CopyStatus = 'idle' | 'ok' | 'fail';

/**
 * 复制回显单点（D45 收敛：CodeBlock/MermaidBlock/RunFooter/Files/AgentTranscriptTab/
 * UserEntryView 六处手写 copied state+timer+卸载清理同构块）：copy(text) 写剪贴板，落定翻
 * ok/fail，resetMs 后回 idle，卸载清定时器。失败面映射——布尔消费方（tip 只分复制/已复制）
 * fail 与 idle 同显「复制」（原失败静默语义），三态消费方（UserEntryView）经 status 直读
 * 「未复制」。
 */
export function useCopyFeedback(resetMs: number = COPY_RESET_MS): { status: CopyStatus; copy: (text: string) => void } {
  const [status, setStatus] = useState<CopyStatus>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    (text: string): void => {
      navigator.clipboard?.writeText(text).then(
        () => setStatus('ok'),
        () => setStatus('fail'),
      );
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setStatus('idle'), resetMs);
    },
    [resetMs],
  );
  return { status, copy };
}
