import { useCallback, useEffect, useState } from 'react';
import { withMinSpin } from './ui-util';

/**
 * 只读拉取骨架单点（D93② 收敛：InsightTabs 私有 useFetch 与 PlansTab 手写体同构——
 * withMinSpin 拉取+alive 竞态守卫+tick/reload 手动刷新+error/fetching 二态）。deps 展开
 * 进重拉 effect（随 tick 一起）；refreshNonce（正文/顶栏打开侧栏主动刷一次）与 catalogNonce
 * （catalog-changed 清单变点）变化即 bump tick 重拉。多消费面：InsightTabs 三面板/PlansTab。
 */
export function useFetch<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  opts?: { refreshNonce?: number; catalogNonce?: number },
): { data: T | null; error: string; reload: () => void; fetching: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [fetching, setFetching] = useState(true);
  const reload = useCallback(() => setTick((v) => v + 1), []);
  useEffect(() => {
    let alive = true;
    setFetching(true);
    withMinSpin(fn()).then(
      (d) => {
        if (alive) {
          setData(d);
          setError('');
          setFetching(false);
        }
      },
      (err: unknown) => {
        if (alive) {
          setError(err instanceof Error ? err.message : String(err));
          setFetching(false);
        }
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  // 正文/顶栏打开侧栏:主动刷一次
  useEffect(() => {
    if (opts?.refreshNonce === undefined) return;
    setTick((v) => v + 1);
  }, [opts?.refreshNonce]);
  // catalog-changed 直播:清单变点重拉
  useEffect(() => {
    if (opts?.catalogNonce === undefined) return;
    setTick((v) => v + 1);
  }, [opts?.catalogNonce]);
  return { data, error, reload, fetching };
}
