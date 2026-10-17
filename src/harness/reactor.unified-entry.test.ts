import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/** P7 双执行路径统一入口形态钉（spec §10-7a；D27 形态钉先例 src/runtime.test.ts）：
 *  生产主链唯一入口 = KernelRuntime.runTask → Loop 长任务模板（D5 裁定，session/runtime.ts:62 既有）。
 *  harness.reactor 实例保留仅为 harness 级测试驱动缝——生产源码（非测试）零 `.reactor.run` 直跑，
 *  第二执行路径复发即红。stableSegment 观测面已出执行器命名空间（harness.stableSegment 薄委托），
 *  顺带锁「生产源码零 harness.reactor.stableSegment 借道」。 */

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

function repoRoot(): string {
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
  return dir;
}

test('统一入口形态钉：生产源码零 .reactor.run 直跑（主链唯一入口=KernelRuntime.runTask→Loop 模板，D5/P7 §10-7a）', () => {
  // 测试恒经 dist 执行（run-tests.js），源码定位沿 guards 先例向上找仓根（本档在 dist/harness 下）
  const srcDir = path.join(repoRoot(), 'src');
  const offenders = walk(srcDir).filter((f) => fs.readFileSync(f, 'utf8').includes('.reactor.run('));
  assert.deepEqual(
    offenders.map((f) => path.relative(srcDir, f)),
    [],
    '生产源码出现 .reactor.run 直跑——第二执行路径复发（统一入口=KernelRuntime.runTask）',
  );
});

test('统一入口形态钉：生产源码零 harness.reactor.stableSegment 借道（观测面走 harness.stableSegment 薄委托，P7）', () => {
  const srcDir = path.join(repoRoot(), 'src');
  const offenders = walk(srcDir).filter((f) => fs.readFileSync(f, 'utf8').includes('reactor.stableSegment'));
  assert.deepEqual(
    offenders.map((f) => path.relative(srcDir, f)),
    [],
    '生产源码借道 reactor.stableSegment——观测面应走 harness.stableSegment（stableSegmentOf 单点）',
  );
});
