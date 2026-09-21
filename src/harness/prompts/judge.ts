import type { ChatTool } from '../../types';
import { render } from './shared';

/**
 * 判据裁决 prompt 模板：准则描述 + goal + 执行证据 → submit_verdict 三值出牌。
 * 动态占位符：{{GOAL}} / {{AGENT_REPLY}} / {{CRITERION_ID}} / {{CRITERION_DESC}}。
 */
const JUDGE_PROMPT_TEMPLATE = [
  'You are the acceptance judge. Goal: {{GOAL}}',
  'Execution reply (evidence): {{AGENT_REPLY}}',
  'Acceptance criterion {{CRITERION_ID}}: {{CRITERION_DESC}}',
  'Call submit_verdict exactly once with your verdict.',
].join('\n');

/** 判据 prompt（恒英文单语） */
export function buildJudgePrompt(criterion: { id: string; desc: string }, goal: string, agentReply: string): string {
  return render(JUDGE_PROMPT_TEMPLATE, {
    GOAL: goal,
    AGENT_REPLY: agentReply,
    CRITERION_ID: criterion.id,
    CRITERION_DESC: criterion.desc,
  });
}

/** 判据 tools 面：submit_verdict 单点——三值裁决经 parameters enum 强约束 */
export const JUDGE_TOOLS: ChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'submit_verdict',
      description: 'Submit the acceptance verdict for the criterion under evaluation',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['passed', 'verdict', 'evidence'],
        properties: {
          passed: { type: 'boolean', description: 'whether the criterion is satisfied' },
          verdict: { type: 'string', enum: ['met', 'not-yet', 'impossible'], description: 'met=satisfied; not-yet=fixable, keep looping; impossible=unsatisfiable, terminate' },
          evidence: { type: ['string', 'null'], description: 'evidence from the execution reply backing the verdict' },
        },
      },
    },
  },
];
