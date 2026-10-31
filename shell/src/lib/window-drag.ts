/** 程序化拖窗的边界计算。宽高来自手势开始时锁住的尺寸,不随光标变。 */

export interface DragPoint {
  x: number;
  y: number;
}

export interface DragSize {
  width: number;
  height: number;
}

export interface DragBounds extends DragPoint, DragSize {}

/** 跟随光标移动,宽高保持锁定值。 */
export function lockedDragBounds(cursor: DragPoint, offset: DragPoint, size: DragSize): DragBounds {
  return {
    x: cursor.x - offset.x,
    y: cursor.y - offset.y,
    width: size.width,
    height: size.height,
  };
}

/** 还原尺寸超出工作区时收进工作区。 */
export function clampSize(size: DragSize, work: DragSize): DragSize {
  return {
    width: Math.min(size.width, work.width),
    height: Math.min(size.height, work.height),
  };
}
