/**
 * 运行中穿插通道（对标 CC queued messages，用户→运行时方向、非模型工具面）。
 * 纯内存 FIFO：会话层运行中入队，Reactor 每个步边界 drain 一次消费；
 * 未投递行（run 末段入队未及步边界）经 takePending 取回补跑。
 */
export class SteeringChannel {
  private queue: string[] = [];

  /** 入队一条用户穿插行（空白行忽略，保持入队序） */
  enqueue(text: string): void {
    const t = text.trim();
    if (t) this.queue.push(t);
  }

  /** 步边界 drain：取走即消费 */
  drain(): string[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  /** 取走全部未投递行（任务收口兜底补跑与用户撤回取回共用） */
  takePending(): string[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  /** 待投递行数（输入框上方队列展示用） */
  pending(): number {
    return this.queue.length;
  }

  /** 待投递行快照（G10 队列 chips 展示用；非破坏拷贝） */
  pendingItems(): string[] {
    return [...this.queue];
  }

  /** 按下标撤回一条待投递行（G10 队列 chips 撤回钮；index 为 pendingItems() 下标，越界 false） */
  removeAt(index: number): boolean {
    if (index < 0 || index >= this.queue.length) return false;
    this.queue.splice(index, 1);
    return true;
  }
}
