import type { AskUserSeam, OutputStyle, SubagentSpawnInput, TodoItem } from '../types';
import * as path from 'path';
import { PerceptionEngine } from './perception';
import { ToolRegistry } from './tools';
import { builtinTools } from './tools/builtin';
import { makeWriteSnapshotSink } from './tools/write-snapshot';
import { createToolOutputArchive } from './tools/output-archive';
import { AgentRegistry, SubagentRunner, makeSpawnTool } from './subagent';
import { makeTaskStopTool } from './tools/task-stop';
import { makeTaskWaitTool } from './tools/task-wait';
import { makeTaskBoardTools } from './tools/taskboard-tools';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { ProcessSandbox } from './security/sandbox';
import { PermissionMode } from './security/modes';
import { SessionEvent } from '../types';
import { SafetyChain } from './security/chain';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { ModelAdapter, StubAdapter } from '../model/adapter';
import { Reactor } from './reactor';
import { SkillsFacade, createSkillsFacade } from './skills';
import { TaskRegistry } from './tasks';
import { TaskBoard } from '../taskboard/board';
import { TeamStore } from '../taskboard/store';
import { TeamRegistry, Teammate } from '../taskboard/teammate';
import { deriveTeammateRegistry } from '../taskboard/teammate-tools';
import { makeSendMessageTool } from '../taskboard/message-tools';
import { FileInbox } from '../taskboard/file-inbox';
import { ExternalCliExecutor } from '../taskboard/executors/external-cli';
import { fail, ok, Result } from '../result';
import { MemoryPipeline } from './memory/pipeline';
import { SteeringChannel } from './steering';
import { writeMemoryFact } from './memory/extractor';
import { guardMemoryWrite } from './memory/writer';
import type { SettlePayload } from './reactor';
import { resolveDataDir } from '../config/data-dir';
import { userConfigDir } from '../config/env';
import { resolveMemoryConfig } from '../config/memory-config';
import { teamTokenCapEnv } from '../config/termination-config';
import { RunLedger } from './ledger';
import { loadMcpServers } from '../config';
import { loadPermissions } from '../config/permissions';
import * as fs from 'fs';
import { McpHost } from './mcp/client';
import type { KnowledgeBase } from './knowledge';

/** headless 缺省问询接缝：无交互面即视为用户跳过（观察回 dismissal，任务不因问询挂死——AskQuestion 线 D7） */
const headlessAskStub: AskUserSeam = async () => ({ type: 'dismissed' });

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
  /** todo_write 接缝（todo_write 规格 D6）：TUI 注入会话实接（setTodos）；缺省 no-op——CLI/headless 下模型可正常维护清单（观察行进链），仅无 UI 卡 */
  todos?: { set(items: TodoItem[]): void };
  /** 输出样式分叉（交互面级，进稳定段）：交互面装配点注入（TUI=terminal）；缺省回 MARKDOWN_LINE 通用约定 */
  outputStyle?: OutputStyle;
  /** D3：CLI/TUI 显式扩目录（与 settings permissions.additionalDirs 合并，三面同源） */
  addDirs?: string[];
  /** KB 知识库实例（D18 整栈接线）：由装配根（runtime.ts buildDeps / selfcheck）经 assembleKnowledgeBase 构造注入；
   *  缺省 undefined → kb_search 维持 kb_not_configured 确定降级（「未配置」是合法确定态，非缺陷） */
  kb?: KnowledgeBase;
}

/** Harness 门面：聚合五大能力，上层只依赖此门面 */
export class Harness {
  readonly perception: PerceptionEngine;
  readonly tools: ToolRegistry;
  readonly security: SecurityGuard;
  readonly sandbox: ProcessSandbox;
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
  /** 统一后台任务账本（后台任务线规格 D1）：exec/spawn 后台任务的 ID 空间/生命周期/状态单点 */
  readonly tasks: TaskRegistry;
  /** 任务板协调器（spec 2026-10-04 §13 P1）：工作区单隐式 team main 的板面操作权威（测试/后续阶段消费） */
  readonly taskboard: TaskBoard;
  /** teammate 注册表（P2 spec §5 T3）：spawn mode:'team' / frontmatter executor:internal-team 双通道
   *  建出的长驻执行体登记处；注入 TaskBoard 派发路由（assignee 命中/留 claim）与 spawn 分流接缝 */
  readonly team: TeamRegistry;
  /** agent 间消息收件箱（P2 agent-message,T2）:<dataDir>/teams/main/inbox/<agent>.jsonl append-only 落档;
   *  主链面与 teammate 面 send_message 共用同一实例（跨面投递单一真相源;lead 收件即 lead.jsonl） */
  readonly inbox: FileInbox;
  /** per-run 成本账本（聚合本实例全部 run 的 tokens/路由决策） */
  readonly ledger: RunLedger;
  /** 后台沉淀管线（规格 §3.1）：CLI/TUI 共用，收口入队 → 空闲/收尾消化 */
  readonly pipeline: MemoryPipeline;
  /** 运行中穿插通道（对标 CC queued messages，用户→运行时方向）：会话层运行中入队，Reactor 步边界 drain 消费 */
  readonly steering: SteeringChannel;
  /** 沉淀双钩子单点（规格 §3.1/§3.5）：单发 Reactor 与 loop 内构造的 Reactor 同源透传，防两处拼装漂移 */
  readonly settleHooks: {
    settle: (r: SettlePayload) => string | undefined;
    settleMemory: (r: SettlePayload) => string | undefined;
  };
  /** MCP 装配就绪门槛（两级 mcp.json → McpHost 注册链）：loop 引擎 run 入口统一 await，单发/loop/graph 嵌套全覆盖；配置为空时零开销直通 */
  readonly mcpReady: () => Promise<void>;
  /** MCP 连接收口（stdio 子进程防悬挂事件循环）：CLI 命令收尾与 TUI dispose 调用；未连接时幂等 no-op */
  readonly mcpClose: () => Promise<void>;
  /** MCP 装配警告单（降级语义）：服务器连接/握手/重名失败只损失该服务器工具，警告收集后继续装配其余服务器 */
  readonly mcpWarnings: () => string[];

  constructor(opts: HarnessOptions) {
    const base = opts.root ?? process.cwd();
    const store = new FileStore(resolveDataDir(base));
    const ledger = new RunLedger(store);
    this.perception = new PerceptionEngine(base);
    this.tools = new ToolRegistry();
    this.sandbox = new ProcessSandbox();
    // MCP 登记制闸门构造期同步注入（两级 mcp.json，项目遮蔽全局；本地 JSON 读零 IO 延迟）：guard 在工具注册前即持名单
    const mcpServers = loadMcpServers(base);
    // 用户权限规则面（spec 5.2）：两级装载合并不遮蔽；非路径通道（Bash/mcp/web）注入 PolicyEngine，路径通道由链消费
    const perms = loadPermissions(base);
    const policy = new PolicyEngine();
    for (const rule of perms.config.deny) policy.add('deny', rule);
    for (const rule of perms.config.allow) policy.add('allow', rule);
    this.security = new SecurityGuard(policy, opts.mode ?? 'dontAsk', mcpServers.map((s) => s.name));
    this.safety = new SafetyChain(this.security, this.sandbox, base);
    this.safety.setPermissions(perms.config);
    this.safety.setAdditionalDirs([...perms.config.additionalDirs, ...(opts.addDirs ?? [])]);
    this.permissionWarningList = perms.warnings;
    // 技能门面先于工具装配创建（skill 工具经它按 id 解析正文；纯构造无副作用）
    this.skills = createSkillsFacade(base);
    // write 影子快照单点（rewind/fork 规格 §6.1）：blob 落数据目录，清单随任务收口进 user 事件
    this.writeSnapshot = makeWriteSnapshotSink(resolveDataDir(base), base);
    // 统一后台任务账本（后台任务线规格 D1）：任务日志落 <dataDir>/tasks/，账本进程内承载
    this.tasks = new TaskRegistry(resolveDataDir(base));
    // memory 接缝注入记忆写入（规格 §4.4 落点表，原第 7 参）：模型会中经既有 write 自写记忆走校验/规范化/索引/容量单点；工具清单零变化
    // kb 接缝（D18 接线，原第 3 参）：装配根构造的 KnowledgeBase 注入——缺省 undefined 时 kb_search 按既有契约降级 kb_not_configured
    // 装配接缝具名注入（D25/H6）：原 13 位置参收敛为 opts 对象，接缝错位由编译期失配兜底（webSearch 生产不注入，缺键即省）
    for (const t of builtinTools(this.safety, base, {
      kb: opts.kb,
      archive: createToolOutputArchive(() => resolveDataDir(base)),
      skills: this.skills,
      memory: guardMemoryWrite,
      memoryWrite: (input) => writeMemoryFact({ root: base, ...input }),
      ask: opts.ask ?? headlessAskStub,
      writeSnapshot: this.writeSnapshot,
      activeRoot: () => this.safety.activeRoot,
      todos: opts.todos ?? { set: () => {} },
      tasks: this.tasks,
    })) this.tools.register(t);
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
    this.steering = new SteeringChannel();
    // MCP 装配链（两级 mcp.json → McpHost）：注册链 fail-fast（连接/握手/拉取任一失败即 run 入口转确定性失败），guard 名单已构造期注入；懒连接——首次 run 前才发起，空配置零开销
    let mcpHost: McpHost | undefined;
    let mcpWarnings: string[] = [];
    this.mcpReady = async () => {
      if (mcpServers.length === 0) return;
      if (!mcpHost) {
        mcpHost = new McpHost(mcpServers, this.tools);
        try {
          const report = await mcpHost.registerTools();
          mcpWarnings = report.warnings;
        } catch (e) {
          mcpHost = undefined; // 注册链失败复位，下次 run 重试连接（失败经 run 入口转确定性 failed，不静默直通）
          throw e;
        }
      }
    };
    this.mcpClose = async () => {
      const h = mcpHost;
      mcpHost = undefined;
      if (h) await h.close();
    };
    this.mcpWarnings = () => mcpWarnings;
    this.settleHooks = {
      settle: (r: SettlePayload) => this.pipeline.enqueue({ kind: 'learned', ...r }),
      settleMemory: (r: SettlePayload) => this.pipeline.enqueue({ kind: 'memory', ...r }),
    };
    // 子代理执行单元：注册表/安全链/上下文/模型同源装配；agents 两级目录（全局 userConfigDir() + 项目 root）
    // 装配期一次性加载 fail-fast（项目遮蔽全局；运行期零增删）
    const agents = new AgentRegistry();
    agents.registerBuiltins();
    agents.loadAgents(base, userConfigDir());
    this.runner = new SubagentRunner(
      {
        registry: this.tools,
        safety: this.safety,
        context: this.context,
        model: this.model,
        root: base,
        rootProvider: () => this.safety.activeRoot,
        tasks: this.tasks,
        ledger,
        ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
        ...(opts.outputStyle ? { outputStyle: opts.outputStyle } : {}),
      },
      agents,
    );
    // TeamRegistry(P2 T3):先于 spawn 注册构造——teamAdapter 闭包经 this 引用注册表与任务板(执行期才解引用);
    // 同点注入 TaskBoard 派发路由(T2 接缝 team?:TeamRegistry)
    this.team = new TeamRegistry();
    // FileInbox 装配（P2 agent-message,T2）:teams/main/inbox 与任务板同 team 目录族;构造零 IO
    // （send 才惰性建档）,与 taskboard.init 的空板零物化纪律一致
    this.inbox = new FileInbox(path.join(resolveDataDir(base), 'teams', 'main', 'inbox'));
    // teammate 创建接缝(P2 T3):spawn 分流命中(makeSpawnTool executor)在此构造长驻 Teammate——
    // 名 = label ?? agent_id ?? 'worker';框定 = 角色行(目录注册制 agent.md)或内联 prompt 前 300 字符;
    // 工具面 = deriveTeammateRegistry 派生(剔 spawn/todo_write/ask_question/worktree/板面五件套 + 注 get_board/get_task)。
    // 重名裁定(T2 register 为替换语义,spawn 通道在其上收紧):活名重复 spawn → INVALID_ARG fail-fast
    // (模型换名/先停后建;静默替换会停掉在跑 teammate 且台账悬空);已停同名 → 替换重建(register 原语义)。
    // 台账登记:kind 'subagent' + label = teammate 名,stop 句柄接 tm.stop——task_stop 即停,日志承载启动行
    const teamAdapter = {
      spawn: (input: SubagentSpawnInput): Result<{ name: string }> => {
        const name = input.label ?? input.agent_id ?? 'worker';
        const incumbent = this.team.get(name);
        if (incumbent !== undefined && !incumbent.stopped) {
          return fail('INVALID_ARG', `teammate name already active: ${name} (stop it via task_stop or spawn with a different label)`);
        }
        let framing: string;
        if (input.agent_id !== undefined) {
          try {
            const def = agents.resolve(input.agent_id);
            framing = `Your role: ${def.name} (${def.id}); duties: ${def.framing}`;
          } catch (e) {
            return fail('INVALID_ARG', e instanceof Error ? e.message : String(e));
          }
        } else {
          framing = (input.prompt ?? '').slice(0, 300);
        }
        const tm = new Teammate({
          name,
          framing,
          deps: {
            safety: this.safety,
            model: this.model,
            registry: this.tools,
            root: base,
            store,
            board: this.taskboard,
            // 回合边界注入(T3 agent-message):worker 每轮 execute 前 drainInbox——与 send_message
            // 两面共用同一 FileInbox 实例,lead↔teammate 消息闭环单点
            inbox: this.inbox,
            ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
            registryFactory: (b: ToolRegistry) => deriveTeammateRegistry(
              b,
              this.taskboard,
              this.team,
              // teammate 面 send_message（T2 双面之二）:收件人 = lead + 其余活名（排己——不自发）,
              // from = teammate 名;事件经 onEvent 直达装配层（TUI 即时呈现/落档同轨）
              makeSendMessageTool({
                inbox: this.inbox,
                ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
                knownRecipients: () => ['lead', ...this.team.aliveNames().filter((n) => n !== name)],
                from: () => name,
              }),
            ),
          },
        });
        const registered = this.team.register(tm);
        if (!registered.ok) return registered;
        // kind 'teammate'(2026-10-06 契约收敛):长驻条目不随任务结束——task_wait(null) 排除本 kind,
        // 否则 lead 建任务后等 teammate 存活条目=600s 空等(用户实机实锤);精确等待走板任务条目 task-tN
        const ledgerTask = this.tasks.submit({ kind: 'teammate', label: name });
        ledgerTask.stop = () => tm.stop();
        this.tasks.append(ledgerTask.id, `[teammate] ${name} started — claims unassigned board tasks (give it work with create_task); stop via task_stop ${ledgerTask.id}\n`);
        tm.kick(); // 建即起 claim 循环(「claims unassigned tasks」承诺即时生效;空板自然收兵零开销)
        return ok({ name });
      },
    };
    // spawn 注册附带呈现元数据（D26/J1）：调用行动词迁自 tui/tool-verbs 旧 VERBS 表；display 为纯
    // 呈现数据（模型面 schema 只取 name/description/parameters，零影响）。工厂文件（subagent.ts 等）
    // 不在 J1 改动清单，故在注册点附加
    this.tools.register({ ...makeSpawnTool(this.runner, teamAdapter), display: { verb: 'SPAWN' } });
    // task_stop：后台任务停止工具（规格 D8），账本在场恒装配；呈现动词同上注册点附加
    this.tools.register({ ...makeTaskStopTool(this.tasks), display: { verb: 'TASK_STOP' } });
    // task_wait：后台任务等待工具（规格 docs/superpowers/specs/2026-09-26-task-wait-design.md），账本在场恒装配
    this.tools.register({ ...makeTaskWaitTool(this.tasks), display: { verb: 'TASK_WAIT' } });
    // TaskBoard(spec 2026-10-04 §13 P1):工作区单隐式 team main(Ruling 2),teams 目录走统一定位面;
    // init 只恢复不 kick;lead 工具五件套 lead-only(deriveChildRegistry 扩剔);
    // team 预算帽(T4,spec §5.6):SUNSHINEX_TEAM_TOKEN_CAP 缺省不设,装配期解析一次 fail-fast;
    // external-cli 执行体(T5):claude code stream-json 适配,board 侧 executorHint 'external-cli' 路由接管
    // (无环:executors/external-cli 只依赖 sandbox/tasks/types/executor 接口,零 board 反向引用)
    this.taskboard = new TaskBoard({
      store: new TeamStore(path.join(resolveDataDir(base), 'teams', 'main')),
      runner: this.runner,
      registry: this.tasks,
      team: this.team,
      externalExecutor: new ExternalCliExecutor({
        sandbox: this.sandbox,
        registry: this.tasks,
        ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      }),
      ...(teamTokenCapEnv() !== undefined ? { teamTokenCap: teamTokenCapEnv() } : {}),
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    });
    this.taskboard.init();
    for (const t of makeTaskBoardTools(this.taskboard)) this.tools.register(t);
    // send_message 主链面注册（T2 双面之一,随 taskboard 工具后）:lead→teammate 定向;不入
    // TASKBOARD_TOOL_NAMES（裁定:teammate 派生面也要有,lead-only 剔除表不适用——两面各注册各的注入器）;
    // lead 投递轨 = 事件即时呈现 + FileInbox 落档（Ruling 3）
    this.tools.register(makeSendMessageTool({
      inbox: this.inbox,
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      knownRecipients: () => this.team.aliveNames(),
      from: () => 'lead',
    }));
    this.reactor = new Reactor({
      registry: this.tools,
      safety: this.safety,
      context: this.context,
      model: this.model,
      root: base,
      // workDirLine 事实行随会话活动根（D19-b）：与 exec cwd / glob 锚同源（safety 单点），worktree 进出即翻转
      activeRoot: () => this.safety.activeRoot,
      ledger,
      runner: this.runner,
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.outputStyle ? { outputStyle: opts.outputStyle } : {}),
      // 运行中穿插（对标 CC queued messages）：步边界 drain 单点；未消费行由会话层收口兜底补跑
      steer: () => this.steering.drain(),
      // 沉淀双钩子零等待入队（规格 §3.1/§3.5 D2）：收口同步路径不再 await 模型调用；开关判门在管线内逐项求值
      ...this.settleHooks,
    });
    this.ledger = ledger;
  }

  private permissionWarningList: string[] = [];

  /** permissions 装载告警（spec 5.2 单级形状非法跳过）；selfcheck 上屏 */
  permissionWarnings(): string[] {
    return [...this.permissionWarningList];
  }

  /** /add-dir 运行期通道（spec 5.3）：realpath 归一后并入信任目录集 */
  addAdditionalDir(dir: string): { ok: boolean; message: string } {
    try {
      const abs = path.resolve(dir);
      if (!fs.existsSync(abs)) return { ok: false, message: abs };
      this.safety.addAdditionalDir(abs);
      return { ok: true, message: abs };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 活动根只读视图（worktree 会话；null=主工作区缺省态） */
  get activeRoot(): string | null {
    return this.safety.activeRoot;
  }
}
