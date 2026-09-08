import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSunshinex, parseMcpServers, parseNetworkAllowlist } from './config';

test('parseMcpServers：行式 name | command | args...，args 按空格切分，无 args 段省略字段', () => {
  const doc = parseSunshinex([
    '# 项目名称',
    'demo',
    '',
    '## MCP 服务器',
    'filesystem | npx | -y @modelcontextprotocol/server-filesystem /tmp',
    'fetch | node | fetch-server.js --port 8080',
    'calc | calc.exe',
  ].join('\n'));
  assert.deepEqual(parseMcpServers(doc), [
    { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
    { name: 'fetch', command: 'node', args: ['fetch-server.js', '--port', '8080'] },
    { name: 'calc', command: 'calc.exe' },
  ]);
});

test('parseMcpServers：分区缺失返回 []', () => {
  assert.deepEqual(parseMcpServers(parseSunshinex('# 项目名称\ndemo')), []);
});

test('parseMcpServers：name 或 command 缺失的行跳过不抛（安全缺省）', () => {
  const doc = parseSunshinex([
    '## MCP 服务器',
    'no-pipe-line',
    '| only-command',
    'only-name |',
    '   |   |  ',
    'ok | echo | hi',
  ].join('\n'));
  assert.deepEqual(parseMcpServers(doc), [{ name: 'ok', command: 'echo', args: ['hi'] }]);
});

test('parseNetworkAllowlist：每行一个域名（trim）', () => {
  const doc = parseSunshinex([
    '## 网络白名单',
    'api.example.com',
    '  cdn.example.org  ',
    'registry.npmjs.org',
  ].join('\n'));
  assert.deepEqual(parseNetworkAllowlist(doc), ['api.example.com', 'cdn.example.org', 'registry.npmjs.org']);
});

test('parseNetworkAllowlist：分区缺失返回 []（空 = 全禁安全缺省，禁用逻辑 Task 2 落地）', () => {
  assert.deepEqual(parseNetworkAllowlist(parseSunshinex('## 其他\nx')), []);
});
