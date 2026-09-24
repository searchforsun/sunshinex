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
// 过滤剔除（与测试 4 的「不存在路径剔除」语义撞车）。改用运行期 mkdtemp 自建存在路径，断言语义不变
// （去重保序 + 只读放行整盘），与仓内既有 mkdtempSync 夹具先例一致。
test('可用 seam：launcher 前缀组装，可写根去重保序，只读放行整盘', async () => {
  configureLandlockLoader(async () => fakeModule);
  resetLandlockProbe();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'landlock-fixture-'));
  try {
    const a = path.join(base, 'a');
    const b = path.join(base, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const wrap = await landlockWrap([a, b, a]);
    if (process.platform !== 'linux') return assert.equal(wrap, null);
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
