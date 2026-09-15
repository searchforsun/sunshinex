import * as path from 'path';
import { PerceptionEngine } from './perception';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { AgentRegistry, SubagentRunner, makeSpawnTool } from './subagent';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { ProcessSandbox } from './security/sandbox';
import { PermissionMode } from './security/modes';
import { SessionEvent } from '../types';
import { DryRun } from './security/dryrun';
import { SafetyChain } from './security/chain';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { ModelAdapter, StubAdapter } from '../model/adapter';
import { Reactor } from './reactor';
import { SkillsFacade, createSkillsFacade } from './skills';
import { LearnedSkillStore } from './skills/learned';
import { resolveDataDir } from '../config/data-dir';
import { RunLedger } from './ledger';

export interface HarnessOptions {
  /** 基准根目录；缺省=process.cwd()。指定时为「项目空间模式」，缺省时为「当前目录模式」 */
  root?: string;
  model?: ModelAdapter;
  /** 权限模式，默认 dontAsk：不询问、自动批准未 deny 的操作（最大权限，供测试/受信场景） */
  mode?: PermissionMode;
  /** 事件流旁路（5A TUI/GUI 公共地基）：透传给 Reactor；缺省零副作用 */
  onEvent?: (e: SessionEvent) => void;
  /** 学习惯例沉淀开关（缺省 true）：成功任务沉淀学习技能至全局数据目录；测试/纯执行场景可关 */
  learnSkills?: boolean;
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
  /** 主模型适配器（TUI/GUI 装配 planner 等子运行时复用） */
  readonly model: ModelAdapter;
  readonly reactor: Reactor;
  readonly skills: SkillsFacade;
  /** 子代理执行单元（spawn 已注册进主链工具面；fork 子面一律派生剔除） */
  readonly runner: SubagentRunner;
  /** per-run 成本账本（聚合本实例全部 run 的 tokens/路由决策） */
  readonly ledger: RunLedger;

  constructor(opts: HarnessOptions) {
    const base = opts.root ?? process.cwd();
    const store = new FileStore(resolveDataDir(base));
    const ledger = new RunLedger(store);
    this.perception = new PerceptionEngine(base);
    this.tools = new ToolRegistry();
    this.sandbox = new ProcessSandbox();
    this.security = new SecurityGuard(new PolicyEngine(), opts.mode ?? 'dontAsk');
    this.dryrun = new DryRun();
    this.safety = new SafetyChain(this.security, this.sandbox, this.dryrun, base);
    for (const t of builtinTools(this.safety, base)) this.tools.register(t);
    this.context = new ContextManager(base, store);
    this.model = opts.model ?? new StubAdapter();
    // 子代理执行单元：注册表/安全链/上下文/模型同源装配；agents 目录装配期一次性加载 fail-fast（运行期零增删）
    const agents = new AgentRegistry();
    agents.registerBuiltins();
    agents.loadAgents(base);
    this.runner = new SubagentRunner(
      {
        registry: this.tools,
        safety: this.safety,
        context: this.context,
        model: this.model,
        root: base,
        ledger,
        ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      },
      agents,
    );
    this.tools.register(makeSpawnTool(this.runner));
    this.reactor = new Reactor({
      registry: this.tools,
      safety: this.safety,
      context: this.context,
      model: this.model,
      root: base,
      ledger,
      runner: this.runner,
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.learnSkills ?? true
        ? { settle: (r: { goal: string; reply: string }) => new LearnedSkillStore(base).settle(r.goal, r.reply) }
        : {}),
    });
    this.ledger = ledger;
    this.skills = createSkillsFacade(base);
  }
}
