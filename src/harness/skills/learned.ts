import * as fs from 'fs';
import * as path from 'path';
import { Result, ok, fail } from '../../result';
import { resolveDataDir } from '../../config/data-dir';
import { DEFAULT_LEARNED_SKILL_LIMIT } from '../../config/memory-config';

const MAX_BODY_CHARS = 2000;

/**
 * 语义提炼产物（learned-extraction 通道）：name 决定目录 id，description/body 直接落 frontmatter 与正文。
 * 定义在本文件（生产者 settled 侧）：learned-extract 已运行时依赖本模块的 slugify，
 * 反向引用只允许 `import type`（类型擦除），避免运行时环。缺省路径（无 refined）不感知本类型。
 */
export interface RefinedSkill {
  name: string;
  description: string;
  body: string;
}

/**
 * goal/name 确定性 slug 化：折叠为 ASCII 小写 slug（`[^a-z0-9]+` → `-`，对标 worktree slugifyLabel 同款口径——
 * 汉字等非 ASCII 一律折叠，防中文目录 id 在跨平台路径与清单出牌面的隐患），截长 40，全折叠回退 learned
 * （撞名避让与清库判断共用同一 slug 面）
 */
export function slugify(goal: string): string {
  const slug = goal
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'learned';
}

function clip(text: string): string {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…(truncated)` : text;
}

/**
 * 学习技能写入面：成功任务沉淀为 <全局数据目录>/skills/{id}/skill.md（~/.sunshinex/projects/<工作区>/data，不入工作区不入库；
 * 用户技能 skills/ 恒优先于学习产物，本类只管写入不参与运行时合并）。
 * 撞名追加 -2/-3… 不覆盖既有产物；目录上限由控制面 opts.limit 驱动（缺省 DEFAULT_LEARNED_SKILL_LIMIT，对齐 CAP.skill），超限按 mtime 删最旧。
 */
export class LearnedSkillStore {
  constructor(private root: string) {}

  settle(goal: string, reply: string, opts?: { limit?: number; refined?: RefinedSkill }): Result<string> {
    const g = goal.trim();
    const rep = reply.trim();
    // refined 在场时不要求 reply：失败/中止的任务没有最终答复，但同样值得沉淀（replied 才校验 reply 非空）
    if (!g || (!rep && !opts?.refined)) return fail('SKILL_SETTLE_EMPTY', 'SKILL_SETTLE_EMPTY: goal and reply must not be empty');

    const dir = path.join(resolveDataDir(this.root), 'skills');
    fs.mkdirSync(dir, { recursive: true });
    this.evictOldest(dir, opts?.limit ?? DEFAULT_LEARNED_SKILL_LIMIT);

    const refined = opts?.refined;
    const id = this.allocateId(dir, slugify(refined ? refined.name : g));
    const name = refined ? refined.name.slice(0, 60) : `settle:${g.slice(0, 30)}`;
    const description = refined ? refined.description.slice(0, 60) : `learned settle — ${g.slice(0, 30)}`;
    const body = refined
      ? clip(refined.body)
      : ['# Goal', '', g, '', '# Successful reply', '', clip(rep)].join('\n');
    const md = [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      'version: 0.1.0',
      'kind: prompt',
      'params:',
      'source: learned',
      '---',
      '',
      body,
      '',
    ].join('\n');
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'skill.md'), md);
    return ok(id);
  }

  /** 撞名追加 -2/-3…：首个空位即落位，既有产物零覆盖 */
  private allocateId(dir: string, base: string): string {
    let candidate = base;
    for (let n = 2; fs.existsSync(path.join(dir, candidate)); n += 1) {
      candidate = `${base}-${n}`;
    }
    return candidate;
  }

  /**
   * 超上限按 mtime 升序删最旧，为本次沉淀腾出 1 个空位（limit 由控制面配置驱动）。
   * 入口夹紧下界：limit<=0 一律按 1 处理（语义 = 至少保留本次新写入的 1 条），
   * 避免 `limit - 1` 为负导致 excess 越界清空历史；不新增抛错路径（沉淀不得因入参失败）。
   */
  private evictOldest(dir: string, limit: number): void {
    const effLimit = Math.max(1, limit);
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const p = path.join(dir, e.name);
        return { path: p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);
    const excess = entries.length - (effLimit - 1);
    for (const e of entries.slice(0, Math.max(0, excess))) {
      fs.rmSync(e.path, { recursive: true, force: true });
    }
  }
}
