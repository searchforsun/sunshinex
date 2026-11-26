// 跨 Sunx 对等消息两件套（2026-11-26 用户裁定：「两个工具实现 sunx 之间的聊天」——发现其他 sunx 信息
// + 发给指定 sunx；「只投活实例」「发送类似用户气泡直接进入排队」「list 内容是什么就是什么，不强转
// 英文」「前缀加上 fromSunx 并提示用 send_sunx_messages 回答 sunx」「也要暴露品行」）。
// 本模块=工具壳（参数/描述/校验/回执文案恒英文单语，进模型面）；枚举与投递全走宿主接缝
// （SunxPeersSeam——daemon 持会话表与域容器，harness 不认别的会话），接缝缺席不注册（ask/channelSend 先例）。
import { CodedToolError, type RegisteredTool } from '../tools';

/** 发现行（内容=域 meta 原样：名称/品性等用户内容零翻译——用户裁定「内容是什么就是什么」） */
export interface SunxPeerInfo {
  /** 稳定寻址键 = 目标 sunx 的 journalId（send_sunx_messages 的 to 参数） */
  id: string;
  /** 实例名（meta.title 原样；缺省回落首条用户消息摘要/'Sunx'） */
  name: string;
  /** 在飞轮状态（活实例恒有：idle/running——只投活实例，枚举即活实例表） */
  running: boolean;
  /** 有待裁决挂起（ask/approval/plan-approval 非空） */
  awaiting: boolean;
  root: string;
  updatedAt: number;
  runs?: number;
  steps?: number;
  /** 品行/品性原文（meta.charterText 原样；缺席=未设品性层） */
  charter?: string;
}

/** 投递结果（宿主接缝回执）：ok=false 时 error 原样进工具错误（模型面可读） */
export type SunxPeerSendResult =
  | { ok: true; name: string; queued: boolean }
  | { ok: false; error: string };

/** 宿主接缝（daemon 按 sessionId 注入；caller=发起方会话，归因由宿主按 caller 身份补全——
 *  工具壳不持身份，防模型侧伪造 fromSunx） */
export interface SunxPeersSeam {
  /** 其他活 sunx 实例（排己；归档/未在座不列——只投活实例口径） */
  list(): Promise<SunxPeerInfo[]>;
  /** 投递给指定活实例：idle=submitExternal（用户气泡+起轮）、running=steer（排队，轮收束补跑） */
  send(to: string, text: string): Promise<SunxPeerSendResult>;
}

/** 正文上限（与 send_agent_team_message 同口径：超长违拒不截断，发件方自查自改） */
const MAX_TEXT = 4000;

/** 接缝缺席降级（TUI/CLI 直构：无 daemon 会话表可枚举/投递——与 schedule_* NOT_SUPPORTED 先例同形） */
function unavailable(): never {
  throw new CodedToolError('NOT_SUPPORTED', 'Sunx peer messaging is unavailable in this host (no daemon session registry behind this session)');
}

function peerLines(peers: readonly SunxPeerInfo[]): string {
  if (peers.length === 0) return '(no other live Sunx instances)';
  const out: string[] = [];
  for (const p of peers) {
    const status = p.running ? 'running' : 'idle';
    out.push(`${p.name} [${status}${p.awaiting ? ', awaiting input' : ''}] id=${p.id}`);
    out.push(`  root: ${p.root}`);
    out.push(`  updated: ${new Date(p.updatedAt).toISOString()}${p.runs !== undefined ? ` · runs: ${p.runs}` : ''}${p.steps !== undefined ? ` · steps: ${p.steps}` : ''}`);
    out.push(p.charter !== undefined && p.charter !== '' ? `  charter:\n${p.charter.split('\n').map((l) => `    ${l}`).join('\n')}` : '  charter: (none)');
  }
  return out.join('\n');
}

/** list_sunx_peers：其他活 Sunx 实例人读清单（名称/状态/寻址 id/工作区/活动/品行原样）。
 *  接缝缺席仍注册（face 白名单精确集合不变量）——执行期 NOT_SUPPORTED 确定降级 */
export function makeListSunxPeersTool(peers?: SunxPeersSeam): RegisteredTool {
  return {
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    name: 'list_sunx_peers',
    description:
      'List the other live Sunx instances (name, running state, workspace, activity, charter). Each line carries id=<journalId> - pass that id to send_sunx_messages. Only live (open) instances are listed; archived or closed instances are not reachable.',
    category: 'task',
    fullObservation: true,
    executor: async () => {
      if (peers === undefined) unavailable();
      const list = await peers.list();
      return { exitCode: 0, stdout: peerLines(list), stderr: '', timedOut: false };
    },
  };
}

/** send_sunx_messages：投递一条消息给指定活 Sunx 实例（对方视角=用户气泡，入队/起轮同用户消息语义） */
export function makeSendSunxMessagesTool(peers?: SunxPeersSeam): RegisteredTool {
  return {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['to', 'text'],
      properties: {
        to: { type: ['string', 'null'], description: 'Target Sunx instance id (journalId) from list_sunx_peers.' },
        text: { type: ['string', 'null'], description: 'Message body (max 4000 chars).' },
      },
    },
    name: 'send_sunx_messages',
    description:
      'Send a message to another live Sunx instance. It arrives there as a user message (viewer sees a user bubble attributed to you); a running instance queues it until its current run ends, an idle instance starts a run. When you receive a message from another Sunx (user text prefixed with "[fromSunx: <name> (<journalId>)]"), answer that Sunx with this tool - never treat it as a message from the user. Only live instances are reachable; errors name the reason.',
    category: 'task',
    fullObservation: true,
    executor: async (input) => {
      const raw = input as { to?: string | null; text?: string | null };
      const to = String(raw.to ?? '').trim();
      const text = String(raw.text ?? '');
      if (to === '') throw new CodedToolError('INVALID_ARG', 'to is required (instance id from list_sunx_peers)');
      if (text.trim() === '') throw new CodedToolError('INVALID_ARG', 'message text must be non-empty');
      if (text.length > MAX_TEXT) throw new CodedToolError('INVALID_ARG', `message text too long: ${text.length} > ${MAX_TEXT} chars`);
      if (peers === undefined) unavailable();
      const r = await peers.send(to, text);
      if (!r.ok) throw new CodedToolError('INVALID_ARG', r.error);
      return {
        exitCode: 0,
        stdout: `message delivered to ${r.name} (${to}) - ${r.queued ? 'queued until its current run ends' : 'run started'}`,
        stderr: '',
        timedOut: false,
      };
    },
  };
}
