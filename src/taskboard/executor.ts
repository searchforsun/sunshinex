/** Executor 接口定型(spec §4.3/Ruling 7):执行体统一契约——P1 的 drain + runSubagent 即
 *  internal-fork 执行体的非正式实现(协议面先立,P2 落 internal-team/external-cli 两个 class)。 */
import type { SessionEvent } from '../types';
import type { Inbox } from './inbox';

export interface Executor {
  capabilities(): {
    contextSource: 'fork' | 'independent';
    tools: string[];
    stopGranularity: 'turn' | 'process';
    budgetModel: 'event-precise' | 'deadline-coarse';
  };
  start(task: { id: string; spec: string; title: string }, inbox: Inbox): {
    events$: AsyncIterable<SessionEvent>;
    conclusion$: Promise<{ ok: boolean; reply: string; tokens: number }>;
    stop(): Promise<void>;
  };
}
