import type { AskUserSeam, OutputStyle, SteerLine, SubagentSpawnInput, TodoItem } from '../types';
import * as path from 'path';
import { PerceptionEngine } from './perception';
import { CodedToolError, ToolRegistry, jsonAbsent } from './tools';
import { builtinTools } from './tools/builtin';
import { createReadGuard, type ReadGuard } from './tools/read-guard';
import { makeWriteSnapshotSink } from './tools/write-snapshot';
import { createToolOutputArchive } from './tools/output-archive';
import { AgentRegistry, SubagentRunner, makeSpawnTool } from './subagent';
import { makeAgentTeamTaskStopTool, makeTaskStopTool } from './tools/task-stop';
import { makeAgentTeamTaskWaitTool, makeTaskWaitTool } from './tools/task-wait';
import { makeTaskBoardTools } from './tools/taskboard-tools';
import { SecurityGuard } from './security/guard';
import { PolicyEngine } from './security/policy';
import { ProcessSandbox } from './security/sandbox';
import { PermissionMode } from './security/modes';
import { SessionEvent } from '../types';
import { SafetyChain } from './security/chain';
import { Reactor } from './reactor';
import { stableSegmentOf } from './prompts/shared';
import { ContextManager } from './context';
import { FileStore } from '../storage/adapter';
import { ModelAdapter, StubAdapter } from '../model/adapter';
import { SkillsFacade, createSkillsFacade } from './skills';
import { TaskRegistry } from './tasks';
import { TaskBoard } from '../taskboard/board';
import { AgentTeamRegistryStore, MemoryTeamStore, TeamStore, TeammateRosterStore, type TeammateRosterRecord } from '../taskboard/store';
import { AgentTeamRegistry, MemoryAgentTeamStore } from '../taskboard/team-registry';
import { TeamRegistry, Teammate, teammateSendTargets } from '../taskboard/teammate';
import { InboxCursorStore } from '../taskboard/inbox-cursors';
import { deriveTeammateRegistry } from '../taskboard/teammate-tools';
import { makeSendMessageTool } from '../taskboard/message-tools';
import { FileInbox } from '../taskboard/file-inbox';
import { ExternalCliExecutor } from '../taskboard/executors/external-cli';
import { fail, ok, Result } from '../result';
import { MemoryPipeline } from './memory/pipeline';
import { writeMemoryFact } from './memory/extractor';
import { guardMemoryWrite } from './memory/writer';
import type { SettlePayload } from './reactor';
import { resolveDataDir, sessionTeamsRoot } from '../config/data-dir';
import { userConfigDir } from '../config/env';
import { resolveMemoryConfig } from '../config/memory-config';
import { teamTokenCapEnv } from '../config/termination-config';
import { DEFAULT_IMAGE_HISTORY_LIMIT } from '../config/image-history';
import { RunLedger } from './ledger';
import { loadMcpServers } from '../config';
import { pluginMcpServers } from '../config/plugins';
import { loadPermissions } from '../config/permissions';
import { resolveImageHistoryLimit } from '../config/image-history';
import { agentTeamsEnabled } from '../config/agent-teams';
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
  /** 权限模式，默认 full-access（原 dontAsk,2026-10-24 档改名）：不询问、自动批准未 deny 的操作（最大权限，供测试/受信场景） */
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
  /** 会话团队根键（journalId）。缺省未绑定时团队/板/inbox 驻内存；daemon/TUI 在 journal 铸造后
   *  经 adoptSessionTeams 收养。测试可直接传入以落盘。 */
  teamsSessionId?: string;
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
  /** 单发执行缝（D5 裁定的测试/工具面残留):生产主链唯一入口=KernelRuntime.runTask→Loop 模板
   *  (P7 形态钉锁死——生产源码零 `.reactor.run` 直跑);本实例仅供 harness 级测试驱动执行器,
   *  与 loop 内构造的 Reactor 同源接线(settleHooks/steer/ledger)不漂移 */
  readonly reactor: Reactor;
  /** 稳定段 outputStyle 装配口径（P7,构造期缓存——run 级常量） */
  private readonly stableOutputStyle?: OutputStyle;
  readonly skills: SkillsFacade;
  /** write 影子快照单点（rewind/fork 规格 §6.1）：write 工具落盘前捕获 pre-image，任务收口随 user 事件落盘 */
  readonly writeSnapshot: ReturnType<typeof makeWriteSnapshotSink>;
  /** 子智能体执行单元（spawn 已注册进主链工具面；fork 子面一律派生剔除） */
  readonly runner: SubagentRunner;
  /** 统一后台任务账本（后台任务线规格 D1）：exec/spawn 后台任务的 ID 空间/生命周期/状态单点 */
  readonly tasks: TaskRegistry;
  /** edit 先读守卫（read-guard.ts）：read 记录快照 / edit 校验，NOT_READ·STALE_READ 硬闸 */
  readonly readGuard: ReadGuard;
  /** 智能体团队板协调器：会话内单物理板，任务按 teamId 聚合；成员认领/消息仅队内 */
  readonly taskboard: TaskBoard;
  /** AgentTeam 注册表：create_agent_team / create_agent_teammate / create_agent_team_task 共用同一实例（按会话落盘） */
  readonly agentTeams: AgentTeamRegistry;
  /** teammate 注册表（P2 spec §5 T3;2026-10-20 起 create_agent_teammate 独立动词创建）
   *  建出的长驻执行体登记处；注入 TaskBoard 派发路由（assignee 命中/留 claim）与 spawn 分流接缝 */
  readonly team: TeamRegistry;
  /** agent 间消息收件箱：会话 teams 根下 main/inbox/<agent>.jsonl；主链与 teammate 面共用 */
  readonly inbox: FileInbox;
  /** 成员 inbox 消费位点（与 inbox 同会话根；adoptSessionTeams 同批切换） */
  private readonly inboxCursors: InboxCursorStore;
  /** 工作区数据根（adoptSessionTeams 拼会话 teams 路径） */
  private readonly dataDir: string;
  /** 已绑定的会话团队键；同键重复收养幂等 */
  private teamsBoundJournalId: string | undefined;
  /** 未落盘前的内存板（adopt 时若盘空则回流事件） */
  private memoryBoardStore: MemoryTeamStore | undefined;
  /** 未绑 journal 时的成员名册（首绑回流）；绑后改写 TeammateRosterStore */
  private memoryRoster: TeammateRosterRecord[] = [];
  /** 会话成员名册落盘（teammates.json）；未绑时 undefined */
  private rosterStore: TeammateRosterStore | undefined;
  /** 成员重建工厂（adopt 读盘复原；与 create_agent_teammate 同构造路径） */
  private restoreTeammate: ((rec: TeammateRosterRecord) => Result<{ name: string }>) | undefined;
  /** per-run 成本账本（聚合本实例全部 run 的 tokens/路由决策） */
  readonly ledger: RunLedger;
  /** 后台沉淀管线（规格 §3.1）：CLI/TUI 共用，收口入队 → 空闲/收尾消化 */
  readonly pipeline: MemoryPipeline;
  /** 步边界穿插源(P5 内核化,spec §12):等待队列态归会话内核(SteeringChannel 退役),会话层装配时
   *  挂入取走口(缺省空——不挂即无穿插);Reactor 步边界经此取走置首条目(text+随行 images)注入当前轮 */
  steerSource: () => SteerLine[] = () => [];
  /** 浏览器会话身份(serve 会话挂载):key=浏览器状态键(journalId),seat=GUI 页签座位(运行时 id)。
   *  缺省(TUI/测试)由浏览器插件装配回落进程级随机键 */
  browserSession: (() => { key: string; seat: string }) | undefined = undefined;
  /** 沉淀双钩子单点（规格 §3.1/§3.5）：单发 Reactor 与 loop 内构造的 Reactor 同源透传，防两处拼装漂移 */
  readonly settleHooks: {
    settle: (r: SettlePayload) => string | undefined;
    settleMemory: (r: SettlePayload) => string | undefined;
  };
  /** MCP 装配就绪门槛（两级 mcp.json → McpHost 注册链）：loop 引擎 run 入口统一 await，单发/loop/graph 嵌套全覆盖。
   *  每次调用重读两级 mcp.json 比对装配基线（2026-10-30 用户裁定「MCP 生效时下次执行追加新工具描述」）——
   *  配置变更即整链重注册（旧 host close 撤牌 → 新 host 注册，guard 名单/safety 表同步对齐），返回应尾追
   *  进链的漂移说明行（added/removed 工具面 diff；引擎按 notice 行落链，本轮 wire 即携带）；未变更零开销直通。
   *  注册链 fail-fast（连接/握手/拉取任一失败即 run 入口转确定性失败），配置为空时零开销直通 */
  readonly mcpReady: () => Promise<string[]>;
  /** MCP 连接收口（stdio 子进程防悬挂事件循环）：CLI 命令收尾与 TUI dispose 调用；未连接时幂等 no-op */
  readonly mcpClose: () => Promise<void>;
  /** MCP 装配警告单（降级语义）：服务器连接/握手/重名失败只损失该服务器工具，警告收集后继续装配其余服务器。
   *  全量口径（TUI 上屏/selfcheck 报表消费） */
  readonly mcpWarnings: () => string[];
  /** 警告单链面一次化（D59）：持续失败 server 的同文案只返回一次——每轮 run 重建失败警告单刷新为同内容,
   *  链面每轮 append 即 O(runs) 刷屏（engine 置 notice 行）；恢复（内容收缩）即摘其上报记录——
   *  「恢复后再失败」是状态变更须重新尾追。展示面走 mcpWarnings 全量 */
  readonly mcpWarningsOnce: () => string[];

  constructor(opts: HarnessOptions) {
    const base = opts.root ?? process.cwd();
    const store = new FileStore(resolveDataDir(base));
    const ledger = new RunLedger(store);
    this.perception = new PerceptionEngine(base);
    this.tools = new ToolRegistry();
    this.sandbox = new ProcessSandbox();
    // MCP 登记制闸门构造期同步注入（两级 mcp.json ∪ 插件贡献，一次合成避免双算——userServerNames 传用户名单名集合，
    // 插件同名 server 被用户遮蔽）：guard 在工具注册前即持名单。
    // enabled=false 整机停用（2026-10-26）：guard 名单与装配面同跳过——停用服务器的工具既不注册也不放行
    // （插件贡献 server 无 enabled 键，不受此滤影响；停用走 settings plugins.<id>.enabled 整插件面）
    const userServers = loadMcpServers(base);
    // safety 声明合成（Task 9 接线）：pluginMcp.safety（server 名 → act/confirm/observe 三类声明，仅启用且平台
    // 可用插件、未声明 server 不落键）注入 guard 问线驱动面
    const pluginMcp = pluginMcpServers(base, { userServerNames: new Set(userServers.map((s) => s.name)) });
    const mcpServers = [...userServers, ...pluginMcp.servers].filter((s) => s.enabled !== false);
    // 用户权限规则面（spec 5.2）：两级装载合并不遮蔽；非路径通道（Bash/mcp/web）注入 PolicyEngine，路径通道由链消费
    const perms = loadPermissions(base);
    const policy = new PolicyEngine();
    for (const rule of perms.config.deny) policy.add('deny', rule);
    for (const rule of perms.config.allow) policy.add('allow', rule);
    this.security = new SecurityGuard(policy, opts.mode ?? 'full-access', mcpServers.map((s) => s.name));
    // safety 表注入（Task 9）：与 mcpServers 名单同一装配单点——插件贡献 server 的三类安全声明驱动 guard 问线
    // （act 强制 ask 绕档位/observe 白名单/confirm 走通用 ask+always）；未声明 server 不落键，guard 行为零变化
    this.security.setMcpSafety(pluginMcp.safety);
    this.safety = new SafetyChain(this.security, this.sandbox, base);
    this.safety.setPermissions(perms.config);
    this.safety.setAdditionalDirs([...perms.config.additionalDirs, ...(opts.addDirs ?? [])]);
    this.permissionWarningList = perms.warnings;
    // 技能门面先于工具装配创建（skill 工具经它按 id 解析正文；纯构造无副作用）
    this.skills = createSkillsFacade(base);
    // write 影子快照单点（rewind/fork 规格 §6.1）：blob 落数据目录，清单随任务收口进 user 事件
    this.writeSnapshot = makeWriteSnapshotSink(resolveDataDir(base), base);
    // 统一后台任务账本（后台任务线规格 D1）：任务日志落 <dataDir>/tasks/;账本持久化走会话维
    // adoptLedger 收养（serve/session.ts syncTasksLedger,journalId 推导路径）——纯构造零注入面
    this.tasks = new TaskRegistry(resolveDataDir(base));
    // 后台任务账本直播(GUI 侧栏/顶栏计数):submit/finish 旁路;adopt 重放不经 onChange
    if (opts.onEvent) {
      const emit = opts.onEvent;
      this.tasks.setOnChange((task) => {
        emit({
          type: 'bg-task',
          ts: Date.now(),
          payload: {
            id: task.id,
            kind: task.kind,
            label: task.label,
            status: task.status,
            startedAt: task.startedAt,
            ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
            ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
          },
        });
      });
    }
    // edit 先读守卫(read 记录快照/edit 校验 NOT_READ·STALE_READ):随运行时铸造——setMode/reset 换铸
    // 即新守卫,换铸后目标文件须重读再改(与快照出生重建同族语义);写入面(write 工具)不设闸(全量覆写
    // 自带完整内容,无 old_string 错位面)
    this.readGuard = createReadGuard();
    // memory 接缝注入记忆写入（规格 §4.4 落点表，原第 7 参）：模型会中经既有 write 自写记忆走校验/规范化/索引/容量单点；工具清单零变化
    // kb 接缝（D18 接线，原第 3 参）：装配根构造的 KnowledgeBase 注入——缺省 undefined 时 kb_search 按既有契约降级 kb_not_configured
    // 装配接缝具名注入（D25/H6）：原 13 位置参收敛为 opts 对象，接缝错位由编译期失配兜底（webSearch 生产不注入，缺键即省）
    for (const t of builtinTools(this.safety, base, {
      kb: opts.kb,
      archive: createToolOutputArchive(() => resolveDataDir(base)),
      skills: this.skills,
      memory: guardMemoryWrite,
      memoryWrite: (input) => {
        const r = writeMemoryFact({ root: base, ...input });
        // 记忆清单变点直播(GUI 记忆页签主动重拉;与沉淀管线 catalog-changed 同形)
        if (r.ok) opts.onEvent?.({ type: 'catalog-changed', payload: { kind: 'memory' }, ts: Date.now() });
        return r;
      },
      ask: opts.ask ?? headlessAskStub,
      writeSnapshot: this.writeSnapshot,
      activeRoot: () => this.safety.activeRoot,
      todos: opts.todos ?? { set: () => {} },
      tasks: this.tasks,
      readGuard: this.readGuard, // edit 先读守卫(2026-10-31 用户裁定):随运行时铸造,换铸后须重读再改
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
        // 记忆/学习技能落盘变点→侧栏清单直播(跳过「未应用」说明行等非清单变文案:仅 skills/memory 源)
        if (source === 'memory') opts.onEvent?.({ type: 'catalog-changed', payload: { kind: 'memory' }, ts: Date.now() });
        if (source === 'skills') opts.onEvent?.({ type: 'catalog-changed', payload: { kind: 'learned' }, ts: Date.now() });
      },
      learnedEnabled: () => opts.learnSkills ?? resolveMemoryConfig().learnedSkills,
      memoryEnabled: () => (opts.memoryOverride ?? resolveMemoryConfig().autoMemory) === true,
    });
    // MCP 装配链（两级 mcp.json → McpHost）：注册链 fail-fast（连接/握手/拉取任一失败即 run 入口转确定性失败），guard 名单已构造期注入；懒连接——首次 run 前才发起，空配置零开销。
    // 会话内热载（2026-10-30）：mcpReady 每次 run 入口重读两级配置比对基线（mcpSig），变更即 close 撤旧牌
    // → 重建 host 注册 → guard 名单/safety 表对齐 → 返回工具面 diff 漂移行（引擎落 notice 链行，本轮 wire 携带——
    // 追加发生在 Reactor 种子捕获之前）；未变更且已注册零开销直通
    let mcpHost: McpHost | undefined;
    let mcpWarnings: string[] = [...pluginMcp.warnings]; // 合成期告警（用户遮蔽/插件撞名/装载告警）并入既有警告单通道
    const reportedMcpWarnings = new Set<string>(); // 链面已上报集合（mcpWarningsOnce 去重账，恢复摘录见 mcpReady）
    let mcpSig = JSON.stringify(mcpServers); // 装配基线（合并后 server 配置集；plugin 贡献随合成入列）
    let mcpEverRegistered = false; // 是否曾真实注册过工具面（未注册过的新配置不产漂移行——模型没见过旧面）
    const mcpToolSnapshot = (): Map<string, string> =>
      new Map(this.tools.list().filter((t) => t.name.startsWith('mcp__')).map((t) => [t.name, t.description]));
    this.mcpReady = async (): Promise<string[]> => {
      const freshUser = loadMcpServers(base);
      const freshPlugin = pluginMcpServers(base, { userServerNames: new Set(freshUser.map((s) => s.name)) });
      const fresh = [...freshUser, ...freshPlugin.servers].filter((s) => s.enabled !== false);
      const sig = JSON.stringify(fresh);
      // 失败重建(2026-11-01「失败连接被缓存永不重试」根修):连接失败的 server 留在 host 的死连接里,
      // sig 未变直通即永不重试(模型侧表现=工具永不挂载,重启会话才恢复)——存在失败 server 时
      // 走下方重建(close 撤旧牌→重连重注册),成功 server 同步重注册(幂等,漂移零行)
      await mcpHost?.livenessCheck(); // 每轮连通性验证(2026-11-01 用户裁定:stdio 存活探测+http/sse 协议 ping,并行 1s 封顶)——server 中途死亡入失败名单触发同轮重建
      if (sig === mcpSig && (mcpHost !== undefined || fresh.length === 0) && mcpHost?.hasFailedServers() !== true) return []; // 未变更：已注册直通/空配置零开销
      const before = mcpEverRegistered ? mcpToolSnapshot() : null;
      if (mcpHost) {
        await mcpHost.close(); // 撤旧牌（registeredNames 逐名 unregister——移除/变更 server 的工具下架）
        mcpHost = undefined;
      }
      if (fresh.length === 0) {
        this.security.setMcpServers([]); // 名单收口：已卸载 server 的工具放行面同步关闭
        const drift = mcpEverRegistered ? ['[mcp] all MCP servers removed — their tools are no longer available'] : [];
        mcpSig = sig;
        mcpEverRegistered = false;
        return drift;
      }
      // stderr 日志面(2026-11-01):<dataDir>/plugins/logs/<server>.log——插件崩退/有头启动失败诊断源
      mcpHost = new McpHost(fresh, this.tools, { logDir: path.join(resolveDataDir(base), 'plugins', 'logs') });
      try {
        const report = await mcpHost.registerTools();
        mcpWarnings = [...freshPlugin.warnings, ...report.warnings];
      } catch (e) {
        mcpHost = undefined; // 注册链失败复位，下次 run 重试连接（失败经 run 入口转确定性 failed，不静默直通）
        throw e;
      }
      // 已上报集合随单收敛（D59）：警告内容收缩（某 server 恢复出单）即摘其上报记录——
      // 「恢复后再失败」对链面是状态变更须重新可见；持续失败同文案保持已上报（每轮静默）
      for (const w of [...reportedMcpWarnings]) {
        if (!mcpWarnings.includes(w)) reportedMcpWarnings.delete(w);
      }
      // guard 名单/safety 表对齐新配置（注册成功才对齐——失败路径保留旧名单，下次 run 重试）
      this.security.setMcpServers(fresh.map((s) => s.name));
      this.security.setMcpSafety(freshPlugin.safety);
      const drift: string[] = [];
      if (before !== null) {
        const after = mcpToolSnapshot();
        const added: string[] = [];
        const removed: string[] = [];
        const updated: string[] = [];
        for (const [name, desc] of after) {
          const prev = before.get(name);
          if (prev === undefined) added.push(desc.length > 0 ? `${name} — ${desc.slice(0, 128)}` : name);
          else if (prev !== desc) updated.push(name);
        }
        for (const name of before.keys()) if (!after.has(name)) removed.push(name);
        if (added.length > 0) drift.push(`[mcp] tools added: ${added.join(', ')}`);
        if (removed.length > 0) drift.push(`[mcp] tools removed: ${removed.join(', ')} (no longer available)`);
        if (updated.length > 0) drift.push(`[mcp] tools updated: ${updated.join(', ')} (tool list refreshed from mcp.json)`);
      }
      mcpSig = sig;
      mcpEverRegistered = true;
      return drift;
    };
    this.mcpClose = async () => {
      const h = mcpHost;
      mcpHost = undefined;
      if (h) await h.close();
    };
    this.mcpWarnings = () => mcpWarnings;
    this.mcpWarningsOnce = () => {
      const fresh = mcpWarnings.filter((w) => !reportedMcpWarnings.has(w));
      for (const w of fresh) reportedMcpWarnings.add(w);
      return fresh;
    };
    this.settleHooks = {
      settle: (r: SettlePayload) => this.pipeline.enqueue({ kind: 'learned', ...r }),
      settleMemory: (r: SettlePayload) => this.pipeline.enqueue({ kind: 'memory', ...r }),
    };
    // 子智能体执行单元：注册表/安全链/上下文/模型同源装配；agents 两级目录（全局 userConfigDir() + 项目 root）
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
    // 团队/板/inbox 按会话隔离：构造期驻内存（或显式 teamsSessionId 立即落盘）；daemon/TUI
    // 在 journal 铸造后 adoptSessionTeams(journalId)。成员名会话内唯一（inbox 按名落档）；
    // 认领与 send_agent_team_message 仅同 teamId——不跨队共享。
    this.dataDir = resolveDataDir(base);
    this.memoryBoardStore = new MemoryTeamStore();
    // 未绑 journal：零盘面占位；adoptSessionTeams 才切到会话根（不写 teams/.unbound）
    this.inbox = new FileInbox();
    this.inboxCursors = new InboxCursorStore();
    this.teamsBoundJournalId = undefined;
    // teammate 创建接缝(P2 T3):spawn 分流命中(makeSpawnTool executor)在此构造长驻 Teammate——
    // 名 = label ?? agent_id ?? 'worker';框定 = 角色行(目录注册制 agent.md)或内联 prompt 前 300 字符;
    // 工具面 = deriveTeammateRegistry 派生(剔 spawn/todo_write/ask_question/worktree/板面五件套 + 注 get_agent_team_board/get_task)。
    // 重名裁定(T2 register 为替换语义,spawn 通道在其上收紧):活名重复 spawn → INVALID_ARG fail-fast
    // (模型换名/先停后建;静默替换会停掉在跑 teammate 且台账悬空);已停同名 → 替换重建(register 原语义)。
    // 台账登记:kind 'subagent' + label = teammate 名,stop 句柄接 tm.stop——板派发中止/成员打断由 agent_team_task_stop,日志承载启动行
    const persistRoster = (rec: TeammateRosterRecord): void => {
      if (this.rosterStore !== undefined) {
        const rows = this.rosterStore.load().filter((r) => r.name !== rec.name);
        rows.push(rec);
        this.rosterStore.save(rows);
      } else {
        this.memoryRoster = [...this.memoryRoster.filter((r) => r.name !== rec.name), rec];
      }
    };
    const mountTeammate = (name: string, framing: string, teamId: string, createdAt?: number): Result<{ name: string }> => {
      if (this.agentTeams.get(teamId) === undefined) {
        return fail('INVALID_ARG', `unknown teamId: ${teamId}; create a team with create_agent_team first`);
      }
      const incumbent = this.team.get(name);
      if (incumbent !== undefined && !incumbent.stopped) {
        return fail('INVALID_ARG', `teammate name already exists on team ${incumbent.teamId}`);
      }
      const tm = new Teammate({
        name,
        framing,
        teamId,
        ...(createdAt !== undefined && createdAt > 0 ? { createdAt } : {}),
        deps: {
          safety: this.safety,
          model: this.model,
          registry: this.tools,
          root: base,
          store,
          board: this.taskboard,
          // 板任务台账：execute 内 submit(dispatchTag)——agent_team_task_wait/stop 可等可停；成员实体本身不进账本
          tasks: this.tasks,
          // 回合边界注入(T3 agent-message):worker 每轮 execute 前 drainInbox——与 send_agent_team_message
          // 两面共用同一 FileInbox 实例,lead↔teammate 消息闭环单点
          inbox: this.inbox,
          inboxCursors: this.inboxCursors,
          ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
          registryFactory: (b: ToolRegistry) => deriveTeammateRegistry(
            b,
            this.taskboard,
            // teammate 面 send_agent_team_message:同队存活(排己);lead 由工具恒放行。from = teammate 名
            makeSendMessageTool({
              inbox: this.inbox,
              ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
              from: () => name,
              ...teammateSendTargets(this.team, teamId, name),
            }),
            this.tasks, // task_wait 换装 exec-only(自动转后台可等;板任务不可等)
          ),
        },
      });
      const registered = this.team.register(tm);
      if (!registered.ok) return registered;
      persistRoster({ name, teamId, framing, createdAt: tm.createdAt });
      // teammate 定位(2026-10-20 用户裁决):长驻执行体是「声明」不是任务——无生命周期、不进任务
      // 账本(账本只承载有生命周期的工作单元,假 running 态即语义污染,task_wait 等待面随之纯净);
      // 存活面=TeamRegistry(退出链 team.stopAll() 收口),打断走 agent_team_task_stop 按名寻址
      tm.kick(); // 建即起 claim 循环(「claims unassigned tasks」承诺即时生效;空板自然收兵零开销)
      return ok({ name });
    };
    this.restoreTeammate = (rec) => mountTeammate(rec.name, rec.framing, rec.teamId, rec.createdAt);
    const teamAdapter = {
      spawn: (input: SubagentSpawnInput, teamId: string): Result<{ name: string }> => {
        const name = input.label ?? input.agent_id ?? 'worker';
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
        return mountTeammate(name, framing, teamId);
      },
    };
    // spawn 注册附带呈现元数据（D26/J1）：调用行动词迁自 tui/tool-verbs 旧 VERBS 表；display 为纯
    // 呈现数据（模型面 schema 只取 name/description/parameters，零影响）。工厂文件（subagent.ts 等）
    // 不在 J1 改动清单，故在注册点附加
    this.tools.register({ ...makeSpawnTool(this.runner), display: { verb: 'SPAWN' } });
    // TaskBoard:会话内单物理板;init 只恢复不 kick;lead 工具面;team 预算帽缺省不设;
    // external-cli 执行体路由(无环:executors 零 board 反向引用)
    this.agentTeams = new AgentTeamRegistry(new MemoryAgentTeamStore());
    this.taskboard = new TaskBoard({
      store: this.memoryBoardStore,
      registry: this.tasks,
      team: this.team,
      agentTeams: this.agentTeams,
      externalExecutor: new ExternalCliExecutor({
        sandbox: this.sandbox,
        registry: this.tasks,
        ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      }),
      ...(teamTokenCapEnv() !== undefined ? { teamTokenCap: teamTokenCapEnv() } : {}),
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    });
    this.taskboard.init();
    if (opts.teamsSessionId !== undefined && opts.teamsSessionId.length > 0) {
      this.adoptSessionTeams(opts.teamsSessionId);
    }
    // task_stop / task_wait / 团队 wait·stop 注册在 taskboard 装配之后（板供拒识或板域操作）。
    // task_stop：仅 exec/spawn 台账；板 id 拒识点名 agent_team_task_stop。
    this.tools.register({ ...makeTaskStopTool(this.tasks, this.taskboard), display: { verb: 'TASK_STOP' } });
    // task_wait：仅 exec/spawn 台账等待（板 id 拒识点名 agent_team_task_wait）；第三参 run 信号穿透阻塞期
    this.tools.register({ ...makeTaskWaitTool(this.tasks, this.taskboard, () => this.sandbox.currentRunSignal), display: { verb: 'TASK_WAIT' } });
    // 智能体团队八件套：agentTeams 关则不注入模型面（板协调器仍构造，盘数据不删）
    if (agentTeamsEnabled(base)) {
      this.tools.register({
        ...makeAgentTeamTaskWaitTool(this.tasks, this.taskboard, () => this.sandbox.currentRunSignal),
        display: { verb: 'AGENT_TEAM_TASK_WAIT' },
      });
      this.tools.register({
        ...makeAgentTeamTaskStopTool(this.tasks, this.team, this.taskboard),
        display: { verb: 'AGENT_TEAM_TASK_STOP' },
      });
      // create_agent_teammate：长驻执行体创建(2026-10-20 与 spawn 分家的独立动词)——team 接缝的模型面出口,
      // 复杂多角色相互依赖工程专用;spawn 回归纯一次性 fork(两动词两契约,重量级通道不再作为隐藏参数)
      this.tools.register({
        name: 'create_agent_teammate',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['teamId', 'name', 'prompt', 'agent_id'],
          properties: {
            teamId: { type: 'string', description: 'teamId from create_agent_team; this teammate only claims that team\'s tasks.' },
            name: { type: 'string', description: 'Unique display name among living teammates on the team.' },
            prompt: {
              type: ['string', 'null'],
              description: 'Role framing (standing duties). Usual: non-empty text with agent_id JSON null.',
            },
            agent_id: {
              type: ['string', 'null'],
              description:
                'Registered agent/preset id for framing, or JSON null when using prompt. Do not invent ids or pass the string "null".',
            },
          },
        },
        description:
          'Register a long-lived teammate on a team (teamId from create_agent_team). Call before create_agent_team_task: board tasks run when this teammate claims unassigned work or is assigned. Usual call: teamId + name + prompt, agent_id JSON null. Teammates keep context across tasks and run one task at a time; interrupt the current task with agent_team_task_stop (member stays). One-shot subtasks outside the board: use spawn.',
        category: 'task',
        fullObservation: true,
        executor: async (input) => {
          const raw = input as { teamId?: unknown; name?: unknown; prompt?: unknown; agent_id?: unknown };
          const teamId = typeof raw.teamId === 'string' ? raw.teamId.trim() : '';
          const name = typeof raw.name === 'string' ? raw.name.trim() : '';
          const prompt = typeof raw.prompt === 'string' && !jsonAbsent(raw.prompt, true) ? raw.prompt : undefined;
          const agentId = typeof raw.agent_id === 'string' && !jsonAbsent(raw.agent_id, true) ? raw.agent_id.trim() : undefined;
          if (teamId === '') throw new CodedToolError('INVALID_ARG', 'teamId is required');
          if (name === '') throw new CodedToolError('INVALID_ARG', 'name is required');
          if (!prompt && !agentId) {
            throw new CodedToolError(
              'INVALID_ARG',
              'prompt or agent_id is required: pass a non-empty prompt with agent_id JSON null (usual), or a real registered agent_id',
            );
          }
          const r = teamAdapter.spawn({ prompt, agent_id: agentId, label: name }, teamId);
          if (!r.ok) return { exitCode: 1, stdout: r.error.message, stderr: '', timedOut: false };
          // 成员名册直播(与 create_agent_team → team-created 同形):GUI 队卡「成员」栏不靠快照轮询
          const tm = this.team.get(r.value.name);
          opts.onEvent?.({
            type: 'teammate-created',
            payload: {
              name: r.value.name,
              teamId,
              createdAt: tm?.createdAt ?? Date.now(),
              busy: tm?.isBusy() ?? false,
            },
            ts: Date.now(),
          });
          return {
            exitCode: 0,
            stdout: `teammate "${r.value.name}" started — claims unassigned board tasks (teamId=${teamId}); give work with create_agent_team_task; interrupt via agent_team_task_stop`,
            stderr: '',
            timedOut: false,
          };
        },
        display: { verb: 'TEAM' },
      });
      for (const t of makeTaskBoardTools(this.taskboard, this.agentTeams, opts.onEvent)) this.tools.register(t);
      // send_agent_team_message 主链面注册（T2 双面之一,随 taskboard 工具后）:lead→teammate 定向;不入
      // TASKBOARD_TOOL_NAMES（裁定:teammate 派生面也要有,lead-only 剔除表不适用——两面各注册各的注入器）;
      // lead 投递轨 = 事件即时呈现 + FileInbox 落档（Ruling 3）
      this.tools.register(makeSendMessageTool({
        inbox: this.inbox,
        ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
        knownRecipients: () => this.team.aliveNames(),
        from: () => 'lead',
        recipientTeamId: (name) => this.team.teamIdOf(name),
      }));
    }
    // P7:稳定段观测面装配口径缓存(outputStyle 是 run 级常量)——harness.stableSegment 与 reactor
    // 构造行同源,不引入第二份 deps 面
    this.stableOutputStyle = opts.outputStyle;
    // imageHistoryLimit（spec §3.2 settings 键接线）：装配期两级解析一次（0-50 整数，非法/缺省回 3），
    // 注入单发 Reactor 并经只读面暴露给 LoopDeps 装配点（loop 主链 Reactor 同源消费）；告警走 selfcheck 面
    const imageHistory = resolveImageHistoryLimit(base);
    this.imageHistoryLimit = imageHistory.value;
    this.imageHistoryWarningList = imageHistory.warnings;
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
      imageHistoryLimit: imageHistory.value,
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts.outputStyle ? { outputStyle: opts.outputStyle } : {}),
      // 运行中穿插（对标 CC queued messages）：步边界 drain 单点；未消费行由会话层收口兜底补跑
      steer: () => this.steerSource(),
      // 沉淀双钩子零等待入队（规格 §3.1/§3.5 D2）：收口同步路径不再 await 模型调用；开关判门在管线内逐项求值
      ...this.settleHooks,
    });
    this.ledger = ledger;
  }

  /**
   * 会话团队收养（与 tasks.adoptLedger 同拍）：journalId 稳定身份下把注册表/板/inbox/位点
   * 切到 `<dataDir>/teams/<journalId>/`。同键幂等。
   * 未绑定→首绑：内存已有队/板且盘空则回流落盘（铸造略晚于首笔 create_agent_team 的窄窗）。
   * 已绑会话切换：停清成员、不回流，按目标 journal 盘面装载（新会话空板）。
   * 不读旧工作区级 `teams/` 根——零兼容。
   */
  adoptSessionTeams(journalId: string): void {
    if (journalId.length === 0) return;
    if (this.teamsBoundJournalId === journalId) return;
    const wasUnbound = this.teamsBoundJournalId === undefined;
    if (!wasUnbound) this.team.clear();
    const root = sessionTeamsRoot(this.dataDir, journalId);
    const regStore = new AgentTeamRegistryStore(root);
    const priorTeams = this.agentTeams.list();
    if (wasUnbound && priorTeams.length > 0 && regStore.load().length === 0) regStore.save(priorTeams);
    this.agentTeams.adopt(regStore);

    const boardStore = new TeamStore(path.join(root, 'main'));
    const diskSnap = boardStore.load();
    const diskEmpty = Object.keys(diskSnap.tasks).length === 0 && diskSnap.seq === 0;
    if (wasUnbound && diskEmpty && this.memoryBoardStore !== undefined) {
      for (const ev of this.memoryBoardStore.drainEvents()) boardStore.append(ev);
    }
    this.taskboard.adoptStore(boardStore);
    this.memoryBoardStore = undefined;
    this.inbox.adopt(path.join(root, 'main', 'inbox'));
    this.inboxCursors.adopt(path.join(root, 'inbox-cursors.json'));

    // 成员名册：首绑回流内存；切换/新进程按盘复原 Teammate（子会话抽象跨重启）
    const roster = new TeammateRosterStore(root);
    if (wasUnbound && this.memoryRoster.length > 0 && roster.load().length === 0) {
      roster.save(this.memoryRoster);
    }
    this.memoryRoster = [];
    this.rosterStore = roster;
    if (this.team.aliveNames().length === 0 && this.restoreTeammate !== undefined) {
      for (const rec of roster.load()) {
        if (this.agentTeams.get(rec.teamId) === undefined) continue;
        this.restoreTeammate(rec);
      }
    }

    this.teamsBoundJournalId = journalId;
  }

  /** 稳定段观测面（P7:出执行器命名空间）——/context 构成观测消费,与 Reactor chatRound 装配同一
   *  stableSegmentOf 单点(零第二拼装);生产/测试观测统一走此薄委托,不再借道 harness.reactor */
  stableSegment(): string {
    return stableSegmentOf({
      ...(this.stableOutputStyle ? { outputStyle: this.stableOutputStyle } : {}),
      activeRoot: () => this.safety.activeRoot,
      contextRoot: this.context.root,
    });
  }

  private permissionWarningList: string[] = [];

  /** permissions 装载告警（spec 5.2 单级形状非法跳过）；selfcheck 上屏 */
  permissionWarnings(): string[] {
    return [...this.permissionWarningList];
  }

  /** 渲染期图片历史半径（spec §3.2 settings 键 imageHistoryLimit 装配期解析值）：LoopDeps 装配点透传 loop 主链 Reactor */
  readonly imageHistoryLimit: number = DEFAULT_IMAGE_HISTORY_LIMIT;

  private imageHistoryWarningList: string[] = [];

  /** imageHistoryLimit 装载告警（settings 键形状非法回缺省）；selfcheck 上屏 */
  imageHistoryWarnings(): string[] {
    return [...this.imageHistoryWarningList];
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
