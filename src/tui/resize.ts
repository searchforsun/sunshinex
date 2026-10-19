/**
 * 终端 resize 收敛器（纯逻辑、零依赖，独立单测）：
 * 原始 resize 事件在拖拽窗口时会高频连发（每像素一级）。2026-10-19 起「冻结-重放」改制
 * （真机：拖拽中瞬时宽度的全量重放与 conpty 异步 resync 互相踩踏 → 重复渲染/布局混乱）：
 * - 拖拽首事件 → **冻结**（宿主卸载渲染实例，静态区定格、拖拽期零重渲染）；
 * - 安静 RESIZE_DEBOUNCE_MS → **重放**（一次性清屏 + 整屏重放，最终态收敛的既有路径）。
 * 未提供 onFreeze 的宿主退回旧语义（首事件立即重绘）。
 */

/** 防抖窗口（毫秒）：拖拽结束后 200ms 内无新事件才重放 */
export const RESIZE_DEBOUNCE_MS = 200;

/** resize 事件源最小接口（真实 TTY 与 EventEmitter 测试替身均可满足） */
export interface ResizeSource {
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}

interface ResizeGate {
  dispose(): void;
}

/**
 * 订阅 resize 并收敛为「冻结 → 重放」两拍：突发首事件调 onFreeze（卸载定格），安静
 * RESIZE_DEBOUNCE_MS 后调 onRepaint（清屏重放）。dispose 注销订阅并撤销未到期的定时器。
 */
export function createResizeGate(opts: {
  source: ResizeSource;
  onRepaint: () => void;
  /** 拖拽首事件冻结回调（宿主卸载渲染实例）；缺省退回旧「首事件立即重绘」语义 */
  onFreeze?: () => void;
  debounceMs?: number;
}): ResizeGate {
  const ms = opts.debounceMs ?? RESIZE_DEBOUNCE_MS;
  let timer: NodeJS.Timeout | undefined;
  const listener = (): void => {
    if (timer === undefined) {
      // 突发首事件：冻结定格（无冻结宿主 = 旧语义立即重绘）
      if (opts.onFreeze) opts.onFreeze();
      else opts.onRepaint();
    } else {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
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
