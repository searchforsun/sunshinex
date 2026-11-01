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

  /** 会话收养：切到新会话根并重读清单（调用方随后以 load 结果覆写内存表） */
  adopt(teamsRoot: string): void {
    this.teamsRoot = teamsRoot;
    this.dirMade = false;
  }

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

  /** 会话收养：切目录后由 TaskBoard.init 重放新根。 */
  adopt(teamDir: string): void {
    this.teamDir = teamDir;
    this.dirMade = false;
  }

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
