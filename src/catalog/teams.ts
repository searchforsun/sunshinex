/**
 * catalog/teams 读面 + 写面：预定义智能体团队（<teams 目录>/<id>/team.md）两级位置合并列举 + 遮蔽/
 * missing 标注；写面 upsert/remove/setEnabled 收口（GUI/serve 后续一律经此，不再各自 fs 直写）。
 * 落位单点 teamsDir 镜像 agentsDir：project=<root>/.sunshinex/teams、global=<userConfigDir>/teams
 * （userDir 显式传参 = teams 全目录测试/重定向口，传全路径非家目录）。词法与格式校验复用
 * harness/teams 单点（isValidTeamId/parseTeamFrontmatter），不另造解析器。
 * 两级层序 global → project（与 harness teamsChain 装载序同构的视图形态：项目撞全局——全局行标
 * shadowedBy:'project' 保留在列，沿 listAgents 视图口径，杜绝「显示全局、生效项目副本」分叉）。
 * 逐文件宽容：单文件畸形 → warnings 不抛死（Listing D7 口径，列举面宁可少列不可抛死）。
 * missing 解析口径（Controller 裁定 2026-11-04，宽于 harness 装载面的纯目录集）：listAgents 生效
 * 目录条目（enabled 且未 shadowed 的 id 集）∪ 内建四角色 id（ROLE_PRESETS 键单点取键，不散抄字面量）
 * ——成员按 id 引用 agents 注册表，内建四角色是注册表常驻合法成员（非文件，视图不造行，仅并入口径；
 * 仅按目录条目算会把内建成员误标 missing）。
 * 写面纪律逐条镜像 upsertAgent：先全量校验后落盘零部分写 + 将落盘字节过真解析器 parseTeamFrontmatter
 * round-trip 回环（验证口径=装载口径）+ writeJsonAtomic 原子写（同目录 tmp+rename）+ notifyCatalogWrite
 * ('teams', scope, root)；失败一律 CatalogWriteError('INVALID') 拒写、目标零触碰；remove 缺失抛
 * INVALID（幂等收口属 serve 面——P1）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { userTeamsDir } from '../config/data-dir';
import { isValidTeamId, parseTeamFrontmatter } from '../harness/teams';
import { ROLE_PRESETS } from '../harness/subagent';
import { listAgents, patchEnabledLine } from './agents';
import { CatalogWriteError, notifyCatalogWrite, requireProjectRoot, writeJsonAtomic } from './io';
import type { Listing, Scope } from './types';

/** 团队落位单点（镜像 agentsDir）：project=<root>/.sunshinex/teams、global=<userConfigDir>/teams；
 *  userDir 显式传参 = 测试/重定向口（teams 全目录直指，非 userConfigDir 形参） */
export function teamsDir(scope: Scope, root: string | null, userDir?: string): string {
  if (scope === 'global') return userDir ?? userTeamsDir();
  return path.join(root ?? process.cwd(), '.sunshinex', 'teams');
}

/** catalog 团队列表条目：frontmatter 元数据 + 来源/遮蔽标注 + missing 现算 + 章程正文 */
export interface TeamEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  members: string[];
  lead?: string;
  enabled: boolean;
  source: Scope;
  sourceDir: string;
  shadowedBy?: Scope;
  /** members 中未解析到的 agent id（对 listAgents 生效集现算，spec §1.3） */
  missing: string[];
  /** frontmatter 后正文（章程原文；设置页编辑器与卡片直读） */
  body: string;
}

/** 两级只读视图（镜像 listAgents：全局 → 项目，项目遮蔽全局标 shadowedBy；项目缺席只列全局）。
 *  missing 对「agents 生效集 ∪ 内建四角色 id」（listAgents 未 shadowed 且 enabled 条目 id ∪
 *  ROLE_PRESETS 键，见模块头裁定）现算；opts.agentsGlobalDir 透传 listAgents、opts.userDir 重定向
 *  teamsDir 全局分支（测试口，不触真 HOME）。root:null 时项目级整体跳过（只列全局，沿 listAgents 口径）。 */
export function listTeams(root: string | null, opts?: { userDir?: string; agentsGlobalDir?: string }): Listing<TeamEntry> {
  const userDir = opts?.userDir;
  const warnings: string[] = [];
  /** 单目录扫描：仅收 <id>/team.md 常规目录且 id 过 isValidTeamId（沿 loadTeamsFrom 几何，非目录/非法 id/缺 team.md 跳过） */
  const scan = (dir: string, scope: Scope): Map<string, TeamEntry> => {
    const out = new Map<string, TeamEntry>();
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isValidTeamId(entry.name)) continue;
      const file = path.join(dir, entry.name, 'team.md');
      if (!fs.existsSync(file)) continue;
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const meta = parseTeamFrontmatter(raw);
        out.set(entry.name, {
          id: entry.name, name: meta.name, description: meta.description, version: meta.version,
          members: meta.members, ...(meta.lead !== undefined ? { lead: meta.lead } : {}), enabled: meta.enabled,
          source: scope, sourceDir: path.join(dir, entry.name), missing: [], body: raw.replace(/^---\s*\n([\s\S]*?)\n---/, '').trim(),
        });
      } catch (e) {
        warnings.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  };
  const globalEntries = scan(teamsDir('global', root, userDir), 'global');
  const projectEntries = root !== null ? scan(teamsDir('project', root, userDir), 'project') : new Map<string, TeamEntry>();
  // 项目最高：同 id 撞全局——全局条目保留在列、标 shadowedBy:'project'（视图口径，harness 装载面才真正就近取一份）
  for (const id of projectEntries.keys()) {
    const g = globalEntries.get(id);
    if (g) globalEntries.set(id, { ...g, shadowedBy: 'project' });
  }
  // missing 解析集（Controller 裁定 2026-11-04）：listAgents 生效目录条目（enabled 且未 shadowed）
  // ∪ 内建四角色 id（ROLE_PRESETS 键单点取键）——内建成员无目录条目亦不算 missing；视图不造内建行
  const agentIds = new Set<string>([
    ...Object.keys(ROLE_PRESETS),
    ...listAgents(root, opts?.agentsGlobalDir).entries.filter((e) => e.meta.enabled && !e.shadowed).map((e) => e.id),
  ]);
  const fillMissing = (t: TeamEntry): TeamEntry => ({ ...t, missing: t.members.filter((m) => !agentIds.has(m)) });
  const byId = (a: TeamEntry, b: TeamEntry): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // warnings 随 Listing 透出（坏档行进 warnings，不抛死）
  return { entries: [...[...globalEntries.values()].map(fillMissing).sort(byId), ...[...projectEntries.values()].map(fillMissing).sort(byId)], warnings };
}

/* ---------- 写面：upsert / remove / setEnabled ----------
 *  写纪律逐条镜像 upsertAgent（先全量校验后落盘零部分写 + 将落盘字节过真解析器 round-trip +
 *  writeJsonAtomic 原子写 + notifyCatalogWrite 写通知）：GUI/serve 后续一律经本面写。 */

/** upsert 输入面（校验后形态）：name/members 必填，可选键按需；enabled 仅 false 落行（缺省/true 由
 *  解析面「缺省 true」承载）；body = 章程正文（frontmatter 之后，缺省空串） */
export interface TeamUpsertSpec {
  name: string;
  description?: string;
  version?: string;
  members: string[];
  lead?: string;
  enabled?: boolean;
  body?: string;
}

/** team.md 生成（键序固定 name 首位、description/version/members 恒列、可选键按需追加
 *  （lead→enabled）；members 空格 join 单行（parseTeamFrontmatter 同款词法）；enabled 仅 false 落行） */
export function renderTeamMd(fm: { name: string; description?: string; version?: string; members: string[]; lead?: string; enabled?: boolean }, body: string): string {
  const lines = [`name: ${fm.name}`, `description: ${fm.description ?? ''}`, `version: ${fm.version ?? '0.1.0'}`, `members: ${fm.members.join(' ')}`];
  if (fm.lead !== undefined) lines.push(`lead: ${fm.lead}`);
  if (fm.enabled === false) lines.push('enabled: false');
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

/** 写面目标定位 + 双守卫（写面三函数共用，镜像 agentWriteTarget）：id 安全校验（isValidTeamId
 *  harness 单点——id 直接拼目录路径，路径分隔/穿越/大写/点开头等形态一律拒）+ project 作用域 root
 *  必备（requireProjectRoot 单点：写面绝不借道 cwd 兜底，凭空落 cwd 是伪写）。返回条目目录 <teams 目录>/<id> */
function teamWriteTarget(root: string | null, scope: Scope, id: string): string {
  if (!isValidTeamId(id)) throw new CatalogWriteError('INVALID', `invalid team id: ${JSON.stringify(id)} (must be lowercase kebab-case)`);
  return path.join(teamsDir(scope, requireProjectRoot(scope, root, 'team')), id);
}

/** 新增/整写一个团队（写纪律镜像 upsertAgent）：renderTeamMd 生成 → 写前 round-trip（真解析器
 *  parseTeamFrontmatter + 字段回环）→ writeJsonAtomic 原子落盘（同目录 tmp+rename）。校验先于任何
 *  落盘动作——坏内容根本不进 tmp，目标与目录零触碰。校验口径：name 必填非空白单行；members 非空、
 *  逐项 agent id 词法、去重后唯一（空白项 trim 剔除）；description 单行（换行注入伪键拒收，多行内容
 *  属 body）；lead ∈ members（解析面对越界 lead 静默丢弃，写了不生效的死行不如写面即拒） */
export function upsertTeam(root: string | null, scope: Scope, id: string, spec: TeamUpsertSpec): void {
  const dir = teamWriteTarget(root, scope, id);
  if (typeof spec.name !== 'string' || spec.name.trim().length === 0 || /\r|\n/.test(spec.name)) {
    throw new CatalogWriteError('INVALID', 'team name required (non-empty single-line string)');
  }
  const members = spec.members.map((m) => String(m).trim()).filter((m) => m.length > 0);
  if (members.length === 0) throw new CatalogWriteError('INVALID', 'team members required (space-separated agent ids)');
  for (const m of members) if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(m)) throw new CatalogWriteError('INVALID', `team member id invalid: ${JSON.stringify(m)}`);
  if (new Set(members).size !== members.length) throw new CatalogWriteError('INVALID', 'team members must be unique');
  if (spec.description !== undefined && /\r|\n/.test(spec.description)) throw new CatalogWriteError('INVALID', 'team description must be single-line');
  const lead = spec.lead !== undefined ? String(spec.lead).trim() : undefined;
  if (lead !== undefined && !members.includes(lead)) throw new CatalogWriteError('INVALID', `team lead must be one of members, got ${JSON.stringify(lead)}`);
  const md = renderTeamMd({ name: spec.name.trim(), ...(spec.description !== undefined ? { description: spec.description } : {}), ...(spec.version !== undefined ? { version: spec.version } : {}), members, ...(lead !== undefined ? { lead } : {}), ...(spec.enabled === false ? { enabled: false } : {}) }, spec.body ?? '');
  // round-trip（验证口径=装载口径）：将落盘字节过真解析器 + 逐字段回环，任一不符 → INVALID 拒写
  let meta: ReturnType<typeof parseTeamFrontmatter>;
  try {
    meta = parseTeamFrontmatter(md);
  } catch (e) {
    throw new CatalogWriteError('INVALID', `generated team.md failed validation (<teams>/${id}/team.md): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (meta.name !== spec.name.trim() || meta.members.join(' ') !== members.join(' ')) {
    throw new CatalogWriteError('INVALID', `round-trip mismatch (<teams>/${id}/team.md)`);
  }
  if (meta.enabled !== (spec.enabled !== false)) throw new CatalogWriteError('INVALID', `round-trip enabled mismatch (<teams>/${id}/team.md)`);
  writeJsonAtomic(path.join(dir, 'team.md'), md);
  // 写通知：team.md 落盘 → ('teams', scope, root)（resource 'teams' 为本任务新入 ResourceKind；
  // watcher 侧 teams 目录映射 P1 接线，当前无回声键冲突——见 catalog/types.ts 注）
  notifyCatalogWrite('teams', scope, root);
}

/** 移除一个团队：rm -rf 条目整目录（team.md 及同级私有文件一并清）；不存在 → INVALID（catalog 写面
 *  严格语义；幂等收口属 serve 面——P1） */
export function removeTeam(root: string | null, scope: Scope, id: string): void {
  const dir = teamWriteTarget(root, scope, id);
  if (!fs.existsSync(dir)) throw new CatalogWriteError('INVALID', `team not found: ${scope}/teams/${id}`);
  fs.rmSync(dir, { recursive: true });
  // 写通知：条目整目录移除同样是配置变更（rm 非原子写路径，成功后同样补一行）
  notifyCatalogWrite('teams', scope, root);
}

/** 启停一个团队：读 team.md → frontmatter 增/改 enabled 行（patchEnabledLine 保序手术，非整块重写，
 *  用户手排键序与行尾注释风格均保真）→ 将落盘字节过真解析器回环（enabled 不符/畸形 → INVALID 拒写，
 *  目标零触碰）→ writeJsonAtomic 原子写回。id 不在该作用域（team.md 缺）→ INVALID */
export function setTeamEnabled(root: string | null, scope: Scope, id: string, enabled: boolean): void {
  const dir = teamWriteTarget(root, scope, id);
  const file = path.join(dir, 'team.md');
  if (!fs.existsSync(file)) throw new CatalogWriteError('INVALID', `team not found: ${scope}/teams/${id}`);
  const md = fs.readFileSync(file, 'utf8'); // 存在性竞态移除 → 读抛错沿调用方收口（serve 面 500 同惯例）
  const patched = patchEnabledLine(md, id, enabled);
  let meta: ReturnType<typeof parseTeamFrontmatter>;
  try {
    meta = parseTeamFrontmatter(patched);
  } catch (e) {
    throw new CatalogWriteError('INVALID', `patched team.md failed validation (<teams>/${id}/team.md): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (meta.enabled !== enabled) throw new CatalogWriteError('INVALID', `round-trip enabled mismatch (<teams>/${id}/team.md)`);
  writeJsonAtomic(file, patched);
  // 写通知：enabled 手术落盘 → ('teams', scope, root)
  notifyCatalogWrite('teams', scope, root);
}
