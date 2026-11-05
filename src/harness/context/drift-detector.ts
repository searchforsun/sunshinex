import * as path from 'path';
import { loadSkills } from '../skills';
import { loadTeams } from '../teams';
import { listAgentDefs } from '../subagent';
import { SUNSHINE_EXCERPT_MAX_CHARS } from '../memory/extractor';
import { INDEX_NAME, memoryDir } from '../memory/store';

/** 漂移探测注入面（D25/H3 拆分自 ContextManager 职责②）：磁盘读全部经门面回调注入，探测器对 ContextManager 零反向依赖——
 *  SUNSHINE 两层走 loader 无副作用形态（缺失为 null，检测永不因文件缺失而抛）；记忆索引走快照装载同源单点
 *  （防快照/比对两处读盘口径漂移）；技能清单读盘是漂移域私有逻辑（只比 id 集，正文永不进上下文）。 */
export interface DriftDetectorDeps {
  /** 项目根（说明行 read 指针路径与技能清单读盘基准） */
  root: string;
  /** 全局层 ~/.sunshinex/SUNSHINE.md 原文读盘（不存在或不可读为 null） */
  readGlobalSunshine(): string | null;
  /** 项目层 SUNSHINE.md 原文读盘（语义同上） */
  readSunshinex(): string | null;
  /** 全局层绝对路径（漂移说明 read 指针文案用） */
  globalPath: string;
  /** 记忆索引 MEMORY.md 全文读盘（无文件为空串；与快照装载共用单点口径） */
  readMemoryIndex(): string;
}

/** 会话常量漂移探测器（规范 N1 / 规格 §9.2）：刷新点捕获六类基线（全局/项目 SUNSHINE.md、技能/智能体/团队清单、记忆索引全文），
 *  轮询比对读盘现值，产出应尾追链尾的英文说明行。确定性、零模型调用；基线随比对前进（同一变更只告知一次），
 *  刷新点由门面在 rebuildSnapshot 后调 captureBaselines 重置。 */
export class DriftDetector {
  /** 动态改动尾追基线（规范 N1 / 规格 §9.2）：刷新点捕获，会话中途与磁盘比对不一致即尾追变更说明；
   *  null 表示「磁盘无 SUNSHINE.md」这一确定态，与「未捕获」不混 */
  private sunshinexBaseline: string | null = null;
  /** 全局约定基线（~/.sunshinex/SUNSHINE.md 全文；语义同 sunshinexBaseline，独立基线独立告知） */
  private globalSunshineBaseline: string | null = null;
  /** 技能清单基线（id 集排序 join；新增才告知，正文永不进上下文） */
  private skillsBaseline = '';
  /** 智能体清单基线（内置四角色 + 目录条目三元组排序 join；spec 2026-11-04 §2.1） */
  private agentsBaseline = '';
  /** 团队清单基线（两级目录三元组排序 join；spec 2026-11-04 §2.1） */
  private teamsBaseline = '';
  /** 记忆索引基线（MEMORY.md 全文；跨轮整理/写入时增量告知，快照仍冻结） */
  private memoryBaseline = '';

  constructor(private readonly deps: DriftDetectorDeps) {
    this.captureBaselines();
  }

  /** 刷新点基线捕获（构造与 reloadContext 经门面调用，防两处装配漂移）：漂移比对的基准，随刷新点与磁盘对齐 */
  captureBaselines(): void {
    this.globalSunshineBaseline = this.deps.readGlobalSunshine();
    this.sunshinexBaseline = this.deps.readSunshinex();
    this.skillsBaseline = skillSig(this.deps.root);
    this.agentsBaseline = agentSig(this.deps.root);
    this.teamsBaseline = teamSig(this.deps.root);
    this.memoryBaseline = this.deps.readMemoryIndex();
  }

  /** 漂移检测（原 ContextManager.checkConstantsDrift，语义逐字保持）：读盘比对刷新点基线，返回应尾追的说明行文本。
   *  基线随比对前进（同一变更只告知一次）；说明文案恒英文单语——经 appendChain 写链即提示词面（CLAUDE.md §15）。 */
  detect(): string[] {
    const out: string[] = [];
    const globalText = this.deps.readGlobalSunshine();
    if (globalText !== this.globalSunshineBaseline) {
      out.push(this.sunshineDriftText('Global SUNSHINE.md', globalText, this.deps.globalPath));
      this.globalSunshineBaseline = globalText;
    }
    const current = this.deps.readSunshinex();
    if (current !== this.sunshinexBaseline) {
      out.push(this.sunshineDriftText('SUNSHINE.md', current, path.join(this.deps.root, 'SUNSHINE.md')));
      this.sunshinexBaseline = current;
    }
    const ids = skillSig(this.deps.root);
    if (ids !== this.skillsBaseline) {
      out.push(...sigDiffNotices('[skills]', this.skillsBaseline, ids, 'load with the skill tool'));
      this.skillsBaseline = ids;
    }
    const agents = agentSig(this.deps.root);
    if (agents !== this.agentsBaseline) {
      out.push(...sigDiffNotices('[agents]', this.agentsBaseline, agents, 'load the agent card with the load_subagent tool (usable in a new session)'));
      this.agentsBaseline = agents;
    }
    const teams = teamSig(this.deps.root);
    if (teams !== this.teamsBaseline) {
      out.push(...sigDiffNotices('[teams]', this.teamsBaseline, teams, 'load the charter card with the load_agent_teams tool'));
      this.teamsBaseline = teams;
    }
    const mem = this.deps.readMemoryIndex();
    if (mem !== this.memoryBaseline) {
      out.push(this.memoryDriftText(mem, path.join(memoryDir(this.deps.root), INDEX_NAME)));
      this.memoryBaseline = mem;
    }
    return out;
  }

  /** 基线导出（ctx-snap 落档面）：六基线现值随快照同出生/同更新 */
  exportSig(): { skills: string; memory: string; sunshinex: string | null; globalSunshine: string | null; agents: string; teams: string } {
    return { skills: this.skillsBaseline, memory: this.memoryBaseline, sunshinex: this.sunshinexBaseline, globalSunshine: this.globalSunshineBaseline, agents: this.agentsBaseline, teams: this.teamsBaseline };
  }

  /** 基线回种（恢复面，spec §3）：落档签名直置——基线随快照走而非随磁盘（attach/resume 换铸时
   *  磁盘可能已变，重取即把变更烘进快照基线、绕过追尾）。回种后首次 detect 检出磁盘 diff 即追尾；
   *  旧档案无 agents/teams 字段 → 缺省 ''（历史档零迁移），首检把清单现值当新增告知 */
  restoreBaselines(sig: { skills: string; memory: string; sunshinex: string | null; globalSunshine: string | null; agents?: string; teams?: string }): void {
    this.skillsBaseline = sig.skills;
    this.memoryBaseline = sig.memory;
    this.sunshinexBaseline = sig.sunshinex;
    this.globalSunshineBaseline = sig.globalSunshine;
    this.agentsBaseline = sig.agents ?? '';
    this.teamsBaseline = sig.teams ?? '';
  }

  /** 单层 SUNSHINE 漂移说明构建（全局/项目两层共用单点，防两处拼装漂移）：变更头+最新全文（超限截断附 read 指针）/ 消失态；文案恒英文单语（写链即提示词面） */
  private sunshineDriftText(label: string, current: string | null, filePath: string): string {
    const text =
      current === null
        ? `(${label} is gone)`
        : current.length > DRIFT_MAX_CHARS
          ? `${current.slice(0, DRIFT_MAX_CHARS)}\n…(truncated) — read ${filePath} for the rest`
          : current;
    return [
      `${label} changed (the session snapshot is stale; the text below is authoritative until the next refresh point):`,
      text,
    ].join('\n');
  }

  /** 记忆索引漂移说明构建（对齐 sunshineDriftText 形态，2026-10-02 用户要求「上下文绝对正确」——
   *  指针式「去读 MEMORY.md」升级为正文级尾追：变更头带 supersession 声明与 slug 失联警告，正文承载
   *  新索引全文（超限截断附 read 指针），使「链尾即真相」成立——模型不花工具调用也能拿到当前态） */
  private memoryDriftText(current: string, indexPath: string): string {
    const trimmed = current.trim();
    const text =
      trimmed.length === 0
        ? '(the memory index is now empty)'
        : current.length > DRIFT_MAX_CHARS
          ? `${current.slice(0, DRIFT_MAX_CHARS)}\n…(truncated) — read ${indexPath} for the rest`
          : trimmed;
    return [
      '[memory] index changed (the snapshot entry above is stale; records listed there may have been merged or removed and their slugs may no longer resolve; the index below is authoritative until the next refresh point):',
      text,
    ].join('\n');
  }
}

/** 签名 diff → 三态 notice 行（skills/agents/teams 共用单点，防三处口径漂移）：
 *  added/updated 带描述截 128，removed 仅 id；文案形态与既有 [skills] 行逐字节同构 */
function sigDiffNotices(tag: string, beforeSig: string, afterSig: string, loadHint: string): string[] {
  const parse = (block: string): Map<string, [string, string]> =>
    new Map(block.split('\n').filter((l) => l.length > 0).map((l) => { const [id, name, desc] = JSON.parse(l) as [string, string, string]; return [id, [name, desc]] as [string, [string, string]]; }));
  const before = parse(beforeSig);
  const after = parse(afterSig);
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];
  for (const [id, meta] of after) {
    const prev = before.get(id);
    if (prev === undefined) added.push(meta[0].length > 0 || meta[1].length > 0 ? `${id} (${(meta[1] || meta[0]).slice(0, 128)})` : id);
    else if (prev[0] !== meta[0] || prev[1] !== meta[1]) updated.push(meta[1].length > 0 ? `${id} — ${meta[1].slice(0, 128)}` : id);
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  const out: string[] = [];
  if (added.length > 0) out.push(`${tag} added: ${added.join(', ')} — ${loadHint}`);
  if (removed.length > 0) out.push(`${tag} removed: ${removed.join(', ')} (no longer available)`);
  if (updated.length > 0) out.push(`${tag} updated: ${updated.join(', ')}`);
  return out;
}

/** 技能指纹（排序后逐条 JSON 行，跨环境逐字节稳定）：漂移比对用——id+name+description 三元，
 *  描述/名称变更与新增/移除同等可检（2026-10-30 用户裁定「技能描述变化后肯定要追尾」）；
 *  正文永不进上下文。装载走 loadSkills 全优先级链（项目 .sunshinex → 全局用户根 → 学习根 → 插件根，
 *  两级+装载口径与快照技能清单同源） */
function skillSig(root: string): string {
  return loadSkills(root)
    .map((m) => JSON.stringify([m.id, m.name, m.description]))
    .sort()
    .join('\n');
}

/** agents 指纹（skillSig 同款形态）：内置四角色 + 目录条目三元组排序 join（装载走 listAgentDefs 宽容链，
 *  与快照 agents 清单同源同拍）；description 即预设/目录 frontmatter 描述 */
function agentSig(root: string): string {
  return listAgentDefs(root).map((a) => JSON.stringify([a.id, a.name, a.description])).sort().join('\n');
}

/** teams 指纹（skillSig 同款形态）：两级目录（就近遮蔽后生效集）三元组排序 join，与快照 teams 清单同源同拍 */
function teamSig(root: string): string {
  return loadTeams(root).map((m) => JSON.stringify([m.id, m.name, m.description])).sort().join('\n');
}

/** 漂移全文块字符上限：超过即截断并附 read <绝对路径> 指针（防单次尾追挤爆上下文）——
 *  与提取材料节同水位，单一来源在 extractor.SUNSHINE_EXCERPT_MAX_CHARS（本地别名保留 DRIFT 域语义：
 *  本处覆盖 SUNSHINE 与记忆索引两类漂移全文，水位须与材料面同进退） */
const DRIFT_MAX_CHARS = SUNSHINE_EXCERPT_MAX_CHARS;
