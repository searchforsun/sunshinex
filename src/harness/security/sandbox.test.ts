import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ProcessSandbox,
  findWindowsBash,
  findWindowsPowerShell,
  isWslBashLauncherDir,
  resolveShell,
  resolveShellFor,
  windowsBashCandidates,
  windowsPowerShellCandidates,
} from './sandbox';
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
    const forced = resolveShell();
    assert.deepEqual({ file: forced.file, args: forced.args }, { file: '/custom/sh', args: ['-c'] });
    assert.equal(forced.source, 'override');
    process.env.SUNSHINEX_SHELL = '   ';
    assert.notEqual(resolveShell().file, '   ', '空串覆盖视为未设置');
  } finally {
    if (prev === undefined) delete process.env.SUNSHINEX_SHELL;
    else process.env.SUNSHINEX_SHELL = prev;
  }
  const s = resolveShell();
  assert.ok(s.file.length > 0, '必须给出 shell 可执行文件');
  assert.ok(s.args.length > 0, '必须给出脚本标志');
  // 缺省决议随平台走：POSIX shell 与 Git Bash 为 -c；Windows 的 PowerShell 为 -NoProfile -Command；ComSpec 兜底为 /c
  assert.ok(s.args.includes('-c') || s.args.includes('-Command') || s.args.includes('/c'), `脚本标志应可识别，实际 ${s.args.join(' ')}`);
});

/**
 * Windows 决议序（纯函数注入，POSIX 上亦可完整回归）：Git Bash → PowerShell（pwsh 先于 powershell.exe）→ ComSpec 末位。
 * 对齐 Claude Code 口径：native Windows 无 Git for Windows 时用 PowerShell 作 shell 工具而非退回 cmd.exe。
 */
test('resolveShell 决议序：win32 逐级回落 git-bash → powershell → comspec，override 压过一切', () => {
  const cmdExe = path.join(path.sep, 'Windows', 'System32', 'cmd.exe');
  const base = { PATH: '', ComSpec: cmdExe };
  const bashExe = path.join(path.sep, 'git', 'bin', 'bash.exe');
  const pwshExe = path.join(path.sep, 'tools', 'pwsh.exe');
  const inBoxPs = path.join(path.sep, 'Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  // ① Git Bash 命中即用（POSIX 兼容，承载 sh 语义）
  assert.deepEqual(resolveShellFor('win32', { ...base, PATH: path.join(path.sep, 'git', 'bin') }, (p) => p === bashExe), {
    file: bashExe,
    args: ['-c'],
    source: 'git-bash',
  });

  // ② 无 Git Bash → PowerShell（-NoProfile 抑制 profile 输出污染 observation）
  assert.deepEqual(resolveShellFor('win32', { ...base, PATH: path.join(path.sep, 'tools') }, (p) => p === pwshExe), {
    file: pwshExe,
    args: ['-NoProfile', '-Command'],
    source: 'powershell',
  });

  // ③ 仅 in-box Windows PowerShell（未挂 PATH 亦须被 SystemRoot 固定位置发现）
  const onlyInBox = resolveShellFor('win32', { ...base, SystemRoot: path.join(path.sep, 'Windows') }, (p) => p === inBoxPs);
  assert.equal(onlyInBox.source, 'powershell');
  assert.equal(onlyInBox.file, inBoxPs);

  // ④ 三者皆无 → ComSpec 末位兜底（诚实登记：仅保证不崩）
  assert.deepEqual(resolveShellFor('win32', base, () => false), { file: cmdExe, args: ['/c'], source: 'comspec' });
  assert.deepEqual(resolveShellFor('win32', { PATH: '' }, () => false), { file: 'cmd.exe', args: ['/c'], source: 'comspec' });

  // ⑤ 逃生口最高：override 命中时不再探测任何候选
  assert.deepEqual(resolveShellFor('win32', { SUNSHINEX_SHELL: '/custom/sh', PATH: '' }, () => true), {
    file: '/custom/sh',
    args: ['-c'],
    source: 'override',
  });

  // ⑥ POSIX 不走 Windows 分支
  assert.deepEqual(resolveShellFor('linux', {}), { file: '/bin/sh', args: ['-c'], source: 'posix' });
});

test('Windows PowerShell 发现：pwsh 整体先于 powershell.exe，且覆盖 PATH 之外的固定安装位（纯逻辑）', () => {
  // 路径不含卷号：POSIX 下 path.delimiter 为 ':'，含 'C:' 的路径会被切成两段致候选失真
  const toolsDir = path.join(path.sep, 'tools');
  const programFiles = path.join(path.sep, 'program-files');
  const localAppData = path.join(path.sep, 'users', 'u', 'AppData', 'Local');
  const sysRoot = path.join(path.sep, 'Windows');
  const env = { PATH: toolsDir, ProgramFiles: programFiles, LOCALAPPDATA: localAppData, SystemRoot: sysRoot };

  const candidates = windowsPowerShellCandidates(env);
  const pwshCandidates = [path.join(toolsDir, 'pwsh.exe'), path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'), path.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe')];
  const legacyCandidates = [path.join(toolsDir, 'powershell.exe'), path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')];
  for (const c of [...pwshCandidates, ...legacyCandidates]) assert.ok(candidates.includes(c), `候选须含 ${c}`);

  const lastPwsh = candidates.map((c) => path.basename(c)).lastIndexOf('pwsh.exe');
  const firstLegacy = candidates.findIndex((c) => path.basename(c) === 'powershell.exe');
  assert.ok(lastPwsh >= 0 && firstLegacy > lastPwsh, 'pwsh（PowerShell 7+）整体先于 powershell.exe（5.1）：能力面更强');

  const pwshExe = path.join(toolsDir, 'pwsh.exe');
  assert.equal(findWindowsPowerShell(env, (p) => p === pwshExe), pwshExe, '探测命中：可注入存在性判定');
  assert.equal(findWindowsPowerShell(env, () => false), undefined, '皆不存在时诚实返回 undefined，由 resolveShellFor 回落 ComSpec');
});

test('WSL 启动器判定：锚定系统目录与别名目录，用户自建同名路径不误伤', () => {
  const sysRoot = path.join(path.sep, 'Windows');
  const env = { SystemRoot: sysRoot, LOCALAPPDATA: path.join(path.sep, 'users', 'u', 'AppData', 'Local') };
  for (const leaf of ['System32', 'SysWOW64', 'Sysnative']) {
    assert.equal(isWslBashLauncherDir(path.join(sysRoot, leaf), env), true, `${leaf} 系 WSL 启动器落点`);
  }
  assert.equal(isWslBashLauncherDir(path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps'), env), true, '应用执行别名目录同为启动器落点');
  assert.equal(isWslBashLauncherDir(path.join(path.sep, 'opt', 'git', 'bin'), env), false, 'Git 的 bin 目录不受影响');
  // 锚定校验：系统目录位置由 SystemRoot 给出，不靠目录名猜——否则用户自建的 <任意路径>\System32 会被误拒
  assert.equal(isWslBashLauncherDir(path.join(path.sep, 'opt', 'System32'), env), false, '非 SystemRoot 下的同名目录不误判');
  assert.equal(isWslBashLauncherDir(path.join(path.sep, 'Windows', 'System32'), {}), true, 'SystemRoot 不可得时按目录名兜底');
});

/**
 * WSL 启动器与 Git Bash 同名（都叫 bash.exe），却完全不是一回事——误选一次错三处：
 * PATH 不继承（宿主装的 node/npm 在发行版里 not found）、路径变 /mnt/<盘>/…（与调用方的 Windows 路径口径不符）、
 * 首次调用等发行版 VM 冷启动（实测 24–32 秒）且其持有 Windows 目录句柄致测试清理 EBUSY。
 * 本组用例把「不选它」钉死，并覆盖与真 Git Bash 并存时的优先序。
 */
test('Windows Git Bash 发现：WSL 启动器在 PATH 上也不得选中（装机常态下它恰排最前）', () => {
  const sysRoot = path.join(path.sep, 'Windows');
  const system32 = path.join(sysRoot, 'System32');
  const gitRoot = path.join(path.sep, 'opt', 'custom-git');
  const gitCmdDir = path.join(gitRoot, 'cmd');
  const wslBash = path.join(system32, 'bash.exe');
  const gitExe = path.join(gitCmdDir, 'git.exe');
  const gitBash = path.join(gitRoot, 'bin', 'bash.exe');

  // 装了 WSL 的宿主：System32 恒在 PATH 上且其 bash.exe 存在——按文件名字符匹配恰是最靠前的候选
  const env = { SystemRoot: sysRoot, PATH: system32 };
  const wslOnly = (p: string): boolean => p === wslBash;
  assert.equal(windowsBashCandidates(env, wslOnly).includes(wslBash), false, 'WSL 启动器不进候选表');
  assert.equal(findWindowsBash(env, wslOnly), undefined, '只有 WSL 时不认账（诚实回落下一级，不误当 Git Bash）');

  // 与真 Git Bash 并存：选 Git Bash，仍不选 WSL 启动器
  const both = { ...env, PATH: [system32, gitCmdDir].join(path.delimiter) };
  const existsBoth = (p: string): boolean => p === wslBash || p === gitExe || p === gitBash;
  assert.equal(findWindowsBash(both, existsBoth), gitBash, '真 Git Bash 优先于同名 WSL 启动器');

  // 决议序集成口径：WSL 存在但 Git Bash 缺席 → 走 PowerShell 一级，绝不落到 WSL
  const toolsDir = path.join(path.sep, 'tools');
  const psExe = path.join(toolsDir, 'pwsh.exe');
  const resolved = resolveShellFor(
    'win32',
    { SystemRoot: sysRoot, PATH: [system32, toolsDir].join(path.delimiter), ComSpec: path.join(system32, 'cmd.exe') },
    (p) => p === wslBash || p === psExe,
  );
  assert.equal(resolved.file, psExe, 'WSL 启动器不参与决议');
  assert.equal(resolved.source, 'powershell');
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

test('execBackground：提交即返回 pid，进程在跑，输出直写回调', async () => {
  const sb = new ProcessSandbox();
  const chunks: string[] = [];
  let exited: (() => void) | undefined;
  const done = new Promise<void>((r) => { exited = r; });
  const r = await sb.execBackground('echo bg-hello && sleep 1', {
    onData: (d) => chunks.push(d),
    onExit: () => exited?.(),
  });
  assert.ok(r.ok, '提交应成功');
  assert.ok(r.ok && r.value.pid > 0);
  await done;
  assert.ok(chunks.join('').includes('bg-hello'), 'stdout 应经 onData 回调');
});

test('exec timeoutToBackground：到点不杀进程、返回存活子进程与已缓冲输出', async () => {
  const sb = new ProcessSandbox();
  // 断言前提是超时到点前「warm」已进入缓冲——阈值须盖过 shell 冷启动 + node 冷启动（win32 实测 Git Bash 首字 ~1–1.4s、PowerShell 冷启动 ~0.5–1s；POSIX /bin/sh 毫秒级）
  const timeoutMs = process.platform === 'win32' ? 3000 : 300;
  // 命令前提对 shell 中立（§14 测试命令形态）：node 脚本文件承载「先输出后长驻」——
  // sh 独有语法（&&、sleep）在 PowerShell 5.1 / ComSpec 回落面上语义不成立（真机 EXEC_FAILED@659ms 即 PS5.1 对 && 的解析错误）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-ttob-'));
  const script = path.join(dir, 'warm-hold.js');
  fs.writeFileSync(script, "console.log('warm'); setTimeout(() => {}, 5000);\n");
  const r = await sb.exec(`node "${script.replace(/\\/g, '/')}"`, { timeoutMs, timeoutToBackground: true });
  assert.ok(r.ok, `期望 ok，实际 ${r.ok ? '' : r.error.code}`);
  assert.equal(r.value.timedOut, true);
  assert.ok(r.value.stdout.includes('warm'), '超时前已缓冲输出随 child 交回');
  const child = r.value.child!;
  assert.ok(child.pid, '存活子进程句柄');
  assert.equal(child.killed, false);
  sb.killBackground(child.pid!);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('killBackground：同步收割后任务 cwd 目录可立即删除', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-killbg-'));
  const sb = new ProcessSandbox();
  // 命令前提对 shell 中立（§14）：node 脚本长驻（sh 的 sleep 在 PowerShell 回落面上立即退出、收割断言成空洞通过）
  const script = path.join(root, 'hold.js');
  fs.writeFileSync(script, "setTimeout(() => {}, 60000);\n");
  const r = await sb.execBackground(`node "${script.replace(/\\/g, '/')}"`, { cwd: root });
  assert.ok(r.ok && r.value.pid > 0);
  sb.killBackground(r.value.pid);
  // 返回即进程树已收割，cwd 目录可删
  fs.rmSync(root, { recursive: true, force: true });
});

test('exec timeoutToBackground：正常快速命令语义不变', async () => {
  const sb = new ProcessSandbox();
  const r = await sb.exec('echo fast-ok', { timeoutToBackground: true });
  assert.ok(r.ok);
  assert.equal(r.value.timedOut, false);
  assert.equal(r.value.stdout.trim(), 'fast-ok');
});
