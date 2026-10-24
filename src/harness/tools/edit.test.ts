import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { builtinTools } from './builtin';
import { ToolRegistry } from '../tools';
import { SafetyChain } from '../security/chain';
import { SecurityGuard } from '../security/guard';
import { PolicyEngine } from '../security/policy';
import { ProcessSandbox } from '../security/sandbox';
import { makeWriteSnapshotSink } from './write-snapshot';
import type { ApprovalDecision } from '../../types';

/** edit 工具业务面回归（2026-10-22 立项）：精确替换/唯一性/replace_all/字面语义与四道写族硬底线
 *  （settings/.git/记忆窄口/worktree 主根）+ acceptEdits 链侧审批 + 规则名域语义 + 影子快照继承。 */

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'edit-tool-'));
}

function makeRegistry(
  root: string,
  opts: { mode?: 'acceptEdits' | 'read-only' | 'full-access'; sink?: ReturnType<typeof makeWriteSnapshotSink>; asker?: (req: { subject: string; kind: string }) => ApprovalDecision } = {},
): { registry: ToolRegistry; safety: SafetyChain } {
  const guard = new SecurityGuard(new PolicyEngine(), opts.mode ?? 'full-access');
  if (opts.asker !== undefined) guard.setAsker(async (req) => opts.asker!(req));
  const safety = new SafetyChain(guard, new ProcessSandbox(), root);
  const r = new ToolRegistry();
  for (const t of builtinTools(safety, root, { writeSnapshot: opts.sink })) r.register(t);
  return { registry: r, safety };
}

function writeRoot(root: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

test('edit：唯一命中 → 精确替换 + edited stat + 影子快照捕获 pre-image', async () => {
  const root = tmp();
  try {
    writeRoot(root, 'app.ts', 'const a = 1;\nconst b = 2;\n');
    const dataDir = path.join(root, 'data');
    const sink = makeWriteSnapshotSink(dataDir, root);
    const { registry, safety } = makeRegistry(root, { sink });
    const res = await registry.execute('edit', { path: 'app.ts', oldString: 'const b = 2;', newString: 'const b = 20;' }, safety);
    assert.ok(res.ok, `edit 应成功:${res.ok ? '' : res.error.message}`);
    assert.equal(fs.readFileSync(path.join(root, 'app.ts'), 'utf8'), 'const a = 1;\nconst b = 20;\n');
    assert.match(res.value.stdout, /^edited \+\d+ -\d+$/, '回执 = edited +A -D（writeStatOf 同源口径）');
    const entries = sink.drain();
    assert.equal(entries.length, 1, '影子快照应捕获一条');
    assert.equal(entries[0].path, 'app.ts');
    const blob = fs.readFileSync(path.join(dataDir, 'sessions', '_blobs', entries[0].hash), 'utf8');
    assert.equal(blob, 'const a = 1;\nconst b = 2;\n', 'blob = pre-image（改前内容）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('edit：old_string 不命中 / 多处命中未 replaceAll → INVALID_ARG；replaceAll=true 全部替换', async () => {
  const root = tmp();
  try {
    writeRoot(root, 'a.txt', 'x = 1;\nx = 1;\nother;\n');
    const { registry, safety } = makeRegistry(root);
    const miss = await registry.execute('edit', { path: 'a.txt', oldString: 'not-there', newString: 'y', replaceAll: null }, safety);
    assert.ok(!miss.ok && miss.error.code === 'INVALID_ARG', '不命中 → INVALID_ARG');
    if (!miss.ok) assert.match(miss.error.message, /not found/);
    const multi = await registry.execute('edit', { path: 'a.txt', oldString: 'x = 1;', newString: 'y = 1;', replaceAll: null }, safety);
    assert.ok(!multi.ok && multi.error.code === 'INVALID_ARG', '两处命中未 replaceAll → INVALID_ARG');
    if (!multi.ok) assert.match(multi.error.message, /matches 2 locations/);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'x = 1;\nx = 1;\nother;\n', '失败路径零写盘');
    const all = await registry.execute('edit', { path: 'a.txt', oldString: 'x = 1;', newString: 'y = 1;', replaceAll: true }, safety);
    assert.ok(all.ok, `replaceAll 应成功:${all.ok ? '' : (all as { error: { message: string } }).error.message}`);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'y = 1;\ny = 1;\nother;\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('edit：字面替换（$& 等 replacement 模式不作解释）+ 空 old_string / old=new / 文件缺失 三拒绝', async () => {
  const root = tmp();
  try {
    writeRoot(root, 'dollar.txt', 'price: 9\n');
    const { registry, safety } = makeRegistry(root);
    const lit = await registry.execute('edit', { path: 'dollar.txt', oldString: '9', newString: '$& dollars $1', replaceAll: null }, safety);
    assert.ok(lit.ok);
    assert.equal(fs.readFileSync(path.join(root, 'dollar.txt'), 'utf8'), 'price: $& dollars $1\n', 'newString 纯字面落盘');

    const empty = await registry.execute('edit', { path: 'dollar.txt', oldString: '', newString: 'x', replaceAll: null }, safety);
    assert.ok(!empty.ok && empty.error.code === 'INVALID_ARG');
    const noop = await registry.execute('edit', { path: 'dollar.txt', oldString: 'price', newString: 'price', replaceAll: null }, safety);
    assert.ok(!noop.ok && noop.error.code === 'INVALID_ARG', 'old=new → 拒绝（无操作误调用）');
    const missing = await registry.execute('edit', { path: 'nope.txt', oldString: 'a', newString: 'b', replaceAll: null }, safety);
    assert.ok(!missing.ok && missing.error.code === 'INVALID_ARG');
    if (!missing.ok) assert.match(missing.error.message, /use write to create/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('edit：写族硬底线——settings.json 与 .git 路径拒绝（与 write 同保护）', async () => {
  const root = tmp();
  try {
    const { registry, safety } = makeRegistry(root);
    const settings = path.join(root, '.sunshinex', 'settings.json');
    const s = await registry.execute('edit', { path: settings, oldString: 'a', newString: 'b', replaceAll: null }, safety);
    assert.ok(!s.ok, 'settings.json edit 应被硬底线拒绝');
    if (!s.ok) assert.match(s.error.message, /settings\.json is protected/);
    const git = await registry.execute('edit', { path: path.join(root, '.git', 'config'), oldString: 'a', newString: 'b', replaceAll: null }, safety);
    assert.ok(!git.ok, '.git 路径 edit 应被硬底线拒绝');
    if (!git.ok) assert.match(git.error.message, /\.git is protected/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('edit：acceptEdits 档信任域外 → 链侧审批（deny 拒 / always 放行且文件落盘）', async () => {
  const root = tmp();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-outside-'));
  try {
    const outside = path.join(outsideDir, 'notes.md');
    fs.writeFileSync(outside, 'hello world\n');
    const denied = makeRegistry(root, {
      mode: 'acceptEdits',
      asker: () => 'deny',
    });
    const d = await denied.registry.execute('edit', { path: outside, oldString: 'hello', newString: 'hi', replaceAll: null }, denied.safety);
    assert.ok(!d.ok, 'asker deny → 拒绝');
    if (!d.ok) assert.match(d.error.message, /rejected by user/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'hello world\n', '拒绝路径零写盘');

    let askKind = '';
    const allowed = makeRegistry(root, {
      mode: 'acceptEdits',
      asker: (req) => {
        askKind = req.kind;
        return 'always';
      },
    });
    const a = await allowed.registry.execute('edit', { path: outside, oldString: 'hello', newString: 'hi', replaceAll: null }, allowed.safety);
    assert.ok(a.ok, `asker always → 放行:${a.ok ? '' : (a as { error: { message: string } }).error.message}`);
    assert.equal(askKind, 'write', 'edit 审批 kind=write（写族）');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'hi world\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('edit：read-only 档拒绝；规则名域——Edit(deny) 命中 edit、Write 规则不波及 edit', async () => {
  const root = tmp();
  try {
    writeRoot(root, 'cert.pem', 'key data\n');
    writeRoot(root, 'free.txt', 'free\n');
    const plan = makeRegistry(root, { mode: 'read-only' });
    const p = await plan.registry.execute('edit', { path: 'free.txt', oldString: 'free', newString: 'busy', replaceAll: null }, plan.safety);
    assert.ok(!p.ok, 'read-only 档 edit 拒绝');
    if (!p.ok) assert.match(p.error.message, /read-only mode allows read-only/);

    const ruled = makeRegistry(root, { mode: 'full-access' });
    ruled.safety.setPermissions({ deny: ['Edit(*.pem)'], allow: [], additionalDirs: [] });
    const r1 = await ruled.registry.execute('edit', { path: 'cert.pem', oldString: 'key', newString: 'x', replaceAll: null }, ruled.safety);
    assert.ok(!r1.ok && /denied by user permissions rule/.test(r1.error.message), 'Edit(*.pem) deny 命中');
    const r2 = await ruled.registry.execute('edit', { path: 'free.txt', oldString: 'free', newString: 'busy', replaceAll: null }, ruled.safety);
    assert.ok(r2.ok, '非命中文件不受规则波及');
    const writeOnly = makeRegistry(root, { mode: 'full-access' });
    writeOnly.safety.setPermissions({ deny: ['Write(**/*.pem)'], allow: [], additionalDirs: [] });
    const r3 = await writeOnly.registry.execute('edit', { path: 'cert.pem', oldString: 'key', newString: 'x', replaceAll: null }, writeOnly.safety);
    assert.ok(r3.ok, '规则按规范名域匹配——Write deny 不拦 edit（名域语义，与 MANUAL 6.2 三件套分列一致）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('edit：SUNSHINE.md 目标 → 快照过期回执（与 write 同一口径）', async () => {
  const root = tmp();
  try {
    writeRoot(root, 'SUNSHINE.md', '# proj\nold line\n');
    const { registry, safety } = makeRegistry(root);
    const r = await registry.execute('edit', { path: 'SUNSHINE.md', oldString: 'old line', newString: 'new line', replaceAll: null }, safety);
    assert.ok(r.ok);
    assert.match(r.value.stdout, /edited \+\d+ -\d+/);
    assert.match(r.value.stdout, /snapshot is stale/, 'SUNSHINE.md 改写附快照过期回执');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
