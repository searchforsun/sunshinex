import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadMcpServers } from './config';
import { approveMcpServer, denyMcpServer } from './catalog/approvals';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-json-'));
}

/** HOME 钉桩：批准阀（approvalState→loadGlobalSettings→userConfigDir）读 $HOME/.sunshinex/settings.json——
 *  不钉则触真实用户家（畸形真档会让装载链抛错）。沿 approvals.test.ts withHome 同款（mkdtemp + 还原）。 */
function withHome(fn: (home: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-loader-home-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    fn(home);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

test('loadMcpServers：文件缺失返回 []（合法确定态）', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.sunshinex'), { recursive: true });
  assert.deepEqual(loadMcpServers(dir), []);
});

test('loadMcpServers：stdio 条目 command/args/env 全解析', () => {
  withHome(() => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.sunshinex'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.sunshinex', 'mcp.json'),
      JSON.stringify({ mcpServers: { echo: { command: 'node', args: ['server.js'], env: { FOO: '1' } } } }),
    );
    approveMcpServer(dir, 'echo'); // 2026-10-28 批准阀：项目条目仅 approved 装载
    assert.deepEqual(loadMcpServers(dir), [
      { name: 'echo', command: 'node', args: ['server.js'], env: { FOO: '1' } },
    ]);
  });
});

test('loadMcpServers：url 条目缺省 transport http', () => {
  withHome(() => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.sunshinex'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.sunshinex', 'mcp.json'),
      JSON.stringify({ mcpServers: { remote: { url: 'https://mcp.example.com/v1' } } }),
    );
    approveMcpServer(dir, 'remote');
    assert.deepEqual(loadMcpServers(dir), [{ name: 'remote', url: 'https://mcp.example.com/v1', transport: 'http' }]);
  });
});

test('loadMcpServers：显式 transport:sse 覆盖缺省', () => {
  withHome(() => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.sunshinex'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.sunshinex', 'mcp.json'),
      JSON.stringify({ mcpServers: { legacy: { url: 'http://127.0.0.1:9101/sse', transport: 'sse' } } }),
    );
    approveMcpServer(dir, 'legacy');
    assert.deepEqual(loadMcpServers(dir), [{ name: 'legacy', url: 'http://127.0.0.1:9101/sse', transport: 'sse' }]);
  });
});

test('loadMcpServers：项目级 .sunshinex/mcp.json 遮蔽全局同名条目，其余合并', () => {
  withHome(() => {
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
    approveMcpServer(root, 'shared');
    // 输出序沿 catalog（2026-10-28 收口）：全局先、项目后（各作用域内字典序）
    assert.deepEqual(loadMcpServers(root, globalDir), [
      { name: 'onlyGlobal', command: 'g' },
      { name: 'shared', command: 'project-cmd' },
    ]);
  });
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
  withHome(() => {
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
    approveMcpServer(dir, 'mixed'); // 形状合法且已批准者才进装载集
    assert.deepEqual(loadMcpServers(dir), [
      { name: 'mixed', url: 'http://x.example.com', transport: 'http' },
    ]);
  });
});

test('loadMcpServers：第三种主流形态 url+headers+enabled(gitnexus 风格)——无 scheme 补 http://,headers/enabled/disabledTools 全解析(2026-10-26 用户实测)', () => {
  withHome(() => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.sunshinex'), { recursive: true });
    // 用户原样配置(节选):url 无 scheme + headers Bearer + enabled 显式布尔
    fs.writeFileSync(
      path.join(dir, '.sunshinex', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          gitnexus: {
            url: '192.168.66.73:3000/api/mcp',
            enabled: true,
            headers: { Authorization: 'Bearer JKZtc53Q5aJUjXCXzfG2kMZDd7ybO54Nf09dzKsQpfDt35i2' },
          },
          'feishu-mcp': { url: 'https://mcp.feishu.cn/mcp/x' },
          FeishuProjectMcp: {
            command: 'npx',
            args: ['-y', '@lark-project/mcp', '--domain', 'https://project.feishu.cn'],
            env: { MCP_USER_TOKEN: 'm-x', NODE_OPTIONS: '--use-system-ca' },
          },
          off: { command: 'node', enabled: false, disabledTools: ['b', 'a'] },
        },
      }),
    );
    // 2026-10-28 装载语义：项目条目全数批准后，enabled:false 的 off 仍被装载面过滤（不再透出）；
    // 输出序沿 catalog（作用域内 name 字典序：FeishuProjectMcp < feishu-mcp < gitnexus）
    for (const name of ['gitnexus', 'feishu-mcp', 'FeishuProjectMcp', 'off']) approveMcpServer(dir, name);
    assert.deepEqual(loadMcpServers(dir), [
      {
        name: 'FeishuProjectMcp',
        command: 'npx',
        args: ['-y', '@lark-project/mcp', '--domain', 'https://project.feishu.cn'],
        env: { MCP_USER_TOKEN: 'm-x', NODE_OPTIONS: '--use-system-ca' },
      },
      { name: 'feishu-mcp', url: 'https://mcp.feishu.cn/mcp/x', transport: 'http' },
      {
        name: 'gitnexus',
        url: 'http://192.168.66.73:3000/api/mcp',
        transport: 'http',
        headers: { Authorization: 'Bearer JKZtc53Q5aJUjXCXzfG2kMZDd7ybO54Nf09dzKsQpfDt35i2' },
        enabled: true,
      },
    ]);
  });
});

// ---------- 2026-10-28 裁定反转 2026-10-27「应用级」（spec §1 决策1/§4 批准阀；Task 4 收口）----------
// 装载语义：两级合并（项目遮蔽全局）→ enabled:false 过滤（全局/项目均不拉起）→ 项目条目批准阀
// （仅 approved 装载，pending/denied 不拉起进程；全局用户手配不过阀）。输出序沿 catalog：全局先、项目后，
// 各作用域内 name 字典序——单一事实源 listMcpServers 的既有口径，装载面不再自有排序。

test('loadMcpServers：项目条目缺审批记录（pending）不装载——批准后装载（批准阀主流程）', () => {
  withHome(() => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '.sunshinex'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.sunshinex', 'mcp.json'),
      JSON.stringify({ mcpServers: { echo: { command: 'node', args: ['server.js'] } } }),
    );
    // 未审先拦：项目 mcp.json 随仓库分发，pending 不拉起进程（宁拦勿放）
    assert.deepEqual(loadMcpServers(dir), []);
    approveMcpServer(dir, 'echo'); // 写 $HOME/.sunshinex/settings.json mcpApprovals（真实批准写面）
    assert.deepEqual(loadMcpServers(dir), [{ name: 'echo', command: 'node', args: ['server.js'] }]);
  });
});

test('loadMcpServers：同名项目条目胜出（command 取项目值），被遮蔽全局条目不出现', () => {
  withHome(() => {
    const root = tmpDir();
    const globalDir = tmpDir();
    fs.mkdirSync(path.join(root, '.sunshinex'), { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'global-cmd' }, only: { command: 'g' } } }),
    );
    fs.writeFileSync(
      path.join(root, '.sunshinex', 'mcp.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'project-cmd' } } }),
    );
    approveMcpServer(root, 'shared');
    // 输出序=catalog 口径：全局先、项目后（各作用域内字典序）
    assert.deepEqual(loadMcpServers(root, globalDir), [
      { name: 'only', command: 'g' },
      { name: 'shared', command: 'project-cmd' },
    ]);
  });
});

test('loadMcpServers：未批准项目条目被过滤且不遮蔽全局同名（全局同名仍生效）', () => {
  withHome(() => {
    const root = tmpDir();
    const globalDir = tmpDir();
    fs.mkdirSync(path.join(root, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'mcp.json'), JSON.stringify({ mcpServers: { shared: { command: 'global-cmd' } } }));
    fs.writeFileSync(path.join(root, '.sunshinex', 'mcp.json'), JSON.stringify({ mcpServers: { shared: { command: 'project-cmd' } } }));
    // 项目条目 pending：不装载，也不吃掉全局同名——遮蔽按「实际装载」计，不按「盘上有无」计
    assert.deepEqual(loadMcpServers(root, globalDir), [{ name: 'shared', command: 'global-cmd' }]);
  });
});

test('loadMcpServers：denied 项目条目不装载（拒绝后不再拉起）', () => {
  withHome(() => {
    const root = tmpDir();
    const globalDir = tmpDir();
    fs.mkdirSync(path.join(root, '.sunshinex'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sunshinex', 'mcp.json'), JSON.stringify({ mcpServers: { solo: { command: 'p' }, twin: { command: 'p2' } } }));
    fs.writeFileSync(path.join(globalDir, 'mcp.json'), JSON.stringify({ mcpServers: { twin: { command: 'global-cmd' } } }));
    approveMcpServer(root, 'solo');
    approveMcpServer(root, 'twin');
    // 输出序沿 catalog：项目作用域内字典序（solo < twin）；同名项目 twin 装载即遮蔽全局 twin
    assert.deepEqual(loadMcpServers(root, globalDir), [
      { name: 'solo', command: 'p' },
      { name: 'twin', command: 'p2' },
    ]);
    denyMcpServer(root, 'solo');
    denyMcpServer(root, 'twin');
    // denied 双双出局；twin 被拒后其全局同名不再被遮蔽（全局仍生效）
    assert.deepEqual(loadMcpServers(root, globalDir), [{ name: 'twin', command: 'global-cmd' }]);
  });
});

test('loadMcpServers：enabled:false 全局或项目均不装载；停用项目条目不遮蔽全局同名', () => {
  withHome(() => {
    const root = tmpDir();
    const globalDir = tmpDir();
    fs.mkdirSync(path.join(root, '.sunshinex'), { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { off: { command: 'g-off', enabled: false }, on: { command: 'g-on' } } }),
    );
    fs.writeFileSync(
      path.join(root, '.sunshinex', 'mcp.json'),
      JSON.stringify({ mcpServers: { poff: { command: 'p-off', enabled: false } } }),
    );
    approveMcpServer(root, 'poff'); // 已批准也拦：enabled 与批准阀两道独立闸
    assert.deepEqual(loadMcpServers(root, globalDir), [{ name: 'on', command: 'g-on' }]);
    // 停用项目条目不装载，同样不遮蔽全局同名（遮蔽以装载集计）
    fs.writeFileSync(
      path.join(root, '.sunshinex', 'mcp.json'),
      JSON.stringify({ mcpServers: { on: { command: 'p-on', enabled: false } } }),
    );
    assert.deepEqual(loadMcpServers(root, globalDir), [{ name: 'on', command: 'g-on' }]);
  });
});
