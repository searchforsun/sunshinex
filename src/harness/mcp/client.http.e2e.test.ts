import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry } from '../tools';
import { SecurityGuard } from '../security/guard';
import { PolicyEngine } from '../security/policy';
import { ProcessSandbox } from '../security/sandbox';
import { SafetyChain } from '../security/chain';
import { DryRun } from '../security/dryrun';
import { McpHost } from './client';

/** 起临时端口 mock（port 0 监听，stdout 解析实际端口）；5s 起不来即失败 */
async function spawnMock(mode: 'http' | 'sse'): Promise<{ proc: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['scripts/mock-mcp-http-server.js', '--mode', mode, '--name', 'fs-http'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`${mode} mock 起服务超时`));
    }, 5000);
    let buf = '';
    proc.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /listening on port (\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve({ proc, port: Number(m[1]) });
      }
    });
    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timer);
        reject(new Error(`${mode} mock 提前退出 code=${code}`));
      }
    });
  });
}

/** 双传输共用链路：注册（mcp__fs-http__echo, external）→ registry.execute 过安全链 → mask 出口 */
async function runE2E(mode: 'http' | 'sse'): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-e2e-'));
  const safety = new SafetyChain(
    new SecurityGuard(new PolicyEngine(), 'dontAsk', [], ['fs-http']),
    new ProcessSandbox(),
    new DryRun(),
    root,
  );
  const registry = new ToolRegistry();
  const { proc, port } = await spawnMock(mode);
  const host = new McpHost([{ name: 'fs-http', url: `http://127.0.0.1:${port}/mcp`, transport: mode }], registry);
  try {
    assert.equal(await host.registerTools(), 1);
    const spec = registry.get('mcp__fs-http__echo');
    assert.ok(spec, '规范名 mcp__fs-http__echo 应已注册');
    assert.equal(spec.category, 'external');
    const r = await registry.execute('mcp__fs-http__echo', { text: 'token sk-abcdef0123456789abcdefgh' }, safety);
    assert.ok(r.ok);
    assert.equal(r.value.stdout, 'echo: token ***');
  } finally {
    await host.close();
    proc.kill();
  }
}

test('e2e http：streamable http 传输 注册→安全链调用→mask 出口', async () => {
  await runE2E('http');
});

test('e2e sse：sse 传输 注册→安全链调用→mask 出口', async () => {
  await runE2E('sse');
});
