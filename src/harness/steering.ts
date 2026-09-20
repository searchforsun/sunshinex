/**
 * 运行中穿插通道（对标 CC queued messages，用户→运行时方向、非模型工具面）。
 * 纯内存 FIFO：会话层运行中入队，Reactor 每个步边界 drain 一次消费；
 * 计数口径服务于收口兜底判定——已投递行已随步尾追进链（收口不补跑），未投递行经 takePending 取回补跑。
 */
export class SteeringChannel {
  private queue: string[] = [];
  private deliveredCount = 0;

  /** 入队一条用户穿插行（空白行忽略，保持入队序） */
  enqueue(text: string): void {
    const t = text.trim();
    if (t) this.queue.push(t);
  }

  /** 步边界 drain：取走即消费，逐行计入投递数 */
  drain(): string[] {
    const out = this.queue;
    this.queue = [];
    this.deliveredCount += out.length;
    return out;
  }

  /** 取走全部未投递行（任务收口兜底补跑与用户撤回取回共用）：不动投递计数 */
  takePending(): string[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  /** 待投递行数（输入框上方队列展示用） */
  pending(): number {
    return this.queue.length;
  }

  /** 本通道累计已投递行数：>0 表示已有穿插同轮生效 */
  delivered(): number {
    return this.deliveredCount;
  }
}
