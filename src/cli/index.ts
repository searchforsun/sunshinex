#!/usr/bin/env node
import { runSelfcheck } from './commands/selfcheck';
import { runLoop } from './commands/run-loop';
import { runPipeline } from './commands/run-pipeline';
import { runSkillsInstall } from './commands/skills-install';
import { runTui } from '../tui/entry';
import { applySettings, loadGlobalSettings, loadProjectSettings } from '../config/settings';
import { parseLanguage, setLanguage, t } from '../i18n';
import { EFFORT_ORDER } from '../model/adapter';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** CLI 版本号：以 package.json 为单一来源（dist 相对定位清单文件，与 npm 安装副本天然同源） */
function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 两级 settings 装载（项目级 → 全局级）：applySettings 只填缺省槽，先装者不被覆盖，装载顺序即优先级。
 * 抛错（畸形 JSON / version 非 1）属 fail-fast：入口层透出含文件路径的错误信息并退出非零，
 * 静默降级会演变成「配置没生效」的排查泥潭；warnings 经 stderr 逐行双语输出（外观通道，库内零打印）。
 */
function loadSettingsChain(projectRoot: string): void {
  try {
    for (const result of [applySettings(loadProjectSettings(projectRoot)), applySettings(loadGlobalSettings())]) {
      for (const w of result.warnings) console.error(t(`settings warning: ${w}`, `settings 警告：${w}`));
    }
  } catch (err) {
    console.error(t(
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? err.message : String(err),
    ));
    process.exit(1);
  }
}

/** CLI 参数解析：仅内置约定，零依赖。--flag=v 或 --flag v → 字符串；--flag（末尾无值）→ true；其余为 positional。
 *  可重复 flag（REPEATABLE_FLAGS，spec 5.3 --add-dir）：多次出现收集为 string[]，其余同前 */
export interface CliArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

/** 可重复 flag 清单：出现多次不覆盖、依次收集为数组（当前仅 --add-dir） */
const REPEATABLE_FLAGS = new Set(['add-dir']);

export function parseArgs(argv: string[]): CliArgs {
  const flags: Record<string, string | boolean | string[]> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let value: string | boolean;
      if (eq !== -1) {
        value = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        value = argv[i + 1];
        i++;
      } else {
        value = true;
      }
      if (REPEATABLE_FLAGS.has(key) && typeof value === 'string') {
        // 归一追加（flagList 单点）：boolean（裸 flag 误用形态）回退空集后收集，避免对 boolean 直接迭代
        const list = flagList(flags, key);
        flags[key] = [...list, value];
      } else {
        flags[key] = value;
      }
    } else if (/^-[a-zA-Z]$/.test(a)) {
      // 单字符短旗（-h / -v）：等价长旗布尔形态；多字符/取值短旗不在此列，落 positional 走既有报错
      flags[a.slice(1)] = true;
    } else {
      positional.push(a);
    }
  }
  // 裸命令兜底：`sunshinex`（无任何参数）落到空命令，由 resolveInvocation 归一为 tui（当前工作区启动）
  return { command: positional.shift() ?? '', positional, flags };
}

/** 可重复 flag 取值归一（spec 5.3 --add-dir）：单值/数组/缺省统一 string[] */
export function flagList(flags: CliArgs['flags'], name: string): string[] {
  const v = flags[name];
  if (typeof v === 'string') return v === '' ? [] : [v];
  if (Array.isArray(v)) return v;
  return [];
}

/** 已知子命令清单：首个 positional 命中其一按子命令分发（tui 为内部派发键、非用户子命令） */
const COMMANDS = ['selfcheck', 'run', 'pipeline', 'skills', 'help'];

/** 路径形态判据（规格 §6.2）：绝对路径（POSIX `/` 前缀、Windows 盘符）、`.`/`..` 显式相对形态、或含路径分隔符 */
export function isPathForm(arg: string): boolean {
  if (!arg) return false;
  if (/^(?:[A-Za-z]:)?[\\/]/.test(arg)) return true;
  if (arg === '.' || arg === '..' || arg.startsWith('./') || arg.startsWith('../') || arg.startsWith('.\\') || arg.startsWith('..\\')) return true;
  return /[/\\]/.test(arg);
}

/**
 * 目录来源统一单点（顶层与 run/pipeline 同判据，规格 §6.2）：--workdir flag 优先于位置路径（同传登记 ignored）；
 * 路径形态判据外的一切裸词报 unrecognized（调用方报「无法识别命令」并不启动）。
 */
export function resolveDirArg(args: CliArgs): { dir?: string; ignored?: string; unrecognized?: string } {
  const positional = args.positional[0];
  const flagDir = typeof args.flags.workdir === 'string' && args.flags.workdir ? args.flags.workdir : undefined;
  if (positional && flagDir) return { dir: flagDir, ignored: positional };
  if (flagDir) return { dir: flagDir };
  if (!positional) return {};
  if (isPathForm(positional)) return { dir: positional };
  return { unrecognized: positional };
}

/**
 * 调用形态归一（规格 §6.2）：裸命令（无位置参数）= 当前工作区 TUI；已知子命令原样透传；
 * 路径形态首个 positional = 指定目录 TUI；其余裸词报 unrecognized（main 据此 stderr 透出并退出非零）。
 */
export function resolveInvocation(args: CliArgs): CliArgs {
  if (args.command === '') return { ...args, command: 'tui' };
  if (COMMANDS.includes(args.command)) return args;
  if (isPathForm(args.command)) return { command: 'tui', positional: [args.command, ...args.positional], flags: args.flags };
  return { ...args, command: 'unrecognized' };
}

/** CLI 帮助（运行期求值：语言随 --language 设定，禁止模块级 t() 冻结）——导出供 USAGE 断言用例消费 */
export function usageText(): string {
  return t(
    `SunshineX CLI
  sunshinex                               enter the interactive session terminal in the current workspace (default)
  sunshinex [dir]                         start in the given directory (path-form arg: /abs, ./x, ../x, a/b; or --workdir=<dir>)
  sunshinex help                          show this usage (--help / -h)
  sunshinex selfcheck                     skeleton self-check (perception/tools/security/context/Loop/Graph)
  sunshinex run <dir> --goal="..."        run the standard verify-fix loop (exit code 1 unless done)
  sunshinex pipeline <dir> --goal="..." [--yes]
                                          five-node pipeline with gate approvals (--yes auto-approves)
  sunshinex skills install <git-url | owner/repo | local-dir> [--force]
                                          install skills into the global skills root (~/.sunshinex/skills)
  flags:
  --mode=manual|plan|dontAsk              permission mode (default manual)
  --language=en|zh                        UI language (default en)
  --version                               print CLI version and exit
  --tier=small|medium|large               model tier (user-level, session-constant)
  --effort=none|minimal|low|medium|high|xhigh|max
                                          reasoning effort (request-level)
  --continue                              TUI, resume latest session
  --resume                                TUI, open the session picker to resume
  --worktree[=<name>]                     TUI, launch in an isolated git worktree
  --workdir=<dir>                         workspace directory
  --add-dir=<dir>                         extend trusted dirs (repeatable)
  unrecognized bare words exit with an error; run sunshinex help for usage`,
    `SunshineX CLI
  sunshinex                               当前工作区启动交互式会话终端（缺省形态）
  sunshinex [dir]                         指定目录启动（路径形态参数：/abs、./x、../x、a/b；或 --workdir=<目录>）
  sunshinex help                          显示用法（--help / -h 同义）
  sunshinex selfcheck                     骨架自检（感知/工具/安全/上下文/Loop/Graph 就绪）
  sunshinex run <dir> --goal="..."        在目录上运行标准验收修正环（非 done 退出码 1）
  sunshinex pipeline <dir> --goal="..." [--yes]
                                          五节点流水线 gate 审批（--yes 跳过交互直接批准）
  sunshinex skills install <git-url | owner/repo | 本地目录> [--force]
                                          把技能安装到全局技能根（~/.sunshinex/skills）
  flags：
  --mode=manual|plan|dontAsk              权限模式（缺省 manual）
  --language=en|zh                        界面语言（缺省 en）
  --tier=small|medium|large               模型档位（用户级，会话内恒定）
  --effort=none|minimal|low|medium|high|xhigh|max
                                          思考强度（请求级参数）
  --continue                              TUI 直接续接最近会话
  --resume                                TUI 弹会话选择卡恢复
  --worktree[=<name>]                     TUI 在隔离 git worktree 中启动
  --workdir=<dir>                         工作区目录
  --add-dir=<dir>                         扩展信任目录（可重复）
  无法识别的裸词报错不启动；使用 sunshinex help 查看使用方法`,
  );
}

/** 用户显式传入的 flag 值合法性单点校验（环境变量兜底形态不在此列，保持既有回退语义）：非法值 fail-fast 报错退出，
 *  杜绝静默回落缺省（如 --mode=dontask 回落 manual 后审批行为与预期不符且无任何提示）；报错随附 help 指引 */
export function assertValidFlagValues(args: CliArgs): void {
  const invalid: string[] = [];
  const single = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const mode = single(args.flags.mode);
  if (mode !== undefined && mode !== 'manual' && mode !== 'plan' && mode !== 'dontAsk') invalid.push(`--mode=${mode}`);
  const language = single(args.flags.language);
  if (language !== undefined && language !== 'en' && language !== 'zh') invalid.push(`--language=${language}`);
  const tier = single(args.flags.tier);
  if (tier !== undefined && tier !== 'small' && tier !== 'medium' && tier !== 'large') invalid.push(`--tier=${tier}`);
  const effort = single(args.flags.effort);
  if (effort !== undefined && !(EFFORT_ORDER as readonly string[]).includes(effort.trim().toLowerCase())) invalid.push(`--effort=${effort}`);
  if (invalid.length > 0) {
    throw new Error(t(
      `Invalid flag value: ${invalid.join(', ')}. Run sunshinex help for usage.`,
      `非法的 flag 取值：${invalid.join(', ')}。使用 sunshinex help 查看使用方法`,
    ));
  }
}

async function main(): Promise<void> {
  const args = resolveInvocation(parseArgs(process.argv.slice(2)));
  // 版本号先于 settings 链装载与语言设定：--version 是纯产物事实查询，输出固定 en 单语
  if (args.flags.version === true || args.flags.v === true) {
    console.log(cliVersion());
    return;
  }
  // 三级配置链（对标 Claude Code 用户级 + 项目级惯例）：已导出环境变量 > 项目 settings > 全局 settings
  // 项目级先装、全局后装兜底——装载器只填缺省键，后装者仅补缺不覆盖，顺序即优先级
  const projectRoot = process.cwd();
  loadSettingsChain(projectRoot);
  // flag 值校验先于语言设定与一切装配：非法值报错退出（错误文案固定 en——setLanguage 尚未执行的时序事实）
  assertValidFlagValues(args);
  // 界面语言：--language=en|zh > settings language 槽 > 缺省 en（zh 为全中文界面 + 中文模型侧提示词；
  // 先于任何输出与装配设定，--help 亦随语言；parseLanguage 仅判 zh/en，回退链由调用点 ?? 承载）
  // 可重复 flag 归一余量：数组形态按非法值处理（同 parseLanguage 缺省 en）
  const langFlag = args.flags.language;
  setLanguage(parseLanguage((Array.isArray(langFlag) ? undefined : langFlag) ?? process.env.SUNSHINEX_LANGUAGE));
  // v 已在前置版本短路消费（提前 return，此处仅 help/h）
  if (args.flags.help === true || args.flags.h === true) {
    console.log(usageText());
    return;
  }
  if (args.command === 'unrecognized') {
    console.error(t('Unrecognized command. Run sunshinex help for usage.', '无法识别命令，使用 sunshinex help 查看使用方法'));
    process.exit(1);
  }
  switch (args.command) {
    case 'selfcheck':
      return runSelfcheck(args);
    case 'run':
      return runLoop(args);
    case 'pipeline':
      return runPipeline(args);
    case 'skills':
      return runSkillsInstall(args);
    case 'tui': {
      const d = resolveDirArg(args);
      if (d.unrecognized) {
        console.error(t('Unrecognized command. Run sunshinex help for usage.', '无法识别命令，使用 sunshinex help 查看使用方法'));
        process.exit(1);
      }
      if (d.ignored) console.warn(t(`--workdir takes precedence; ignoring positional dir ${d.ignored}`, `--workdir 优先，位置参数目录 ${d.ignored} 已忽略`));
      return runTui({ ...args, positional: d.dir ? [d.dir] : [] });
    }
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
