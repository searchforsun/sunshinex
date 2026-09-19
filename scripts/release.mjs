#!/usr/bin/env node
// SunshineX 发版脚本（跨平台：Windows / macOS / Linux，node scripts/release.mjs）：
// 全量验证 → npm pack → 创建 GitHub Release 并上传 tgz 附件。
// 仅依赖 node 内置模块 + git / npm（pnpm 可选加速）/ gh 或 curl；不依赖 sh/sed/du/jq。
// 发布后任何机器一条链接直装（npm 原生支持 tarball URL）：
//   npm install -g https://github.com/<owner>/<repo>/releases/download/<tag>/<name>-<version>.tgz
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Windows 下 npm/pnpm 实体是 .cmd 脚本：Node ≥ 18.20（CVE-2024-27980）禁止 spawn 直接执行
// .cmd/.bat（一律 EINVAL），必须经 shell 调用；git/gh/curl/node 为原生可执行，免 shell 免引号语义
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const usage = () => {
  console.log(`用法: scripts/release.mjs [--version 0.2.0 | --bump patch|minor|major] [--dry-run] [--skip-verify] [--allow-dirty] [--clobber]

  --version X.Y.Z  以指定版本号发版：写回 package.json 并随发版提交推送（固定版本，不自动递增）
  --bump patch     发版前自动递增版本号并写回 package.json（随发版提交推送）：patch=0.1.0→0.1.1
  （不带两者）      使用 package.json 当前版本号直接发版（不自动递增；同版本重发加 --clobber）
  --dry-run        只做全量验证 + npm pack，不触网上传（打印将产生的安装链接）
  --skip-verify    跳过全量测试与 selfcheck（不推荐）
  --allow-dirty    允许工作区未提交/未推送时发布（tag 打在远端 HEAD，本地未推送提交不包含在内）
  --clobber        Release 已存在时覆盖同名附件（同版本重发用；缺省拒绝，防误覆盖已发布版本）

版本语义（链接随版本走，一次发布一个永久可回溯的地址）:
  每次发版必须对应新版本号 → 新 tag + 新链接，旧版本 Release 永不覆盖
  同版本号重发需显式 --clobber（覆盖该版本附件，链接不变）

上传通道（自动探测，三选一）:
  1. gh CLI（推荐）          gh auth login 一次即可（多仓库通用）
  2. GITHUB_TOKEN + curl     GITHUB_TOKEN=<pat> node scripts/release.mjs（JSON 解析已内建，无需 jq）
  3. git 凭据助手 + curl     复用 clone/push 已存的凭据（能 git push 通常即可用，无需另装 gh 或配 PAT）
  通道决议在开头完成：缺通道立即报出，不会等跑完全量验证与打包之后才失败。`);
};

const die = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};
const say = (msg) => console.log(`==> ${msg}`);

// PATH 探测（对标 sh 的 command -v；win32 按 PATHEXT 补全后缀）
function has(cmd) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, cmd + ext));
        return true;
      } catch {
        /* 继续探测 */
      }
    }
  }
  return false;
}

function run(cmd, args, opts = {}) {
  // win32 下 .cmd/.bat 只能经 shell 执行（Node ≥ 18.20 免 shell spawn 报 EINVAL）。
  // 启动式取 Node 官方文档给出的显式形态 spawn(cmd.exe, ['/c', cmd, ...args])，**不用** shell:true 与 args 并用：
  // 后者自 Node 22.15 起弃用（DEP0190——args 会被重拼并再转义一遍，多一层引号语义不确定）；
  // 本脚本传的皆为无空格无引号的简单 token（'pack' '--cache' '.npm-cache'），显式 argv 零转义、路径更窄。
  // windowsHide 抑制控制台闪窗（与 ProcessSandbox.exec 同口径）；POSIX 与 .exe 恒免 shell。
  const isWinScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  const file = isWinScript ? process.env.ComSpec ?? 'cmd.exe' : cmd;
  const argv = isWinScript ? ['/c', cmd, ...args] : args;
  const r = spawnSync(file, argv, { encoding: 'utf8', windowsHide: true, ...(opts.stdio ? { stdio: opts.stdio } : {}) });
  if (opts.allowFail) return r;
  if (r.error) die(`${cmd} 执行失败：${r.error.message}`);
  if (r.status !== 0) die(`${cmd} ${args.join(' ')} 失败（exit=${r.status}）${r.stderr ? `：${String(r.stderr).trim()}` : ''}`);
  return r;
}

// ---------- 参数解析 ----------
let DRY_RUN = false;
let SKIP_VERIFY = false;
let ALLOW_DIRTY = false;
let CLOBBER = false;
let TARGET_VERSION = '';
let BUMP = '';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') DRY_RUN = true;
  else if (a === '--skip-verify') SKIP_VERIFY = true;
  else if (a === '--allow-dirty') ALLOW_DIRTY = true;
  else if (a === '--clobber') CLOBBER = true;
  else if (a === '--version') {
    if (i + 1 >= argv.length) die('--version 需要版本号参数，如 --version 0.2.0');
    TARGET_VERSION = argv[++i];
  } else if (a === '--bump') {
    if (i + 1 >= argv.length) die('--bump 需要档位参数：patch | minor | major');
    BUMP = argv[++i];
  } else if (a === '-h' || a === '--help') {
    usage();
    process.exit(0);
  } else {
    die(`未知参数：${a}（--help 看用法）`);
  }
}
if (TARGET_VERSION && BUMP) die('--version 与 --bump 互斥，二选一');

// ---------- 定位仓库根（对标 sh 的 SCRIPT_DIR/ROOT 解析）----------
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SCRIPT_DIR);
process.chdir(ROOT);

// ---------- 依赖检查 ----------
if (!has('git')) die('需要 git');
if (!has(NPM) && !has('npm')) die('需要 npm');

// ---------- 版本计算 ----------
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let VERSION = pkg.version;

// 目标版本：--version 显式指定 > --bump 按档位递增 > 缺省用 package.json 当前版本
if (BUMP) {
  if (!['patch', 'minor', 'major'].includes(BUMP)) die('--bump 仅支持 patch | minor | major');
  const [maj, min, pat] = VERSION.split('.').map(Number);
  const out = BUMP === 'major' ? [maj + 1, 0, 0] : BUMP === 'minor' ? [maj, min + 1, 0] : [maj, min, pat + 1];
  TARGET_VERSION = out.join('.');
}
if (TARGET_VERSION) {
  if (!/^\d+\.\d+\.\d+$/.test(TARGET_VERSION)) die(`版本号须为 X.Y.Z 形态：${TARGET_VERSION}`);
  if (TARGET_VERSION === VERSION && !CLOBBER) {
    die(`目标版本与当前版本相同（${VERSION}）：换新版本号发新 Release，同版本重发加 --clobber`);
  }
}

const TAG = `v${VERSION}`;
let TGZ_NAME = `sunshinex-agent-${VERSION}.tgz`;

// ---------- origin → owner/repo ----------
const remoteUrl = run('git', ['remote', 'get-url', 'origin'], { allowFail: true }).stdout?.trim() || '';
if (!remoteUrl) die('未找到 origin 远程');
const REPO = remoteUrl.replace(/^git@github\.com:/, '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
if (!/^[^/]+\/[^/]+$/.test(REPO)) die(`origin 不是 github 仓库：${REPO}`);

// ---------- 上传通道（开始处决议）----------
// 决议必须早于全量验证：缺通道却要跑完 tsc + 全量测试 + 打包几分钟才报错，纯属白等。
// git 协议本身**没有**上传 Release 附件的能力（附件只存在于 REST API），但 git 为 clone/push 存下的凭据可以复用来调 API——
// 这正是「本机已经能用 git 推代码」时该有的默认体验：不必为发版再装 gh 或另配 PAT。
const HOST = 'github.com'; // 两种受支持的 origin 形态（https://github.com/…、git@github.com:…）都指向它

/**
 * 从 git 凭据助手取令牌（git credential fill）。
 * 非交互硬化三件 + 超时：取凭据不该把发版挂住等输入——credential.interactive=false（git ≥2.36 口径）、
 * GIT_TERMINAL_PROMPT=0、GCM_INTERACTIVE=never（兼容老版凭据管理器）。
 * 取不到即诚实返回 null（凭据助手为空 / origin 走 SSH 未存令牌 / helper 拒绝非交互取用），由上层给替代路径。
 */
function tokenFromGitCredential() {
  const r = spawnSync('git', ['-c', 'credential.interactive=false', 'credential', 'fill'], {
    input: `protocol=https\nhost=${HOST}\n\n`,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  if (r.status !== 0 || !r.stdout) return null;
  const password = /^password=(.*)$/m.exec(r.stdout)?.[1]?.trim() ?? '';
  return password.length > 0 ? password : null;
}

/** 通道决议：gh CLI 优先（一次登录多仓库通用）；否则 curl + 令牌（环境变量 > git 凭据助手） */
function resolveChannel() {
  if (has('gh')) return { kind: 'gh', label: 'gh CLI' };
  if (!has('curl')) return null;
  const envToken = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (envToken) return { kind: 'curl', token: envToken, label: 'GitHub API + curl', auth: 'GITHUB_TOKEN 环境变量' };
  const gitToken = tokenFromGitCredential();
  if (gitToken) return { kind: 'curl', token: gitToken, label: 'GitHub API + curl', auth: 'git 凭据助手（复用 clone/push 已存凭据）' };
  return null;
}

const CHANNEL = resolveChannel();
if (CHANNEL) {
  say(`上传通道：${CHANNEL.label}${CHANNEL.auth ? `（凭据来源：${CHANNEL.auth}）` : ''}`);
} else if (DRY_RUN) {
  say('上传通道：未探测到（--dry-run 不阻断；正式发版见 --help 的三条通道）');
} else {
  die('缺少上传通道，三选一：① 装 gh CLI 并 gh auth login；② 设 GITHUB_TOKEN=<pat> 后重跑；③ 让 git 凭据助手存有本仓库凭据（git 协议不能上传 Release 附件，只能复用凭据走 API）');
}

/**
 * 调 GitHub API 并一次取回「状态码 + 正文」。失败的正文才是诊断依据——`curl -sf` 会把状态码与错误正文一起吞掉，
 * 只剩一句「失败」（本脚本第一次实跑创建 Release 失败时就是这样一无所获）。
 * 状态码取自 `-i` 带回的响应头（取末个 HTTP/ 行，兼容代理 100-continue），不落临时文件。
 */
function ghApi(method, url, token, opts = {}) {
  const args = ['-sS', '-i', '-X', method, '-H', `Authorization: Bearer ${token}`, '-H', 'Accept: application/vnd.github+json'];
  if (opts.json !== undefined) args.push('-H', 'Content-Type: application/json', '--data-binary', opts.json);
  if (opts.file !== undefined) args.push('-H', 'Content-Type: application/octet-stream', '--data-binary', `@${opts.file}`);
  args.push(url);
  const r = spawnSync('curl', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const lines = (r.stdout || '').split('\n');
  let status = 0;
  let bodyFrom = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('HTTP/')) continue;
    const code = lines[i].split(' ')[1] || '';
    if (code.length === 3 && Number.isInteger(Number(code))) {
      status = Number(code);
      bodyFrom = i + 1;
    }
  }
  // 末个状态行之后可能还有剩余响应头，跳到空行再取正文
  while (bodyFrom < lines.length && lines[bodyFrom].trim() !== '') bodyFrom++;
  return { status, body: lines.slice(bodyFrom + 1).join('\n'), error: r.error, stderr: r.stderr };
}

/** 把一次 API 失败讲清楚：HTTP 状态 + GitHub 原文 message + 按状态给出的可操作处置 */
function apiFail(what, res) {
  if (res.error) die(`${what}失败：curl 执行出错（${res.error.message}）`);
  let msg = '';
  try {
    msg = JSON.parse(res.body)?.message || '';
  } catch {
    msg = String(res.body || '').trim().slice(0, 200);
  }
  const hint =
    res.status === 401 ? '凭据无效或已过期：重新登录，或换一个 PAT' :
    res.status === 403 ? '凭据权限不足（创建 Release 需要 contents:write），或组织仓库未在该令牌上完成 SSO 授权' :
    res.status === 404 ? '这份凭据看不到该仓库：多半是别的账号或只读令牌' :
    res.status === 422 ? '参数被拒：常见为 tag 已存在或 target 提交不可用' :
    '见上方 GitHub 原文';
  die(`${what}失败：HTTP ${res.status}${msg ? ` · ${msg}` : ''}（${hint}）`);
}

/**
 * 凭据预检（真实发版、且走 API 通道时）：在跑全量验证之前先问清「这份凭据是谁、能不能写这个仓库」。
 * 两问合一——GET /repos 取该仓库的 push 权限（创建 Release 需要 contents:write），GET /user 取身份
 * （暴露「凭据助手存的是另一个账号」这类错配）。存在的理由：权限不足原本要到验证 + 打包几分钟之后、
 * 以一句无信息的失败暴露；预检把同一判断提前到约一秒。--dry-run 恒不联网，故预检只在真实发版跑。
 */
function preflight(token) {
  const repo = ghApi('GET', `https://api.github.com/repos/${REPO}`, token);
  if (repo.status !== 200) apiFail('仓库访问预检', repo);
  const who = ghApi('GET', 'https://api.github.com/user', token);
  let login = '';
  try {
    login = JSON.parse(who.body)?.login || '';
  } catch {
    /* 正文非 JSON：身份降级为未知，不阻断发版 */
  }
  const identity = who.status === 200 && login ? login : `未知（HTTP ${who.status}）`;
  let push = null;
  try {
    push = JSON.parse(repo.body)?.permissions?.push ?? null;
  } catch {
    /* 无 permissions 字段则不下结论 */
  }
  if (push === false) {
    die(
      `凭据预检：身份 ${identity} 对 ${REPO} 只有读权限（push=false），无法创建 Release。补写权限三选一：` +
        '① 把带写权限的 PAT 交回 git 凭据助手（写法见 README 发版段）；② GITHUB_TOKEN=<PAT> 重跑本脚本；③ 装 gh CLI 并 gh auth login',
    );
  }
  say(`凭据预检：身份 ${identity}；${REPO} push=${push === true ? 'yes' : 'unknown'}`);
}

if (!DRY_RUN && CHANNEL.kind === 'curl') preflight(CHANNEL.token);

// ---------- 工作区与上游一致性 ----------
if (!DRY_RUN && !ALLOW_DIRTY) {
  const dirty = run('git', ['status', '--porcelain'], { allowFail: true }).stdout || '';
  if (dirty.trim()) die('工作区有未提交改动：先提交推送，或加 --allow-dirty');
  const upstream = run('git', ['rev-parse', '@{u}'], { allowFail: true }).stdout?.trim() || '';
  const head = run('git', ['rev-parse', 'HEAD']).stdout.trim();
  if (upstream && upstream !== head) die('本地 HEAD 与上游不一致：先 git push，或加 --allow-dirty');
}

// ---------- 全量验证 ----------
if (!SKIP_VERIFY) {
  say('全量验证（tsc + node --test 全量 + selfcheck）');
  if (has(PNPM) || has('pnpm')) run(PNPM, ['run', 'test'], { stdio: 'inherit' });
  else run(NPM, ['run', 'test'], { stdio: 'inherit' });
  run(process.execPath, ['dist/cli/index.js', 'selfcheck'], { stdio: 'inherit' });
}

// ---------- 版本落库 ----------
if (TARGET_VERSION && TARGET_VERSION !== VERSION) {
  if (DRY_RUN) {
    say(`--dry-run：版本号将 ${VERSION} → ${TARGET_VERSION}（未落库；正式运行将提交 v${TARGET_VERSION} 并上传新 Release）`);
    console.log(`  安装链接：npm install -g https://github.com/${REPO}/releases/download/v${TARGET_VERSION}/sunshinex-agent-${TARGET_VERSION}.tgz`);
    process.exit(0);
  }
  say(`版本号 ${VERSION} → ${TARGET_VERSION}（写回 package.json，随发版提交推送）`);
  run(NPM, ['version', TARGET_VERSION, '--no-git-tag-version', '--cache', '.npm-cache'], { stdio: 'ignore' });
  run('git', ['add', '-A'], { stdio: 'inherit' });
  run('git', ['commit', '-m', `chore(release): v${TARGET_VERSION}`], { stdio: 'inherit' });
  if (run('git', ['push'], { stdio: 'inherit', allowFail: true }).status !== 0) die('版本提交推送失败：处理后重发');
  VERSION = TARGET_VERSION;
  TGZ_NAME = `sunshinex-agent-${VERSION}.tgz`;
}

// ---------- npm pack ----------
say(`npm pack → ${TGZ_NAME}`);
const packOut = run(NPM, ['pack', '--cache', '.npm-cache']).stdout || '';
const TGZ = packOut.trim().split('\n').filter(Boolean).pop() || '';
if (!TGZ || !fs.existsSync(TGZ)) die(`npm pack 未产出 ${TGZ_NAME}（实际输出：${TGZ || packOut.trim()}）`);
const bytes = fs.statSync(TGZ).size;
const humanSize = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;
say(`包体：${humanSize} ${TGZ}`);

const DOWNLOAD_URL = `https://github.com/${REPO}/releases/download/${TAG}/${TGZ}`;
const NOTES = `SunshineX TUI ${TAG}. Install: npm install -g ${DOWNLOAD_URL}`;
const HEAD = run('git', ['rev-parse', 'HEAD']).stdout.trim();

if (DRY_RUN) {
  say(`--dry-run 结束：未创建 Release、未上传附件。正式发布将经 ${CHANNEL ? CHANNEL.label : '（当前无可用通道，需先补通道）'} 上传 ${TGZ_NAME}`);
  console.log(`  安装链接：npm install -g ${DOWNLOAD_URL}`);
  process.exit(0);
}

// ---------- 上传 ----------
// CHANNEL 非空由开头的早决保证（真实发版缺通道已在验证前 die；dry-run 已在 pack 后 exit）。
if (CHANNEL.kind === 'gh') {
  say(`创建 Release ${TAG}（gh CLI）`);
  if (run('gh', ['release', 'view', TAG, '-R', REPO], { allowFail: true }).status === 0) {
    if (!CLOBBER) die(`Release ${TAG} 已存在：发新版本用 --version/--bump，覆盖该版本附件加 --clobber`);
    run('gh', ['release', 'upload', TAG, TGZ, '-R', REPO, '--clobber'], { stdio: 'inherit' });
    say(`Release ${TAG} 附件覆盖上传完成`);
  } else {
    run('gh', ['release', 'create', TAG, TGZ, '-R', REPO, '--target', HEAD, '--title', TAG, '--notes', NOTES], { stdio: 'inherit' });
  }
} else {
  const API = `https://api.github.com/repos/${REPO}/releases`;
  say(`发布 ${TAG}（GitHub API）`);
  // 存在性用 GET 直接问：一次调用同时拿到状态与已有 Release 正文，不去猜 HEAD 的行为
  const probe = ghApi('GET', `${API}/tags/${TAG}`, CHANNEL.token);
  let release;
  if (probe.status === 200) {
    release = JSON.parse(probe.body);
    if (!CLOBBER) die(`Release ${TAG} 已存在：发新版本用 --version/--bump，覆盖该版本附件加 --clobber`);
    say(`Release ${TAG} 已存在（id=${release.id}），--clobber 覆盖同名附件`);
  } else if (probe.status === 404) {
    const created = ghApi('POST', API, CHANNEL.token, {
      json: JSON.stringify({ tag_name: TAG, name: TAG, body: NOTES, target_commitish: HEAD }),
    });
    if (created.status !== 201) apiFail('创建 Release', created);
    release = JSON.parse(created.body);
  } else {
    apiFail('查询已有 Release', probe);
  }
  const uploadUrl = String(release.upload_url || '').split('{')[0];
  if (!uploadUrl || uploadUrl === 'null') die('未取得 upload_url');
  // --clobber 的真语义：REST 上传同名附件一律 422 already_exists，必须先删旧附件再传。
  // gh 的 --clobber 是它自己封装了这一步；curl 通道此前只认了参数没做这件事，故「已存在 + --clobber」必然 422。
  if (CLOBBER) {
    const dup = (Array.isArray(release.assets) ? release.assets : []).find((a) => a.name === TGZ_NAME);
    if (dup) {
      const del = ghApi('DELETE', `https://api.github.com/repos/${REPO}/releases/assets/${dup.id}`, CHANNEL.token);
      if (del.status !== 204 && del.status !== 200) apiFail(`删除同名旧附件 ${dup.name}`, del);
      say(`已删除同名旧附件 ${dup.name}（${Math.max(1, Math.round((dup.size || 0) / 1024))}KB）`);
    }
  }
  const up = ghApi('POST', `${uploadUrl}?name=${TGZ_NAME}`, CHANNEL.token, { file: TGZ });
  if (up.status !== 201) apiFail('附件上传', up);
  say(`附件已上传：${TGZ_NAME}（${humanSize}）`);
}

say('发布完成');
console.log(`  Release 页：https://github.com/${REPO}/releases/tag/${TAG}`);
console.log(`  安装命令：npm install -g ${DOWNLOAD_URL}`);
