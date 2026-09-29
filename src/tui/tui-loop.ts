import { createResizeGate, ResizeSource } from './resize';
import { initialRetained, RetainedUiState } from './ui-state';

/** ink 实例最小接口（便于测试注入替身） */
export interface InkLikeInstance {
  waitUntilExit(): Promise<void>;
  unmount(): void;
}

export interface TuiLoopDeps {
  /** 首挂 retain 初值补丁（--continue 恢复的输入历史与视图两态；buffer/cursor 易失不还原——规格 D6 边界） */
  initialRetain?: Partial<RetainedUiState>;
  /** resize 事件源（真实 TTY stdout 或测试 EventEmitter） */
  stdout: ResizeSource;
  /** 重挂前的整屏清理（清屏 + 归位光标）；清理后重挂使 Static 历史重放一次、动态区按新宽度重排 */
  clearScreen(): void;
  /** 原始终端写出（同步更新序列载体）；缺省直写 stdout */
  writeRaw?(s: string): void;
  /** 渲染一次交互面；retain 为跨重挂现场（挂载读初值、变化实时回写） */
  renderOnce(retain: RetainedUiState): InkLikeInstance;
  /** 宿主注册「请求整屏重绘」出口：Tab 展开模式切换等非 resize 场景复用同一卸载→清屏→重挂路径 */
  onRequestRepaint?: (request: () => void) => void;
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
  const retain: RetainedUiState = { ...initialRetained(), ...deps.initialRetain };
  // 重绘换帧以 DEC 2026 同步更新包裹为原子操作：终端持有旧帧直到重放完成一次性切换，
  // 消除「清屏空屏 → Static 重放」中间帧的闪屏观感；不识别该序列的终端静默忽略、行为同旧路径
  const writeRaw = deps.writeRaw ?? ((s: string): void => { process.stdout.write(s); });
  let repaintQueued = false;
  let current: InkLikeInstance | undefined;
  // resize 与 Tab 模式切换共用同一条「卸载 → 清屏 → 重挂」路径：Static 历史按当前模式整屏重放
  const requestRepaint = (): void => {
    repaintQueued = true;
    current?.unmount();
  };
  const gate = createResizeGate({
    source: deps.stdout,
    debounceMs: deps.debounceMs,
    onRepaint: requestRepaint,
  });
  deps.onRequestRepaint?.(requestRepaint);
  try {
    let first = true;
    do {
      const isRepaint = !first;
      first = false;
      repaintQueued = false;
      if (isRepaint) {
        writeRaw('\u001b[?2026h');
        deps.clearScreen();
        current = deps.renderOnce(retain);
        writeRaw('\u001b[?2026l');
      } else {
        current = deps.renderOnce(retain);
      }
      await current.waitUntilExit();
    } while (repaintQueued);
  } finally {
    gate.dispose();
    current?.unmount();
  }
}

/** 全帧逐写原子化（2026-09-28 流式/全屏闪屏扩展）：DEC 2026 同步更新原只覆盖整屏 repaint 路径，
 *  ink 逐帧「擦除+重写」裸出——动态区任一行变化即全帧重写（session 合帧窗口注释自证无逐行 diff），
 *  擦写序列中间态肉眼可见即持续闪屏。装配期对流式输出做逐写包裹：每帧写原子化，终端持旧帧到整帧
 *  落定；已含 2026h 的写（repaint 路径自包）不重复包裹，不识别该序列的终端静默忽略零劣化 */
export function installSyncUpdateWrap(stream: { write: (...args: unknown[]) => unknown }): void {
  const orig = stream.write.bind(stream);
  stream.write = (...args: unknown[]): unknown => {
    const chunk = args[0];
    if (typeof chunk === 'string' && !chunk.includes('\u001b[?2026h')) {
      return orig(`\u001b[?2026h${chunk}\u001b[?2026l`, ...args.slice(1));
    }
    return orig(...args);
  };
}
