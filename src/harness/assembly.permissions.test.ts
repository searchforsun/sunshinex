import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Harness } from './index';

// Harness 最小构造形态与本文件既有 harness 级测试保持一致（参照 mcp 装配用例的 new Harness 写法）
//
// 夹具偏差说明（接管修正，简报原文两处笔误）：
// ① deny 断言对象 x.env——`Write(**/.env)` 的 `**/` 段后须紧跟 basename `.env`（spec 5.2 glob：`**` 跨段、
//    其余字面），x.env 不命中属规则语义而非装配缺陷（Task 2 / chain.boundary 同形态用例均钉 .env）；
// ② 告警断言——additionalDirs 字符串数组形状合法不告警（缺失路径由链侧归一兜底；spec 5.2 仅单级形状
//    非法告警）。修正为双面夹具：全局级 permissions 形状非法（告警通道）+ 项目级合法 deny（链侧生效）。

test('装配：settings permissions 注入后链侧生效 + permissionWarnings 通道', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-asm-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-asm-root-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // 全局级：permissions 形状非法 → 该级整键忽略 + warning（告警通道）；项目级：合法 deny → 链侧生效
    fs.mkdirSync(path.join(home, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.sunshinex', 'settings.json'), JSON.stringify({ permissions: 'oops' }));
    fs.mkdirSync(path.join(root, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sunshinex', 'settings.json'), JSON.stringify({
      permissions: { deny: ['Write(**/.env)'] },
    }));
    const h = new Harness({ root, mode: 'dontAsk' });
    const d = h.safety.evaluate('Write', { path: path.join(root, '.env') });
    assert.equal(d.allowed, false);
    assert.ok(h.permissionWarnings().length >= 1, '全局级 permissions 形状非法须走 warnings 通道');
    const outside = path.join(path.dirname(root), 'w.txt');
    assert.equal(h.safety.evaluate('Write', { path: outside }).allowed, true);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('addAdditionalDir：运行期扩目录读写放行，缺失路径报错', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-asm2-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-asm2-root-'));
  const trust = path.join(path.dirname(root), 'trusted-x');
  fs.mkdirSync(trust, { recursive: true });
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const h = new Harness({ root, mode: 'manual' });
    const bad = h.addAdditionalDir(path.join(root, 'no-such-dir'));
    assert.equal(bad.ok, false);
    const ok = h.addAdditionalDir(trust);
    assert.equal(ok.ok, true);
    assert.equal(h.safety.evaluate('Write', { path: path.join(trust, 'a.txt') }).allowed, true);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
