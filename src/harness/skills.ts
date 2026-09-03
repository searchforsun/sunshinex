import * as fs from 'fs';
import * as path from 'path';
import { SkillManifest } from '../types';

/** 解析 skill.md 的简易 frontmatter（--- 块内 key: value） */
export function parseSkillFrontmatter(md: string): Omit<SkillManifest, 'id'> {
  const out: Record<string, string> = { name: '', description: '', version: '0.1.0' };
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(md);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(line.trim());
      if (kv) out[kv[1]] = kv[2].trim();
    }
  }
  return { name: out.name, description: out.description, version: out.version };
}

/** 扫描 skills/{id}/skill.md，返回技能清单 */
export function loadSkills(root: string): SkillManifest[] {
  const dir = path.join(root, 'skills');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const skillFile = path.join(dir, d.name, 'skill.md');
      if (!fs.existsSync(skillFile)) return null;
      const meta = parseSkillFrontmatter(fs.readFileSync(skillFile, 'utf8'));
      return { id: d.name, ...meta } as SkillManifest;
    })
    .filter((s): s is SkillManifest => s !== null);
}
