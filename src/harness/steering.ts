/**
 * 运行中穿插通道（对标 CC queued messages，用户→运行时方向、非模型工具面）。
 * 纯内存 FIFO：会话层运行中入队，Reactor 每个步边界 drain 一次消费；
 * 未投递行（run 末段入队未及步边界）经 takePending 取回补跑。
 *
 * G14.89 两档消费语义：
 * - 普通入队（front=false）：只排队——run 收束后由会话层兜底补跑为下一轮（排队=等当前轮完成）；
 * - 置首（front=true，Insert/插入发送）：Reactor 步边界 drain 即注入当前轮（不暂停轮次）。
 */
export interface SteerEntry {
  text: string;
  /** 步边界可注入标记（插入发送）；普通排队条目为 false，仅轮收束补跑 */
  front: boolean;
}

export class SteeringChannel {
  private queue: SteerEntry[] = [];

  /** 入队一条用户穿插行（空白行忽略，保持入队序；缺省仅排队——轮收束自动发下一轮） */
  enqueue(text: string): void {
    const t = text.trim();
    if (t) this.queue.push({ text: t, front: false });
  }

  /** 步边界 drain：仅取走置首（插入发送）条目——普通排队条目留待轮收束补跑 */
  drain(): string[] {
    const out: string[] = [];
    this.queue = this.queue.filter((e) => {
      if (e.front) {
        out.push(e.text);
        return false;
      }
      return true;
    });
    return out;
  }

  /** 取走全部未投递行（任务收口兜底补跑与用户撤回取回共用） */
  takePending(): string[] {
    const out = this.queue.map((e) => e.text);
    this.queue = [];
    return out;
  }

  /** 待投递行数（输入框上方队列展示用） */
  pending(): number {
    return this.queue.length;
  }

  /** 待投递行快照（G10 队列 chips 展示用；非破坏拷贝） */
  pendingItems(): string[] {
    return this.queue.map((e) => e.text);
  }

  /** 按下标撤回一条待投递行（G10 队列 chips 撤回钮；index 为 pendingItems() 下标，越界 false） */
  removeAt(index: number): boolean {
    if (index < 0 || index >= this.queue.length) return false;
    this.queue.splice(index, 1);
    return true;
  }

  /** G14.83 队列重排：from → to（下标越界按边界夹紧）——排队条目拖拽排序 */
  move(from: number, to: number): boolean {
    if (from < 0 || from >= this.queue.length) return false;
    const t = Math.max(0, Math.min(to, this.queue.length - 1));
    const [item] = this.queue.splice(from, 1);
    this.queue.splice(t, 0, item);
    return true;
  }

  /** G14.83/G14.89 置首并标记步边界可注入（插入发送 = 不等轮次完成，下一步立即注入当前轮） */
  moveToFront(index: number): boolean {
    if (!this.move(index, 0)) return false;
    this.queue[0] = { text: this.queue[0].text, front: true };
    return true;
  }
}
