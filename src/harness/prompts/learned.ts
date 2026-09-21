import { render } from './shared';

/** learned 提炼固定标记（测试桩据此区分提炼调用与主链调用——对齐 'handoff summary' 先例）；单点在此、learned-extract 原位再导出 */
export const LEARNED_EXTRACTION_MARKER = 'learned-extraction';

export interface LearnedExtractionInput {
  goal: string;
  reply: string;
  outcome: 'done' | 'failed' | 'stopped';
  digest: string;
}

/**
 * learned 技能提炼 prompt 模板（lessons-not-logs）。
 * 动态占位符：{{MARKER}} / {{OUTCOME}} / {{GOAL}} / {{REPLY}} / {{DIGEST}}。
 */
const LEARNED_PROMPT_TEMPLATE = [
  'You are distilling a reusable skill ({{MARKER}}) from a finished engineering session.',
  'Capture lessons, not logs: a skill is instructions for doing a class of task the correct way.',
  'Be conservative — if the session taught nothing reusable, return {"skill":null}; saving nothing is a valid answer.',
  'Output strict JSON only, no prose: {"skill":{"name":"kebab-case-name","description":"what it does, at most 60 chars","body":"markdown"}} or {"skill":null}.',
  'The body must contain exactly these sections: ## When to Use / ## Procedure / ## Pitfalls / ## Verification.',
  'A pitfall is a generalizable rule plus one clause of why (the mechanism) — no incident narration, no PR or issue numbers, no dates, no quoted chat.',
  'Do not restate what SUNSHINE.md or the always-loaded context already covers.',
  'Session outcome: {{OUTCOME}}',
  'Goal: {{GOAL}}',
  'Final reply: {{REPLY}}',
  'Step digest:',
  '{{DIGEST}}',
].join('\n');

/** 提炼 prompt（恒英文单语） */
export function buildLearnedExtractionPrompt(input: LearnedExtractionInput): string {
  return render(LEARNED_PROMPT_TEMPLATE, {
    MARKER: LEARNED_EXTRACTION_MARKER,
    OUTCOME: input.outcome,
    GOAL: input.goal,
    REPLY: input.reply,
    DIGEST: input.digest,
  });
}

/** 提炼 tools 面：submit_refined_skill 结构化出牌（usable 语义 = skill 非 null） */
export const LEARNED_TOOLS = [
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
