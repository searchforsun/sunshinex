import * as fs from 'fs';
import { learnedSkillsDir } from '../skills';
import * as path from 'path';
import { Result, ok, fail } from '../../result';
import { resolveDataDir } from '../../config/data-dir';
import { DEFAULT_LEARNED_SKILL_LIMIT } from '../../config/memory-config';
import { slugify as asciiSlug } from '../../slug';

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
 * goal/name 确定性 slug 化（ASCII 小写、`[^a-z0-9]+` → '-'、截长 40、全折叠回退 'learned'）：
 * 正则链单点在 src/slug.ts，本处只声明 learned 目录 id 方言参数（learned-extract 运行时依赖本函数，
 * 撞名避让与清库判断共用同一 slug 面）
 */
export function slugify(goal: string): string {
  return asciiSlug(goal, { max: 40, fallback: 'learned' });
}

function clip(text: string): string {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…(truncated)` : text;
}

/**
 * 学习技能写入面：成功任务沉淀为 <全局数据目录>/skills/{id}/skill.md（~/.sunshinex/projects/<工作区>/data，不入工作区不入库；
 * 用户技能 skills/ 恒优先于学习产物，本类只管写入不参与运行时合并）。
 * 撞名=原地更新（2026-10-15 用户裁决「禁止 -1/-2 后缀，要在之前 skills 上修改」）：同 slug 二次沉淀覆盖既有产物，
 * 不产 -2/-3 副本；目录上限由控制面 opts.limit 驱动（缺省 DEFAULT_LEARNED_SKILL_LIMIT，对齐 CAP.skill），超限按 mtime 删最旧。
 */
export class LearnedSkillStore {
  constructor(private root: string) {}

  /** G14.81 已沉淀技能 id 清单(目录名=name slug)——提炼 prompt 的去重/合并上下文 */
  names(): string[] {
    try {
      return fs
        .readdirSync(learnedSkillsDir(this.root), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  settle(goal: string, reply: string, opts?: { limit?: number; refined?: RefinedSkill }): Result<{ id: string; updated: boolean }> {
    const g = goal.trim();
    const rep = reply.trim();
    // refined 在场时不要求 reply：失败/中止的任务没有最终答复，但同样值得沉淀（replied 才校验 reply 非空）
    if (!g || (!rep && !opts?.refined)) return fail('SKILL_SETTLE_EMPTY', 'SKILL_SETTLE_EMPTY: goal and reply must not be empty');

    const dir = path.join(resolveDataDir(this.root), 'skills');
    fs.mkdirSync(dir, { recursive: true });
    this.evictOldest(dir, opts?.limit ?? DEFAULT_LEARNED_SKILL_LIMIT);

    const refined = opts?.refined;
    const id = slugify(refined ? refined.name : g);
    const updated = fs.existsSync(path.join(dir, id));
    const name = refined ? refined.name.slice(0, 60) : `settle:${g.slice(0, 30)}`;
    const description = refined ? refined.description.slice(0, 60) : `learned settle — ${g.slice(0, 30)}`;
    const body = refined
      ? clip(refined.body)
      : ['# Goal', '', g, '', '# Successful reply', '', clip(rep)].join('\n');
    this.writeSkillFile(dir, id, name, description, body);
    return ok({ id, updated });
  }

  /** G14.92 原地更新：覆盖既有 id 的 frontmatter 与正文（去重于源头——相近主题合并进既有技能，
   *  不新增目录）。id 不存在 → fail（调用方降级 create）。不计新增、不触发逐出（容量守恒） */
  updateExisting(id: string, refined: RefinedSkill): Result<string> {
    const dir = path.join(resolveDataDir(this.root), 'skills');
    const target = path.join(dir, id, 'skill.md');
    if (!fs.existsSync(target)) return fail('SKILL_UPDATE_MISSING', `SKILL_UPDATE_MISSING: ${id}`);
    this.writeSkillFile(dir, id, refined.name.slice(0, 60), refined.description.slice(0, 60), clip(refined.body));
    return ok(id);
  }

  private writeSkillFile(dir: string, id: string, name: string, description: string, body: string): void {
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
  }

  /** 撞名原地更新已收编进 settle（同 slug 覆盖，不产 -2 副本）；allocateId 撞名避让循环随之退役 */

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
