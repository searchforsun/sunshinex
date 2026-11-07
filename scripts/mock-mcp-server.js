#!/usr/bin/env node
/**
 * 测试专用 mock MCP server：stdio JSON-RPC（零依赖零网络）。
 * 协议面：initialize → tools/list（单 echo 工具）→ tools/call；按行 JSON 收发。
 * 用法：node scripts/mock-mcp-server.js [--delay <ms>] [--name <name>] [--die-on-call <n|all>] [--fail-call]
 * - --delay <ms>：仅 tools/call 响应延迟（供客户端超时用例）；握手与 tools/list 不延迟
 * - --name <name>：改写 serverInfo.name（供「未登记服务器」越权用例）
 * - --die-on-call <n|all>：第 n 次 tools/call 不回包直接退出进程（n=all 恒杀）——供断链重试用例
 *   造「server 中途死亡」真实现场（客户端 pending 请求收传输层连接类错误）。注意：重连拉起的是
 *   全新进程，计数随之归零——「只死一次、重连后恢复」场景用 --die-once-file
 * - --die-once-file <path>：tools/call 时若该哨兵文件不存在则创建之并退出进程（跨重启恰死一次），
 *   存在则正常服务——重连后的新进程见到哨兵即恢复健康
 * - --fail-call：tools/call 回 isError:true 结果（业务失败面，供「业务错误不重试」对照用例）
 */
'use strict';

const fs = require('node:fs');
const argv = process.argv.slice(2);

function argOf(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

const CALL_DELAY_MS = parseInt(argOf('--delay', '0'), 10);
const SERVER_NAME = argOf('--name', 'mock-fs');
const DIE_ON_CALL = argOf('--die-on-call', '');
const DIE_ONCE_FILE = argOf('--die-once-file', '');
const FAIL_CALL = argv.includes('--fail-call');
let callCount = 0;

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
        callCount += 1;
        if (DIE_ONCE_FILE !== '' && !fs.existsSync(DIE_ONCE_FILE)) {
          fs.writeFileSync(DIE_ONCE_FILE, '1');
          process.exit(1); // 不回包直接死亡：客户端 pending 请求收传输层「Connection closed」（断链真实现场）
        }
        if (DIE_ON_CALL === 'all') process.exit(1);
        const text = String((params && params.arguments && params.arguments.text) ?? '');
        // 宿主侧注入参数(purpose)不得透传到插件——收到即判错,供剥除断言
        if (params && params.arguments && Object.prototype.hasOwnProperty.call(params.arguments, 'purpose')) reply(id, { content: [{ type: 'text', text: 'unexpected purpose' }], isError: true });
        else if (FAIL_CALL) reply(id, { content: [{ type: 'text', text: 'boom' }], isError: true });
        else reply(id, { content: [{ type: 'text', text: `echo: ${text}` }] });
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
