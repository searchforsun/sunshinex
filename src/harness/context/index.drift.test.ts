import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextManager } from './index';
import { FileStore } from '../../storage/adapter';
import { resolveDataDir } from '../../config/data-dir';

/** 动态改动尾追（规范 N1 / 规格 §9.2 + §9.1）：SUNSHINE.md 会话中途漂移在指令行落点尾追最新全文块；
 *  同一变更只追一次（基线前进，刷新点重置）；超 4KB 截断 + read 指针；技能清单增量只给一行 id（正文不进上下文）；
 *  前缀零击穿（前置段首条字节不变）。全部写链文案英文单语（CLAUDE.md §15，模型侧双语别名已废止）。 */

function withRoot(fn: (root: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-cm-drift-'));
  process.env.SUNSHINEX_DATA_DIR = tmp;
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    fn(root);
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const cmAt = (root: string): ContextManager => new ContextManager(root, new FileStore(resolveDataDir(root)));

test('轮次起点 SUNSHINE.md 不一致 → 尾追全文块，且指令行仍是链尾最后一行', () => {
  withRoot((root) => {
    fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'rule A\n');
    const cm = cmAt(root); // 构造 = 刷新点：基线捕获 'rule A\n'
    fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'rule A\nrule B\n');
    const notices = cm.appendInstructionLine('Current instruction: do X');
    assert.equal(notices.length, 1);
    assert.match(notices[0], /^SUNSHINE\.md changed/, '说明行以变更头开始（英文单语）');
    assert.match(notices[0], /rule B/, '承载最新磁盘全文');
    const chain = cm.chainView();
    assert.equal(chain[chain.length - 1].observation, 'Current instruction: do X', '指令恒为链尾最后一行');
    assert.equal(chain[chain.length - 2].action, 'notice', '说明行紧邻其前');
  });
});

test('同一变更只尾追一次（baseline 前进），再改再追', () => {
  withRoot((root) => {
    const cm = cmAt(root);
    fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'v2\n');
    assert.equal(cm.appendInstructionLine('t1').length, 1);
    assert.equal(cm.appendInstructionLine('t2').length, 0, '未再改不重复');
    fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'v3\n');
    assert.equal(cm.appendInstructionLine('t3').length, 1);
  });
});

test('SUNSHINE.md 消失 → 尾追 (SUNSHINE.md is gone)', () => {
  withRoot((root) => {
    fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'v1\n');
    const cm = cmAt(root);
    fs.unlinkSync(path.join(root, 'SUNSHINE.md'));
    const notices = cm.appendInstructionLine('t');
    assert.equal(notices.length, 1);
    assert.match(notices[0], /^SUNSHINE\.md changed/);
    assert.match(notices[0], /\(SUNSHINE\.md is gone\)/);
  });
});

test('超 4096 字符截断 + read 指针', () => {
  withRoot((root) => {
    const cm = cmAt(root);
    fs.writeFileSync(path.join(root, 'SUNSHINE.md'), `start\n${'x'.repeat(5000)}\n`);
    const [notice] = cm.appendInstructionLine('t');
    assert.ok(notice.length < 5000, '已截断');
    assert.match(notice, /read .*SUNSHINE\.md/, '含 read 指针');
    assert.match(notice, /\(truncated\)/);
  });
});

test('技能清单新增 → 尾追一行（正文不进上下文）', () => {
  withRoot((root) => {
    const cm = cmAt(root);
    const dir = path.join(root, '.sunshinex', 'skills', 'newone');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), ['---', 'name: New One', 'description: brand new skill', '---', 'body', ''].join('\n'));
    const notices = cm.appendInstructionLine('t');
    assert.equal(notices.filter((n) => n.includes('newone')).length, 1);
    assert.match(notices.find((n) => n.includes('newone'))!, /^\[skills\] added: newone — load with the skill tool$/);
    assert.ok(!notices.some((n) => n.includes('body')), '技能正文不进上下文');
  });
});

test('reloadContext 后基线重置：快照已是最新，不再重复尾追', () => {
  withRoot((root) => {
    const cm = cmAt(root);
    fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'v2\n');
    assert.equal(cm.appendInstructionLine('t1').length, 1);
    cm.reloadContext();
    assert.equal(cm.appendInstructionLine('t2').length, 0);
  });
});

test('前缀不变量：变更后相邻帧仅尾部新增（断言 contextSnapshot 首条字节不变）', () => {
  withRoot((root) => {
    const cm = cmAt(root);
    const head = cm.assemble([])[0].content;
    fs.writeFileSync(path.join(root, 'SUNSHINE.md'), 'v2\n');
    cm.appendInstructionLine('t');
    assert.equal(cm.assemble([])[0].content, head, '前置段首条字节不变');
  });
});
