/**
 * CLI 公共 target 解析（Task 17）：catalog 族子命令共用的 --scope/--root/--json 三旗标扫描单点。
 * 两形态沿 plugins.parseRootFlag 惯例（`--flag v` / `--flag=v`）：
 * - `--scope=global` → { scope: 'global', root: null }（全局面——list 消费 root=null 的合并视图后按
 *   作用域过滤，写面落 global scope，即 ~/.sunshinex/ 下的 catalog 文件）
 * - 缺省 project → { scope: 'project', root: < --root 目录或 process.cwd() 的绝对路径> }（项目面
 *   锚点，catalog 写面凭它落 <root>/.sunshinex/）
 * - `--json` → json: true（list 数据面 JSON 输出口）
 * 词汇表（MCP_FLAG_KEYS）内其余旗标（command/arg/env/url/transport）跳过不验——归子命令解析面；
 * 词汇表外旗标（拼错一类）在两处口径不同：顶层 dispatch 回填时按 plugins 先例静默丢弃（语言类全局
 * 旗标由此兼容），本面 bad 仅防御直调面（进程内直跑 runMcpCommand 一类）；--scope 值越界 / --root
 * 缺值 → bad，调用方走 usage + exit 1（非法参数口径）。
 */
import * as path from 'node:path';
import type { Scope } from '../../catalog/types';

/** mcp 族旗标词汇表单点：前三为公共 target 旗标（本面消费），其余子命令自有（跳过）；
 *  cli/index dispatch 按此表回填 parseArgs 拆装结果（词汇表外旗标静默丢弃——plugins case 同款宽松口径，
 *  语言类全局旗标 main 已先行消费） */
export const MCP_FLAG_KEYS: readonly string[] = ['scope', 'root', 'json', 'command', 'arg', 'env', 'url', 'transport'];

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
 * --root 只对 project 作用域有意义（global 恒 null——全局面无项目锚，显式传 --root 亦不落 target）。
 */
export function resolveTarget(args: string[]): ResolvedTarget {
  const target: ResolvedTarget = { scope: 'project', root: null, json: false, bad: false };
  let rootArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
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
      if (!MCP_FLAG_KEYS.includes(key)) {
        target.bad = true; // 词汇表外旗标：直调面拒识（spawn 面经 dispatch 回填，词典外旗标已被静默丢弃，不达此处）
        continue;
      }
      // 子命令自有旗标：两形态吞值跳过，值合法性归子命令解析面
      if (eq === -1) i++;
      continue;
    }
    // 位置参数（子命令名/条目名）跳过
  }
  target.root = target.scope === 'global' ? null : path.resolve(rootArg ?? process.cwd());
  return target;
}
