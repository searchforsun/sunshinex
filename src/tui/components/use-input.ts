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
  React.useEffect(() => {
    if (options.isActive === false) return;
    setRawMode(true);
    return () => {
      setRawMode(false);
    };
  }, [options.isActive, setRawMode]);
  React.useEffect(() => {
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
        inputHandler(input, key);
      }
    };
    stdin?.on('data', handleData);
    return () => {
      stdin?.off('data', handleData);
    };
  }, [options.isActive, stdin, internal_exitOnCtrlC, inputHandler]);
};

export default useInput;
