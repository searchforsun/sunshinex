import type { AskUserSeam } from '../types';
import * as path from 'path';
import { PerceptionEngine } from './perception';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { makeWriteSnapshotSink } from './tools/write-snapshot';
import { createToolOutputArchive } from './tools/output-archive';
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
import { MemoryPipeline } from './memory/pipeline';
import { writeMemoryFact } from './memory/extractor';
import { guardMemoryWrite } from './memory/writer';
import type { SettlePayload } from './reactor';
import { resolveDataDir } from '../config/data-dir';
import { resolveMemoryConfig } from '../config/memory-config';
import { RunLedger } from './ledger';

/** headless 缺省问询接缝：无交互面即视为用户跳过（观察回 dismissal，任务不因问询挂死——AskQuestion 线 D7） */
export const headlessAskStub: AskUserSeam = async () => ({ type: 'dismissed' });

export interface HarnessOptions {
  /** 问询接缝（ask_question 消费方）：缺省 headlessAskStub——headless 下工具恒在清单且诚实告知不可达 */
  ask?: AskUserSeam;
  /** 基准根目录；缺省=process.cwd()。指定时为「项目空间模式」，缺省时为「当前目录模式」 */
  root?: string;
  model?: ModelAdapter;
  /** 权限模式，默认 dontAsk：不询问、自动批准未 deny 的操作（最大权限，供测试/受信场景） */
  mode?: PermissionMode;
  /** 事件流旁路（5A TUI/GUI 公共地基）：透传给 Reactor；缺省零副作用 */
  onEvent?: (e: SessionEvent) => void;
  /** 学习惯例沉淀开关（缺省=随控制面 SUNSHINEX_LEARNED_SKILLS）：成功任务沉淀学习技能至全局数据目录；测试/纯执行场景可关 */
  learnSkills?: boolean;
  /** 会话内持久记忆覆盖（/memory on|off 会话级开关；undefined=随控制面 SUNSHINEX_AUTO_MEMORY）：仅本会话生效、不改盘 */
  memoryOverride?: boolean;
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
  /** write 影子快照单点（rewind/fork 规格 §6.1）：write 工具落盘前捕获 pre-image，任务收口随 user 事件落盘 */
  readonly writeSnapshot: ReturnType<typeof makeWriteSnapshotSink>;
  /** 子代理执行单元（spawn 已注册进主链工具面；fork 子面一律派生剔除） */
  readonly runner: SubagentRunner;
  /** per-run 成本账本（聚合本实例全部 run 的 tokens/路由决策） */
  readonly ledger: RunLedger;
  /** 后台沉淀管线（规格 §3.1）：CLI/TUI 共用，收口入队 → 空闲/收尾消化 */
  readonly pipeline: MemoryPipeline;
  /** 运行中穿插通道（对标 CC queued messages，用户→运行时方向）：会话层运行中入队，Reactor 步边界 drain 消费 */
  /** 沉淀双钩子单点（规格 §3.1/§3.5）：单发 Reactor 与 loop 内构造的 Reactor 同源透传，防两处拼装漂移 */
  readonly settleHooks: {
    settle: (r: SettlePayload) => string | undefined;
    settleMemory: (r: SettlePayload) => string | undefined;
  };

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
    // 技能门面先于工具装配创建（skill 工具经它按 id 解析正文；纯构造无副作用）
    this.skills = createSkillsFacade(base);
    // write 影子快照单点（rewind/fork 规格 §6.1）：blob 落数据目录，清单随任务收口进 user 事件
    this.writeSnapshot = makeWriteSnapshotSink(resolveDataDir(base), base);
    // 第 7 参注入记忆写入接缝（规格 §4.4 落点表）：模型会中经既有 write 自写记忆走校验/规范化/索引/容量单点；工具清单零变化
    for (const t of builtinTools(this.safety, base, undefined, undefined, createToolOutputArchive(() => resolveDataDir(base)), this.skills, guardMemoryWrite, (input) => writeMemoryFact({ root: base, ...input }), opts.ask ?? headlessAskStub, this.writeSnapshot)) this.tools.register(t);
    this.context = new ContextManager(base, store);
    this.model = opts.model ?? new StubAdapter();
    // 后台沉淀管线（规格 §3.1/§3.5）：收口零等待入队 → 空闲/收尾消化；notify 双通道=链尾 notice 行（模型面）+ notice 事件（用户面），
    // 与 reactor announce 逐字同形；两个开关逐项消费时求值（/memory on|off 与 --learn 语义贯通）
    this.pipeline = new MemoryPipeline({
      model: this.model,
      root: base,
      notify: (source, text) => {
        this.context.appendChain([{ action: 'notice', observation: text }]);
        opts.onEvent?.({ type: 'notice', text, payload: { source, text }, ts: Date.now() });
      },
      learnedEnabled: () => opts.learnSkills ?? resolveMemoryConfig().learnedSkills,
      memoryEnabled: () => (opts.memoryOverride ?? resolveMemoryConfig().autoMemory) === true,
    });
    this.settleHooks = {
      settle: (r: SettlePayload) => this.pipeline.enqueue({ kind: 'learned', ...r }),
      settleMemory: (r: SettlePayload) => this.pipeline.enqueue({ kind: 'memory', ...r }),
    };
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
      // 运行中穿插（对标 CC queued messages）：步边界 drain 单点；未消费行由会话层收口兜底补跑
      // 沉淀双钩子零等待入队（规格 §3.1/§3.5 D2）：收口同步路径不再 await 模型调用；开关判门在管线内逐项求值
      ...this.settleHooks,
    });
    this.ledger = ledger;
  }
}
