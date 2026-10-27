import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shrinkToEdge, toPhysical } from '../src/scale';
import { JPEG_QUALITY } from '../src/dispatch';

test('shrinkToEdge：1568 长边封顶与不放大', () => {
  assert.deepEqual(shrinkToEdge(3136, 1568), { width: 1568, height: 784 });
  assert.deepEqual(shrinkToEdge(800, 600), { width: 800, height: 600 });
});

test('toPhysical：缩放比反算（sent→orig）', () => {
  assert.deepEqual(toPhysical(100, 50, { origWidth: 2000, origHeight: 1000, sentWidth: 1000, sentHeight: 500 }), { x: 200, y: 100 });
});

// ---- 跨包镜像对拍钉（2026-10-27 技术债轮 D55）----
// 长边/质量常量跨包四镜像（本包 scale.ts 缺省参 + dispatch.JPEG_QUALITY + worker.ps1 兜底字面量
// vs 主仓 src/images.ts 权威源）此前仅注释互指——改主仓不同步插件即静默漂移且无任何闸门报警。
// 本钉从主仓源文本解析权威值，行为钉 + 导出值钉 + 脚本模板字面量钉三层锁死。
test('跨包镜像对拍（D55）：长边/质量常量与主仓 src/images.ts 同源', () => {
  const imagesSrc = readFileSync(resolve(__dirname, '../../../../src/images.ts'), 'utf8');
  const edge = Number(/IMAGE_MAX_EDGE = (\d+)/.exec(imagesSrc)?.[1]);
  const quality = Number(/IMAGE_JPEG_QUALITY = (0\.\d+)/.exec(imagesSrc)?.[1]);
  assert.ok(Number.isFinite(edge) && Number.isFinite(quality), '主仓常量解析（src/images.ts 挪位/改名即红）');
  const q100 = Math.round(quality * 100);
  // ① scale.ts 缺省参 = 长边镜像（行为钉：缺省参数下收缩封顶值即权威值）
  assert.deepEqual(shrinkToEdge(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), { width: edge, height: edge });
  // ② dispatch JPEG 质量镜像（0.85 → 85 整数量纲）
  assert.equal(JPEG_QUALITY, q100);
  // ③ worker.ps1 脚本模板兜底字面量镜像（$quality 缺省与长边收缩式）
  const ps = readFileSync(resolve(__dirname, '../src/worker.ps1.ts'), 'utf8');
  assert.ok(ps.includes(`$quality = ${q100}`), `worker 默认质量须为 ${q100}（与主仓 0.85 档镜像）`);
  assert.ok(ps.includes(`${edge}.0 / [Math]::Max`), `worker 长边封顶须为 ${edge}.0（与主仓 IMAGE_MAX_EDGE 镜像）`);
});
