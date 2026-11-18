/**
 * 块高度表按会话持久(2026-11-18 结构性改造完全体):虚拟窗口的高度表原先随组件挂载新建——
 * 切走再切回,所有块退回估算值,滚动条比例/冷开恢复位/总高都要重新校准。这里按会话档
 * (journalId 优先,同滚动存档口径)做进程内 LRU:重挂即命中上次实测高度,首帧 spacer 与
 * 滚动条比例一次到位;条目 key 在会话内稳定(快照键同源),rewind 后新增块自然走估算。
 *
 * 容量:每档 ≤6000 块(≈6000 条用户/工具块;超出按插入序淘汰最旧),档数 ≤6——四座 LRU +
 * 少量余量,内存上界约 6000×6×~40B ≈ 1.4MB。
 */
const SCOPES = 6;
const PER_SCOPE_MAX = 6000;
const store = new Map<string, Map<string, number>>();

export function unitHeightsFor(scope: string): Map<string, number> {
  const hit = store.get(scope);
  if (hit !== undefined) {
    // LRU 触碰:最近使用的档放队尾
    store.delete(scope);
    store.set(scope, hit);
    return hit;
  }
  const m = new Map<string, number>();
  store.set(scope, m);
  if (store.size > SCOPES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  return m;
}

/** 写高并守容量(插入序淘汰最旧;返回容量内剩余数) */
export function rememberUnitHeight(scope: string, key: string, h: number): void {
  const m = store.get(scope);
  if (m === undefined) return;
  m.set(key, h);
  while (m.size > PER_SCOPE_MAX) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}

/** 测试/诊断:某档当前高度条目数 */
export function unitHeightCount(scope: string): number {
  return store.get(scope)?.size ?? 0;
}
