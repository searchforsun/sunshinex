import { ToolSpec, ToolCategory, ToolInput, ToolExecutor, ExecResult } from '../types';
import { pick } from '../i18n';
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

  async execute(name: string, input: ToolInput, safety: SafetyChain): Promise<Result<ExecResult>> {
    const tool = this.tools.get(name);
    if (!tool) return fail('TOOL_NOT_FOUND', pick(`Tool not registered: ${name}`, `工具未注册：${name}`));

    const canonical = CANONICAL_TOOL_NAMES[name] ?? name;
    const decision = await safety.evaluateAsync(canonical, input);
    if (!decision.allowed) return fail('COMMAND_DENIED', decision.reason ?? '命令被安全策略拦截');

    // 文件工具：evaluate 已校验并返回 safePath（绝对路径），executor 直接消费，消除二次解析双轨
    const execInput: ToolInput = decision.safePath !== undefined ? { ...input, path: decision.safePath } : input;

    try {
      const result = await tool.executor(execInput);
      return ok(safety.maskResult(canonical, result));
    } catch (e) {
      if (e instanceof CodedToolError) return fail(e.code, e.message);
      return fail('EXEC_FAILED', e instanceof Error ? e.message : '工具执行失败');
    }
  }
}
