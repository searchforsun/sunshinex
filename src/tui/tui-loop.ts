import { createResizeGate, ResizeSource } from './resize';
import { initialRetained, RetainedUiState } from './ui-state';

/** ink 实例最小接口（便于测试注入替身） */
export interface InkLikeInstance {
  waitUntilExit(): Promise<void>;
  unmount(): void;
}

/** 重绘模式：full=卸载→清屏→整屏重放（resize/Tab/全屏接管）；tail=光标上移+就地擦写只重放
 *  变化尾部（2026-09-30 方案 A——段折叠闪屏消除，前缀滚动缓冲原样保留、零空白帧） */
export type RepaintMode = 'full' | 'tail';

export interface TuiLoopDeps {
  /** 首挂 retain 初值补丁（--continue 恢复的输入历史与视图两态；buffer/cursor 易失不还原——规格 D6 边界） */
  initialRetain?: Partial<RetainedUiState>;
  /** resize 事件源（真实 TTY stdout 或测试 EventEmitter） */
  stdout: ResizeSource;
  /** 重绘前的整屏清理（清屏 + 归位光标）；清理后重挂使 Static 历史重放一次、动态区按新宽度重排 */
  clearScreen(): void;
  /** 原始终端写出（同步更新序列载体）；缺省直写 stdout */
  writeRaw?(s: string): void;
  /** 渲染一次交互面；retain 为跨重挂现场（挂载读初值、变化实时回写） */
  renderOnce(retain: RetainedUiState): InkLikeInstance;
  /** 宿主注册「请求整屏重绘」出口：Tab 展开模式切换等非 resize 场景复用同一卸载→清屏→重挂路径 */
  onRequestRepaint?: (request: (mode?: RepaintMode) => void) => void;
  /** 防抖窗口覆盖（测试压短用；缺省 200ms，见 resize.ts） */
  debounceMs?: number;
  /** 动态帧高度嗅探（tail 模式可达性判定的分母之一）；缺省恒 undefined=tail 一律回落全量 */
  frameLines?: () => number | undefined;
  /** 终端行数（tail 可达性判定：擦写起点须在视口内）；缺省 24 */
  rows?: () => number;
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
  let repaintQueued: RepaintMode | undefined;
  let current: InkLikeInstance | undefined;
  // resize 与 Tab 模式切换共用同一条「卸载 → 清屏 → 重挂」路径：Static 历史按当前模式整屏重放
  // 重绘模式升级钉：已排队的 full 不被后续 tail 降级（full 语义覆盖面更广）
  const requestRepaint = (mode: RepaintMode = 'full'): void => {
    repaintQueued = repaintQueued === 'full' ? 'full' : mode;
    current?.unmount();
  };
  const gate = createResizeGate({
    source: deps.stdout,
    debounceMs: deps.debounceMs,
    onRepaint: () => requestRepaint('full'),
  });
  deps.onRequestRepaint?.(requestRepaint);
  try {
    let first = true;
    do {
      const mode: RepaintMode | undefined = !first ? (repaintQueued ?? 'full') : undefined;
      first = false;
      repaintQueued = undefined;
      // 尾部原位重写（方案 A）：账本 plan 给出首个变化条目与其上方已打印行数，帧高嗅探给出
      // 动态区高度——两者之和即擦写起点距光标的行距；可达（在视口内）即上移就地擦写、
      // 重挂只重放变化尾部（屏上前缀原样保留）。任一前置缺失/不可达回落全量路径（安全降级）
      const plan = retain.tailLedger !== undefined && !retain.tailLedger.forceFull ? retain.tailLedger.plan : null;
      const frameH = deps.frameLines?.();
      const termRows = deps.rows?.() ?? 24;
      if (mode === 'tail' && plan !== null && frameH !== undefined && plan.suffixLines + frameH <= termRows - 1) {
        writeRaw(`\u001b[?2026h\u001b[${plan.suffixLines + frameH}A\u001b[J\u001b[?2026l`);
        retain.rewriteFrom = plan.from;
        current = deps.renderOnce(retain);
        retain.rewriteFrom = undefined;
      } else if (mode !== undefined) {
        retain.rewriteFrom = undefined;
        writeRaw('\u001b[?2026h');
        deps.clearScreen();
        current = deps.renderOnce(retain);
        writeRaw('\u001b[?2026l');
      } else {
        current = deps.renderOnce(retain);
      }
      await current.waitUntilExit();
    } while (repaintQueued !== undefined);
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
  // A/B 验证开关（2026-09-30 真机「按键已派发但画面冻结」假设）：SUNSHINEX_NO_SYNC_WRAP=1 直通。
  // 假设：WT 对高频 2026h/2026l 成对开合失步（终端视觉冻结至某次幸运刷新，键位日志已证状态机正常）。
  // 直通则回到逐帧裸写（无冻结但可能闪灼）——用户实测二选一即可定位
  if (process.env.SUNSHINEX_NO_SYNC_WRAP === '1') return;
  const orig = stream.write.bind(stream);
  stream.write = (...args: unknown[]): unknown => {
    const chunk = args[0];
    if (typeof chunk === 'string' && !chunk.includes('\u001b[?2026h')) {
      return orig(`\u001b[?2026h${chunk}\u001b[?2026l`, ...args.slice(1));
    }
    return orig(...args);
  };
}
