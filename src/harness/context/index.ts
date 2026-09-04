import { StorageAdapter } from '../../storage/adapter';
import { ContextItem } from '../../types';
import { ContextLoader } from './loader';
import { RulesRegistry } from './rules';
import { MemoryLifecycle } from './memory-lifecycle';
import { ContextWindow } from './window';
import { SessionStore } from './session';

/** 上下文与记忆管理门面 */
export class ContextManager {
  readonly loader: ContextLoader;
  readonly rules: RulesRegistry;
  readonly memory: MemoryLifecycle;
  readonly window: ContextWindow;
  readonly session: SessionStore;

  constructor(root: string, store: StorageAdapter) {
    this.loader = new ContextLoader(root);
    this.rules = new RulesRegistry(root);
    this.memory = new MemoryLifecycle(store);
    this.window = new ContextWindow();
    this.session = new SessionStore(store);
  }

  /** 统一装配上下文：loader 分层指令 → rules 路径规则 → memory 记忆 → goal → history */
  assemble(goal: string, history: ContextItem[] = [], relPath?: string): ContextItem[] {
    const items: ContextItem[] = [];
    items.push(...this.loader.load());
    if (relPath) items.push(...this.rules.forPath(relPath));
    const mem = this.memory.index();
    if (mem.length > 0) items.push({ kind: 'memory', content: mem.join('\n') });
    items.push({ kind: 'instruction', content: goal });
    items.push(...history);
    return items;
  }
}
