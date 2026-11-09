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

test('exportSig/restoreBaselines: 基线随快照走——回种后 detect 不报漂移,磁盘变更才报', () => {
  // deps 桩:readSunshinex 可变
  let disk = 'v1';
  const d = new DriftDetector({ root: os.tmpdir(), readGlobalSunshine: () => null, readSunshinex: () => disk, globalPath: '/g', readMemoryIndex: () => '' });
  assert.deepEqual(d.detect(), []); // 构造基线=磁盘,无漂移
  disk = 'v2';
  assert.equal(d.detect().length, 1); // 变更检出,基线前进
  assert.deepEqual(d.detect(), []);
  d.restoreBaselines({ skills: '', memory: '', sunshinex: 'v1', globalSunshine: null }); // 回种旧基线
  // 2026-11-04 起 sig 扩 agents/teams 字段：旧形态入参缺字段 → 基线缺省 ''（零迁移容忍）——
  // 首检除 SUNSHINE 追尾外还会把磁盘清单现值当新增告知（[agents]/[teams] added），故本钉只锚 SUNSHINE 追尾行
  assert.equal(d.detect().filter((s) => s.startsWith('SUNSHINE.md changed')).length, 1, '旧基线 vs 新磁盘 → 再报一次(追尾语义)');
  assert.equal(d.exportSig().sunshinex, 'v2'); // 基线已随比对前进
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

test('[skills] 设置开关停用与文件移除分列:停用→disabled 行(不报 removed);删目录→removed;再启用→added', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-drift-disabled-'));
  const prevEnv = process.env.SUNSHINEX_DISABLED_SKILLS;
  const mk = (id: string): string => {
    const dir = path.join(tmp, '.sunshinex', 'skills', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: TEST_ ${id}\n---\nbody\n`);
    return dir;
  };
  try {
    delete process.env.SUNSHINEX_DISABLED_SKILLS;
    const fooDir = mk('foo');
    const barDir = mk('bar');
    const det = new DriftDetector({ root: tmp, readGlobalSunshine: () => null, readSunshinex: () => null, globalPath: '/g', readMemoryIndex: () => '' });
    assert.deepEqual(det.detect(), []);
    process.env.SUNSHINEX_DISABLED_SKILLS = fooDir;
    const off = det.detect();
    assert.equal(off.length, 1, '停用只出一行');
    assert.match(off[0], /^\[skills\] disabled: foo \(turned off by the user in settings/);
    assert.ok(!off.some((l) => l.includes('removed')), '停用不得报成 removed');
    assert.deepEqual(det.detect(), [], '基线前进:同一停用只告知一次');
    fs.rmSync(barDir, { recursive: true, force: true });
    assert.deepEqual(det.detect(), ['[skills] removed: bar (no longer available)'], '文件消失仍报 removed');
    delete process.env.SUNSHINEX_DISABLED_SKILLS;
    const on = det.detect();
    assert.equal(on.length, 1);
    assert.match(on[0], /^\[skills\] added: foo/, '再启用=重新可用,报 added');
  } finally {
    if (prevEnv === undefined) delete process.env.SUNSHINEX_DISABLED_SKILLS;
    else process.env.SUNSHINEX_DISABLED_SKILLS = prevEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
