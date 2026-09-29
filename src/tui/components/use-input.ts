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

const useInput = (inputHandler: (input: string, key: RawKey) => void, options: { isActive?: boolean } = {}): void => {
  const { stdin, setRawMode, internal_exitOnCtrlC } = useStdin();
  // 处理器进 ref（监听生命周期与处理器身份解耦）：App 高频重渲染（子面板 120ms 节流 + Spinner 帧）下
  // 以处理器为 effect 依赖会使 stdin 监听反复摘挂，按键落入空窗即丢失——真机「运行中快捷键与输入
  // 全部失效」的根因；监听只挂一次、每次分发取 ref 最新处理器，重渲染零摘挂、按键零丢失
  const handlerRef = React.useRef(inputHandler);
  handlerRef.current = inputHandler;
  React.useEffect(() => {
    if (options.isActive === false) return;
    setRawMode(true);
    return () => {
      setRawMode(false);
    };
  }, [options.isActive, setRawMode]);
  // 监听挂载用 layout 相位（commit 同步，早于任何被动冲刷）：挂载后立即到达的按键不丢
  React.useLayoutEffect(() => {
    if (options.isActive === false) return;
    // 单点解析分发：raw 保留原始字节；键位判定与 ink3 原版逐行一致
    const dispatch = (bytes: string): void => {
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
      if (bytes <= '\u001A' && !key.return) {
        key.ctrl = true;
      }
      if (bytes.startsWith('\u001B')) {
        key.meta = true;
      }
      const input =
        bytes <= '\u001A' && !key.return ? String.fromCharCode(bytes.charCodeAt(0) + 'a'.charCodeAt(0) - 1) : bytes;
      // Ctrl+C 退出语义与原版一致：exitOnCtrlC 开启时按键由 ink 托管，不进分发层
      if (!(input === 'c' && key.ctrl) || !internal_exitOnCtrlC) {
        handlerRef.current(input, key);
      }
    };
    // 拆包重组缓冲：未完序列累积待续；窗口计时过期按现状直发（裸 ESC=真 Esc 键、残缺序列按既有丢弃口径）
    let pending = '';
    let joinTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => {
      if (joinTimer) {
        clearTimeout(joinTimer);
        joinTimer = undefined;
      }
      if (pending.length === 0) return;
      const bytes = pending;
      pending = '';
      dispatch(bytes);
    };
    const handleData = (data: string): void => {
      const incoming = String(data);
      // 裸 ESC 已扣住、新块到达（2026-09-30 真机「全屏 Esc 需先按 Enter」病根）：新块以 [ / O 开头 =
      // 拆包序列剩余（↑/⌦ 等），继续拼合（保上方拆包重组语义）；其余字节（\r、字符、控制符）=
      // 「用户按了 Esc 又按了别的键」——先派发扣住的裸 Esc 再解析新块。否则 pending='\u001B'+X 被
      // isCompleteSequence 判完整即整体直发，escape 判定失败、Esc 键被吞（拼合窗口反成吞键窗口）
      if (pending === '\u001B' && incoming.length > 0 && !incoming.startsWith('[') && !incoming.startsWith('O')) {
        pending = '';
        if (joinTimer) {
          clearTimeout(joinTimer);
          joinTimer = undefined;
        }
        dispatch('\u001B');
      }
      pending += incoming;
      if (isCompleteSequence(pending)) {
        flush();
        return;
      }
      if (joinTimer) clearTimeout(joinTimer);
      joinTimer = setTimeout(flush, Number(process.env.SUNSHINEX_ESC_JOIN_MS || '') || ESC_JOIN_WINDOW_MS);
      if (typeof joinTimer === 'object' && joinTimer && 'unref' in joinTimer) joinTimer.unref();
    };
    stdin?.on('data', handleData);
    return () => {
      if (joinTimer) clearTimeout(joinTimer);
      stdin?.off('data', handleData);
    };
  }, [options.isActive, stdin, internal_exitOnCtrlC]);
};

export default useInput;
