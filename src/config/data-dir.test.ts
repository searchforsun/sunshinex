import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { projectSlug, resolveDataDir } from './data-dir';

function tmpdir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('projectSlug：绝对路径确定性折叠 + 摘要尾巴；同 root 稳定、异 root 不同', () => {
  const a = tmpdir('sunshinex-slug-a-');
  const b = tmpdir('sunshinex-slug-b-');
  try {
    assert.equal(projectSlug(a), projectSlug(a), '同 root slug 稳定');
    assert.notEqual(projectSlug(a), projectSlug(b), '不同 root slug 不同');
    assert.match(projectSlug(a), /-[0-9a-f]{8}$/, '带 8 位摘要尾巴（防撞名/超长）');
    assert.equal(projectSlug('相对路径'), projectSlug(path.resolve('相对路径')), '内部先收敛绝对路径');
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('resolveDataDir：SUNSHINEX_DATA_DIR 显式覆盖最高优先（整目录直指）', () => {
  const root = tmpdir('sunshinex-dd-root-');
  const override = path.join(tmpdir('sunshinex-dd-ovr-'), 'data');
  const prev = process.env.SUNSHINEX_DATA_DIR;
  try {
    process.env.SUNSHINEX_DATA_DIR = override;
    assert.equal(resolveDataDir(root), path.resolve(override));
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveDataDir：HOME 可写时落 ~/.sunshinex/projects/<slug>/data，按工作区隔离（POSIX 读 $HOME，对齐 env.test 手法；用后复原）', () => {
  const rootA = tmpdir('sunshinex-dd-a-');
  const rootB = tmpdir('sunshinex-dd-b-');
  const fakeHome = tmpdir('sunshinex-dd-home-');
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevOvr = process.env.SUNSHINEX_DATA_DIR;
  try {
    delete process.env.SUNSHINEX_DATA_DIR;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    const dirA = resolveDataDir(rootA);
    const dirB = resolveDataDir(rootB);
    const base = path.join(fakeHome, '.sunshinex', 'projects');
    assert.ok(dirA.startsWith(base), '落全局 projects/<slug> 下');
    assert.ok(dirA.endsWith(path.join('data')), '叶级为 data 目录');
    assert.notEqual(dirA, dirB, '不同工作区不同数据目录（隔离）');
    assert.equal(resolveDataDir(rootA), dirA, '同工作区稳定');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;else process.env.USERPROFILE = prevUserProfile;
    if (prevOvr === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevOvr;
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('resolveDataDir：HOME 不可写回退项目内 .data（沙箱/只读家目录零破坏）', () => {
  const root = tmpdir('sunshinex-dd-fb-');
  const blk = tmpdir('sunshinex-dd-blk-');
  const blocked = path.join(blk, 'file');
  fs.writeFileSync(blocked, 'x');
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevOvr = process.env.SUNSHINEX_DATA_DIR;
  try {
    delete process.env.SUNSHINEX_DATA_DIR;
    process.env.HOME = blocked;
    process.env.USERPROFILE = blocked;
    assert.equal(resolveDataDir(root), path.join(root, '.data'), 'mkdir 失败即回退旧形态');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;else process.env.USERPROFILE = prevUserProfile;
    if (prevOvr === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevOvr;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(blk, { recursive: true, force: true });
  }
});
