import * as React from 'react';
import { render as inkRender } from 'ink';
import { EventEmitter, Writable } from 'stream';

export interface TestRenderResult {
  lastFrame(): string | undefined;
  /** 全量输出：Static 区（横幅/历史消息）打印一次后不再进入动态帧，历史内容断言用本口径 */
  allOutput(): string;
  /** 模拟键盘输入（\r 表示回车提交；y/a/n 为审批裁决键） */
  write(data: string): void;
  unmount(): void;
}

/**
 * ink-testing-library 替身：ink 原生 render + 假 stdout/stdin（零新增依赖）。
 * 背景：ITL@4 peer 依赖 ink@5 与项目 ink@3 冲突（pnpm 安装即被剪除，运行时 MODULE_NOT_FOUND）。
 * 等价面：假 stdout 收帧（debug 关节流）+ EventEmitter 假 stdin（isTTY=true 绕过 raw-mode 抛错，
 * 'data' 事件直通 ink 的 useInput 键盘分发），与 ITL4 渲染语义一致。
 * 口径：lastFrame = 末次非空写入（非 debug 模式：动态帧末次重绘）；allOutput = 累计 stdout（含 Static 一次性打印与逐帧动态输出）。
 */
export function render(element: React.ReactElement): TestRenderResult {
  let last = '';
  let all = '';
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      const s = String(chunk).replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
      if (s.trim().length > 0) last = s;
      all += s;
      cb();
    },
  }) as Writable & { columns: number };
  stdout.columns = 100;

  const stdin = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    setEncoding(): void;
    setRawMode(): void;
    resume(): void;
    pause(): void;
    ref(): void;
    unref(): void;
  };
  stdin.isTTY = true;
  stdin.setEncoding = () => {};
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  const instance = inkRender(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
    debug: false,
  });
  return {
    lastFrame: () => last,
    allOutput: () => all,
    write: (data) => stdin.emit('data', data),
    unmount: () => instance.unmount(),
  };
}
