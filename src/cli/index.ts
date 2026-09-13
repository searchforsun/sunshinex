#!/usr/bin/env node
import { runSelfcheck } from './commands/selfcheck';
import { runLoop } from './commands/run-loop';
import { runPipeline } from './commands/run-pipeline';
import { runTui } from '../tui/entry';
import { loadEnv, loadGlobalEnv } from '../config/env';

/** CLI 参数解析：仅内置约定，零依赖。--flag=v 或 --flag v → 字符串；--flag（末尾无值）→ true；其余为 positional */
export interface CliArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): CliArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[a.slice(2)] = argv[i + 1];
        i++;
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  // 裸命令兜底：`sunshinex`（无子命令）直接进入交互式终端（= sunshinex tui，对标 claude 裸命令），
  // `sunshinex --mode=manual` 同样落 tui；显式 help 子命令与 --help flag 不受影响（见 main 拦截）
  return { command: positional.shift() ?? 'tui', positional, flags };
}

const USAGE = `SunshineX CLI
  sunshinex                               直接进入交互式会话终端（= sunshinex tui，manual 缺省）
  sunshinex --mode=manual|dontAsk|plan    裸命令可直带权限模式 flag
  sunshinex selfcheck                     骨架自检（感知/工具/安全/上下文/Loop/Graph 就绪）
  sunshinex run <dir> [--template=...]    在目录上运行 Loop 模板修正环（goal 走交互或 --goal）
  sunshinex pipeline <dir> [--yes]        五节点全链路流水线，gate 审批交互（--yes 跳过交互直接批准）
  sunshinex tui [dir] [--mode=manual|dontAsk|plan] 交互式会话终端（流式/审批/待办，manual 缺省）`;

async function main(): Promise<void> {
  // 三级配置链（对标 Claude Code 用户级 + 项目级惯例）：已导出环境变量 > 项目 .env > ~/.sunshinex/.env
  // 项目级先装、全局后装兜底——loadEnv 只填缺省键，后装者仅补缺不覆盖，顺序即优先级
  loadEnv();
  loadGlobalEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.help === true || args.flags.h === true) {
    console.log(USAGE);
    return;
  }
  switch (args.command) {
    case 'selfcheck':
      return runSelfcheck(args);
    case 'run':
      return runLoop(args);
    case 'pipeline':
      return runPipeline(args);
    case 'tui':
      return runTui(args);
    default:
      console.log(USAGE);
  }
}

// 仅直接执行时启动（测试 import 本模块只取纯函数，不得触发 TUI/CLI 副作用）
if (require.main === module) {
  main().catch((e) => {
    console.error('CLI-ERROR', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
