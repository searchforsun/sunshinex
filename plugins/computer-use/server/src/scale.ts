/** 坐标缩放置账纯函数（spec §5.2「缩放置账在 server 单点」）：
 *  模型坐标 = 所见截图（收缩后 sent 空间）像素；动作下发前按最近一次截图的 orig↔sent 记账反算物理像素。
 *  本模块零 I/O 零状态——纯函数，随 server/test/scale.test.ts 钉死（Task 17）。
 *
 *  跨包对齐（plan Task 4）：长边上限 1568 镜像主仓 `src/images.ts` IMAGE_MAX_EDGE（vision 端点惯例
 *  ≤1568px，GUI 装载面与插件 server 生产者同规范）；JPEG 压缩质量 0.85 镜像 IMAGE_JPEG_QUALITY
 *  （压缩在 PowerShell worker 侧落码，本包只持同值记账）。 */

/** 截图记账元数据：worker 截物理屏 orig 尺寸 → 按 edge 收缩后实际输出 sent 尺寸。
 *  随 screenshot 结果元数据回传（Task 19），动作工具据 lastMeta 经 toPhysical 反算（Task 20）。 */
export interface ScreenMeta {
  origWidth: number;
  origHeight: number;
  sentWidth: number;
  sentHeight: number;
}

/** 长边封顶收缩比（只缩不放大）：s = min(1, edge / max(w,h))；四舍五入后钳制 ≥1 兜极小屏。 */
export function shrinkToEdge(w: number, h: number, edge = 1568): { width: number; height: number } {
  const s = Math.min(1, edge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** 模型坐标（sent 空间）→ 物理像素（orig 空间）单点反算：按记账比例缩放后四舍五入。 */
export function toPhysical(x: number, y: number, m: ScreenMeta): { x: number; y: number } {
  return { x: Math.round((x * m.origWidth) / m.sentWidth), y: Math.round((y * m.origHeight) / m.sentHeight) };
}
