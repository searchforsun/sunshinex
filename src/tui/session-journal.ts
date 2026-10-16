/** 会话事件日志（规格 docs/superpowers/specs/2026-09-17-session-persistence-resume-design.md D1/D3/D4/D5）：
 *  每会话一文件 data/sessions/<sessionId>.jsonl 追加只增。
 *  事件词汇封闭枚举 schema v1：新增持久化状态必须先登记新事件类型 + 对应重放动作 + 重放一致性断言，三者同批。
 *  写=事件级即时落盘（逐事件 append，运行中即写，崩溃丢失窗口=在飞一步；生命周期点写 header，
 *  规格 docs/superpowers/specs/2026-09-22-event-level-journal-persistence-design.md）；
 *  读=逐行解析重放（尾行撕裂/中段损坏重放到上一条完整事件、未知版本由调用方拒载）。 */
import * as fs from 'fs';
import * as path from 'path';
import type { ContextItem, HistoryStep, ModelTier, ReasoningEffort } from '../types';
import type { ChatItem, TodoItem } from './session';

/** 分档血缘（规格 2026-09-20 rewind+fork §5.1）：upToLine=源档 1-based 行号，新档含源档第 1..upToLine 行 */
interface ForkedFrom {
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

interface JournalHeader {
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
  | { t: 'snapshots'; files: SnapshotEntry[] }
  | { t: 'msg'; item: ChatItem }
  /** 已入档消息的终态覆盖（2026-09-30 归档富化回写）：subagent 归档把 detail/subagentMeta 富化进既有 SPAWN 调用行——
   *  归档时该行已以 'msg' 入档，不回写即 resume/rewind 回放退回裸调用行、Ctrl+B 历史归档全消失（真机「6 个只显示 1 个」） */
  | { t: 'msg-update'; item: ChatItem }
  | { t: 'chain'; steps: HistoryStep[] }
  | { t: 'compact'; chainFrom: number; compacted: ContextItem[] }
  | { t: 'todos'; items: TodoItem[] }
  /** 用户级会话参数快照（末值覆盖）：tier=档位、effort=思考强度、modelId=/model 选择（`源/模型`；undefined 字段=该项回缺省） */
  | { t: 'model'; tier?: ModelTier; effort?: ReasoningEffort; modelId?: string }
  | { t: 'view'; expandAll: boolean; latestFull: boolean }
  /** G14.15 run 收尾元数据(GUI Worked 行/统计回放):daemon run 结束时落——秒数/步数/tokens/结束时刻。
   *  G14.100 changes=本轮 git 变动增量(路径/状态/±行数)——GUI 轮尾汇总条(展开逐文件/撤销) */
  | { t: 'runmeta'; seconds?: number; steps?: number; runSteps?: number; tokens?: number; cacheTokens?: number; endedTs?: number; stopped?: boolean; changes?: Array<{ path: string; status: string; added: number | null; deleted: number | null }> };

export interface SessionMeta extends SessionSidecarMeta {
  id: string;
  file: string;
  updatedAt: number;
  firstUser?: string;
  /** 建档时刻（journal header createdAt 直读；旁车不另存创建时间防双源漂移） */
  createdAt?: string;
  forkedFrom?: ForkedFrom;
}

/** 会话级旁车元数据（G14.17：<dataDir>/sessions/<id>.meta.json，单文件读改写合并——
 *  daemon run 收尾与 TUI closeTask 同构写入，rename 写标题；列表/回溯面零重放直读） */
export interface SessionSidecarMeta {
  /** 自定义会话名（G14.16 标题统一流；缺省回落 firstUser 摘要） */
  title?: string;
  /** 末次活动 epoch ms（run 收尾/closeTask；列表排序仍以 journal mtime 为准） */
  updatedAt?: number;
  /** 累计 run 数（TUI 侧取台账 summary().runs，serve 侧逐 run +1） */
  runs?: number;
  /** 累计链步数 */
  steps?: number;
  /** 累计 tokens（主链口径；TUI 另记子代理 childTokens） */
  tokens?: number;
  /** 累计运行秒数 */
  seconds?: number;
  /** 累计 prompt 缓存命中 tokens（reactor usage 事件 cacheHitTotal 口径） */
  cacheTokens?: number;
  /** 累计 prompt tokens（真实上下文逐请求消耗） */
  promptTokens?: number;
  /** 累计子代理 tokens（TUI 口径；serve 暂缺子代理聚合不写） */
  childTokens?: number;
  /** 末次上文占用（ctx 事件 exact 权威值；快照语义非累计） */
  ctxUsed?: number;
  /** 末次窗口预算（resolveRunWindow 同源） */
  ctxWindow?: number;
  /** 末次模型（id/label/provider 同源字符串） */
  model?: string;
  /** 末次思考强度 */
  effort?: string;
  /** 辅助会话标记(G14.29 /btw /side 旁路档)——listSessions 全列表滤除,不进 RECENTS 与 /resume */
  side?: boolean;
}

const SIDECAR_KEYS: ReadonlyArray<keyof SessionSidecarMeta> = [
  'title', 'updatedAt', 'runs', 'steps', 'tokens', 'seconds',
  'cacheTokens', 'promptTokens', 'childTokens', 'ctxUsed', 'ctxWindow', 'model', 'effort', 'side',
];
/** 字符串值键（其余键一律 number 值，类型不合法即弃该键防脏数据回流） */
const SIDECAR_STR_KEYS: ReadonlySet<string> = new Set(['title', 'model', 'effort']);
/** 布尔值键（G14.29 side 辅助会话标记） */
const SIDECAR_BOOL_KEYS: ReadonlySet<string> = new Set(['side']);

/** 读会话旁车元数据：缺失/坏 JSON/未知键一律容错（未知键丢弃防脏数据回流），值类型不合法即弃该键 */
export function readSessionMeta(dataDir: string, id: string): SessionSidecarMeta {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(sessionsDir(dataDir), id + '.meta.json'), 'utf8')) as Record<string, unknown>;
    const out: SessionSidecarMeta = {};
    for (const k of SIDECAR_KEYS) {
      const v = raw[k];
      if (SIDECAR_STR_KEYS.has(k)) {
        if (typeof v === 'string' && v.trim() !== '') (out as Record<string, unknown>)[k] = v;
      } else if (SIDECAR_BOOL_KEYS.has(k)) {
        if (typeof v === 'boolean') (out as Record<string, unknown>)[k] = v;
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        (out as Record<string, unknown>)[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** 写会话旁车元数据（读改写合并单点）：patch 只落已知键且剔除 undefined——调用方自行
 *  读旧值算累计（runs/tokens 等加法语义在调用面，本帮手只管合并与原子性） */
export function writeSessionMeta(dataDir: string, id: string, patch: SessionSidecarMeta): void {
  const merged = { ...readSessionMeta(dataDir, id) };
  for (const k of SIDECAR_KEYS) {
    const v = patch[k];
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
  }
  fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir(dataDir), id + '.meta.json'), JSON.stringify(merged), 'utf8');
}

interface ParsedJournal {
  events: JournalEvent[];
  /** 与 events 一一对应的原始行（branchFrom 逐字节复制用） */
  lines: string[];
  truncated: boolean;
}

interface JournalReplay {
  version: number | undefined;
  chain: HistoryStep[];
  chainFrom: number;
  compacted: ContextItem[];
  messages: ChatItem[];
  nextSeq: number;
  history: string[];
  todos: TodoItem[];
  tier?: ModelTier;
  effort?: ReasoningEffort;
  /** /model 选择 id（`源/模型`；undefined = 缺省主模型） */
  modelId?: string;
  view: { expandAll: boolean; latestFull: boolean };
}

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

/** todos 载荷三态归一（规格 D8）：旧档 {text, done} 布尔形态 → status（done:true→completed / false→pending），新载荷原样通过 */
function normalizeTodoItems(raw: unknown[]): TodoItem[] {
  return raw.map((it) => {
    const o = (it ?? {}) as { text?: unknown; status?: unknown; done?: unknown };
    const text = typeof o.text === 'string' ? o.text : '';
    if (o.status === 'pending' || o.status === 'in_progress' || o.status === 'completed') return { text, status: o.status };
    return { text, status: o.done === true ? 'completed' : 'pending' };
  });
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
      case 'msg-update': {
        // 消息终态覆盖：同 seq 原位替换（append-only 序不动）；基行缺失（崩溃窗口内 update 先行落盘）防御性追加，内容不蒸发
        const idx = r.messages.findIndex((m) => m.seq === e.item.seq);
        if (idx >= 0) r.messages[idx] = e.item;
        else r.messages.push(e.item);
        r.nextSeq = Math.max(r.nextSeq, e.item.seq);
        break;
      }
      case 'user':
        r.history.push(e.text);
        break;
      case 'todos':
        r.todos = normalizeTodoItems(e.items as unknown[]);
        break;
      case 'model':
        r.tier = e.tier;
        r.effort = e.effort;
        r.modelId = e.modelId;
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
      // 扫目录竞态：readdir 与 stat 之间档案被并发删除/轮转清理即 ENOENT——跳过该档案继续列目录，不让单文件消失击穿整个 /resume 列表
      continue;
    }
    let firstUser: string | undefined;
    let forked: ForkedFrom | undefined;
    let headerCreatedAt: string | undefined;
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n').slice(0, 8)) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as JournalEvent;
          if (e.t === 'header') {
            headerCreatedAt = e.createdAt;
            if (e.forkedFrom) forked = e.forkedFrom;
            continue;
          }
          if (e.t === 'user') {
            firstUser = e.text;
            break;
          }
          // daemon(GUI)会话不落 user 行——goal 以链首 task 步入档(serve/session.ts appendInstructionLine);
          // 首条链行即取首个 task 观测作摘要,否则侧栏列表恒「无摘要」(TUI 会话有 user 行,先到先取不受扰)
          if (e.t === 'chain') {
            const task = e.steps.find((s) => s.action === 'task' && s.observation.length > 0);
            if (task !== undefined) {
              firstUser = task.observation;
              break;
            }
          }
        } catch {
          // 坏行截断停止摘要扫描：头 8 行内出现撕裂/损坏行（事件级落盘的在飞崩溃窗口）即后续行不可信——
          // 停止取 firstUser/forkedFrom，列表项退化为无摘要形态（不误读错位内容当摘要）
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
    const sid = name.slice(0, -'.jsonl'.length);
    const side = readSessionMeta(dataDir, sid);
    if (side.side === true) continue; // G14.29:辅助会话不进任何列表(RECENTS//resume//sessions)
    metas.push({
      id: sid,
      file,
      updatedAt,
      ...(labeled !== undefined ? { firstUser: labeled } : {}),
      ...side,
      ...(headerCreatedAt !== undefined ? { createdAt: headerCreatedAt } : {}),
      ...(forked ? { forkedFrom: forked } : {}),
    });
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt);
}

interface JournalAnchor {
  line: number;
  text: string;
}

/** 任务锚点枚举（规格 D4）：每条 user 事件一个锚点（斜杠命令行不入菜单，含 /rewind //fork 自身入档行），line 为文件 1-based 行号 */
export function listAnchors(parsed: ParsedJournal): JournalAnchor[] {
  const anchors: JournalAnchor[] = [];
  let sawUser = false;
  parsed.events.forEach((e, i) => {
    if (e.t === 'user' && !e.text.startsWith('/')) {
      sawUser = true;
      anchors.push({ line: i + 1, text: e.text });
    }
  });
  if (sawUser) return anchors;
  // G14.29:daemon(GUI)档只落 chain(无 user 行)——以链内 task 行为轮锚点,
  // rewind/fork 的寻址面对 GUI 会话同样成立(TUI 档 user 行路径不变)
  parsed.events.forEach((e, i) => {
    if (e.t !== 'chain') return;
    for (const st of e.steps) {
      if (st.action === 'task' && st.observation.length > 0) anchors.push({ line: i + 1, text: st.observation });
    }
  });
  return anchors;
}

/**
 * 分档原语（规格 2026-09-20 rewind+fork §5.2）：复制源档第 1..upToLine 行到新档（第 2..upToLine 行逐字节相等），
 * header 重写（新 id / 新 createdAt / forkedFrom 血缘），写新档；源档零改动。
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
  return newId;
}

/** 会话日志写面（事件级即时落盘，规格 2026-09-22 D1/D3）：逐事件 appendFileSync、生命周期点写 header；未建档 log 丢弃（空会话零文件） */
export class SessionJournal {
  private id: string | undefined;
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = sessionsDir(dataDir);
  }

  get currentId(): string | undefined {
    return this.id;
  }

  /** 建档（首个持久化事件触发）：生成 id，header 立即写盘 */
  start(): void {
    if (this.id) return;
    this.startId(newSessionId());
  }

  /** 轮转（/new）：换新 id，新 header 立即写盘（旧档已在盘零改动） */
  rotate(id: string): void {
    this.startId(id);
  }

  /** 续挂既有日志（/resume / --continue / 分档）：档已在盘，仅切 id，不重复 header */
  attach(id: string): void {
    this.id = id;
  }

  /** 事件级落盘（规格 D1）：逐事件 append，运行中即写，崩溃丢失窗口=在飞一步；未建档丢弃 */
  log(event: JournalEvent): void {
    if (!this.id) return;
    fs.appendFileSync(path.join(this.dir, this.id + '.jsonl'), JSON.stringify(event) + '\n', 'utf8');
  }

  /** 任务收口快照清单补拍（规格 D2）：本任务 write 的影子快照清单以 snapshots 事件尾追；空清单零事件 */
  seal(files: SnapshotEntry[]): void {
    if (!this.id || files.length === 0) return;
    this.log({ t: 'snapshots', files });
  }

  private startId(id: string): void {
    this.id = id;
    fs.mkdirSync(this.dir, { recursive: true });
    const header: JournalHeader = { t: 'header', v: 1, id, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(this.dir, id + '.jsonl'), JSON.stringify(header) + '\n', 'utf8');
  }
}
