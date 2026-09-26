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
    const handleData = (data: string): void => {
      const bytes = String(data);
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
    stdin?.on('data', handleData);
    return () => {
      stdin?.off('data', handleData);
    };
  }, [options.isActive, stdin, internal_exitOnCtrlC]);
};

export default useInput;
