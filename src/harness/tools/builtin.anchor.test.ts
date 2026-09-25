import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SafetyChain } from '../security/chain';
import { ProcessSandbox } from '../security/sandbox';
import { SecurityGuard } from '../security/guard';
import { PolicyEngine } from '../security/policy';
import { DryRun } from '../security/dryrun';
import { builtinTools } from './builtin';

function makeTools(root: string) {
  const safety = new SafetyChain(new SecurityGuard(new PolicyEngine(), 'dontAsk'), new ProcessSandbox(), new DryRun(), root);
  return builtinTools(safety, root);
}

test('read 相对路径按项目根解析（进程 cwd ≠ 项目根 时锚点不漂移）', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-anchor-'));
  const root = path.join(parent, 'proj');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'pom.xml'), '<project>ok</project>');
  const prevCwd = process.cwd();
  process.chdir(parent); // 进程 cwd 停在父目录：复现「从父目录启动会话」的锚点分裂
  try {
    const tools = makeTools(root);
    const read = tools.find((t) => t.name === 'read')!;
    const r = await read.executor({ path: 'pom.xml' });
    assert.match(String(r.stdout ?? JSON.stringify(r)), /<project>ok<\/project>/, '相对路径须按项目根解析而非进程 cwd');
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('write 相对路径按项目根解析', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-anchor-w-'));
  const root = path.join(parent, 'proj');
  fs.mkdirSync(root);
  const prevCwd = process.cwd();
  process.chdir(parent);
  try {
    const tools = makeTools(root);
    const write = tools.find((t) => t.name === 'write')!;
    await write.executor({ path: 'out.txt', content: 'hello' });
    assert.equal(fs.readFileSync(path.join(root, 'out.txt'), 'utf8'), 'hello', '写入须落在项目根而非进程 cwd');
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('绝对路径语义不变', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-anchor-abs-'));
  const root = path.join(parent, 'proj');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'abs');
  const prevCwd = process.cwd();
  process.chdir(parent);
  try {
    const tools = makeTools(root);
    const read = tools.find((t) => t.name === 'read')!;
    const r = await read.executor({ path: path.join(root, 'a.txt') });
    assert.match(String(r.stdout ?? JSON.stringify(r)), /abs/);
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
