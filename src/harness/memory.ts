import { MemoryLevel } from '../types';

/** 三级记忆：working（工作记忆）/ episodic（情景记忆）/ skill（技能记忆） */
export class Memory {
  private store: Record<MemoryLevel, Record<string, unknown>> = {
    working: {},
    episodic: {},
    skill: {},
  };

  set(level: MemoryLevel, key: string, value: unknown): void {
    this.store[level][key] = value;
  }

  get(level: MemoryLevel, key: string): unknown {
    return this.store[level][key];
  }

  dump(level: MemoryLevel): Record<string, unknown> {
    return { ...this.store[level] };
  }

  clear(level: MemoryLevel): void {
    this.store[level] = {};
  }
}
