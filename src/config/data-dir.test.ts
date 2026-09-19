import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dataDirReal, projectsRoot, projectSlug, resolveDataDir, userSkillsDir } from './data-dir';

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
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  try {
    delete process.env.SUNSHINEX_DATA_DIR;
    delete process.env.SUNSHINEX_PROJECTS_DIR;
    process.env.HOME = blocked;
    process.env.USERPROFILE = blocked;
    assert.equal(resolveDataDir(root), path.join(root, '.data'), 'mkdir 失败即回退旧形态');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;else process.env.USERPROFILE = prevUserProfile;
    if (prevOvr === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevOvr;
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(blk, { recursive: true, force: true });
  }
});

/**
 * projects 根可指定（用户裁决 2026-09-19）：数据落哪块盘不该被家目录绑死——
 * 大容量盘/外置盘/多盘分置下用户需要显式指定一个绝对路径，逐项目 slug 隔离语义不变。
 * 与「HOME 不可写回退项目内 .data」的分界是本组用例的要害：**显式指定即权威、不回退**——
 * 回退会把「指了 D 盘却写在 C 盘」这类配置错误伪装成成功，宁可在使用点以真实路径报出来。
 */
test('projectsRoot：缺省 = userConfigDir()/projects；SUNSHINEX_PROJECTS_DIR 覆盖可指向任意盘', () => {
  const fakeHome = tmpdir('sunshinex-pr-home-');
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  try {
    delete process.env.SUNSHINEX_PROJECTS_DIR;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    assert.equal(projectsRoot(), path.join(fakeHome, '.sunshinex', 'projects'), '缺省沿用 userConfigDir()/projects');

    const elsewhere = path.join(tmpdir('sunshinex-pr-elsewhere-'), 'projects');
    process.env.SUNSHINEX_PROJECTS_DIR = elsewhere;
    assert.equal(projectsRoot(), path.resolve(elsewhere), '覆盖生效且归一为绝对路径');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;else process.env.USERPROFILE = prevUserProfile;
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('resolveDataDir：projects 根覆盖后数据落该盘并按工作区隔离，家目录零落盘', () => {
  const rootA = tmpdir('sunshinex-pr-a-');
  const rootB = tmpdir('sunshinex-pr-b-');
  const fakeHome = tmpdir('sunshinex-pr-home2-');
  const custom = path.join(tmpdir('sunshinex-pr-d-'), 'sunshinex-projects');
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevOvr = process.env.SUNSHINEX_DATA_DIR;
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  try {
    delete process.env.SUNSHINEX_DATA_DIR;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.SUNSHINEX_PROJECTS_DIR = custom;

    const dirA = resolveDataDir(rootA);
    const dirB = resolveDataDir(rootB);
    assert.equal(dirA, path.join(path.resolve(custom), projectSlug(rootA), 'data'), '落指定盘的 <slug>/data');
    assert.equal(dirB, path.join(path.resolve(custom), projectSlug(rootB), 'data'), '同根稳定');
    assert.notEqual(dirA, dirB, '逐项目 slug 隔离在自定义根下同样成立');
    assert.equal(resolveDataDir(rootA), dirA, '同工作区稳定');
    assert.ok(!fs.existsSync(path.join(fakeHome, '.sunshinex', 'projects')), '家目录下不再出现 projects（数据确实换盘）');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;else process.env.USERPROFILE = prevUserProfile;
    if (prevOvr === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevOvr;
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    for (const d of [rootA, rootB, fakeHome]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('resolveDataDir：projects 根显式指定时不可建也不回退项目内 .data（配置错误不伪装成成功）', () => {
  const root = tmpdir('sunshinex-pr-nofb-');
  const blk = tmpdir('sunshinex-pr-blk-');
  const blocked = path.join(blk, 'file');
  fs.writeFileSync(blocked, 'x');
  const prevOvr = process.env.SUNSHINEX_DATA_DIR;
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  try {
    delete process.env.SUNSHINEX_DATA_DIR;
    // 把 projects 根指到一个「父级是文件」的非法位置：mkdir 必失败
    process.env.SUNSHINEX_PROJECTS_DIR = path.join(blocked, 'projects');
    const got = resolveDataDir(root);
    assert.equal(got, path.join(path.resolve(path.join(blocked, 'projects')), projectSlug(root), 'data'), '显式指定即权威：即便不可建也如实返回该路径');
    assert.notEqual(got, path.join(root, '.data'), '不回退项目内 .data——回退会掩盖配置错误');
  } finally {
    if (prevOvr === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevOvr;
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(blk, { recursive: true, force: true });
  }
});

test('resolveDataDir：projects 根覆盖运行期切换即生效（无模块级缓存），且 SUNSHINEX_DATA_DIR 直指仍最高优先', () => {
  const root = tmpdir('sunshinex-pr-lazy-');
  const baseA = path.join(tmpdir('sunshinex-pr-la-'), 'projects');
  const baseB = path.join(tmpdir('sunshinex-pr-lb-'), 'projects');
  const prevOvr = process.env.SUNSHINEX_DATA_DIR;
  const prevProjects = process.env.SUNSHINEX_PROJECTS_DIR;
  try {
    delete process.env.SUNSHINEX_DATA_DIR;
    process.env.SUNSHINEX_PROJECTS_DIR = baseA;
    const first = resolveDataDir(root);
    process.env.SUNSHINEX_PROJECTS_DIR = baseB;
    const second = resolveDataDir(root);
    assert.notEqual(first, second, '换根即换落点：无缓存');

    const direct = path.join(tmpdir('sunshinex-pr-direct-'), 'data');
    process.env.SUNSHINEX_DATA_DIR = direct;
    assert.equal(resolveDataDir(root), path.resolve(direct), 'SUNSHINEX_DATA_DIR 整目录直指优先级更高');
  } finally {
    if (prevOvr === undefined) delete process.env.SUNSHINEX_DATA_DIR;else process.env.SUNSHINEX_DATA_DIR = prevOvr;
    if (prevProjects === undefined) delete process.env.SUNSHINEX_PROJECTS_DIR;else process.env.SUNSHINEX_PROJECTS_DIR = prevProjects;
    fs.rmSync(root, { recursive: true, force: true });
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
