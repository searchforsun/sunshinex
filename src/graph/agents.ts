import { AgentRole } from '../types';

/** 多角色子 Agent 描述 */
export interface SubAgent {
  role: AgentRole;
  name: string;
  run(input: string): string;
}

/** 角色子 Agent 工厂：占位实现，返回角色化输出 */
export function createAgent(role: AgentRole): SubAgent {
  return {
    role,
    name: `${role}-agent`,
    run: (input) => `[${role}] processed: ${input}`,
  };
}
