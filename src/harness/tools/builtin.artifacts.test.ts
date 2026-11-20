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

/** report_artifacts 模型显式声明面（2026-11-14 kind 化；2026-11-20 收敛：唯一产物来源）：
 *  file 落盘存在性校验防虚报,url http(s) 形态,command 非空,declare 入收集器;write/edit 落盘
 *  不再自动登记产物（自动网全部退役）。 */

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-artifacts-'));
}

interface ArtifactsSeam {
  declare(entries: Artifact[]): void;
}

function makeTools(root: string, seam: ArtifactsSeam) {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'full-access'), new ProcessSandbox(), root);
  return builtinTools(safety, root, { artifacts: seam });
}

test('write/edit 落盘不再自动登记产物（2026-11-20 自动网退役）', async () => {
  const root = tmp();
  const declared: Artifact[] = [];
  const tools = makeTools(root, { declare: (es) => declared.push(...es) });
  try {
    const write = tools.find((t) => t.name === 'write')!;
    await write.executor({ path: 'docs/a.md', content: '# hi' });
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'a.md'), 'utf8'), '# hi', '落盘照常');
    assert.deepEqual(declared, [], '写盘零产物副作用');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('report_artifacts 显式声明面:file 存在性校验防虚报/url 形态/command 非空/declare 入收集器', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'main.py'), 'print(1)\n');
  const declared: Artifact[] = [];
  const tools = makeTools(root, { declare: (es) => declared.push(...es) });
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
  const tools = makeTools(root, { declare: (es) => declared.push(...es) });
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
  const tools = makeTools(root, { declare: (es) => declared.push(...es) });
  const report = tools.find((t) => t.name === 'report_artifacts')!;
  await report.executor({ artifacts: [{ kind: 'file', path: path.join(root, 'docs', 'r.md') }] });
  assert.deepEqual(declared, [{ kind: 'file', path: 'docs/r.md', source: 'tool' }]);
});
