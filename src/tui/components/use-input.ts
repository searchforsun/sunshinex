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
 *  各挂载实例注册/注销自己的分发器，data 事件派发给最后注册者（最新挂载赢，同旧语义）；
 *  注销后延迟一 tick 检测真空——同 tick 内重挂（repaint 卸载→重挂路径）即零间隙零丢键，
 *  真正退出（无再注册）才摘监听 + 退 raw mode。 */
interface StdinEntry {
  handleData: (data: string) => void;
  handlers: Set<(input: string, key: RawKey) => void>;
  pending: string;
  joinTimer?: ReturnType<typeof setTimeout>;
  setRawMode: (on: boolean) => void;
}
const stdinEntries = new Map<unknown, StdinEntry>();

const useInput = (inputHandler: (input: string, key: RawKey) => void, options: { isActive?: boolean } = {}): void => {
  const { stdin, setRawMode, internal_exitOnCtrlC } = useStdin();
  // 处理器进 ref（监听生命周期与处理器身份解耦）：App 高频重渲染（子面板 120ms 节流 + Spinner 帧）下
  // 以处理器为 effect 依赖会使 stdin 监听反复摘挂，按键落入空窗即丢失——真机「运行中快捷键与输入
  // 全部失效」的根因；监听进程级只挂一次、每次分发取注册表最新处理器，重渲染零摘挂、按键零丢失
  const handlerRef = React.useRef(inputHandler);
  handlerRef.current = inputHandler;
  React.useLayoutEffect(() => {
    if (options.isActive === false || !stdin) return;
    let entry: StdinEntry | undefined = stdinEntries.get(stdin);
    if (!entry) {
      const created: StdinEntry = { handlers: new Set(), pending: '', setRawMode, handleData: () => {} };
      const e = created;
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
        // 拆包序列剩余（↑/⌦ 等），继续拼合（保拆包重组语义）；其余字节（\r、字符、控制符）=
        // 「用户按了 Esc 又按了别的键」——先派发扣住的裸 Esc 再解析新块。否则 pending='\u001B'+X 被
        // isCompleteSequence 判完整即整体直发，escape 判定失败、Esc 键被吞（拼合窗口反成吞键窗口）
        if (e.pending === '\u001B' && incoming.length > 0 && !incoming.startsWith('[') && !incoming.startsWith('O')) {
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
      entry = e;
    }
    const e: StdinEntry = entry;
    // 首个注册者开 raw mode（常驻到最终注销——重挂空窗不再闪断，裸字节不落行缓冲）
    if (e.handlers.size === 0) setRawMode(true);
    const wrapped = (input: string, key: RawKey): void => {
      handlerRef.current(input, key);
    };
    e.handlers.add(wrapped);
    stdin.on('data', e.handleData);
    return () => {
      e.handlers.delete(wrapped);
      if (e.handlers.size === 0) {
        // 同步摘除（不用延迟 timer）：quit() 路径 process.exit 同步退出，unref'd detach timer 永不执行
        // 即 raw mode 残留（终端坏掉）；重挂路径的 off/on 在同一同步任务内完成（JS 单线程零事件让渡），
        // 空窗内不可能插入 data 事件，零丢键
        if (e.joinTimer) clearTimeout(e.joinTimer);
        e.pending = '';
        stdin.off('data', e.handleData);
        stdinEntries.delete(stdin);
        setRawMode(false);
      }
    };
  }, [options.isActive, stdin, internal_exitOnCtrlC]);
};

export default useInput;
