import { ToolSpec } from '../types';

/** 统一执行面：工具注册表（内置工具 + MCP 第三方工具挂载点） */
export class ToolRegistry {
  private tools = new Map<string, ToolSpec>();

  register(spec: ToolSpec): void {
    this.tools.set(spec.name, spec);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}
