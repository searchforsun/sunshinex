/**
 * Worktree 隔离工作区单点模块（计划 docs/superpowers/plans/2026-09-20-worktree-isolation.md T1）：
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
 * 5. guard.ts manual 免审批先例 = `if (tool === 'spawn') return { allowed: true }`；plan 只读闸门 =
 *    `if (this.mode === 'plan')` 只读白名单段；T4 worktree 分支沿 spawn 落点追加。
 * 6. reactor.ts 并行闸门两处判定（批量执行与执行面校验），谓词「exec and ask must run exclusively」——
 *    T4 worktree 与 exec/ask 同列单发独占，谓词同处扩展。
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fail, ok, Result } from '../result';

/** worktree 登记条目（registry.json 数组元素；createdAt 属数据面文件，允许时间戳） */
export interface WorktreeEntry {
  name: string;
  path: string;
  branch: string;
  sessionId?: string;
  createdAt: string;
  keptReason?: string;
}

export interface CreateWorktreeOptions {
  sessionId?: string;
  fromBranch?: string;
}

export type CreateWorktreeResult = Result<{
  name: string;
  path: string;
  branch: string;
  copiedSettings: boolean;
}>;

export type RemoveWorktreeResult = Result<'removed' | 'kept-dirty'>;

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

/** 子代理专属树名（规格 §9）：`subagent-<净化label>-<4位随机>`；slug 走 slugifyLabel 单点（空折叠回 's' 兜底） */
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

function isRepo(root: string): boolean {
  return execGit(root, ['rev-parse', '--git-common-dir']).ok;
}

function registryFilePath(dataDir: string): string {
  return path.join(worktreesRoot(dataDir), 'registry.json');
}

function persistRegistry(dataDir: string, entries: WorktreeEntry[]): void {
  fs.mkdirSync(worktreesRoot(dataDir), { recursive: true });
  fs.writeFileSync(registryFilePath(dataDir), JSON.stringify(entries, null, 2) + '\n');
}

export function slugifyLabel(label: string): string {
  const folded = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return folded.length > 0 ? folded : 'wt';
}

export function worktreesRoot(dataDir: string): string {
  return path.join(dataDir, 'worktrees');
}

export function detectIsolation(root: string): boolean {
  const gitDir = execGit(root, ['rev-parse', '--git-dir']);
  const commonDir = execGit(root, ['rev-parse', '--git-common-dir']);
  // 非 git 仓 / 探测失败 → 按普通仓（fail-closed 不误判隔离）
  if (!gitDir.ok || !commonDir.ok) return false;
  // linked worktree 判定前提：git-dir ≠ common-dir（resolve 归一防相对/绝对形态误比）
  if (path.resolve(root, gitDir.value) === path.resolve(root, commonDir.value)) return false;
  // submodule 同样满足上式（Step 0 护栏）：superproject 非空按普通仓处理
  const superProject = execGit(root, ['rev-parse', '--show-superproject-working-tree']);
  return superProject.ok && superProject.value.length === 0;
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
  const tree = path.join(worktreesRoot(dataDir), name);
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
  const added = execGit(root, ['worktree', 'add', '--no-track', '-b', branch, tree, base.value]);
  if (!added.ok) return fail(added.error.code, added.error.message);
  const copied = copySettings(root, tree);
  const entry: WorktreeEntry = {
    name,
    path: tree,
    branch,
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    createdAt: new Date().toISOString(), // 数据面 registry 文件（规格 §12：不进提示词面）
  };
  const registry = readRegistry(dataDir).filter((e) => e.name !== name); // 同名竞态防御（正常已由 EXISTS 拒）
  registry.push(entry);
  persistRegistry(dataDir, registry);
  return ok({ name, path: tree, branch, copiedSettings: copied });
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
