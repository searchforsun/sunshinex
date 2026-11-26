// 跨 Sunx 对等消息宿主实现（2026-11-26 用户裁定「两个工具实现 sunx 之间的聊天」；「只投活实例」）：
// 活实例=daemon 会话表里 attachedJournalId 命中的运行时（未在座=不可达，不 attach——裁定只投活实例）。
// 枚举数据源=域容器（sunxContainerDir/<jid>/data listSessions + 旁车 meta 的 charterText/root/活动），
// 与 GET /sunx/sessions 同底座；行内容原样（名称/品性零翻译——用户裁定「内容是什么就是什么」）。
// 投递=对方视角的**用户消息**语义（用户气泡直接入队）：idle→submitExternal（回显帧+起轮），
// running→steer（排队，轮收束补跑）；来源归因 fromSunx 由本层按 caller 会话补全（工具壳不持身份）。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sunxContainerDir } from '../config/data-dir';
import { listSessions, readSessionMeta } from '../session/journal';
import type { SunxPeerInfo, SunxPeerSendResult } from '../harness/tools/sunx-peer-tools';
import type { SunxPeerRef } from '../types';

/** 会话表最小结构面（daemon Map 直引用；测试注入轻量桩） */
export interface PeersSessionLike {
  readonly attachedJournalId: string | undefined;
  readonly sessionKind: string | undefined;
  readonly sunxName: string | undefined;
  readonly root: string;
  /** 域目录外窥（SessionRuntime.dataDir 同形）——旁车 meta 读面（名称/品行归因）寻址 */
  readonly dataDir: string;
  status(): string;
  /** 在飞轮次锚（kernel run 条目 seq；空闲=-1——随归因下行,GUI 点击归因行据此定位发送轮） */
  openRunSeq(): number;
  pendingSnapshot(): ReadonlyArray<unknown>;
  submitExternal(text: string, images?: string[], fromSunx?: SunxPeerRef): { ok: boolean; status?: number };
  steer(text: string, images?: string[], fromSunx?: SunxPeerRef): void;
}

/** journal → 活运行时（同 journal 多座=取首个在座——daemon 单写者纪律下正常只有一座） */
function liveByJournal(sessions: ReadonlyMap<string, PeersSessionLike>): Map<string, PeersSessionLike> {
  const m = new Map<string, PeersSessionLike>();
  for (const s of sessions.values()) {
    const jid = s.attachedJournalId;
    if (jid !== undefined && jid !== '' && !m.has(jid)) m.set(jid, s);
  }
  return m;
}

/** 会话显示名（创建名优先；重启重开壳 sessionName 由 meta.title 铸，同源） */
function displayName(s: PeersSessionLike | undefined, dataDir: string | undefined, jid: string | undefined): string {
  if (s?.sunxName !== undefined && s.sunxName !== '') return s.sunxName;
  if (dataDir !== undefined && jid !== undefined) {
    const t = readSessionMeta(dataDir, jid).title;
    if (t !== undefined && t !== '') return t;
  }
  return 'Sunx';
}

/** caller 会话归因：journalId 未铸（首轮前）时该会话还发不出对等消息——返回 undefined 即拒绝。
 *  runSeq=此刻在飞轮次锚（发送动作所在轮次——接收方点击归因行定位到该轮） */
function callerRef(sessions: ReadonlyMap<string, PeersSessionLike>, callerId: string): SunxPeerRef | undefined {
  const s = sessions.get(callerId);
  const jid = s?.attachedJournalId;
  if (s === undefined || jid === undefined || jid === '') return undefined;
  const runSeq = s.openRunSeq();
  return { id: jid, name: displayName(s, s.dataDir, jid), ...(runSeq > 0 ? { runSeq } : {}) };
}

/**
 * 实例枚举（排己；归档不列）：域容器逐域 listSessions（行形=id/title/firstUser/updatedAt/archived/
 * root/runs/steps）+ 旁车 charterText。**存在即列**——GUI SUNX 分组可见面=未归档存在实例面，枚举
 * 与之同口径（2026-11-26 用户裁定「gui侧肯定都是活的」）；在座与否只作状态标注（running/idle/
 * not open），未在座实例投递时自动 attach（见 deliver 的 ensureLive 缝）——不再以「有运行时」为列/投条件。
 */
export function listSunxPeers(sessions: ReadonlyMap<string, PeersSessionLike>, callerId: string): SunxPeerInfo[] {
  const caller = sessions.get(callerId);
  const callerJournal = caller?.attachedJournalId;
  const live = liveByJournal(sessions);
  const out: SunxPeerInfo[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sunxContainerDir(), { withFileTypes: true });
  } catch {
    return out; // 容器不存在=空列合法空态
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dataDir = path.join(sunxContainerDir(), ent.name, 'data');
    for (const r of listSessions(dataDir)) {
      if (r.archived === true) continue; // 归档实例不列（同分组口径）
      if (r.id === callerJournal) continue; // 排己
      const rt = live.get(r.id);
      const meta = readSessionMeta(dataDir, r.id);
      const name = r.title ?? meta.title ?? r.firstUser ?? 'Sunx';
      const charter = meta.charterText ?? undefined;
      out.push({
        id: r.id,
        name,
        running: rt !== undefined && rt.status() !== 'idle',
        live: rt !== undefined,
        awaiting: rt !== undefined && rt.pendingSnapshot().length > 0,
        root: r.root ?? meta.root ?? '',
        updatedAt: r.updatedAt,
        ...(r.runs !== undefined ? { runs: r.runs } : {}),
        ...(r.steps !== undefined ? { steps: r.steps } : {}),
        ...(charter !== undefined && charter !== '' ? { charter } : {}),
      });
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/** 投递（只投活实例；归因按 caller 会话补全后随 submit/steer 落链）：
 *  - 目标非活/未知 → ok:false（错误原样进工具面）
 *  - 目标=自己 → 拒
 *  - 注入 md = 来源前缀 + 正文 + 回答提示行（2026-11-26 用户二轮裁定「提示添加到这里」：
 *    回答提示随消息正文进模型面，不再只靠工具描述；提示行恒英文——进模型上下文的文案恒英文
 *    单语，2026-09-18 prompt-english-only；GUI 显示侧前缀与提示行同剥，用户只看到正文） */
export function deliverSunxPeerMessage(
  sessions: ReadonlyMap<string, PeersSessionLike>,
  callerId: string,
  to: string,
  text: string,
  /** 在座化缝（daemon 注入 attachSunxIn 薄委托）：目标存在但未打开→attach 后投递（与点侧栏行同链）。
   *  缺席（测试/CLI）=未在座即拒 */
  opts?: { ensureLive?: (journalId: string) => boolean },
): SunxPeerSendResult {
  const from = callerRef(sessions, callerId);
  if (from === undefined) return { ok: false, error: 'caller session has no journal yet - cannot send_sunx_messages before your first run' };
  if (to === from.id) return { ok: false, error: 'cannot send_sunx_messages to yourself' };
  let target = liveByJournal(sessions).get(to);
  if (target === undefined) {
    // 存在但未打开（GUI 分组可见面）：attach 开座后投递（与侧栏行点击同一重开链）
    if (opts?.ensureLive !== undefined && opts.ensureLive(to)) target = liveByJournal(sessions).get(to);
    if (target === undefined) {
      return { ok: false, error: `cannot send_sunx_messages to ${to}: unknown or not openable Sunx instance (see list_sunx_peers)` };
    }
  }
  if (target.sessionKind !== 'sunx') {
    return { ok: false, error: `cannot send_sunx_messages to ${to}: not a Sunx session` };
  }
  const name = displayName(target, target.dataDir, to);
  const body = `[fromSunx: ${from.name} (${from.id})] ${text}\n\n(From another Sunx, not from the user. Reply to that Sunx with send_sunx_messages, to="${from.id}".)`;
  if (target.status() === 'idle') {
    const r = target.submitExternal(body, undefined, from);
    if (r.ok) return { ok: true, name, queued: false };
    // 受理竞态（idle→running 间隙）：回退入队（channels router 409 回退 steer 同口径）
    if (r.status === 409) {
      target.steer(body, undefined, from);
      return { ok: true, name, queued: true };
    }
    return { ok: false, error: `cannot deliver to ${name}: submit rejected` };
  }
  target.steer(body, undefined, from);
  return { ok: true, name, queued: true };
}
