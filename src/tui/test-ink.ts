import * as React from 'react';
import { render as inkRender } from 'ink';
import { EventEmitter, Writable } from 'stream';

export interface TestRenderResult {
  lastFrame(): string | undefined;
  /** 模拟键盘输入（\r 表示回车提交；y/a/n 为审批裁决键） */
  write(data: string): void;
  unmount(): void;
}

/**
 * ink-testing-library 替身：ink 原生 render + 假 stdout/stdin（零新增依赖）。
 * 背景：ITL@4 peer 依赖 ink@5 与项目 ink@3 冲突（pnpm 安装即被剪除，运行时 MODULE_NOT_FOUND）。
 * 等价面：假 stdout 收帧（debug 关节流）+ EventEmitter 假 stdin（isTTY=true 绕过 raw-mode 抛错，
 * 'data' 事件直通 ink 的 useInput 键盘分发），与 ITL4 渲染语义一致。
 */
export function render(element: React.ReactElement): TestRenderResult {
  let last = '';
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      const s = String(chunk).replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
      if (s.trim().length > 0) last = s;
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
    debug: true,
  });
  return {
    lastFrame: () => last,
    write: (data) => stdin.emit('data', data),
    unmount: () => instance.unmount(),
  };
}
