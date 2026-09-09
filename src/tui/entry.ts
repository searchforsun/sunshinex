import * as React from 'react';
import { render } from 'ink';
import { App } from './components/App';
import { SessionController } from './session';
import type { CliArgs } from '../cli';

/** TUI 入口：同进程装配会话控制器与 Ink 渲染；manual 审批经键盘 y/a/n 在会话内裁决 */
export async function runTui(args: CliArgs): Promise<void> {
  const root = args.positional[0] ?? process.cwd();
  const modeFlag = typeof args.flags.mode === 'string' ? args.flags.mode : undefined;
  const mode = modeFlag === 'dontAsk' || modeFlag === 'plan' ? modeFlag : 'manual';
  const ctrl = new SessionController({ root, mode });
  const instance = render(React.createElement(App, { controller: ctrl }));
  const shutdown = (): void => {
    instance.unmount();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  await instance.waitUntilExit();
}
