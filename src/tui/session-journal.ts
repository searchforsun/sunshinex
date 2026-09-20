/** 会话事件日志（规格 docs/superpowers/specs/2026-09-17-session-persistence-resume-design.md D1/D3/D4/D5）：
 *  每会话一文件 data/sessions/<sessionId>.jsonl 追加只增 + data/sessions-active.json 活动指针。
 *  事件词汇封闭枚举 schema v1：新增持久化状态必须先登记新事件类型 + 对应重放动作 + 重放一致性断言，三者同批。
 *  写=缓冲批量追加（三 flush 点：closeTask / /new 轮转 / TUI 退出），运行中不写盘；
 *  读=逐行解析重放（尾行撕裂/中段损坏重放到上一条完整事件、未知版本由调用方拒载）。 */
import * as fs from 'fs';
import * as path from 'path';
import type { ContextItem, HistoryStep, ModelTier, ReasoningEffort } from '../types';
import type { ChatItem, TodoItem } from './session';

export interface JournalHeader {
  t: 'header';
  v: number;
  id: string;
  createdAt: string;
}

/** 封闭事件词汇 schema v1 */
export type JournalEvent =
  | JournalHeader
  | { t: 'user'; text: string }
  | { t: 'msg'; item: ChatItem }
  | { t: 'chain'; steps: HistoryStep[] }
  | { t: 'compact'; chainFrom: number; compacted: ContextItem[] }
  | { t: 'todos'; items: TodoItem[] }
  | { t: 'model'; tier?: ModelTier; effort?: ReasoningEffort }
  | { t: 'view'; expandAll: boolean; latestFull: boolean };

export interface SessionMeta {
  id: string;
  file: string;
  updatedAt: number;
  firstUser?: string;
}

export interface ParsedJournal {
  events: JournalEvent[];
  truncated: boolean;
}

export interface JournalReplay {
  version: number | undefined;
  chain: HistoryStep[];
  chainFrom: number;
  compacted: ContextItem[];
  messages: ChatItem[];
  nextSeq: number;
  history: string[];
  todos: TodoItem[];
  model?: ModelTier;
  effort?: ReasoningEffort;
  view: { expandAll: boolean; latestFull: boolean };
}

const ACTIVE_POINTER = 'sessions-active.json';

/** 会话 id：UTC 紧凑时间戳 + 4 位随机尾（文件名安全、可排序） */
export function newSessionId(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const ts = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  return `${ts}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 会话日志目录：<dataDir>/sessions */
export function sessionsDir(dataDir: string): string {
  return path.join(dataDir, 'sessions');
}

/** 活动指针读取：最近一次有落盘的会话 id；无指针/损坏返回 undefined（不静默造档） */
export function readActivePointer(dataDir: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, ACTIVE_POINTER), 'utf8')) as { id?: unknown };
    return typeof raw.id === 'string' && raw.id ? raw.id : undefined;
  } catch {
    return undefined;
  }
}

export function writeActivePointer(dataDir: string, id: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, ACTIVE_POINTER), JSON.stringify({ id }), 'utf8');
}

/** 逐行解析：坏行（尾行撕裂/中段损坏）停在上一条完整事件并标 truncated（fail-bounded） */
export function parseJournalFile(file: string): ParsedJournal {
  const events: JournalEvent[] = [];
  let truncated = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.length === 0) continue;
    try {
      events.push(JSON.parse(line) as JournalEvent);
    } catch {
      truncated = true;
      break;
    }
  }
  return { events, truncated };
}

/** 重放归约（封闭词汇 v1）：链累积、压缩后态覆盖（末值语义）、消息直汇、user 汇输入历史、todos/model/view 末值覆盖 */
export function reduceJournal(events: JournalEvent[]): JournalReplay {
  const r: JournalReplay = {
    version: undefined,
    chain: [],
    chainFrom: 0,
    compacted: [],
    messages: [],
    nextSeq: 0,
    history: [],
    todos: [],
    view: { expandAll: false, latestFull: false },
  };
  for (const e of events) {
    switch (e.t) {
      case 'header':
        r.version = e.v;
        break;
      case 'chain':
        r.chain.push(...e.steps);
        break;
      case 'compact':
        r.chainFrom = e.chainFrom;
        r.compacted = e.compacted;
        break;
      case 'msg':
        r.messages.push(e.item);
        r.nextSeq = Math.max(r.nextSeq, e.item.seq);
        break;
      case 'user':
        r.history.push(e.text);
        break;
      case 'todos':
        r.todos = e.items;
        break;
      case 'model':
        r.model = e.tier;
        r.effort = e.effort;
        break;
      case 'view':
        r.view = { expandAll: e.expandAll, latestFull: e.latestFull };
        break;
    }
  }
  return r;
}

/** 档案列表（/resume 无参展示）：mtime 降序；扫文件头 8 行取首条用户输入作摘要（零重放成本） */
export function listSessions(dataDir: string): SessionMeta[] {
  const dir = sessionsDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  const metas: SessionMeta[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    let updatedAt = 0;
    try {
      updatedAt = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    let firstUser: string | undefined;
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n').slice(0, 8)) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as JournalEvent;
          if (e.t === 'user') {
            firstUser = e.text;
            break;
          }
        } catch {
          break;
        }
      }
    } catch {
      /* 读失败：无摘要 */
    }
    metas.push({ id: name.slice(0, -'.jsonl'.length), file, updatedAt, ...(firstUser !== undefined ? { firstUser } : {}) });
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 会话日志写面：事件入缓冲（运行中不写盘）、flush 点批量落盘并维护活动指针；未建档 log 丢弃（空会话零文件） */
export class SessionJournal {
  private buf: string[] = [];
  private id: string | undefined;
  private readonly dataDir: string;
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.dir = sessionsDir(dataDir);
  }

  get currentId(): string | undefined {
    return this.id;
  }

  get pending(): number {
    return this.buf.length;
  }

  /** 建档（首个持久化事件触发）：生成 id，header 入缓冲随首个 flush 落盘 */
  start(): void {
    if (this.id) return;
    this.id = newSessionId();
    const header: JournalHeader = { t: 'header', v: 1, id: this.id, createdAt: new Date().toISOString() };
    this.buf.push(JSON.stringify(header));
  }

  /** 轮转（/new）：清缓冲换新 id，新 header 入缓冲（旧档已在盘） */
  rotate(id: string): void {
    this.buf = [];
    this.id = id;
    const header: JournalHeader = { t: 'header', v: 1, id, createdAt: new Date().toISOString() };
    this.buf.push(JSON.stringify(header));
  }

  /** 续挂既有日志（/resume / --continue）：后续事件追加至同一文件，不重复 header */
  attach(id: string): void {
    this.buf = [];
    this.id = id;
  }

  log(event: JournalEvent): void {
    if (!this.id) return; // 未建档：事件丢弃（空会话零文件）
    this.buf.push(JSON.stringify(event));
  }

  /** flush 点：批量追加 + 活动指针更新；缓冲空为 no-op（不落盘不动指针） */
  flush(): boolean {
    if (!this.id || this.buf.length === 0) return false;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(path.join(this.dir, this.id + '.jsonl'), this.buf.join('\n') + '\n', 'utf8');
    this.buf = [];
    writeActivePointer(this.dataDir, this.id);
    return true;
  }
}
