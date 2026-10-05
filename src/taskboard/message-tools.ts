// T2(P2 spec §5):send_message 双面工具——主链面(lead→teammate)与 teammate 派生面(teammate→lead/他队友,
// 排己)共用同一构造器;收件人白名单与发件人身份由装配点闭包注入(harness/index.ts 双注册点),工具本身
// 不持 team 引用。投递语义:inbox.send 落档(append-only jsonl,重启可续)→ agent-message 事件(lead 投递轨
// = 事件即时呈现 + 落档,Ruling 3;teammate 面消息在其回合边界由 T3 注入消费)。文案恒英文单语(工具
// description/回执直接进模型面)。
import { CodedToolError, RegisteredTool } from '../harness/tools';
import type { FileInbox } from './file-inbox';
import type { SessionEvent } from '../types';

/** text 上限(spec §5.5 消息体约束):超长违拒,不截断——发件方自查自改 */
const MAX_TEXT = 4000;

export interface SendMessageToolDeps {
  inbox: FileInbox;
  /** agent-message 事件出口(透传装配层 onEvent;缺省零副作用) */
  onEvent?: (e: SessionEvent) => void;
  /** 可达收件人活名单(不含 'lead'——'lead' 恒可达由工具内判;teammate 面注入时排己) */
  knownRecipients: () => string[];
  /** 发件人身份注入(主链面 'lead';teammate 面为 teammate 名) */
  from: () => string;
}

/** send_message 工具(to/text 两参,category 'task'):to ∈ {'lead'} ∪ knownRecipients()、
 *  text 非空且 ≤4000,违者 CodedToolError INVALID_ARG;合法 → 落档 + 事件 + 回执 message <id> delivered to <to> */
export function makeSendMessageTool(deps: SendMessageToolDeps): RegisteredTool {
  return {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['to', 'text'],
      properties: {
        to: { type: ['string', 'null'], description: 'Recipient: a live teammate name, or "lead" for the main session.' },
        text: { type: ['string', 'null'], description: 'Message body (max 4000 chars). Delivered at the recipient task boundary; lead sees it immediately.' },
      },
    },
    name: 'send_message',
    description:
      'Send a direct message to a live teammate or the main session (to="lead"); messages persist to the shared inbox and lead sees them immediately.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { to?: string | null; text?: string | null };
      const to = String(raw.to ?? '');
      const live = ['lead', ...deps.knownRecipients()];
      if (to !== 'lead' && !deps.knownRecipients().includes(to)) {
        throw new CodedToolError('INVALID_ARG', `unknown recipient: ${to === '' ? '(empty)' : to}; live: ${live.join(', ')}`);
      }
      const text = String(raw.text ?? '');
      if (text.trim().length === 0) throw new CodedToolError('INVALID_ARG', 'message text must be non-empty');
      if (text.length > MAX_TEXT) throw new CodedToolError('INVALID_ARG', `message text too long: ${text.length} > ${MAX_TEXT} chars`);
      const m = await deps.inbox.send(to, { from: deps.from(), text });
      deps.onEvent?.({ type: 'agent-message', payload: { messageId: m.id, from: m.from, to: m.to, text: m.text }, ts: m.ts });
      return { exitCode: 0, stdout: `message ${m.id} delivered to ${to}`, stderr: '', timedOut: false };
    },
  };
}
