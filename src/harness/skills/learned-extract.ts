import type { ModelAdapter } from '../../model/adapter';
import { scanMemoryText } from '../memory/guards';
import type { RefinedSkill } from './learned';
import { LEARNED_EXTRACTION_MARKER, buildLearnedExtractionPrompt, LEARNED_TOOLS } from '../prompts/learned';
import type { LearnedExtractionInput } from '../prompts/learned';

export { LEARNED_EXTRACTION_MARKER, buildLearnedExtractionPrompt };
export type { LearnedExtractionInput };

export function parseLearnedEnvelope(out: string): { skill: RefinedSkill | null } | null {
  const text = String(out ?? '').trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const skill = (obj as { skill?: unknown }).skill;
  if (skill === null) return { skill: null };
  if (typeof skill !== 'object' || skill === null) return null;
  const name = String((skill as { name?: unknown }).name ?? '').trim();
  const description = String((skill as { description?: unknown }).description ?? '').trim();
  const body = String((skill as { body?: unknown }).body ?? '').trim();
  // name 须至少含一个 ASCII 字母/数字：slugify 按 ASCII 口径折叠，纯中文/纯标点 name 会全折叠回退
  // 'learned'（truthy），直接用 slugify(name) 判空会放行畸形 name，故先按字符面判定
  if (!name.replace(/[^a-zA-Z0-9]+/g, '') || !description || !body) return null;
  const clipped = description.slice(0, 60);
  if (scanMemoryText(`${clipped}\n${body}`)) return null;
  return { skill: { name, description: clipped, body } };
}

export async function extractLearnedSkill(
  model: ModelAdapter,
  input: LearnedExtractionInput,
): Promise<{ skill: RefinedSkill | null } | null> {
  try {
    const chat = model.chat;
    if (!chat) return null;
    const res = await chat.call(model, {
      messages: [{ role: 'user', content: buildLearnedExtractionPrompt(input) }],
      tools: LEARNED_TOOLS,
    });
    const call = res.toolCalls.find((t) => t.name === 'submit_refined_skill');
    if (!call) return null;
    return parseRefinedPayload(call.argsJson);
  } catch {
    return null;
  }
}

/** 结构化提炼载荷解析（复用 parseLearnedEnvelope 的对象校验与闸门扫描） */
function parseRefinedPayload(argsJson: string): { skill: RefinedSkill | null } | null {
  try {
    const obj = JSON.parse(argsJson) as { skill?: unknown };
    if (obj.skill === null) return { skill: null };
    const name = String((obj.skill as { name?: unknown })?.name ?? '').trim();
    const description = String((obj.skill as { description?: unknown })?.description ?? '').trim();
    const body = String((obj.skill as { body?: unknown })?.body ?? '').trim();
    if (!name && !description && !body) return null;
    return parseLearnedEnvelope(JSON.stringify({ skill: { name, description, body } }));
  } catch {
    return null;
  }
}
