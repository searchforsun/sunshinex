/**
 * catalog/agents 读面：子智能体定义（<agents 目录>/<id>/agent.md）三级位置合并列举 + 遮蔽/旧位置/启用标注。
 * 位置级序（高→低）：项目新家 <root>/.sunshinex/agents → 全局 <userConfigDir>/agents → 项目旧位置
 * <root>/agents（目录注册制历史装配口径，读面兼容列举、写面只迁不删）。与装载面（harness.AgentRegistry）
 * 的分工：装载面 fail-fast 且每 id 运行期只装一份（Task 7 收口三级装载）；本面是「视图」——全量列出 +
 * 来源标注（新家撞全局：全局条目标 shadowed 保留在列；旧位置仅无同 id 碰撞时列出标 oldLocation）。
 * 逐文件宽容：单文件畸形 → warnings 不抛死（沿 loadAgentsView 纪律）；enabled:false 照列（启停是
 * 写面/视图操作，运行时剔除属装载面职责）。解析词法复用 parseAgentFrontmatter 单点，不另造解析器。
 */
import * as fs from 'fs';
import * as path from 'path';
import { userConfigDir } from '../config/env';
import { parseAgentFrontmatter } from '../harness/subagent';
import type { Listing, Scope } from './types';

/** catalog agents 列表条目：id/scope 定位 + 遮蔽/旧位置标注 + 落盘目录 + frontmatter 元数据 + 正文预览 */
export interface AgentEntry {
  id: string;
  scope: Scope;
  /** true = 被项目新家同 id 遮蔽（全局条目保留展示，沿 listMcpServers/loadAgentsView 视图口径）；旧位置条目恒 false（有碰撞即不列） */
  shadowed: boolean;
  /** true = 来自旧位置 <root>/agents（新家与全局均无同 id 才列出） */
  oldLocation: boolean;
  /** 条目落盘目录（所在 agents 目录下本 id 子目录；agent.md 及同级私有文件均在此） */
  dir: string;
  meta: {
    name: string;
    description: string;
    version: string;
    memory: boolean;
    isolation?: 'worktree';
    executor?: 'internal-team' | 'external-cli';
    enabled: boolean;
  };
  /** frontmatter 之后正文前 200 字符（沿 loadAgentsView 口径，防长正文击穿设置面板） */
  bodyPreview: string;
}

/** agents 落位单点：global=<userConfigDir>/agents（globalDir 显式传参 = 测试/重定向口）；project=<root>/.sunshinex/agents（新家）。
 *  project 分支 root:null → cwd 回退仅为签名全整改（沿 mcpJsonPath 同形）；listAgents 对 root:null 刻意
 *  整体跳过项目两级（见该函数注释），不经此回退——写面调本函数前须自行保证 project 有 root。 */
export function agentsDir(scope: Scope, root: string | null, globalDir?: string): string {
  if (scope === 'global') return path.join(globalDir ?? userConfigDir(), 'agents');
  return path.join(root ?? process.cwd(), '.sunshinex', 'agents');
}

/** 旧位置（legacy）：<root>/agents —— 目录注册制历史装配口径；读面兼容列举（最低优先级），写面只迁不删 */
export function legacyAgentsDir(root: string): string {
  return path.join(root, 'agents');
}

/**
 * 三级合并列举：global → 项目新家 → 旧位置；各层内按 id 字典序（分层序沿 listMcpServers 口径）。
 * 容错口径沿 Listing（D7）：目录缺 = 空条目不算错；单文件畸形（frontmatter 缺块/缺 name、读失败）
 * 一律降级产 warnings 不抛——列举面宁可少列不可抛死。root:null 时项目两级整体跳过（只列全局）：
 * 与 mcp 模块 root:null→cwd 回退刻意不同——mcp 需要「无项目上下文时回落 cwd 惯例位」继续可操作，
 * agents 列表面无此需求：目录注册制定义本就依附具体工作区（新家 .sunshinex/agents 与旧位置 agents
 * 皆是项目概念），凭空落 cwd 只会伪造条目。
 */
export function listAgents(root: string | null, globalDir?: string): Listing<AgentEntry> {
  const warnings: string[] = [];
  /** 单目录扫描：仅收 <id>/agent.md 常规目录（沿 loadAgentsView 几何，无 agent.md 的目录跳过） */
  const scan = (dir: string, scope: Scope, oldLocation: boolean): Map<string, AgentEntry> => {
    const out = new Map<string, AgentEntry>();
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, 'agent.md');
      if (!fs.existsSync(file)) continue;
      try {
        const meta = parseAgentFrontmatter(fs.readFileSync(file, 'utf8'));
        out.set(entry.name, {
          id: entry.name,
          scope,
          shadowed: false,
          oldLocation,
          dir: path.join(dir, entry.name),
          meta: {
            name: meta.name,
            description: meta.description,
            version: meta.version,
            memory: meta.memory,
            ...(meta.isolation !== undefined ? { isolation: meta.isolation } : {}),
            ...(meta.executor !== undefined ? { executor: meta.executor } : {}),
            enabled: meta.enabled,
          },
          bodyPreview: meta.body.slice(0, 200),
        });
      } catch (e) {
        warnings.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  };
  const globalEntries = scan(agentsDir('global', root, globalDir), 'global', false);
  const newHome = root !== null ? scan(agentsDir('project', root, globalDir), 'project', false) : new Map<string, AgentEntry>();
  // 遮蔽标注：新家同 id 遮蔽全局——全局条目保留在列、标 shadowed:true（视图口径，装载面才真正就近取一份）
  for (const id of newHome.keys()) {
    const g = globalEntries.get(id);
    if (g) globalEntries.set(id, { ...g, shadowed: true });
  }
  // 旧位置最低：仅当该 id 在全局与新家都不存在时列出（就近优先零歧义），标 oldLocation:true
  const legacy = root !== null ? scan(legacyAgentsDir(root), 'project', true) : new Map<string, AgentEntry>();
  const legacyEntries = [...legacy.values()].filter((e) => !globalEntries.has(e.id) && !newHome.has(e.id));
  const byId = (a: AgentEntry, b: AgentEntry): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { entries: [...[...globalEntries.values()].sort(byId), ...[...newHome.values()].sort(byId), ...legacyEntries.sort(byId)], warnings };
}
