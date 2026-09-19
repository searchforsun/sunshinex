import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextManager } from './index';
import { FileStore } from '../../storage/adapter';
import { resolveDataDir } from '../../config/data-dir';

/** 全局约定层（~/.sunshinex/SUNSHINE.md，SUNSHINEX_GLOBAL_SUNSHINE 覆盖；对标 ~/.claude/CLAUDE.md）：
 *  装载序（全局在前、项目在后）、漂移尾追（Global SUNSHINE.md changed）、基线前进只告知一次、
 *  消失态、双层同变有序、刷新点对齐、前置段字节冻结（前缀零击穿）。写链文案恒英文单语（CLAUDE.md §15）。 */

function withGlobal(fn: (root: string, globalFile: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-global-'));
  const prevGlobal = process.env.SUNSHINEX_GLOBAL_SUNSHINE;
  const prevData = process.env.SUNSHINEX_DATA_DIR;
  const globalFile = path.join(tmp, 'global-SUNSHINE.md');
  process.env.SUNSHINEX_GLOBAL_SUNSHINE = globalFile;
  process.env.SUNSHINEX_DATA_DIR = tmp;
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    fn(root, globalFile);
  } finally {
    if (prevGlobal === undefined) delete process.env.SUNSHINEX_GLOBAL_SUNSHINE;
    else process.env.SUNSHINEX_GLOBAL_SUNSHINE = prevGlobal;
    if (prevData === undefined) delete process.env.SUNSHINEX_DATA_DIR;
    else process.env.SUNSHINEX_DATA_DIR = prevData;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const cmAt = (root: string): ContextManager => new ContextManager(root, new FileStore(resolveDataDir(root)));

test('全局层装载：全局在前、项目在后（快照首条为全局内容）', () => {
  withGlobal((root, gf) => {
    fs.writeFileSync(gf, 'global rule G\n');
    fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'project rule P\n');
    const cm = cmAt(root);
    const items = cm.assemble();
    const gi = items.findIndex((i) => i.content.includes('global rule G'));
    const pi = items.findIndex((i) => i.content.includes('project rule P'));
    assert.ok(gi >= 0 && pi > gi, '全局层先于项目层（更靠近稳定段，会话内恒定）');
  });
});

test('无全局文件：零条目零开销，快照首条即项目层', () => {
  withGlobal((root) => {
    fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'project rule P\n');
    const cm = cmAt(root);
    const items = cm.assemble();
    assert.ok(items[0].content.includes('project rule P'));
  });
});

test('全局层漂移：中途变更尾追 Global SUNSHINE.md changed（基线前进只告知一次）', () => {
  withGlobal((root, gf) => {
    fs.writeFileSync(gf, 'G v1\n');
    const cm = cmAt(root);
    fs.writeFileSync(gf, 'G v1\nG v2\n');
    const notices = cm.appendInstructionLine('Current instruction: do X');
    assert.equal(notices.length, 1);
    assert.match(notices[0], /^Global SUNSHINE\.md changed/);
    assert.match(notices[0], /G v2/);
    assert.equal(cm.appendInstructionLine('t2').length, 0, '同一变更不重复告知');
  });
});

test('全局层消失 → (Global SUNSHINE.md is gone)', () => {
  withGlobal((root, gf) => {
    fs.writeFileSync(gf, 'G v1\n');
    const cm = cmAt(root);
    fs.unlinkSync(gf);
    const notices = cm.appendInstructionLine('t');
    assert.equal(notices.length, 1);
    assert.match(notices[0], /Global SUNSHINE\.md is gone/);
  });
});

test('双层同时变更：全局说明在前、项目说明在后，指令恒为链尾', () => {
  withGlobal((root, gf) => {
    fs.writeFileSync(gf, 'G v1\n');
    fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'P v1\n');
    const cm = cmAt(root);
    fs.writeFileSync(gf, 'G v2\n');
    fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'P v2\n');
    const notices = cm.appendInstructionLine('Current instruction: do Y');
    assert.equal(notices.length, 2);
    assert.match(notices[0], /^Global SUNSHINE\.md changed/);
    assert.match(notices[1], /^SUNSHINE\.md changed/);
    const chain = cm.chainView();
    assert.equal(chain[chain.length - 1].observation, 'Current instruction: do Y');
  });
});

test('刷新点对齐与前置段字节冻结：reloadContext 后零漂移、快照吸收全局最新', () => {
  withGlobal((root, gf) => {
    fs.writeFileSync(gf, 'G v1\n');
    const cm = cmAt(root);
    const head = cm.assemble()[0].content;
    fs.writeFileSync(gf, 'G v2\n');
    cm.appendInstructionLine('t');
    assert.equal(cm.assemble()[0].content, head, '前置段首条字节不变（前缀零击穿）');
    cm.reloadContext();
    assert.equal(cm.checkConstantsDrift().length, 0, '刷新点对齐后零漂移');
    assert.ok(cm.assemble()[0].content.includes('G v2'), '刷新后快照含全局最新');
  });
});
