/**
 * permissions 结构化语义键装载与规则匹配单点（spec 5.2）：
 * - 两级装载合并不遮蔽：全局 ~/.sunshinex/settings.json + 项目 .sunshinex/settings.json 数组拼接去重
 *   （deny 取并集——项目级不得解除全局 deny；对标 CC 层级合并语义）
 * - 单级形状非法 → 该级 warning 跳过（对标 mcp.json 非法条目跳过语义），畸形 JSON 由 settings 装载链统一 fail-fast
 * - 语法 Tool(specifier)：文件工具 = 路径 glob（`**` 跨段、`*`/`?` 不跨段、无 `/` 模式对 basename 匹配）；
 *   Bash = 命令匹配（尾 `*` 为前缀）；mcp__ 直名（尾 `*` 通配）
 */
import * as path from 'path';
import { parseRule } from '../harness/security/rules';
import { parseSettingsFile, loadProjectSettings, loadGlobalSettings } from './settings';

export interface PermissionsConfig {
  deny: string[];
  allow: string[];
  additionalDirs: string[];
}

export interface LoadedPermissions {
  config: PermissionsConfig;
  warnings: string[];
}

const EMPTY: PermissionsConfig = { deny: [], allow: [], additionalDirs: [] };

function readLevel(filePath: string, warnings: string[]): PermissionsConfig {
  let doc: ReturnType<typeof parseSettingsFile> = null;
  try {
    doc = parseSettingsFile(filePath);
  } catch {
    doc = null; // 畸形 JSON 由 settings 装载链统一上报；此处按缺级处理
  }
  if (doc === null || doc.permissions === undefined) return EMPTY;
  const raw = doc.permissions as unknown;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warnings.push(`settings.json permissions 须为对象（${filePath}），该键已忽略`);
    return EMPTY;
  }
  const obj = raw as Record<string, unknown>;
  const strArr = (value: unknown, name: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((s) => typeof s !== 'string')) {
      warnings.push(`settings.json permissions.${name} 须为字符串数组（${filePath}），该键已忽略`);
      return [];
    }
    return value as string[];
  };
  return {
    deny: strArr(obj.deny, 'deny'),
    allow: strArr(obj.allow, 'allow'),
    additionalDirs: strArr(obj.additionalDirs, 'additionalDirs'),
  };
}

/** 两级装载合并不遮蔽：全局在前、项目在后，数组拼接去重 */
export function loadPermissions(projectRoot: string): LoadedPermissions {
  const warnings: string[] = [];
  const levels = [readLevel(loadGlobalSettings(), warnings), readLevel(loadProjectSettings(projectRoot), warnings)];
  return {
    config: {
      deny: [...new Set(levels.flatMap((l) => l.deny))],
      allow: [...new Set(levels.flatMap((l) => l.allow))],
      additionalDirs: [...new Set(levels.flatMap((l) => l.additionalDirs))],
    },
    warnings,
  };
}

function escapeRegExp(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 路径 glob → 正则片段（gitignore 风格，spec 5.2）：`**` 跨段、`*`/`?` 不跨段 */
function pathGlobToRegex(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('**', i)) {
      const prevIsSlash = i === 0 || pattern[i - 1] === '/';
      const nextIsSlash = pattern[i + 2] === '/';
      if (prevIsSlash && nextIsSlash) {
        out += '(?:[^/]+/)*';
        i += 3;
        continue;
      }
      out += '.*';
      i += 2;
      continue;
    }
    const ch = pattern[i]!;
    out += ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : escapeRegExp(ch);
    i += 1;
  }
  return out;
}

/** 路径 glob 匹配（target 须 `/` 分隔）：无 `/` 模式对 basename，其余对整路径 */
export function pathGlobMatch(pattern: string, target: string): boolean {
  if (!pattern.includes('/')) {
    // 无 `/` 模式只钉裸文件名：target 带目录成分直接不命中（对标 mcp.json server 名的直名语义，杜绝 *.pem 吞掉 a/server.pem）
    if (target.includes('/')) return false;
    return new RegExp('^' + pathGlobToRegex(pattern) + '$').test(target);
  }
  return new RegExp('^' + pathGlobToRegex(pattern) + '$').test(target);
}

/** 单条规则匹配：文件工具对 specifiers 任一命中即命中；Bash 尾 `*` 前缀否则全等；mcp 直名尾 `*` 通配 */
export function matchPermission(rule: string, tool: string, specifiers: string[]): boolean {
  const { tool: ruleTool, specifier: spec } = parseRule(rule);
  const toolMatches = ruleTool.endsWith('*')
    ? tool.startsWith(ruleTool.slice(0, -1))
    : ruleTool === tool || ruleTool === '*';
  if (!toolMatches) return false;
  if (spec === null || spec === '*') return true;
  const first = specifiers[0] ?? '';
  if (ruleTool === 'Bash' || ruleTool.startsWith('mcp__')) {
    return spec.endsWith('*') ? first.startsWith(spec.slice(0, -1)) : first === spec;
  }
  return specifiers.some((s) => pathGlobMatch(spec, s));
}

/** 规则清单匹配：任一条命中即 true */
export function matchAnyRule(rules: string[], tool: string, specifiers: string[]): boolean {
  return rules.some((rule) => matchPermission(rule, tool, specifiers));
}
