import { ToolSpec, ToolCategory, ToolInput, ToolExecutor, ExecResult } from '../types';
import { Result, ok, fail } from '../result';
import { SecurityGuard } from './security/guard';
import { Sandbox } from './security/sandbox';

/** 内置工具名（小写）→ 安全链规范名：guard/policy 沿用 Bash/Read/Grep/Glob/Write 语法 */
const CANONICAL_TOOL_NAMES: Record<string, string> = {
  exec: 'Bash',
  read: 'Read',
  write: 'Write',
  grep: 'Grep',
  glob: 'Glob',
};

export interface RegisteredTool extends ToolSpec {
  category: ToolCategory;
  executor: ToolExecutor;
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

  list(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  async execute(name: string, input: ToolInput, guard: SecurityGuard, sandbox: Sandbox): Promise<Result<ExecResult>> {
    const tool = this.tools.get(name);
    if (!tool) return fail('TOOL_NOT_FOUND', `工具未注册：${name}`);

    const canonical = CANONICAL_TOOL_NAMES[name] ?? name;
    const decision = guard.preToolUse(canonical, input);
    if (!decision.allowed) return fail('COMMAND_DENIED', decision.reason ?? '命令被安全策略拦截');

    try {
      return ok(await tool.executor(input));
    } catch (e) {
      return fail('EXEC_FAILED', e instanceof Error ? e.message : '工具执行失败');
    }
  }
}
