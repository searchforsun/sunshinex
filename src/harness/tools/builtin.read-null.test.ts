import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry } from '../tools';
import { builtinTools } from './builtin';
import { SafetyChain } from '../security/chain';
import { SecurityGuard } from '../security/guard';
import { ProcessSandbox } from '../security/sandbox';
import { DryRun } from '../security/dryrun';

function setup(): { registry: ToolRegistry; safety: SafetyChain; root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-null-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'l1\nl2\nl3\n');
  const registry = new ToolRegistry();
  const safety: SafetyChain = new SafetyChain(new SecurityGuard(), new ProcessSandbox(), new DryRun(), root);
  for (const t of builtinTools(safety, root)) registry.register(t);
  return { registry, safety, root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('read range=null 整文件读（strict schema 空联合 required 下模型的显式 null 形态）', async () => {
  const { registry, safety, cleanup } = setup();
  try {
    const r = await registry.execute('read', { path: 'a.txt', range: null }, safety);
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(r.value.stdout.includes('l1') && r.value.stdout.includes('l3'));
  } finally {
    cleanup();
  }
});

test('read range="null"（模型把可空联合当字符串传，与 spawn agent_id 同病）应按整文件处理', async () => {
  const { registry, safety, cleanup } = setup();
  try {
    const r = await registry.execute('read', { path: 'a.txt', range: 'null' }, safety);
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(r.value.stdout.includes('l1') && r.value.stdout.includes('l3'));
  } finally {
    cleanup();
  }
});
