import type { ModelAdapter } from '../../model/adapter';
import { scanMemoryText } from '../memory/guards';
import type { RefinedSkill } from './learned';
import { LEARNED_EXTRACTION_MARKER, buildLearnedExtractionPrompt, LEARNED_TOOLS } from '../prompts/learned';
import type { LearnedExtractionInput } from '../prompts/learned';

export { LEARNED_EXTRACTION_MARKER, buildLearnedExtractionPrompt };
export type { LearnedExtractionInput };

/** G14.92 提炼裁决三态：create=新技能 / update=原地合并既有 id / skip=无可复用内容 */
export interface LearnedVerdict {
  action: 'create' | 'update' | 'skip';
  /** update 的目标 id（ALREADY-LEARNED SKILLS 之一；create/skip 无） */
  id?: string;
  skill?: RefinedSkill;
}

/** 名字质量门（代码侧双保险，模型侧 prompt 同律）：至少 3 字符、含 ASCII 字母、结尾为字母——
 *  纯数字（'34'）、单词命令（'rm'）、全折叠回退名（'learned'）一律不合格 */
export function validSkillName(name: string): boolean {
  const n = name.trim();
  return n.length >= 3 && n.toLowerCase() !== 'learned' && /^[a-z0-9][a-z0-9-]*[a-z]$/i.test(n) && /[a-zA-Z]/.test(n);
}

/** 结构化裁决解析：畸形/名字不合格 → null（调用方据此带错误重试） */
export function parseLearnedVerdict(argsJson: string): LearnedVerdict | null {
  let obj: { action?: unknown; id?: unknown; skill?: unknown };
  try {
    obj = JSON.parse(argsJson) as typeof obj;
  } catch {
    return null;
  }
  const action = String(obj.action ?? '');
  if (action === 'skip') return { action: 'skip' };
  if (action !== 'create' && action !== 'update') return null;
  const skillRaw = (obj.skill ?? {}) as { name?: unknown; description?: unknown; body?: unknown };
  const name = String(skillRaw.name ?? '').trim();
  const description = String(skillRaw.description ?? '').trim();
  const body = String(skillRaw.body ?? '').trim();
  if (!validSkillName(name)) return null;
  if (!description || !body) return null;
  const clipped = description.slice(0, 60);
  if (scanMemoryText(`${clipped}
${body}`)) return null;
  const skill: RefinedSkill = { name, description: clipped, body };
  if (action === 'update') {
    const id = String(obj.id ?? '').trim();
    if (id === '') return null;
    return { action: 'update', id, skill };
  }
  return { action: 'create', skill };
}

/** 兼容旧面（learned.test 消费）：envelope 文本 → 二态。三态语义下 create 才算产物，update/skip 归 null */
export function parseLearnedEnvelope(out: string): { skill: RefinedSkill | null } | null {
  const text = String(out ?? '').trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const v = parseLearnedVerdict(text.slice(start, end + 1));
  if (v === null || v.action !== 'create' || v.skill === undefined) return { skill: null };
  return { skill: v.skill };
}

const MAX_ATTEMPTS = 3; // 首次 + 2 次带错误反馈重试；仍败即丢弃（宁缺勿滥）

/**
 * 提炼入口（G14.92 重试环）：解析失败/名字不合格/字段缺失 → 错误信息并入下一轮材料重试
 * （最多 2 次重试），三次皆败返回 skip（丢弃，不落盘不回退）——带病产物宁可不进技能库。
 */
export async function extractLearnedSkill(model: ModelAdapter, input: LearnedExtractionInput): Promise<LearnedVerdict> {
  const chat = model.chat;
  if (!chat) return { action: 'skip' };
  let feedback = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const prompt = buildLearnedExtractionPrompt(input);
      const res = await chat.call(model, {
        messages: [
          { role: 'user', content: attempt === 0 ? prompt : `${prompt}\n\nPREVIOUS ATTEMPT REJECTED: ${feedback}\nFix the stated problem and resubmit.` },
        ],
        tools: LEARNED_TOOLS,
      });
      const call = res.toolCalls.find((t) => t.name === 'submit_refined_skill');
      if (call === undefined) {
        feedback = 'no submit_refined_skill tool call in response';
        continue;
      }
      const v = parseLearnedVerdict(call.argsJson);
      if (v !== null) return v;
      feedback = `payload invalid: action must be create|update|skip; skill.name must be kebab-case with letters (>=3 chars); description/body required'; payload head: ' + String(call.argsJson).slice(0, 120)`;
    } catch (e) {
      feedback = `extraction call failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { action: 'skip' };
}
