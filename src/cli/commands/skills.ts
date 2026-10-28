/**
 * sunshinex skills list（Task 18）：catalog skills 只读视图的 CLI 出口，与 skills-install 同族分发
 * （cli/index skills case：`skills list` 走本模块，`skills install` 沿既有 runSkillsInstall 不动）。
 * 分组表格：id/name/来源(source)/遮蔽(shadowedBy)——条目序沿 listSkills 链序（project → user →
 * learned → plugin 组序，组内沿链现序），「分组」即来源段自然分组呈现。--scope 过滤段：all（缺省）
 * = 全链；project = 项目段；global = 非项目段（user/learned/plugin，两级语义的自然投影——技能链本就
 * 项目根在前、用户级根在后）。--json 输出 SkillEntry 原样数组。skills 只读是设计裁定（catalog/skills
 * 模块头）：本命令零写面。
 * 通道即语义（mcp.ts 先例）：结果面（表格/JSON）stdout、诊断面 stderr、非法参数 usage + exit 1。
 * --scope 解析不经 resolveTarget（其值域固定 global|project，不含本面的 all），口径同形自扫。
 */
import CliTable3 from 'cli-table3';
import * as path from 'node:path';
import { listSkills } from '../../catalog/skills';
import { t } from '../../i18n';

function printUsage(): void {
  console.error(t(
    'Usage: sunshinex skills list [--scope=all|project|global] [--root <dir>] [--json]',
    '用法：sunshinex skills list [--scope=all|project|global] [--root <目录>] [--json]',
  ));
}

function listCmd(args: string[]): number {
  let scope: 'all' | 'project' | 'global' = 'all';
  let rootArg: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a.startsWith('--json=')) {
      printUsage(); // 布尔旗带值拒识（resolveTarget 同口径）
      return 1;
    }
    if (a === '--scope' || a.startsWith('--scope=')) {
      const v = a === '--scope' ? args[++i] : a.slice('--scope='.length);
      if (v === 'all' || v === 'project' || v === 'global') scope = v;
      else {
        printUsage();
        return 1;
      }
      continue;
    }
    if (a === '--root' || a.startsWith('--root=')) {
      const v = a === '--root' ? args[++i] : a.slice('--root='.length);
      if (v === undefined || v === '' || v.startsWith('--')) {
        printUsage();
        return 1;
      }
      rootArg = v;
      continue;
    }
    printUsage(); // list 无位置参数，未知 token 一律 usage
    return 1;
  }
  const root = path.resolve(rootArg ?? process.cwd());
  const listing = listSkills(root);
  // 段过滤：project = 项目五根段；global = 非项目段（user/learned/plugin）；all = 全链不筛
  const entries = scope === 'all'
    ? listing.entries
    : listing.entries.filter((e) => (scope === 'project' ? e.source === 'project' : e.source !== 'project'));
  if (json) {
    console.log(JSON.stringify(entries, null, 2));
  } else {
    // 表格（cli-table3，style 清空色码沿 plugins 先例，输出保持纯文本可管道）；遮蔽列 = 胜者来源名
    const table = new CliTable3({
      head: ['id', 'name', t('source', '来源'), t('shadowed', '遮蔽')],
      style: { head: [], border: [] },
    });
    for (const e of entries) {
      table.push([e.id, e.name, e.source, e.shadowedBy ?? '']);
    }
    console.log(table.toString());
  }
  for (const w of listing.warnings) console.warn(`[warn] ${w}`);
  return 0;
}

/** 命令入口：skills list（install 归 runSkillsInstall，dispatch 层分流）；返回 exit code，调用方落 process.exitCode */
export async function runSkillsCommand(args: string[]): Promise<number> {
  if (args[0] === 'list') return listCmd(args.slice(1));
  printUsage();
  return 1;
}
