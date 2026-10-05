import type { SessionEvent } from '../types';

/**
 * 粗粒度转录累积器（spec G2 Ruling 1）：daemon 侧从事件流直接累积的归档面快照源——
 * user（submit 回显）/ assistant（done 终答全文）/ tool（call-result 按 callId 配对为单条）三类；
 * token 流式增量、usage/step 等过程事件不进归档面（G3 gui 走事件实时面渲染细粒度，两轨不重复）。
 * 纯件零 IO：不做 md 渲染，只拼字符串面（GUI 侧按 md 自行渲染）。
 */
export interface TranscriptEntry {
  /** 全局单调序号（入列顺序，三类共用同一序列） */
  seq: number;
  /** user 条=submit 时刻；assistant/tool 条=源事件 ts */
  ts: number;
  kind: 'user' | 'assistant' | 'tool';
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

/** result 首行摘要：多行观察行只取首行；空文本回落 … 占位 */
function firstLine(text: string | undefined): string {
  const line = (text ?? '').split('\n')[0] ?? '';
  return line.length > 0 ? line : '…';
}

/**
 * 转录收集器：daemon.pump 单点喂入（与广播同源同序），GET /snapshot 的 messages 字段即
 * entries() 快照。配对语义：tool-call/tool-result 以 payload.callId 互找归并为同一条——
 * call 先到即入列（result 行占位 …），result 先到亦入列（verb 行占位 …）等迟到者回填；
 * 无 callId 的 result FIFO 兜底配最老未配对条（与 session.ts pendingCalls 同口径）；
 * 再无处可配的孤儿 result 以 payload.tool 为动词独立成条。非 done/tool-call/tool-result
 * 事件一律忽略（粗粒度归档面，Ruling 1）。
 */
export class TranscriptCollector {
  private readonly list: TranscriptEntry[] = [];
  private readonly pending: PendingTool[] = [];
  private nextSeq = 1;

  /** user 条目（daemon /submit 处理器调用）：`> <goal>` 引用块形态 */
  submit(goal: string): void {
    this.list.push({ seq: this.nextSeq++, ts: Date.now(), kind: 'user', md: `> ${goal}` });
  }

  push(e: SessionEvent): void {
    if (e.type === 'done') {
      this.list.push({ seq: this.nextSeq++, ts: e.ts, kind: 'assistant', md: e.text ?? '' });
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
    // 其余事件（token/usage/step/route/delegation-*/task-* 等）不进归档面
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
    this.list.push(entry);
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
      this.list.push(entry);
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
    this.list.push({
      seq: this.nextSeq++,
      ts: e.ts,
      kind: 'tool',
      md: toolMd(typeof tool === 'string' && tool.length > 0 ? tool : '…', resultLine),
    });
  }
}
