import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProcessSandbox, findWindowsBash, resolveShell, windowsBashCandidates } from './sandbox';
import { DryRun } from './dryrun';
import { ToolBackend } from '../../types';

test('ProcessSandbox 执行 echo 返回输出', async () => {
  const s = new ProcessSandbox();
  const r = await s.exec('echo hello');
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.value.stdout, /hello/);
});

/**
 * 平台 shell 决议契约：本文件是平台分支的唯一落点（CLAUDE.md §14），sh 语义用例集中于此，
 * 其余测试用 sh/cmd 双通命令（不把宿主 shell 方言编进断言）。
 */
test('resolveShell：SUNSHINEX_SHELL 覆盖优先，缺省给出可解析的 shell 与脚本 flag', () => {
  const prev = process.env.SUNSHINEX_SHELL;
  try {
    process.env.SUNSHINEX_SHELL = '/custom/sh';
    assert.deepEqual(resolveShell(), { file: '/custom/sh', scriptFlag: '-c' });
    process.env.SUNSHINEX_SHELL = '   ';
    assert.notEqual(resolveShell().file, '   ', '空串覆盖视为未设置');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_SHELL;
    else process.env.SUNSHINEX_SHELL = prev;
  }
  const s = resolveShell();
  assert.ok(s.file.length > 0, '必须给出 shell 可执行文件');
  // 缺省决议随平台走：POSIX shell（含 Windows 的 Git Bash）为 -c；Windows 无 Git Bash 时按 §14 回退 ComSpec 的 /c
  assert.ok(s.scriptFlag === '-c' || s.scriptFlag === '/c', `脚本 flag 应为 -c 或 /c，实际 ${s.scriptFlag}`);
});

test('Windows Git Bash 发现：安装根与 PATH 反推（纯逻辑，跨平台可断言）', () => {
  // 路径不含卷号：POSIX 下 path.delimiter 为 ':'，含 'D:' 的路径会被切成两段致候选失真
  const gitRoot = path.join(path.sep, 'opt', 'custom-git');
  const gitCmdDir = path.join(gitRoot, 'cmd');
  const env = {
    ProgramFiles: path.join(path.sep, 'program-files'),
    LOCALAPPDATA: path.join(path.sep, 'users', 'u', 'AppData', 'Local'),
    PATH: [gitCmdDir, path.join(path.sep, 'usr', 'bin')].join(path.delimiter),
  };
  const gitExe = path.join(gitCmdDir, 'git.exe');
  const bashExe = path.join(gitRoot, 'bin', 'bash.exe');
  // 真实安装态：git.exe 在 PATH 目录下、bash.exe 在安装根 bin/ 下，两者同时在
  const existsInstalled = (p: string): boolean => p === gitExe || p === bashExe;

  const candidates = windowsBashCandidates(env, existsInstalled);
  assert.ok(candidates.includes(bashExe), 'PATH 上 git.exe 的祖先根须纳入候选（非标准安装不再静默回落 cmd）');
  assert.ok(
    candidates.includes(path.join(gitRoot, 'usr', 'bin', 'bash.exe')),
    '每个候选根两种安装布局皆列（<root>/bin 与 <root>/usr/bin）',
  );

  assert.equal(findWindowsBash(env, existsInstalled), bashExe, '探测命中：可注入存在性判定');
  assert.equal(
    findWindowsBash(env, (p) => p === gitExe),
    undefined,
    '候选存在性必须逐个复核：只有 git.exe 而无 bash.exe 时不认账（诚实回落由 resolveShell 兜底）',
  );
});

test('ProcessSandbox 执行不存在命令返回失败', async () => {
  const s = new ProcessSandbox();
  const r = await s.exec('nonexistent_cmd_xyz');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'EXEC_FAILED');
});

test('DryRun 预览返回原命令', () => {
  const d = new DryRun();
  assert.equal(d.preview('rm -rf /'), 'rm -rf /');
});

test('ProcessSandbox 是 ToolBackend（name=process，含文件三方法）', () => {
  const b: ToolBackend = new ProcessSandbox();
  assert.equal(b.name, 'process');
  assert.equal(typeof b.readFile, 'function');
  assert.equal(typeof b.writeFile, 'function');
  assert.equal(typeof b.listFiles, 'function');
});

test('writeFile/readFile 往返（含父目录自动创建）', () => {
  const b = new ProcessSandbox();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-1d-'));
  const file = path.join(dir, 'a/b/c.txt');
  b.writeFile(file, 'hello 1d');
  assert.equal(b.readFile(file), 'hello 1d');
});

test('listFiles glob 语义：** 跨目录段、跳过 node_modules', () => {
  const b = new ProcessSandbox();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-1d-glob-'));
  fs.mkdirSync(path.join(dir, 'sub/node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'top.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'sub', 'deep.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'sub', 'node_modules', 'skip.txt'), 'x');
  const rel = b.listFiles(dir, '**/*.txt').sort();
  assert.deepEqual(rel, ['sub/deep.txt', 'top.txt']);
});
