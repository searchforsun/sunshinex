import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dataDirReal, projectSlug, resolveDataDir, userSkillsDir } from './data-dir';

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

/**
 * dataDirReal：数据目录真实路径单点（安全链写窄口与记忆写入接缝共用）。
 * 两处各持一份拷贝时策略一旦漂移，接缝判类返回 null → 'pass' → 裸写绕过六道闸门（失效方向 fail-open），故设这三条钉子。
 * 三条用例均真断言（可区分实现）：① 归一确实发生（与字面值不等）；② 新建段字面保留且零副作用；③ 无缓存即重定向即生效。
 */
test('dataDirReal：数据目录经符号链接段传入时返回 realpath 归一结果（存在段归一 + 新建段字面拼接）', () => {
  const base = tmpdir('sunshinex-ddr-link-');
  const realDir = path.join(base, 'real');
  const sub = path.join(realDir, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  const link = path.join(base, 'link');
  fs.symlinkSync(realDir, link, 'dir');
  const prev = process.env.SUNSHINEX_DATA_DIR;
  try {
    const literal = path.join(link, 'sub', 'data'); // 经符号链接段，末段 data 尚未存在
    process.env.SUNSHINEX_DATA_DIR = literal;
    const got = dataDirReal(base);
    assert.equal(got, path.join(fs.realpathSync(sub), 'data'), '存在段 realpath 归一 + 新建段字面拼接');
    assert.notEqual(got, path.resolve(literal), '归一确实发生：字面比对不命中');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('dataDirReal：数据目录不存在（新建段）时按字面拼接返回、不抛', () => {
  const base = tmpdir('sunshinex-ddr-new-');
  const prev = process.env.SUNSHINEX_DATA_DIR;
  try {
    const literal = path.join(base, 'not-yet', 'deep', 'data');
    process.env.SUNSHINEX_DATA_DIR = literal;
    const got = dataDirReal(base);
    assert.equal(got, fs.realpathSync(base) + literal.slice(base.length), '最近存在祖先归一 + 其余字面拼接');
    assert.ok(got.endsWith(path.join('not-yet', 'deep', 'data')), '新建段字面保留、不抛');
    assert.equal(fs.existsSync(literal), false, '零副作用：不建目录');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('dataDirReal：运行期重定向 SUNSHINEX_DATA_DIR 后返回值跟随（惰性求值、无模块级缓存）', () => {
  const base = tmpdir('sunshinex-ddr-lazy-');
  const dirA = path.join(base, 'a-data');
  const dirB = path.join(base, 'b-data');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const prev = process.env.SUNSHINEX_DATA_DIR;
  try {
    process.env.SUNSHINEX_DATA_DIR = dirA;
    const first = dataDirReal(base);
    assert.equal(first, fs.realpathSync(dirA), '首次求值取 env 现值');
    process.env.SUNSHINEX_DATA_DIR = dirB;
    const second = dataDirReal(base);
    assert.equal(second, fs.realpathSync(dirB), '同进程内重定向即生效');
    assert.notEqual(first, second, '无缓存：两次求值不同源');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prev;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/** 全局用户技能根（三级技能目录规格 §3）：缺省 ~/.sunshinex/skills，SUNSHINEX_USER_SKILLS_DIR 显式覆盖 */
test('userSkillsDir：缺省 = userConfigDir()/skills，SUNSHINEX_USER_SKILLS_DIR 显式覆盖；不主动 mkdir', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-usd-home-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevOverride = process.env.SUNSHINEX_USER_SKILLS_DIR;
  try {
    delete process.env.SUNSHINEX_USER_SKILLS_DIR;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    const expect = path.join(fakeHome, '.sunshinex', 'skills');
    assert.equal(userSkillsDir(), expect);
    assert.ok(!fs.existsSync(expect), '缺省不主动建目录：技能根缺失是常态');

    const override = path.join(fakeHome, 'custom-skills-root');
    process.env.SUNSHINEX_USER_SKILLS_DIR = override;
    assert.equal(userSkillsDir(), path.resolve(override), '显式覆盖生效且归一为绝对路径');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;else process.env.USERPROFILE = prevUserProfile;
    if (prevOverride === undefined) delete process.env.SUNSHINEX_USER_SKILLS_DIR;else process.env.SUNSHINEX_USER_SKILLS_DIR = prevOverride;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
