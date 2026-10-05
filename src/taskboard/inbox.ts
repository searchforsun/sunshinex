/** Inbox 接口定型(spec §4.4/Ruling 7):agent 间消息收件箱——append-only 队列 + 消费位点(ts)。
 *  P1 只交付 MemoryInbox(单进程内存实现);文件 inbox(<teams>/inbox/<agent>.jsonl)随 P2
 *  agent-message 落地,协议(append-only + 位点 + 至少一次 + 注入幂等)两实现共用——换实现不换语义。 */
export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  ts: number;
}

export interface Inbox {
  send(to: string, msg: Omit<AgentMessage, 'id' | 'to' | 'ts'>): Promise<AgentMessage>;
  /** 取 agent 的 ts 严格大于 since 的消息(位点 = 已消费的最大 ts;至少一次投递的读侧) */
  poll(agent: string, since: number): AgentMessage[];
}

export class MemoryInbox implements Inbox {
  private messages: AgentMessage[] = [];
  private seq = 0;
  private clock = 0;

  async send(to: string, msg: Omit<AgentMessage, 'id' | 'to' | 'ts'>): Promise<AgentMessage> {
    this.seq += 1;
    this.clock = Math.max(this.clock + 1, Date.now());
    const full: AgentMessage = { id: `m${this.seq}`, to, ts: this.clock, from: msg.from, text: msg.text };
    this.messages = [...this.messages, full];
    return full;
  }

  poll(agent: string, since: number): AgentMessage[] {
    return this.messages.filter((m) => m.to === agent && m.ts > since);
  }
}
