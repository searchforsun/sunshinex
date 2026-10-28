/**
 * sunshinex mcp 子命令族（Task 17，Phase D 首个 catalog CLI 族）：
 *   list [--scope=global|project] [--root <dir>] [--json]
 *   add <name> (--command=<cmd> [--arg=a] [--env=K=V] | --url=<u> [--transport=stdio|http|sse])
 *   remove|enable|disable|test|approve|deny <name>
 * 读写全走 catalog 单点（listMcpServers / upsertMcpServer / removeMcpServer / setMcpServerEnabled /
 * approveMcpServer / denyMcpServer），CLI 零自管盘上形态；approve/deny 是项目级批准阀操作（写全局
 * settings mcpApprovals/mcpDenied 按项目根 slug 记账，catalog 面已互斥维护），--scope=global 不适用。
 * 通道即语义（plugins.ts 先例）：结果面（表格/JSON/ok 行）stdout、诊断面（error/[warn]/hint）stderr、
 * 非法参数 usage + exit 1（仓内零 exit 2 先例）。T15 错误语义映射：CatalogWriteError
 * （COMMENTS/INVALID）→ stderr 错误行 + exit 1（CLI 无 409 概念；COMMENTS 文案自带「含注释 →
 * raw 编辑面移除后重试」指引）。
 * --scope 语义：global → 全局面（list 消费 root=null 合并视图后过滤 global 条目，test 同口径找名）；
 * 缺省 project → root = --root 目录或 process.cwd()。add 到 project 作用域后上屏 approve 指引一行
 * （安全阀指引——项目条目未审不装载）。
 */
import CliTable3 from 'cli-table3';
import { listMcpServers, mcpJsonPath, removeMcpServer, setMcpServerEnabled, upsertMcpServer } from '../../catalog/mcp';
import type { McpServerEntry } from '../../catalog/mcp';
import { approveMcpServer, denyMcpServer } from '../../catalog/approvals';
import { CatalogWriteError } from '../../catalog/io';
import { probeMcpServer } from '../../serve/config-helpers';
import { t } from '../../i18n';
import { resolveTarget } from './catalog-common';

function printUsage(): void {
  console.error(t(
    'Usage: sunshinex mcp list [--scope=global|project] [--root <dir>] [--json]'
    + ' | add <name> (--command=<cmd> [--arg=a] [--env=K=V] | --url=<u> [--transport=stdio|http|sse])'
    + ' | remove|enable|disable|test|approve|deny <name>',
    '用法：sunshinex mcp list [--scope=global|project] [--root <目录>] [--json]'
    + ' | add <名称>（--command=<命令> [--arg=a] [--env=K=V] | --url=<地址> [--transport=stdio|http|sse]）'
    + ' | remove|enable|disable|test|approve|deny <名称>',
  ));
}

/**
 * catalog 写面统一出口：CatalogWriteError（COMMENTS/INVALID）→ stderr 错误行 + exit 1（T15 映射，
 * CLI 无 409 概念）；其余异常原样穿透（main 的 CLI-ERROR 兜底）。
 */
function runWrite(fn: () => void): number {
  try {
    fn();
    return 0;
  } catch (e) {
    if (e instanceof CatalogWriteError) {
      console.error(`error: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

/** 条目名守卫：缺参/形如旗标 → usage（e2e 用例⑥口径——usage 错误零盘上副作用） */
function nameArg(args: string[]): string | undefined {
  const name = args[0];
  return name === undefined || name.startsWith('--') ? undefined : name;
}

/* ---------- list ---------- */

/** 端点摘要：http/sse → url；stdio/缺省 → command + args 拼接（gitnexus 形态无 transport 有 url 时兜底 url） */
function endpointOf(e: McpServerEntry): string {
  const s = e.server;
  if (s.transport === 'http' || s.transport === 'sse') return s.url ?? '';
  const cmd = [s.command ?? '', ...(s.args ?? [])].filter((v) => v !== '').join(' ');
  return cmd !== '' ? cmd : s.url ?? '';
}

function listCmd(args: string[]): number {
  const target = resolveTarget(args);
  if (target.bad) {
    printUsage();
    return 1;
  }
  const listing = listMcpServers(target.root);
  // --scope=global 过滤全局面（listMcpServers(null) 的合并视图仍含 cwd 项目条目，视图自筛）；
  // 缺省 project = 全量合并视图（global+project，遮蔽标注保留——与 daemon GET 面同源裁定）
  const entries = target.scope === 'global' ? listing.entries.filter((e) => e.scope === 'global') : listing.entries;
  if (target.json) {
    // --json 输出 entries 原样数组（含 server 全量配置与 approval 态），warnings 走 stderr 不混数据面
    console.log(JSON.stringify(entries, null, 2));
  } else {
    // 表格（cli-table3，style 清空色码沿 plugins 先例，输出保持纯文本可管道）
    const table = new CliTable3({
      head: ['name', 'scope', t('enabled', '启用'), 'approval', t('shadowed', '遮蔽'), t('endpoint', '端点')],
      style: { head: [], border: [] },
    });
    for (const e of entries) {
      table.push([e.name, e.scope, e.server.enabled === false ? 'off' : 'on', e.approval, e.shadowed ? 'yes' : '', endpointOf(e)]);
    }
    console.log(table.toString());
  }
  for (const w of listing.warnings) console.warn(`[warn] ${w}`);
  return 0;
}

/* ---------- add ---------- */

/** add 解析产物：条目名 + 载荷形态二选一（command 形 / url 形）+ bad（用法错归 usage） */
interface AddParsed {
  name?: string;
  command?: string;
  url?: string;
  transport?: string;
  args: string[];
  env: Record<string, string>;
  bad: boolean;
}

/**
 * add 旗标解析（两形态沿 parseRootFlag 惯例）：--command/--url/--transport 单值、--arg/--env 可重复；
 * 单值旗标取值缺失/形如旗标 → bad。形态约束（与 usage 行括号 alternation 同口径）：
 * command/url 互斥必居其一；--arg/--env 仅 command 形（stdio 子进程面）；--transport 仅 url 形。
 */
function parseAdd(args: string[]): AddParsed {
  const p: AddParsed = { args: [], env: {}, bad: false };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    if (a === '--command' || a.startsWith('--command=')) {
      const v = a === '--command' ? args[++i] : a.slice('--command='.length);
      if (v === undefined || v === '' || v.startsWith('--')) p.bad = true;
      else p.command = v;
    } else if (a === '--url' || a.startsWith('--url=')) {
      const v = a === '--url' ? args[++i] : a.slice('--url='.length);
      if (v === undefined || v === '' || v.startsWith('--')) p.bad = true;
      else p.url = v;
    } else if (a === '--transport' || a.startsWith('--transport=')) {
      const v = a === '--transport' ? args[++i] : a.slice('--transport='.length);
      if (v === undefined || v === '' || v.startsWith('--')) p.bad = true;
      else p.transport = v;
    } else if (a === '--arg' || a.startsWith('--arg=')) {
      const v = a === '--arg' ? args[++i] : a.slice('--arg='.length);
      if (v === undefined || v === '' || v.startsWith('--')) p.bad = true;
      else p.args.push(v);
    } else if (a === '--env' || a.startsWith('--env=')) {
      const v = a === '--env' ? args[++i] : a.slice('--env='.length);
      const eq = typeof v === 'string' ? v.indexOf('=') : -1;
      // K=V 形：首个 = 分键值，空键/无 = → bad
      if (typeof v !== 'string' || v === '' || v.startsWith('--') || eq <= 0) p.bad = true;
      else p.env[v.slice(0, eq)] = v.slice(eq + 1);
    } else if (a === '--json' || a.startsWith('--json=')) {
      // 公共 target 旗标归 resolveTarget；--json 是布尔旗，带值与 resolveTarget 同口径拒识
      if (a.startsWith('--json=')) p.bad = true;
    } else if (a === '--scope' || a === '--root' || a.startsWith('--scope=') || a.startsWith('--root=')) {
      // 公共 target 旗标跳过（两形态；带值形态已定格，两 token 形态吞值）
      if (!a.includes('=')) i++;
    } else {
      p.bad = true; // 词汇表外旗标
    }
  }
  p.name = positional[0];
  if (positional.length !== 1) p.bad = true; // 条目名必填且唯一
  return p;
}

function addCmd(args: string[]): number {
  const p = parseAdd(args);
  const commandForm = p.command !== undefined;
  const urlForm = p.url !== undefined;
  // 形态约束违例与 catalog 载荷校验分工：互斥/必居其一/旗标-形态错配在 CLI 拦（usage 口径），
  // transport 枚举/名称形状等载荷校验归 catalog 单点（upsertMcpServer fail-fast）
  const mismatched = (urlForm && (p.args.length > 0 || Object.keys(p.env).length > 0)) || (commandForm && p.transport !== undefined);
  if (p.bad || (commandForm && urlForm) || (!commandForm && !urlForm) || mismatched) {
    printUsage();
    return 1;
  }
  const target = resolveTarget(args);
  if (target.bad) {
    printUsage();
    return 1;
  }
  const server = commandForm
    ? {
        command: p.command,
        ...(p.args.length > 0 ? { args: p.args } : {}),
        ...(Object.keys(p.env).length > 0 ? { env: p.env } : {}),
      }
    : { url: p.url as string, ...(p.transport !== undefined ? { transport: p.transport } : {}) }; // urlForm 已守卫
  const code = runWrite(() => upsertMcpServer(target.root, target.scope, p.name!, server));
  if (code !== 0) return code;
  const file = mcpJsonPath(target.scope, target.root);
  console.log(t(`ok: mcp server ${p.name} (${target.scope} ${file})`, `ok：mcp server ${p.name}（${target.scope} ${file}）`));
  // 安全阀指引：project 条目随仓库分发、未审不装载——上屏一行 approve 指引（诊断面，不混数据管道）
  if (target.scope === 'project') {
    console.error(t(`hint: first load requires approval — sunshinex mcp approve ${p.name}`, `hint：首次加载需 approve（sunshinex mcp approve ${p.name}）`));
  }
  return 0;
}

/* ---------- remove / enable / disable ---------- */

function removeCmd(args: string[]): number {
  const name = nameArg(args);
  if (name === undefined) {
    printUsage();
    return 1;
  }
  const target = resolveTarget(args);
  if (target.bad) {
    printUsage();
    return 1;
  }
  const code = runWrite(() => removeMcpServer(target.root, target.scope, name));
  if (code !== 0) return code;
  console.log(t(`ok: removed mcp server ${name} (${target.scope})`, `ok：已移除 mcp server ${name}（${target.scope}）`));
  return 0;
}

function toggleCmd(args: string[], enabled: boolean): number {
  const name = nameArg(args);
  if (name === undefined) {
    printUsage();
    return 1;
  }
  const target = resolveTarget(args);
  if (target.bad) {
    printUsage();
    return 1;
  }
  const code = runWrite(() => setMcpServerEnabled(target.root, target.scope, name, enabled));
  if (code !== 0) return code;
  console.log(t(
    `ok: mcp server ${name} ${enabled ? 'enabled' : 'disabled'} (${target.scope})`,
    `ok：mcp server ${name} 已${enabled ? '启用' : '停用'}（${target.scope}）`,
  ));
  return 0;
}

/* ---------- approve / deny（项目级批准阀） ---------- */

function approvalCmd(args: string[], kind: 'approve' | 'deny'): number {
  const name = nameArg(args);
  const target = resolveTarget(args);
  // 批准阀按项目根 slug 记账（approveMcpServer root 必传）——--scope=global 不适用
  if (name === undefined || target.bad || target.scope !== 'project' || target.root === null) {
    printUsage();
    return 1;
  }
  const root = target.root; // 收窄落 const（回调内不保属性收窄）
  const code = runWrite(() => (kind === 'approve' ? approveMcpServer(root, name) : denyMcpServer(root, name)));
  if (code !== 0) return code;
  console.log(t(
    `ok: mcp server ${name} ${kind}d for project (${root})`,
    `ok：mcp server ${name} 已${kind === 'approve' ? '批准' : '拒绝'}（项目 ${root}）`,
  ));
  return 0;
}

/* ---------- test（真连接探测） ---------- */

async function testCmd(args: string[]): Promise<number> {
  const name = nameArg(args);
  if (name === undefined) {
    printUsage();
    return 1;
  }
  const target = resolveTarget(args);
  if (target.bad) {
    printUsage();
    return 1;
  }
  const listing = listMcpServers(target.root);
  const pool = target.scope === 'global' ? listing.entries.filter((e) => e.scope === 'global') : listing.entries;
  // 有效条目裁定沿装载面遮蔽序（entries 排布 global 前 project 后）：倒序取首个同名 = 生效条目
  const entry = pool.slice().reverse().find((e) => e.name === name);
  if (entry === undefined) {
    console.error(t(`error: mcp server not found: ${name}`, `error：找不到 mcp server：${name}`));
    return 1;
  }
  // 探测面照 daemon /settings/mcp/probe 同源（临时装配+握手+tools/list）；失败是结果不是异常——
  // error 行上屏 + exit 1（CLI 面 CI 可判定），进程内零残留由 probeMcpServer finally 收口。
  // name 显式注入：盘上条目本体无 name 键（name 是 mcpServers 的键、值即配置），probe 的连接失败
  // 文案与身份比对（serverInfo.name ≠ cfg.name 恒真→误发 note）都读 cfg.name——T17 评审修补
  const r = await probeMcpServer({ ...entry.server, name: entry.name });
  if (!r.ok) {
    console.error(`error: ${r.error}`);
    return 1;
  }
  console.log(t(
    `ok: ${entry.name} (${r.tools.length} tools${r.tools.length > 0 ? ': ' + r.tools.map((x) => x.name).join(', ') : ''})`,
    `ok：${entry.name}（${r.tools.length} 个工具${r.tools.length > 0 ? '：' + r.tools.map((x) => x.name).join('、') : ''}）`,
  ));
  if (r.note !== undefined) console.log(`note: ${r.note}`);
  return 0;
}

/** 命令入口：mcp 子命令族；返回 exit code（0 成功 / 1 用法错或写失败），调用方落 process.exitCode */
export async function runMcpCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === 'list') return listCmd(args.slice(1));
  if (sub === 'add') return addCmd(args.slice(1));
  if (sub === 'remove') return removeCmd(args.slice(1));
  if (sub === 'enable') return toggleCmd(args.slice(1), true);
  if (sub === 'disable') return toggleCmd(args.slice(1), false);
  if (sub === 'test') return testCmd(args.slice(1));
  if (sub === 'approve') return approvalCmd(args.slice(1), 'approve');
  if (sub === 'deny') return approvalCmd(args.slice(1), 'deny');
  printUsage();
  return 1;
}
