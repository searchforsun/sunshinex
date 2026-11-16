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
import type { Artifact } from '../../types';

/** commitFileWrite 产物声明钩（2026-11-12 spec §3.3）+ 根外写入守卫（2026-11-14 终审 Important#2）+
 *  report_artifacts 模型显式声明面（2026-11-14 kind 化改宗）：file 落盘存在性校验防虚报,
 *  url http(s) 形态,command 非空,declare 入收集器 */

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-artifacts-'));
}

interface ArtifactsSeam {
  record(relPosix: string, source: 'write' | 'edit'): void;
  declare(entries: Artifact[]): void;
}

function makeTools(root: string, seam: ArtifactsSeam) {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'full-access'), new ProcessSandbox(), root);
  return builtinTools(safety, root, { artifacts: seam });
}

test('write 声明钩:根内白名单命中记;根外写入(.. 前缀)落盘不受影响但不记', async () => {
  const parent = tmp();
  const root = path.join(parent, 'proj');
  const tree = path.join(parent, 'wt-tree'); // 模拟 worktree 专属树/附加根：装配根的兄弟目录
  fs.mkdirSync(root);
  fs.mkdirSync(tree);
  const records: Array<{ path: string; source: string }> = [];
  const tools = makeTools(root, { record: (p, s) => records.push({ path: p, source: s }), declare: () => {} });
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

test('report_artifacts 显式声明面:file 存在性校验防虚报/url 形态/command 非空/declare 入收集器', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'main.py'), 'print(1)\n');
  const declared: Artifact[] = [];
  const tools = makeTools(root, { record: () => {}, declare: (es) => declared.push(...es) });
  const report = tools.find((t) => t.name === 'report_artifacts')!;
  const receipt = await report.executor({
    artifacts: [
      { kind: 'file', path: 'main.py', title: '游戏主模块', desc: 'python main.py 运行' },
      { kind: 'url', url: 'http://localhost:7788', title: '在线试玩' },
      { kind: 'command', command: 'python main.py', desc: '终端启动' },
    ],
  });
  assert.match(String((receipt as { stdout: string }).stdout), /registered 3 artifact\(s\)/);
  assert.deepEqual(declared, [
    { kind: 'file', path: 'main.py', source: 'tool', title: '游戏主模块', desc: 'python main.py 运行' },
    { kind: 'url', url: 'http://localhost:7788', source: 'tool', title: '在线试玩' },
    { kind: 'command', command: 'python main.py', source: 'tool', desc: '终端启动' },
  ]);
  // 防虚报:声明的文件不在盘上 → 硬错误且不登记
  await assert.rejects(
    () => report.executor({ artifacts: [{ kind: 'file', path: 'ghost.md' }] }),
    /does not exist on disk/,
  );
  await assert.rejects(() => report.executor({ artifacts: [{ kind: 'url', url: 'ftp://bad' }] }), /http\(s\) URL/);
  await assert.rejects(() => report.executor({ artifacts: [{ kind: 'command', command: '' }] }), /non-empty command/);
  await assert.rejects(() => report.executor({ artifacts: [] }), /non-empty array/);
  assert.equal(declared.length, 3, '校验失败的批次不得部分登记');
});

test('desc 卡面硬钳(2026-11-16 用户裁定「描述一点过要严格限制长度」):超 40 字符截断加省略号,≤40 原样', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.md'), 'x\n');
  const declared: Artifact[] = [];
  const tools = makeTools(root, { record: () => {}, declare: (es) => declared.push(...es) });
  const report = tools.find((t) => t.name === 'report_artifacts')!;
  const short = '短描述';
  const long = '只读分析报告：顶层目录树、Maven 构建体系、11 个入口点、1535 个 Java 文件规模统计与技术结论一览';
  assert.ok([...long].length > 40, '前置:样例确实超长');
  await report.executor({
    artifacts: [
      { kind: 'file', path: 'a.md', desc: short },
      { kind: 'file', path: 'a.md', desc: long },
    ],
  });
  assert.equal(declared[0]!.desc, short, '限内原样透传');
  const clamped = declared[1]!.desc ?? '';
  assert.equal([...clamped].length, 40, '钳后恒 40 字符(39+省略号)');
  assert.ok(clamped.endsWith('…'), '尾部省略号');
});

test('report_artifacts:file 声明钉项目根相对路径(绝对路径入参归一)', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'r.md'), 'x');
  const declared: Artifact[] = [];
  const tools = makeTools(root, { record: () => {}, declare: (es) => declared.push(...es) });
  const report = tools.find((t) => t.name === 'report_artifacts')!;
  await report.executor({ artifacts: [{ kind: 'file', path: path.join(root, 'docs', 'r.md') }] });
  assert.deepEqual(declared, [{ kind: 'file', path: 'docs/r.md', source: 'tool' }]);
});
