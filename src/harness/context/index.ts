import { StorageAdapter } from '../../storage/adapter';
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
}
