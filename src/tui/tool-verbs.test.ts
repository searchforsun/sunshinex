import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolCallLine } from './tool-verbs';

test('toolCallLine：已登记工具映射英文动词 + target 摘要', () => {
  assert.equal(toolCallLine('exec', { command: 'ls -la' }), 'EXEC ls');
  assert.equal(toolCallLine('read', { path: 'SUNSHINE.md' }), 'READ SUNSHINE.md');
  assert.equal(toolCallLine('write', { path: 'README.md', content: 'x' }), 'WRITE README.md');
  assert.equal(toolCallLine('grep', { pattern: 'TODO' }), 'GREP TODO');
  assert.equal(toolCallLine('glob', { pattern: 'src/**/*.ts' }), 'GLOB src/**/*.ts');
  assert.equal(toolCallLine('webfetch', { url: 'https://x.dev' }), 'FETCH https://x.dev');
  assert.equal(toolCallLine('kb_search', { query: '部署' }), 'SEARCH 部署');
});

test('toolCallLine：MCP 工具统一 MCP，未登记工具大写原名', () => {
  assert.equal(toolCallLine('mcp__fs__read', { path: 'a.txt' }), 'MCP a.txt');
  assert.equal(toolCallLine('custom_tool', { x: 1 }), 'CUSTOM_TOOL {"x":1}');
});

test('toolCallLine：无输入回退为空 target（仅动词）', () => {
  assert.equal(toolCallLine('read', {}), 'READ');
  assert.equal(toolCallLine('read', undefined), 'READ');
});

test('toolCallLine：超长 target 截断到 60 字符', () => {
  const line = toolCallLine('read', { path: 'x'.repeat(120) });
  assert.equal(line.length, 'READ '.length + 61);
  assert.ok(line.endsWith('…'));
});

test('toolCallLine：grep 带 path 仍取 pattern 代表字段', () => {
  assert.equal(toolCallLine('grep', { path: '.', pattern: 'needle' }), 'GREP needle');
});

test('toolCallLine：exec 取 command 首段而非 path', () => {
  assert.equal(toolCallLine('exec', { command: 'npm test', path: '/x' }), 'EXEC npm');
});
