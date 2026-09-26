/** 子代理执行单元（单一权威）：定义解析（目录注册制 agents/{id}/agent.md + 预设四角色 + 内联临时）→
 * fork 组装（seedHistory = 主链快照 + 角色行/任务行，行号与 action 词汇对齐 graph 先例）→ 执行 → 终态一行回写。
 * 前缀缓存纪律：定义装配期一次性加载 fail-fast、运行期零增删（同 skills/MCP 纪律）；文案恒英文单语（角色行/工具 description 直接进模型） */
import * as fs from 'fs';
import * as path from 'path';
import { AgentRole, ModelTier, OutputStyle, SessionEvent, SubagentSpawnInput } from '../types';
import { Result, ok, fail } from '../result';
import { Reactor, StepRecord } from './reactor';
import { CodedToolError, RegisteredTool, ToolRegistry } from './tools';
import { createWorktree, isRepo, removeWorktree, subagentTreeName } from './worktree';
import { dataDirReal } from '../config/data-dir';
import { SafetyChain } from './security/chain';
import { ContextManager } from './context';
import { MemoryStore } from './memory/store';
import type { MemoryScope } from './memory/paths';
import { resolveMemoryConfig } from '../config/memory-config';
import { RunLedger } from './ledger';
import { TaskRegistry } from './tasks';
import type { ModelAdapter, ModelRouter } from '../model/adapter';

/** 四角色任务框定（多角色子 Agent 预设：只做框定与档位建议，不新增模型通道）；label/framing 恒英文单语（角色行直接进 fork 提示词） */
export const ROLE_PRESETS: Record<AgentRole, { label: string; framing: string }> = {
  planner: { label: 'Planner', framing: 'requirement breakdown, solution and plan' },
  developer: { label: 'Developer', framing: 'code implementation, refactoring' },
  tester: { label: 'Tester', framing: 'test case generation, execution and reporting' },
  reviewer: { label: 'Reviewer', framing: 'convention, logic and security review' },
};

/** 角色预设取值（英文单语）：保留函数形态作为统一入口，防调用点散读 ROLE_PRESETS */
export function rolePreset(role: AgentRole): { label: string; framing: string } {
  return ROLE_PRESETS[role];
}

/** 注册制子代理定义（目录注册制解析产物 / 预设角色统一形态） */
export interface AgentDef {
  id: string;
  name: string;
  description: string;
  /** 角色框定正文（agent.md frontmatter 之后的正文；预设角色经 rolePreset 运行期求值） */
  framing: string;
  /** 自有跨会话记忆开关（agent.md frontmatter `memory: true`；缺省关）：
   * 声明后自有记忆目录 <dataDir>/memory/agents/<id>/，索引经 fork 私有尾块注入、写面收窄到自身目录 */
  memory?: boolean;
  /** 隔离声明（规格 2026-09-23-subagent-worktree-isolation D2）：frontmatter `isolation: worktree`；缺省无 */
  isolation?: 'worktree';
}

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---/;

/** 解析 agent.md 的简易 frontmatter（--- 块内 key: value，与 skills 解析器同风格） */
export function parseAgentFrontmatter(md: string): { name: string; description: string; version: string; body: string; memory: boolean; isolation?: 'worktree' } {
  const out: Record<string, string> = { name: '', description: '', version: '0.1.0' };
  const m = FRONTMATTER.exec(md);
  if (!m) throw new Error('agent.md missing frontmatter');
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) out[kv[1]] = kv[2].trim();
  }
  if (!out.name) throw new Error('agent.md frontmatter missing name');
  return { name: out.name, description: out.description, version: out.version, body: md.slice(m[0].length).trim(), memory: out.memory === 'true', ...(out.isolation === 'worktree' ? { isolation: 'worktree' as const } : {}) };
}

/** 注册表：四角色内建注册 + agents/{id}/agent.md 装配期一次性加载（fail-fast，运行期零增删）。
 * 内建预设与目录注册制均为英文单语直存（角色行直接进 fork 提示词）；目录注册制正文为用户自撰物料、原样直存 */
export class AgentRegistry {
  private defs = new Map<string, AgentDef>();
  private builtins = new Map<string, { name: string; framing: string }>();

  registerBuiltins(): void {
    for (const role of Object.keys(ROLE_PRESETS) as AgentRole[]) {
      const p = ROLE_PRESETS[role];
      this.builtins.set(role, { name: p.label, framing: p.framing });
    }
  }

  /** 扫描 agents/{id}/agent.md；目录不存在 = 空注册（不算错）；畸形文件整次加载 fail-fast（同 skills/MCP 装配纪律） */
  loadAgents(root: string): void {
    const dir = path.join(root, 'agents');
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, 'agent.md');
      if (!fs.existsSync(file)) continue;
      const md = fs.readFileSync(file, 'utf8');
      const meta = parseAgentFrontmatter(md);
      this.defs.set(entry.name, { id: entry.name, name: meta.name, description: meta.description, framing: meta.body, ...(meta.memory ? { memory: true } : {}), ...(meta.isolation ? { isolation: meta.isolation } : {}) });
    }
  }

  resolve(id: string): AgentDef {
    const b = this.builtins.get(id);
    if (b) {
      return { id, name: b.name, description: b.framing, framing: b.framing };
    }
    const def = this.defs.get(id);
    if (!def) throw new Error(`Subagent not found: ${id}`);
    return def;
  }

  has(id: string): boolean {
    return this.builtins.has(id) || this.defs.has(id);
  }
}

/** 可选点入参归一单点：模型按 schema「null」描述把字面量当字符串传（agent_id:"null" 等），
 * 归一回真实 null/undefined 语义；根因修复点——防 "null" 走注册表查询报 not found 死循环（2026-09-25 用户实测） */
export function normalizeSpawnInput(input: SubagentSpawnInput): SubagentSpawnInput {
  const lit = (v: unknown): boolean => v === 'null' || v === 'undefined';
  return {
    ...input,
    agent_id: input.agent_id !== undefined && lit(input.agent_id) ? undefined : input.agent_id,
    label: input.label !== undefined && lit(input.label) ? undefined : input.label,
    tools: Array.isArray(input.tools) ? input.tools.filter((t) => !lit(t)) : input.tools,
    isolation: input.isolation !== undefined && lit(input.isolation) ? undefined : input.isolation,
  };
}

/** 三形态归一：目录注册制 / 预设角色（agent_id 直取） / 内联临时（仅 prompt）。
 * 显式 taskLine（graph 传入）> prompt > 仅 agent_id 时的缺省续接行；角色行模板与 step/action 口径逐字对齐 graph 先例 */
export function resolveSpawnSpec(
  registry: AgentRegistry,
  input: SubagentSpawnInput,
  opts?: { taskLine?: string },
): { roleLine?: string; taskLine: string; label: string } {
  if (!input.agent_id && !input.prompt && !opts?.taskLine) {
    throw new Error('agent_id and prompt are both missing');
  }
  const roleLine = input.agent_id
    ? (() => {
        const def = registry.resolve(input.agent_id!);
        return `Your role: ${def.name} (${def.id}); duties: ${def.framing}`;
      })()
    : undefined;
  const taskLine =
    opts?.taskLine ??
    input.prompt ??
    'Continue the current task per your role framing.';
  return { roleLine, taskLine, label: input.label ?? input.agent_id ?? 'subagent' };
}

/* ---------- 执行半边 ---------- */

/** spawn 工具名（父级清单唯一持有者；任何 fork 子面一律派生剔除——「spawn 只在主链工具面」全局不变量） */
export const SPAWN_TOOL_NAME = 'spawn';

/** todo_write 工具名（规格 D9：fork 子面恒剔除——子代理私有步骤零主链状态污染，进度经既有结论行回写） */
export const TODO_TOOL_NAME = 'todo_write';

/** 同层并发 fork 上限：超限该次 spawn 显式拒绝（预算护栏，不静默排队）；与 reactor 并行批上限 8 同量级对齐 */
export const SUBAGENT_CONCURRENCY_LIMIT = 8;

/** 子代理预算（对齐 ReactorLimits 语义；tokenCap 缺省 = 透传父级无显式上限，以 maxSteps/deadline 为护栏） */
export interface SubagentBudget {
  maxSteps: number;
  tokenCap?: number;
  deadlineAt?: number;
  tier?: ModelTier;
}

/** 结论行首行摘要（截断 300，链行是模型上下文载荷，防长报告击穿链预算） */
function firstLine(text: string, max = 300): string {
  const line = text.split(/\r?\n/)[0] ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export interface SubagentRunnerDeps {
  registry: ToolRegistry;
  safety: SafetyChain;
  context: ContextManager;
  model: ModelAdapter;
  root?: string;
  /** 活动根提供者（worktree 会话）：派生 fork 子 Reactor root 取活动值，缺省回退静态 root（T2 接缝） */
  rootProvider?: () => string | null;
  router?: ModelRouter;
  ledger?: RunLedger;
  onEvent?: (e: SessionEvent) => void;
  /** 后台任务账本（T2 两段式接缝）：spawn background:true 时立即登记任务并异步执行，结论行落任务日志（规格 D6） */
  tasks?: TaskRegistry;
  /** 输出样式分叉（交互面级，进稳定段）：随装配透传 fork 子 Reactor，子代理与主链同面 */
  outputStyle?: OutputStyle;
}

/** 子代理生命周期唯一权威：spawn 工具与 graph 节点都是薄入口，只传参不拼装（防两处拼装漂移）。
 * fork 组装严格随 graph 先例（显式 step 递进、'role'/'task' 行、终态 appendChain 一行 'node'/'note'） */
export class SubagentRunner {
  private getBudget: (() => SubagentBudget) | null = null;
  private inFlight = 0;
  /** base label → 在飞计数（同名并发消歧：后到者 #N 后缀，run 结束递减归零删键） */
  private inFlightLabels = new Map<string, number>();

  /** 活动根提供者引用（deps.rootProvider 缺省 null）：fork 子 Reactor root 经 forkRoot() 单点取活动值 */
  private readonly rootProvider: (() => string | null) | null;

  constructor(private deps: SubagentRunnerDeps, private agents: AgentRegistry) {
    this.rootProvider = deps.rootProvider ?? null;
  }

  /** spawn 通道预算源：reactor run 起止挂/摘（graph 通道经 opts.budget 显式传入，不走此源） */
  attachParent(getBudget: () => SubagentBudget): void {
    this.getBudget = getBudget;
  }

  detachParent(): void {
    this.getBudget = null;
  }

  /** fork 子 Reactor 工作目录事实单点：活动根优先（worktree 会话经 rootProvider），缺省回退静态 deps.root */
  private forkRoot(): string | null {
    return this.rootProvider?.() ?? this.deps.root ?? null;
  }

  /** 隔离树收口单点（规格 D4）：干净树自动删（含分支，零链行）；有改动/登记缺失 → 保留 + 路径提示（结论/补丁行前注）；
   * 收口失败逐项容忍，尽力而为 */
  private settleSubagentTree(iso?: { name: string; tree: string }): string | undefined {
    if (iso === undefined || this.deps.root === undefined) return undefined;
    const removed = removeWorktree(this.deps.root, dataDirReal(this.deps.root), iso.name);
    if (removed.ok && removed.value === 'removed') return undefined;
    return `worktree kept for inspection: ${iso.tree}`;
  }

  /** 子代理工具面派生（「spawn 只在主链工具面」不变量的单一实现点；收窄 spawn+todo_write+ask_question+worktree）：
   * 缺省 = 父全量 − 这四件；显式 tools = 按名取交集再恒剔除。剔除依据：todo_write 归属主任务单一事实源（D9）；
   * spawn 防子代再生子代（派生树受控）；ask_question 是面向用户的 HITL 通道，fork 执行不中途发问（结论回写即应答）；
   * worktree 切换的是父子共享的活动根（chain.ts activeRoot 单点），子代理不得改动主会话工作环境 */
  deriveChildRegistry(input?: SubagentSpawnInput): ToolRegistry {
    if (input?.tools && input.tools.length > 0) {
      const child = this.deps.registry.derive({ only: input.tools });
      child.unregister(TODO_TOOL_NAME);
      child.unregister(SPAWN_TOOL_NAME);
      child.unregister('ask_question');
      child.unregister('worktree');
      return child;
    }
    return this.deps.registry.derive({ exclude: [SPAWN_TOOL_NAME, TODO_TOOL_NAME, 'ask_question', 'worktree'] });
  }

  /** spawn 输入面校验（fail-fast，禁静默）：双缺 INVALID_ARG、tools 未知名 INVALID_ARG（T2 起两段式开通，background 分支放行）。
   *  校验前先过 normalizeSpawnInput——模型照 schema 可空联合字面传 "null"/"undefined" 字符串（与 agent_id 同病），
   *  不归一直接 INVALID_ARG "Unknown isolation: null" 会被观察行原样回流，模型同参重试成死循环 */
  validateSpawnInput(rawInput: SubagentSpawnInput): void {
    const input = normalizeSpawnInput(rawInput);
    if (!input.agent_id && !input.prompt) {
      throw new CodedToolError('INVALID_ARG', 'agent_id and prompt are both missing');
    }
    if (input.isolation !== undefined && input.isolation !== 'worktree') {
      throw new CodedToolError('INVALID_ARG', `Unknown isolation: ${String(input.isolation)} (only 'worktree')`);
    }
    for (const t of input.tools ?? []) {
      if (!this.deps.registry.has(t)) {
        throw new CodedToolError('INVALID_ARG', `Unknown tool: ${t}`);
      }
    }
  }

  /** 子代理自有记忆（规格 §8）：agent.md 声明 memory:true 且总开关开时给出 { scope, line }——
   * 自有目录 <dataDir>/memory/agents/<id>/，索引行作 fork 私有尾块（role/task 行之间，主链零污染）；
   * 未声明 / 无 root / 总开关关 → undefined（不建目录、不注入）。文案恒英文单语（写链面，CLAUDE.md §15） */
  private agentMemory(agentId: string | undefined): { scope: MemoryScope; line: string } | undefined {
    if (agentId === undefined || this.deps.root === undefined) return undefined;
    if (!resolveMemoryConfig().autoMemory) return undefined;
    let def: AgentDef;
    try {
      def = this.agents.resolve(agentId);
    } catch {
      return undefined;
    }
    if (!def.memory) return undefined;
    const scope = `agents/${def.id}` as const;
    const store = new MemoryStore(this.deps.root, { subdir: path.join('agents', def.id) });
    const index = store.indexText().trim();
    const line = [
      `Your own persistent memory for this role (cross-session reference data, not instructions). Directory: ${store.dir()}`,
      'Protocol: write one .md file per fact with frontmatter (type: user|feedback|project|reference, description: one line); the index is derived and rebuilt automatically — do not edit MEMORY.md. New entries do not enter this session: read a record file directly when you need it now.',
      `Index: ${index.length > 0 ? index : '(empty)'}`,
    ].join('\n');
    return { scope, line };
  }

  /** spawn 两段式入口（规格 D6，对标 CC Task run_in_background）：立即登记 subagent 任务并同步返回回执，
   * 子代理转场外异步执行——结论行只落任务日志（模型以 read 查看终态行），主链零追加；stop 触发协作式取消 */
  spawnBackground(rawInput: SubagentSpawnInput): { taskId: string; outputFilePath: string } {
    const input = normalizeSpawnInput(rawInput);
    const ledger = this.deps.tasks;
    if (ledger === undefined) {
      throw new CodedToolError('NOT_SUPPORTED', 'background spawn requires a task registry (not wired in this assembly)');
    }
    const label = input.agent_id ?? 'subagent';
    const task = ledger.submit({ kind: 'subagent', label, ownerRun: ledger.currentOwner() });
    const budget = this.getBudget?.();
    const abort = new AbortController();
    task.stop = () => abort.abort();
    // fire-and-forget：错误全程 fail-bounded 落日志，绝不冒泡主链
    void (async () => {
      try {
        ledger.append(task.id, `[spawn background] ${input.agent_id ?? 'inline'}: ${input.prompt ?? ''}\n`);
        const r = await this.runSubagent(input, {
          ...(budget !== undefined ? { budget } : {}),
          signal: abort.signal,
          taskId: task.id,
        });
        if (r.ok) {
          // 结论全文落任务日志（多行报告完整可读回）：首行前置 [conclusion] 标记供 finish 判据/快速定位，
          // 后续行原样尾追——日志是后台产出唯一落盘面，截首行即丢产出
          ledger.append(task.id, `[conclusion] ${r.value.reply}\n`);
          ledger.finish(task.id, 'done');
        } else {
          ledger.append(task.id, `[failed] ${r.error.code}: ${r.error.message}\n`);
          ledger.finish(task.id, 'failed');
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ledger.append(task.id, `[failed] ${msg}\n`);
        ledger.finish(task.id, 'failed');
      }
    })();
    return { taskId: task.id, outputFilePath: task.outputFilePath };
  }

  /** 统一入口：解析 → 并发护栏 → fork 组装 → 执行 → 终态一行回写。失败不炸父任务（错误局部化由父模型决策续跑/换路） */
  async runSubagent(
    input: SubagentSpawnInput,
    opts?: { taskLine?: string; label?: string; budget?: SubagentBudget; signal?: AbortSignal; taskId?: string },
  ): Promise<Result<{ reply: string; tokens: number }>> {
    const budget = opts?.budget ?? this.getBudget?.();
    if (!budget) {
      return fail('INVALID_STATE', 'Subagent budget source not attached');
    }
    let spec: { roleLine?: string; taskLine: string; label: string };
    try {
      spec = resolveSpawnSpec(this.agents, normalizeSpawnInput(input), { taskLine: opts?.taskLine });
    } catch (e) {
      return fail('INVALID_ARG', e instanceof Error ? e.message : String(e));
    }
    const label = opts?.label ?? spec.label;
    if (this.inFlight >= SUBAGENT_CONCURRENCY_LIMIT) {
      return fail(
        'CONCURRENCY_LIMIT',
        `Subagent concurrency limit reached (${SUBAGENT_CONCURRENCY_LIMIT})`,
      );
    }
    // 同名并发消歧（规格 §7）：后到者按在飞计数加 #N 后缀，事件标识与结论/补丁行前缀随 finalLabel；
    // 并发集内唯一，全部结束后计数归零、后续 spawn 回裸 label
    const n = this.inFlightLabels.get(label) ?? 0;
    const finalLabel = n > 0 ? `${label}#${n + 1}` : label;
    this.inFlightLabels.set(label, n + 1);
    this.inFlight++;
    try {
      // D2 双通道声明（入参优先于 frontmatter）；D3 静默兜底——root 缺失或非 git 仓 → iso 静默置空，
      // 零链行、主工作区执行（隔离是增强非承诺）；是仓但建树失败 → fail-bounded 补丁行回链，父任务不炸
      const declaredByAgent = (() => {
        if (input.agent_id === undefined) return false;
        try {
          return this.agents.resolve(input.agent_id)?.isolation === 'worktree';
        } catch {
          return false;
        }
      })();
      const wantsIso = input.isolation === 'worktree' || declaredByAgent;
      let iso: { name: string; tree: string } | undefined;
      if (wantsIso && this.deps.root !== undefined && isRepo(this.deps.root)) {
        const created = createWorktree(this.deps.root, dataDirReal(this.deps.root), subagentTreeName(finalLabel));
        if (created.ok) iso = { name: created.value.name, tree: created.value.path };
        else if (created.error.code !== 'WORKTREE_NOT_A_REPO') {
          this.deps.context.appendChain([{ action: 'note', observation: `[${finalLabel}] isolation failed: ${created.error.code}: ${created.error.message}` }]);
          return fail('INCOMPLETE', `[${finalLabel}] isolation failed (${created.error.code})`);
        }
      }
      const base = this.deps.context.chainView();
      let step = base.length > 0 ? base[base.length - 1].step + 1 : 1;
      const seedHistory: StepRecord[] = [...base];
      if (spec.roleLine !== undefined) seedHistory.push({ step: step++, action: 'role', observation: spec.roleLine });
      // 自有记忆（规格 §8）：声明 memory:true 的 agent 在 role/task 行之间注入自有记忆索引行（fork 私有尾块，主链零污染）
      const own = this.agentMemory(input.agent_id);
      if (own !== undefined) seedHistory.push({ step: step++, action: 'memory', observation: own.line });
      seedHistory.push({ step: step++, action: 'task', observation: spec.taskLine });

      // 子链安全链：记忆 scope 收窄克隆；隔离声明在场再换根克隆（withRoot 保 scope，exec cwd 与判界锚专属树）；
      // fork root 锚树（工作目录事实=专属树），缺省锚主链工作目录事实
      const scopeChain = own !== undefined ? this.deps.safety.withMemoryScope(own.scope) : this.deps.safety;
      const childSafety = iso !== undefined ? scopeChain.withRoot(iso.tree) : scopeChain;
      const child = new Reactor({
        safety: childSafety,
        registry: this.deriveChildRegistry(input),
        context: this.deps.context,
        model: this.deps.model,
        ...(iso !== undefined ? { root: iso.tree } : this.forkRoot() ? { root: this.forkRoot()! } : {}),
        ...(this.deps.router ? { router: this.deps.router } : {}),
        ...(this.deps.ledger ? { ledger: this.deps.ledger } : {}),
        ...(this.deps.outputStyle ? { outputStyle: this.deps.outputStyle } : {}),
        ...(this.deps.onEvent
          ? { onEvent: (e: SessionEvent) => this.deps.onEvent!({ ...e, payload: { ...e.payload, subagent: finalLabel } }) }
          : {}),
      });
      try {
        // fork 收割作用域（规格 D9）：子代理执行期内发起/转后台的任务缺省归属本 fork owner，收口统一收割防泄漏
        const ledger = this.deps.tasks;
        const forkOwner = `fork:${finalLabel}`;
        const runInScope = <T>(fn: () => Promise<T>): Promise<T> =>
          ledger !== undefined ? ledger.runInOwnerScope(forkOwner, fn) : fn();
        const result = await runInScope(() =>
          child.run(
            { goal: spec.taskLine },
            {
              maxSteps: budget.maxSteps,
              tokenCap: budget.tokenCap,
              ...(budget.deadlineAt !== undefined ? { deadlineAt: budget.deadlineAt } : {}),
              ...(budget.tier !== undefined ? { tier: budget.tier } : {}),
              scope: 'fork',
              seedHistory,
            },
          ),
        );
        if (result.done && result.reply) {
          // 子代理返回制：私有步骤零主链污染；隔离树收口先行——脏树保留时补丁行附路径，再落结论行
          const keptNote = this.settleSubagentTree(iso);
          if (keptNote !== undefined) this.deps.context.appendChain([{ action: 'note', observation: `[${finalLabel}] ${keptNote}` }]);
          this.deps.context.appendChain([{ action: 'node', observation: `[${finalLabel}] ${firstLine(result.reply)}` }]);
          return ok({ reply: result.reply, tokens: result.tokensUsed ?? 0 });
        }
        const reason = result.stopReason ?? 'failed';
        {
          const keptNote = this.settleSubagentTree(iso);
          this.deps.context.appendChain([{ action: 'note', observation: `[${finalLabel}] did not finish (${reason})${keptNote !== undefined ? ` — ${keptNote}` : ''}` }]);
        }
        return fail('INCOMPLETE', `[${finalLabel}] did not finish (${reason})`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown error';
        const keptNote = this.settleSubagentTree(iso);
        this.deps.context.appendChain([{ action: 'note', observation: `[${finalLabel}] failed: ${msg}${keptNote !== undefined ? ` — ${keptNote}` : ''}` }]);
        return fail('INCOMPLETE', msg);
      }
    } finally {
      this.inFlight--;
      const left = (this.inFlightLabels.get(label) ?? 1) - 1;
      if (left <= 0) this.inFlightLabels.delete(label);
      else this.inFlightLabels.set(label, left);
      // fork 收割（规格 D9）：子代理收口终结其名下全部 running 后台任务，零泄漏
      this.deps.tasks?.reap(`fork:${finalLabel}`);
    }
  }
}

/* ---------- spawn 内置工具（主链动态派生入口） ---------- */

/** spawn 工具工厂：同步阻塞形态，子代理最终报告作为该轮工具观察回传；
 * 同轮 tools 数组批量并行由 reactor 并行闸门放行（subagent 类非 bash）；本身无直接 IO 副作用
 * （guard manual 分支免审批），子代理内部每个工具调用独立过安全链 */
export function makeSpawnTool(runner: SubagentRunner): RegisteredTool {
  return {
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt', 'agent_id', 'label', 'tools', 'background', 'isolation'],
      properties: {
        prompt: { type: 'string', description: 'Self-contained subtask brief: goal, key facts, paths, constraints, acceptance (the subagent cannot see this conversation)' },
        agent_id: { type: ['string', 'null'], description: 'Registered agent id or preset role; null spawns an inline subagent' },
        label: { type: ['string', 'null'], description: 'Short card title for the timeline; null defaults to agent_id ?? subagent' },
        tools: { type: ['array', 'null'], items: { type: 'string' }, description: 'Optional child tool-name allowlist; null defaults to the parent surface minus spawn' },
        background: { type: ['boolean', 'null'], description: 'true = two-phase spawn: returns a task id immediately, the subagent runs in the background and its conclusion lands in the task log (inspect via read)' },
        isolation: { type: ['string', 'null'], enum: ['worktree', null], description: "Request an isolated git worktree for this subtask; null runs in the main workspace (silently degraded when the workspace is not a git repository)" },
      },
    },
    name: SPAWN_TOOL_NAME,
    description:
      'Spawn one or more subagents — prefer one round with several spawn calls over several rounds with one each whenever subtasks are independent and do not need this conversation; they run concurrently (in-flight cap 8, background=true removes the cap via two-phase spawn). Each spawn must carry a self-contained prompt (goal, key facts, paths, constraints, acceptance) — the subagent cannot see this conversation; agent_id references a registered agent or preset role; tools optionally narrows the child tool surface.',
    category: 'subagent',
    executor: async (input) => {
      const spec = input as SubagentSpawnInput;
      runner.validateSpawnInput(spec);
      if (spec.background === true) {
        const started = runner.spawnBackground(spec);
        return { exitCode: 0, stdout: `task ${started.taskId} started (output: ${started.outputFilePath})`, stderr: '', timedOut: false };
      }
      const r = await runner.runSubagent(spec);
      if (!r.ok) return { exitCode: 1, stdout: r.error.message, stderr: '', timedOut: false };
      return { exitCode: 0, stdout: r.value.reply, stderr: '', timedOut: false };
    },
  };
}
