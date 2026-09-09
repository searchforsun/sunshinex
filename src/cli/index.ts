import { runSelfcheck } from './commands/selfcheck';
import { runLoop } from './commands/run-loop';
import { runPipeline } from './commands/run-pipeline';
import { runTui } from '../tui/entry';
import { loadEnv } from '../config/env';

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
  return { command: positional.shift() ?? 'help', positional, flags };
}

const USAGE = `SunshineX CLI
  sunshinex selfcheck                     骨架自检（感知/工具/安全/上下文/Loop/Graph 就绪）
  sunshinex run <dir> [--template=...]    在目录上运行 Loop 模板修正环（goal 走交互或 --goal）
  sunshinex pipeline <dir> [--yes]        五节点全链路流水线，gate 审批交互（--yes 跳过交互直接批准）
  sunshinex tui [dir] [--mode=manual|dontAsk|plan] 交互式会话终端（流式/审批/待办，manual 缺省）`;

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
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

main().catch((e) => {
  console.error('CLI-ERROR', e instanceof Error ? e.message : e);
  process.exit(1);
});
