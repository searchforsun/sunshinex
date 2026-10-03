import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DriftDetector, DriftDetectorDeps } from './drift-detector';

/** DriftDetector 单元钉（D25/H3 拆件）：磁盘读全部经注入回调伪造，零真实读盘——
 *  基线两态比对（未变/变更）、基线前进、captureBaselines 重置、消失态与空记忆索引态的文案出口。 */

function withDetector(fn: (det: DriftDetector, state: { proj: string | null; global: string | null; mem: string }) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-drift-det-'));
  try {
    // 技能根随 tmp（无技能目录：skillIds 恒空串，不干扰两态比对）
    const state = { proj: 'v1\n' as string | null, global: null as string | null, mem: '' };
    const deps: DriftDetectorDeps = {
      root: tmp,
      readGlobalSunshine: () => state.global,
      readSunshinex: () => state.proj,
      globalPath: path.join(tmp, 'global-SUNSHINE.md'),
      readMemoryIndex: () => state.mem,
    };
    fn(new DriftDetector(deps), state);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('基线两态比对：未变零输出；变更一条英文说明；基线随比对前进只告知一次；captureBaselines 重置后再漂移', () => {
  withDetector((det, state) => {
    assert.equal(det.detect().length, 0, '构造即基线：未漂移零输出');
    state.proj = 'v2\n';
    const notices = det.detect();
    assert.equal(notices.length, 1, '项目层漂移恰好一条');
    assert.match(notices[0], /^SUNSHINE\.md changed/, '变更头英文单语');
    assert.match(notices[0], /v2/, '承载最新全文');
    assert.equal(det.detect().length, 0, '基线前进：同一变更不重复告知');
    state.global = 'g2\n';
    const g = det.detect();
    assert.equal(g.length, 1, '全局层独立基线独立告知');
    assert.match(g[0], /^Global SUNSHINE\.md changed/);
    det.captureBaselines(); // 刷新点：基线与磁盘对齐
    assert.equal(det.detect().length, 0, '重置后已对齐，零漂移');
    state.proj = 'v3\n';
    assert.equal(det.detect().length, 1, '重置后再变更重新告知');
  });
});

test('消失态与空记忆索引态：is gone / (the memory index is now empty) 显式标注', () => {
  withDetector((det, state) => {
    state.proj = null; // 磁盘文件被删
    const gone = det.detect();
    assert.equal(gone.length, 1);
    assert.match(gone[0], /\(SUNSHINE\.md is gone\)/, '消失态显式标注（null 与「未捕获」不混）');
    state.mem = '- [x](x.md)：事实'; // 记忆索引从空到有再清空
    det.detect();
    state.mem = '';
    const mem = det.detect();
    assert.equal(mem.length, 1);
    assert.match(mem[0], /^\[memory\] index changed/, '记忆漂移变更头');
    assert.match(mem[0], /\(the memory index is now empty\)/, '空态显式标注（不产空正文）');
  });
});
