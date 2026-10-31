import { describe, expect, it } from 'vitest';
import { clampSize, lockedDragBounds } from './window-drag';

describe('lockedDragBounds', () => {
  it('只改位置,宽高保持手势开始时的值', () => {
    expect(lockedDragBounds({ x: 500, y: 80 }, { x: 40, y: 12 }, { width: 1200, height: 800 })).toEqual({
      x: 460,
      y: 68,
      width: 1200,
      height: 800,
    });
  });
});

describe('clampSize', () => {
  it('超出工作区的边收进工作区,未超出的边保持', () => {
    expect(clampSize({ width: 2000, height: 700 }, { width: 1536, height: 864 })).toEqual({
      width: 1536,
      height: 700,
    });
  });
});
