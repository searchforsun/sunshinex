import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Result, ok, fail } from '../result';
import type { ChangeFile } from '../types';

/**
 * G14.99 工作区未提交变动面（Diff 标签数据源）：git 只读探测 + commit/push 执行。
 * 全部经 execFile 参数数组（零 shell 拼接，message/路径不进命令行解析），cwd 钉 session root。
 * 非 git 仓库 → 零文件空态（前端示「不是 git 仓库」引导）；错误回 Result 带 stderr 摘要。
 */

const MAX_DIFF_BYTES = 512 * 1024;

function git(root: string, args: string[]): Promise<{ ok: true; out: string } | { ok: false; err: string }> {
  return new Promise((resolve) => {
    execFile('git', ['-C', root, ...args], { maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err !== null) {
        const msg = String(stderr ?? err.message ?? '').trim().split('\n').slice(-3).join(' | ').slice(0, 400);
        resolve({ ok: false, err: msg || 'git failed' });
        return;
      }
      resolve({ ok: true, out: String(stdout ?? '') });
    });
  });
}

/** 未提交变动清单：working tree + index 合并视图（git status --porcelain 单源，numstat 补行数） */
export async function listChanges(root: string): Promise<Result<{ branch: string; files: ChangeFile[]; staged?: ChangeFile[]; unstaged?: ChangeFile[] }>> {
  if (!fs.existsSync(path.join(root, '.git'))) return ok({ branch: '', files: [] });
  const st = await git(root, ['status', '--porcelain=v1', '-b']);
  if (!st.ok) return fail('CHANGES_STATUS', st.err);
  const lines = st.out.split('\n').filter((l) => l.trim().length > 0);
  const branch = (lines[0] ?? '').replace(/^## /, '').split('...')[0].trim();
  const files: ChangeFile[] = [];
  const numstat = await git(root, ['diff', '--numstat', 'HEAD']);
  const numMap = new Map<string, { added: number; deleted: number }>();
  if (numstat.ok) {
    for (const line of numstat.out.split('\n')) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
      if (m === null) continue;
      const p = m[3].includes('=>') ? (m[3].split('=>').pop() ?? m[3]).replace(/[{}]/g, '').trim() : m[3];
      numMap.set(p.replaceAll('\\', '/'), { added: m[1] === '-' ? 0 : Number(m[1]), deleted: m[2] === '-' ? 0 : Number(m[2]) });
    }
  }
  for (const line of lines.slice(1)) {
    const st2 = line.slice(0, 2);
    const p = line.slice(3).trim().replace(/^"|"$/g, '').replaceAll('\\', '/');
    if (p === '') continue;
    const renamed = st2.includes('R');
    const rel = renamed ? (p.split('->').pop() ?? p).trim() : p;
    const num = numMap.get(rel) ?? (numMap.get(p) ?? { added: 0, deleted: 0 });
    const untracked = st2 === '??';
    const status: ChangeFile['status'] = untracked
      ? 'untracked'
      : renamed
        ? 'renamed'
        : st2.includes('D')
          ? 'deleted'
          : st2.includes('A')
            ? 'added'
            : 'modified';
    let newLines: number | undefined;
    if (untracked) {
      try {
        newLines = fs.readFileSync(path.join(root, rel), 'utf8').split('\n').filter((l, i2, a) => i2 < a.length - 1 || l.trim() !== '').length;
      } catch {
        newLines = 0;
      }
    }
    files.push({
      path: rel,
      status,
      added: untracked ? null : num.added,
      deleted: untracked ? null : num.deleted,
      ...(untracked ? { newLines } : {}),
    });
  }
  const areas = await listChangeAreas(root, lines.slice(1));
  return ok({ branch, files, ...areas });
}

/** porcelain XY 拆两区(2026-11-09 审查页分「已暂存/未暂存」):X=暂存区相对 HEAD、Y=工作区相对暂存区;
 *  同一文件可同时在两区(MM)。行数各取 diff --cached / diff 的 numstat;untracked 只在未暂存区 */
async function listChangeAreas(root: string, statusLines: string[]): Promise<{ staged: ChangeFile[]; unstaged: ChangeFile[] }> {
  const numOf = async (args: string[]): Promise<Map<string, { added: number; deleted: number }>> => {
    const m = new Map<string, { added: number; deleted: number }>();
    const r = await git(root, args);
    if (!r.ok) return m;
    for (const line of r.out.split('\n')) {
      const mm = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
      if (mm === null) continue;
      const p2 = mm[3].includes('=>') ? (mm[3].split('=>').pop() ?? mm[3]).replace(/[{}]/g, '').trim() : mm[3];
      m.set(p2.replaceAll('\\', '/'), { added: mm[1] === '-' ? 0 : Number(mm[1]), deleted: mm[2] === '-' ? 0 : Number(mm[2]) });
    }
    return m;
  };
  const stagedNum = await numOf(['diff', '--cached', '--numstat']);
  const unstagedNum = await numOf(['diff', '--numstat']);
  const kind = (c: string): ChangeFile['status'] => (c === 'D' ? 'deleted' : c === 'A' ? 'added' : c === 'R' ? 'renamed' : 'modified');
  const staged: ChangeFile[] = [];
  const unstaged: ChangeFile[] = [];
  for (const line of statusLines) {
    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    const raw = line.slice(3).trim().replace(/^"|"$/g, '').replaceAll('\\', '/');
    if (raw === '') continue;
    const rel = x === 'R' || y === 'R' ? (raw.split('->').pop() ?? raw).trim() : raw;
    if (x === '?' && y === '?') {
      let newLines = 0;
      try {
        newLines = fs.readFileSync(path.join(root, rel), 'utf8').split('\n').filter((l, i2, a) => i2 < a.length - 1 || l.trim() !== '').length;
      } catch {
        newLines = 0;
      }
      unstaged.push({ path: rel, status: 'untracked', added: null, deleted: null, newLines });
      continue;
    }
    if (x !== ' ' && x !== '?' && x !== '!') {
      const n = stagedNum.get(rel) ?? { added: 0, deleted: 0 };
      staged.push({ path: rel, status: kind(x), added: n.added, deleted: n.deleted });
    }
    if (y !== ' ' && y !== '?' && y !== '!') {
      const n = unstagedNum.get(rel) ?? { added: 0, deleted: 0 };
      unstaged.push({ path: rel, status: kind(y), added: n.added, deleted: n.deleted });
    }
  }
  return { staged, unstaged };
}

/** 单文件 diff 内容面:area 缺省=HEAD 对磁盘(合并视图);'staged'=HEAD 对暂存区;'unstaged'=暂存区对磁盘
 *  (暂存区无此文件回落 HEAD)。untracked → old 缺场(新文件全行增) */
export async function changeContent(
  root: string,
  relPath: string,
  area?: 'staged' | 'unstaged',
): Promise<Result<{ path: string; oldContent?: string; newContent: string; truncated: boolean; deleted: boolean }>> {
  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(path.resolve(root))) return fail('CHANGES_PATH', 'path outside workspace');
  const rel = relPath.replaceAll(path.sep, '/');
  const head = await git(root, ['show', `HEAD:${rel}`]);
  const index = area !== undefined ? await git(root, ['show', `:${rel}`]) : undefined;
  const oldSrc = area === 'unstaged' && index !== undefined && index.ok ? index : head;
  const oldContent = oldSrc.ok ? oldSrc.out : undefined;
  let newContent = '';
  let deleted = false;
  if (area === 'staged') {
    if (index !== undefined && index.ok) newContent = index.out;
    else deleted = true; // 暂存区已删
  } else {
    try {
      newContent = fs.readFileSync(abs, 'utf8');
    } catch {
      deleted = true; // 磁盘已删（working tree 删除态）——old 全行删
    }
  }
  const truncated = newContent.length > MAX_DIFF_BYTES;
  if (truncated) newContent = newContent.slice(0, MAX_DIFF_BYTES);
  return ok({ path: relPath.replaceAll(path.sep, '/'), ...(oldContent !== undefined ? { oldContent } : {}), newContent, truncated, deleted });
}

/** G14.112 目录树 git 状态映射(含 ignored 目录折叠):path(仓库相对,/分隔,目录尾带/)
 *  → 状态码(VSCode 词汇:modified/added/untracked/deleted/renamed/ignored)。ignored 由
 *  status --ignored 折叠目录级产出(不逐文件展开,.npm-cache 等量级可控) */
export async function gitStatusMap(root: string): Promise<Result<{ branch: string; map: Record<string, string> }>> {
  if (!fs.existsSync(path.join(root, '.git'))) return ok({ branch: '', map: {} });
  const st = await git(root, ['status', '--porcelain=v1', '-b', '--ignored=matching']);
  if (!st.ok) return fail('CHANGES_STATUS', st.err);
  const lines = st.out.split('\n').filter((l) => l.trim().length > 0);
  const branch = (lines[0] ?? '').replace(/^## /, '').split('...')[0].trim();
  const map: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const code = line.slice(0, 2);
    let p = line.slice(3).trim().replace(/^"|"$/g, '').replaceAll('\\', '/');
    if (p === '') continue;
    if (p.endsWith('/')) p = p.slice(0, -1);
    const renamed = code.includes('R');
    if (renamed) p = (p.split('->').pop() ?? p).trim();
    const status = code === '!!'
      ? 'ignored'
      : code.includes('D')
        ? 'deleted'
        : code.includes('A') || code === '??'
          ? 'untracked'
          : code.includes('R')
            ? 'renamed'
            : 'modified';
    if (map[p] === undefined || map[p] === 'ignored') map[p] = status;
  }
  return ok({ branch, map });
}

/** 提交：缺省 add -A + commit -m(全部变动);stagedOnly=只提交暂存区(审查页「已暂存」区提交,2026-11-09)。
 *  message 必填;空提交无变动报错透传 */
export async function commitChanges(root: string, message: string, stagedOnly = false): Promise<Result<{ out: string }>> {
  if (message.trim() === '') return fail('COMMIT_MSG', 'commit message required');
  if (!stagedOnly) {
    const add = await git(root, ['add', '-A']);
    if (!add.ok) return fail('CHANGES_ADD', add.err);
  }
  const c = await git(root, ['commit', '-m', message]);
  if (!c.ok) return fail('COMMIT_FAIL', c.err);
  return ok({ out: c.out });
}

/** 路径入参收口:仓库相对、不越根(暂存/取消暂存/丢弃三面共用) */
function safeRels(root: string, paths: readonly string[]): Result<string[]> {
  const base = path.resolve(root);
  const out: string[] = [];
  for (const p of paths) {
    const abs = path.resolve(root, p);
    if (abs !== base && !abs.startsWith(base + path.sep)) return fail('CHANGES_PATH', `path outside workspace: ${p}`);
    out.push(path.relative(base, abs).replaceAll(path.sep, '/'));
  }
  return ok(out);
}

/** 暂存:paths 缺省=全部未暂存变动(含 untracked) */
export async function stageChanges(root: string, paths?: readonly string[]): Promise<Result<{ out: string }>> {
  const rels = safeRels(root, paths ?? []);
  if (!rels.ok) return rels;
  const r = await git(root, paths === undefined ? ['add', '-A'] : ['add', '-A', '--', ...rels.value]);
  if (!r.ok) return fail('STAGE_FAIL', r.err);
  return ok({ out: r.out });
}

/** 取消暂存(审查页「已暂存」区撤销):暂存区回 HEAD,工作区改动保留(移回未暂存区,不丢内容);
 *  paths 缺省=全部。无提交的新仓库(HEAD 缺)回落 rm --cached */
export async function unstageChanges(root: string, paths?: readonly string[]): Promise<Result<{ out: string }>> {
  const rels = safeRels(root, paths ?? []);
  if (!rels.ok) return rels;
  const spec = paths === undefined ? ['.'] : rels.value;
  const r = await git(root, ['restore', '--staged', '--', ...spec]);
  if (r.ok) return ok({ out: r.out });
  const r2 = await git(root, ['rm', '--cached', '-r', '-q', '--', ...spec]);
  if (!r2.ok) return fail('UNSTAGE_FAIL', r.err);
  return ok({ out: r2.out });
}

/** 丢弃未暂存改动(审查页「未暂存」区撤销,不可恢复——前端二次确认):已跟踪文件工作区回暂存区版本;
 *  untracked 文件删除。paths 缺省=全部未暂存变动 */
export async function discardUnstaged(root: string, paths?: readonly string[]): Promise<Result<{ out: string }>> {
  const listed = await listChanges(root);
  if (!listed.ok) return listed;
  const unstaged = listed.value.unstaged ?? [];
  let targets = unstaged;
  if (paths !== undefined) {
    const rels = safeRels(root, paths);
    if (!rels.ok) return rels;
    const want = new Set(rels.value);
    targets = unstaged.filter((f) => want.has(f.path));
  }
  const tracked = targets.filter((f) => f.status !== 'untracked').map((f) => f.path);
  if (tracked.length > 0) {
    const r = await git(root, ['restore', '--worktree', '--', ...tracked]);
    if (!r.ok) return fail('DISCARD_FAIL', r.err);
  }
  for (const f of targets.filter((x) => x.status === 'untracked')) {
    try {
      fs.rmSync(path.join(root, f.path), { force: true, recursive: true });
    } catch (e) {
      return fail('DISCARD_FAIL', e instanceof Error ? e.message : String(e));
    }
  }
  return ok({ out: `discarded ${targets.length}` });
}

/** 推送：push;无上游(首推/新分支常态)且 remote 在场时 -u origin HEAD 自动补上游重试
 *  (2026-10-31 用户实测裸 push 400——错误面原样透出,remote 缺场/凭据失败不掩盖) */
export async function pushChanges(root: string): Promise<Result<{ out: string }>> {
  const p = await git(root, ['push']);
  if (p.ok) return ok({ out: p.out });
  if (/set-upstream|no upstream|has no upstream/i.test(p.err)) {
    const remote = await git(root, ['remote']);
    if (remote.ok && remote.out.trim() !== '') {
      const r2 = await git(root, ['push', '-u', 'origin', 'HEAD']);
      if (r2.ok) return ok({ out: r2.out });
      return fail('PUSH_FAIL', r2.err);
    }
  }
  return fail('PUSH_FAIL', p.err);
}

/** G14.113 分支清单+当前分支(欢迎页分支选择弹窗;非 git 目录 → branches 空数组) */
export async function gitBranches(root: string): Promise<{ current: string; branches: string[] }> {
  if (!fs.existsSync(path.join(root, '.git'))) return { current: '', branches: [] };
  const r = await git(root, ['branch', '--format=%(refname:short)']);
  if (!r.ok) return { current: '', branches: [] };
  const branches = r.out.split('\n').map((l) => l.replace(/^\*\s*/, '').trim()).filter((l) => l.length > 0);
  const cur = await git(root, ['branch', '--show-current']);
  return { current: cur.ok ? cur.out.trim() : branches[0] ?? '', branches };
}

/** G14.113 切换分支:工作区未提交改动与目标分支冲突时 git 拒绝——识别为 DIRTY_TREE(前端弹「提交并切换」确认) */
export async function checkoutBranch(root: string, branch: string, create = false): Promise<Result<{ out: string }>> {
  if (/[^\w./-]/.test(branch) || branch.startsWith('-')) return fail('BRANCH_NAME', 'invalid branch name');
  // create=新建并切换(欢迎页分支弹窗筛选行「+」,2026-11-09 用户裁定);已存在同名由 git 拒(错误回显)
  const r = await git(root, create ? ['checkout', '-b', branch] : ['checkout', branch]);
  if (!r.ok) return fail(isDirtyTreeError(r.err) ? 'DIRTY_TREE' : 'CHECKOUT_FAIL', r.err);
  return ok({ out: r.out });
}

/** 切换代价面(2026-11-10 用户裁定「切换分支弹确认,说明代价」):当前 tip → 目标 tip 的
 *  numstat 汇总(切换=工作区将被更新的文件量)+ 未提交改动数(dirty)。missing=true=目标分支
 *  不存在(新建分支确认不示数);非 git 目录 NOT_GIT(GUI 据此隐藏数字面) */
export async function branchDiffStat(root: string, branch: string): Promise<Result<{ files: number; added: number; deleted: number; dirty: number; missing: boolean }>> {
  if (!fs.existsSync(path.join(root, '.git'))) return fail('NOT_GIT', 'not a git repository');
  if (/[^\w./-]/.test(branch) || branch.startsWith('-')) return fail('BRANCH_NAME', 'invalid branch name');
  const cur = await git(root, ['branch', '--show-current']);
  const current = cur.ok ? cur.out.trim() : '';
  const dirtyList = await git(root, ['status', '--porcelain']);
  const dirty = dirtyList.ok ? dirtyList.out.split('\n').filter((l) => l.trim().length > 0).length : 0;
  if (branch === current) return ok({ files: 0, added: 0, deleted: 0, dirty, missing: false });
  const stat = await git(root, ['diff', '--numstat', 'HEAD', branch]);
  if (!stat.ok) return ok({ files: 0, added: 0, deleted: 0, dirty, missing: true }); // 分支不存在(新建面):确认不示数
  let files = 0;
  let added = 0;
  let deleted = 0;
  for (const line of stat.out.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (m === null) continue;
    files += 1;
    if (m[1] !== '-') added += Number(m[1]);
    if (m[2] !== '-') deleted += Number(m[2]);
  }
  return ok({ files, added, deleted, dirty, missing: false });
}

/** git 切换被未提交改动阻断的报错特征(本地改动会被覆盖/请先提交或贮藏) */
export function isDirtyTreeError(err: string): boolean {
  return /would be overwritten|commit your changes or stash|Please move or remove them/i.test(err);
}

/** 提交全部未提交改动后切换(2026-11-09 用户裁定「提交并切换」):add -A + commit(无改动可提交时跳过)→ checkout */
export async function commitAndCheckout(root: string, branch: string, create: boolean, message: string): Promise<Result<{ out: string }>> {
  const st = await git(root, ['status', '--porcelain']);
  if (st.ok && st.out.trim() !== '') {
    const c = await commitChanges(root, message);
    if (!c.ok) return c;
  }
  return checkoutBranch(root, branch, create);
}

/** G14.100 撤销变动：restore 回 HEAD（tracked）；本轮新建（HEAD 无此文件）→ 删除。
 *  多轮未提交链下 restore 回最近提交(上一状态语义近似,对齐 Codex) */
export async function restoreChange(root: string, relPath: string): Promise<Result<{ out: string }>> {
  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(path.resolve(root))) return fail('CHANGES_PATH', 'path outside workspace');
  const head = await git(root, ['cat-file', '-e', `HEAD:${relPath.replaceAll(path.sep, '/')}`]);
  if (head.ok) {
    const r = await git(root, ['checkout', 'HEAD', '--', relPath]);
    if (!r.ok) return fail('RESTORE_FAIL', r.err);
    return ok({ out: `restored ${relPath}` });
  }
  // HEAD 无 → 本轮新建:删除
  try {
    fs.rmSync(abs, { force: true });
  } catch (e) {
    return fail('RESTORE_FAIL', e instanceof Error ? e.message : String(e));
  }
  return ok({ out: `removed ${relPath}` });
}

/** 两份变动清单的路径级差集（B 相对 A 的本轮增量）：B 中路径不在 A，或行数/状态变化。
 *  untracked 文件 numstat 不覆盖——newLines(内容行数)参与比较，轮间再改可辨 */
export function diffChangeSets(base: ChangeFile[], now: ChangeFile[]): ChangeFile[] {
  const baseMap = new Map(base.map((f) => [f.path, f]));
  return now.filter((f) => {
    const b = baseMap.get(f.path);
    if (b === undefined) return true;
    return b.added !== f.added || b.deleted !== f.deleted || b.status !== f.status || b.newLines !== f.newLines;
  });
}

/** G14.124 git 忽略集(status --ignored=matching 的 '!!' 行;目录项带尾斜杠):索引/@ 面板滤除。
 *  非 git 目录/命令失败静默空集(索引降级可用) */
async function gitIgnoredSet(root: string): Promise<Set<string>> {
  if (!fs.existsSync(path.join(root, '.git'))) return new Set();
  const r = await git(root, ['status', '--porcelain=v1', '--ignored=matching']);
  if (!r.ok) return new Set();
  const out = new Set<string>();
  for (const line of r.out.split('\n')) {
    if (!line.startsWith('!! ')) continue;
    const p = line.slice(3).trim().replace(/^"|"$/g, '').replaceAll('\\', '/');
    if (p !== '') out.add(p);
  }
  return out;
}

/** G14.121 工作区文件索引(@ 文件面板数据源,Chat 与欢迎页共用):BFS 限深限数、跳噪声目录与
 *  git 忽略文件(G14.124),stat mtime 倒序——最近改动优先;cap 600 控响应体。返回 posix 相对
 *  路径(展示/子序列匹配)。非目录/IO 异常静默空表(面板降级可用)。
 *  目录引用面(@面板可滤出文件夹/拖目录引用):dirs 独立数组带尾斜杠标记(与 mtime 文件序
 *  分离,面板目录排前),cap 300;跳噪/忽略口径与文件同。 */
const WS_INDEX_SKIP = new Set([
  'node_modules', '.git', 'dist', 'dist-gui', 'build', 'target', 'out', '.next',
  '.idea', '.vscode', '__pycache__', '.sunshinex',
  '.pnpm-store', '.cache', 'coverage', '.zcode', 'tmp', 'temp',
]);
export async function workspaceFiles(root: string): Promise<{ files: Array<{ path: string; mtime: number }>; dirs: string[] }> {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { files: [], dirs: [] };
  const ign = await gitIgnoredSet(root);
  const cap = { n: 600 };
  const dcap = { n: 300 };
  const out: Array<{ path: string; mtime: number }> = [];
  const dirs: string[] = [];
  /** rel 或其任一祖先目录命中忽略集 */
  const ignoredRel = (rel: string): boolean => {
    let acc = '';
    for (const seg of rel.split('/')) {
      acc = acc === '' ? seg : `${acc}/${seg}`;
      if (ign.has(acc) || ign.has(`${acc}/`)) return true;
    }
    return false;
  };
  const walk = (rel: string, depth: number): void => {
    // 目录遍历只受自身 cap/深度约束:文件 cap 满额仅停记账不停走——否则大仓 DFS 前段文件
    // 耗尽配额,后段目录(src/tui 等)整块缺席,@面板滤目录残缺
    if (depth > 4 || dcap.n <= 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rel === '' ? root : path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel2 = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (WS_INDEX_SKIP.has(e.name) || ignoredRel(rel2) || dcap.n <= 0) continue;
        dirs.push(`${rel2}/`);
        dcap.n -= 1;
        walk(rel2, depth + 1);
        continue;
      }
      if (!e.isFile() || ignoredRel(rel2) || cap.n <= 0) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(path.join(root, rel2)).mtimeMs;
      } catch {
        /* 竞态亡文件:跳过 */
      }
      out.push({ path: rel2, mtime });
      cap.n -= 1;
    }
  };
  walk('', 0);
  out.sort((x, y) => y.mtime - x.mtime);
  return { files: out, dirs };
}
