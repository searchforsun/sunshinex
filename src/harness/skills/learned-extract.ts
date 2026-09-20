import type { ModelAdapter } from '../../model/adapter';
import { scanMemoryText } from '../memory/guards';
import type { RefinedSkill } from './learned';

export const LEARNED_EXTRACTION_MARKER = 'learned-extraction';

export interface LearnedExtractionInput {
  goal: string;
  reply: string;
  outcome: 'done' | 'failed' | 'stopped';
  digest: string;
}

export function buildLearnedExtractionPrompt(input: LearnedExtractionInput): string {
  return [
    `You are distilling a reusable skill (${LEARNED_EXTRACTION_MARKER}) from a finished engineering session.`,
    'Capture lessons, not logs: a skill is instructions for doing a class of task the correct way.',
    'Be conservative — if the session taught nothing reusable, return {"skill":null}; saving nothing is a valid answer.',
    'Output strict JSON only, no prose: {"skill":{"name":"kebab-case-name","description":"what it does, at most 60 chars","body":"markdown"}} or {"skill":null}.',
    'The body must contain exactly these sections: ## When to Use / ## Procedure / ## Pitfalls / ## Verification.',
    'A pitfall is a generalizable rule plus one clause of why (the mechanism) — no incident narration, no PR or issue numbers, no dates, no quoted chat.',
    'Do not restate what SUNSHINE.md or the always-loaded context already covers.',
    `Session outcome: ${input.outcome}`,
    `Goal: ${input.goal}`,
    `Final reply: ${input.reply}`,
    'Step digest:',
    input.digest,
  ].join('\n');
}

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
  // name 须至少含一个字母/数字：slugify 对空串与纯标点会全折叠回退 'learned'（truthy），
  // 直接用 slugify(name) 判空会放行畸形 name，故先按字符面判定
  if (!name.replace(/[^\p{L}\p{N}]+/gu, '') || !description || !body) return null;
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

/** 提炼 tools 面（T5）：submit_refined_skill 结构化出牌（usable 语义 = skill 非 null） */
const LEARNED_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'submit_refined_skill',
      description: 'Submit the distilled reusable skill, or null when the session taught nothing reusable',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['skill'],
        properties: {
          skill: {
            type: ['object', 'null'],
            additionalProperties: false,
            required: ['name', 'description', 'body'],
            properties: {
              name: { type: 'string', description: 'kebab-case skill name' },
              description: { type: 'string', description: 'what it does, at most 60 chars' },
              body: { type: 'string', description: 'markdown with ## When to Use / ## Procedure / ## Pitfalls / ## Verification sections' },
            },
          },
        },
      },
    },
  },
];

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
