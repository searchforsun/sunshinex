import { ToolSpec, ToolCategory, ToolInput, ToolExecutor, ExecResult } from '../types';
import { Result, ok, fail } from '../result';
import { SafetyChain } from './security/chain';

/** 内置工具名（小写）→ 安全链规范名：guard/policy 沿用 Bash/Read/Grep/Glob/Write 语法 */
const CANONICAL_TOOL_NAMES: Record<string, string> = {
  exec: 'Bash',
  read: 'Read',
  write: 'Write',
  grep: 'Grep',
  glob: 'Glob',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  skill: 'Read', // 技能正文加载=只读读取技能文件，归 Read 族（plan 可读、manual 免审批）
  // 记忆写入与 Write 同族（规格 §3.7）：manual 走审批（无 asker 拒绝）、dontAsk 放行、plan 只读闸门拒绝；
  // 不新增安全族——写窄口/审批/plan 语义全部沿用既有一份实现
  memory_write: 'Write',
};

export interface RegisteredTool extends ToolSpec {
  category: ToolCategory;
  executor: ToolExecutor;
}

/** 工具域带码错误：executor 以业务错误码中止执行（registry 转译为同码 Result.fail，降级语义不再笼统 EXEC_FAILED） */
export class CodedToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** 入参 null 键剥离单点（执行边界归一）：仓内工具 schema 约定「可选项以 null 联合进 required」
 *  （function calling strict 兼容口径）——严格守约的端点（DeepSeek V3.2 等）对缺省可选项**必发字面 null**
 *  而非省键；null 是「缺席标记」不是值（真值 null 语义在工具面不存在），安全链评估与 executor 前统一剥键。
 *  模型侧把 "null" 当字符串发的病走各工具自己的归一（如 spawn 的 normalizeSpawnInput），此处只收 JSON null */
export function stripNullInputArgs(input: ToolInput): ToolInput {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === null) {
      changed = true;
      continue;
    }
    out[k] = v;
  }
  return changed ? (out as ToolInput) : input;
}

/** 统一执行面：工具注册表（工具只声明，不直接执行） */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(spec: RegisteredTool): void {
    this.tools.set(spec.name, spec);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** 派生子集面（浅克隆，executor 引用共享——工具无状态、安全链执行期注入）：
   * only 按名取交集（未知名静默忽略，未知名校验属 spawn 输入面职责）、exclude 剔除；
   * 无参即全量克隆，供 fork 装配点在克隆面上做排除收口，原 registry 零突变 */
  derive(opts?: { exclude?: string[]; only?: string[] }): ToolRegistry {
    const child = new ToolRegistry();
    const only = opts?.only;
    const exclude = new Set(opts?.exclude ?? []);
    for (const tool of this.tools.values()) {
      if (only && !only.includes(tool.name)) continue;
      if (exclude.has(tool.name)) continue;
      child.register(tool);
    }
    return child;
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  async execute(name: string, rawInput: ToolInput, safety: SafetyChain): Promise<Result<ExecResult>> {
    const tool = this.tools.get(name);
    if (!tool) return fail('TOOL_NOT_FOUND', `Tool not registered: ${name}`);

    // null 键剥离（schema 可选项缺省标记）：安全链与 executor 前单点归一（2026-10-03 真机
    // 「INVALID_ARG: Unknown isolation: null」——严格守约端点按 enum:['worktree',null] 必发字面 null）
    const input = stripNullInputArgs(rawInput);
    const canonical = CANONICAL_TOOL_NAMES[name] ?? name;
    const decision = await safety.evaluateAsync(canonical, input);
    if (!decision.allowed) return fail('COMMAND_DENIED', decision.reason ?? 'Command denied by security policy');

    // 文件工具：evaluate 已校验并返回 safePath（绝对路径），executor 直接消费，消除二次解析双轨
    const execInput: ToolInput = decision.safePath !== undefined ? { ...input, path: decision.safePath } : input;

    try {
      // 执行期安全缝（规格 D6）：注入运行期链视图，fork 子链 withRoot 换根克隆在此生效；
      // execWrap 转发（spec 5.4）：后台 exec 分支经视图取链侧 landlock 包装（gateView.execWrap 缺省即旧行为）。
      // `?? null` 收口可选契约的 undefined 余量（RuntimeSafetyGate 契约 Promise<wrap|null>；Task 5 台账 parked 承接）
      const runtimeSafety = { execCwd: () => safety.execCwd(), execCommandAllowed: (cmd: string) => safety.execCommandAllowed(cmd), execWrap: async (cmd: string) => (await safety.execWrap(cmd)) ?? null };
      const result = await tool.executor(execInput, runtimeSafety);
      return ok(safety.maskResult(canonical, result));
    } catch (e) {
      if (e instanceof CodedToolError) return fail(e.code, e.message);
      return fail('EXEC_FAILED', e instanceof Error ? e.message : 'Tool execution failed');
    }
  }
}
