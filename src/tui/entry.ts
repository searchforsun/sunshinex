import * as React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { render } from 'ink';
import { App } from './components/App';
import { runTuiLoop } from './tui-loop';
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
  // 相对路径立即收敛为绝对路径：root 全链路（工具沙箱 cwd、guard 边界、上下文工作目录事实）都以绝对路径为准
  const root = path.resolve(args.positional[0] ?? process.cwd());
  const modeFlag = typeof args.flags.mode === 'string' ? args.flags.mode : undefined;
  const mode = modeFlag === 'dontAsk' || modeFlag === 'plan' ? modeFlag : 'manual';
  const model = buildModel(args.flags);
  const ctrl = new SessionController({ root, mode, model });
  const banner = buildBannerInfo({ version: readPackageVersion(), root, model: model.label ?? model.provider });
  // 进入 TUI 先清屏（含滚动缓冲）并归位光标，主横幅自首行起渲染
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  // 渲染循环：resize 时卸载→清屏→重挂整屏重绘（ink3 对 resize 只做原位重绘，擦除按旧帧行数计数，
  // 终端缩放 reflow 后行数失配、旧帧擦不净即残影叠字）；输入与展开打印现场跨重挂保留
  let current: { unmount(): void } | undefined;
  process.once('SIGINT', () => {
    current?.unmount();
    process.exit(0);
  });
  await runTuiLoop({
    stdout: process.stdout,
    clearScreen: () => process.stdout.write('\x1b[2J\x1b[3J\x1b[H'),
    renderOnce: (retain) => {
      const inst = render(React.createElement(App, { controller: ctrl, banner, retain }));
      current = inst;
      return inst;
    },
  });
  process.exit(0);
}
