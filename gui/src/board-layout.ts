import type { BoardTask } from './projection';

/**
 * G5 看板布局纯函数(任务简报契约):Kahn 分层 + 层内横排坐标——DAG 视图(svg)与
 * 任何渲染面的同一单点,零 React 依赖可独立桩测。
 * 分层口径:入度 = dependsOn 中「引用集合内任务」的边数(缺依赖视作无该边——daemon
 * 补发流交错时会话间互引天然出现,防御忽略);波次推进(Kahn),节点层 = 其依赖最长
 * 路径层 + 1,同波次即同层;层内按 id 序横排 x=i*160,层高 y=layer*90(盒 140×50,
 * 间留 20/40 呼吸位)。环成员(波次放不完的节点)全部置末层 maxLayer+1 按 id 序——
 * 分层布局不因脏数据炸裂,环可视化降级为同层并排。空板回 []。
 */

/** 布局节点:layer 分层序 + (x, y) svg 画布坐标(px) */
export interface BoardLayoutNode {
  id: string;
  layer: number;
  x: number;
  y: number;
}

/** 层内横向间距(x 步进)/ 层高(y 步进)——渲染面盒尺寸 140×50 的既定配套 */
export const LAYER_X_STEP = 160;
export const LAYER_Y_STEP = 90;

/** id 序(localeCompare numeric:任务 id 方言 t<seq> 自然序 t2 < t10) */
const byId = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

export function layoutBoard(tasks: BoardTask[]): BoardLayoutNode[] {
  if (tasks.length === 0) return [];
  const ids = new Set(tasks.map((t) => t.id));
  // 入度/邻接表:缺依赖(引用不存在任务)的边忽略
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    indeg.set(t.id, 0);
    dependents.set(t.id, []);
  }
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!ids.has(d)) continue;
      indeg.set(t.id, (indeg.get(t.id) ?? 0) + 1);
      dependents.get(d)!.push(t.id);
    }
  }
  // Kahn 波次推进:同波次同层(节点层 = 依赖最长路径层 + 1);层内 id 序确定性横排
  const layerOf = new Map<string, number>();
  let frontier = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id).sort(byId);
  let layer = 0;
  while (frontier.length > 0) {
    for (const id of frontier) layerOf.set(id, layer);
    const next = new Set<string>();
    for (const id of frontier) {
      for (const dep of dependents.get(id)!) {
        const n = (indeg.get(dep) ?? 1) - 1;
        indeg.set(dep, n);
        if (n === 0) next.add(dep);
      }
    }
    frontier = [...next].sort(byId);
    layer += 1;
  }
  // 环防御:未放置成员全部置末层(已放置 maxLayer+1;全环时 layer=0 即层 0),按 id 序
  const cycle = tasks.map((t) => t.id).filter((id) => !layerOf.has(id)).sort(byId);
  for (const id of cycle) layerOf.set(id, layer);
  // 逐层组装:层升序、层内 id 序(cycle 已并入末层集合统一排序)
  const byLayer = new Map<number, string[]>();
  const maxLayer = cycle.length > 0 ? layer : layer - 1;
  for (const t of tasks) {
    const l = layerOf.get(t.id) ?? 0;
    const bucket = byLayer.get(l) ?? [];
    bucket.push(t.id);
    byLayer.set(l, bucket);
  }
  const nodes: BoardLayoutNode[] = [];
  for (let l = 0; l <= maxLayer; l += 1) {
    const bucket = (byLayer.get(l) ?? []).sort(byId);
    bucket.forEach((id, i) => {
      nodes.push({ id, layer: l, x: i * LAYER_X_STEP, y: l * LAYER_Y_STEP });
    });
  }
  return nodes;
}
