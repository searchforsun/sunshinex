import { sanitizeArtifacts, sanitizeChanges, sanitizeTurn, parseWakeRefs, type KernelEntry, type RunMeta } from './entry';
import type { KernelEvent, SteerItem } from './kernel';
import type { JournalEvent } from './journal';
import type { ChainAction } from '../types';

/**
 * v3 段级行重放(session-kernel spec §3.2 装载序;journal v3 零兼容,P11-T2 正名 seglog):
 * seg/run-open/seg-update/truncate/runmeta 行 → KernelEntry 列(seq 原样保留,truncate 行 upToSeq 可对位)。
 * chain/compact/model/todos/view 等 v1 行由 reduceJournal 另路(上下文/参数面);msg 面归 P3。纯件零 IO。
 *
 * 语义(v3 读侧零归一——档即 v3 写面单形态,无旧形态可归):seg 行零变换直读(md 原样——user 裸文/tool
 * 恒空,不剥前缀不重组);seg-update 只做字段回填(name/input/result);run-open 开 run 条;runmeta 行对位
 * 末个 run 条 meta 合入(changes 经 sanitize);末尾悬空 run(无 runmeta 对位——daemon 随重启已死)标
 * `meta.stopped=true` 回放显「已停止」;悬空 tool 行(result 永不到达=执行体已死)补 interrupted result
 * ——v3 自身语义,非旧档归一。
 */

/** 内核段级事件 → v3 行(write 映射单点,daemon(P2)/TUI(P3) 写者共用):
 *  seg-open 的 run→run-open 行、assistant/thinking 开启段不落(等 seg-close)、其余即终态落 seg 行
 *  (tool 带 result 时回填行随落);seg-close 落闭合段终态;seg-update 落回填行;truncate 落截断行。
 *  shadow 行(面事件透传):task- → board 行(原始 SessionEvent,回种侧经 boardEventFrom
 *  翻译折叠);delegation- → delegation 行;子智能体流 → subagent 行——凡界面可见皆落库,渲染层回溯共用。 */
export function kernelEventRows(ev: KernelEvent): JournalEvent[] {
  if (ev.t === 'shadow') {
    const e = ev.e;
    if (e.type.startsWith('task-')) return [{ t: 'board', e }];
    if (e.type.startsWith('delegation-')) return [{ t: 'delegation', e }];
    return [{ t: 'subagent', e }];
  }
  if (ev.t === 'truncate') return [{ t: 'truncate', upToSeq: ev.upToSeq }];
  if (ev.t === 'runmeta') {
    // open run meta 增量落行(2026-10-31 用户裁定「步数统计要持久化」):fields 缺省=undefined,
    // runMetaOf 净化面按缺省不覆盖(行面字段不予信任既有口径);对位=reduceSegRows 末个 run 条
    const m = ev.entry.meta;
    if (m === undefined) return [];
    return [{ t: 'runmeta', ...(m.steps !== undefined ? { steps: m.steps } : {}), ...(m.runSteps !== undefined ? { runSteps: m.runSteps } : {}), ...(m.tokens !== undefined ? { tokens: m.tokens } : {}), ...(m.cacheTokens !== undefined ? { cacheTokens: m.cacheTokens } : {}), ...(m.turn !== undefined && m.turn.length > 0 ? { turn: m.turn } : {}), ...(m.artifacts !== undefined && m.artifacts.length > 0 ? { artifacts: m.artifacts } : {}) }];
  }
  if (ev.t === 'steer') return [{ t: 'steer', items: ev.items.map((x) => ({ seq: x.seq, text: x.text, front: x.front, ...(x.images !== undefined ? { images: x.images } : {}) })) }];
  if (ev.t === 'stats') return []; // 统计面不落档(P9):非转录,装载自 run meta 重建
  const e = ev.entry;
  if (ev.t === 'seg-open') {
    if (e.kind === 'run') return [{ t: 'run-open', ts: e.ts, seq: e.seq }];
    if (ev.open && (e.kind === 'assistant' || e.kind === 'thinking')) return []; // 开启段:等闭合落终态
      const rows: JournalEvent[] = [
        {
          t: 'seg',
          kind: e.kind,
          md: e.md,
          ts: e.ts,
          seq: e.seq,
          ...(e.images !== undefined ? { images: e.images } : {}),
          ...(e.callId !== undefined ? { callId: e.callId } : {}),
          ...(e.name !== undefined ? { name: e.name } : {}),
          ...(e.input !== undefined ? { input: e.input } : {}),
          ...(e.seconds !== undefined ? { seconds: e.seconds } : {}),
          ...(e.wake !== undefined ? { wake: e.wake } : {}),
          ...(e.schedule !== undefined ? { schedule: e.schedule } : {}),
          ...(e.restored !== undefined ? { restored: e.restored } : {}),
        },
      ];
    if (e.kind === 'tool' && e.result !== undefined) rows.push({ t: 'seg-update', seq: e.seq, ts: e.ts, result: e.result });
    return rows;
  }
  if (ev.t === 'seg-close') {
    if (e.kind !== 'assistant' && e.kind !== 'thinking') return []; // 发射面只产正文/思考闭合(防御性)
    return [
      {
        t: 'seg',
        kind: e.kind,
        md: e.md,
        ts: e.ts,
        seq: e.seq,
        ...(e.images !== undefined ? { images: e.images } : {}),
        ...(e.seconds !== undefined ? { seconds: e.seconds } : {}),
      },
    ];
  }
  return [
    {
      t: 'seg-update',
      seq: e.seq,
      ts: e.ts,
      ...(e.name !== undefined ? { name: e.name } : {}),
      ...(e.input !== undefined ? { input: e.input } : {}),
      ...(e.result !== undefined ? { result: e.result } : {}),
      ...(e.images !== undefined ? { images: e.images } : {}),
    },
  ];
}

/** v3 段级行的载荷面(journal 行的松散形态——行解析自 JSON,字段不予信任;v1 行字段在列仅为透传类型面) */
export interface SegRowLike {
  t?: unknown;
  kind?: unknown;
  md?: unknown;
  ts?: unknown;
  seq?: unknown;
  /** 行随行图片附件（dataURL 串数组；行面字段不予信任——imagesOf 净化回落。user 附件+tool
   *  结果图(2026-10-31 截屏回显)全 kind 通用,读侧不再按 kind 设门） */
  images?: unknown;
  callId?: unknown;
  name?: unknown;
  input?: unknown;
  seconds?: unknown;
  result?: unknown;
  /** 行随唤醒引用(bg-wake spec §5.1;行面字段不予信任——parseWakeRefs 净化,旧档无此字段=普通 notice) */
  wake?: unknown;
  /** 行随定时唤醒标记（2026-11-15 sunx P2 Task 3;行面字段不予信任——严判 true,旧档无此字段=普通 notice） */
  schedule?: unknown;
  /** 行随恢复唤醒轮标记（2026-11-15 sunx P2 Task 5,R9;行面字段不予信任——严判 true,旧档无此字段=普通 notice） */
  restored?: unknown;
  /** wake-schedule 机制行载荷（同下 id/fireAt/note/taskSpec/firedAt——行面字段不予信任） */
  fireAt?: unknown;
  note?: unknown;
  taskSpec?: unknown;
  firedAt?: unknown;
  /** pending 机制行载荷（2026-11-15 sunx P2 Task 4;同下 pid/req/outcome——行面字段不予信任,
   *  kind 键与 seg 行共用 unknown 透传位,由 t 判别） */
  pid?: unknown;
  req?: unknown;
  outcome?: unknown;
  upToSeq?: unknown;
  stopped?: unknown;
  endedTs?: unknown;
  changes?: unknown;
  steps?: unknown;
  runSteps?: unknown;
  tokens?: unknown;
  cacheTokens?: unknown;
  /** 轮次 checkpoint 行(runmeta.turn;行面字段不予信任,sanitizeTurn 净化) */
  turn?: unknown;
  /** 轮次产物行(runmeta.artifacts;行面字段不予信任,sanitizeArtifacts 净化) */
  artifacts?: unknown;
  /** v1 行透传面(header/chain)——转录读面忽略,类型上允许整行入列 */
  v?: unknown;
  id?: unknown;
  createdAt?: unknown;
  /** P5 steer 行(items 整列重写;转录读面忽略,steer 读面专取) */
  items?: unknown;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** 行面 images 净化（dataURL 或本地图片文件地址串数组；非串项丢弃、空列回落 undefined——行面字段
 *  不予信任）。2026-10-31 images-cache 裁定后落档形态=绝对文件地址（恒正斜杠），dataURL 为旧档
 *  兼容形态——两者都收；无扩展名又非 data: 的串仍弃（行面字段不予信任口径不破） */
function imagesOf(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter(
    (x): x is string =>
      typeof x === 'string' &&
      (x.startsWith('data:image/') || /^https?:\/\//i.test(x) || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(x)),
  );
  return out.length > 0 ? out : undefined;
}

/** runmeta 净化合入(行面字段不予信任;seconds 等数值面缺省即不覆盖) */
function runMetaOf(row: SegRowLike, prev: RunMeta | undefined): RunMeta {
  const changes = sanitizeChanges(row.changes);
  const turn = sanitizeTurn(row.turn);
  const artifacts = sanitizeArtifacts(row.artifacts);
  return {
    ...(prev ?? {}),
    ...(num(row.seconds) !== undefined ? { seconds: num(row.seconds) } : {}),
    ...(num(row.steps) !== undefined ? { steps: num(row.steps) } : {}),
    ...(num(row.runSteps) !== undefined ? { runSteps: num(row.runSteps) } : {}),
    ...(num(row.tokens) !== undefined ? { tokens: num(row.tokens) } : {}),
    ...(num(row.cacheTokens) !== undefined ? { cacheTokens: num(row.cacheTokens) } : {}),
    ...(num(row.endedTs) !== undefined ? { endedTs: num(row.endedTs) } : {}),
    ...(row.stopped === true ? { stopped: true } : {}),
    ...(changes !== undefined && changes.length > 0 ? { changes } : {}),
    ...(turn !== undefined && turn.length > 0 ? { turn } : {}),
    ...(artifacts !== undefined && artifacts.length > 0 ? { artifacts } : {}),
  };
}

/** 结果回填面净化(result 载荷不予信任:text 字符串/ok 布尔/full 全文可选,缺省回落)。
 *  G14.2xx 修复:full(完整 observation)必须保留——text 恒 200 字符截断回执,丢了 full 回放后
 *  工具展开体只剩一两行回执(skill 正文/write diff 等全量消费面全残) */
function resultOf(raw: unknown): { text: string; ok: boolean; full?: string } | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined;
  const o = raw as { text?: unknown; ok?: unknown; full?: unknown };
  const full = typeof o.full === 'string' && o.full !== '' ? o.full : undefined;
  return { text: typeof o.text === 'string' ? o.text : '', ok: o.ok !== false, ...(full !== undefined ? { full } : {}) };
}

/** 行列 → 转录条目(未知行型忽略;坏行字段缺省回落——行级容错与 parseJournalFile 截断互补) */
export function reduceSegRows(rows: ReadonlyArray<SegRowLike>): KernelEntry[] {
  const entries: KernelEntry[] = [];
  let seq = 0;
  for (const row of rows) {
    if (row.t === 'truncate') {
      const upTo = num(row.upToSeq) ?? 0;
      while (entries.length > 0 && (entries[entries.length - 1]?.seq ?? 0) > upTo) entries.pop();
      continue;
    }
    if (row.t === 'run-open') {
      seq = num(row.seq) ?? seq + 1;
      entries.push({ seq, ts: num(row.ts) ?? 0, kind: 'run', md: '' });
      continue;
    }
    if (row.t === 'seg') {
      const kind = str(row.kind);
      if (kind !== 'user' && kind !== 'assistant' && kind !== 'tool' && kind !== 'thinking' && kind !== 'notice' && kind !== 'error') continue;
      seq = num(row.seq) ?? seq + 1;
      const callId = str(row.callId);
      const name = str(row.name);
      const input = row.input !== undefined && typeof row.input === 'object' && row.input !== null ? (row.input as Record<string, unknown>) : undefined;
      const seconds = num(row.seconds);
      // images 全 kind 通用(user 附件+tool 结果图;2026-10-31 截屏回显——读侧不再按 kind 设门)
      const images = imagesOf(row.images);
      // wake 唤醒引用净化(bg-wake spec §5.1;行面字段不予信任,旧档无字段回落 undefined=普通 notice)
      const wake = parseWakeRefs(row.wake);
      entries.push({
        seq,
        ts: num(row.ts) ?? 0,
        kind,
        md: str(row.md) ?? '',
        ...(images !== undefined ? { images } : {}),
        ...(callId !== undefined ? { callId } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(input !== undefined ? { input } : {}),
        ...(wake !== undefined ? { wake } : {}),
        ...(row.schedule === true ? { schedule: true as const } : {}),
        ...(row.restored === true ? { restored: true as const } : {}),
        ...(kind === 'thinking' && seconds !== undefined ? { seconds } : {}),
      });
      continue;
    }
    if (row.t === 'seg-update') {
      const target = num(row.seq);
      const idx = target !== undefined ? entries.findIndex((e) => e.seq === target) : -1;
      if (idx < 0) continue;
      const cur = entries[idx]!;
      if (cur.kind !== 'tool') continue;
      const name = str(row.name);
      const input = row.input !== undefined && typeof row.input === 'object' && row.input !== null ? (row.input as Record<string, unknown>) : undefined;
      const result = resultOf(row.result);
      const backfillImages = imagesOf(row.images);
      entries[idx] = { ...cur, ...(name !== undefined ? { name } : {}), ...(input !== undefined ? { input } : {}), ...(result !== undefined ? { result } : {}), ...(backfillImages !== undefined ? { images: backfillImages } : {}) };
      continue;
    }
    if (row.t === 'runmeta') {
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const e = entries[i]!;
        if (e.kind === 'run') {
          entries[i] = { ...e, meta: runMetaOf(row, e.meta) };
          break;
        }
      }
      continue;
    }
    // v1 行(chain/compact/model/todos/view/snapshots/msg)与未知行:转录面忽略(另路读面)
  }
  // 悬空 run(run-open 无收尾 runmeta/endedTs):daemon 重启被杀即 run 已死——标停止态,回放显
  // 「已停止」非永转。2026-11-18 修正:遍历**全部** run 条——中断轮可能不是末个(后续轮另开
  // run-open 后旧悬空轮被挤到中间,只查末个会让它显示「已运行」并漏出轮尾复制/分叉行)
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i]!;
    if (e.kind !== 'run' || e.meta?.endedTs !== undefined || e.meta?.stopped === true) continue;
    entries[i] = { ...e, meta: { ...e.meta, stopped: true } };
  }
  // 悬空 tool 行收口(渲染中立 spec §7.4;v3 自身语义,非旧档归一):result 永不到达=执行体已死——
  // 补 interrupted result(渲染 ✗,不永转)。status 不落行:装载面条目恒终态,done 以缺省承载
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.kind === 'tool' && e.result === undefined) entries[i] = { ...e, result: { text: '(interrupted)', ok: false } };
  }
  return entries;
}

/** steer 行读面(P5,spec §12):扫全行取**末条** steer 行(整列重写语义=末行为准),字段净化回落
 *  (text 非串弃、front 严判 true、seq 非负夹取);无 steer 行回空列。 */
export function reduceSteerRows(rows: ReadonlyArray<SegRowLike>): SteerItem[] {
  let items: SteerItem[] = [];
  for (const row of rows) {
    if (row.t !== 'steer' || !Array.isArray(row.items)) continue;
    const next: SteerItem[] = [];
    let seq = 0;
    for (const raw of row.items) {
      if (raw === null || typeof raw !== 'object') continue;
      const o = raw as { seq?: unknown; text?: unknown; front?: unknown; images?: unknown };
      const text = str(o.text);
      const images = imagesOf(o.images);
      if (text === undefined || text.trim() === '') continue;
      const s = num(o.seq);
      next.push({ seq: s !== undefined && s >= 0 ? s : seq, text, front: o.front === true, ...(images !== undefined ? { images } : {}) });
      seq += 1;
    }
    items = next;
  }
  return items;
}

// ===== 定时调度（2026-11-15 sunx P2 Task 3）：wake-schedule 机制行读面（attach 重布防数据源） =====

/** 定时调度记录（机制行词汇 {id, fireAt, note, taskSpec?, firedAt?} 的净化形态——TimerController
 *  调度位/serve 落档/attach 重布防三方同一形态）。firedAt=终态时刻（到点触发**或**被新调度替换——
 *  两者都终结调度位；回放面按在场即跳过，「已触发不重发」与「被替换不复活」同一闸门） */
export interface WakeScheduleRecord {
  id: string;
  /** 触发时刻 epoch ms */
  fireAt: number;
  /** 模型面通知文正文（schedule_task=label ?? spec 首行——兼作到点 fork 派发的台账任务名） */
  note: string;
  /** schedule_task 到点自动派发的自包含简报；缺席=纯唤醒（schedule_wakeup） */
  taskSpec?: string;
  /** 终态时刻（触发/被替换；缺席=未触发态——attach 重布防 re-arm 对象） */
  firedAt?: number;
}

/** wake-schedule 机制行读面（P2 Task 3）：按 id 取**末行**（append-only——arm 未触发态行在前、
 *  firedAt 终态行在后，末行为准同 steer 行语义）；行面字段不予信任逐条严判（id/fireAt/note 任一
 *  缺席或类型非法即整行弃——坏行不炸读面）。旧档无此行=空列（行为不变）。写面=serve/session.ts
 *  logScheduleRow 直落 journal（runmeta 直写先例——arm 非内核转录事件，不经 kernelEventRows） */
export function reduceWakeScheduleRows(rows: ReadonlyArray<SegRowLike>): WakeScheduleRecord[] {
  const byId = new Map<string, WakeScheduleRecord>();
  for (const row of rows) {
    if (row.t !== 'wake-schedule') continue;
    const id = str(row.id);
    const fireAt = num(row.fireAt);
    const note = str(row.note);
    if (id === undefined || id === '' || fireAt === undefined || note === undefined || note === '') continue;
    const firedAt = num(row.firedAt);
    const taskSpec = str(row.taskSpec);
    byId.set(id, {
      id,
      fireAt,
      note,
      ...(taskSpec !== undefined && taskSpec !== '' ? { taskSpec } : {}),
      ...(firedAt !== undefined ? { firedAt } : {}),
    });
  }
  return [...byId.values()];
}

// ===== 挂起持久化（2026-11-15 sunx P2 Task 4）：pending-open/pending-resolve 机制行读面（attach 回放素材源） =====

/** pending 机制行挂起种类（与 SnapshotPendingRow/挂起表三态同源——serve/session 挂起面判定单点） */
type PendingRowKind = 'ask' | 'approval' | 'plan-approval';

/** 恢复轮素材（attach 回放面产出——Task 5 恢复轮 notice 消费;凡界面可见皆落库延伸的挂起形态）:
 *  pid=存档铸造票据（审计寻址键,新 run 不复用）;title=人读面（ask=question 原文/approval=subject/
 *  plan-approval=name ?? 计划书首行）;options/askedBy 仅 ask 携带（问题原文+选项+归因=裁定 ② 的
 *  素材全量——恢复后的 Sunx 在新 run 重新处理,不复活原 promise） */
export interface PendingMaterial {
  pid: string;
  kind: PendingRowKind;
  title: string;
  /** ask 选项 label 列（人读面;非 ask 或空列缺席） */
  options?: string[];
  /** ask 发起方归因（子智能体问线直通主对话,2026-11-14;主链直问/非 ask 缺席） */
  askedBy?: { label: string; taskId?: string };
}

/** 已决挂起审计行（已答的行仅审计——裁定 ①;material 同构+outcome 结果摘要,入 resolved 列） */
type PendingResolved = PendingMaterial & { outcome: string };

/** pending 机制行读面视图:open=未决（daemon 重启蒸发在内存表,档上 open 行无 resolve 对位=未决态）
 *  ——attach 回放转恢复轮素材（不复活 promise,不重建挂起表,不重发挂起帧）;resolved=已决（仅审计） */
interface PendingRowsView {
  open: PendingMaterial[];
  resolved: PendingResolved[];
}

/** pending-open 行素材提取（行面字段不予信任,逐字段严判——坏行整行弃）:pid/kind 任一缺席或非法、
 *  req 非对象、或人读面 title 提取不出（ask 缺 question/approval 缺 subject/plan 卡 doc 全空行）
 *  即弃——素材本质缺席的行无审计/恢复价值,宁缺勿造 */
function pendingMaterialOf(pid: unknown, kind: unknown, rawReq: unknown): PendingMaterial | undefined {
  const id = str(pid);
  if (id === undefined || id === '') return undefined;
  if (kind !== 'ask' && kind !== 'approval' && kind !== 'plan-approval') return undefined;
  if (rawReq === undefined || rawReq === null || typeof rawReq !== 'object') return undefined;
  const req = rawReq as Record<string, unknown>;
  if (kind === 'ask') {
    const question = str(req.question);
    if (question === undefined || question === '') return undefined;
    const options = Array.isArray(req.options)
      ? req.options.map((o) => (o !== null && typeof o === 'object' ? str((o as Record<string, unknown>).label) : undefined)).filter((x): x is string => x !== undefined)
      : [];
    const by = req.askedBy !== null && typeof req.askedBy === 'object' ? (req.askedBy as Record<string, unknown>) : undefined;
    const label = by !== undefined ? str(by.label) : undefined;
    const taskId = by !== undefined ? str(by.taskId) : undefined;
    return {
      pid: id,
      kind,
      title: question,
      ...(options.length > 0 ? { options } : {}),
      ...(label !== undefined && label !== '' ? { askedBy: { label, ...(taskId !== undefined && taskId !== '' ? { taskId } : {}) } } : {}),
    };
  }
  if (kind === 'approval') {
    const subject = str(req.subject);
    if (subject === undefined || subject === '') return undefined;
    return { pid: id, kind, title: subject };
  }
  // plan-approval：name 缺席回落计划书首个非空行（derivePlanName 同构的人读兜底——档面不再派生名）
  const name = str(req.name);
  const doc = str(req.doc) ?? '';
  const firstLine = doc.split('\n').map((l) => l.trim()).find((l) => l !== '');
  const title = name !== undefined && name !== '' ? name : firstLine;
  if (title === undefined || title === '') return undefined;
  return { pid: id, kind, title };
}

/** pending 机制行读面（P2 Task 4,与 reduceWakeScheduleRows 同构单点）：按 pid 配对——open 行登记
 *  素材（同 pid 末行为准）,resolve 行即配对终结（移入 resolved 列,行序=审计序）。孤儿 resolve
 *  （无 open 对位——open 行写失败/档撕裂）弃:kind/title 不可知,不伪造素材（行面字段不予信任）。
 *  坏行逐条跳过不炸读面;旧档无此行=空视图（行为不变）。写面=serve/session logPendingRow 直落
 *  journal（wake-schedule 同先例——挂起非内核转录事件,不经 kernelEventRows） */
export function reducePendingRows(rows: ReadonlyArray<SegRowLike>): PendingRowsView {
  const open = new Map<string, PendingMaterial>();
  const resolved: PendingResolved[] = [];
  for (const row of rows) {
    if (row.t === 'pending-open') {
      const m = pendingMaterialOf(row.pid, row.kind, row.req);
      if (m === undefined) continue;
      open.set(m.pid, m);
      continue;
    }
    if (row.t === 'pending-resolve') {
      const pid = str(row.pid);
      const outcome = str(row.outcome);
      if (pid === undefined || outcome === undefined || outcome === '') continue;
      const m = open.get(pid);
      if (m === undefined) continue; // 孤儿 resolve（无 open 对位）弃——不伪造素材
      open.delete(pid);
      resolved.push({ ...m, outcome });
    }
  }
  return { open: [...open.values()], resolved };
}

// ===== 崩溃兜底回灌(2026-10-30 spec §2):seg 面有而链没有的在飞窗口 → 链行 =====

/** 崩溃窗口提取:journal 顺序扫描,chain/compact 行落点即「此前 seg 行已入链」的水位标记——其后新增
 *  的 seg 行=未入链在飞窗口(崩溃档特征;轮边界入链后正常档窗口恒空)。返回 reduceSegRows 全集按
 *  seq > 水位过滤(truncate 行在全档重放中对位,窗口过滤在其后统一生效)。纯件零 IO。 */
export function crashWindowEntries(rows: ReadonlyArray<SegRowLike>): KernelEntry[] {
  let boundarySeq = 0;
  let seq = 0;
  for (const row of rows) {
    if (row.t === 'chain' || row.t === 'compact') boundarySeq = seq;
    const s = num(row.seq);
    if (s !== undefined && s > seq) seq = s;
  }
  return reduceSegRows(rows).filter((e) => e.seq > boundarySeq);
}

/** seg 条目 → 链行归约(兜底口径,非逐字节恢复):user→task;assistant→reply;thinking 前挂后继
 *  assistant(无后继自落 note);tool→tool-result 观察行(observation=result.full ?? text;悬空 tool
 *  已由 reduceSegRows 补 interrupted result,无回执面跳过);notice/error→note;run 条跳过。
 *  纯件零 IO,restore 消费方(TUI commands-session/daemon session-lifecycle)共用。 */
export function entriesToChainSteps(entries: readonly KernelEntry[]): Array<{ action?: ChainAction; observation: string; images?: string[]; reasoning?: string; thinkSeconds?: number }> {
  const out: Array<{ action?: ChainAction; observation: string; images?: string[]; reasoning?: string; thinkSeconds?: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.kind === 'run') continue;
    if (e.kind === 'user') {
      out.push({ action: 'task', observation: e.md, ...(e.images !== undefined && e.images.length > 0 ? { images: e.images } : {}) });
      continue;
    }
    if (e.kind === 'assistant') {
      out.push({ action: 'reply', observation: e.md });
      continue;
    }
    if (e.kind === 'thinking') {
      const next = entries[i + 1];
      if (next !== undefined && next.kind === 'assistant') {
        out.push({ action: 'reply', observation: next.md, reasoning: e.md, ...(e.seconds !== undefined ? { thinkSeconds: e.seconds } : {}) });
        i += 1; // 思考已并入后继正文行,后继跳过
        continue;
      }
      out.push({ action: 'note', observation: `[thinking] ${e.md}` });
      continue;
    }
    if (e.kind === 'tool') {
      const obs = e.result?.full ?? e.result?.text ?? '';
      if (obs === '') continue; // 配对残缺容错:无回执面跳过,不阻塞恢复
      out.push({ action: 'tool-result', observation: obs });
      continue;
    }
    if (e.kind === 'error') {
      out.push({ action: 'note', observation: `Error: ${e.md}` });
      continue;
    }
    if (e.kind === 'notice') {
      out.push({ action: 'note', observation: e.md });
    }
  }
  return out;
}
