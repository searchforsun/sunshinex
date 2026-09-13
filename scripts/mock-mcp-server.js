#!/usr/bin/env node
/**
 * 测试专用 mock MCP server：stdio JSON-RPC（零依赖零网络）。
 * 协议面：initialize → tools/list（单 echo 工具）→ tools/call；按行 JSON 收发。
 * 用法：node scripts/mock-mcp-server.js [--delay <ms>] [--name <name>]
 * - --delay <ms>：仅 tools/call 响应延迟（供客户端超时用例）；握手与 tools/list 不延迟
 * - --name <name>：改写 serverInfo.name（供「未登记服务器」越权用例）
 */
'use strict';

const argv = process.argv.slice(2);

function argOf(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

const CALL_DELAY_MS = parseInt(argOf('--delay', '0'), 10);
const SERVER_NAME = argOf('--name', 'mock-fs');

const TOOLS = [
  {
    name: 'echo',
    description: '回显输入文本',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

function writeLine(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  writeLine({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  writeLine({ jsonrpc: '2.0', id, error: { code, message } });
}

function handle(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return; // 非 JSON 行忽略（对齐真实 stdio server 对心跳噪声的容忍）
  }
  const { id, method, params } = req;
  const respond = () => {
    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: '0.1.0' },
        });
        break;
      case 'tools/list':
        reply(id, { tools: TOOLS });
        break;
      case 'tools/call': {
        const text = String((params && params.arguments && params.arguments.text) ?? '');
        reply(id, { content: [{ type: 'text', text: `echo: ${text}` }] });
        break;
      }
      default:
        if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
        // 通知类（无 id）不回包
    }
  };
  if (method === 'tools/call' && CALL_DELAY_MS > 0) setTimeout(respond, CALL_DELAY_MS);
  else respond();
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) handle(line);
  }
});
