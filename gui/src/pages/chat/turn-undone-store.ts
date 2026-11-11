/**
 * 轮次撤销持久化(2026-11-12 用户裁定「撤销后聚合行不应该再出现」):restored 原是组件内存态,
 * 切会话回来重挂即复现——落 localStorage,journal+run(+path) 为键,跨重挂/重启稳定。
 * 形态 { [journalId]: { [runSeq]: { all?: true, paths?: string[] } } };journalId 缺场(新座)
 * 不持久化,仅会话内内存语义。
 */
const KEY = 'sunshinex.turn-undone';

export interface TurnUndoneShape {
  [journalId: string]: { [runSeq: string]: { all?: true; paths?: string[] } };
}

export function loadTurnUndone(): TurnUndoneShape {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as TurnUndoneShape;
    return raw !== null && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function save(shape: TurnUndoneShape): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(shape));
  } catch {
    /* 隐私模式等持久化失败:仅内存态生效,不阻断 */
  }
}

export function runUndone(shape: TurnUndoneShape, journalId: string, run: number): boolean {
  return shape[journalId]?.[String(run)]?.all === true;
}

export function undonePaths(shape: TurnUndoneShape, journalId: string, run: number): ReadonlySet<string> {
  return new Set(shape[journalId]?.[String(run)]?.paths ?? []);
}

export function markRunUndone(journalId: string, run: number): TurnUndoneShape {
  const shape = loadTurnUndone();
  const seat = (shape[journalId] ?? {});
  seat[String(run)] = { all: true as const };
  shape[journalId] = seat;
  save(shape);
  return shape;
}

export function markPathUndone(journalId: string, run: number, path: string): TurnUndoneShape {
  const shape = loadTurnUndone();
  const seat = (shape[journalId] ?? {});
  const entry = seat[String(run)] ?? {};
  if (entry.all !== true) {
    const paths = new Set(entry.paths ?? []);
    paths.add(path);
    entry.paths = [...paths];
  }
  seat[String(run)] = entry;
  shape[journalId] = seat;
  save(shape);
  return shape;
}
