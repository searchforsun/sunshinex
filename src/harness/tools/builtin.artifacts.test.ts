import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { builtinTools } from './builtin';
import { SafetyChain } from '../security/chain';
import { SecurityGuard } from '../security/guard';
import { PolicyEngine } from '../security/policy';
import { ProcessSandbox } from '../security/sandbox';

/** commitFileWrite 产物声明钩（2026-11-12 spec §3.3）+ 根外写入守卫（2026-11-14 终审 Important#2）：
 *  根内白名单命中才记；根外写入（worktree 专属树/附加根——rel 以 '..' 开头或绝对）不记——
 *  非项目根产物，卡区目录显示/侧栏预览路径/bash 差集去重全锚项目根相对语义 */

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-artifacts-'));
}

function makeTools(root: string, record: (relPosix: string, source: 'write' | 'edit') => void) {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'full-access'), new ProcessSandbox(), root);
  return builtinTools(safety, root, { artifacts: { record } });
}

test('write 声明钩:根内白名单命中记;根外写入(.. 前缀)落盘不受影响但不记', async () => {
  const parent = tmp();
  const root = path.join(parent, 'proj');
  const tree = path.join(parent, 'wt-tree'); // 模拟 worktree 专属树/附加根：装配根的兄弟目录
  fs.mkdirSync(root);
  fs.mkdirSync(tree);
  const records: Array<{ path: string; source: string }> = [];
  const tools = makeTools(root, (p, s) => records.push({ path: p, source: s }));
  try {
    const write = tools.find((t) => t.name === 'write')!;
    await write.executor({ path: 'docs/a.md', content: '# hi' }); // 根内交付物：记
    const outsideFile = path.join(tree, 'report.md');
    await write.executor({ path: outsideFile, content: 'out' }); // 根外：写照常、声明跳过
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'a.md'), 'utf8'), '# hi', '根内写不受守卫影响');
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'out', '根外写链语义不变（worktree 写入照常落盘）');
    assert.deepEqual(records, [{ path: 'docs/a.md', source: 'write' }], '根外写入不得进产物声明');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('edit 声明钩:根外编辑同样不记（与 write 同一 commitFileWrite 守卫）', async () => {
  const parent = tmp();
  const root = path.join(parent, 'proj');
  const tree = path.join(parent, 'wt-tree');
  fs.mkdirSync(root);
  fs.mkdirSync(tree);
  const outsideFile = path.join(tree, 'notes.md');
  fs.writeFileSync(outsideFile, 'old text\n');
  const records: Array<{ path: string; source: string }> = [];
  const tools = makeTools(root, (p, s) => records.push({ path: p, source: s }));
  try {
    const edit = tools.find((t) => t.name === 'edit')!;
    await edit.executor({ path: outsideFile, oldString: 'old', newString: 'new', replaceAll: false });
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'new text\n', '根外编辑链语义不变');
    assert.deepEqual(records, [], '根外编辑不得进产物声明');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
