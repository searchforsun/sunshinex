/** P1 Task 8:App 级后台帧节流尾随队列——ms 窗内 push 合并、窗尾一次 apply(尾随触发)。
 *  消费面:use-connection-wiring 的 live 板/委派/子智能体投影路径(流式突发帧高频 setState 的
 *  收敛面);水合/播种回放路径(权威终态)旁路直投,不经本队列。单 timer 在途守卫:窗内后续 push
 *  只入缓冲不另起表;flush 同步排空供权威读面;dispose 弃缓冲清 timer(卸载面) */
export function createTrailingQueue<T>(apply: (items: T[]) => void, ms: number): { push(item: T): void; flush(): void; dispose(): void } {
  let buf: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const drain = (): void => {
    timer = null;
    if (buf.length === 0) return;
    const items = buf;
    buf = [];
    apply(items);
  };
  return {
    push(item: T): void {
      buf.push(item);
      if (timer === null) timer = setTimeout(drain, ms);
    },
    flush(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      drain();
    },
    dispose(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      buf = [];
    },
  };
}
