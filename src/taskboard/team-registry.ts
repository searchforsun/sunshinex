import { fail, ok, Result } from '../result';
import { slugify } from '../slug';
import type { AgentTeamRecord, AgentTeamStoreBackend } from './store';

export type AgentTeam = AgentTeamRecord;
export type { AgentTeamStoreBackend };

/** 进程内注册表后端(单测与无盘场景) */
export class MemoryAgentTeamStore implements AgentTeamStoreBackend {
  private teams: AgentTeam[] = [];

  load(): AgentTeam[] {
    return [...this.teams];
  }

  save(teams: AgentTeam[]): void {
    this.teams = [...teams];
  }
}

function genTeamId(name: string, exists: (id: string) => boolean): string {
  const gen = (): string =>
    `team-${slugify(name, { max: 16, fallback: 'team' })}-${Math.random().toString(36).slice(2, 6)}`;
  let teamId = gen();
  while (exists(teamId)) teamId = gen();
  return teamId;
}

/** AgentTeam 注册表：create/get/list；teamId 方言 team-<slug>-<4rand>；清单按会话落盘 */
export class AgentTeamRegistry {
  private teams: AgentTeam[];
  private store: AgentTeamStoreBackend;

  constructor(
    store: AgentTeamStoreBackend,
    private readonly now: () => number = Date.now,
  ) {
    this.store = store;
    this.teams = store.load();
  }

  /** 会话收养：换后端并重载清单（同会话重复收养幂等）。 */
  adopt(store: AgentTeamStoreBackend): void {
    this.store = store;
    this.teams = store.load();
  }

  create(name: string): Result<AgentTeam> {
    const trimmed = name.trim();
    if (trimmed.length === 0) return fail('INVALID_ARG', 'name is required');
    const teamId = genTeamId(trimmed, (id) => this.teams.some((t) => t.teamId === id));
    const team: AgentTeam = { teamId, name: trimmed, createdAt: this.now() };
    this.teams = [...this.teams, team];
    this.store.save(this.teams);
    return ok(team);
  }

  get(id: string): AgentTeam | undefined {
    return this.teams.find((t) => t.teamId === id);
  }

  list(): AgentTeam[] {
    return [...this.teams];
  }
}
