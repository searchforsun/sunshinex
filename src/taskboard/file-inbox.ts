import * as fs from 'fs';
import * as path from 'path';
import { AgentMessage, Inbox } from './inbox';

/** agent 间消息的文件收件箱(spec §4.4/Ruling 7;P2 agent-message):<inboxDir>/<agent>.jsonl
 *  append-only 单行原子落盘(§7.2 event sourcing 同款纪律,TeamStore 先例);poll = 全量重放 + 过滤
 *  (to 匹配 + ts 严格大于),损坏行(无换行截断/非法 JSON/缺字段)跳过不卡收件箱(§7.3「单条脏数据
 *  卡死收件箱」教训的结构性回避,TeamStore.load 同款)。
 *  id 唯一性跨重启:构造后首次对某 agent send 时懒重放其文件,seq = 现有最大 id 序号、clock = 现有
 *  最大 ts——ts = max(clock+1, Date.now()) 严格单调(MemoryInbox 同款语义,换实现不换语义)。
 *  目录惰性建档:send 才 mkdir,poll 只读不建。 */
export class FileInbox implements Inbox {
  private dirMade = false;
  /** 每 agent 一份(id seq + ts clock);未 send 过的 agent 无条目 = 未重放初始化 */
  private readonly stateByAgent = new Map<string, { seq: number; clock: number }>();

  constructor(private readonly inboxDir: string) {}

  private fileFor(agent: string): string {
    return path.join(this.inboxDir, `${agent}.jsonl`);
  }

  private ensureDir(): void {
    if (this.dirMade) return;
    fs.mkdirSync(this.inboxDir, { recursive: true });
    this.dirMade = true;
  }

  /** 逐行重放该 agent 的文件:文件缺失(ENOENT)= 空收件箱;损坏行跳过,其余读错误上抛不吞 */
  private readMessages(file: string): AgentMessage[] {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: AgentMessage[] = [];
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      try {
        const m = JSON.parse(line) as Partial<AgentMessage>;
        if (
          typeof m.id === 'string' && typeof m.from === 'string' && typeof m.to === 'string' &&
          typeof m.text === 'string' && typeof m.ts === 'number'
        ) {
          out.push(m as AgentMessage);
        }
      } catch {
        // 崩溃截断行/非法 JSON:跳过该行
      }
    }
    return out;
  }

  async send(to: string, msg: Omit<AgentMessage, 'id' | 'to' | 'ts'>): Promise<AgentMessage> {
    this.ensureDir();
    let st = this.stateByAgent.get(to);
    if (st === undefined) {
      // 懒初始化:重放现有文件恢复 seq(最大 id 序号,跨重启不撞 id)与 clock(最大 ts,ts 跨实例严格单调)
      st = { seq: 0, clock: 0 };
      for (const m of this.readMessages(this.fileFor(to))) {
        const match = /^m(\d+)$/.exec(m.id);
        if (match) st.seq = Math.max(st.seq, Number(match[1]));
        st.clock = Math.max(st.clock, m.ts);
      }
      this.stateByAgent.set(to, st);
    }
    st.seq += 1;
    st.clock = Math.max(st.clock + 1, Date.now());
    const full: AgentMessage = { id: `m${st.seq}`, to, ts: st.clock, from: msg.from, text: msg.text };
    fs.appendFileSync(this.fileFor(to), JSON.stringify(full) + '\n', 'utf8');
    return full;
  }

  poll(agent: string, since: number): AgentMessage[] {
    return this.readMessages(this.fileFor(agent)).filter((m) => m.to === agent && m.ts > since);
  }
}
