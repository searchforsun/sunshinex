/**
 * sunshinex agents 子命令族（Task 18，Phase D 第二批 catalog CLI 族）：
 *   list [--scope=global|project] [--root <dir>] [--json]
 *   add <id> --name=<n> [--description=<d>] [--memory] [--isolation=worktree]
 *        [--executor=internal-team|external-cli] [--body-file=<path>]
 *   remove|enable|disable <id>
 * 读写全走 catalog 单点（listAgents / upsertAgent / removeAgent / setAgentEnabled），CLI 零自管盘上
 * 形态；两级视图（全局 → 项目新家）在 list 标注 scope/shadowed/enabled（--json
 * 输出 AgentEntry 原样数组）。add 的 --body-file 读文件为正文（frontmatter 之后的 markdown 本体），
 * 缺省空正文；isolation/executor 枚举校验归 catalog 写面（越界值 CatalogWriteError('INVALID')）。
 * 通道即语义（mcp.ts 先例）：结果面（表格/JSON/ok 行）stdout、诊断面（error/[warn]）stderr、
 * 非法参数 usage + exit 1（仓内零 exit 2 先例）；CatalogWriteError → error 行 + exit 1
 * （runCatalogWrite 单点，T15 映射）。
 * --scope 语义沿 catalog-common：global → 全局面（list 过滤 global 条目，写面落 ~/.sunshinex/agents）；
 * 缺省 project → root = --root 目录或 process.cwd()（写面落 <root>/.sunshinex/agents）。
 */
import * as fs from 'node:fs';
import CliTable3 from 'cli-table3';
import { agentsDir, listAgents, removeAgent, setAgentEnabled, upsertAgent } from '../../catalog/agents';
import type { AgentUpsertSpec } from '../../catalog/agents';
import { t } from '../../i18n';
import { AGENTS_FLAG_KEYS, entryArg, resolveTarget, runCatalogWrite } from './catalog-common';

function printUsage(): void {
  console.error(t(
    'Usage: sunshinex agents list [--scope=global|project] [--root <dir>] [--json]'
    + ' | add <id> --name=<n> [--description=<d>] [--memory] [--isolation=worktree] [--executor=internal-team|external-cli] [--body-file=<path>]'
    + ' | remove|enable|disable <id>',
    '用法：sunshinex agents list [--scope=global|project] [--root <目录>] [--json]'
    + ' | add <id> --name=<名称> [--description=<描述>] [--memory] [--isolation=worktree] [--executor=internal-team|external-cli] [--body-file=<路径>]'
    + ' | remove|enable|disable <id>',
  ));
}

/* ---------- list ---------- */

function listCmd(args: string[]): number {
  const target = resolveTarget(args, AGENTS_FLAG_KEYS);
  if (target.bad) {
    printUsage();
    return 1;
  }
  const listing = listAgents(target.root);
  // --scope=global 过滤全局面（listAgents(null) 只列全局，root 非 null 时合并视图含项目级+全局）；
  // 缺省 project = 全量合并视图（global+项目新家，遮蔽标注保留——与 catalog 视图同源裁定）
  const entries = target.scope === 'global' ? listing.entries.filter((e) => e.scope === 'global') : listing.entries;
  if (target.json) {
    // --json 输出 entries 原样数组（含 meta 全量与 bodyPreview），warnings 走 stderr 不混数据面
    console.log(JSON.stringify(entries, null, 2));
  } else {
    // 表格（cli-table3，style 清空色码沿 plugins 先例，输出保持纯文本可管道）
    const table = new CliTable3({
      head: ['id', 'name', 'scope', t('enabled', '启用'), t('shadowed', '遮蔽')],
      style: { head: [], border: [] },
    });
    for (const e of entries) {
      table.push([e.id, e.meta.name, e.scope, e.meta.enabled ? 'on' : 'off', e.shadowed ? 'yes' : '']);
    }
    console.log(table.toString());
  }
  for (const w of listing.warnings) console.warn(`[warn] ${w}`);
  return 0;
}

/* ---------- add ---------- */

/** add 解析产物：条目 id + frontmatter 载荷 + bad（用法错归 usage；枚举越界交 catalog 写面拒） */
interface AddParsed {
  id?: string;
  name?: string;
  description?: string;
  memory?: boolean;
  isolation?: string;
  executor?: string;
  bodyFile?: string;
  bad: boolean;
}

/**
 * add 旗标解析（两形态沿 parseRootFlag 惯例）：--name/--description/--isolation/--executor/--body-file
 * 单值、--memory 布尔旗（bare=true，`--memory=true|false` 显式归一，他值拒识）；公共 target 旗标
 * （scope/root/json）跳过归 resolveTarget；词汇表外旗标 → bad（直调面拒识，spawn 面经 dispatch 回填
 * 不会到达）。id 必填且唯一（positional 恰一个）。
 */
function parseAdd(args: string[]): AddParsed {
  const p: AddParsed = { bad: false };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const inlineVal = eq === -1 ? undefined : a.slice(eq + 1);
    /** 取单值旗标的值（`--flag v` / `--flag=v` 两形态）；缺值/形如旗标 → undefined（调用方记 bad） */
    const take = (): string | undefined => {
      if (inlineVal !== undefined) return inlineVal;
      const v = args[++i];
      return v !== undefined && !v.startsWith('--') ? v : undefined;
    };
    const badIf = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);
    switch (key) {
      case 'name': {
        const v = badIf(take());
        if (v === undefined) p.bad = true;
        else p.name = v;
        break;
      }
      case 'description': {
        const v = badIf(take());
        if (v === undefined) p.bad = true;
        else p.description = v;
        break;
      }
      case 'memory':
        // 布尔旗：bare=true；显式 =true/=false 归一；他值拒识（防 --memory=yes 静默失效）
        if (inlineVal === undefined || inlineVal === 'true') p.memory = true;
        else if (inlineVal === 'false') p.memory = false;
        else p.bad = true;
        break;
      case 'isolation': {
        const v = badIf(take());
        if (v === undefined) p.bad = true;
        else p.isolation = v;
        break;
      }
      case 'executor': {
        const v = badIf(take());
        if (v === undefined) p.bad = true;
        else p.executor = v;
        break;
      }
      case 'body-file': {
        const v = badIf(take());
        if (v === undefined) p.bad = true;
        else p.bodyFile = v;
        break;
      }
      case 'scope':
      case 'root':
        // 公共 target 旗标跳过（两形态；两 token 形态吞值，值合法性归 resolveTarget）
        if (inlineVal === undefined) i++;
        break;
      case 'json':
        // --json 是布尔旗，带值与 resolveTarget 同口径拒识
        if (inlineVal !== undefined) p.bad = true;
        break;
      default:
        p.bad = true; // 词汇表外旗标
    }
  }
  p.id = positional[0];
  if (positional.length !== 1) p.bad = true; // 条目 id 必填且唯一
  return p;
}

function addCmd(args: string[]): number {
  const p = parseAdd(args);
  // --name 必填（catalog 写面同样拒，但缺旗标属用法错归 usage 口径）；id 由 parseAdd 守卫
  if (p.bad || p.id === undefined || p.name === undefined) {
    printUsage();
    return 1;
  }
  const target = resolveTarget(args, AGENTS_FLAG_KEYS);
  if (target.bad) {
    printUsage();
    return 1;
  }
  let body: string | undefined;
  if (p.bodyFile !== undefined) {
    try {
      body = fs.readFileSync(p.bodyFile, 'utf8');
    } catch (e) {
      console.error(t(
        `error: cannot read --body-file: ${p.bodyFile} (${e instanceof Error ? e.message : String(e)})`,
        `error：--body-file 不可读：${p.bodyFile}（${e instanceof Error ? e.message : String(e)}）`,
      ));
      return 1;
    }
  }
  const id = p.id;
  // isolation/executor 以 string 透传，枚举校验归 catalog 写面（越界值 INVALID → error + exit 1）
  const spec: AgentUpsertSpec = {
    name: p.name,
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.memory === true ? { memory: true } : {}),
    ...(p.isolation !== undefined ? { isolation: p.isolation as AgentUpsertSpec['isolation'] } : {}),
    ...(p.executor !== undefined ? { executor: p.executor as AgentUpsertSpec['executor'] } : {}),
    ...(body !== undefined ? { body } : {}),
  };
  const code = runCatalogWrite(() => upsertAgent(target.root, target.scope, id, spec));
  if (code !== 0) return code;
  console.log(t(
    `ok: agent ${id} (${target.scope} ${agentsDir(target.scope, target.root)})`,
    `ok：agent ${id}（${target.scope} ${agentsDir(target.scope, target.root)}）`,
  ));
  return 0;
}

/* ---------- remove / enable / disable ---------- */

function removeCmd(args: string[]): number {
  const id = entryArg(args);
  if (id === undefined) {
    printUsage();
    return 1;
  }
  const target = resolveTarget(args, AGENTS_FLAG_KEYS);
  if (target.bad) {
    printUsage();
    return 1;
  }
  const code = runCatalogWrite(() => removeAgent(target.root, target.scope, id));
  if (code !== 0) return code;
  console.log(t(`ok: removed agent ${id} (${target.scope})`, `ok：已移除 agent ${id}（${target.scope}）`));
  return 0;
}

function toggleCmd(args: string[], enabled: boolean): number {
  const id = entryArg(args);
  if (id === undefined) {
    printUsage();
    return 1;
  }
  const target = resolveTarget(args, AGENTS_FLAG_KEYS);
  if (target.bad) {
    printUsage();
    return 1;
  }
  const code = runCatalogWrite(() => setAgentEnabled(target.root, target.scope, id, enabled));
  if (code !== 0) return code;
  console.log(t(
    `ok: agent ${id} ${enabled ? 'enabled' : 'disabled'} (${target.scope})`,
    `ok：agent ${id} 已${enabled ? '启用' : '停用'}（${target.scope}）`,
  ));
  return 0;
}

/** 命令入口：agents 子命令族；返回 exit code（0 成功 / 1 用法错或写失败），调用方落 process.exitCode */
export async function runAgents(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === 'list') return listCmd(args.slice(1));
  if (sub === 'add') return addCmd(args.slice(1));
  if (sub === 'remove') return removeCmd(args.slice(1));
  if (sub === 'enable') return toggleCmd(args.slice(1), true);
  if (sub === 'disable') return toggleCmd(args.slice(1), false);
  printUsage();
  return 1;
}
