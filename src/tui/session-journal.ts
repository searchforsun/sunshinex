/** 会话事件日志（规格 docs/superpowers/specs/2026-09-17-session-persistence-resume-design.md D1/D3/D4/D5）：
 *  每会话一文件 data/sessions/<sessionId>.jsonl 追加只增。
 *  事件词汇封闭枚举 schema v1：新增持久化状态必须先登记新事件类型 + 对应重放动作 + 重放一致性断言，三者同批。
 *  写=事件级即时落盘（逐事件 append，运行中即写，崩溃丢失窗口=在飞一步；生命周期点写 header，
 *  规格 docs/superpowers/specs/2026-09-22-event-level-journal-persistence-design.md）；
 *  读=逐行解析重放（尾行撕裂/中段损坏重放到上一条完整事件、未知版本由调用方拒载）。 */
import * as fs from 'fs';
import * as path from 'path';
import type { ContextItem, HistoryStep, ModelTier, ReasoningEffort, SessionEvent } from '../types';
import { utcCompactStamp } from '../idstamp';
import type { ChatItem, TodoItem } from './session';
// CtxSnapshot 类型定义在上下文域（src/harness/context/index.ts）——journal 是持久化层，type-only import 防反向依赖；
// 此处 re-export 保 Task 1 消费方零改动
import type { CtxSnapshot } from '../harness/context/index';
export type { CtxSnapshot };

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
  | { t: 'runmeta'; seconds?: number; steps?: number; runSteps?: number; tokens?: number; cacheTokens?: number; endedTs?: number; stopped?: boolean; changes?: Array<{ path: string; status: string; added: number | null; deleted: number | null }>; turn?: import('../types').TurnFileChange[] }
  // ===== v3 段级行(session-kernel spec §3.2,journal v3 档专用;reduceJournal 忽略——TUI 重放不受扰) =====
  /** 转录段行:即终态条目(user/notice/error/tool)与闭合段(assistant/thinking,seconds=思考秒);seq=live 序号原样随档(truncate 对位依赖)。
   *  v3 写面单形态(P11-T2 渲染中立):user md=裸文、tool md 恒 ''(字段单源,读侧零归一) */
  | { t: 'seg'; kind: 'user' | 'assistant' | 'tool' | 'thinking' | 'notice' | 'error'; md: string; ts: number; seq: number; images?: string[]; callId?: string; name?: string; input?: Record<string, unknown>; seconds?: number }
  /** 工具条回填行(重放按 seq upsert:name/input/result 缺面回填——纯字段回填,无 md 重算) */
  | { t: 'seg-update'; seq: number; ts: number; name?: string; input?: Record<string, unknown>; result?: { text: string; ok: boolean } }
  /** run 条开启行(md='' 条目;收尾统计由 runmeta 行对位,悬空 run-open 重放标 stopped) */
  | { t: 'run-open'; ts: number; seq: number }
  /** 视界截断行(rewind/compact/reset;upToSeq=0 即全清;重放在流中位置即时生效) */
  | { t: 'truncate'; upToSeq: number }
  /** 等待队列行(P5 内核化 spec §12;整列重写——每次变更一行全量,重放取末行为准;reduceJournal 忽略) */
  | { t: 'steer'; items: Array<{ seq: number; text: string; front: boolean; images?: string[] }> }
  /** 板面影子投影行(G14.2xx 内核层落库):task-/gate- 面事件原件落档(内核 shadow 透传)——attach 回种
   *  影子投影时经 boardEventFrom 翻译折叠,重启/重连/换渲染层后板面不再空;reduceJournal 忽略 */
  | { t: 'board'; e: SessionEvent }
  /** 委派影子投影行(同上):delegation 起止事件原件落档(applyDelegation 直接消费),attach 回种委派面 */
  | { t: 'delegation'; e: SessionEvent }
  /** 子智能体流影子投影行(同上):payload.subagent 标签事件原件落档——attach 以帧重放给渲染层,
   *  子智能体活动面(agent 页签)跨重启/换渲染层可重建;reduceJournal 忽略 */
  | { t: 'subagent'; e: SessionEvent }
  /** 会话前缀快照落档行(2026-10-31 spec:会话档生命周期快照冻结):items=快照条目,
   *  sig=漂移基线签名;重放末条合法行为准,载荷不合法的行视同不存在(v3 零兼容,未知行双向可忽略) */
  | { t: 'ctx-snap'; items: unknown; sig: unknown };

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
  /** 累计 tokens（主链口径；TUI 另记子智能体 childTokens） */
  tokens?: number;
  /** 累计运行秒数 */
  seconds?: number;
  /** 累计 prompt 缓存命中 tokens（reactor usage 事件 cacheHitTotal 口径） */
  cacheTokens?: number;
  /** 累计 prompt tokens（真实上下文逐请求消耗） */
  promptTokens?: number;
  /** 累计子智能体 tokens（TUI 口径；serve 暂缺子智能体聚合不写） */
  childTokens?: number;
  /** 末次上文占用（ctx 事件 exact 权威值；快照语义非累计） */
  ctxUsed?: number;
  /** 末次窗口预算（resolveRunWindow 同源） */
  ctxWindow?: number;
  /** 末次模型（id/label/provider 同源字符串） */
  model?: string;
  /** 末次思考强度 */
  effort?: string;
  /** 权限模式(G14.2xx 运行中切换即刻落,attach 回放——重启不再回落缺省;值域 dontAsk/manual/plan) */
  mode?: string;
  /** 辅助会话标记(G14.29 /btw /side 旁路档)——listSessions 全列表滤除,不进 RECENTS 与 /resume */
  side?: boolean;
  /** 辅助会话编号(2026-10-31 用户裁定):父档 sideCount=N 持久化,辅助档题=辅助对话 N */
  sideCount?: number;
  /** 辅助会话回指父档 journalId(重进主会话列其辅助对话) */
  sideOf?: string;
  /** 辅助会话自身序号(fork 建档时落档,标题仅展示不承载语义——nextSideSeq 推导单源;存量档无此键
   *  回退标题正则) */
  sideSeq?: number;
  /** 归档标记(2026-10-21):纯标记态——主列表/RECENTS/TUI /resume 滤除,会话本体零行为差异 */
  archived?: boolean;
  /** 归档时刻 epoch ms(归档页排序;撤销即删键) */
  archivedAt?: number;
  /** GUI 编辑重发/回到此轮的旧时间线标记(2026-11-05):值=接替它的新档 id。档保留在盘,
   *  listSessions 滤除——否则每回退一次列表多一条同名会话 */
  rewoundTo?: string;
}

const SIDECAR_KEYS: ReadonlyArray<keyof SessionSidecarMeta> = [
  'title', 'updatedAt', 'runs', 'steps', 'tokens', 'seconds',
  'cacheTokens', 'promptTokens', 'childTokens', 'ctxUsed', 'ctxWindow', 'model', 'effort', 'mode', 'side',
  'archived', 'archivedAt', 'sideCount', 'sideOf', 'sideSeq', 'rewoundTo',
];
/** 字符串值键（其余键一律 number 值，类型不合法即弃该键防脏数据回流） */
const SIDECAR_STR_KEYS: ReadonlySet<string> = new Set(['title', 'model', 'effort', 'mode', 'sideOf', 'rewoundTo']);
/** 布尔值键（G14.29 side 辅助会话标记 / archived 归档标记） */
const SIDECAR_BOOL_KEYS: ReadonlySet<string> = new Set(['side', 'archived']);

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

/** 辅助对话 fork 档视图起点裁剪（2026-10-31 用户裁定「只 fork 继承上下文,不显示之前的时间线」）：
 *  剥转录面行（seg/seg-update/run-open/runmeta/subagent/delegation/board/todos/snapshots/msg 等）,
 *  留 header/ctx-snap/chain/compact/steer——模型侧上下文完整继承(chain 行即主链),GUI 视图从空时间线
 *  开始(辅助对话自己的段行随对话增量落档)。坏行保留(半行撕裂由装载侧容错);handleBranch side 分支
 *  与测试同调此单点 */
export function pruneSideForkArchive(dataDir: string, id: string): void {
  const file = path.join(sessionsDir(dataDir), `${id}.jsonl`);
  const kept = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => {
      if (line === '') return false;
      try {
        const r = JSON.parse(line) as { t?: unknown };
        return r.t === 'header' || r.t === 'ctx-snap' || r.t === 'chain' || r.t === 'compact' || r.t === 'steer';
      } catch {
        return true;
      }
    });
  fs.writeFileSync(file, `${kept.join('\n')}\n`, 'utf8');
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

/** 归档打标/撤销(读改写+原子语义同 writeSessionMeta):archived=true 落 archived+archivedAt;
 *  false 两键同删(撤销)——writeSessionMeta 无删键路径,此处自管合并体 */
export function markSessionArchived(dataDir: string, id: string, archived: boolean): void {
  const merged = { ...readSessionMeta(dataDir, id) } as Record<string, unknown>;
  if (archived) {
    merged.archived = true;
    merged.archivedAt = Date.now();
  } else {
    delete merged.archived;
    delete merged.archivedAt;
  }
  fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir(dataDir), id + '.meta.json'), JSON.stringify(merged), 'utf8');
}

/** 会话真清(purge,受控删除唯一落点):sessions 目录内 `<id>.` 前缀全家(journal/meta/transcript 等
 *  伴生档)+ 两面会话私有档(gui/sessions/<id>.json、tui/sessions/<id>.json——后者现状无档,条件清理)。
 *  工作区级档(tui/ui-state.json 等)不触;缺文件静默跳过(幂等) */
export function purgeSession(dataDir: string, id: string): void {
  const dir = sessionsDir(dataDir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  for (const f of names) {
    if (!f.startsWith(`${id}.`)) continue;
    try {
      fs.rmSync(path.join(dir, f), { force: true, recursive: true });
    } catch {
      /* 单文件失败不阻断全家清理(幂等重试可达) */
    }
  }
  const slugDir = path.dirname(dataDir);
  for (const p of [path.join(slugDir, 'gui', 'sessions', `${id}.json`), path.join(slugDir, 'tui', 'sessions', `${id}.json`)]) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* 幂等 */
    }
  }
  // 会话绑定旁档(2026-11-06 用户裁定「会话删除后一并删除」):任务板账本+会话级团队目录
  // (`<dataDir>/tasks/ledger-<id>.jsonl`、`<dataDir>/teams/<id>/`——均以 journalId 键,缺文件静默幂等)
  try {
    fs.rmSync(path.join(dataDir, 'tasks', `ledger-${id}.jsonl`), { force: true });
  } catch {
    /* 幂等 */
  }
  try {
    fs.rmSync(path.join(dataDir, 'teams', id), { force: true, recursive: true });
  } catch {
    /* 幂等 */
  }
}

/** 主 journal 的辅助会话 journal id 清单(meta.sideOf 回指扫描;目录不可读=空列) */
export function sideJournalsOf(dataDir: string, id: string): string[] {
  const dir = sessionsDir(dataDir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const f of names) {
    if (!f.endsWith('.meta.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { side?: unknown; sideOf?: unknown };
      if (meta.side !== true || meta.sideOf !== id) continue;
      out.push(f.slice(0, -'.meta.json'.length));
    } catch {
      /* 坏 meta 行跳过 */
    }
  }
  return out;
}

/** 辅助会话连带清理(2026-11-06 用户裁定「只有删除主会话后,才一同删除辅助会话内容」):
 *  side 全家逐个 purgeSession(档+gui/tui 页签态+任务板账本+团队目录),返回被清 journal id
 *  供调用方(删除面)接力清浏览器状态/pty 锚杀 */
export function purgeSideJournals(dataDir: string, id: string): string[] {
  const out: string[] = [];
  for (const jid of sideJournalsOf(dataDir, id)) {
    purgeSession(dataDir, jid);
    out.push(jid);
  }
  return out;
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
  /** 会话前缀快照（ctx-snap 归约；末条合法行为准，载荷不合法视同不存在） */
  snapshot?: CtxSnapshot;
}

/** 会话 id：UTC 紧凑时间戳 + 4 位随机尾（文件名安全、可排序） */
export function newSessionId(now = new Date()): string {
  return `${utcCompactStamp(now)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 会话日志目录：<dataDir>/sessions */
export function sessionsDir(dataDir: string): string {
  return path.join(dataDir, 'sessions');
}

/** 会话索引文件名（派生物，语义对齐 memory/MEMORY.md）：listSessions 每次全量重建 */
export const SESSIONS_INDEX_NAME = 'INDEX.md';

/** 会话索引重建（OKF index 件，模型可读面的定位单点）：listSessions 收尾时由元数据全量重写——
 *  行形态 `- <id> | <updatedAt ISO> | <标题/摘要截断 80 字> | <标记>`（updatedAt 降序 = 列表同序）。
 *  写失败旁路降级不击穿列表（索引是派生物，丢行了下次 listSessions 重建即可）。 */
function writeSessionsIndex(dataDir: string, metas: SessionMeta[]): void {
  const lines = metas.map((m) => {
    const summary = (m.title ?? m.firstUser ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const marks: string[] = [];
    if (m.archived === true) marks.push('archived');
    if (m.sideOf !== undefined) marks.push(`side-of-${m.sideOf}`);
    const stamp = new Date(m.updatedAt).toISOString();
    return `- ${m.id} | ${stamp} | ${summary} | ${marks.join(',')}`;
  });
  const text = `# Session Index\n\n> <id>.transcript.md = readable projection; <id>.jsonl = byte-exact source of record.\n\n${lines.join('\n')}\n`;
  try {
    // 写前比对（2026-11-08 审计补：listSessions 是 /workspaces 计数面与侧栏刷新的公共路径——
    // 无变更照写=每次 GET 都动盘；派生物逐字节相同即跳过，churn 归零且新鲜度语义不变）
    const file = path.join(sessionsDir(dataDir), SESSIONS_INDEX_NAME);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
    fs.writeFileSync(file, text, 'utf8');
  } catch {
    /* 旁路：索引是派生物，失败不阻断列表消费 */
  }
}

/** 计划书落盘单点（2026-11-03 交稿协议）：`<dataDir>/sessions/<journalId>.plan.md` 覆盖写，
 *  返回绝对路径（GUI 经既有 /session/:id/file 端点打开——数据目录已放行,零新端点）。
 *  命名沿用 `<id>.` 旁车前缀先例（<id>.jsonl/<id>.meta.json 同族）：purgeSession 的前缀全家清理
 *  天然覆盖——删除会话即删除计划文件（删除即无痕纪律,零新增清理面）。每轮修订覆盖写（journal
 *  全量留档不受影响——链 'plan' 行与工具行才是权威事实源,文件是给人看的工件） */
export function writePlanDoc(dataDir: string, journalId: string, name: string, doc: string): string {
  const file = path.join(sessionsDir(dataDir), `${journalId}.plan.md`);
  fs.mkdirSync(sessionsDir(dataDir), { recursive: true });
  // 文件首行=计划名(2026-11-03 用户裁定「计划文件要有计划名」):提示词骨架不含 H1 标题——doc 无前导
  // `# ` 标题时前置 `# <name>`,有则保留原文(模型自拟标题优先,不双标题)
  const firstLine = doc.slice(0, Math.max(0, doc.indexOf('\n') + 1));
  const hasTitle = /^[ \t]*# /.test(firstLine);
  const body = hasTitle ? doc : `# ${name}\n\n${doc}`;
  fs.writeFileSync(file, body, 'utf8');
  return file;
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

/** ctx-snap 行面净化单点（行面字段不予信任——journal 既有口径）：任一字段形态不合法即整行视同不存在。
 *  part 五值闭集（2026-11-04 §2.1 扩 agents/teams——旧档三值行原样通过，五段行不再被误判坏档）；
 *  sig 两新字段可选（在场须为 string，缺省即旧档形态——restore 侧 `?? ''` 容错，归约面不吞不补） */
function normalizeCtxSnap(items: unknown, sig: unknown): CtxSnapshot | undefined {
  if (!Array.isArray(items) || typeof sig !== 'object' || sig === null) return undefined;
  const out: CtxSnapshot['items'] = [];
  for (const it of items) {
    const o = (it ?? {}) as { part?: unknown; kind?: unknown; content?: unknown };
    if ((o.part !== 'instructions' && o.part !== 'skills' && o.part !== 'agents' && o.part !== 'teams' && o.part !== 'memory') || typeof o.kind !== 'string' || typeof o.content !== 'string') return undefined;
    out.push({ part: o.part, kind: o.kind, content: o.content });
  }
  const s = sig as Record<string, unknown>;
  if (typeof s.skills !== 'string' || typeof s.memory !== 'string' || !(s.sunshinex === null || typeof s.sunshinex === 'string') || !(s.globalSunshine === null || typeof s.globalSunshine === 'string')) return undefined;
  if (!(s.agents === undefined || typeof s.agents === 'string') || !(s.teams === undefined || typeof s.teams === 'string')) return undefined;
  return {
    items: out,
    sig: {
      skills: s.skills,
      memory: s.memory,
      sunshinex: s.sunshinex as string | null,
      globalSunshine: s.globalSunshine as string | null,
      ...(typeof s.agents === 'string' ? { agents: s.agents } : {}),
      ...(typeof s.teams === 'string' ? { teams: s.teams } : {}),
    },
  };
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
    snapshot: undefined,
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
      case 'ctx-snap': {
        const snap = normalizeCtxSnap(e.items, e.sig);
        if (snap !== undefined) r.snapshot = snap; // 末行为准；不合法行视同不存在
        break;
      }
    }
  }
  return r;
}

/** 会话显示标题单点（fork 命名/快照血缘面消费）：meta.title 优先；未题名扫档头 8 行取首条
 *  用户输入/链首 task 观测（与 listSessions 摘要同口径）截 60 字；全空回退 fallback（调用方给
 *  root 名等），再退 journalId 短码。fork 子档题=`Fork of ${本值}`——父档已带前缀即递归链接 */
export function journalDisplayTitle(dataDir: string, journalId: string, fallback?: string): string {
  const meta = readSessionMeta(dataDir, journalId);
  if (meta.title !== undefined && meta.title.trim() !== '') return meta.title.trim();
  const file = path.join(sessionsDir(dataDir), `${journalId}.jsonl`);
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').slice(0, 8)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as JournalEvent;
        if (e.t === 'user' && e.text.trim() !== '') return e.text.trim().slice(0, 60);
        if (e.t === 'chain') {
          const task = e.steps.find((s) => s.action === 'task' && s.observation.length > 0);
          if (task !== undefined) return task.observation.trim().slice(0, 60);
        }
      } catch {
        break; // 坏行截断（事件级落盘在飞崩溃窗口），退 fallback
      }
    }
  } catch {
    /* 读失败退 fallback */
  }
  return fallback ?? journalId.slice(0, 8);
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
    if (side.rewoundTo !== undefined) continue;
    if (side.side === true) continue; // G14.29:辅助会话不进列表(RECENTS//resume//sessions)——2026-10-31 用户实时反馈「不要进主菜单」,持久化入口=主会话页签恢复(/session/:id/sides)
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
  const sorted = metas.sort((a, b) => b.updatedAt - a.updatedAt);
  writeSessionsIndex(dataDir, sorted);
  return sorted;
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
 * fork 含轮切点（2026-11-04 用户裁定「fork 显示点击点之上所有记录」→点击轮**整轮含**）：
 * 切在下一轮锚点行之前；紧贴切点的下轮 user 行回撤——GUI 档 SEG user 行先于其 task 链行落档
 * （实测父档 29=user 段/30=task 链行，切 29 即悬挂下轮输入气泡），TUI 档 user 事件行同形同撤。
 * 末轮（无下轮锚点）=整档长度。rewind 不走此函数（锚点行不进新档的规格语义不变）。
 */
export function forkIncludeCut(parsed: ParsedJournal, anchors: JournalAnchor[], turn: number): number {
  const next = anchors[turn]; // 1-based turn → 下一轮锚点 = anchors[turn]
  if (next === undefined) return parsed.lines.length;
  return retractDanglingUser(parsed, next.line - 1);
}

/** 自 cut 行起回撤紧贴切点的悬挂 user 行——GUI 档 SEG user 行先于其 task 链行落档（实测父档
 *  29=user 段/30=task 链行），TUI 档 user 事件行同形。rewind「锚点行不进新档」（规格 §5.2）在
 *  GUI 锚点面（chain 行）下须把该轮 user 段行一并排除：编辑重发/回到此轮语义=被编辑消息本体
 *  不进新档（否则原文+编辑文双显）；TUI 档锚点=user 行自身，cut 落在其前一行，本回撤对其零动。 */
export function retractDanglingUser(parsed: ParsedJournal, cut: number): number {
  while (cut > 1) {
    const ev = parsed.events[cut - 1];
    const danglingUser = ev !== undefined && (ev.t === 'user' || (ev.t === 'seg' && (ev as { kind?: string }).kind === 'user'));
    if (!danglingUser) break;
    cut -= 1;
  }
  return cut;
}

/** rewind 切点:cut=新档保留行数(1-based 末行),text=被回退的用户原文,ts=首个被丢弃行的时刻 */
export interface RewindCut {
  cut: number;
  text: string;
  ts?: number;
}

function rewindCutAt(parsed: ParsedJournal, cut: number, text: string): RewindCut {
  for (let i = cut; i < parsed.events.length; i += 1) {
    const ts = (parsed.events[i] as { ts?: unknown }).ts;
    if (typeof ts === 'number') return { cut, text, ts };
  }
  return { cut, text };
}

/** 按任务轮锚点定切点(回到此轮菜单):锚点行不进新档,紧贴的该轮 user 段行一并回撤 */
export function rewindCutOfTurn(parsed: ParsedJournal, turn: number): RewindCut | undefined {
  const anchor = listAnchors(parsed)[turn - 1];
  if (anchor === undefined) return undefined;
  return rewindCutAt(parsed, retractDanglingUser(parsed, anchor.line - 1), anchor.text);
}

/** 按用户消息倒序序号定切点(编辑重发):0=最后一条。不用任务轮寻址——轮内插入消息也落 task 链行,
 *  run 序与锚点序会错位;倒序不受转录尾窗分页影响 */
export function rewindCutOfUser(parsed: ParsedJournal, fromEnd: number): RewindCut | undefined {
  const rows: number[] = [];
  parsed.events.forEach((e, i) => {
    if (e.t === 'seg' && e.kind === 'user') rows.push(i);
  });
  const idx = rows[rows.length - 1 - fromEnd];
  if (idx === undefined || idx < 1) return undefined;
  return rewindCutAt(parsed, idx, (parsed.events[idx] as { md?: string }).md ?? '');
}

/** 账本+团队物理面整件克隆（copySessionStores/rewindSessionStores 共用件）——静态记录全量复制
 *  （fork 先例「之上静态内容记录完整复制」同口径；运行中任务/成员进程归会话进程=动态不复制） */
function copyLedgerAndTeams(dataDir: string, srcId: string, newId: string, cutoff?: number): void {
  const ledgerSrc = path.join(dataDir, 'tasks', `ledger-${srcId}.jsonl`);
  try {
    if (fs.existsSync(ledgerSrc)) {
      fs.mkdirSync(path.join(dataDir, 'tasks'), { recursive: true });
      if (cutoff === undefined) fs.copyFileSync(ledgerSrc, path.join(dataDir, 'tasks', `ledger-${newId}.jsonl`));
      else fs.writeFileSync(path.join(dataDir, 'tasks', `ledger-${newId}.jsonl`), filterLedger(ledgerSrc, cutoff), 'utf8');
    }
  } catch {
    /* 账本复制失败不阻断 */
  }
  try {
    const teamsSrc = path.join(dataDir, 'teams', srcId);
    if (fs.existsSync(teamsSrc)) {
      fs.cpSync(teamsSrc, path.join(dataDir, 'teams', newId), { recursive: true });
      if (cutoff !== undefined) filterTeamFace(path.join(dataDir, 'teams', newId), cutoff);
    }
  } catch {
    /* 团队面复制失败不阻断 */
  }
}

/** 账本按起点裁剪:丢弃起点及之后提交的任务(submit 行 startedAt 判)及其 finish 行——起点前
 *  已有任务保留完整生命周期(实际结局是事实);startedAt 缺失的旧行按未知保留(不裁) */
function filterLedger(ledgerSrc: string, cutoff: number): string {
  const out: string[] = [];
  const dropped = new Set<string>();
  for (const line of fs.readFileSync(ledgerSrc, 'utf8').split('\n')) {
    if (line.length === 0) continue;
    try {
      const row = JSON.parse(line) as { op?: string; task?: { id?: string; startedAt?: number }; id?: string };
      if (row.op === 'submit') {
        const startedAt = row.task?.startedAt;
        if (typeof startedAt === 'number' && startedAt >= cutoff && row.task?.id !== undefined) {
          dropped.add(row.task.id);
          continue;
        }
      } else if (row.op === 'finish' && row.id !== undefined && dropped.has(row.id)) {
        continue;
      }
    } catch {
      /* 坏行原样保留(重放侧跳过) */
    }
    out.push(line);
  }
  return out.length > 0 ? out.join('\n') + '\n' : '';
}

/** 团队物理面按起点裁剪(克隆件上就地裁):注册表/成员名册按 createdAt,板事件源按 ts(被丢弃
 *  团队的板任务事件整链裁掉,dependency-added 对端被裁也裁);board.json 快照缓存删除(载入走
 *  全量重放);inbox 消息与消费位点按 ts 裁(位点钳回被保留的最大 ts)。单件失败静默跳过 */
function filterTeamFace(teamDir: string, cutoff: number): void {
  filterJsonArrayByCreatedAt(path.join(teamDir, 'registry.json'), cutoff);
  filterJsonArrayByCreatedAt(path.join(teamDir, 'teammates.json'), cutoff);
  filterBoardEvents(path.join(teamDir, 'main', 'events.jsonl'), cutoff);
  filterInboxDir(path.join(teamDir, 'main', 'inbox'), cutoff);
  try {
    fs.rmSync(path.join(teamDir, 'main', 'board.json'), { force: true });
  } catch {
    /* 快照缓存清理失败不阻断(载入按事件重放) */
  }
}

function filterJsonArrayByCreatedAt(file: string, cutoff: number): void {
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{ createdAt?: number }>;
    if (!Array.isArray(rows)) return;
    const kept = rows.filter((r) => !(typeof r.createdAt === 'number' && r.createdAt >= cutoff));
    if (kept.length === rows.length) return;
    const tmp = `${file}.rewind-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(kept), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* 缺档/坏档:不裁不阻断 */
  }
}

function filterBoardEvents(eventsFile: string, cutoff: number): void {
  let lines: string[];
  try {
    lines = fs.readFileSync(eventsFile, 'utf8').split('\n');
  } catch {
    return; // 无板事件:零裁剪面
  }
  const dropped = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    try {
      const ev = JSON.parse(line) as { t?: string; taskId?: string; dependsOn?: string; ts?: number };
      if (ev.t === 'task-created' && ev.taskId !== undefined) {
        if (typeof ev.ts === 'number' && ev.ts >= cutoff) {
          dropped.add(ev.taskId);
          continue;
        }
        out.push(line);
        continue;
      }
      if (ev.t === 'dependency-added' && ((ev.taskId !== undefined && dropped.has(ev.taskId)) || (ev.dependsOn !== undefined && dropped.has(ev.dependsOn)))) continue;
      if (ev.taskId !== undefined && dropped.has(ev.taskId)) continue;
      out.push(line);
    } catch {
      out.push(line); // 坏行原样保留(载入侧跳过)
    }
  }
  try {
    fs.writeFileSync(eventsFile, out.length > 0 ? out.join('\n') + '\n' : '', 'utf8');
  } catch {
    /* 重写失败不阻断 */
  }
}

function filterInboxDir(inboxDir: string, cutoff: number): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(inboxDir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    filterInboxCursors(path.join(inboxDir, '..', '..', 'inbox-cursors.json'), cutoff, new Map<string, number>());
    return; // 无 inbox:零消息面,位点归零
  }
  const maxTsByAgent = new Map<string, number>();
  for (const name of names) {
    const file = path.join(inboxDir, name);
    try {
      const kept: string[] = [];
      let maxTs = 0;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (line.length === 0) continue;
        try {
          const m = JSON.parse(line) as { ts?: number };
          if (typeof m.ts === 'number' && m.ts >= cutoff) continue;
          kept.push(line);
          if (typeof m.ts === 'number') maxTs = Math.max(maxTs, m.ts);
        } catch {
          kept.push(line); // 坏行原样保留(读侧跳过)
        }
      }
      fs.writeFileSync(file, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
      maxTsByAgent.set(name.slice(0, -'.jsonl'.length), maxTs);
    } catch {
      /* 单文件失败不阻断 */
    }
  }
  filterInboxCursors(path.join(inboxDir, '..', '..', 'inbox-cursors.json'), cutoff, maxTsByAgent);
}

/** 位点钳回被保留的最大 ts;收件箱清空的 agent 位点删除(重放从头,至少一次投递语义不受损) */
function filterInboxCursors(cursorsFile: string, cutoff: number, maxTsByAgent: Map<string, number>): void {
  try {
    const cursors = JSON.parse(fs.readFileSync(cursorsFile, 'utf8')) as Record<string, number>;
    if (typeof cursors !== 'object' || cursors === null) return;
    for (const [agent, cursor] of Object.entries(cursors)) {
      if (cursor < cutoff) continue;
      // 钳回被保留的最大 ts(收件箱时钟自被保留消息重置,不钳则新消息 ts 低于旧位点=永不可见);
      // 无被保留消息则删除(位点归零,重放从头——至少一次投递语义不受损)
      const keptTs = maxTsByAgent.get(agent) ?? 0;
      if (keptTs > 0) cursors[agent] = Math.min(cursor, keptTs);
      else delete cursors[agent];
    }
    const tmp = `${cursorsFile}.rewind-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cursors), 'utf8');
    fs.renameSync(tmp, cursorsFile);
  } catch {
    /* 缺档/坏档:不裁不阻断 */
  }
}

/**
 * 会话级静态存储随 fork 复制（2026-11-04 用户裁定「fork 之上静态内容记录完整复制」）——三件
 * journalId 键控的物理面，fork 换 id 后子会话 adoptSessionStores 收养空壳即丢，此处逐一克隆：
 * ①后台任务账本 `<dataDir>/tasks/ledger-<jid>.jsonl`（静态记录；运行中任务归父会话进程=动态不复制）
 * ②智能体团队物理面 `<dataDir>/teams/<jid>/`（注册表/板/inbox 位点递归；成员进程动态不复制）
 * ③辅助对话档（meta sideOf 回指父档）：整档换 id 复制、sideOf 改指子档——子会话 sides 清单可见。
 * 待办/看板影子/子 agent 归档记录在 journal 行内,随 branchFrom 前缀复制原生覆盖,不在此列。
 * 单件失败不阻断 fork（尽力复制,查无文件静默跳过）。
 */
export function copySessionStores(dataDir: string, srcId: string, newId: string): void {
  copyLedgerAndTeams(dataDir, srcId, newId);
  const dir = sessionsDir(dataDir);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const sideJid = name.slice(0, -'.jsonl'.length);
    try {
      const meta = readSessionMeta(dataDir, sideJid);
      if (meta.side !== true || meta.sideOf !== srcId) continue;
      const lines = parseJournalFile(path.join(dir, name)).lines.length;
      const sideNewId = branchFrom(dataDir, sideJid, lines, 'fork');
      writeSessionMeta(dataDir, sideNewId, { side: true, ...(meta.title !== undefined ? { title: meta.title } : {}), sideOf: newId });
    } catch {
      /* 单个辅助档复制失败不阻断 */
    }
  }
}

/**
 * 会话级静态存储随 rewind 换档迁移（2026-11-05 编辑重发/回到此轮裁定「侧栏内容回退到当前点」）：
 * rewind 同 visible id 换挂新 journal，attach 收养面按新 id 扫描——不迁移即账本/团队面收养空壳、
 * 辅助对话 sideOf 回指旧档 sides 清单变空。①账本 ②团队物理面：整件克隆（fork 先例同口径；
 * 旧档自带原件零改动，/resume 回原时间线仍可读）；③辅助对话档：同会话续档**不克隆**，sideOf
 * 原地改指新 journal id（writeSessionMeta 读改写合并，side/title 随档保留）；④旁车 meta（题/模型/
 * 权限档/辅助编号，attach 回放依赖）与 ⑤GUI 页签档（journalId 键控）随迁；账本/团队面按 cutoff
 * 严格裁到回退点（起点后提交的任务/创建的团队/成员/板任务/收件箱消息整链丢弃；起点前已有实体
 * 保留完整生命周期——实际结局是事实）。cutoff 缺省=全量复制（fork 同口径兜底）。
 * 单件失败尽力而为不阻断 rewind。
 */
export function rewindSessionStores(dataDir: string, srcId: string, newId: string, cutoff?: number): void {
  copyLedgerAndTeams(dataDir, srcId, newId, cutoff);
  writeSessionMeta(dataDir, newId, readSessionMeta(dataDir, srcId));
  try {
    const guiDir = path.join(path.dirname(dataDir), 'gui', 'sessions');
    const guiSrc = path.join(guiDir, `${srcId}.json`);
    if (fs.existsSync(guiSrc)) fs.copyFileSync(guiSrc, path.join(guiDir, `${newId}.json`));
  } catch {
    /* 页签档复制失败不阻断 */
  }
  const dir = sessionsDir(dataDir);
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const sideJid = name.slice(0, -'.jsonl'.length);
    try {
      const meta = readSessionMeta(dataDir, sideJid);
      if (meta.side !== true || meta.sideOf !== srcId) continue;
      writeSessionMeta(dataDir, sideJid, { sideOf: newId });
    } catch {
      /* 单个辅助档改指失败不阻断 */
    }
  }
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
  opts?: { now?: Date; inheritLineage?: boolean },
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
  // inheritLineage(GUI 回退):新档是同一会话的延续,不记 rewind 血缘(列表摘要不出「↳ rewind from」);
  // 源档自身的 fork 血缘在切点内才承继(分叉横幅靠 upToLine 定位),否则随被丢弃段失效
  const { forkedFrom: inherited, ...headerRest } = header;
  const lineage = opts?.inheritLineage === true
    ? (inherited !== undefined && inherited.upToLine <= upToLine ? { forkedFrom: inherited } : {})
    : { forkedFrom: { sourceSessionId: sourceId, upToLine, kind } };
  const newHeader: JournalHeader = { ...headerRest, id: newId, createdAt: now, ...lineage };
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

  /** 建档（首个持久化事件触发）：生成 id，header 立即写盘。version=档 schema 版本（v1=TUI 词汇;
   *  v2=+段级行;v3=渲染中立单形态,P11-T2 零兼容——全仓仅认 v:3,缺省 3） */
  start(version = 3): void {
    if (this.id) return;
    this.startId(newSessionId(), version);
  }

  /** 轮转（/new）：换新 id，新 header 立即写盘（旧档已在盘零改动）；v3=段级词汇单形态（P11-T2 起 TUI 档 v3） */
  rotate(id: string, version = 3): void {
    this.startId(id, version);
  }

  /** 续挂既有日志（/resume / --continue / 分档）：档已在盘，仅切 id，不重复 header */
  attach(id: string): void {
    this.id = id;
  }

  /** 事件级落盘（规格 D1）：逐事件 append，运行中即写，崩溃丢失窗口=在飞一步；未建档丢弃。
   *  旁车镜像（账本可读面）：user/终态 seg 事件同步追加人类可读行到 <id>.transcript.md——
   *  jsonl 是权威事实源（含 base64 快照/增量行，不适合模型直读），transcript 是供模型浏览的投影；
   *  镜像失败旁路降级不阻断主档落盘 */
  log(event: JournalEvent): void {
    if (!this.id) return;
    fs.appendFileSync(path.join(this.dir, this.id + '.jsonl'), JSON.stringify(event) + '\n', 'utf8');
    this.mirror(event);
  }

  /** transcript 镜像追加（user 事件与终态 seg 行；msg-update 增量/snapshots/seg-update/board 等机械行一概不入镜） */
  private mirror(event: JournalEvent): void {
    let line: string | undefined;
    if (event.t === 'user' && event.text.length > 0) {
      line = `[user] ${event.text}`;
    } else if (event.t === 'seg' && (event.kind === 'user' || event.kind === 'assistant' || event.kind === 'notice' || event.kind === 'error') && event.md.length > 0) {
      line = `[${event.kind}] ${event.md}`;
    }
    if (line === undefined) return;
    line = `${line.replace(/\s+/g, ' ').trim().slice(0, 500)}\n`;
    try {
      fs.appendFileSync(path.join(this.dir, this.id + '.transcript.md'), line, 'utf8');
    } catch {
      /* 旁路：镜像是投影，失败不阻断主档 */
    }
  }

  /** 任务收口快照清单补拍（规格 D2）：本任务 write 的影子快照清单以 snapshots 事件尾追；空清单零事件 */
  seal(files: SnapshotEntry[]): void {
    if (!this.id || files.length === 0) return;
    this.log({ t: 'snapshots', files });
  }

  private startId(id: string, version = 3): void {
    this.id = id;
    fs.mkdirSync(this.dir, { recursive: true });
    const header: JournalHeader = { t: 'header', v: version, id, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(this.dir, id + '.jsonl'), JSON.stringify(header) + '\n', 'utf8');
  }
}
