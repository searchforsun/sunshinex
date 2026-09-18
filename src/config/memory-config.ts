/**
 * 记忆控制面（规格 §7）三层解析单点：环境变量 > SUNSHINE.md `## 记忆` 分区 > 缺省。
 * 非法值装配期 fail-fast（沿用 agents/MCP 装配纪律）——不做静默兜底，配置错误必须显式暴露。
 */
import * as fs from 'fs';
import * as path from 'path';

export interface MemoryConfig {
  /** 陈述性记忆总开关（不注入 / 不提取 / 不整理 / 写被拒，四处贯通） */
  autoMemory: boolean;
  /** 程序性记忆（技能沉淀）开关 */
  learnedSkills: boolean;
  /** 技能沉淀 FIFO 上限（替换旧硬编码 50） */
  learnedSkillLimit: number;
}

export const DEFAULT_LEARNED_SKILL_LIMIT = 50;

const SECTION = /^##\s+(Memory|记忆)\s*$/;
const KV = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/;

/** 抽取 `## 记忆` 区键值对（区体在下个二级标题或文件尾终止；无区为空集） */
function sectionKeys(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => SECTION.test(l.trim()));
  if (start < 0) return out;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i].trim())) break;
    const m = KV.exec(lines[i].trim());
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function onOff(key: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'on' || v === 'true') return true;
  if (v === 'off' || v === 'false') return false;
  throw new Error(`memory config: ${key} must be on|off, got "${raw}"`);
}

function limit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LEARNED_SKILL_LIMIT;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(n) || String(n) !== raw.trim() || n < 1 || n > 1000) {
    throw new Error(`memory config: learned_skill_limit must be an integer in 1..1000, got "${raw}"`);
  }
  return n;
}

/** 解析链：env（SUNSHINEX_AUTO_MEMORY / SUNSHINEX_LEARNED_SKILLS / SUNSHINEX_LEARNED_SKILL_LIMIT）> SUNSHINE.md 分区 > 缺省 */
export function resolveMemoryConfig(root: string, env: NodeJS.ProcessEnv = process.env): MemoryConfig {
  let md = '';
  try {
    md = fs.readFileSync(path.join(root, 'SUNSHINE.md'), 'utf8');
  } catch {
    md = '';
  }
  const keys = sectionKeys(md);
  return {
    autoMemory: onOff('auto_memory', env.SUNSHINEX_AUTO_MEMORY ?? keys.auto_memory, true),
    learnedSkills: onOff('learned_skills', env.SUNSHINEX_LEARNED_SKILLS ?? keys.learned_skills, true),
    learnedSkillLimit: limit(env.SUNSHINEX_LEARNED_SKILL_LIMIT ?? keys.learned_skill_limit),
  };
}
