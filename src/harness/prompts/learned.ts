import { render } from './shared';

/** learned 提炼固定标记（测试桩据此区分提炼调用与主链调用——对齐 'handoff summary' 先例）；单点在此、learned-extract 原位再导出 */
export const LEARNED_EXTRACTION_MARKER = 'learned-extraction';

export interface LearnedExtractionInput {
  goal: string;
  reply: string;
  outcome: 'done' | 'failed' | 'stopped';
  digest: string;
  /** G14.81 跨轮合成上下文：此前各轮目标与结局（旧→新，不含当前轮） */
  recent: Array<{ goal: string; outcome: string }>;
  /** 已沉淀技能名（去重/合并判断用） */
  existing: string[];
}

/**
 * learned 技能提炼 prompt 模板（lessons-not-logs + 价值门控 + 跨轮合成 + 业务命名）。
 * 动态占位符：{{MARKER}} / {{OUTCOME}} / {{GOAL}} / {{REPLY}} / {{DIGEST}} / {{RECENT}} / {{EXISTING}}。
 */
const LEARNED_PROMPT_TEMPLATE = [
  'You are distilling a reusable skill ({{MARKER}}) from finished engineering work.',
  'A skill is PROCEDURAL memory: instructions for repeating a non-obvious class of task correctly.',
  '',
  'VALUE GATE (be very strict — most rounds must NOT produce a skill):',
  '- REJECT one-off operations: running a single command, deleting/creating a file, asking a question,',
  '  answering, status replies, introductions, summaries, trivial CRUD — anything a competent engineer',
  '  does without thinking teaches nothing.',
  '- ACCEPT only: a multi-step procedure with non-obvious ordering or caveats, an architectural flow worth',
  '  repeating, a hard-won pitfall with its mechanism, or a decision pattern likely to recur in this project.',
  '- When unsure whether it is reusable, reject.',
  '- You MAY synthesize one skill spanning several of the recent sessions when together they form one coherent procedure.',
  '',
  'RESPONSIBILITY SPLIT (do not double-record):',
  '- Skills = HOW to do things (procedures). Facts, events, user preferences, what happened — those belong to',
  '  episodic memory (a separate channel); never encode them as a skill.',
  '',
  'DEDUP / UPDATE (avoid skill-library pollution at the source):',
  '- Check ALREADY-LEARNED SKILLS first. If one covers the same ground, set "action":"update" with that exact id',
  '  and a MERGED body (keep still-valid points, fold in the new lesson) — never a near-duplicate.',
  '- Only truly new ground gets "action":"create". The create name must NOT equal or nearly equal any existing id:',
  '  name collisions are folded into the existing skill (in-place update) by the harness — a -2 style copy never exists.',
  '',
  'NAMING (mandatory for create; id decides the target for update):',
  '- name = short English kebab-case reflecting the BUSINESS capability or lesson, e.g. "auth-login-strategy".',
  '- MUST contain letters and be at least 3 characters; NEVER generic ("learned", "task", "session"), never bare',
  '  numbers, never non-English words. A failing name is rejected by the harness and retried with the error attached.',
  '',
  'Output strict JSON only, no prose:',
  '  accept:   {"action":"create","skill":{"name":"kebab-case-name","description":"at most 60 chars","body":"markdown"}}',
  '  update:   {"action":"update","id":"existing-skill-id","skill":{"name":"...","description":"...","body":"..."}}',
  '  reject:   {"action":"skip"}',
  'The body must contain exactly these sections: ## When to Use / ## Procedure / ## Pitfalls / ## Verification.',
  'A pitfall is a generalizable rule plus one clause of why (the mechanism) — no incident narration, no PR or issue numbers, no dates, no quoted chat.',
  'Do not restate what SUNSHINE.md or the always-loaded context already covers.',
  '',
  'Session outcome: {{OUTCOME}}',
  'Goal: {{GOAL}}',
  'Final reply: {{REPLY}}',
  'Step digest:',
  '{{DIGEST}}',
  '',
  'Recent sessions (older → newer, for cross-round synthesis):',
  '{{RECENT}}',
  'Already-learned skills (id list — update target must be one of these): {{EXISTING}}',
].join('\n');

/** 提炼 prompt（恒英文单语） */
export function buildLearnedExtractionPrompt(input: LearnedExtractionInput): string {
  return render(LEARNED_PROMPT_TEMPLATE, {
    MARKER: LEARNED_EXTRACTION_MARKER,
    OUTCOME: input.outcome,
    GOAL: input.goal,
    REPLY: input.reply,
    DIGEST: input.digest,
    RECENT: input.recent.length > 0 ? input.recent.map((r2) => `- (${r2.outcome}) ${r2.goal}`).join('\n') : '(none)',
    EXISTING: input.existing.length > 0 ? input.existing.join(', ') : '(none)',
  });
}

/** 提炼 tools 面：submit_refined_skill 结构化出牌（G14.92 三态 create/update/skip） */
export const LEARNED_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'submit_refined_skill',
      description: 'Submit the distillation verdict: create a new skill, update an existing one, or skip',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'skip'], description: 'create=new skill, update=merge into existing id, skip=nothing reusable' },
          id: { type: 'string', description: 'existing skill id to update (required when action=update, must be one of ALREADY-LEARNED SKILLS)' },
          skill: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'description', 'body'],
            properties: {
              name: { type: 'string', description: 'short English kebab-case name reflecting the business capability; must contain letters, never generic like learned/task/numbers' },
              description: { type: 'string', description: 'what it does, at most 60 chars' },
              body: { type: 'string', description: 'markdown with ## When to Use / ## Procedure / ## Pitfalls / ## Verification sections' },
            },
          },
        },
      },
    },
  },
];
