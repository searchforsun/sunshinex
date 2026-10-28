/** catalog/permissions 钉（Task 16，settings.json permissions 键的两级读视图 + 结构化写单点）：
 *  读面：merged=两级拼接去重（loadPermissions 同口径合并不遮蔽——项目级不得解除全局 deny）、
 *  project/global 分立、root:null 仅全局（project 面恒空）、坏形状告警跳过。
 *  写面纪律沿 catalog/providers（Task 10）同款：COMMENTS 先于一切内容守卫 → 畸形 JSON/根非对象
 *  INVALID 拒写不覆盖 → 原子写（新档补 version:1、2-space、尾随换行）→ 写后 notifyCatalogWrite
 *  （写的是 settings.json 物理文件 → resource='settings'，approvals 先例 + io.ts 同构要求）。
 *  add 去重幂等（同值零落盘）、remove 缺失 INVALID（严格语义非幂等）、value 空串/非字符串 INVALID、
 *  permissions 键形状坏整键重置（add 路径）、project 写 root:null INVALID（绝不借道 cwd）。
 *  纪律：HOME 桩隔离（禁真实 ~/.sunshinex）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listPermissions, addPermission, removePermission } from './permissions';
import { loadGlobalSettings, loadProjectSettings } from '../config/settings';
import { CatalogWriteError, setOnCatalogWrite } from './io';

/** HOME/USERPROFILE 双变量重定向临时家目录夹具（win32 先例，与 catalog/providers.test 同款） */
function withHome<T>(fn: (fakeHome: string, proj: string) => T): T {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-perms-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-perms-proj-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    return fn(fakeHome, proj);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(proj, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function writeJson(file: string, doc: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
}

function readDoc(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

const invalid = (e: unknown): boolean => e instanceof CatalogWriteError && e.code === 'INVALID';
const comments = (e: unknown): boolean => e instanceof CatalogWriteError && e.code === 'COMMENTS';

test('listPermissions：两级拼接去重合并不遮蔽 + project/global 分立 + root:null 仅全局 + 坏形状告警跳过', () => {
  withHome((fakeHome, proj) => {
    writeJson(path.join(fakeHome, '.sunshinex', 'settings.json'), {
      version: 1,
      permissions: { deny: ['Bash(rm *)', 'Read(**)'], allow: ['Read'], additionalDirs: ['/g-dir'] },
    });
    writeJson(path.join(proj, '.sunshinex', 'settings.json'), {
      version: 1,
      permissions: { deny: ['Bash(rm *)', 'Bash(git push)'], allow: ['Write'] },
    });

    const view = listPermissions(proj);
    assert.deepEqual(view.merged.deny, ['Bash(rm *)', 'Read(**)', 'Bash(git push)'], 'deny 取并集去重（项目级不得解除全局 deny）');
    assert.deepEqual(view.merged.allow, ['Read', 'Write'], 'allow 拼接去重');
    assert.deepEqual(view.merged.additionalDirs, ['/g-dir'], '项目缺键按空参与合并');
    assert.deepEqual(view.global.deny, ['Bash(rm *)', 'Read(**)'], 'global 面分立');
    assert.deepEqual(view.project.deny, ['Bash(rm *)', 'Bash(git push)'], 'project 面分立');
    assert.deepEqual(view.warnings, [], '干净配置零告警');

    // root:null 仅全局：project 面恒空（不伪造 cwd 相对读取）
    const rootless = listPermissions(null);
    assert.deepEqual(rootless.project, { deny: [], allow: [], additionalDirs: [] }, 'root:null project 面恒空');
    assert.deepEqual(rootless.merged, rootless.global, 'root:null merged = global');

    // 坏形状：permissions 键非对象 / 数组槽非字符串数组 → 告警跳过（读面宽容）
    writeJson(path.join(proj, '.sunshinex', 'settings.json'), { version: 1, permissions: ['not-an-object'] });
    const badKey = listPermissions(proj);
    assert.equal(badKey.warnings.length, 1, 'permissions 键形状坏 → 告警');
    assert.deepEqual(badKey.project, { deny: [], allow: [], additionalDirs: [] }, '坏键按空');
    writeJson(path.join(proj, '.sunshinex', 'settings.json'), { version: 1, permissions: { deny: 'not-an-array' } });
    const badSlot = listPermissions(proj);
    assert.ok(badSlot.warnings.some((w) => w.includes('deny')), '数组槽形状坏 → 告警点名槽');
    assert.deepEqual(badSlot.project.deny, [], '坏槽按空');
  });
});

test('addPermission：落对应 scope settings 的对应数组 + 去重幂等（同值零落盘）+ 新档补 version:1 且盘上形态合规 + 其余键保真', () => {
  withHome((_fakeHome, proj) => {
    const projFile = loadProjectSettings(proj);
    addPermission(proj, 'project', 'deny', 'Bash(git push)');
    let doc = readDoc(projFile);
    assert.deepEqual(doc['permissions'], { deny: ['Bash(git push)'] }, 'deny 落 permissions.deny');
    assert.equal(doc['version'], 1, '新档补 version:1');
    const raw = fs.readFileSync(projFile, 'utf8');
    assert.ok(raw.endsWith('\n'), '尾随换行');
    assert.ok(raw.includes('\n  "permissions"'), '2-space 缩进形态');

    // 同值重加：去重幂等——零字节落盘（仍单条）
    const before = fs.readFileSync(projFile, 'utf8');
    addPermission(proj, 'project', 'deny', 'Bash(git push)');
    assert.equal(fs.readFileSync(projFile, 'utf8'), before, '同值重加零落盘');
    assert.deepEqual(readDoc(projFile)['permissions'], { deny: ['Bash(git push)'] }, '去重后仍单条');

    // 三个清单各落各位：allow / additionalDirs 与既有 deny 并存
    addPermission(proj, 'project', 'allow', 'Read(**)');
    addPermission(proj, 'project', 'additionalDirs', '/tmp/playground');
    doc = readDoc(projFile);
    assert.deepEqual(doc['permissions'], {
      deny: ['Bash(git push)'],
      allow: ['Read(**)'],
      additionalDirs: ['/tmp/playground'],
    }, '三清单各落各位、互不干扰');

    // 既有顶层键与 permissions 其余槽保真（手术写非整档重造）
    writeJson(projFile, { version: 1, note: 'keepme', permissions: { allow: ['Keep'], deny: ['Old'] } });
    addPermission(proj, 'project', 'allow', 'New');
    doc = readDoc(projFile);
    assert.equal(doc['note'], 'keepme', 'permissions 以外顶层键原样保留');
    assert.deepEqual(doc['permissions'], { allow: ['Keep', 'New'], deny: ['Old'] }, '同槽追加、异槽不动');
  });
});

test('removePermission：摘除对应条目 + 缺失 INVALID（值缺/槽缺/键缺/键形状坏）+ 严格语义非幂等', () => {
  withHome((_fakeHome, proj) => {
    const projFile = loadProjectSettings(proj);
    writeJson(projFile, { version: 1, note: 'keepme', permissions: { deny: ['Bash(rm *)', 'Bash(git push)'], allow: ['Read'] } });

    removePermission(proj, 'project', 'deny', 'Bash(rm *)');
    let doc = readDoc(projFile);
    assert.deepEqual(doc['permissions'], { deny: ['Bash(git push)'], allow: ['Read'] }, '目标条目已摘除、同槽其余与异槽原样');
    assert.equal(doc['note'], 'keepme', '其余顶层键保真');

    assert.throws(() => removePermission(proj, 'project', 'deny', 'Bash(rm *)'), invalid, '同值再删 → INVALID（严格语义）');
    assert.throws(() => removePermission(proj, 'project', 'allow', 'Write'), invalid, '槽内无此值 → INVALID');
    assert.throws(() => removePermission(proj, 'project', 'additionalDirs', '/x'), invalid, '槽缺失 → INVALID');

    // permissions 键缺失 / 键形状坏：remove 一律 INVALID（无从摘除），零盘上副作用
    writeJson(projFile, { version: 1 });
    assert.throws(() => removePermission(proj, 'project', 'deny', 'X'), invalid, 'permissions 键缺失 → INVALID');
    writeJson(projFile, { version: 1, permissions: 'garbage' });
    const raw = fs.readFileSync(projFile, 'utf8');
    assert.throws(() => removePermission(proj, 'project', 'deny', 'X'), invalid, 'permissions 键形状坏 → INVALID');
    assert.equal(fs.readFileSync(projFile, 'utf8'), raw, 'INVALID 面零盘上副作用');

    // 对照：add 对形状坏键整键重置后落值（装载面告警忽略坏形状，写面不保留垃圾——plugins 键先例）
    addPermission(proj, 'project', 'deny', 'Fresh');
    assert.deepEqual(readDoc(projFile)['permissions'], { deny: ['Fresh'] }, 'add 对坏键整键重置');
  });
});

test('value 校验：空串/空白 → INVALID；COMMENTS 先于一切内容守卫（含 value 非法与 scope/root 形状）；畸形 JSON INVALID 拒写', () => {
  withHome((_fakeHome, proj) => {
    const projFile = loadProjectSettings(proj);

    // 空串/空白/非字符串 → INVALID；目标文件不因拒写而创建
    assert.throws(() => addPermission(proj, 'project', 'deny', ''), invalid, '空串 → INVALID');
    assert.throws(() => addPermission(proj, 'project', 'deny', '   '), invalid, '空白串 → INVALID');
    assert.throws(() => removePermission(proj, 'project', 'deny', ''), invalid, 'remove 空串 → INVALID');
    assert.throws(
      () => addPermission(proj, 'project', 'deny', 42 as unknown as string),
      invalid,
      '非字符串 → INVALID（catalog 库面防御；HTTP 面由 handler 400 拦截）',
    );
    assert.equal(fs.existsSync(projFile), false, '拒写零盘上副作用（文件不因拒写而创建）');

    // COMMENTS 先于一切内容守卫：value 非法让位 COMMENTS（文件位置守卫 project root:null 在先——
    // providers providerWriteFile 同序，无位置无从谈文件）
    fs.mkdirSync(path.join(projFile, '..'), { recursive: true });
    const commented = '{\n  // 手写注释\n  "version": 1,\n  "permissions": { "deny": ["Old"] }\n}\n';
    fs.writeFileSync(projFile, commented, 'utf8');
    assert.throws(() => addPermission(proj, 'project', 'deny', ''), comments, 'COMMENTS 先于 value 校验');
    assert.throws(() => addPermission(proj, 'project', 'deny', 'New'), comments, '注释文件拒写');
    assert.throws(() => removePermission(proj, 'project', 'deny', 'Old'), comments, 'remove 同口径');
    assert.equal(fs.readFileSync(projFile, 'utf8'), commented, 'COMMENTS 面零盘上副作用（原文逐字保留）');

    // 畸形 JSON/根非对象：readJsoncDoc 降级空 doc，照写等于毁既有内容——INVALID 拒写引流修文件
    fs.writeFileSync(projFile, '{ not json', 'utf8');
    assert.throws(() => addPermission(proj, 'project', 'deny', 'New'), invalid, '畸形 JSON → INVALID');
    fs.writeFileSync(projFile, '[1,2]', 'utf8');
    assert.throws(() => addPermission(proj, 'project', 'deny', 'New'), invalid, '根非对象 → INVALID');
    assert.equal(fs.readFileSync(projFile, 'utf8'), '[1,2]', 'INVALID 面零盘上副作用');
  });
});

test('scope 落位：global 写落全局文件 + project 写 root:null INVALID（绝不借道 cwd）；写后 notify（settings 物理文件 → resource=settings，全局 root 归 null）', () => {
  withHome((fakeHome, proj) => {
    const calls: Array<{ resource: string; scope: string; root: string | null }> = [];
    setOnCatalogWrite((resource, scope, root) => calls.push({ resource, scope, root }));
    try {
      // global：无 root 落 <home>/.sunshinex/settings.json；notify ('settings','global',null)——
      // 写的是 settings.json 物理文件，resource 恒 'settings'（approvals 先例 + io.ts 钩子同构要求：
      // watcher 对 settings.json 的映射恒 'settings'，键不同构则回声去重失效自触双发）
      addPermission(null, 'global', 'allow', 'Read(**)');
      const gDoc = readDoc(loadGlobalSettings());
      assert.deepEqual(gDoc['permissions'], { allow: ['Read(**)'] }, 'global 落全局 settings');
      assert.deepEqual(calls, [{ resource: 'settings', scope: 'global', root: null }], 'notify 与 watcher 物理文件映射同构');

      // project：落项目文件；notify ('settings','project',root)
      calls.length = 0;
      addPermission(proj, 'project', 'deny', 'Bash(rm *)');
      assert.deepEqual(readDoc(loadProjectSettings(proj))['permissions'], { deny: ['Bash(rm *)'] }, 'project 落项目 settings');
      assert.deepEqual(calls, [{ resource: 'settings', scope: 'project', root: proj }], 'project notify 携带 root');

      // project 写 root:null → INVALID（agentWriteTarget/providerWriteTarget 先例：写面绝不借道 cwd）
      calls.length = 0;
      assert.throws(() => addPermission(null, 'project', 'deny', 'X'), invalid, 'project 写 root:null → INVALID');
      assert.throws(() => removePermission(null, 'project', 'deny', 'X'), invalid, 'remove 同口径');
      assert.deepEqual(calls, [], '拒写路径零 notify（未落盘即未通知）');
      assert.equal(fs.existsSync(path.join(fakeHome, 'proj')), false, 'cwd 无凭空落盘');
    } finally {
      setOnCatalogWrite(null);
    }
  });
});
