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
export async function listChanges(root: string): Promise<Result<{ branch: string; files: ChangeFile[] }>> {
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
  return ok({ branch, files });
}

/** 单文件 diff 内容面：untracked → old 缺场（新文件全行增）；tracked → HEAD 版为 old、磁盘为 new */
export async function changeContent(
  root: string,
  relPath: string,
): Promise<Result<{ path: string; oldContent?: string; newContent: string; truncated: boolean; deleted: boolean }>> {
  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(path.resolve(root))) return fail('CHANGES_PATH', 'path outside workspace');
  const head = await git(root, ['show', `HEAD:${relPath.replaceAll(path.sep, '/')}`]);
  const oldContent = head.ok ? head.out : undefined;
  let newContent = '';
  let deleted = false;
  try {
    newContent = fs.readFileSync(abs, 'utf8');
  } catch {
    deleted = true; // 磁盘已删（working tree 删除态）——old 全行删
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

/** 提交：add -A + commit -m（message 必填；空提交无变动报错透传） */
export async function commitChanges(root: string, message: string): Promise<Result<{ out: string }>> {
  if (message.trim() === '') return fail('COMMIT_MSG', 'commit message required');
  const add = await git(root, ['add', '-A']);
  if (!add.ok) return fail('CHANGES_ADD', add.err);
  const c = await git(root, ['commit', '-m', message]);
  if (!c.ok) return fail('COMMIT_FAIL', c.err);
  return ok({ out: c.out });
}

/** 推送：push（上游缺场回错误面——前端提示先设置上游） */
export async function pushChanges(root: string): Promise<Result<{ out: string }>> {
  const p = await git(root, ['push']);
  if (!p.ok) return fail('PUSH_FAIL', p.err);
  return ok({ out: p.out });
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

/** G14.113 切换分支(工作区有未提交变动时 git 自身拒绝,错误透传) */
export async function checkoutBranch(root: string, branch: string): Promise<Result<{ out: string }>> {
  if (/[^\w./-]/.test(branch) || branch.startsWith('-')) return fail('BRANCH_NAME', 'invalid branch name');
  const r = await git(root, ['checkout', branch]);
  if (!r.ok) return fail('CHECKOUT_FAIL', r.err);
  return ok({ out: r.out });
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
 *  路径(展示/子序列匹配)。非目录/IO 异常静默空表(面板降级可用) */
const WS_INDEX_SKIP = new Set([
  'node_modules', '.git', 'dist', 'dist-gui', 'build', 'target', 'out', '.next',
  '.idea', '.vscode', '__pycache__', '.sunshinex',
  '.pnpm-store', '.cache', 'coverage', '.zcode', 'tmp', 'temp',
]);
export async function workspaceFiles(root: string): Promise<Array<{ path: string; mtime: number }>> {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  const ign = await gitIgnoredSet(root);
  const cap = { n: 600 };
  const out: Array<{ path: string; mtime: number }> = [];
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
    if (depth > 4 || cap.n <= 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rel === '' ? root : path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (cap.n <= 0) break;
      const rel2 = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!WS_INDEX_SKIP.has(e.name) && !ignoredRel(rel2)) walk(rel2, depth + 1);
        continue;
      }
      if (!e.isFile() || ignoredRel(rel2)) continue;
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
  return out;
}
