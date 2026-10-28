/**
 * catalog/mcp 读面：两级（全局/项目）mcp.json 合并列举 + 遮蔽标注。
 * 与装载面（config.loadMcpServers）的分工：装载面丢遮蔽条目（运行时一台只装一份，Task 4 接线）；
 * 本面是「视图」——项目同名遮蔽全局时，全局条目保留在列并标 shadowed:true（catalog 面要能看清
 * 全局配了什么、被谁遮蔽）。读纪律沿 catalog/io 单点（readJsoncDoc），条目形状判定复用
 * parseMcpJsonFile 的谓词（单点，不另造解析器）；项目条目 approval 接 approvals.approvalState
 * 批准阀（Task 3——项目 mcp.json 随仓库分发，未审不启），全局条目恒 'none'（用户手配不过阀）。
 */
import * as path from 'node:path';
import { userConfigDir } from '../config/env';
import { parseMcpJsonFile } from '../config';
import type { McpServerConfig } from '../types';
import type { Listing, Scope } from './types';
import { readJsoncDoc } from './io';
import { approvalState } from './approvals';

/** catalog 列表条目：name/scope 定位 + 遮蔽标注 + 原始 server 配置 + 审批态（project 接批准阀，global 恒 'none'） */
export interface McpServerEntry {
  name: string;
  scope: Scope;
  /** true = 被另一作用域同名条目遮蔽（项目遮全局）；仅视图标注，条目本身保留在列 */
  shadowed: boolean;
  server: McpServerConfig;
  approval: 'none' | 'approved' | 'pending' | 'denied';
}

/** mcp.json 落位单点：global=<userConfigDir>/mcp.json（globalDir 显式传参 = 测试/重定向口）；project=<root>/.sunshinex/mcp.json（root 缺省回退 cwd，与 CLI 无项目上下文时口径一致） */
export function mcpJsonPath(scope: Scope, root: string | null, globalDir?: string): string {
  if (scope === 'global') return path.join(globalDir ?? userConfigDir(), 'mcp.json');
  return path.join(root ?? process.cwd(), '.sunshinex', 'mcp.json');
}

/**
 * 两级合并列举：全局先、项目后；各作用域内按 name 字典序；同名项目遮蔽全局（全局标 shadowed 保留）。
 * 容错口径沿 Listing（D7）：缺文件 = 空条目不算错；坏 JSON / 根非对象 / mcpServers 形状非法 /
 * 单条目形状非法（parseMcpJsonFile 静默拒收）一律降级产 warnings，不抛错——列举面宁可少配不可错配。
 */
export function listMcpServers(root: string | null, globalDir?: string): Listing<McpServerEntry> {
  const warnings: string[] = [];
  /** 单作用域读面：readJsoncDoc 出文件级告警，parseMcpJsonFile 出条目（缺文件跳过，避免双读双告警） */
  const readScope = (scope: Scope): McpServerConfig[] => {
    const file = mcpJsonPath(scope, root, globalDir);
    const doc = readJsoncDoc(file);
    warnings.push(...doc.warnings);
    if (!doc.exists) return [];
    const servers = parseMcpJsonFile(file);
    // 坏条目对账：doc 里声明了、但形状谓词拒收的键 → 跳过并产告警（parseMcpJsonFile 自身静默）
    const entry = doc.doc['mcpServers'];
    if (entry !== undefined && (entry === null || typeof entry !== 'object' || Array.isArray(entry))) {
      warnings.push(`${file} mcpServers 须为对象，已按空处理`);
      return servers;
    }
    const known = new Set(servers.map((s) => s.name));
    for (const name of Object.keys(entry as Record<string, unknown>)) {
      if (!known.has(name)) warnings.push(`${file} 条目 "${name}" 形状非法，已跳过`);
    }
    return servers;
  };
  // approval 接线：项目条目过批准阀（root 缺省回退 cwd——与 mcpJsonPath 项目落位同口径）；
  // 全局条目不过阀（用户手配非仓库供给）恒 'none'。读全局 settings 走 parseSettingsFile 既有纪律。
  const effectiveRoot = root ?? process.cwd();
  const toEntry = (scope: Scope) => (s: McpServerConfig): McpServerEntry => ({
    name: s.name,
    scope,
    shadowed: false,
    server: s,
    approval: scope === 'project' ? approvalState(effectiveRoot, s.name) : 'none',
  });
  const globalEntries = readScope('global').map(toEntry('global'));
  const projectEntries = readScope('project').map(toEntry('project'));
  // 遮蔽标注：项目同名遮蔽全局——全局条目保留在列、标 shadowed:true（视图口径）
  const projectNames = new Set(projectEntries.map((e) => e.name));
  for (const g of globalEntries) if (projectNames.has(g.name)) g.shadowed = true;
  const byName = (a: McpServerEntry, b: McpServerEntry): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { entries: [...globalEntries.sort(byName), ...projectEntries.sort(byName)], warnings };
}
