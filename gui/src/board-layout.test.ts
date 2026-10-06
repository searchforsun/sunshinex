import { describe, it, expect } from 'vitest';
import { layoutBoard } from './board-layout';
import type { BoardTask } from './projection';

/**
 * G5 layoutBoard 纯函数测(任务简报契约):Kahn 分层——线性链逐层下沉、菱形同层、
 * 环成员防御置末层(maxLayer+1 按 id 序)、缺依赖边忽略、空板 []。坐标口径:层内
 * x=i*160 横排、层 y=layer*90。
 */

const task = (id: string, over: Partial<BoardTask> = {}): BoardTask => ({
  id,
  title: id,
  spec: '',
  status: 'pending',
  dependsOn: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const byId = (rows: Array<{ id: string; layer: number; x: number; y: number }>): Record<string, { layer: number; x: number; y: number }> =>
  Object.fromEntries(rows.map((r) => [r.id, { layer: r.layer, x: r.x, y: r.y }]));

describe('layoutBoard:Kahn 分层(纯函数)', () => {
  it('空板回 []', () => {
    expect(layoutBoard([])).toEqual([]);
  });

  it('线性链 t1→t2→t3:三层逐层下沉(t1 层 0,t2/t3 各下一层);层内 x=i*160、层 y=layer*90', () => {
    const rows = layoutBoard([
      task('t1'),
      task('t2', { dependsOn: ['t1'] }),
      task('t3', { dependsOn: ['t2'] }),
    ]);
    const m = byId(rows);
    expect(m.t1).toEqual({ layer: 0, x: 0, y: 0 });
    expect(m.t2).toEqual({ layer: 1, x: 0, y: 90 });
    expect(m.t3).toEqual({ layer: 2, x: 0, y: 180 });
  });

  it('菱形:a;b,c dep a(同层横排);d dep b,c(末层)——层内 x 依 id 序横排', () => {
    const rows = layoutBoard([
      task('a'),
      task('b', { dependsOn: ['a'] }),
      task('c', { dependsOn: ['a'] }),
      task('d', { dependsOn: ['b', 'c'] }),
    ]);
    const m = byId(rows);
    expect(m.a).toEqual({ layer: 0, x: 0, y: 0 });
    // b/c 同层(层 1):id 序横排——b x=0、c x=160
    expect(m.b).toEqual({ layer: 1, x: 0, y: 90 });
    expect(m.c).toEqual({ layer: 1, x: 160, y: 90 });
    expect(m.d).toEqual({ layer: 2, x: 0, y: 180 });
  });

  it('环防御:d↔e(Kahn 放不完):环成员全部置末层 maxLayer+1 按 id 序;无环任务照常分层', () => {
    const rows = layoutBoard([
      task('a'),
      task('b', { dependsOn: ['a'] }),
      task('c', { dependsOn: ['b'] }),
      task('d', { dependsOn: ['c', 'e'] }),
      task('e', { dependsOn: ['d'] }),
    ]);
    const m = byId(rows);
    expect(m.a.layer).toBe(0);
    expect(m.b.layer).toBe(1);
    expect(m.c.layer).toBe(2);
    // d↔e 环:maxLayer=2(c)→ 末层 3,按 id 序横排
    expect(m.d.layer).toBe(3);
    expect(m.e.layer).toBe(3);
    expect(m.d.x).toBe(0);
    expect(m.e.x).toBe(160);
    expect(m.d.y).toBe(270);
    expect(m.e.y).toBe(270);
  });

  it('全环(t1↔t2):无波可放——环成员置层 0(防御不炸)', () => {
    const rows = layoutBoard([task('t1', { dependsOn: ['t2'] }), task('t2', { dependsOn: ['t1'] })]);
    const m = byId(rows);
    expect(m.t1.layer).toBe(0);
    expect(m.t2.layer).toBe(0);
    expect(m.t1.x).toBe(0);
    expect(m.t2.x).toBe(160);
  });

  it('缺依赖(引用不存在任务)视作无该边:t1 dep ghost 照入层 0', () => {
    const rows = layoutBoard([task('t1', { dependsOn: ['ghost'] }), task('t2', { dependsOn: ['t1'] })]);
    const m = byId(rows);
    expect(m.t1.layer).toBe(0); // ghost 不在集合——边忽略,入度 0
    expect(m.t2.layer).toBe(1);
  });
});
