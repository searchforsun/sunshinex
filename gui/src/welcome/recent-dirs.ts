/**
 * 浏览过的目录持久化（2026-11-21 用户需求「浏览的文件持久化进下拉框,避免切会话/关闭后还要重新选」）：
 * localStorage 记最近选择的目录（**不是项目登记**——与 workspace.json 解耦，选完即用、不建项目）。
 * 容量封顶 8（MRU 序，新在前）；路径比较 Windows 大小写不敏感（lower 归一）；空串/'default' 不记
 * （默认锚恒在候选首行，无需历史）。
 */
const KEY = 'sunshinex.recent-dirs';
const CAP = 8;

export function readRecentDirs(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [];
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && x !== '' && x !== 'default') : [];
  } catch {
    return [];
  }
}

/** 记一条（MRU 置顶、去重、封顶）；写失败静默（隐私模式） */
export function rememberDir(root: string): string[] {
  const p = root.trim();
  if (p === '' || p === 'default') return readRecentDirs();
  const prev = readRecentDirs();
  const norm = p.toLowerCase();
  const next = [p, ...prev.filter((x) => x.toLowerCase() !== norm)].slice(0, CAP);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 静默 */
  }
  return next;
}

/** 存在性剪枝（2026-11-21 用户补充「文件夹被删除:打开时验证,不存在剔除」）：exists 回调判活的保留，
 *  其余从历史与 localStorage 移除；返回剪枝后的列表（无变化时零写入） */
export function pruneRecentDirs(exists: (root: string) => boolean): string[] {
  const prev = readRecentDirs();
  const next = prev.filter((p) => exists(p));
  if (next.length !== prev.length) {
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* 静默 */
    }
  }
  return next;
}
