/** 子代理执行单元（单一权威）：定义解析（目录注册制 agents/{id}/agent.md + 预设四角色 + 内联临时）→
 * fork 组装（seedHistory = 主链快照 + 角色行/任务行，行号与 action 词汇对齐 graph 先例）→ 执行 → 终态一行回写。
 * 前缀缓存纪律：定义装配期一次性加载 fail-fast、运行期零增删（同 skills/MCP 纪律）；文案 pick() 运行期求值禁模块级冻结 */
import * as fs from 'fs';
import * as path from 'path';
import { AgentRole, ModelTier, SessionEvent, SubagentSpawnInput } from '../types';
import { pick } from '../i18n';
import { Result, ok, fail } from '../result';
import { Reactor, StepRecord } from './reactor';
import { ToolRegistry } from './tools';
import { SafetyChain } from './security/chain';
import { ContextManager } from './context';
import { RunLedger } from './ledger';
import type { ModelAdapter, ModelRouter } from '../model/adapter';

/** 四角色任务框定（多角色子 Agent 预设：只做框定与档位建议，不新增模型通道）；label/framing 存双语静态对，取值经 rolePreset 运行期求值 */
export const ROLE_PRESETS: Record<AgentRole, { label: { en: string; zh: string }; framing: { en: string; zh: string } }> = {
  planner: { label: { en: 'Planner', zh: '规划师' }, framing: { en: 'requirement breakdown, solution and path design', zh: '需求拆解、方案与路径设计' } },
  developer: { label: { en: 'Developer', zh: '开发者' }, framing: { en: 'code implementation, refactoring and fixes', zh: '代码实现、重构与修复' } },
  tester: { label: { en: 'Tester', zh: '测试工程师' }, framing: { en: 'test case generation, execution and failure analysis', zh: '测试用例生成、执行与失败分析' } },
  reviewer: { label: { en: 'Reviewer', zh: '审查员' }, framing: { en: 'convention, logic and security review with a review report', zh: '规范、逻辑与安全审查，产出审查报告' } },
};

/** 角色预设运行期取值（语言随 --language 装配后设定，禁止模块级 pick 冻结） */
export function rolePreset(role: AgentRole): { label: string; framing: string } {
  const p = ROLE_PRESETS[role];
  return { label: pick(p.label.en, p.label.zh), framing: pick(p.framing.en, p.framing.zh) };
}

/** 注册制子代理定义（目录注册制解析产物 / 预设角色统一形态） */
export interface AgentDef {
  id: string;
  name: string;
  description: string;
  /** 角色框定正文（agent.md frontmatter 之后的正文；预设角色经 rolePreset 运行期求值） */
  framing: string;
}

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---/;

/** 解析 agent.md 的简易 frontmatter（--- 块内 key: value，与 skills 解析器同风格） */
export function parseAgentFrontmatter(md: string): { name: string; description: string; version: string; body: string } {
  const out: Record<string, string> = { name: '', description: '', version: '0.1.0' };
  const m = FRONTMATTER.exec(md);
  if (!m) throw new Error(pick('agent.md missing frontmatter', 'agent.md 缺少 frontmatter 头'));
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) out[kv[1]] = kv[2].trim();
  }
  if (!out.name) throw new Error(pick('agent.md frontmatter missing name', 'agent.md frontmatter 缺少 name'));
  return { name: out.name, description: out.description, version: out.version, body: md.slice(m[0].length).trim() };
}

/** 注册表：四角色内建注册 + agents/{id}/agent.md 装配期一次性加载（fail-fast，运行期零增删）。
 * 内建预设存双语对、resolve 时经 pick 求值（语言为启动参数，注册可能先于语言设置）；目录注册制为用户自撰正文、语言无关直存 */
export class AgentRegistry {
  private defs = new Map<string, AgentDef>();
  private builtins = new Map<string, { name: { en: string; zh: string }; framing: { en: string; zh: string } }>();

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
      this.defs.set(entry.name, { id: entry.name, name: meta.name, description: meta.description, framing: meta.body });
    }
  }

  resolve(id: string): AgentDef {
    const b = this.builtins.get(id);
    if (b) {
      return { id, name: pick(b.name.en, b.name.zh), description: pick(b.framing.en, b.framing.zh), framing: pick(b.framing.en, b.framing.zh) };
    }
    const def = this.defs.get(id);
    if (!def) throw new Error(pick(`Subagent not found: ${id}`, `未找到智能体：${id}`));
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
    throw new Error(pick('agent_id and prompt are both missing', 'agent_id 与 prompt 皆缺'));
  }
  const roleLine = input.agent_id
    ? (() => {
        const def = registry.resolve(input.agent_id!);
        return pick(`Your role: ${def.name} (${def.id}); duties: ${def.framing}`, `你的角色：${def.name}（${def.id}），职责：${def.framing}`);
      })()
    : undefined;
  const taskLine =
    opts?.taskLine ??
    input.prompt ??
    pick('Continue the current task per your role framing.', '按角色框定继续当前链上任务。');
  return { roleLine, taskLine, label: input.label ?? input.agent_id ?? 'subagent' };
}

/* ---------- 执行半边 ---------- */

/** spawn 工具名（父级清单唯一持有者；任何 fork 子面一律派生剔除——「spawn 只在主链工具面」全局不变量） */
export const SPAWN_TOOL_NAME = 'spawn';

/** 同层并发 fork 上限：超限该次 spawn 显式拒绝（预算护栏，不静默排队） */
export const SUBAGENT_CONCURRENCY_LIMIT = 4;

/** 子代理预算（对齐 ReactorLimits 语义；以 tokenCap 硬停为护栏，窗口预算属 loop 编排层不在此设） */
export interface SubagentBudget {
  maxSteps: number;
  tokenCap: number;
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
  router?: ModelRouter;
  ledger?: RunLedger;
  onEvent?: (e: SessionEvent) => void;
}

/** 子代理生命周期唯一权威：spawn 工具与 graph 节点都是薄入口，只传参不拼装（防两处拼装漂移）。
 * fork 组装严格随 graph 先例（显式 step 递进、'role'/'task' 行、终态 appendChain 一行 'node'/'note'） */
export class SubagentRunner {
  private getBudget: (() => SubagentBudget) | null = null;
  private inFlight = 0;

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

  /** 统一入口：解析 → 并发护栏 → fork 组装 → 执行 → 终态一行回写。失败不炸父任务（错误局部化由父模型决策续跑/换路） */
  async runSubagent(
    input: SubagentSpawnInput,
    opts?: { taskLine?: string; label?: string; budget?: SubagentBudget },
  ): Promise<Result<{ reply: string }>> {
    const budget = opts?.budget ?? this.getBudget?.();
    if (!budget) {
      return fail('INVALID_STATE', pick('Subagent budget source not attached', '子代理预算源未挂载'));
    }
    const spec = resolveSpawnSpec(this.agents, input, { taskLine: opts?.taskLine });
    const label = opts?.label ?? spec.label;
    if (this.inFlight >= SUBAGENT_CONCURRENCY_LIMIT) {
      return fail(
        'CONCURRENCY_LIMIT',
        pick(`Subagent concurrency limit reached (${SUBAGENT_CONCURRENCY_LIMIT})`, `子代理并发已达上限（${SUBAGENT_CONCURRENCY_LIMIT}）`),
      );
    }
    this.inFlight++;
    try {
      const base = this.deps.context.chainView();
      let step = base.length > 0 ? base[base.length - 1].step + 1 : 1;
      const seedHistory: StepRecord[] = [...base];
      if (spec.roleLine !== undefined) seedHistory.push({ step: step++, action: 'role', observation: spec.roleLine });
      seedHistory.push({ step: step++, action: 'task', observation: spec.taskLine });

      const child = new Reactor({
        safety: this.deps.safety,
        registry: this.deriveChildRegistry(input),
        context: this.deps.context,
        model: this.deps.model,
        ...(this.deps.router ? { router: this.deps.router } : {}),
        ...(this.deps.ledger ? { ledger: this.deps.ledger } : {}),
        ...(this.deps.onEvent
          ? { onEvent: (e: SessionEvent) => this.deps.onEvent!({ ...e, payload: { ...e.payload, subagent: label } }) }
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
          this.deps.context.appendChain([{ action: 'node', observation: `[${label}] ${firstLine(result.reply)}` }]);
          return ok({ reply: result.reply });
        }
        const reason = result.stopReason ?? 'failed';
        this.deps.context.appendChain([
          { action: 'note', observation: `[${label}] ${pick('did not finish', '未完成收束')}（${reason}）` },
        ]);
        return fail('INCOMPLETE', `[${label}] ${pick('did not finish', '未完成收束')}（${reason}）`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : pick('unknown error', '未知错误');
        this.deps.context.appendChain([{ action: 'note', observation: `[${label}] ${pick('failed', '失败')}：${msg}` }]);
        return fail('INCOMPLETE', msg);
      }
    } finally {
      this.inFlight--;
    }
  }
}
