import { createResizeGate, ResizeSource } from './resize';
import { initialRetained, RetainedUiState } from './ui-state';

/** ink 实例最小接口（便于测试注入替身） */
export interface InkLikeInstance {
  waitUntilExit(): Promise<void>;
  unmount(): void;
}

export interface TuiLoopDeps {
  /** resize 事件源（真实 TTY stdout 或测试 EventEmitter） */
  stdout: ResizeSource;
  /** 重挂前的整屏清理（清屏 + 归位光标）；清理后重挂使 Static 历史重放一次、动态区按新宽度重排 */
  clearScreen(): void;
  /** 渲染一次交互面；retain 为跨重挂现场（挂载读初值、变化实时回写） */
  renderOnce(retain: RetainedUiState): InkLikeInstance;
  /** 防抖窗口覆盖（测试压短用；缺省 200ms，见 resize.ts） */
  debounceMs?: number;
}

/**
 * TUI 渲染循环：常态单实例常驻；resize 时「卸载 → 清屏 → 重挂」整屏重绘。
 * 根因：ink3 对 resize 只做原位重绘，其擦除按「上一帧行数」计数——终端 reflow 后行数失配，
 * 旧帧擦不净，思考流等多行动态区反复叠影；重挂让 Static 历史重放、动态区重建，残帧归零。
 * 时机：首个 resize 立即重绘（单击缩放/最大化一步到位），拖拽连发按防抖窗口收敛为一次。
 * 输入/视图现场经 retain 跨重挂保留（App 挂载读初值、变化实时回写）。
 */
export async function runTuiLoop(deps: TuiLoopDeps): Promise<void> {
  const retain = initialRetained();
  let repaintQueued = false;
  let current: InkLikeInstance | undefined;
  const gate = createResizeGate({
    source: deps.stdout,
    debounceMs: deps.debounceMs,
    onRepaint: () => {
      repaintQueued = true;
      current?.unmount();
    },
  });
  try {
    let first = true;
    do {
      const isRepaint = !first;
      first = false;
      repaintQueued = false;
      if (isRepaint) deps.clearScreen();
      current = deps.renderOnce(retain);
      await current.waitUntilExit();
    } while (repaintQueued);
  } finally {
    gate.dispose();
    current?.unmount();
  }
}
