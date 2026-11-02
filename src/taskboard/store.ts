import * as fs from 'fs';
import * as path from 'path';
import { applyBoardEvent, BoardEvent, emptyBoard, TaskBoardState } from './model';
/** AgentTeam 注册表落盘记录(spec §2.1) */
export interface AgentTeamRecord {
  teamId: string;
  name: string;
  createdAt: number;
}

export interface AgentTeamStoreBackend {
  load(): AgentTeamRecord[];
  save(teams: AgentTeamRecord[]): void;
}

/** AgentTeam 清单持久化：与板事件同会话 teams 根（`<dataDir>/teams/<journalId>/`），单文件 registry.json */
export class AgentTeamRegistryStore implements AgentTeamStoreBackend {
  private dirMade = false;

  constructor(private teamsRoot: string) {}

  private registryPath(): string {
    return path.join(this.teamsRoot, 'registry.json');
  }

  private ensureDir(): void {
    if (this.dirMade) return;
    fs.mkdirSync(this.teamsRoot, { recursive: true });
    this.dirMade = true;
  }

  load(): AgentTeamRecord[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.registryPath(), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isAgentTeamRecord);
    } catch {
      return [];
    }
  }

  save(teams: AgentTeamRecord[]): void {
    this.ensureDir();
    const target = this.registryPath();
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(teams), 'utf8');
    fs.renameSync(tmp, target);
  }
}

function isAgentTeamRecord(v: unknown): v is AgentTeamRecord {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.teamId === 'string' && typeof o.name === 'string' && typeof o.createdAt === 'number';
}

/** 成员名册落盘记录：长驻执行体身份（子会话抽象），按会话 teams 根持久化 */
export interface TeammateRosterRecord {
  name: string;
  teamId: string;
  framing: string;
  /** 创建时刻(ms)；旧档缺省=0，GUI 不显示 */
  createdAt: number;
}

export interface TeammateRosterStoreBackend {
  load(): TeammateRosterRecord[];
  save(rows: TeammateRosterRecord[]): void;
}

/** 成员名册：`<dataDir>/teams/<journalId>/teammates.json`——重启后重建 Teammate 实例 */
export class TeammateRosterStore implements TeammateRosterStoreBackend {
  private dirMade = false;

  constructor(private teamsRoot: string) {}

  private rosterPath(): string {
    return path.join(this.teamsRoot, 'teammates.json');
  }

  private ensureDir(): void {
    if (this.dirMade) return;
    fs.mkdirSync(this.teamsRoot, { recursive: true });
    this.dirMade = true;
  }

  load(): TeammateRosterRecord[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.rosterPath(), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      const out: TeammateRosterRecord[] = [];
      for (const item of parsed) {
        const rec = parseTeammateRosterRecord(item);
        if (rec !== undefined) out.push(rec);
      }
      return out;
    } catch {
      return [];
    }
  }

  save(rows: TeammateRosterRecord[]): void {
    this.ensureDir();
    const target = this.rosterPath();
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows), 'utf8');
    fs.renameSync(tmp, target);
  }
}

function parseTeammateRosterRecord(v: unknown): TeammateRosterRecord | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string' || typeof o.teamId !== 'string' || typeof o.framing !== 'string') return undefined;
  const createdAt = typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : 0;
  return { name: o.name, teamId: o.teamId, framing: o.framing, createdAt };
}

/** 板事件存储接缝：磁盘 TeamStore 与会话未绑定前的 MemoryTeamStore 共用。 */
export interface TeamStoreBackend {
  append(ev: BoardEvent): void;
  writeSnapshot(state: TaskBoardState): void;
  load(): TaskBoardState;
}

/** 会话未绑定 journal 前的内存板（零盘面；adopt 后换成 TeamStore）。 */
export class MemoryTeamStore implements TeamStoreBackend {
  private events: BoardEvent[] = [];

  append(ev: BoardEvent): void {
    this.events = [...this.events, ev];
  }

  writeSnapshot(_state: TaskBoardState): void {
    // 内存态无快照文件
  }

  load(): TaskBoardState {
    let state = emptyBoard();
    for (const ev of this.events) state = applyBoardEvent(state, ev);
    return state;
  }

  /** adopt 回流：盘空时把内存事件灌进会话 TeamStore */
  drainEvents(): BoardEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}

/** team 目录 event sourcing:events.jsonl 为协调状态唯一真相源(append-only 单行原子),
 *  board.json 为物化快照缓存(tmp+rename 原子写)——载入走全量重放。损坏行跳过。
 *  目录惰性建档:首写才 mkdir。落位在会话根 `<dataDir>/teams/<journalId>/main/`。 */
export class TeamStore implements TeamStoreBackend {
  private dirMade = false;

  constructor(private teamDir: string) {}

  private eventsPath(): string {
    return path.join(this.teamDir, 'events.jsonl');
  }

  private ensureDir(): void {
    if (this.dirMade) return;
    fs.mkdirSync(this.teamDir, { recursive: true });
    this.dirMade = true;
  }

  append(ev: BoardEvent): void {
    this.ensureDir();
    fs.appendFileSync(this.eventsPath(), JSON.stringify(ev) + '\n', 'utf8');
  }

  writeSnapshot(state: TaskBoardState): void {
    this.ensureDir();
    const target = path.join(this.teamDir, 'board.json');
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, target);
  }

  /** 全量重放载入:文件缺失 = 空板;损坏行跳过不炸。 */
  load(): TaskBoardState {
    let raw: string;
    try {
      raw = fs.readFileSync(this.eventsPath(), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyBoard();
      throw e;
    }
    let state = emptyBoard();
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      let ev: BoardEvent | undefined;
      try {
        const parsed = JSON.parse(line) as BoardEvent;
        if (typeof parsed.t === 'string') ev = parsed;
      } catch {
        ev = undefined;
      }
      if (ev !== undefined) state = applyBoardEvent(state, ev);
    }
    return state;
  }
}
