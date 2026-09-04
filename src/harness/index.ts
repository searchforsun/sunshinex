import * as path from 'path';
import { PerceptionEngine } from './perception';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { ProcessSandbox } from './security/sandbox';
import { DryRun } from './security/dryrun';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { ModelAdapter, StubAdapter } from '../model/adapter';
import { Reactor } from './reactor';

export interface HarnessOptions {
  root: string;
  model?: ModelAdapter;
}

/** Harness 门面：聚合五大能力，上层只依赖此门面 */
export class Harness {
  readonly perception: PerceptionEngine;
  readonly tools: ToolRegistry;
  readonly security: SecurityGuard;
  readonly sandbox: ProcessSandbox;
  readonly dryrun: DryRun;
  readonly context: ContextManager;
  readonly reactor: Reactor;

  constructor(opts: HarnessOptions) {
    const store = new FileStore(path.join(opts.root, '.data'));
    this.perception = new PerceptionEngine(opts.root);
    this.tools = new ToolRegistry();
    this.sandbox = new ProcessSandbox();
    for (const t of builtinTools(this.sandbox)) this.tools.register(t);
    this.security = new SecurityGuard(new PolicyEngine(), 'manual');
    this.dryrun = new DryRun();
    this.context = new ContextManager(opts.root, store);
    this.reactor = new Reactor({
      registry: this.tools,
      guard: this.security,
      sandbox: this.sandbox,
      context: this.context,
      model: opts.model ?? new StubAdapter(),
    });
  }
}
