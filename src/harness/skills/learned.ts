import * as fs from 'fs';
import * as path from 'path';
import { Result, ok, fail } from '../../result';

const MAX_BODY_CHARS = 2000;
const MAX_LEARNED_SKILLS = 50;

/** goal 确定性 slug 化：非安全字符折叠为 `-`，截长 40，全折叠回退 learned（撞名避让与清库判断共用同一 slug 面） */
export function slugify(goal: string): string {
  const slug = goal
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'learned';
}

function clip(text: string): string {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…（已截断）` : text;
}

/**
 * 学习技能写入面：成功任务沉淀为 .data/skills/{id}/skill.md（.data 已 gitignore，学习产物不入库；
 * 用户技能 skills/ 恒优先于学习产物，本类只管写入不参与运行时合并）。
 * 撞名追加 -2/-3… 不覆盖既有产物；目录上限 50（对齐 CAP.skill）超限按 mtime 删最旧。
 */
export class LearnedSkillStore {
  constructor(private root: string) {}

  settle(goal: string, reply: string): Result<string> {
    const g = goal.trim();
    const rep = reply.trim();
    if (!g || !rep) return fail('SKILL_SETTLE_EMPTY', '沉淀失败：goal 与 reply 均不得为空');

    const dir = path.join(this.root, '.data', 'skills');
    fs.mkdirSync(dir, { recursive: true });
    this.evictOldest(dir);

    const id = this.allocateId(dir, slugify(g));
    const md = [
      '---',
      `name: 沉淀:${g.slice(0, 30)}`,
      `description: 学习沉淀 —— ${g.slice(0, 30)}`,
      'version: 0.1.0',
      'kind: prompt',
      'params:',
      'source: learned',
      '---',
      '',
      '# 目标',
      '',
      g,
      '',
      '# 成功答复',
      '',
      clip(rep),
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

  /** 超上限按 mtime 升序删最旧，为本次沉淀腾出 1 个空位 */
  private evictOldest(dir: string): void {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const p = path.join(dir, e.name);
        return { path: p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);
    const excess = entries.length - (MAX_LEARNED_SKILLS - 1);
    for (const e of entries.slice(0, Math.max(0, excess))) {
      fs.rmSync(e.path, { recursive: true, force: true });
    }
  }
}
