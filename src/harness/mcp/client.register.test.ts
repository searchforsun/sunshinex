import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry } from '../tools';
import { SecurityGuard } from '../security/guard';
import { PolicyEngine } from '../security/policy';
import { ProcessSandbox } from '../security/sandbox';
import { SafetyChain } from '../security/chain';
import { McpHost } from './client';

function makeFixture(serverNames: string[]): { registry: ToolRegistry; safety: SafetyChain; host: McpHost } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mcp-'));
  const safety = new SafetyChain(
    new SecurityGuard(new PolicyEngine(), 'full-access', serverNames),
    new ProcessSandbox(),
    root,
  );
  const registry = new ToolRegistry();
  const host = new McpHost([{ name: 'fs', command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'fs'] }], registry);
  return { registry, safety, host };
}

test('McpHost 注册链：handshake → tools/list → 规范名注册（mcp__fs__echo，category external）', async () => {
  const { registry, host } = makeFixture(['fs']);
  try {
    const rep = await host.registerTools();
    assert.equal(rep.registered, 1);
    assert.equal(rep.warnings.length, 0);
    const spec = registry.get('mcp__fs__echo');
    assert.ok(spec, '规范名 mcp__fs__echo 应已注册');
    assert.equal(spec.category, 'external');
    assert.deepEqual(spec.parameters, { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      'tools/list 的 inputSchema 须透传为 ToolSpec.parameters（2026-10-26 联调裁定：无 schema 则模型参数化调用全败）');
  } finally {
    await host.close();
  }
});

test('McpHost：经 registry.execute 走安全链调用 mock echo，结果过 mask 出口', async () => {
  const { registry, safety, host } = makeFixture(['fs']);
  try {
    await host.registerTools();
    const r = await registry.execute('mcp__fs__echo', { text: 'hi' }, safety);
    assert.ok(r.ok);
    assert.equal(r.value.stdout, 'echo: hi');
  } finally {
    await host.close();
  }
});

// ---- 装配面开关钉（2026-10-27 技术债轮 D56：enabled/disabledTools 此前仅 config parse 面有钉，
// 直构 McpHost 的装配面用例缺——换回「开关不生效」的旧实现即红）----

test('registerTools 装配面：enabled=false 整机跳过（不连接不注册，软提示单条）', async () => {
  const registry = new ToolRegistry();
  const host = new McpHost(
    [{ name: 'fs', command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'fs'], enabled: false }],
    registry,
  );
  try {
    const rep = await host.registerTools();
    assert.equal(rep.registered, 0, '停用 server 零注册');
    assert.equal(registry.get('mcp__fs__echo'), undefined);
    assert.deepEqual(rep.warnings, ['server disabled (fs): enabled=false, skipped'], '软提示恰一条（不尝试连接）');
  } finally {
    await host.close();
  }
});

test('registerTools 装配面：disabledTools 短名过滤——命中不注册，未命中照常', async () => {
  const mk = async (disabledTools: string[]): Promise<{ registry: ToolRegistry; host: McpHost; rep: { registered: number; warnings: string[] } }> => {
    const registry = new ToolRegistry();
    const host = new McpHost(
      [{ name: 'fs', command: 'node', args: ['scripts/mock-mcp-server.js', '--name', 'fs'], disabledTools }],
      registry,
    );
    return { registry, host, rep: await host.registerTools() };
  };
  const hit = await mk(['echo']);
  try {
    assert.equal(hit.rep.registered, 0, 'echo 被停用 → 零注册（装配期不注册即模型不可见）');
    assert.equal(hit.registry.get('mcp__fs__echo'), undefined);
    assert.deepEqual(hit.rep.warnings, [], '逐工具停用非告警面（零警告）');
  } finally {
    await hit.host.close();
  }
  const miss = await mk(['nope']);
  try {
    assert.equal(miss.rep.registered, 1, '停用名单未命中 → 照常注册');
    assert.ok(miss.registry.get('mcp__fs__echo'), 'echo 在册');
  } finally {
    await miss.host.close();
  }
});
