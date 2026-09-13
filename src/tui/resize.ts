/**
 * 终端 resize 防抖器（纯逻辑、零依赖，独立单测）：
 * 原始 resize 事件在拖拽窗口时会高频连发（每像素一级），直接每次都整屏重绘会闪烁与卡顿；
 * 防抖只认「安静窗口」结束后的最后一次事件，且首事件立即执行（首次进入即修正布局，不等窗口安静）。
 */
export interface ResizeDebouncer {
  /** 每次 resize 事件调用；返回 true 表示本次应立即执行重绘（首个事件），否则进入防抖等待 */
  bump(): boolean;
  /** 防抖窗口到期回调挂载点：由宿主在 bump() 返回 false 后调度，到期时调用 fire() */
  fire(): void;
  /** 当前累计 bump 次数（测试观测用） */
  bumps(): number;
}

/** 防抖窗口（毫秒）：拖拽结束后 200ms 内无新事件才重绘 */
export const RESIZE_DEBOUNCE_MS = 200;

export function createResizeDebouncer(): ResizeDebouncer {
  let first = true;
  let count = 0;
  return {
    bump(): boolean {
      count += 1;
      if (first) {
        first = false;
        return true;
      }
      return false;
    },
    fire(): void {
      // 语义仅为「防抖窗口到期、执行重绘」；重置 first 使极快连续两次缩放（<窗口间隔）也能各得一次立即重绘
      first = true;
    },
    bumps: () => count,
  };
}

/** resize 事件源最小接口（真实 TTY 与 EventEmitter 测试替身均可满足） */
export interface ResizeSource {
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}

export interface ResizeGate {
  dispose(): void;
}

/**
 * 订阅 resize 并收敛为重绘时机：首事件立即重绘（单击缩放/最大化一步到位），
 * 拖拽连发进入防抖——安静 RESIZE_DEBOUNCE_MS 后重绘一次。重绘动作由宿主提供
 * （清屏 + 重挂渲染树全量重绘，见 entry.ts），本模块只负责事件收敛与注销。
 */
export function createResizeGate(opts: {
  source: ResizeSource;
  onRepaint: () => void;
  debounceMs?: number;
}): ResizeGate {
  const debouncer = createResizeDebouncer();
  const ms = opts.debounceMs ?? RESIZE_DEBOUNCE_MS;
  let timer: NodeJS.Timeout | undefined;
  const listener = (): void => {
    if (debouncer.bump()) {
      opts.onRepaint();
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      debouncer.fire();
      opts.onRepaint();
    }, ms);
  };
  opts.source.on('resize', listener);
  return {
    dispose(): void {
      opts.source.off('resize', listener);
      if (timer) clearTimeout(timer);
    },
  };
}
