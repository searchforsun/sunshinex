/** ink Output 画布宽护盾（2026-09-30 真机「RangeError: Invalid string length」终修）：
 *  ink renderer 的两张画布（主画布宽=终端宽；static 画布宽=staticNode 内容驱动 getComputedWidth()）
 *  在子树宽度异常（超长无空格行/yoga 布局 NaN）时进 `' '.repeat(异常值)`——负数/NaN/超 512MB 即
 *  RangeError 整进程退出（真机两轮实锤）。护盾在 Output 原型层自愈：宽度越界（非正/非有限/>4K）
 *  钳制重试，repeat 仍炸则降级 120 列兜底——视觉降级换进程存活。ink 内部路径变动时静默跳过。 */

export function installInkOutputGuard(): void {
  try {
    const mod: any = require('ink/build/output.js');
    const Output = mod?.default;
    if (!Output?.prototype || (Output.prototype as any).__widthGuard) return;
    const origGet = Output.prototype.get;
    Output.prototype.get = function () {
      const w = Number(this.width);
      if (!Number.isFinite(w) || w <= 0 || w > 4000) {
        // 画布宽异常：钳制到安全域重试（static 画布内容驱动宽可能天文数字）
        this.width = Number.isFinite(w) ? Math.min(Math.max(Math.round(w), 20), 4000) : 120;
      }
      try {
        return origGet.call(this);
      } catch (err) {
        if (err instanceof RangeError) {
          // 行内容仍触发（超高/超宽残余）：降级 120 列画布兜底
          this.width = 120;
          return origGet.call(this);
        }
        throw err;
      }
    };
    (Output.prototype as any).__widthGuard = true;
  } catch {
    /* ink 内部路径变动时静默跳过（护盾缺失不劣于现状） */
  }
}
