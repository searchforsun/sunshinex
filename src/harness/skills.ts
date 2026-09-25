import * as fs from 'fs';
import * as path from 'path';
import { SkillManifest } from '../types';
import { Result, ok, fail } from '../result';
import { resolveDataDir, userSkillsDir } from '../config/data-dir';

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---/;

/** 解析 skill.md 的简易 frontmatter（--- 块内 key: value；params 为空格分隔的形参清单，kind 仅认 prompt） */
export function parseSkillFrontmatter(md: string): Omit<SkillManifest, 'id'> {
  const out: Record<string, string> = { name: '', description: '', version: '0.1.0' };
  const m = FRONTMATTER.exec(md);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(line.trim());
      if (kv) out[kv[1]] = kv[2].trim();
    }
  }
  const params = out.params ? out.params.split(/\s+/).filter((p) => p.length > 0) : undefined;
  return {
    name: out.name,
    description: out.description,
    version: out.version,
    ...(params !== undefined && { params }),
    ...(out.kind === 'prompt' && { kind: 'prompt' as const }),
  };
}

/** 学习技能目录（LearnedSkillStore 写入面与双根合并共用的唯一定位）：落全局数据目录 ~/.sunshinex/projects/<工作区>/data/skills（HOME 不可写回退项目 .data） */
export function learnedSkillsDir(root: string): string {
  return path.join(resolveDataDir(root), 'skills');
}

/** 项目级兼容根升序（规格 v2：五根统一标准形态 {根}/skills/{id}/SKILL.md；右侧遮蔽左侧，.sunshinex 原生恒最优先） */
export const PROJECT_SKILL_ROOTS_ASC = ['.cursor', '.codex', '.claude', '.agents', '.sunshinex'] as const;

/** 项目级各兼容根下的技能目录（升序） */
export function projectSkillDirs(root: string): string[] {
  return PROJECT_SKILL_ROOTS_ASC.map((dot) => path.join(root, dot, 'skills'));
}

/** 技能文件名查找单点（SKILL.md 标准名优先、skill.md 兜底）：装载与解析共用，防两处漂移。
 *  兜底理由——Windows/macOS 文件系统本不区分大小写（两者同一文件），Linux 显式补齐才保三平台装载结果一致 */
function skillFileIn(dir: string, id: string): string | undefined {
  return ['SKILL.md', 'skill.md'].map((f) => path.join(dir, id, f)).find((f) => fs.existsSync(f));
}

/** 技能 id 格式规范（程序校验单点）：`^[a-z0-9]+(-[a-z0-9]+)*$`——ASCII 小写字母数字、连字符分段、
 *  不以连字符开头/结尾、无连续连字符。装载面（非规范目录跳过）与 resolve 面（非规范 id 即拒）共用，
 *  防中文/大写/畸形 id 目录进入清单与出牌面 */
const SKILL_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidSkillId(id: string): boolean {
  return SKILL_ID_PATTERN.test(id);
}

/** 扫描单根目录下 {id}/SKILL.md（文件名口径见 skillFileIn） */
function loadSkillsFrom(dir: string): SkillManifest[] {
  if (!fs.existsSync(dir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // 枚举瞬间目录不可读（并发移除等）：本根视为空，其余根照常装载
  }
  const out: SkillManifest[] = [];
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    if (!isValidSkillId(d.name)) continue; // id 格式程序校验：非规范目录（中文/大写/畸形连字符）跳过不装载
    const named = skillFileIn(dir, d.name);
    if (named === undefined) continue;
    try {
      const meta = parseSkillFrontmatter(fs.readFileSync(named, 'utf8'));
      out.push({ id: d.name, ...meta } as SkillManifest);
    } catch {
      // 单条目不可读（枚举与读取之间被移除 / 目录占位 / 权限）逐条跳过，不拖垮整次扫描：
      // 技能清单是装配面的尽力而为视图，一条坏条目不得阻断会话装配
      //（历史事故：共享数据目录下并发移除致 captureBaselines 抛 ENOENT，整场 /init 崩）
    }
  }
  return out;
}

/** 装载/解析优先级链（降序）：项目级五根（.sunshinex > .agents > .claude > .codex > .cursor）→ 全局根 → 学习根 */
function priorityChain(root: string): string[] {
  return [...projectSkillDirs(root)].reverse().concat([userSkillsDir(), learnedSkillsDir(root)]);
}

/** 技能清单（规格 v2）：按优先级链降序装载，id 撞名就近遮蔽（被遮蔽者静默让位不抛） */
export function loadSkills(root: string): SkillManifest[] {
  const out: SkillManifest[] = [];
  const seen = new Set<string>();
  for (const dir of priorityChain(root)) {
    for (const s of loadSkillsFrom(dir)) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}

/** 技能清单格式化（对标 Claude Code 常驻技能清单）：每技能一行 `- name: description`，按 name 码点字典序排序（locale 无关，跨环境逐字节稳定——前置段冻结先例）；description 截 128 加省略号控预算；空清单返回 null（零条目零注入开销） */
export function formatSkillsIndex(manifests: SkillManifest[]): string | null {
  if (manifests.length === 0) return null;
  const sorted = [...manifests].sort((a, b) =>
    a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1,
  );
  return sorted
    .map((m) => {
      const desc = m.description.length > 128 ? `${m.description.slice(0, 128)}…` : m.description;
      return `- ${m.name} (id: ${m.id}): ${desc}`;
    })
    .join('\n');
}

/** 技能门面：装配根暴露 list/get/resolve 三能力（Harness.skills；结构兼容 LoopDeps.skills） */
export interface SkillsFacade {
  list(): SkillManifest[];
  get(id: string): SkillManifest | undefined;
  resolve(id: string, params?: Record<string, string>): Result<ResolvedSkill>;
  /** 学习技能条数（双根合并视角被遮蔽的也计入；无 .data/skills 目录返回 0） */
  learnedCount(): number;
}

export function createSkillsFacade(root: string): SkillsFacade {
  const learnedDir = learnedSkillsDir(root);
  const chain = priorityChain(root);
  return {
    list: () => loadSkills(root),
    get: (id) => loadSkills(root).find((s) => s.id === id),
    resolve: (id, params) => {
      // 沿优先级链逐级解析：命中或缺参即止（SKILL_PARAM_MISSING 就近不回退），仅未注册（SKILL_NOT_FOUND）才下探下一根
      let result: Result<ResolvedSkill> | null = null;
      for (const dir of chain) {
        result = resolveSkill(dir, id, params);
        if (result.ok || result.error.code !== 'SKILL_NOT_FOUND') break;
      }
      return result ?? resolveSkill(learnedDir, id, params);
    },
    learnedCount: () => loadSkillsFrom(learnedDir).length,
  };
}

/** 解析后的技能：清单 + 占位符已替换的正文（供 Loop 首帧注入） */
export interface ResolvedSkill {
  manifest: SkillManifest;
  body: string;
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/**
 * 技能解析三态：未注册 id → SKILL_NOT_FOUND；manifest.params 白名单内形参缺失 → SKILL_PARAM_MISSING（报缺失名）；
 * 命中 → 仅白名单内形参被替换（白名单外 {{x}} 原样保留，多余实参被过滤），返回参数化正文
 */
export function resolveSkill(skillsDir: string, id: string, params?: Record<string, string>): Result<ResolvedSkill> {
  if (!isValidSkillId(id)) return fail('SKILL_NOT_FOUND', `SKILL_NOT_FOUND: skill not registered: ${id}`);
  const file = skillFileIn(skillsDir, id);
  if (file === undefined) return fail('SKILL_NOT_FOUND', `SKILL_NOT_FOUND: skill not registered: ${id}`);

  let md: string;
  try {
    md = fs.readFileSync(file, 'utf8');
  } catch {
    // 命中条目在探测与读取之间不可用（并发移除等）：按未注册处理，让回退链照常下探下一根，
    // 而不是把读取异常抛给调用方（resolve 契约：仅 SKILL_NOT_FOUND 回退、其余即止）
    return fail('SKILL_NOT_FOUND', `SKILL_NOT_FOUND: skill not registered: ${id}`);
  }
  const manifest: SkillManifest = { id, ...parseSkillFrontmatter(md) };
  const body = md.replace(FRONTMATTER, '').trim();

  const provided = params ?? {};
  const missing = (manifest.params ?? []).filter((p) => !(p in provided));
  if (missing.length > 0) return fail('SKILL_PARAM_MISSING', `SKILL_PARAM_MISSING: skill ${id} missing params: ${missing.join(', ')}`);

  const whitelist = manifest.params ?? [];
  const resolved = body.replace(PLACEHOLDER, (raw, name: string) => (whitelist.includes(name) ? provided[name] : raw));
  return ok({ manifest, body: resolved });
}
