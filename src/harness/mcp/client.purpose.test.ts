import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../tools';
import { McpHost, stripPurposeArg, withPurposeParam } from './client';

/** 内置插件操作说明参数(2026-11-07 用户裁定):宿主插件工具的参数表首位注入 purpose 并必填,
 *  调用转发插件前剥除;第三方 MCP 工具不受影响 */

test('withPurposeParam:purpose 置属性首位并入 required 首位;零参/无 schema 工具同样带上;不重复', () => {
  const p = withPurposeParam({ type: 'object', additionalProperties: false, properties: { x: { type: 'number' } }, required: ['x'] });
  assert.deepEqual(Object.keys(p.properties ?? {}), ['purpose', 'x']);
  assert.deepEqual(p.required, ['purpose', 'x']);
  assert.equal(p.additionalProperties, false, '原 schema 其余字段保留');
  const bare = withPurposeParam(undefined);
  assert.deepEqual(Object.keys(bare.properties ?? {}), ['purpose']);
  assert.deepEqual(bare.required, ['purpose']);
  assert.deepEqual(withPurposeParam(p).required, ['purpose', 'x'], '重复注入幂等');
});

test('stripPurposeArg:只剥 purpose,其余参数原样;无 purpose 原引用', () => {
  assert.deepEqual(stripPurposeArg({ purpose: '截屏', region: null }), { region: null });
  const a = { text: 'hi' };
  assert.equal(stripPurposeArg(a), a);
});

function hostOf(configName: string): { registry: ToolRegistry; host: McpHost } {
  const registry = new ToolRegistry();
  const host = new McpHost([{ name: configName, command: 'node', args: ['scripts/mock-mcp-server.js', '--name', configName] }], registry);
  return { registry, host };
}

test('宿主插件(computer-use)工具:模型面带 purpose,调用剥除后转发——插件收不到 purpose', async () => {
  const { registry, host } = hostOf('computer-use');
  try {
    await host.registerTools();
    const spec = registry.get('mcp__computer-use__echo')!;
    assert.deepEqual(Object.keys(spec.parameters?.properties ?? {}), ['purpose', 'text']);
    const r = await spec.executor({ purpose: '回显一下', text: 'hi' });
    assert.equal(r.stdout, 'echo: hi');
  } finally {
    await host.close();
  }
});

test('第三方 MCP 工具不注入 purpose(参数表原样)', async () => {
  const { registry, host } = hostOf('fs');
  try {
    await host.registerTools();
    assert.deepEqual(Object.keys(registry.get('mcp__fs__echo')!.parameters?.properties ?? {}), ['text']);
  } finally {
    await host.close();
  }
});
