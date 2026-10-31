import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry, CodedToolError } from '../tools';
import { SecurityGuard } from '../security/guard';
import { ProcessSandbox } from '../security/sandbox';
import { SafetyChain } from '../security/chain';
import { builtinTools } from './builtin';
import { createReadGuard } from './read-guard';

/** edit 先读守卫（read-guard.ts）行为钉（2026-10-31 用户裁定「一批编辑先读源码再编辑,加守卫」）：
 *  edit 未读先拒 NOT_READ;read 后放行;外部改写后拒 STALE_READ;edit 成功后快照前进（连环编辑
 *  免重读）;未注入守卫（既有夹具形态）零影响不设闸 */

function setup(root: string, withGuard: boolean): ToolRegistry {
  const safety = new SafetyChain(new SecurityGuard(undefined, 'full-access'), new ProcessSandbox(), root);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root, withGuard ? { readGuard: createReadGuard() } : {})) registry.register(t);
  return registry;
}

test('edit 未读先拒 NOT_READ,不落盘', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-readguard-'));
  const reg = setup(root, true);
  const f = path.join(root, 'a.txt');
  fs.writeFileSync(f, 'hello world', 'utf8');
  await assert.rejects(
    () => reg.get('edit')!.executor({ path: 'a.txt', oldString: 'hello', newString: 'hi', replaceAll: false }),
    (e: unknown) => e instanceof CodedToolError && (e as CodedToolError).code === 'NOT_READ',
  );
  assert.equal(fs.readFileSync(f, 'utf8'), 'hello world');
});

test('read 后 edit 放行;外部改写后拒 STALE_READ', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-readguard-'));
  const reg = setup(root, true);
  const f = path.join(root, 'b.txt');
  fs.writeFileSync(f, 'v1 content', 'utf8');
  await reg.get('read')!.executor({ path: 'b.txt' }); // 记快照
  await reg.get('edit')!.executor({ path: 'b.txt', oldString: 'v1', newString: 'v2', replaceAll: false });
  assert.equal(fs.readFileSync(f, 'utf8'), 'v2 content');
  fs.writeFileSync(f, 'external write', 'utf8'); // 外部进程绕过 edit 直写
  await assert.rejects(
    () => reg.get('edit')!.executor({ path: 'b.txt', oldString: 'external', newString: 'x', replaceAll: false }),
    (e: unknown) => e instanceof CodedToolError && (e as CodedToolError).code === 'STALE_READ',
  );
});

test('edit 成功后快照前进:连环编辑免重读', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-readguard-'));
  const reg = setup(root, true);
  const f = path.join(root, 'c.txt');
  fs.writeFileSync(f, 'one two', 'utf8');
  await reg.get('read')!.executor({ path: 'c.txt' });
  await reg.get('edit')!.executor({ path: 'c.txt', oldString: 'one', newString: 'ONE', replaceAll: false });
  await reg.get('edit')!.executor({ path: 'c.txt', oldString: 'two', newString: 'TWO', replaceAll: false }); // 基于上一次编辑后的态
  assert.equal(fs.readFileSync(f, 'utf8'), 'ONE TWO');
});

test('未注入守卫(既有夹具形态)零影响:未读也可 edit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-readguard-'));
  const reg = setup(root, false);
  const f = path.join(root, 'd.txt');
  fs.writeFileSync(f, 'x', 'utf8');
  await reg.get('edit')!.executor({ path: 'd.txt', oldString: 'x', newString: 'y', replaceAll: false });
  assert.equal(fs.readFileSync(f, 'utf8'), 'y');
});
