import * as React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { render } from 'ink';
import { App } from './components/App';
import { runTuiLoop } from './tui-loop';
import { SessionController } from './session';
import { buildBannerInfo } from './banner-info';
import { buildModel, parseTier } from '../runtime';
import { resolveWorktreeLaunchRoot } from '../cli/worktree-launch';
import { parseEffort } from '../model/adapter';
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
  // 入口一（规格 §7/D5）：--worktree 装配前解析（fail-fast 于建树失败/互斥冲突），root 替换后走既有装配链
  const launchRoot = resolveWorktreeLaunchRoot(args, root);
  const modeFlag = typeof args.flags.mode === 'string' ? args.flags.mode : undefined;
  const mode = modeFlag === 'dontAsk' || modeFlag === 'plan' ? modeFlag : 'manual';
  const model = buildModel(args.flags);
  // 模型档位（用户级会话参数，对标 Claude Code 的模型选择）：--tier 优先，SUNSHINEX_TIER 兜底；/model 可会话内切换
  const tier = parseTier(args.flags.tier) ?? parseTier(process.env.SUNSHINEX_TIER);
  // 缺省思考强度（请求级参数，--effort > SUNSHINEX_REASONING_EFFORT）：/model effort 可会话内切换
  const effort = parseEffort(typeof args.flags.effort === 'string' ? args.flags.effort : undefined) ?? parseEffort(process.env.SUNSHINEX_REASONING_EFFORT);
  // 会话续接（--continue，规格 D1/D5）：裸 flag 解析为 boolean，透传控制器构造（无档时控制器内提示并以新会话继续）
  const continueLast = args.flags['continue'] === true;
  const ctrl = new SessionController({ root: launchRoot, mode, model, ...(tier ? { tier } : {}), ...(effort ? { effort } : {}), ...(continueLast ? { continueLast: true } : {}) });
  // 恢复携带的 UI 现场（输入历史 + 视图两态）经 initialRetain 播种 retain（一次性取走）
  const restored = ctrl.takeRestoredUi();
  const banner = buildBannerInfo({ version: readPackageVersion(), root: launchRoot, model: model.label ?? model.provider });
  // 进入 TUI 先清屏（含滚动缓冲）并归位光标，主横幅自首行起渲染
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  // 渲染循环：resize 时卸载→清屏→重挂整屏重绘（ink3 对 resize 只做原位重绘，擦除按旧帧行数计数，
  // 终端缩放 reflow 后行数失配、旧帧擦不净即残影叠字）；输入与展开模式现场跨重挂保留
  let current: { unmount(): void } | undefined;
  // Tab 切换的展开模式：经宿主 onRequestRepaint 注入 tui-loop 的重绘出口（与 resize 共用卸载→清屏→重挂路径）
  let requestRepaint: (() => void) | undefined;
  // 优雅退出单点：SIGINT 与空闲态 Ctrl+C（App onExit）共用——清定时器→卸载渲染→退出
  const quit = (): void => {
    ctrl.dispose(); // 清空闲兜底节拍定时器（规格 §3.5）
    current?.unmount();
    process.exit(0);
  };
  process.once('SIGINT', quit);
  try {
    await runTuiLoop({
      stdout: process.stdout,
      clearScreen: () => process.stdout.write('\x1b[2J\x1b[3J\x1b[H'),
      onRequestRepaint: (req) => {
        requestRepaint = req;
      },
      renderOnce: (retain) => {
        // exitOnCtrlC 关闭：Ctrl+C 不再被 ink 托管退出，改由 App 分流（运行中=中断任务，空闲=经 onExit 退出）
        const inst = render(React.createElement(App, { controller: ctrl, banner, retain, onRequestRepaint: requestRepaint, onExit: quit }), { exitOnCtrlC: false });
        current = inst;
        return inst;
      },
      initialRetain: restored ? { history: restored.history, expandAll: restored.expandAll, latestFull: restored.latestFull } : undefined,
    });
  } finally {
    ctrl.dispose(); // 清空闲兜底节拍定时器（规格 §3.5）：循环退出即释放
  }
  process.exit(0);
}
