/**
 * sunshinex plugins list/validate：插件作者 lint 面（Task 13）
 * - list [--root <abs>]：loadEffectivePlugins 两级装载（内置 → 用户，settings 启用态合并，--root = 项目 settings 锚，
 *   缺省 process.cwd()）→ cli-table3 表格：id/version/来源/启用(on/off)/平台(ok/n-a)/server 名(逗号 joined)/告警数；
 *   装载告警表后 `[warn] …` 逐行点名（含 [builtin:id]/[user:id] 前缀）。
 * - validate <dir>：parsePluginManifest 单目录校验（schema 同源——与装载面/随包 plugin-manifest.schema.json 同一规则单点），
 *   errors/warnings 逐行 `error:` / `warn:` 前缀上屏，合法时附一句 ok 级摘要（id/version）。
 * exit code 可进 CI：validate = errors 非空 ? 1 : 0；通道即语义——结果面（表格/摘要）走 stdout、
 * 诊断面（error/warn）走 stderr（管道 2>/dev/null 只剩数据）。未知子命令/缺参 → usage 行 + exit 1
 * （沿仓内非法参数口径：全仓零 exit 2 先例，skills install 缺参/顶层未识别命令同为 1）。
 */
import CliTable3 from 'cli-table3';
import * as path from 'node:path';
import { loadEffectivePlugins, parsePluginManifest } from '../../config/plugins';
import { t } from '../../i18n';

/** 装载注入面（loadEffectivePlugins opts 原型透传）：list 测试经此免真写 HOME 与平台断言跳变，生产缺省全真 */
type LoadOpts = Parameters<typeof loadEffectivePlugins>[1];

function printUsage(): void {
  console.error(t(
    'Usage: sunshinex plugins list [--root <abs>] | validate <dir>',
    '用法：sunshinex plugins list [--root <abs>] | validate <dir>',
  ));
}

/** list 子命令 `--root` 取值提取（`--root v` / `--root=v` 两形态）；未知 token/缺值报 bad 走 usage */
function parseRootFlag(args: string[]): { root?: string; bad?: boolean } {
  let root: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--root') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) return { bad: true };
      root = v;
      i++;
    } else if (a.startsWith('--root=')) {
      root = a.slice('--root='.length);
      if (root === '') return { bad: true };
    } else {
      return { bad: true };
    }
  }
  return { root };
}

/** 命令入口：plugins list/validate；返回 exit code（0 成功 / 1 校验失败或用法错误），调用方落 process.exitCode */
export async function runPlugins(args: string[], opts: LoadOpts = {}): Promise<number> {
  const sub = args[0];
  if (sub === 'list') {
    const { root, bad } = parseRootFlag(args.slice(1));
    if (bad) {
      printUsage();
      return 1;
    }
    const { plugins, warnings } = loadEffectivePlugins(root !== undefined ? path.resolve(root) : process.cwd(), opts);
    // 表格（cli-table3 依赖已有；style 清空色码沿 markdown.ts alignTable 先例，输出保持纯文本可管道）
    const table = new CliTable3({
      head: ['id', 'version', t('source', '来源'), t('enabled', '启用'), t('platform', '平台'), 'server', t('warnings', '告警')],
      style: { head: [], border: [] },
    });
    for (const p of plugins) {
      table.push([
        p.manifest.id,
        p.manifest.version,
        p.source,
        p.enabled ? 'on' : 'off',
        p.platformSupported ? 'ok' : 'n-a',
        Object.keys(p.manifest.mcpServers ?? {}).join(','),
        String(p.warnings.length),
      ]);
    }
    console.log(table.toString());
    for (const w of warnings) console.warn(`[warn] ${w}`);
    return 0;
  }
  if (sub === 'validate') {
    const dir = args[1];
    if (dir === undefined || dir.startsWith('--') || args.length > 2) {
      printUsage();
      return 1;
    }
    const abs = path.resolve(dir);
    const { manifest, warnings, errors } = parsePluginManifest(abs);
    for (const e of errors) console.error(`error: ${e}`);
    for (const w of warnings) console.warn(`warn: ${w}`);
    if (manifest !== null) {
      console.log(t(
        `ok: plugin ${manifest.id}@${manifest.version} (${abs})`,
        `ok：插件 ${manifest.id}@${manifest.version}（${abs}）`,
      ));
    }
    return errors.length > 0 ? 1 : 0;
  }
  printUsage();
  return 1;
}
