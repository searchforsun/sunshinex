import type { SessionEvent } from '../types';

/**
 * 粗粒度转录累积器（spec G2 Ruling 1；G3 kind 扩 §5.3 归档面）：daemon 侧从事件流直接累积的
 * 归档面快照源——user（submit 回显）/ assistant（done 终答全文）/ tool（call-result 按 callId 配对
 * 为单条）三类 + G3 扩：error（运行错误行）/ notice（提示行、委派起止单行、agent 间消息定向注记）
 * 两 kind；token 流式增量、usage/step 等过程事件不进归档面（G3 gui 走事件实时面渲染细粒度，两轨
 * 不重复）。纯件零 IO：不做 md 渲染，只拼字符串面（GUI 侧按 md 自行渲染）。
 */
export interface TranscriptEntry {
  /** 全局单调序号（入列顺序，五类共用同一序列） */
  seq: number;
  /** user 条=submit 时刻；其余条=源事件 ts */
  ts: number;
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'error';
  md: string;
}

/** 未配对 tool 条的旁挂记账（条目本体已在列表，缺面由 result/call 迟到回填） */
interface PendingTool {
  entry: TranscriptEntry;
  /** 事件载荷 callId（缺省事件无此面——配对退化为 FIFO） */
  callId?: string;
  /** 工具动词（call 事件 text；result 先到时尚未知，占位 …） */
  verb: string;
  /** result 首行（call 先到时尚未知，占位 …） */
  resultLine: string;
}

/** tool 条 md 单点：`● <verb>` + `⎿ <result 首行>` 两行；缺面以 … 占位 */
function toolMd(verb: string, resultLine: string): string {
  return `● ${verb}\n⎿ ${resultLine}`;
}

/** 归档面上限（T5δ）：与 session.ts eventBuffer 512 同构的丢最老环形形态——超限 shift 最老条 */
const TRANSCRIPT_CAP = 2000;

/** result 首行摘要：多行观察行只取首行；空文本回落 … 占位 */
function firstLine(text: string | undefined): string {
  const line = (text ?? '').split('\n')[0] ?? '';
  return line.length > 0 ? line : '…';
}

/** 委派起止单行 md（G3 §5.3）：`✻ <label> <started|status>`——label 恒取 payload.label（缺省
 *  delegationId 兜底），ended 状态面取 payload.status（done/failed/skipped/paused，缺省 ended） */
function delegationMd(e: SessionEvent): string {
  const p = e.payload as { label?: unknown; delegationId?: unknown; status?: unknown } | undefined;
  const label =
    typeof p?.label === 'string' && p.label.length > 0 ? p.label : typeof p?.delegationId === 'string' && p.delegationId.length > 0 ? p.delegationId : '…';
  const status = e.type === 'delegation-started' ? 'started' : typeof p?.status === 'string' && p.status.length > 0 ? p.status : 'ended';
  return `✻ ${label} ${status}`;
}

/**
 * 转录收集器：daemon.pump 单点喂入（与广播同源同序），GET /snapshot 的 messages 字段即
 * entries() 快照。配对语义：tool-call/tool-result 以 payload.callId 互找归并为同一条——
 * call 先到即入列（result 行占位 …），result 先到亦入列（verb 行占位 …）等迟到者回填；
 * 无 callId 的 result FIFO 兜底配最老未配对条（与 session.ts pendingCalls 同口径）；
 * 再无处可配的孤儿 result 以 payload.tool 为动词独立成条。G3 kind 扩：error/notice/
 * delegation-started|ended/agent-message → error|notice 两 kind 单行入档。其余事件
 * （token/usage/step/route/task-* 等）一律忽略（粗粒度归档面，Ruling 1）。
 */
export class TranscriptCollector {
  private readonly list: TranscriptEntry[] = [];
  private readonly pending: PendingTool[] = [];
  private nextSeq = 1;

  /** 入列单点（T5δ 上限收口）：全部条目入口（submit/seed/push 五 kind/tool 两路）统一过此——push 后
   *  超 TRANSCRIPT_CAP（2000）丢最老（与 session.ts eventBuffer 512 同构形态），每丢一条 stderr 留
   *  一行痕（collector 每 SessionRuntime 一个、无 id 面，不打会话标识）。被裁条若仍是未配对 tool 条，
   *  同步退出 pending 池——防迟到 result 回填已出档死条目、FIFO 兜底被已裁条截胡 */
  private append(entry: TranscriptEntry): void {
    this.list.push(entry);
    if (this.list.length > TRANSCRIPT_CAP) {
      const dropped = this.list.shift();
      console.error('[serve] transcript trimmed (2000 cap)');
      if (dropped !== undefined && dropped.kind === 'tool') {
        const idx = this.pending.findIndex((p) => p.entry === dropped);
        if (idx >= 0) this.pending.splice(idx, 1);
      }
    }
  }

  /** user 条目（daemon /submit 处理器调用）：`> <goal>` 引用块形态 */
  submit(goal: string): void {
    this.append({ seq: this.nextSeq++, ts: Date.now(), kind: 'user', md: `> ${goal}` });
  }

  /** attach 播种批量入列（T2）：journal msg 行映射条目按序入列。seq 由本收集器续发——入参 seq 无效
   *  （TUI msgSeq 与本收集器序列不同源，沿用会与后续事件条目撞号，G3.5 计划「负数或独立起段」裁定
   *  取续计数形态）；ts/kind/md 采信入参（md 已在映射面按五 kind 定形）。逐条过 append——播种同样
   *  受 2000 上限裁（超限丢最老，T5δ） */
  seed(entries: TranscriptEntry[]): void {
    for (const e of entries) this.append({ ...e, seq: this.nextSeq++ });
  }

  push(e: SessionEvent): void {
    if (e.type === 'done') {
      this.append({ seq: this.nextSeq++, ts: e.ts, kind: 'assistant', md: e.text ?? '' });
      return;
    }
    if (e.type === 'tool-call') {
      this.onToolCall(e);
      return;
    }
    if (e.type === 'tool-result') {
      this.onToolResult(e);
      return;
    }
    if (e.type === 'error') {
      this.append({ seq: this.nextSeq++, ts: e.ts, kind: 'error', md: e.text ?? 'error' });
      return;
    }
    if (e.type === 'notice') {
      this.append({ seq: this.nextSeq++, ts: e.ts, kind: 'notice', md: e.text ?? '' });
      return;
    }
    if (e.type === 'delegation-started' || e.type === 'delegation-ended') {
      this.append({ seq: this.nextSeq++, ts: e.ts, kind: 'notice', md: delegationMd(e) });
      return;
    }
    if (e.type === 'agent-message') {
      const p = e.payload as { from?: unknown; to?: unknown; text?: unknown } | undefined;
      const from = typeof p?.from === 'string' && p.from.length > 0 ? p.from : '?';
      const to = typeof p?.to === 'string' && p.to.length > 0 ? p.to : '?';
      this.append({ seq: this.nextSeq++, ts: e.ts, kind: 'notice', md: `[${from} → ${to}] ${typeof p?.text === 'string' ? p.text : ''}` });
      return;
    }
    // 其余事件（token/usage/step/route/task-* 等）不进归档面
  }

  /** 快照只读：返回列表浅拷贝（条目对象视为不可变——配对回填只发生在收集器内部） */
  entries(): TranscriptEntry[] {
    return [...this.list];
  }

  private onToolCall(e: SessionEvent): void {
    const callId = typeof e.payload?.callId === 'string' ? e.payload.callId : undefined;
    if (callId !== undefined) {
      const hit = this.pending.find((p) => p.callId === callId);
      if (hit !== undefined) {
        // result 先行的乱序路径：verb 回填同条（seq/ts 保持 result 到达时刻的入列位）
        hit.verb = e.text ?? '…';
        hit.entry.md = toolMd(hit.verb, hit.resultLine);
        return;
      }
    }
    const entry: TranscriptEntry = { seq: this.nextSeq++, ts: e.ts, kind: 'tool', md: '' };
    const p: PendingTool = { entry, ...(callId !== undefined ? { callId } : {}), verb: e.text ?? '…', resultLine: '…' };
    entry.md = toolMd(p.verb, p.resultLine);
    this.append(entry);
    this.pending.push(p);
  }

  private onToolResult(e: SessionEvent): void {
    const callId = typeof e.payload?.callId === 'string' ? e.payload.callId : undefined;
    const resultLine = firstLine(e.text);
    if (callId !== undefined) {
      const hit = this.pending.find((p) => p.callId === callId);
      if (hit !== undefined) {
        hit.resultLine = resultLine;
        hit.entry.md = toolMd(hit.verb, hit.resultLine);
        this.pending.splice(this.pending.indexOf(hit), 1); // 已配对：退出未配对池
        return;
      }
      // result 先到：即刻入列占位，等同 callId 的 call 回填 verb
      const entry: TranscriptEntry = { seq: this.nextSeq++, ts: e.ts, kind: 'tool', md: '' };
      const p: PendingTool = { entry, callId, verb: '…', resultLine };
      entry.md = toolMd(p.verb, p.resultLine);
      this.append(entry);
      this.pending.push(p);
      return;
    }
    // 无 callId：FIFO 兜底配最老的无 callId 未配对条（与 session.ts pendingCalls 同口径）
    const idx = this.pending.findIndex((p) => p.callId === undefined);
    if (idx >= 0) {
      const hit = this.pending[idx]!;
      hit.resultLine = resultLine;
      hit.entry.md = toolMd(hit.verb, hit.resultLine);
      this.pending.splice(idx, 1);
      return;
    }
    // 孤儿 result（无 callId 且无未配对面）：以 payload.tool 为动词独立成条
    const tool = e.payload?.tool;
    this.append({
      seq: this.nextSeq++,
      ts: e.ts,
      kind: 'tool',
      md: toolMd(typeof tool === 'string' && tool.length > 0 ? tool : '…', resultLine),
    });
  }
}
