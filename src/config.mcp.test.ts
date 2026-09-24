import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadMcpServers } from './config';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-json-'));
}

test('loadMcpServers：文件缺失返回 []（合法确定态）', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.sunshinex'), { recursive: true });
  assert.deepEqual(loadMcpServers(dir), []);
});

test('loadMcpServers：stdio 条目 command/args/env 全解析', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.sunshinex'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.sunshinex', 'mcp.json'),
    JSON.stringify({ mcpServers: { echo: { command: 'node', args: ['server.js'], env: { FOO: '1' } } } }),
  );
  assert.deepEqual(loadMcpServers(dir), [
    { name: 'echo', command: 'node', args: ['server.js'], env: { FOO: '1' } },
  ]);
});

test('loadMcpServers：url 条目缺省 transport http', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.sunshinex'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.sunshinex', 'mcp.json'),
    JSON.stringify({ mcpServers: { remote: { url: 'https://mcp.example.com/v1' } } }),
  );
  assert.deepEqual(loadMcpServers(dir), [{ name: 'remote', url: 'https://mcp.example.com/v1', transport: 'http' }]);
});

test('loadMcpServers：显式 transport:sse 覆盖缺省', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.sunshinex'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.sunshinex', 'mcp.json'),
    JSON.stringify({ mcpServers: { legacy: { url: 'http://127.0.0.1:9101/sse', transport: 'sse' } } }),
  );
  assert.deepEqual(loadMcpServers(dir), [{ name: 'legacy', url: 'http://127.0.0.1:9101/sse', transport: 'sse' }]);
});

test('loadMcpServers：项目级 .sunshinex/mcp.json 遮蔽全局同名条目，其余合并', () => {
  const root = tmpDir();
  const globalDir = tmpDir();
  fs.mkdirSync(path.join(root, '.sunshinex'), { recursive: true });
  fs.writeFileSync(
    path.join(globalDir, 'mcp.json'),
    JSON.stringify({ mcpServers: { shared: { command: 'global-cmd' }, onlyGlobal: { command: 'g' } } }),
  );
  fs.writeFileSync(
    path.join(root, '.sunshinex', 'mcp.json'),
    JSON.stringify({ mcpServers: { shared: { command: 'project-cmd' } } }),
  );
  assert.deepEqual(loadMcpServers(root, globalDir), [
    { name: 'shared', command: 'project-cmd' },
    { name: 'onlyGlobal', command: 'g' },
  ]);
});

test('loadMcpServers：项目级缺失或为空时直接透传全局', () => {
  const root = tmpDir();
  const globalDir = tmpDir();
  fs.writeFileSync(path.join(globalDir, 'mcp.json'), JSON.stringify({ mcpServers: { g: { command: 'g' } } }));
  assert.deepEqual(loadMcpServers(root, globalDir), [{ name: 'g', command: 'g' }]);
  fs.mkdirSync(path.join(root, '.sunshinex'));
  fs.writeFileSync(path.join(root, '.sunshinex', 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  assert.deepEqual(loadMcpServers(root, globalDir), [{ name: 'g', command: 'g' }]);
});

test('loadMcpServers：非法 JSON 与非法条目跳过不抛（宁少配不错配）', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.sunshinex'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.sunshinex', 'mcp.json'), '{ not json');
  assert.deepEqual(loadMcpServers(dir), []);
  fs.writeFileSync(
    path.join(dir, '.sunshinex', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        bad: { transport: 'stdio' },
        badTransport: { url: 'http://x.example.com', transport: 'grpc' },
        mixed: { command: 'node', url: 'http://x.example.com' },
      },
    }),
  );
  assert.deepEqual(loadMcpServers(dir), [
    { name: 'mixed', url: 'http://x.example.com', transport: 'http' },
  ]);
});
