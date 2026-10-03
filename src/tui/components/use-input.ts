import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import * as React from 'react';
import { Key, useStdin } from 'ink';

/**
 * ink3 useInput 复刻补丁：与原版唯一差异——功能键不再清空 input。
 * 背景：原版把 \u001B[3~（⌦）与 \u007F（退格）都归并进 key.delete 并清空 input，
 * 无法区分退格与真 Delete；本补丁以 raw 保留原始字节供分发层精确分流。
 * 其余解析（方向键/控制字符转 ctrl/ESC 转 meta/Ctrl+C 退出语义）与 ink3 逐行一致。
 */
export interface RawKey extends Key {
  /** 原始字节序列（清洗前） */
  raw: string;
  /** Shift+Enter / Alt+Enter 换行键（\x1b\r、\x1b\n、kitty CSI-u \x1b[13;2u）——输入框内插入换行，
   *  不触发提交；终端默认 Shift+Enter 与 Enter 同发 \r 不可区分，需终端键位绑定发送 \x1b\r
   *  （Windows Terminal /terminal-setup 同款 sendInput 片段）或直接用 Alt+Enter（xterm ESC 前缀） */
  newline: boolean;
}

/** 裸 ESC 拼接窗口（2026-09-30 幽灵中断修复）：conpty/高负载（后台任务收割、整帧流式重绘）下
 *  一次按键的转义序列可拆成多个 data 事件——首字节 \u001B 单独到达时旧解析当真 Esc 键，
 *  运行中即「无缘无故中断」（TASK_WAIT 收割瞬间真机形态）。窗口内等待后续字节拼成完整序列
 *  再解析；窗口过期仍孤零 = 真 Esc 按键（40ms 延迟无感）。SUNSHINEX_ESC_JOIN_MS 覆盖（测试钉短用） */
const ESC_JOIN_WINDOW_MS = 40;

/** 序列完整性判据：非 ESC 开头恒完整（普通字节串直发，零延迟）；裸 ESC 未完（可能是被拆序列的
 *  首字节）；CSI（ESC [ …）以 final byte（0x40–0x7E）且长度 ≥3 为完整（覆盖 [1;5A 等参数形态）；
 *  SS3（ESC O …）长度 ≥3 为完整；其余 ESC 前缀形态（Alt 组合等）按既有口径直发 */
function isCompleteSequence(b: string): boolean {
  if (!b.startsWith('\u001B')) return true;
  if (b === '\u001B') return false;
  if (b.startsWith('\u001B[')) {
    const code = b.charCodeAt(b.length - 1);
    return b.length >= 3 && code >= 0x40 && code <= 0x7e;
  }
  if (b.startsWith('\u001BO')) return b.length >= 3;
  return true;
}


/** 键位实据日志（免配置常开，真机「前置 Enter」类症状唯一取证通道）：固定路径 %TEMP%/sunshinex-keys.log，
 *  每个 data 块与最终派发的 raw 序列逐条落盘（**带 PID 前缀**——并行会话共写同一文件，2026-10-02 实证
 * 行序时间倒挂污染取证，按 PID 过滤才是单会话流），超 256KB 自动截断重写 */
const KEY_LOG_PATH = join(os.tmpdir(), 'sunshinex-keys.log');
function keyDebug(msg: string): void {
  try {
    if (fs.existsSync(KEY_LOG_PATH) && fs.statSync(KEY_LOG_PATH).size > 262_144) {
      fs.writeFileSync(KEY_LOG_PATH, '');
    }
    fs.appendFileSync(KEY_LOG_PATH, `${Date.now()} ${process.pid} ${msg}
`);
  } catch {
    /* 诊断落盘失败静默（不干扰键位主路径） */
  }
}

/** 渲染层归因口（同一日志）：分发层只能证明字节到达，无法证明「谁消费、画面是否重画」——
 *  App 分支消费点与 tui-loop 重绘点调用本函数落同一日志，一次真机复现即可区分
 *  「键没到 App」/「App 消费了但重绘没跑」/「重绘跑了但终端冻结」三段（2026-10-02 前置 Enter 复发取证） */
export function keyTrace(msg: string): void {
  keyDebug(`trace ${msg}`);
}

/** 每一 stdin 的进程级监听条目（2026-09-30 真机「进全屏后 Esc/Tab 须先按 Enter」终版根因修复）：
 *  监听器原挂每次挂载的 useLayoutEffect——React 提交（长转录全量 Static 渲染可达秒级）完成才挂上，
 *  重挂空窗与长渲染期按键全丢（用户按 Enter 时渲染早已完成，即「Enter 解锁」假象）。
 *  改注册制：监听器与拆包重组缓冲按 stdin 单例常驻（跨重挂存活，pending 字节不丢、raw mode 不闪断），
 *  各挂载实例注册/注销自己的分发器，data 事件派发给最后注册者（最新挂载赢，同旧语义）。
 *  2026-10-03 真空宽限（真机「归档视图进入/live→archived 换挡后须先按 Enter」复发终修）：最后一个处理器
 *  随卸载注销时不再同步「摘监听+关 raw mode」——重挂路径（browse→归档进入、换挡）卸载与重挂虽在同一
 *  宏任务（ink unmount 同步 resolveExitPromise），中间却隔着归档大转录的首帧同步渲染（真机秒级），
 *  窗口内 setRawMode(false) 已生效：终端落入 cooked 线路规程，物理按键进「行缓冲」直到按 Enter 才
 *  整行递交=「先按 Enter 才有 Esc/Tab/Ctrl+C」的签名特征。宽限期内监听与 raw mode 原样保留（重挂即
 *  整个跳过、零模式翻转）；宽限到期仍真空才真正拆链。进程退出卫生由 'exit' 单点同步拆链兜底
 *  （quit() 的 process.exit 不给 timer 机会——旧实现为此曾同步拆链，该职责移交 exit 钩子后通杀所有退出路径） */
interface StdinEntry {
  handleData: (data: string) => void;
  handlers: Set<(input: string, key: RawKey) => void>;
  pending: string;
  joinTimer?: ReturnType<typeof setTimeout>;
  vacuumTimer?: ReturnType<typeof setTimeout>;
  /** 终端流恢复单点（终拆链/进程退出时）：直驱流的 setRawMode(false)+pause */
  restore: () => void;
}
const stdinEntries = new Map<unknown, StdinEntry>();

/** 真空宽限窗口：卸载→重挂虽同宏任务不可被 timer 抢占，窗口取值只约束「真无重挂」路径的拆链延迟
 *  （测试直卸等）；SUNSHINEX_VACUUM_GRACE_MS 覆盖（测试压短用） */
const VACUUM_GRACE_MS = 1000;

/** 条目真拆链单点：宽限到期/进程退出共用——摘监听 + 清缓冲 + 退 raw mode + 删条目 */
function teardownEntry(e: StdinEntry, stdin: unknown): void {
  if (e.vacuumTimer) {
    clearTimeout(e.vacuumTimer);
    e.vacuumTimer = undefined;
  }
  if (e.joinTimer) {
    clearTimeout(e.joinTimer);
    e.joinTimer = undefined;
  }
  e.pending = '';
  e.handlers.clear();
  (stdin as { off?: (ev: string, fn: unknown) => void }).off?.('data', e.handleData);
  stdinEntries.delete(stdin);
  e.restore();
}

/** 进程退出卫生（'exit' 同步回调约束内完成）：真空宽限定时器在 process.exit 前永不执行，raw mode
 *  复位必须由此兜底——quit()/SIGINT/自然退出全路径通杀，终端无 cooked 残留 */
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const [stdin, e] of [...stdinEntries]) teardownEntry(e, stdin);
  });
}

const useInput = (inputHandler: (input: string, key: RawKey) => void, options: { isActive?: boolean } = {}): void => {
  const { stdin, internal_exitOnCtrlC } = useStdin();
  // 处理器进 ref（监听生命周期与处理器身份解耦）：App 高频重渲染（子面板 120ms 节流 + Spinner 帧）下
  // 以处理器为 effect 依赖会使 stdin 监听反复摘挂，按键落入空窗即丢失——真机「运行中快捷键与输入
  // 全部失效」的根因；监听进程级只挂一次、每次分发取注册表最新处理器，重渲染零摘挂、按键零丢失
  const handlerRef = React.useRef(inputHandler);
  handlerRef.current = inputHandler;
  React.useLayoutEffect(() => {
    if (options.isActive === false || !stdin) return;
    let entry: StdinEntry | undefined = stdinEntries.get(stdin);
    if (!entry) {
      installExitHook();
      // 直驱终端流（不经 ink context setRawMode，2026-10-03 终修）：ink 内部 App 组件卸载时无条件
      // handleSetRawMode(false)（其内部计数 --count===0 即关 raw+摘其监听+pause）——重挂路径卸载→重挂
      // 之间的渲染窗口（归档大转录首帧秒级）终端即落 cooked 行缓冲=真机「归档视图先按 Enter」病根。
      // 改直驱后 ink 计数恒 0，其卸载 disable 成 --0=-1≠0 的 no-op：raw mode/流动/本监听跨重挂全程稳定，
      // 恢复 cooked 只发生在终拆链（restore）与进程退出（exit 钩子）两处
      const rawStdin = stdin as unknown as {
        setEncoding?: (enc: string) => void;
        resume?: () => void;
        setRawMode?: (on: boolean) => void;
        pause?: () => void;
      };
      rawStdin.setEncoding?.('utf8');
      rawStdin.resume?.();
      rawStdin.setRawMode?.(true);
      const created: StdinEntry = {
        handlers: new Set(),
        pending: '',
        restore: () => {
          rawStdin.setRawMode?.(false);
          rawStdin.pause?.();
        },
        handleData: () => {},
      };      const e = created;
      const flush = (): void => {
        if (e.joinTimer) {
          clearTimeout(e.joinTimer);
          e.joinTimer = undefined;
        }
        if (e.pending.length === 0) return;
        const bytes = e.pending;
        e.pending = '';
        keyDebug(`dispatch raw=${JSON.stringify(bytes)} handlers=${e.handlers.size}`);
        if (e.handlers.size === 0) return;
        const handler = [...e.handlers][e.handlers.size - 1]!;
        // 单点解析分发：raw 保留原始字节；键位判定与 ink3 原版逐行一致
        const key: RawKey = {
          upArrow: bytes === '\u001B[A',
          downArrow: bytes === '\u001B[B',
          leftArrow: bytes === '\u001B[D',
          rightArrow: bytes === '\u001B[C',
          pageDown: bytes === '\u001B[6~',
          pageUp: bytes === '\u001B[5~',
          return: bytes === '\r',
          escape: bytes === '\u001B',
          ctrl: false,
          shift: false,
          tab: bytes === '\t' || bytes === '\u001B[Z',
          backspace: bytes === '\u0008',
          delete: bytes === '\u007F' || bytes === '\u001B[3~',
          meta: false,
          raw: bytes,
          newline:
            bytes === '\u001B\r' ||
            bytes === '\u001B\n' ||
            /^\u001B\[13;\d*u$/.test(bytes), // kitty CSI-u：Shift(2)/Ctrl(5)+Enter
        };
        if (bytes <= '\u001A' && !key.return) key.ctrl = true;
        if (bytes.startsWith('\u001B')) key.meta = true;
        const input =
          bytes <= '\u001A' && !key.return ? String.fromCharCode(bytes.charCodeAt(0) + 'a'.charCodeAt(0) - 1) : bytes;
        // Ctrl+C 退出语义与 ink3 原版一致：仅 exitOnCtrlC 开启（ink 托管退出）时扣发；
        // 本 CLI exitOnCtrlC:false——Ctrl+C 必须进分发层交 App 分流（运行中=中断任务，空闲=退出）。
        // cb3ec70 重写时丢失该守卫致 Ctrl+C 被无条件吞掉（真机「Ctrl+C 失效」实锤）
        if (!(input === 'c' && key.ctrl) || !internal_exitOnCtrlC) handler(input, key);
      };
      e.handleData = (data: string): void => {
        const incoming = String(data);
        keyDebug(`data ${JSON.stringify(incoming)}`);
        // 裸 ESC 已扣住、新块到达（2026-09-30 真机「全屏 Esc 需先按 Enter」病根）：新块以 [ / O 开头 =
        // 拆包序列剩余（↑/⌦ 等），继续拼合（保拆包重组语义）；\r / \n 到达 = Alt+Enter（\x1b\r 换行键）
        // 也走拼合（单事件整块到达即整体判完整，两段到达跨过 40ms 窗口才退化为 Esc+Enter）；其余字节
        // （字符、控制符）=「用户按了 Esc 又按了别的键」——先派发扣住的裸 Esc 再解析新块。否则
        // pending='\u001B'+X 被 isCompleteSequence 判完整即整体直发，escape 判定失败、Esc 键被吞
        if (
          e.pending === '\u001B' &&
          incoming.length > 0 &&
          !incoming.startsWith('[') &&
          !incoming.startsWith('O') &&
          incoming !== '\r' &&
          incoming !== '\n'
        ) {
          if (e.joinTimer) {
            clearTimeout(e.joinTimer);
            e.joinTimer = undefined;
          }
          flush(); // 派发扣住的真 Esc（读 pending='\u001B'），随后正常解析新块
        }
        e.pending += incoming;
        if (isCompleteSequence(e.pending)) {
          flush();
          return;
        }
        if (e.joinTimer) clearTimeout(e.joinTimer);
        e.joinTimer = setTimeout(flush, Number(process.env.SUNSHINEX_ESC_JOIN_MS || '') || ESC_JOIN_WINDOW_MS);
        if (typeof e.joinTimer === 'object' && e.joinTimer && 'unref' in e.joinTimer) e.joinTimer.unref();
      };
      stdinEntries.set(stdin, e);
      // 监听条目生命周期仅一次：首建挂/终拆链摘（宽限重挂零翻转）；raw mode 已在直驱段开启
      stdin.on('data', e.handleData);
      entry = e;
    }
    const e: StdinEntry = entry;
    // 真空宽限内重挂：撤宽限定时器即可——监听与 raw mode 自条目创建起常驻未拆（重挂零模式翻转，
    // 归档大转录渲染窗口内终端不落 cooked，裸字节不进行缓冲）
    if (e.handlers.size === 0 && e.vacuumTimer) {
      clearTimeout(e.vacuumTimer);
      e.vacuumTimer = undefined;
    }
    const wrapped = (input: string, key: RawKey): void => {
      handlerRef.current(input, key);
    };
    e.handlers.add(wrapped);
    return () => {
      e.handlers.delete(wrapped);
      if (e.handlers.size === 0) {
        // 真空宽限：不同步拆链（归档大转录首帧渲染的窗口内 raw mode 关闭=终端行缓冲吞键，真机
        // 「归档视图先按 Enter」签名特征）；宽限到期仍真空才真拆链，进程退出另有 'exit' 兜底
        if (e.joinTimer) {
          clearTimeout(e.joinTimer);
          e.joinTimer = undefined;
        }
        e.pending = '';
        const graceMs = Number(process.env.SUNSHINEX_VACUUM_GRACE_MS || '') || VACUUM_GRACE_MS;
        e.vacuumTimer = setTimeout(() => {
          e.vacuumTimer = undefined;
          teardownEntry(e, stdin);
        }, graceMs);
        if (typeof e.vacuumTimer === 'object' && e.vacuumTimer && 'unref' in e.vacuumTimer) e.vacuumTimer.unref();
      }
    };
  }, [options.isActive, stdin, internal_exitOnCtrlC]);
};

export default useInput;
