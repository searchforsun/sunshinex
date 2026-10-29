/**
 * CLI 公共 target 解析 + catalog 族共享小助手（Task 17 起，Task 18 扩为各命令族共用单点）：
 * - resolveTarget：--scope/--root/--json 三旗标扫描（mcp/agents/skills/settings/plugins enable 同用）；
 * - 各命令族旗标词汇表（MCP_FLAG_KEYS / AGENTS_FLAG_KEYS / SKILLS_FLAG_KEYS / SETTINGS_FLAG_KEYS）+
 *   backfillFlags 回填单点（cli/index dispatch 把 parseArgs 拆装结果还原为原始 token）；
 * - runCatalogWrite：CatalogWriteError → stderr + exit 1 的 T15 错误语义映射单点（mcp 上收共享）；
 * - entryArg：条目名守卫单点（缺参/形如旗标 → undefined，调用方 usage + exit 1）。
 * resolveTarget 两形态沿 plugins.parseRootFlag 惯例（`--flag v` / `--flag=v`）：
 * - `--scope=global` → { scope: 'global', root: null }（全局面——list 消费 root=null 的合并视图后按
 *   作用域过滤，写面落 global scope，即 ~/.sunshinex/ 下的 catalog 文件）
 * - 缺省 project → { scope: 'project', root: < --root 目录或 process.cwd() 的绝对路径> }（项目面
 *   锚点，catalog 写面凭它落 <root>/.sunshinex/）
 * - `--json` → json: true（list 数据面 JSON 输出口）
 * 词汇表内子命令自有旗标（command/arg/env/name/executor 等）跳过不验——归子命令解析面；
 * 词汇表外旗标（拼错一类）在两处口径不同：顶层 dispatch 回填时按 plugins 先例静默丢弃（语言类全局
 * 旗标由此兼容），本面 bad 仅防御直调面（进程内直跑 runMcpCommand 一类）；--scope 值越界 / --root
 * 缺值 → bad，调用方走 usage + exit 1（非法参数口径）。
 */
import * as path from 'node:path';
import type { Scope } from '../../catalog/types';
import { CatalogWriteError } from '../../catalog/io';

/** mcp 族旗标词汇表单点：前三为公共 target 旗标（本面消费），其余子命令自有（跳过）；
 *  cli/index dispatch 按此表回填 parseArgs 拆装结果（词汇表外旗标静默丢弃——plugins case 同款宽松口径，
 *  语言类全局旗标 main 已先行消费） */
export const MCP_FLAG_KEYS: readonly string[] = ['scope', 'root', 'json', 'command', 'arg', 'env', 'url', 'transport'];

/** agents 族旗标词汇表（Task 18）：前三为公共 target 旗标，其余 add 子命令自有；--memory 是布尔旗
 *  （bare 形态 true，`--memory=false` 显式停用形态归子命令解析面归一） */
export const AGENTS_FLAG_KEYS: readonly string[] = ['scope', 'root', 'json', 'name', 'description', 'memory', 'isolation', 'executor', 'body-file'];

/** skills 族旗标词汇表（Task 18）：list 仅公共 target 旗标（--scope 值域 all|project|global 归子命令解析面） */
export const SKILLS_FLAG_KEYS: readonly string[] = ['scope', 'root', 'json'];

/** settings 族旗标词汇表（Task 18）：get/set 仅公共 target 旗标 */
export const SETTINGS_FLAG_KEYS: readonly string[] = ['scope', 'root'];

/** providers 族旗标词汇表（Task 19）：前三为公共 target 旗标，其余 add/set/model 三操作自有。
 *  --models 是单值逗号清单（`--models=a,b` 一串即清单，清单序 = 模型优先级）——非可重复旗，
 *  不进 cli/index REPEATABLE_FLAGS；--supports-images 是布尔旗（bare 形态 true，agents --memory 同款） */
export const PROVIDERS_FLAG_KEYS: readonly string[] = ['scope', 'root', 'json', 'base-url', 'models', 'context-window', 'reasoning-effort', 'supports-images', 'tier', 'direction'];

/** 解析产物：scope+root 定位 catalog 读写目标面，json 是 list 输出形态旗，bad 走调用方 usage */
export interface ResolvedTarget {
  scope: Scope;
  /** 项目锚绝对路径（project 作用域定位/写面锚）；global 作用域恒 null */
  root: string | null;
  json: boolean;
  /** 非法参数（--scope 值越界 / --root 缺值 / 词汇表外旗标）→ 调用方 usage 行 + exit 1 */
  bad: boolean;
}

/**
 * 扫描 args 提取公共 target：位置参数（子命令名/条目名）不归本面管；子命令自有旗标两形态吞值跳过。
 * ownFlags = 调用方命令族的子命令自有旗标词汇表（mcp 缺省 MCP_FLAG_KEYS 零改现场；agents 传
 * AGENTS_FLAG_KEYS——Task 18 修补：add 的 --name/--memory 等旗标直调面曾被误判词汇表外 → bad；
 * 两 token 形态吞值仅在值不像旗标时吞（--memory 一类布尔旗的 bare 形态不得吞掉后续旗标））。
 * --root 只对 project 作用域有意义（global 恒 null——全局面无项目锚，显式传 --root 亦不落 target）。
 */
export function resolveTarget(args: string[], ownFlags: readonly string[] = MCP_FLAG_KEYS): ResolvedTarget {
  const target: ResolvedTarget = { scope: 'project', root: null, json: false, bad: false };
  let rootArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') {
      target.json = true;
      continue;
    }
    if (a.startsWith('--json=')) {
      // --json 是布尔旗（bare 形态），带值即用法错（拒识防 --json=false 静默失效）
      target.bad = true;
      continue;
    }
    if (a === '--scope' || a.startsWith('--scope=')) {
      const v = a === '--scope' ? args[++i] : a.slice('--scope='.length);
      if (v === 'global' || v === 'project') target.scope = v;
      else target.bad = true;
      continue;
    }
    if (a === '--root' || a.startsWith('--root=')) {
      const v = a === '--root' ? args[++i] : a.slice('--root='.length);
      // 值缺失/形如旗标/空串 → bad（parseRootFlag 同款守卫）
      if (v === undefined || v === '' || v.startsWith('--')) target.bad = true;
      else rootArg = v;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (!MCP_FLAG_KEYS.includes(key) && !ownFlags.includes(key)) {
        target.bad = true; // 词汇表外旗标：直调面拒识（spawn 面经 dispatch 回填，词典外旗标已被静默丢弃，不达此处）
        continue;
      }
      // 子命令自有旗标：两形态吞值跳过，值合法性归子命令解析面；bare 形态仅在下一个 token
      // 像值（非旗标）时吞——布尔旗（--memory）与缺值形态不吞后续 token
      if (eq === -1) {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) i++;
      }
      continue;
    }
    // 位置参数（子命令名/条目名）跳过
  }
  target.root = target.scope === 'global' ? null : path.resolve(rootArg ?? process.cwd());
  return target;
}

/**
 * dispatch 回填单点（Task 18 自 cli/index mcp case 内联循环上收）：parseArgs 拆装结果按词汇表还原为
 * 原始 token 形态（数组 = 可重复旗展开多值；true = 裸旗原样透传由子命令裁定；其余 `--key=value`）。
 * 词汇表外旗标静默丢弃（plugins 先例——语言类全局旗标 main 已先行消费，不进词汇表即不会回传）。
 */
export function backfillFlags(flags: Record<string, string | boolean | string[] | undefined>, keys: readonly string[]): string[] {
  const rest: string[] = [];
  for (const key of keys) {
    const v = flags[key];
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) rest.push(`--${key}=${item}`);
    else if (v === true) rest.push(`--${key}`);
    else rest.push(`--${key}=${v}`);
  }
  return rest;
}

/**
 * catalog 写面统一出口（T15 错误语义映射，Task 18 自 mcp.ts 上收共享）：CatalogWriteError
 * （COMMENTS/INVALID）→ stderr 错误行 + exit 1（CLI 无 409 概念；COMMENTS 文案自带「含注释 →
 * raw 编辑面移除后重试」指引）；其余异常原样穿透（main 的 CLI-ERROR 兜底）。
 */
export function runCatalogWrite(fn: () => void): number {
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

/** 条目名守卫单点（Task 18 自 mcp.ts 上收共享）：缺参/形如旗标 → undefined（调用方 usage + exit 1；
 *  e2e 用例口径——usage 错误零盘上副作用） */
export function entryArg(args: string[]): string | undefined {
  const name = args[0];
  return name === undefined || name.startsWith('--') ? undefined : name;
}
