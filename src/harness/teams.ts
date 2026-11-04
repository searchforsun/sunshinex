import * as fs from 'fs';
import * as path from 'path';
import { TeamManifest } from '../types';
import { Result, ok, fail } from '../result';
import { userTeamsDir } from '../config/data-dir';
import { parseFrontmatterKV } from './skills';

const TEAM_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 团队 id 格式规范（与 SKILL/AGENT 同一正则，spec §1.1 单点） */
export function isValidTeamId(id: string): boolean {
  return TEAM_ID_PATTERN.test(id);
}

/** 解析 team.md 单行 KV frontmatter（词法复用 skills.parseFrontmatterKV；members 空格分隔、enabled 缺省 true、lead 须 ∈ members） */
export function parseTeamFrontmatter(md: string): { name: string; description: string; version: string; members: string[]; lead?: string; enabled: boolean } {
  const kv = parseFrontmatterKV(md);
  const members = (kv.members ?? '').split(/\s+/).filter((m) => m.length > 0);
  const lead = kv.lead?.trim();
  return {
    name: kv.name ?? '',
    description: kv.description ?? '',
    version: kv.version ?? '0.1.0',
    members,
    ...(lead !== undefined && members.includes(lead) && lead !== '' ? { lead } : {}),
    enabled: kv.enabled !== 'false',
  };
}

/** 两级链（降序）：项目 {root}/.sunshinex/teams → 全局 userTeamsDir()（spec §1.1）。
 *  userDir 显式传参 = userConfigDir 重定向口（测试钉目录，镜像 agentsDir 惯例），teams 根取其 'teams' 子目录 */
function teamsChain(root: string, userDir?: string): string[] {
  return [path.join(root, '.sunshinex', 'teams'), userDir !== undefined ? path.join(userDir, 'teams') : userTeamsDir()];
}

function teamFileIn(dir: string, id: string): string {
  return path.join(dir, id, 'team.md');
}

/** 单根装载：尽力而为（目录缺/条目坏逐条跳过，skills.loadSkillsFrom 同款纪律）；agentIds 在位时算 missing */
function loadTeamsFrom(dir: string, source: 'project' | 'user', agentIds?: ReadonlySet<string>): TeamManifest[] {
  if (!fs.existsSync(dir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: TeamManifest[] = [];
  for (const d of entries) {
    if (!d.isDirectory() || !isValidTeamId(d.name)) continue;
    const file = teamFileIn(dir, d.name);
    if (!fs.existsSync(file)) continue;
    try {
      const meta = parseTeamFrontmatter(fs.readFileSync(file, 'utf8'));
      out.push({
        id: d.name,
        source,
        sourceDir: path.join(dir, d.name),
        ...meta,
        missing: meta.members.filter((m) => agentIds !== undefined && !agentIds.has(m)),
      });
    } catch {
      // 单条目坏档不拖垮整次扫描（skills 装载同款）
    }
  }
  return out;
}

/** 全链装载：就近遮蔽（先装者留）；agentIds 可选（测试/宽容调用面注入；missing 仅在位时非空） */
export function loadTeams(root: string, agentIds?: ReadonlySet<string>, userDir?: string): TeamManifest[] {
  const out: TeamManifest[] = [];
  const seen = new Set<string>();
  for (const [i, dir] of teamsChain(root, userDir).entries()) {
    const source: 'project' | 'user' = i === 0 ? 'project' : 'user';
    for (const t of loadTeamsFrom(dir, source, agentIds)) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

/** 团队清单格式化（确定性：name 码点字典序、平局比 id；desc 截 128、members 展示截 8；空清单 null 零注入） */
export function formatTeamsIndex(teams: TeamManifest[]): string | null {
  if (teams.length === 0) return null;
  const sorted = [...teams].sort((a, b) => (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1));
  return sorted
    .map((m) => {
      const desc = m.description.length > 128 ? `${m.description.slice(0, 128)}…` : m.description;
      const shown = m.members.slice(0, 8);
      const more = m.members.length > 8 ? ', …' : '';
      const state = m.enabled ? '' : ' (disabled)';
      return `- ${m.name} (id: ${m.id})${state}: ${desc} (members: ${shown.join(', ')}${more})`;
    })
    .join('\n');
}

/** 团队解析三态（spec §3.1）：未注册 → TEAM_NOT_FOUND；enabled:false → TEAM_DISABLED */
export function resolveTeam(root: string, id: string, userDir?: string): Result<TeamManifest> {
  if (!isValidTeamId(id)) return fail('TEAM_NOT_FOUND', `TEAM_NOT_FOUND: team not registered: ${id}`);
  for (const dir of teamsChain(root, userDir)) {
    const file = teamFileIn(dir, id);
    if (!fs.existsSync(file)) continue;
    try {
      const meta = parseTeamFrontmatter(fs.readFileSync(file, 'utf8'));
      const manifest: TeamManifest = { id, source: dir === teamsChain(root, userDir)[0] ? 'project' : 'user', sourceDir: path.join(dir, id), ...meta, missing: [] };
      if (!manifest.enabled) return fail('TEAM_DISABLED', `TEAM_DISABLED: team ${id} is disabled`);
      return ok(manifest);
    } catch {
      return fail('TEAM_NOT_FOUND', `TEAM_NOT_FOUND: team ${id} is unreadable`);
    }
  }
  return fail('TEAM_NOT_FOUND', `TEAM_NOT_FOUND: team not registered: ${id}`);
}

/** 团队门面（Harness.teams；team 工具与后续 serve 面共用） */
export interface TeamsFacade {
  list(): TeamManifest[];
  get(id: string): TeamManifest | undefined;
  resolve(id: string): Result<TeamManifest>;
}

export function createTeamsFacade(root: string): TeamsFacade {
  return {
    list: () => loadTeams(root),
    get: (id) => loadTeams(root).find((t) => t.id === id),
    resolve: (id) => resolveTeam(root, id),
  };
}
