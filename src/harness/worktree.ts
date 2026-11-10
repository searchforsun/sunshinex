/**
 * Worktree 隔离工作区单点模块（入口：启动旗标 --worktree 与会话内 worktree 工具）：
 * 本线全部 git 调用收敛于此——`spawnSync('git', args, { cwd, timeout })` 参数数组、无 shell 拼接、
 * 失败返回 `Result.fail`（错误码 `WORKTREE_*`），沿 perception Git 感知先例（perception.ts readGitBranch）。
 *
 * §1 现场核实结论（T1 编码前钉死，实施期已逐条验证）：
 * 1. exec 的 shell 工作目录来自 builtin.ts 闭包捕获的装配期 root（`safety.run(cmd, { cwd: root })`）——
 *    活动根下的 exec 锚定由 T4 经 builtinTools 末位 seam 注入 root 提供者解决，注册面形态零改动。
 * 2. builtinTools 第 2 参 root 仅喂 exec cwd 与 glob/grep 缺省根；文件路径安全全在 SafetyChain 注入的
 *    safePath——活动 root 判定收敛安全链（T2），工具注册面无需触碰。
 * 3. cli/index.ts 解析器：`--flag=v` / `--flag v` → 字符串，裸 flag（末尾无值）→ true；`--worktree <dir>`
 *    形态会吞下一个非 `--` 起始词，T3 用例钉 `--worktree=<name>` 紧凑形态为唯一取值通道。
 * 4. 安全链工具名为大写形态（'Read'/'Write'/'Grep'，PATH_TOOLS 集合 chain.ts 顶部）；读面恒开放名单 =
 *    非 'Write' 工具；记忆窄口判定先于活动根判定（2026-09-18 审查裁决序，序不破）。
 * 5. guard.ts acceptEdits 免审批先例 = `if (tool === 'spawn') return { allowed: true }`；read-only 闸门 =
 *    `if (this.mode === 'read-only')` 只读白名单段；T4 worktree 分支沿 spawn 落点追加。
 * 6. reactor.ts 并行闸门两处判定（批量执行与执行面校验），谓词「exec and ask must run exclusively」——
 *    T4 worktree 与 exec/ask 同列单发独占，谓词同处扩展。
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fail, ok, Result } from '../result';
import { resolveDataDir } from '../config/data-dir';
import { slugify } from '../slug';

/** worktree 登记条目（registry.json 数组元素；createdAt 属数据面文件，允许时间戳） */
interface WorktreeEntry {
  name: string;
  path: string;
  branch: string;
  sessionId?: string;
  createdAt: string;
  keptReason?: string;
}

interface CreateWorktreeOptions {
  sessionId?: string;
  fromBranch?: string;
  /** 签出既有分支(2026-11-10 用户裁定「隔离会话可指定分支」):给定点 `worktree add <树> <分支>`
   *  直签;分支不存在回退 `-b` 创建同名;分支已被其他 worktree 签出 → BRANCH_HELD(用户裁定
   *  「提示已被签出,引导重选」,错误原文含 already used by/already checked out) */
  branch?: string;
}

type CreateWorktreeResult = Result<{
  name: string;
  path: string;
  branch: string;
  copiedSettings: boolean;
}>;

type RemoveWorktreeResult = Result<'removed' | 'kept-dirty'>;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** slug 截断上限 27：为调用方追加的 `-` + 4 位随机尾留位（slug+尾 ≤ 32，名称上限 64 内充裕） */
const SLUG_MAX = 27;

export function isValidWorktreeName(name: string): boolean {
  return NAME_RE.test(name);
}

/** 自动名生成（--worktree 裸旗标）：`wt-` + 4 位随机小写字母数字（worktree.ts 单点，防入口散写） */
export function randomWorktreeName(): string {
  return `wt-${randomTail4()}`;
}

/** 4 位随机尾（名称生成共用单点：62^4 ≈ 1.48e7 组合，同批并发撞名概率可忽略；EXISTS 由调用方重试兜底） */
function randomTail4(): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let tail = '';
  for (let i = 0; i < 4; i++) tail += abc[Math.floor(Math.random() * abc.length)];
  return tail;
}

/** 子智能体专属树名（规格 2026-09-23-subagent-worktree-isolation §3）：`subagent-<净化label>-<4位随机>`；
 * slug 走 slugifyLabel 单点（空折叠回 's' 兜底），并行批多个隔离子智能体互不撞名 */
export function subagentTreeName(label: string): string {
  const slug = slugifyLabel(label) || 's';
  return `subagent-${slug}-${randomTail4()}`;
}

/** git 单点调用（§0.5 纪律）：参数数组、无 shell 拼接、超时 30s；零退出即成功（stderr 含 advice 噪声容忍），
 *  失败返回 WORKTREE_GIT_FAIL（message 附截断 stderr） */
function execGit(cwd: string, args: string[], timeoutMs = 30_000): Result<string> {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  if (r.error || r.status !== 0) {
    const stderr = String(r.stderr ?? r.error?.message ?? '').trim().slice(0, 400);
    return fail('WORKTREE_GIT_FAIL', stderr.length > 0 ? `git ${args[0]} failed: ${stderr}` : `git ${args[0]} failed (exit ${r.status})`);
  }
  return ok(String(r.stdout ?? '').trim());
}

function branchOf(name: string): string {
  return `worktree-${name}`;
}

/** 会话删档连带清树(2026-11-10 用户裁定 worktree 会话随 /session/:id DELETE 退役):
 *  入参=树路径(会话 root)。定位链:git -C <树> rev-parse --git-common-dir → 主仓 .git →
 *  主仓 dataDir 的 registry 按 path 反查条目 → 既有 removeWorktree(脏树 kept-dirty 保护照旧)。
 *  返回 removed / kept-dirty / not-worktree(普通会话或缺登记,调用方静默跳过) */
export function removeWorktreeForSession(
  treeRoot: string,
): { kind: 'removed' | 'kept-dirty' | 'not-worktree' } | { kind: 'error'; message: string } {
  const common = execGit(treeRoot, ['rev-parse', '--git-common-dir']);
  if (!common.ok) return { kind: 'not-worktree' };
  const commonDir = path.resolve(treeRoot, common.value.trim());
  const mainRoot = path.dirname(commonDir); // commonDir=主仓 .git 目录
  const dataDir = resolveDataDir(mainRoot);
  const entry = readRegistry(dataDir).find((e) => path.resolve(e.path) === path.resolve(treeRoot));
  if (entry === undefined) return { kind: 'not-worktree' };
  const r = removeWorktree(mainRoot, dataDir, entry.name);
  if (!r.ok) return { kind: 'error', message: r.error.message };
  return { kind: r.value };
}

export function isRepo(root: string): boolean {
  return execGit(root, ['rev-parse', '--git-common-dir']).ok;
}

/** 分支占用清单(2026-11-10 用户裁定「已签出分支禁用+标记」):git worktree list --porcelain 单点——
 *  occupied[分支]=签出它的 worktree 路径(含主工作区);GUI 菜单据此禁用+「已签出」标记,
 *  发送/切换时以 daemon 实测兜底(菜单清单可能过期) */
export function listWorktreeBranches(root: string): { occupied: Record<string, string>; mainBranch: string } {
  const r = execGit(root, ['worktree', 'list', '--porcelain']);
  const empty = { occupied: {} as Record<string, string>, mainBranch: '' };
  if (!r.ok) return empty;
  let currentPath = '';
  const occupied: Record<string, string> = {};
  let mainBranch = '';
  for (const line of r.value.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim();
      continue;
    }
    if (line.startsWith('branch ')) {
      const full = line.slice('branch '.length).trim();
      const short = full.startsWith('refs/heads/') ? full.slice('refs/heads/'.length) : full;
      occupied[short] = currentPath;
      if (mainBranch === '') mainBranch = short; // porcelain 输出首条=主工作区
    }
  }
  return { occupied, mainBranch };
}

function registryFilePath(dataDir: string): string {
  return path.join(worktreesRoot(dataDir), 'registry.json');
}

function persistRegistry(dataDir: string, entries: WorktreeEntry[]): void {
  fs.mkdirSync(worktreesRoot(dataDir), { recursive: true });
  fs.writeFileSync(registryFilePath(dataDir), JSON.stringify(entries, null, 2) + '\n');
}

/** label → 树名 slug 段（≤27 截断、全折叠回退 'wt'）：正则链单点在 src/slug.ts，本处只声明 worktree 方言参数 */
export function slugifyLabel(label: string): string {
  return slugify(label, { max: SLUG_MAX, fallback: 'wt' });
}

export function worktreesRoot(dataDir: string): string {
  return path.join(dataDir, 'worktrees');
}

/** 拷贝面目录（规格 §6.3 固定拷贝）：脏判据不计入——git 2.47 实测对链接 worktree 的 status 不读
 *  per-worktree info/exclude（排除文件方案失效），改由本单点过滤，零仓库侵入、版本行为解耦 */
const COPY_IGNORED_PREFIX = '.sunshinex/';

export function isDirty(root: string): boolean {
  const r = execGit(root, ['status', '--porcelain']);
  if (!r.ok) return true; // 非 git 仓 / git 失败 → 按脏兜底（fail-closed：宁保留勿误删）
  return r.value
    .split('\n')
    .filter((l) => l.length > 0)
    .some((l) => {
      const raw = l.slice(3); // porcelain v1：XY + 空格 + 路径
      const p = raw.includes(' -> ') ? raw.split(' -> ')[1]! : raw;
      if (p === '.sunshinex-worktree') return false; // 数据目录重定向标记(建树自带,非脏面)
      return !p.startsWith(COPY_IGNORED_PREFIX);
    });
}

/** 规格 §6.3：创建时固定拷贝 `.sunshinex/settings.json`（存在才拷、覆盖语义），返回拷贝事实 */
function copySettings(root: string, tree: string): boolean {
  const src = path.join(root, '.sunshinex', 'settings.json');
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.join(tree, '.sunshinex'), { recursive: true });
  fs.copyFileSync(src, path.join(tree, '.sunshinex', 'settings.json'));
  return true;
}

export function createWorktree(
  root: string,
  dataDir: string,
  name: string,
  opts: CreateWorktreeOptions = {},
): CreateWorktreeResult {
  if (!isValidWorktreeName(name)) {
    return fail('WORKTREE_INVALID_NAME', `invalid worktree name: ${JSON.stringify(name)} (expect /^[a-z0-9][a-z0-9-]{0,63}$/)`);
  }
  if (!isRepo(root)) {
    return fail('WORKTREE_NOT_A_REPO', `not a git repository: ${root}`);
  }
  // 树落位(2026-11-10 用户裁定):项目内 .git/sunshinex/worktrees/<name>——跟项目走、感知扫描
  // 天然跳过 .git、不污染 sunshinex 数据目录(旧 dataDir/worktrees 形态退役;.git/worktrees/<name>
  // 是 git 自身管理目录,marker 重定向标记仍落那里)
  const tree = path.join(root, '.git', 'sunshinex', 'worktrees', name);
  if (fs.existsSync(tree)) {
    return fail('WORKTREE_EXISTS', `worktree already exists: ${tree}`);
  }
  const branch = branchOf(name);
  // 分叉基点：显式 fromBranch → HEAD（unborn HEAD 是仓但无提交可分叉 → GIT_FAIL）
  const base = opts.fromBranch
    ? execGit(root, ['rev-parse', '--verify', '--quiet', `${opts.fromBranch}^{commit}`])
    : execGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!base.ok || base.value.length === 0) {
    return fail('WORKTREE_GIT_FAIL', `cannot resolve fork base (${opts.fromBranch ?? 'HEAD'}): ${base.ok ? 'no commits yet' : base.error.message}`);
  }
  try {
    fs.mkdirSync(worktreesRoot(dataDir), { recursive: true });
  } catch (e) {
    return fail('WORKTREE_GIT_FAIL', `cannot create worktrees root: ${e instanceof Error ? e.message : String(e)}`);
  }
  // branch 指定:直签既有分支(缺场=自动 worktree-<name> 专属分支,既有行为);分支缺失回退 -b 同名创建
  // (2026-11-10 用户裁定「输入框不填则创建随机/指定新分支」——一个参数同时覆盖 签出既有/创建新分支);
  // 分支已被其他 worktree 签出 → BRANCH_HELD(用户裁定「提示已被签出,引导重选」)
  let branchOut = opts.branch !== undefined && opts.branch !== '' ? opts.branch : branch;
  // 单次 add(先建树再签出会撞树已存在):branch 指定=直签既有(--no-track 仅 -b 形合法,裸签不带)/
  // 失败按名新建;缺场=自动专属分支。占用→ BRANCH_HELD(实测文案 'X' is already used by worktree)
  let added =
    opts.branch !== undefined && opts.branch !== ''
      ? execGit(root, ['worktree', 'add', tree, opts.branch])
      : execGit(root, ['worktree', 'add', '--no-track', '-b', branch, tree, base.value]);
  if (!added.ok && opts.branch !== undefined && opts.branch !== '' && /invalid reference|not found|bad revision/i.test(added.error.message)) {
    branchOut = opts.branch;
    added = execGit(root, ['worktree', 'add', '--no-track', '-b', opts.branch, tree, base.value]); // 不存在=按名新建
  }
  if (!added.ok) {
    if (/already used by|already checked out|already registered/i.test(added.error.message)) return fail('BRANCH_HELD', added.error.message);
    return fail(added.error.code, added.error.message);
  }
  // 数据目录重定向标记(2026-11-10 用户报障「worktree 会话不归主项目/tooltip 显假路径」根修):
  // 写在主仓 .git/worktrees/<name>/sunshinex-mainroot(工作树外——树内文件会让 worktree remove/
  // isDirty 误判脏)——resolveDataDir(树) 经树根 .git 文件(gitdir: 指针)定位此标记即改指主项目
  // 数据目录:会话档/记忆/学习技能全归主项目,侧栏分组与最近会话自动收敛
  try {
    const dotGit = fs.readFileSync(path.join(tree, '.git'), 'utf8');
    const m = /^gitdir:\s*(.+)$/m.exec(dotGit);
    if (m !== null) {
      fs.mkdirSync(m[1]!.trim(), { recursive: true });
      fs.writeFileSync(path.join(m[1]!.trim(), 'sunshinex-mainroot'), root, 'utf8');
    }
  } catch {
    // 标记写失败不挡建树(降级=旧形态各自 slug 目录,分组缺失但不损坏)
  }
  const copied = copySettings(root, tree);
  const entry: WorktreeEntry = {
    name,
    path: tree,
    branch: branchOut,
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    createdAt: new Date().toISOString(), // 数据面 registry 文件（规格 §12：不进提示词面）
  };
  const registry = readRegistry(dataDir).filter((e) => e.name !== name); // 同名竞态防御（正常已由 EXISTS 拒）
  registry.push(entry);
  persistRegistry(dataDir, registry);
  return ok({ name, path: tree, branch: branchOut, copiedSettings: copied });
}

export function removeWorktree(root: string, dataDir: string, name: string): RemoveWorktreeResult {
  const registry = readRegistry(dataDir);
  const entry = registry.find((e) => e.name === name);
  if (!entry) {
    return fail('WORKTREE_NOT_FOUND', `no registered worktree named ${JSON.stringify(name)}`);
  }
  if (isDirty(entry.path)) {
    const next = registry.map((e) => (e.name === name ? { ...e, keptReason: 'dirty' } : e));
    persistRegistry(dataDir, next);
    return ok('kept-dirty');
  }
  const removed = execGit(root, ['worktree', 'remove', entry.path]);
  if (!removed.ok) return fail(removed.error.code, removed.error.message);
  // 分支强删（-D）：worktree 移除即显式弃置裁决，干净树亦可含未合并提交
  execGit(root, ['branch', '-D', entry.branch]);
  try {
    fs.rmSync(entry.path, { recursive: true, force: true }); // 目录残影兜底（git 侧已 prune 场景）
  } catch {
    // 目录删除失败不翻转结果：git 元数据已移除
  }
  persistRegistry(dataDir, registry.filter((e) => e.name !== name));
  return ok('removed');
}

export function readRegistry(dataDir: string): WorktreeEntry[] {
  const file = registryFilePath(dataDir);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('registry is not an array');
    return parsed as WorktreeEntry[];
  } catch {
    persistRegistry(dataDir, []); // 损坏 → 重建空表不抛（后续写入自愈）
    return [];
  }
}
