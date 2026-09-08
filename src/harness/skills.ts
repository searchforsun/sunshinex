import * as fs from 'fs';
import * as path from 'path';
import { SkillManifest } from '../types';
import { Result, ok, fail } from '../result';

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
  const file = path.join(skillsDir, id, 'skill.md');
  if (!fs.existsSync(file)) return fail('SKILL_NOT_FOUND', `技能未注册：${id}`);

  const md = fs.readFileSync(file, 'utf8');
  const manifest: SkillManifest = { id, ...parseSkillFrontmatter(md) };
  const body = md.replace(FRONTMATTER, '').trim();

  const provided = params ?? {};
  const missing = (manifest.params ?? []).filter((p) => !(p in provided));
  if (missing.length > 0) return fail('SKILL_PARAM_MISSING', `技能 ${id} 缺少形参：${missing.join(', ')}`);

  const whitelist = manifest.params ?? [];
  const resolved = body.replace(PLACEHOLDER, (raw, name: string) => (whitelist.includes(name) ? provided[name] : raw));
  return ok({ manifest, body: resolved });
}
