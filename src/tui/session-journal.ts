/** 会话事件日志（规格 docs/superpowers/specs/2026-09-17-session-persistence-resume-design.md D1/D3/D4/D5）：
 *  每会话一文件 data/sessions/<sessionId>.jsonl 追加只增 + data/sessions-active.json 活动指针。
 *  事件词汇封闭枚举 schema v1：新增持久化状态必须先登记新事件类型 + 对应重放动作 + 重放一致性断言，三者同批。
 *  写=缓冲批量追加（三 flush 点：closeTask / /new 轮转 / TUI 退出），运行中不写盘；
 *  读=逐行解析重放（尾行撕裂/中段损坏重放到上一条完整事件、未知版本由调用方拒载）。 */
import * as fs from 'fs';
import * as path from 'path';
import type { ContextItem, HistoryStep, ModelTier, ReasoningEffort } from '../types';
import type { ChatItem, TodoItem } from './session';

/** 分档血缘（规格 2026-09-20 rewind+fork §5.1）：upToLine=源档 1-based 行号，新档含源档第 1..upToLine 行 */
export interface ForkedFrom {
  sourceSessionId: string;
  upToLine: number;
  kind: 'rewind' | 'fork';
}

/** write 影子快照条目：path=相对项目根 POSIX；deleted=true 表示写入时文件不存在（hash 置空串） */
export interface SnapshotEntry {
  path: string;
  hash: string;
  deleted?: true;
}

export interface JournalHeader {
  t: 'header';
  v: number;
  id: string;
  createdAt: string;
  /** 分档来源（branchFrom 产物；原生会话档无此字段） */
  forkedFrom?: ForkedFrom;
}

/** 封闭事件词汇 schema v1 */
export type JournalEvent =
  | JournalHeader
  | { t: 'user'; text: string; files?: SnapshotEntry[] }
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
  /** 分档血缘（branchFrom 产物；原生会话档无此字段） */
  forkedFrom?: ForkedFrom;
}

export interface ParsedJournal {
  events: JournalEvent[];
  /** 与 events 一一对应的原始行（branchFrom 逐字节复制用） */
  lines: string[];
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
  const lines: string[] = [];
  let truncated = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.length === 0) continue;
    try {
      events.push(JSON.parse(line) as JournalEvent);
      lines.push(line);
    } catch {
      truncated = true;
      break;
    }
  }
  return { events, lines, truncated };
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

/** 档案列表（/resume 无参展示）：mtime 降序；扫文件头 8 行取首条用户输入摘要与分档血缘（零重放成本） */
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
    let forked: ForkedFrom | undefined;
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n').slice(0, 8)) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as JournalEvent;
          if (e.t === 'header' && e.forkedFrom) {
            forked = e.forkedFrom;
            continue;
          }
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
    // 血缘标注随摘要单点拼接（/resume 列表展示面）
    const labeled = forked
      ? `↳ ${forked.kind} from ${forked.sourceSessionId.slice(0, 8)}${firstUser ? ' · ' + firstUser : ''}`
      : firstUser;
    metas.push({
      id: name.slice(0, -'.jsonl'.length),
      file,
      updatedAt,
      ...(labeled !== undefined ? { firstUser: labeled } : {}),
      ...(forked ? { forkedFrom: forked } : {}),
    });
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface JournalAnchor {
  line: number;
  text: string;
}

/** 任务锚点枚举（规格 D4）：每条 user 事件一个锚点（斜杠命令行不入菜单，含 /rewind //fork 自身入档行），line 为文件 1-based 行号 */
export function listAnchors(parsed: ParsedJournal): JournalAnchor[] {
  const anchors: JournalAnchor[] = [];
  parsed.events.forEach((e, i) => {
    if (e.t !== 'user' || e.text.startsWith('/')) return;
    anchors.push({ line: i + 1, text: e.text });
  });
  return anchors;
}

/**
 * 分档原语（规格 2026-09-20 rewind+fork §5.2）：复制源档第 1..upToLine 行到新档（第 2..upToLine 行逐字节相等），
 * header 重写（新 id / 新 createdAt / forkedFrom 血缘），写新档并切活动指针；源档零改动。
 * 任一前缀行非合法 JSON、upToLine 越界、源档缺失即 throw Error('INVALID_ARG: ...')，零副作用。
 */
export function branchFrom(
  dataDir: string,
  sourceId: string,
  upToLine: number,
  kind: 'rewind' | 'fork',
  opts?: { now?: Date },
): string {
  const srcFile = path.join(sessionsDir(dataDir), sourceId + '.jsonl');
  const all = fs.readFileSync(srcFile, 'utf8').split('\n');
  while (all.length > 0 && all[all.length - 1] === '') all.pop();
  if (!Number.isInteger(upToLine) || upToLine < 1 || upToLine > all.length) {
    throw new Error(`INVALID_ARG: upToLine out of range: ${upToLine} (file has ${all.length} lines)`);
  }
  const kept = all.slice(0, upToLine);
  for (let i = 0; i < kept.length; i++) {
    try {
      JSON.parse(kept[i]);
    } catch {
      throw new Error(`INVALID_ARG: source journal line ${i + 1} is not valid JSON`);
    }
  }
  const header = JSON.parse(kept[0]) as JournalHeader;
  if (header.t !== 'header') throw new Error('INVALID_ARG: source journal line 1 is not a header');
  const newId = newSessionId(opts?.now);
  const now = (opts?.now ?? new Date()).toISOString();
  // spread 保持原字段序，id/createdAt 原位覆盖，forkedFrom 尾追
  const newHeader: JournalHeader = { ...header, id: newId, createdAt: now, forkedFrom: { sourceSessionId: sourceId, upToLine, kind } };
  fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir(dataDir), newId + '.jsonl'), [JSON.stringify(newHeader), ...kept.slice(1)].join('\n') + '\n', 'utf8');
  writeActivePointer(dataDir, newId);
  return newId;
}

/** 会话日志写面：事件入缓冲（运行中不写盘）、flush 点批量落盘并维护活动指针；未建档 log 丢弃（空会话零文件） */
export class SessionJournal {
  private buf: JournalEvent[] = [];
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
    this.buf.push(header);
  }

  /** 轮转（/new）：清缓冲换新 id，新 header 入缓冲（旧档已在盘） */
  rotate(id: string): void {
    this.buf = [];
    this.id = id;
    const header: JournalHeader = { t: 'header', v: 1, id, createdAt: new Date().toISOString() };
    this.buf.push(header);
  }

  /** 续挂既有日志（/resume / --continue）：后续事件追加至同一文件，不重复 header */
  attach(id: string): void {
    this.buf = [];
    this.id = id;
  }

  log(event: JournalEvent): void {
    if (!this.id) return; // 未建档：事件丢弃（空会话零文件）
    this.buf.push(event);
  }

  /** flush 点：批量追加 + 活动指针更新；缓冲空为 no-op（不落盘不动指针） */
  flush(): boolean {
    if (!this.id || this.buf.length === 0) return false;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(path.join(this.dir, this.id + '.jsonl'), this.buf.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    this.buf = [];
    writeActivePointer(this.dataDir, this.id);
    return true;
  }

  /** 任务收口回填（规格 §6.1）：本任务 write 的影子快照清单补进该轮 user 事件；缓冲内无 user 事件返回 false */
  amendLastUser(files: SnapshotEntry[]): boolean {
    for (let i = this.buf.length - 1; i >= 0; i--) {
      if (this.buf[i].t === 'user') {
        if (files.length === 0) return true; // 空清单不写字段（与 v1 旧档形态一致）
        (this.buf[i] as Extract<JournalEvent, { t: 'user' }>).files = files;
        return true;
      }
    }
    return false;
  }
}
