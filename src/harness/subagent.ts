/** 子代理执行单元（单一权威）：定义解析（目录注册制 agents/{id}/agent.md + 预设四角色 + 内联临时）→
 * fork 组装（seedHistory = 主链快照 + 角色行/任务行，行号与 action 词汇对齐 graph 先例）→ 执行 → 终态一行回写。
 * 前缀缓存纪律：定义装配期一次性加载 fail-fast、运行期零增删（同 skills/MCP 纪律）；文案恒英文单语（角色行/工具 description 直接进模型） */
import * as fs from 'fs';
import * as path from 'path';
import { AgentRole, ModelTier, SessionEvent, SubagentSpawnInput } from '../types';
import { Result, ok, fail } from '../result';
import { Reactor, StepRecord } from './reactor';
import { CodedToolError, RegisteredTool, ToolRegistry } from './tools';
import { SafetyChain } from './security/chain';
import { ContextManager } from './context';
import { MemoryStore } from './memory/store';
import type { MemoryScope } from './memory/paths';
import { resolveMemoryConfig } from '../config/memory-config';
import { RunLedger } from './ledger';
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
}

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---/;

/** 解析 agent.md 的简易 frontmatter（--- 块内 key: value，与 skills 解析器同风格） */
export function parseAgentFrontmatter(md: string): { name: string; description: string; version: string; body: string; memory: boolean } {
  const out: Record<string, string> = { name: '', description: '', version: '0.1.0' };
  const m = FRONTMATTER.exec(md);
  if (!m) throw new Error('agent.md missing frontmatter');
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) out[kv[1]] = kv[2].trim();
  }
  if (!out.name) throw new Error('agent.md frontmatter missing name');
  return { name: out.name, description: out.description, version: out.version, body: md.slice(m[0].length).trim(), memory: out.memory === 'true' };
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
      this.defs.set(entry.name, { id: entry.name, name: meta.name, description: meta.description, framing: meta.body, ...(meta.memory ? { memory: true } : {}) });
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

/** 同层并发 fork 上限：超限该次 spawn 显式拒绝（预算护栏，不静默排队） */
export const SUBAGENT_CONCURRENCY_LIMIT = 4;

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
  router?: ModelRouter;
  ledger?: RunLedger;
  onEvent?: (e: SessionEvent) => void;
}

/** 子代理生命周期唯一权威：spawn 工具与 graph 节点都是薄入口，只传参不拼装（防两处拼装漂移）。
 * fork 组装严格随 graph 先例（显式 step 递进、'role'/'task' 行、终态 appendChain 一行 'node'/'note'） */
export class SubagentRunner {
  private getBudget: (() => SubagentBudget) | null = null;
  private inFlight = 0;
  /** base label → 在飞计数（同名并发消歧：后到者 #N 后缀，run 结束递减归零删键） */
  private inFlightLabels = new Map<string, number>();

  constructor(private deps: SubagentRunnerDeps, private agents: AgentRegistry) {}

  /** spawn 通道预算源：reactor run 起止挂/摘（graph 通道经 opts.budget 显式传入，不走此源） */
  attachParent(getBudget: () => SubagentBudget): void {
    this.getBudget = getBudget;
  }

  detachParent(): void {
    this.getBudget = null;
  }

  /** 子代理工具面派生（「spawn 只在主链工具面」不变量的单一实现点）：缺省 = 父全量 − spawn；
   * 显式 tools = 按名取交集（未知名静默忽略，未知名校验属 spawn 输入面职责） */
  deriveChildRegistry(input?: SubagentSpawnInput): ToolRegistry {
    if (input?.tools && input.tools.length > 0) return this.deps.registry.derive({ only: input.tools });
    return this.deps.registry.derive({ exclude: [SPAWN_TOOL_NAME] });
  }

  /** spawn 输入面校验（fail-fast，禁静默）：双缺 INVALID_ARG、background 两段式未开通 NOT_SUPPORTED、tools 未知名 INVALID_ARG */
  validateSpawnInput(input: SubagentSpawnInput): void {
    if (!input.agent_id && !input.prompt) {
      throw new CodedToolError('INVALID_ARG', 'agent_id and prompt are both missing');
    }
    if (input.background === true) {
      throw new CodedToolError('NOT_SUPPORTED', 'Background two-phase spawn is not available yet; await the result synchronously');
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

  /** 统一入口：解析 → 并发护栏 → fork 组装 → 执行 → 终态一行回写。失败不炸父任务（错误局部化由父模型决策续跑/换路） */
  async runSubagent(
    input: SubagentSpawnInput,
    opts?: { taskLine?: string; label?: string; budget?: SubagentBudget },
  ): Promise<Result<{ reply: string; tokens: number }>> {
    const budget = opts?.budget ?? this.getBudget?.();
    if (!budget) {
      return fail('INVALID_STATE', 'Subagent budget source not attached');
    }
    let spec: { roleLine?: string; taskLine: string; label: string };
    try {
      spec = resolveSpawnSpec(this.agents, input, { taskLine: opts?.taskLine });
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
      const base = this.deps.context.chainView();
      let step = base.length > 0 ? base[base.length - 1].step + 1 : 1;
      const seedHistory: StepRecord[] = [...base];
      if (spec.roleLine !== undefined) seedHistory.push({ step: step++, action: 'role', observation: spec.roleLine });
      // 自有记忆（规格 §8）：声明 memory:true 的 agent 在 role/task 行之间注入自有记忆索引行（fork 私有尾块，主链零污染）
      const own = this.agentMemory(input.agent_id);
      if (own !== undefined) seedHistory.push({ step: step++, action: 'memory', observation: own.line });
      seedHistory.push({ step: step++, action: 'task', observation: spec.taskLine });

      const child = new Reactor({
        safety: own !== undefined ? this.deps.safety.withMemoryScope(own.scope) : this.deps.safety,
        registry: this.deriveChildRegistry(input),
        context: this.deps.context,
        model: this.deps.model,
        ...(this.deps.root ? { root: this.deps.root } : {}),
        ...(this.deps.router ? { router: this.deps.router } : {}),
        ...(this.deps.ledger ? { ledger: this.deps.ledger } : {}),
        ...(this.deps.onEvent
          ? { onEvent: (e: SessionEvent) => this.deps.onEvent!({ ...e, payload: { ...e.payload, subagent: finalLabel } }) }
          : {}),
      });
      try {
        const result = await child.run(
          { goal: spec.taskLine },
          {
            maxSteps: budget.maxSteps,
            tokenCap: budget.tokenCap,
            ...(budget.deadlineAt !== undefined ? { deadlineAt: budget.deadlineAt } : {}),
            ...(budget.tier !== undefined ? { tier: budget.tier } : {}),
            scope: 'fork',
            seedHistory,
          },
        );
        if (result.done && result.reply) {
          // 子代理返回制：私有步骤零主链污染，终态恰好一行结论行
          this.deps.context.appendChain([{ action: 'node', observation: `[${finalLabel}] ${firstLine(result.reply)}` }]);
          return ok({ reply: result.reply, tokens: result.tokensUsed ?? 0 });
        }
        const reason = result.stopReason ?? 'failed';
        this.deps.context.appendChain([
          { action: 'note', observation: `[${finalLabel}] did not finish (${reason})` },
        ]);
        return fail('INCOMPLETE', `[${finalLabel}] did not finish (${reason})`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown error';
        this.deps.context.appendChain([{ action: 'note', observation: `[${finalLabel}] failed: ${msg}` }]);
        return fail('INCOMPLETE', msg);
      }
    } finally {
      this.inFlight--;
      const left = (this.inFlightLabels.get(label) ?? 1) - 1;
      if (left <= 0) this.inFlightLabels.delete(label);
      else this.inFlightLabels.set(label, left);
    }
  }
}

/* ---------- spawn 内置工具（主链动态派生入口） ---------- */

/** spawn 工具工厂：同步阻塞形态，子代理最终报告作为该轮工具观察回传；
 * 同轮 tools 数组批量并行由 reactor 并行闸门放行（subagent 类非 bash）；本身无直接 IO 副作用
 * （guard manual 分支免审批），子代理内部每个工具调用独立过安全链 */
export function makeSpawnTool(runner: SubagentRunner): RegisteredTool {
  return {
    name: SPAWN_TOOL_NAME,
    description:
      'Spawn a subagent to execute one independent subtask; its final report returns as this tool result. Issue multiple spawn calls in one tools array to run independent subtasks in parallel. prompt must be self-contained (goal, key facts, paths, constraints, acceptance) — the subagent cannot see this conversation; agent_id references a registered agent or preset role; tools optionally narrows the child tool surface.',
    category: 'subagent',
    executor: async (input) => {
      const spec = input as SubagentSpawnInput;
      runner.validateSpawnInput(spec);
      const r = await runner.runSubagent(spec);
      if (!r.ok) return { exitCode: 1, stdout: r.error.message, stderr: '', timedOut: false };
      return { exitCode: 0, stdout: r.value.reply, stderr: '', timedOut: false };
    },
  };
}
