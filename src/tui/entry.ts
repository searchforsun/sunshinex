import * as React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { render } from 'ink';
import { App } from './components/App';
import { SessionController } from './session';
import { buildBannerInfo } from './banner-info';
import { buildModel } from '../runtime';
import type { CliArgs } from '../cli';

/** 读根 package.json 版本（失败回退 undefined，由 buildBannerInfo 兜底） */
function readPackageVersion(): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** TUI 入口：同进程装配会话控制器与 Ink 渲染；manual 审批经键盘 y/a/n 在会话内裁决 */
export async function runTui(args: CliArgs): Promise<void> {
  const root = args.positional[0] ?? process.cwd();
  const modeFlag = typeof args.flags.mode === 'string' ? args.flags.mode : undefined;
  const mode = modeFlag === 'dontAsk' || modeFlag === 'plan' ? modeFlag : 'manual';
  const model = buildModel(args.flags);
  const ctrl = new SessionController({ root, mode, model });
  const banner = buildBannerInfo({ version: readPackageVersion(), root, model: model.label ?? model.provider });
  // 进入 TUI 先清屏（含滚动缓冲）并归位光标，主横幅自首行起渲染
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  const instance = render(React.createElement(App, { controller: ctrl, banner }));
  const shutdown = (): void => {
    instance.unmount();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  await instance.waitUntilExit();
}
