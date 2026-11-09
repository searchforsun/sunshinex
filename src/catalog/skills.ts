/**
 * catalog/skills 只读视图（Task 12，Phase A 收尾）：来源链 + 跨源遮蔽标注（skills 设置页展示面）。
 * skills 只读是设计裁定：无启停开关、无 CRUD 写面（技能资产沿文件语义手工管理，视图不越权）。
 * 装载链零改动——src/harness/skills.ts 不动，本面只「看」：根链经 priorityChain 单点取
 * （项目四根 .sunshinex > .agents > .claude > .codex > user > learned > plugin），
 * 条目解析经 parseSkillFrontmatter 单点 + SKILL.md/skill.md 文件名查找（frontmatter 词法与
 * 大小写兜底全沿装载口径，不另造解析器）；刻意不走 resolveSkill——那是出牌面（resolve 三态），
 * manifest.params 非空且无实参即 SKILL_PARAM_MISSING，套在清单上会让带参技能从视图整条消失
 * （T12 评审修补）；清单视图也不需要正文读取/参数替换产物。遮蔽语义：同 id 跨来源——链上最高
 * 优先来源为正选（与装载面就近取一份一致），被遮蔽条目保留在列、标 shadowedBy=<胜者来源名>
 * （GUI 可据此灰显）；组内（同 source 段内）同 id 沿 loadSkillsGrouped 现序去重（就近胜出、
 * 败者不列——loadSkillsChain 组内口径同款）。
 * 容错沿装载面（Listing D7 形态）：目录缺/不可读 = 空段；条目竞态消失/非规范 id 静默跳过
 * （loadSkillsFrom 同款纪律，不抛死），warnings 预留恒空。跨项目 scope=all 枚举不在本面
 * （loadCrossProjectSkillGroups 直供 GUI）。skills 页无启停：装载面按链自动就近取一份，视图只如实呈现。
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadEffectivePlugins } from '../config/plugins';
import { PROJECT_SKILL_ROOTS_ASC, isValidSkillId, parseSkillFrontmatter, priorityChain } from '../harness/skills';
import type { Listing } from './types';

/** 技能来源段（对齐装载优先级链的语义级）：project = 项目四根 .sunshinex/.agents/.claude/.codex 合并一组（loadSkillsGrouped 同款） */
export type SkillSource = 'project' | 'user' | 'learned' | 'plugin';

/** catalog skills 列表条目：id + frontmatter 三件套 + 来源段 + 落盘目录 + 跨源遮蔽标注 */
export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  source: SkillSource;
  /** 技能条目自身目录（<链根>/<id>；正文引用的伴随文件按此目录解析，沿 SkillManifest.sourceRoot 口径） */
  sourceDir: string;
  /** 同 id 被更高优先来源遮蔽时 = 胜者来源名（project/user/learned/plugin，非 id）；正选条目缺席 */
  shadowedBy?: SkillSource;
}

/** 插件 skills 根收集（缺省口）：口径与 harness/skills.ts 私有 pluginSkillDirs 逐位一致（启用且平台
 *  可用的插件，manifest.skills 相对插件根解析为绝对目录）——harness 不导出该函数，视图侧镜像此一行；
 *  漂移防线 = 两处同以 loadEffectivePlugins 为唯一来源，且 skills 页不写盘、漂移最多影响展示不含装载 */
function defaultPluginSkillDirs(root: string): string[] {
  return loadEffectivePlugins(root).plugins
    .filter((p) => p.enabled && p.platformSupported)
    .flatMap((p) => (p.manifest.skills ?? []).map((rel) => path.join(p.dir, rel)));
}

/** 单目录枚举候选 id（条目几何层）：仅收子目录且 id 过 isValidSkillId 规范校验（沿 loadSkillsFrom
 *  口径，中文/大写/畸形连字符目录不进清单）；目录不可读 = 空（并发移除等竞态容忍，装载面同款容错）。
 *  候选是否真成条目（SKILL.md 在场/可读）由 listSkills 逐条裁定 */
function listCandidateIds(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // 枚举瞬间目录不可读：本根视为空，其余根照常列举（装载面同款容错）
  }
  return entries.filter((d) => d.isDirectory() && isValidSkillId(d.name)).map((d) => d.name);
}

/** 技能文件名查找（与 harness/skills.ts 私有 skillFileIn 同一行口径：SKILL.md 标准名优先、skill.md
 *  兜底——Windows/macOS 文件系统本不区分大小写，Linux 显式补齐保三平台列举一致）。属解析粘合
 *  （文件定位一行），非 brief 禁止的优先级/去重逻辑复制 */
function skillMdIn(dir: string, id: string): string | undefined {
  return ['SKILL.md', 'skill.md'].map((f) => path.join(dir, id, f)).find((f) => fs.existsSync(f));
}

/**
 * 技能只读视图（Task 12）：沿装载优先级链全段列出，同 id 跨源高优先正选、低优先保留在列标
 * shadowedBy=<胜者来源名>；组内同 id 就近去重（loadSkillsGrouped 现序同款）。组序恒
 * project > user > learned > plugin，组内沿链现序（readdir 序）。opts.pluginSkillDirs 显式传参 =
 * 测试/重定向口（沿 priorityChain 尾参口径），缺省经 loadEffectivePlugins 收集。
 */
export function listSkills(root: string, opts?: { pluginSkillDirs?: string[] }): Listing<SkillEntry> {
  const pluginDirs = opts?.pluginSkillDirs ?? defaultPluginSkillDirs(root);
  // 段切分沿 priorityChain 构成（项目根 → user 根 → learned 根 → 插件根）：前段长度 =
  // PROJECT_SKILL_ROOTS_ASC.length，随后 user/learned 各一根，尾段 = 插件根。链构成（含顺序）由
  // priorityChain 单点承载，本面只按语义段切片、不重复拼接与排序逻辑
  const chain = priorityChain(root, pluginDirs);
  const nProject = PROJECT_SKILL_ROOTS_ASC.length;
  const segments: ReadonlyArray<{ source: SkillSource; dirs: string[] }> = [
    { source: 'project', dirs: chain.slice(0, nProject) },
    { source: 'user', dirs: chain.slice(nProject, nProject + 1) },
    { source: 'learned', dirs: chain.slice(nProject + 1, nProject + 2) },
    { source: 'plugin', dirs: chain.slice(nProject + 2) },
  ];
  const entries: SkillEntry[] = [];
  const winner = new Map<string, SkillSource>(); // id → 跨源胜者来源（链上首个成功装载的来源段）
  const seenInSegment = new Set<string>(); // 组内已见 id（组内去重，沿 loadSkillsChain 组内口径）
  for (const seg of segments) {
    seenInSegment.clear();
    for (const dir of seg.dirs) {
      for (const id of listCandidateIds(dir)) {
        if (seenInSegment.has(id)) continue; // 组内去重：同 source 段内就近胜出，败者不列（非跨源遮蔽）
        // 清单解析走 parseSkillFrontmatter 单点（frontmatter 词法沿装载口径），刻意不走 resolveSkill——
        // 后者是出牌面（resolve 三态），manifest.params 非空且无实参即 SKILL_PARAM_MISSING 失败，
        // 套在清单上会让带参技能整条从视图消失（T12 评审修补）；本视图也不需要正文/参数替换产物
        const file = skillMdIn(dir, id);
        if (file === undefined) continue; // 无 SKILL.md/skill.md 的占位目录：不构成条目（装载面同款）
        let meta: ReturnType<typeof parseSkillFrontmatter>;
        try {
          meta = parseSkillFrontmatter(fs.readFileSync(file, 'utf8'));
        } catch {
          continue; // 命中条目在探测与读取之间不可用（竞态移除等）：静默让位，不拖垮列举
        }
        seenInSegment.add(id); // 解析成功才注册段内已见（坏条目让位低优先级，沿装载面语义）
        const shadowedBy = winner.get(id);
        entries.push({
          id,
          name: meta.name,
          description: meta.description,
          version: meta.version,
          source: seg.source,
          sourceDir: path.join(dir, id),
          ...(shadowedBy !== undefined ? { shadowedBy } : {}),
        });
        if (shadowedBy === undefined) winner.set(id, seg.source); // 链上首次成功装载 = 正选，胜者恒最高优先来源
      }
    }
  }
  return { entries, warnings: [] };
}
