import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSunshinex, parseMcpServers } from './config';

test('parseMcpServers：http(s) endpoint 行解析为 url + transport http（无 command 字段）', () => {
  const doc = parseSunshinex(
    [
      '## MCP 服务器',
      'remote | https://mcp.example.com/rpc',
      'local-net | http://127.0.0.1:3000/mcp',
    ].join('\n'),
  );
  assert.deepEqual(parseMcpServers(doc), [
    { name: 'remote', url: 'https://mcp.example.com/rpc', transport: 'http' },
    { name: 'local-net', url: 'http://127.0.0.1:3000/mcp', transport: 'http' },
  ]);
});

test('parseMcpServers：transport:sse 标记覆盖 URL 行缺省 http', () => {
  const doc = parseSunshinex(['## MCP 服务器', 'legacy | http://127.0.0.1:9101/sse | transport:sse'].join('\n'));
  assert.deepEqual(parseMcpServers(doc), [{ name: 'legacy', url: 'http://127.0.0.1:9101/sse', transport: 'sse' }]);
});

test('parseMcpServers：stdio 命令行行为不变（无 transport 字段，既有契约零改动）', () => {
  const doc = parseSunshinex(['## MCP 服务器', 'calc | calc.exe', 'fs | node | mock-server.js --name fs'].join('\n'));
  assert.deepEqual(parseMcpServers(doc), [
    { name: 'calc', command: 'calc.exe' },
    { name: 'fs', command: 'node', args: ['mock-server.js', '--name', 'fs'] },
  ]);
});

test('parseMcpServers：stdio 行显式 transport:stdio 注入字段；args 中其余 token 保留', () => {
  const doc = parseSunshinex(['## MCP 服务器', 'echo | node | server.js | transport:stdio'].join('\n'));
  assert.deepEqual(parseMcpServers(doc), [{ name: 'echo', command: 'node', args: ['server.js'], transport: 'stdio' }]);
});

test('parseMcpServers：非法 transport 值整行跳过不抛（宁少配不错配）', () => {
  const doc = parseSunshinex(
    ['## MCP 服务器', 'bad | npx | server.js | transport:bogus', 'ok | echo'].join('\n'),
  );
  assert.deepEqual(parseMcpServers(doc), [{ name: 'ok', command: 'echo' }]);
});

test('parseMcpServers：URL 行显式 transport:stdio 属矛盾配置，整行跳过', () => {
  const doc = parseSunshinex(
    ['## MCP 服务器', 'weird | http://127.0.0.1:1/mcp | transport:stdio', 'ok | http://ok.example.com'].join('\n'),
  );
  assert.deepEqual(parseMcpServers(doc), [{ name: 'ok', url: 'http://ok.example.com', transport: 'http' }]);
});
