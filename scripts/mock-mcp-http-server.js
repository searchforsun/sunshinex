#!/usr/bin/env node
/**
 * 测试专用 mock MCP server：HTTP/SSE 传输（node:http 零依赖）。
 * 协议面对齐 mock-mcp-server.js（stdio 版）：initialize → tools/list（单 echo 工具）→ tools/call。
 * 用法：node scripts/mock-mcp-http-server.js [--mode http|sse] [--name <name>]
 * - --mode http（缺省）：streamable http 最小面——POST 单端点收 JSON-RPC，application/json 单响应回包
 * - --mode sse：GET /mcp 推 text/event-stream，先发 event: endpoint 告知 POST 地址，
 *   后续 JSON-RPC 响应以 event: message 帧推送（对齐 SDK SSEClientTransport 协议）
 * 端口 0 监听，实际端口输出 stdout 行「mock-mcp-http listening on port <n>」供测试解析。
 */
'use strict';

const http = require('http');

const argv = process.argv.slice(2);

function argOf(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

const MODE = argOf('--mode', 'http');
const SERVER_NAME = argOf('--name', 'mock-fs-http');
if (MODE !== 'http' && MODE !== 'sse') {
  console.error(`未知模式：${MODE}（仅支持 http | sse）`);
  process.exit(2);
}

const TOOLS = [
  {
    name: 'echo',
    description: '回显输入文本',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

/** 单条 JSON-RPC 请求 → 响应消息；通知类（无 id）返回 undefined 不回包 */
function handleRpc(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: String((params && params.protocolVersion) || '2024-11-05'),
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: '0.1.0' },
        },
      };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const text = String((params && params.arguments && params.arguments.text) ?? '');
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo: ${text}` }] } };
    }
    default:
      return id !== undefined
        ? { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
        : undefined;
  }
}

const sseClients = new Set();

function pushSse(message) {
  const frame = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && MODE === 'sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('event: endpoint\ndata: /mcp\n\n');
    sseClients.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 10_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const out = handleRpc(msg);
      if (MODE === 'sse') {
        // SSE 模式：POST 仅受理请求，响应帧经事件流推送
        res.writeHead(out ? 202 : 200).end();
        if (out) pushSse(out);
      } else if (!out) {
        res.writeHead(202).end(); // 通知类受理即返回
      } else {
        const payload = JSON.stringify(out);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
        res.end(payload);
      }
    });
    return;
  }
  res.writeHead(405).end();
});

server.listen(0, '127.0.0.1', () => {
  console.log(`mock-mcp-http listening on port ${server.address().port}`);
});
