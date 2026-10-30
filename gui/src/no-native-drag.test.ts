import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 原生 app-region 防回归钉(2026-10-30 用户裁定收口):-webkit-app-region 位图按未缩放布局
 *  坐标记录、按缩放视觉坐标命中(zoom 一等公民偏好下挖孔错位×3 案在档,详见 ui-zoom.ts),且
 *  399a26a 整族清场后 settings 遮盖条又复发(=「点顶部窗宽高自动变大」元凶)。注释挡不住
 *  第四次复发,机械断言可以:gui/src 全部 css/tsx 扫描,出现即失败。窗口拖拽唯一契约 =
 *  [data-drag-band] + 壳 IPC(App.tsx / shell main.ts),新拖拽面请走该路径 */
function collect(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collect(p, acc);
    else if (/\.(css|tsx?|scss)$/.test(name)) acc.push(p);
  }
  return acc;
}

describe('native app-region ban', () => {
  it('gui/src 源码零 -webkit-app-region(拖拽唯一契约=data-drag-band + 壳 IPC)', () => {
    const self = join(__dirname, 'no-native-drag.test.ts');
    const offenders = collect(join(__dirname, '.'))
      .filter((p) => p !== self)
      .map((p) => ({ p, src: readFileSync(p, 'utf8') }))
      .filter(({ src }) => src.includes('-webkit-app-region') || /app-region\s*:/.test(src))
      .map(({ p }) => p);
    expect(offenders).toEqual([]);
  });
});
