import * as path from 'path';
import { PerceptionEngine } from './perception';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { ProcessSandbox } from './security/sandbox';
import { PermissionMode } from './security/modes';
import { DryRun } from './security/dryrun';
import { SafetyChain } from './security/chain';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { ModelAdapter, StubAdapter } from '../model/adapter';
import { Reactor } from './reactor';

export interface HarnessOptions {
  /** 基准根目录；缺省=process.cwd()。指定时为「项目空间模式」，缺省时为「当前目录模式」 */
  root?: string;
  model?: ModelAdapter;
  /** 权限模式，默认 dontAsk：不询问、自动批准未 deny 的操作（最大权限，供测试/受信场景） */
  mode?: PermissionMode;
}

/** Harness 门面：聚合五大能力，上层只依赖此门面 */
export class Harness {
  readonly perception: PerceptionEngine;
  readonly tools: ToolRegistry;
  readonly security: SecurityGuard;
  readonly sandbox: ProcessSandbox;
  readonly dryrun: DryRun;
  readonly safety: SafetyChain;
  readonly context: ContextManager;
  readonly reactor: Reactor;

  constructor(opts: HarnessOptions) {
    const base = opts.root ?? process.cwd();
    const store = new FileStore(path.join(base, '.data'));
    this.perception = new PerceptionEngine(base);
    this.tools = new ToolRegistry();
    this.sandbox = new ProcessSandbox();
    this.security = new SecurityGuard(new PolicyEngine(), opts.mode ?? 'dontAsk');
    this.dryrun = new DryRun();
    this.safety = new SafetyChain(this.security, this.sandbox, this.dryrun, base);
    for (const t of builtinTools(this.safety, base)) this.tools.register(t);
    this.context = new ContextManager(base, store);
    this.reactor = new Reactor({
      registry: this.tools,
      safety: this.safety,
      context: this.context,
      model: opts.model ?? new StubAdapter(),
    });
  }
}
