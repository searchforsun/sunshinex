import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { scanChunk } from './providers';

/**
 * providers 子命令族端到端验收（Task 19）：spawn dist/cli/index.js 真子进程——CLI 全链
 * （parseArgs → dispatch → runProviders → catalog/providers 读写面）原样走一遍，env 桩钉住
 * HOME/数据目录（mcp/agents.test 先例：HOME 重定向 + SUNSHINEX_* 显式清场，父测试进程态零污染）。
 * 用例对齐 brief：① add --base-url --models=a,b → list --json 断言序 [a,b]
 * ② model move a --direction=down → 序 [b,a] ③ model add c --tier=small → ModelChoice tier 标注
 * ④ set --base-url 增量 ⑤ remove 删整条 ⑥ key：非 TTY spawn → exit 1 提示（TTY 交互路径手工验收）。
 * 附加钉：⑦ 密钥任何输出路径零回显 ⑧ 用法错族零副作用 ⑨ test 真 HTTP 探测（ok 两行/Bearer 头/
 * 拒连 error/not found）⑩ --scope=global 落 HOME settings ⑪⑫ key 块解析 scanChunk 注入钉
 * （T19 评审修补：粘贴块内嵌终止符/控制字符——进程内混合面，spawn 面 stdin 恒非 TTY 无法驱动）。
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

interface Fixture {
  home: string;
  proj: string;
}

function makeFixture(tag: string): Fixture {
  return {
    home: fs.mkdtempSync(path.join(os.tmpdir(), `provcli-${tag}-home-`)),
    proj: fs.mkdtempSync(path.join(os.tmpdir(), `provcli-${tag}-proj-`)),
  };
}

function cleanup(f: Fixture): void {
  fs.rmSync(f.home, { recursive: true, force: true });
  fs.rmSync(f.proj, { recursive: true, force: true });
}

/** CLI 子进程 env 桩：HOME 重定向 + 数据目录隔离 + 密钥槽清场（sync/async 两个 runner 共用） */
function cliEnv(f: Fixture, extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: f.home,
    SUNSHINEX_DATA_DIR: path.join(f.home, 'data'),
    SUNSHINEX_USER_SKILLS_DIR: path.join(f.home, 'user-skills'),
    SUNSHINEX_GLOBAL_SUNSHINE: path.join(f.home, 'SUNSHINE.md'),
    SUNSHINEX_LANGUAGE: 'en', // 钉 en：上屏文案断言（usage/error）不随宿主 settings/env 语言漂移
    // 密钥槽显式清场（空串 = resolveProviderApiKey 视为未配置）：宿主环境若泄漏同名槽会让
    // apiKeyPresent 断言漂移；extraEnv 在其后展开，按用例覆盖回真值
    SUNSHINEX_API_KEY: '',
    SUNSHINEX_API_KEY_P1: '',
    SUNSHINEX_API_KEY_LIVE: '',
    ...extraEnv,
  };
}

/** spawn dist CLI（同步形态）：cwd = 临时项目（project 作用域锚） */
function runCli(f: Fixture, args: string[], extraEnv: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'dist', 'cli', 'index.js'), 'providers', ...args], {
    cwd: f.proj,
    timeout: 60_000,
    encoding: 'utf8',
    env: cliEnv(f, extraEnv),
  });
}

/**
 * spawn dist CLI（异步形态）：⑨ test 用例专用——本用例的探测目标是父测试进程内的 HTTP server，
 * spawnSync 会阻塞父进程事件循环致 server 无法应答（客户端必然撞 10s 超时的假阳性），须让父进程
 * 在子进程运行期间保持响应。
 */
interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCliAsync(f: Fixture, args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'dist', 'cli', 'index.js'), 'providers', ...args], {
      cwd: f.proj,
      env: cliEnv(f, extraEnv),
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr!.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`spawn timeout: providers ${args.join(' ')}`));
    }, 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** 项目 settings.json 读取（add/set/model 三操作/remove 落盘断言面） */
interface ProjSettings {
  version?: number;
  providers?: Array<{ name: string; baseUrl: string; contextWindow?: number; models: Array<Record<string, unknown>> }>;
  env?: Record<string, string>;
}

function readProjSettings(f: Fixture): ProjSettings {
  return JSON.parse(fs.readFileSync(path.join(f.proj, '.sunshinex', 'settings.json'), 'utf8'));
}

/** list --json 双视图解析（providers=源级分组文件镜像 + choices=展平生效值） */
interface ListView {
  providers: Array<{ name: string; baseUrl: string; apiKeyPresent: boolean; apiKeyEnv: string; models: Array<{ model: string; tier?: string }> }>;
  choices: Array<{ id: string; provider: string; model: string; tier?: string; contextWindow?: number }>;
}

function listJson(f: Fixture): ListView {
  const r = runCli(f, ['list', '--json']);
  assert.equal(r.status, 0, `list --json 应 exit 0，stderr：${r.stderr}`);
  return JSON.parse(r.stdout ?? '') as ListView;
}

test('① add 全旗标（--base-url --models=a,b --context-window --reasoning-effort --supports-images）→ list --json 序 [a,b]', () => {
  const f = makeFixture('add');
  try {
    const r = runCli(f, ['add', 'p1', '--base-url=https://api.example.com/v1', '--models=a,b', '--context-window=32000', '--reasoning-effort=low', '--supports-images']);
    assert.equal(r.status, 0, `add 应 exit 0，stderr：${r.stderr}`);
    // 落盘面：settings.json providers 键（models 条目 = 对象形态，序 = 逗号清单序）
    const doc = readProjSettings(f);
    assert.equal(doc.version, 1, '新档应补 version:1');
    assert.equal(doc.providers![0]!.name, 'p1');
    assert.equal(doc.providers![0]!.baseUrl, 'https://api.example.com/v1');
    assert.equal(doc.providers![0]!.contextWindow, 32000);
    assert.deepEqual(doc.providers![0]!.models.map((m) => m['model']), ['a', 'b']);
    // --json 双面：providers 源级序 + choices 展平序（同源同序，choices 继承源级缺省值）
    const view = listJson(f);
    assert.equal(view.providers.length, 1);
    assert.deepEqual(view.providers[0]!.models.map((m) => m.model), ['a', 'b'], 'models 序 = 逗号清单序');
    assert.equal(view.providers[0]!.apiKeyPresent, false, '未配密钥应标 false（值不回传）');
    assert.equal(view.providers[0]!.apiKeyEnv, 'SUNSHINEX_API_KEY_P1');
    assert.deepEqual(view.choices.map((c) => c.id), ['p1/a', 'p1/b'], 'choices 序 = providers 序 × models 序');
    assert.equal(view.choices[0]!.contextWindow, 32000, 'choices 继承源级 contextWindow');
    // 表格面：名称与 baseUrl 可见（非 JSON 通道）
    const table = runCli(f, ['list']);
    assert.equal(table.status, 0, `list 应 exit 0，stderr：${table.stderr}`);
    assert.ok((table.stdout ?? '').includes('p1'), `表格应含源名：${JSON.stringify(table.stdout)}`);
    assert.ok((table.stdout ?? '').includes('https://api.example.com/v1'), '表格应含 baseUrl');
  } finally {
    cleanup(f);
  }
});

test('② model move a --direction=down → 序 [b,a]（providers 与 choices 同步翻序）', () => {
  const f = makeFixture('move');
  try {
    assert.equal(runCli(f, ['add', 'p1', '--base-url=https://api.example.com/v1', '--models=a,b']).status, 0, '前置 add 应成功');
    const mv = runCli(f, ['model', 'move', 'p1', 'a', '--direction=down']);
    assert.equal(mv.status, 0, `model move 应 exit 0，stderr：${mv.stderr}`);
    const view = listJson(f);
    assert.deepEqual(view.providers[0]!.models.map((m) => m.model), ['b', 'a'], 'down = 与后一位互换');
    assert.deepEqual(view.choices.map((c) => c.id), ['p1/b', 'p1/a'], 'choices 序随之（choices[0] 即默认模型）');
  } finally {
    cleanup(f);
  }
});

test('③ model add c --tier=small → choices 面 tier 标注 + 盘上对象形态', () => {
  const f = makeFixture('modeladd');
  try {
    assert.equal(runCli(f, ['add', 'p1', '--base-url=https://api.example.com/v1', '--models=a']).status, 0, '前置 add 应成功');
    const r = runCli(f, ['model', 'add', 'p1', 'c', '--tier=small']);
    assert.equal(r.status, 0, `model add 应 exit 0，stderr：${r.stderr}`);
    const view = listJson(f);
    const c = view.choices.find((x) => x.id === 'p1/c');
    assert.ok(c, 'choices 应含 p1/c');
    assert.equal(c!.tier, 'small', 'tier 标注应在 choices 面可见（档位路由消费）');
    assert.equal(view.choices.find((x) => x.id === 'p1/a')!.tier, undefined, '未标注模型 tier 缺省');
    const doc = readProjSettings(f);
    assert.ok(doc.providers![0]!.models.some((m) => m['model'] === 'c' && m['tier'] === 'small'), '盘上应落 {model:c, tier:small} 对象形态');
  } finally {
    cleanup(f);
  }
});

test('④ set --base-url 增量：baseUrl 更新，models/contextWindow 不动', () => {
  const f = makeFixture('set');
  try {
    assert.equal(runCli(f, ['add', 'p1', '--base-url=https://old.example.com/v1', '--models=a,b', '--context-window=32000']).status, 0, '前置 add 应成功');
    const r = runCli(f, ['set', 'p1', '--base-url=https://new.example.com/v1']);
    assert.equal(r.status, 0, `set 应 exit 0，stderr：${r.stderr}`);
    const doc = readProjSettings(f);
    assert.equal(doc.providers![0]!.baseUrl, 'https://new.example.com/v1', 'baseUrl 已更新');
    assert.deepEqual(doc.providers![0]!.models.map((m) => m['model']), ['a', 'b'], '未提字段不动（models 增量语义）');
    assert.equal(doc.providers![0]!.contextWindow, 32000, '未提字段不动（contextWindow）');
  } finally {
    cleanup(f);
  }
});

test('⑤ remove 删整条；再 remove → exit 1 + not found', () => {
  const f = makeFixture('remove');
  try {
    assert.equal(runCli(f, ['add', 'p1', '--base-url=https://api.example.com/v1', '--models=a']).status, 0, '前置 add 应成功');
    const r = runCli(f, ['remove', 'p1']);
    assert.equal(r.status, 0, `remove 应 exit 0，stderr：${r.stderr}`);
    const view = listJson(f);
    assert.equal(view.providers.length, 0, 'providers 应为空');
    const doc = readProjSettings(f);
    assert.equal(doc.providers!.length, 0, '盘上 providers 键应为空数组');
    const again = runCli(f, ['remove', 'p1']);
    assert.equal(again.status, 1, '重复 remove 应 exit 1');
    assert.ok((again.stderr ?? '').includes('not found'), `应上屏 not found：${JSON.stringify(again.stderr)}`);
  } finally {
    cleanup(f);
  }
});

test('⑥ key 非 TTY spawn → exit 1 + 提示走 GUI/raw；零盘上副作用', () => {
  const f = makeFixture('key');
  try {
    assert.equal(runCli(f, ['add', 'p1', '--base-url=https://api.example.com/v1', '--models=a']).status, 0, '前置 add 应成功');
    const r = runCli(f, ['key', 'p1']);
    assert.equal(r.status, 1, '非 TTY 应 exit 1');
    const err = r.stderr ?? '';
    assert.ok(err.includes('TTY'), `应提示需要交互终端：${JSON.stringify(err)}`);
    assert.ok(/GUI|raw/i.test(err), `应提示替代通道（GUI/raw）：${JSON.stringify(err)}`);
    assert.equal(readProjSettings(f).env, undefined, '非 TTY 失败不应写 env 块（零副作用）');
  } finally {
    cleanup(f);
  }
});

test('⑦ 密钥零回显钉：专用槽 env 桩 → list --json apiKeyPresent 翻转且输出无键值', () => {
  const f = makeFixture('noecho');
  try {
    assert.equal(runCli(f, ['add', 'p1', '--base-url=https://api.example.com/v1', '--models=a']).status, 0, '前置 add 应成功');
    const view = listJson(f);
    assert.equal(view.providers[0]!.apiKeyPresent, false, '清场态应 false');
    const r = runCli(f, ['list', '--json'], { SUNSHINEX_API_KEY_P1: 'supersecret-key-value' });
    assert.equal(r.status, 0, `list --json 应 exit 0，stderr：${r.stderr}`);
    const out = r.stdout ?? '';
    assert.ok(!out.includes('supersecret-key-value'), `密钥值不得出现在任何输出通道：${JSON.stringify(out)}`);
    const v2 = JSON.parse(out) as ListView;
    assert.equal(v2.providers[0]!.apiKeyPresent, true, '专用槽有值应标 present（只标布尔不回值）');
  } finally {
    cleanup(f);
  }
});

test('⑧ 用法错族：add 缺 --base-url/--models、model move 缺 --direction、未知子命令 → usage + exit 1 + 零副作用', () => {
  const f = makeFixture('usage');
  try {
    const noUrl = runCli(f, ['add', 'p1']);
    assert.equal(noUrl.status, 1, '缺 --base-url 应 exit 1');
    assert.ok(/Usage: sunshinex providers/.test(noUrl.stderr ?? ''), `应上屏 usage 行：${JSON.stringify(noUrl.stderr)}`);
    const noModels = runCli(f, ['add', 'p1', '--base-url=https://api.example.com/v1']);
    assert.equal(noModels.status, 1, '缺 --models 应 exit 1');
    assert.equal(fs.existsSync(path.join(f.proj, '.sunshinex', 'settings.json')), false, 'usage 错误不应写 settings.json');
    const noDir = runCli(f, ['model', 'move', 'p1', 'a']);
    assert.equal(noDir.status, 1, 'model move 缺 --direction 应 exit 1');
    assert.ok(/Usage: sunshinex providers/.test(noDir.stderr ?? ''), 'model move 缺 --direction 应上屏 usage');
    const bare = runCli(f, ['nosuch']);
    assert.equal(bare.status, 1, '未知子命令应 exit 1');
    assert.ok(/Usage: sunshinex providers/.test(bare.stderr ?? ''), '未知子命令应上屏 usage');
  } finally {
    cleanup(f);
  }
});

test('⑨ test 真 HTTP 探测：本地 /models 200 → ok 两行 + Bearer 头带键 + 键不回显；拒连 → error exit 1；未知名 → not found', async () => {
  let sawAuth: string | undefined;
  const server = http.createServer((req, res) => {
    sawAuth = req.headers.authorization;
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const f = makeFixture('probe');
  try {
    const addEnv = { SUNSHINEX_API_KEY_LIVE: 'sk-live-secret' };
    assert.equal(runCli(f, ['add', 'live', `--base-url=http://127.0.0.1:${port}/v1`, '--models=m1,m2'], addEnv).status, 0, '前置 add 应成功');
    const ok = await runCliAsync(f, ['test', 'live'], addEnv);
    assert.equal(ok.status, 0, `test 应 exit 0，stderr：${ok.stderr}`);
    const lines = ok.stdout.trim().split('\n');
    assert.equal(lines.length, 2, `结果两行：${JSON.stringify(ok.stdout)}`);
    assert.ok(lines[0]!.startsWith('ok:'), `首行 ok：${JSON.stringify(ok.stdout)}`);
    assert.match(lines[1]!, /2/, `次行模型数：${JSON.stringify(ok.stdout)}`);
    assert.equal(sawAuth, 'Bearer sk-live-secret', '应以 Bearer 头携带解析到的专用槽密钥');
    assert.ok(!ok.stdout.includes('sk-live-secret'), '密钥值不得回显到 stdout');
    assert.ok(!ok.stderr.includes('sk-live-secret'), '密钥值不得回显到 stderr');
    // 拒连：先起后关的必闭端口（不依赖固定保留端口）
    const dead = http.createServer();
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const deadPort = (dead.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    assert.equal(runCli(f, ['add', 'deadp', `--base-url=http://127.0.0.1:${deadPort}/v1`, '--models=x']).status, 0, '拒连前置 add 应成功');
    const r2 = await runCliAsync(f, ['test', 'deadp']);
    assert.equal(r2.status, 1, '拒连应 exit 1');
    assert.ok(r2.stderr.includes('error'), `应上屏 error 行：${JSON.stringify(r2.stderr)}`);
    assert.ok(!r2.stdout.includes('ok:'), '拒连不应有 ok 行');
    const nf = runCli(f, ['test', 'nosuch']);
    assert.equal(nf.status, 1, '未知名应 exit 1');
    assert.ok((nf.stderr ?? '').includes('not found'), `应上屏 not found：${JSON.stringify(nf.stderr)}`);
  } finally {
    server.close();
    cleanup(f);
  }
});

test('⑩ add --scope=global → 落 HOME settings.json（HOME 桩）', () => {
  const f = makeFixture('global');
  try {
    const r = runCli(f, ['add', 'g1', '--base-url=https://global.example.com/v1', '--models=gm', '--scope=global']);
    assert.equal(r.status, 0, `global add 应 exit 0，stderr：${r.stderr}`);
    const doc = JSON.parse(fs.readFileSync(path.join(f.home, '.sunshinex', 'settings.json'), 'utf8')) as ProjSettings;
    assert.equal(doc.providers![0]!.name, 'g1', '应落全局 settings.json');
    assert.equal(fs.existsSync(path.join(f.proj, '.sunshinex', 'settings.json')), false, '项目侧不应有落盘');
  } finally {
    cleanup(f);
  }
});

/* ---------- key 交互面块解析（scanChunk 纯函数注入面） ----------
 *  T19 评审修补钉：readHiddenLine 的 stdin 交互在 spawn 面恒非 TTY（⑥ 已钉错误路径），TTY 交互
 *  无法自动化——块解析裁定抽纯为 scanChunk 后按 plugins.test 进程内+spawn 混合先例在此注入钉测。
 *  重点：粘贴块把密钥文本与终止符合并送达（剪贴板尾随换行 → 'abc\r'）时终止符不得嵌入存入密钥。 */

test('⑪ scanChunk：粘贴块内嵌终止符 → 终止且不嵌入密钥（T19 评审修补钉）', () => {
  // 剪贴板带尾随换行的整块粘贴：'abc\r' 一次送达 → 得 'abc' 且终止（逐块等值检查漏判的缺陷面）
  const cr = scanChunk('abc\r', '');
  assert.ok(cr.done, '块内 \r 应终止');
  assert.equal(cr.done && cr.value, 'abc', `终止符不得嵌入密钥：${JSON.stringify(cr)}`);
  // LF 终止同判
  const lf = scanChunk('abc\n', '');
  assert.ok(lf.done && lf.done && lf.value === 'abc', '块内 \n 应终止且不嵌入');
  // 终止符后的字符不再收集（'abc\rX' → 'abc'，X 属下一行输入）
  const trail = scanChunk('abc\rX', '');
  assert.ok(trail.done && trail.value === 'abc', `终止符后的残块不得入缓冲：${JSON.stringify(trail)}`);
});

test('⑫ scanChunk：块内 Ctrl+C 中止 / C0 控制字符忽略 / 退格 / ESC 序列跳过 / 分块续接', () => {
  // 块内 \x03（Ctrl+C 内嵌）→ 中止（value undefined），后续字符不再收集
  const abort = scanChunk('ab\x03cd', '');
  assert.ok(abort.done, '块内 Ctrl+C 应中止');
  assert.equal(abort.done && abort.value, undefined, '中止不得提交半截缓冲');
  // 其余 C0 控制字符（\x00、\t）忽略不入缓冲
  const c0 = scanChunk('a\x00b\tc', '');
  assert.ok(!c0.done && c0.buf === 'abc', `C0 控制字符应忽略：${JSON.stringify(c0)}`);
  assert.equal(c0.echo, '***', '回显位逐可打印字符计');
  // 块内退格（DEL \x7f）：删一位缓冲
  const del = scanChunk('abc\x7f\r', '');
  assert.ok(del.done && del.value === 'ab', `块内退格应删一位：${JSON.stringify(del)}`);
  // CSI 序列整条跳过（ESC [ 参数 最终字节）：最终字节 'A' 不得漏入缓冲
  const csi = scanChunk('ab\x1b[Ac', '');
  assert.ok(!csi.done && csi.buf === 'abc', `ESC 序列应整条跳过：${JSON.stringify(csi)}`);
  // 分块送达续接：单字符块逐位来（逐键形态）
  const first = scanChunk('a', '');
  assert.ok(!first.done, '单字符块不应终止');
  const second = scanChunk('b', first.done ? '' : first.buf);
  assert.ok(!second.done, '单字符块不应终止');
  const last = scanChunk('c\r', second.done ? '' : second.buf);
  assert.ok(last.done && last.value === 'abc', `分块续接应等价整块：${JSON.stringify(last)}`);
});
