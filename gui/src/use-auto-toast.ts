import { useEffect, useRef, useState } from 'react';

/** 3s 自隐 toast 单点（2026-11-22 裁定「测试结果居中 toast 3s 自隐」形态的家族收敛，D113：原
 *  SettingsForm/GlobalRulesPane/RawPane/ProvidersPane/ChannelsPane/StoragePane 六份 pane 级
 *  「state + timer ref + 连续触发重置 + 卸载兜底清」手写克隆收敛此 hook）。showToast 重置计时、
 *  clearToast 即清（读面重置等主动清场消费）、卸载清句柄；展示标记（className/文案）留各 pane。
 *  泛型值：字符串 toast 与 {ok,text} 双语对象 toast 两形皆承载。 */
export function useAutoToast<T>(clearAfterMs = 3_000): { toast: T | null; showToast: (v: T) => void; clearToast: () => void } {
  const [toast, setToast] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (v: T): void => {
    setToast(v);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), clearAfterMs);
  };
  const clearToast = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setToast(null);
  };
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  return { toast, showToast, clearToast };
}
