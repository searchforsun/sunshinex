// send_message 双面工具——主链面(lead→任一存活 teammate)与 teammate 派生面(同队队友或 lead,排己)
// 共用同一构造器;白名单与发件人身份由装配点闭包注入(harness/index.ts 双注册点)。投递语义:inbox.send
// 落档(append-only jsonl)→ agent-message 事件(lead 投递轨 = 事件即时呈现 + 落档;teammate 面消息在其
// 回合边界注入消费)。文案恒英文单语(工具 description/回执直接进模型面)。
import { CodedToolError, RegisteredTool } from '../harness/tools';
import type { Inbox } from './inbox';
import type { SessionEvent } from '../types';

/** text 上限(spec §5.5 消息体约束):超长违拒,不截断——发件方自查自改 */
const MAX_TEXT = 4000;

export interface SendMessageToolDeps {
  inbox: Inbox;
  /** agent-message 事件出口(透传装配层 onEvent;缺省零副作用) */
  onEvent?: (e: SessionEvent) => void;
  /** 同队存活成员(不含 'lead'——'lead' 恒可达由工具内判;teammate 面注入时排己) */
  knownRecipients: () => string[];
  /** 发件人身份注入(主链面 'lead';teammate 面为 teammate 名) */
  from: () => string;
  /** 发件人 teamId。lead 面省略:lead 可投给任一存活成员 */
  teamId?: () => string;
  /** 存活收件人的 teamId;未注册或已停返回 undefined,用于区分跨队与未知名 */
  recipientTeamId?: (name: string) => string | undefined;
}

/** send_message 工具(to/text 两参,category 'task'):to ∈ {'lead'} ∪ knownRecipients()
 *  (同队存活)、text 非空且 ≤4000。跨队活成员 → cannot send_message across teams;
 *  其余不在白名单 → cannot send_message to <to>: not a live member of team <teamId>。
 *  合法 → 落档 + 事件 + 回执 message <id> delivered to <to> */
export function makeSendMessageTool(deps: SendMessageToolDeps): RegisteredTool {
  return {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['to', 'text'],
      properties: {
        to: { type: ['string', 'null'], description: 'Living same-team teammate name, or "lead" for the main session.' },
        text: { type: ['string', 'null'], description: 'Message body (max 4000 chars).' },
      },
    },
    name: 'send_message',
    description:
      'Send a message to a living teammate on the same team, or to lead (to="lead"). Cross-team rejected. Persists to the shared inbox; lead sees it immediately, teammates at their next task boundary.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { to?: string | null; text?: string | null };
      const to = String(raw.to ?? '');
      if (to !== 'lead' && !deps.knownRecipients().includes(to)) {
        const mine = deps.teamId?.();
        const theirs = to !== '' ? deps.recipientTeamId?.(to) : undefined;
        if (mine !== undefined && theirs !== undefined && theirs !== mine) {
          throw new CodedToolError('INVALID_ARG', 'cannot send_message across teams');
        }
        const who = to === '' ? '(empty)' : to;
        const team = mine !== undefined ? `team ${mine}` : 'team';
        throw new CodedToolError('INVALID_ARG', `cannot send_message to ${who}: not a live member of ${team}`);
      }
      const text = String(raw.text ?? '');
      if (text.trim().length === 0) throw new CodedToolError('INVALID_ARG', 'message text must be non-empty');
      if (text.length > MAX_TEXT) throw new CodedToolError('INVALID_ARG', `message text too long: ${text.length} > ${MAX_TEXT} chars`);
      const m = await deps.inbox.send(to, { from: deps.from(), text });
      const senderTeam = deps.teamId?.();
      const teamId = typeof senderTeam === 'string' && senderTeam.length > 0 ? senderTeam : deps.recipientTeamId?.(to);
      deps.onEvent?.({
        type: 'agent-message',
        payload: {
          messageId: m.id,
          from: m.from,
          to: m.to,
          text: m.text,
          ...(typeof teamId === 'string' && teamId.length > 0 ? { teamId } : {}),
        },
        ts: m.ts,
      });
      return { exitCode: 0, stdout: `message ${m.id} delivered to ${to}`, stderr: '', timedOut: false };
    },
  };
}
