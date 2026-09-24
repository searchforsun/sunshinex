import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { configureLandlockLoader, landlockWrap, resetLandlockProbe, sandboxEnabled } from './landlock';

const fakeModule = {
  launcherPath: () => '/fake/landlock-launcher',
  probe: (_launcher: string) => 'ok',
  grantArgs: (g: { readOnly: string[]; readWrite: string[] }) => ['--rw', ...g.readWrite, '--ro', ...g.readOnly],
};

// 偏差说明：简报字面路径 /a、/b 在本环境（根文件系统只读）不存在，会被 landlockWrap 的 fs.existsSync
// 过滤剔除（与「不存在路径剔除」语义撞车）。改用运行期 mkdtemp 自建存在路径，断言语义不变
// （去重保序 + 只读段恒为运行面 "/"），与仓内既有 mkdtempSync 夹具先例一致。
// argv 段序由 fake 重建决定（rw 段前置）；真实 launcher 契约为只读根在前（lib/index.d.ts grantArgs 注）。
test('可用 seam：launcher 前缀组装，可写根去重保序，只读段为运行面非写通道', async () => {
  configureLandlockLoader(async () => fakeModule);
  resetLandlockProbe();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'landlock-fixture-'));
  try {
    const a = path.join(base, 'a');
    const b = path.join(base, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const wrap = await landlockWrap([a, b, a]);
    assert.notEqual(wrap, null);
    assert.equal(wrap!.file, '/fake/landlock-launcher');
    assert.deepEqual(wrap!.args, ['--rw', a, b, '--ro', '/']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('SUNSHINEX_SANDBOX=off 一键关（seam 可用亦不包装）', async () => {
  configureLandlockLoader(async () => fakeModule);
  resetLandlockProbe();
  process.env.SUNSHINEX_SANDBOX = 'off';
  try {
    assert.equal(await landlockWrap(['/a']), null);
    assert.equal(sandboxEnabled(), false);
  } finally {
    delete process.env.SUNSHINEX_SANDBOX;
  }
  assert.equal(sandboxEnabled(), true);
});

test('包缺失/内核探测不可用：静默降级返回 null（不抛错不阻断）', async () => {
  configureLandlockLoader(async () => null);
  resetLandlockProbe();
  assert.equal(await landlockWrap(['/a']), null);
  configureLandlockLoader(async () => ({ ...fakeModule, probe: () => 'unusable' }));
  resetLandlockProbe();
  assert.equal(await landlockWrap(['/a']), null);
});

test('不存在路径从可写根过滤剔除', async () => {
  configureLandlockLoader(async () => fakeModule);
  resetLandlockProbe();
  if (process.platform !== 'linux') return;
  const wrap = await landlockWrap([os.tmpdir(), '/definitely-not-exist-xyz']);
  assert.notEqual(wrap, null);
  assert.equal(wrap!.args.includes('/definitely-not-exist-xyz'), false);
  assert.equal(wrap!.args.includes(os.tmpdir()), true);
});

test('I-1：只读段仅为运行面 "/"——grant argv 不含 "/" 之外的只读授权，可写集由 readWrite 段精确圈定', async () => {
  configureLandlockLoader(async () => fakeModule);
  resetLandlockProbe();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'landlock-fixture-'));
  try {
    const root = path.join(base, 'r');
    fs.mkdirSync(root);
    const wrap = await landlockWrap([root]);
    assert.notEqual(wrap, null);
    // fake 只透传 grantArgs 入参形状：只读段必须恰为运行面 '/'（launcher 语义下写边界由 readWrite 白名单保证）
    assert.deepEqual(wrap!.args.slice(wrap!.args.indexOf('--ro')), ['--ro', '/'], `只读段：${JSON.stringify(wrap!.args)}`);
    assert.ok(wrap!.args.includes('--rw'), '可写段在 grant 中');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('I-1：可写根之外路径不进 grant（fake loader 断言 grantArgs 入参形状）', async () => {
  configureLandlockLoader(async () => fakeModule);
  resetLandlockProbe();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'landlock-fixture-'));
  try {
    const root = path.join(base, 'r');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    const wrap = await landlockWrap([root]);
    assert.notEqual(wrap, null);
    // grant 参数取 fake 重建的 readWrite 数组（fake 只透传入参形状）；可写根之外路径不得出现
    const granted = wrap!.args.filter((arg) => arg.startsWith(base));
    assert.deepEqual(granted, [root], `grant 只含可写根本身：${JSON.stringify(wrap!.args)}`);
    assert.equal(wrap!.args.includes(outside), false);
    assert.equal(wrap!.args.includes(path.join(root, '.git')), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('I-2：探测失败不缓存——fake loader 先失败后成功，第二阶段 usable 恢复、wrap 重新包装', async () => {
  let probeVerdict = 'unusable';
  configureLandlockLoader(async () => ({ ...fakeModule, probe: () => probeVerdict }));
  resetLandlockProbe();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'landlock-fixture-'));
  try {
    const root = path.join(base, 'r');
    fs.mkdirSync(root);
    if (process.platform === 'linux') {
      assert.equal(await landlockWrap([root]), null, '第一阶段探测失败 → 不包装');
      assert.equal(await landlockWrap([root]), null, '失败结果不落缓存，第二轮仍重探（本轮仍失败）');
    }
    probeVerdict = 'ok';
    resetLandlockProbe();
    const wrap = await landlockWrap([root]);
    assert.notEqual(wrap, null, '第二阶段探测恢复 → 重新包装');
    assert.deepEqual(wrap!.args, ['--rw', root, '--ro', '/']);
  } finally {
    configureLandlockLoader(null);
    resetLandlockProbe();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
