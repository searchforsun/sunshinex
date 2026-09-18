/**
 * 记忆控制面（规格 §7）解析单点：环境变量 > 缺省。
 * **不读 SUNSHINE.md**（2026-09-18 用户裁决）：该文件与 CLAUDE.md 同定位——项目规范、给模型的指令，不承载键值配置。
 * 非法值装配期 fail-fast（沿用 agents/MCP 装配纪律）——不做静默兜底，配置错误必须显式暴露。
 */
export interface MemoryConfig {
  /** 陈述性记忆总开关（不注入 / 不提取 / 不整理 / 写被拒，四处贯通） */
  autoMemory: boolean;
  /** 程序性记忆（技能沉淀）开关 */
  learnedSkills: boolean;
  /** 技能沉淀 FIFO 上限（替换旧硬编码 50） */
  learnedSkillLimit: number;
}

export const DEFAULT_LEARNED_SKILL_LIMIT = 50;

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

/** 解析链：会话内覆盖（TUI /memory on|off，进程级单值、不落盘）> env（SUNSHINEX_AUTO_MEMORY / SUNSHINEX_LEARNED_SKILLS / SUNSHINEX_LEARNED_SKILL_LIMIT）> 缺省。
 *  覆盖仅作用于运行时判门点（提取/注入/写入闸门），控制面解析零副作用；/new 等新会话起点由调用方显式清除。 */
let sessionAutoMemoryOverride: boolean | undefined;

export function setMemorySessionOverride(v: boolean | undefined): void {
  sessionAutoMemoryOverride = v;
}

export function resolveMemoryConfig(env: NodeJS.ProcessEnv = process.env): MemoryConfig {
  return {
    autoMemory: sessionAutoMemoryOverride ?? onOff('auto_memory', env.SUNSHINEX_AUTO_MEMORY, true),
    learnedSkills: onOff('learned_skills', env.SUNSHINEX_LEARNED_SKILLS, true),
    learnedSkillLimit: limit(env.SUNSHINEX_LEARNED_SKILL_LIMIT),
  };
}
