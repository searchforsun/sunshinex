import * as http from 'node:http';
import type { EventFrame } from './session';
import type { ApprovalRequest, AskUserAnswer, AskUserRequest } from '../types';

/** daemon 下行 wire 面（D31 分域拆分自 daemon.ts）：HTTP URL 解析原语（urlOf/LOOPBACK_HOST）+
 *  下行帧形态（事件帧并集/审批/问询/reset）与挂起表条目——叶子模块，daemon 与各 handler 域共用，
 *  零上层依赖（防 config 域 → daemon 类的运行时环）。
 */

/** daemon 恒绑回环（G10 免鉴权档裁定「本地工具不设密」）：bind 面与 serve 打印面同源单点 */
export const LOOPBACK_HOST = '127.0.0.1';

/** 请求 URL 解析单点：base 仅为解析锚（host 不参与实际绑定），pathname/search 统一出口 */
export function urlOf(req: http.IncomingMessage): URL {
  return new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
}


/** 挂起面 WS 帧（G4 审批问询，spec §4.2）：无 seq——不入单调序列（挂起非事件流成员，重连重发幂等，
 *  客户端以 pid 去重）；pid 为 daemon 级铸造的挂起票据（回执端点 `POST /approval/:pid` /
 *  `POST /ask/:pid/reply` 的寻址键）；req 纯数据直序列化（ApprovalRequest/AskUserRequest 字面） */
export interface ApprovalFrame {
  kind: 'approval';
  sessionId: string;
  pid: string;
  req: ApprovalRequest;
}

/** ask 挂起帧：AskUserRequest 无 id 字段（types.ts 现场核）——pid 由 daemon 单点铸造承载回执寻址 */
export interface AskFrame {
  kind: 'ask';
  sessionId: string;
  pid: string;
  req: AskUserRequest;
}

/** plan 审批挂起帧（阶段三 plan-arm,spec §5.1）：planFlow 裁决卡——req={doc,items} 计划书全文+步骤
 *  清单（纯数据直序列化,同 approval/ask 形态）;回执端点 `POST /plan-approval/:pid` {approved,feedback?}，
 *  决策形 `{approved:boolean,feedback?:string}`（harness PlanDecision 同构）。无 seq——不入单调序列
 *  （挂起非事件流成员,重连重发幂等,客户端以 pid 去重） */
export interface PlanApprovalFrame {
  kind: 'plan-approval';
  sessionId: string;
  pid: string;
  req: { doc: string; items: string[] };
}

/** reset 通知帧（G4 裁定 7）：无 seq——GUI 收到即清该会话本地投影并重播种（sessionSnapshot） */
export interface ResetFrame {
  kind: 'reset';
  sessionId: string;
}

/** daemon 下行帧全并集：pump 事件帧（有 seq）+ 挂起/reset 帧（无 seq）——广播面单点共用序列化 */
export type DaemonFrame = EventFrame | ApprovalFrame | AskFrame | PlanApprovalFrame | ResetFrame;

/** P1 Task 6 batch=1 客户端合帧形态：30ms 合批窗内连发的事件帧打包单帧下行（内嵌数组序保持）——
 *  挂起/reset 帧绕过合批直发（审批即时性优先）。仅下行合成帧，不经 broadcastFrame 入参（泵输入
 *  并集保持精确，客户端帧并集 = DaemonFrame | WsBatchFrame） */
export interface WsBatchFrame {
  kind: 'batch';
  frames: EventFrame[];
}

/** batch 客户端合批窗（毫秒）：窗内连发事件攒一帧，首帧入窗即起表 */
export const BATCH_FLUSH_MS = 30;

/** AskUserAnswer 回执载荷校验（G4）：三态字面核验——selected 需 string[]、custom 需非空 text、
 *  dismissed 无参；非法形态回 null（HTTP 面 400）。labels 空数组放行——类型面合法，工具执行面
 *  自行降级为 dismissed 观察文案（builtin.ts ask_question executor 既有口径） */
export function parseAskAnswer(v: unknown): AskUserAnswer | null {
  if (typeof v !== 'object' || v === null) return null;
  const a = v as { type?: unknown; labels?: unknown; text?: unknown };
  if (a.type === 'dismissed') return { type: 'dismissed' };
  if (a.type === 'custom') return typeof a.text === 'string' && a.text.length > 0 ? { type: 'custom', text: a.text } : null;
  if (a.type === 'selected') {
    if (!Array.isArray(a.labels) || !a.labels.every((l) => typeof l === 'string')) return null;
    return { type: 'selected', labels: a.labels as string[] };
  }
  return null;
}
