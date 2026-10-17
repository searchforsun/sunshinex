import { sanitizeChanges, toolMd, type KernelEntry, type RunMeta } from './entry';

/**
 * v2 段级行重放(session-kernel spec §3.2 装载序):seg/run-open/seg-update/truncate/runmeta 行 →
 * KernelEntry 列(seq 原样保留,truncate 行 upToSeq 可对位)。chain/compact/model/todos/view 等
 * v1 行由 reduceJournal 另路(上下文/参数面);msg 面归 P3。纯件零 IO。
 *
 * 语义:seg 行直映射(tool 行 md 先按行面,seg-update 回填 result 后重算 `● name\n⎿ 首行`);
 * run-open 开 run 条;runmeta 行对位末个 run 条 meta 合入(changes 经 sanitize);
 * 末尾悬空 run(无 runmeta 对位——daemon 随重启已死)标 `meta.stopped=true`,回放显「已停止」。
 */

/** v2 段级行的载荷面(journal 行的松散形态——行解析自 JSON,字段不予信任;v1 行字段在列仅为透传类型面) */
export interface V2RowLike {
  t?: unknown;
  kind?: unknown;
  md?: unknown;
  ts?: unknown;
  seq?: unknown;
  callId?: unknown;
  name?: unknown;
  input?: unknown;
  seconds?: unknown;
  result?: unknown;
  upToSeq?: unknown;
  stopped?: unknown;
  endedTs?: unknown;
  changes?: unknown;
  steps?: unknown;
  runSteps?: unknown;
  tokens?: unknown;
  cacheTokens?: unknown;
  /** v1 行透传面(header/chain)——转录读面忽略,类型上允许整行入列 */
  v?: unknown;
  id?: unknown;
  createdAt?: unknown;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** runmeta 净化合入(行面字段不予信任;seconds 等数值面缺省即不覆盖) */
function runMetaOf(row: V2RowLike, prev: RunMeta | undefined): RunMeta {
  const changes = sanitizeChanges(row.changes);
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
  };
}

/** 结果回填面净化(result 载荷不予信任:text 字符串/ok 布尔缺省回落) */
function resultOf(raw: unknown): { text: string; ok: boolean } | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined;
  const o = raw as { text?: unknown; ok?: unknown };
  return { text: typeof o.text === 'string' ? o.text : '', ok: o.ok !== false };
}

/** 行列 → 转录条目(未知行型忽略;坏行字段缺省回落——行级容错与 parseJournalFile 截断互补) */
export function reduceV2Rows(rows: ReadonlyArray<V2RowLike>): KernelEntry[] {
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
      entries.push({
        seq,
        ts: num(row.ts) ?? 0,
        kind,
        md: str(row.md) ?? '',
        ...(callId !== undefined ? { callId } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(input !== undefined ? { input } : {}),
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
      const next: KernelEntry = {
        ...cur,
        ...(name !== undefined ? { name } : {}),
        ...(input !== undefined ? { input } : {}),
        ...(result !== undefined ? { result } : {}),
      };
      // md 重算:result 回填取其首行;仅 name 回填则保留行面既有 ⎿ 结果行(live verb 回填同语义)
      const line =
        next.result !== undefined
          ? next.result.text.split('\n')[0] ?? ''
          : (() => {
              const m = cur.md.indexOf('⎿ ');
              return m >= 0 ? cur.md.slice(m + 2) : '';
            })();
      next.md = toolMd(next.name ?? '…', line.length > 0 ? line : '…');
      entries[idx] = next;
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
  // 悬空 run(run-open 无 runmeta 对位):daemon 重启即 run 已死——标停止态,回放显「已停止」非永转
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i]!;
    if (e.kind !== 'run') continue;
    if (e.meta?.endedTs === undefined) entries[i] = { ...e, meta: { ...e.meta, stopped: true } };
    break; // 只看末个 run 条(在途只可能有一个)
  }
  return entries;
}
