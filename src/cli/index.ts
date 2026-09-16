#!/usr/bin/env node
import { runSelfcheck } from './commands/selfcheck';
import { runLoop } from './commands/run-loop';
import { runPipeline } from './commands/run-pipeline';
import { runTui } from '../tui/entry';
import { loadEnv, loadGlobalEnv } from '../config/env';
import { parseLanguage, setLanguage, t } from '../i18n';

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

/** 已知子命令清单：首个 positional 命中其一按子命令分发，否则视为项目目录直进 TUI */
const COMMANDS = ['selfcheck', 'run', 'pipeline', 'tui', 'help'];

/**
 * 调用形态归一：非已知子命令的首个 positional 视为项目目录，归一为 tui 调用（对标 claude <dir>）。
 * `sunshinex ../my-project --mode=plan` 与 `sunshinex tui ../my-project --mode=plan` 归一后完全同构；
 * 已知子命令（含拼错的「疑似子命令」之外的一切目录路径）原样透传。
 */
export function resolveInvocation(args: CliArgs): CliArgs {
  if (COMMANDS.includes(args.command)) return args;
  return { command: 'tui', positional: [args.command, ...args.positional], flags: args.flags };
}

/** CLI 帮助（运行期求值：语言随 --language 设定，禁止模块级 t() 冻结） */
function usageText(): string {
  return t(
    `SunshineX CLI
  sunshinex                               enter the interactive session terminal directly (= sunshinex tui, manual default)
  sunshinex [dir] [--mode=manual|dontAsk|plan] [--language=en|zh] [--tier=small|medium|large]
                                         first arg that is not a subcommand is treated as the project dir (= sunshinex tui <dir>); --language UI & prompt language (default en)
  sunshinex selfcheck                     skeleton self-check (perception/tools/security/context/Loop/Graph)
  sunshinex run <dir> --goal="..."        run the standard verify-fix loop on the dir (goal via --goal)
  sunshinex pipeline <dir> [--yes]        five-node full pipeline with interactive gate approvals (--yes auto-approves)
  sunshinex tui [dir] [--mode=manual|dontAsk|plan] [--language=en|zh] [--tier=small|medium|large]
                              interactive session terminal (streaming/approvals/todos, manual default)`,
    `SunshineX CLI
  sunshinex                               直接进入交互式会话终端（= sunshinex tui，manual 缺省）
  sunshinex [dir] [--mode=manual|dontAsk|plan] [--language=en|zh] [--tier=small|medium|large]
                                         首参非子命令时视为项目目录直进终端（= sunshinex tui <dir>）；--language 界面与提示词语言（缺省 en）
  sunshinex selfcheck                     骨架自检（感知/工具/安全/上下文/Loop/Graph 就绪）
  sunshinex run <dir> --goal="..."        在目录上运行标准验收修正环（goal 走交互或 --goal）
  sunshinex pipeline <dir> [--yes]        五节点全链路流水线，gate 审批交互（--yes 跳过交互直接批准）
  sunshinex tui [dir] [--mode=manual|dontAsk|plan] [--language=en|zh] [--tier=small|medium|large]
                              交互式会话终端（流式/审批/待办，manual 缺省）`,
  );
}

async function main(): Promise<void> {
  // 三级配置链（对标 Claude Code 用户级 + 项目级惯例）：已导出环境变量 > 项目 .env > ~/.sunshinex/.env
  // 项目级先装、全局后装兜底——loadEnv 只填缺省键，后装者仅补缺不覆盖，顺序即优先级
  loadEnv();
  loadGlobalEnv();
  const args = resolveInvocation(parseArgs(process.argv.slice(2)));
  // 界面语言：--language=en|zh（缺省 en；zh 为全中文界面 + 中文模型侧提示词；先于任何输出与装配设定，--help 亦随语言）
  setLanguage(parseLanguage(args.flags.language));
  if (args.flags.help === true || args.flags.h === true) {
    console.log(usageText());
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
      console.log(usageText());
  }
}

// 仅直接执行时启动（测试 import 本模块只取纯函数，不得触发 TUI/CLI 副作用）
if (require.main === module) {
  main().catch((e) => {
    console.error('CLI-ERROR', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
