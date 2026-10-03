import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry } from '../tools';
import { SecurityGuard } from '../security/guard';
import { ProcessSandbox } from '../security/sandbox';
import { SafetyChain } from '../security/chain';
import { builtinTools } from './builtin';

function setup(root: string): { registry: ToolRegistry; safety: SafetyChain } {
  const safety = new SafetyChain(new SecurityGuard(undefined, 'dontAsk'), new ProcessSandbox(), root);
  const registry = new ToolRegistry();
  for (const t of builtinTools(safety, root)) registry.register(t);
  return { registry, safety };
}

test('grep 目录级递归：命中带 相对路径:行号', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-grepdir-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'const alpha = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'beta\nconst alpha = 2;\n');
  fs.writeFileSync(path.join(root, 'docs', 'x.md'), 'alpha here\n');
  const { registry, safety } = setup(root);

  const r = await registry.execute('grep', { path: '.', pattern: 'alpha' }, safety);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.value.stdout.includes('src/a.ts:1:'), r.value.stdout);
    assert.ok(r.value.stdout.includes('src/b.ts:2:'), r.value.stdout);
    assert.ok(r.value.stdout.includes('docs/x.md:1:'), r.value.stdout);
  }
});

test('grep/glob 零命中不再静默空：附 no-match 提示行', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-nomatch-'));
  fs.writeFileSync(path.join(root, 'a.ts'), 'hello\n');
  const { registry, safety } = setup(root);

  const g = await registry.execute('grep', { path: '.', pattern: 'zzz-no-hit' }, safety);
  assert.ok(g.ok, '零命中不报错');
  if (g.ok) assert.ok(g.value.stdout.includes('no matches'), `grep 零命中应附提示: ${JSON.stringify(g.value.stdout)}`);

  const gf = await registry.execute('grep', { path: '.', pattern: 'hello', glob: '*.md' }, safety);
  if (gf.ok) assert.ok(gf.value.stdout.includes('no matches'), `grep glob 过滤零命中应附提示: ${JSON.stringify(gf.value.stdout)}`);

  const gl = await registry.execute('glob', { pattern: '**/*.xyz' }, safety);
  if (gl.ok) assert.ok(gl.value.stdout.includes('no files match'), `glob 零命中应附提示: ${JSON.stringify(gl.value.stdout)}`);
});

test('grep 目录级 glob 过滤：仅命中匹配文件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-grepglob-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'needle\n');
  fs.writeFileSync(path.join(root, 'readme.md'), 'needle\n');
  const { registry, safety } = setup(root);

  const r = await registry.execute('grep', { path: '.', pattern: 'needle', glob: '*.md' }, safety);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.value.stdout.includes('readme.md:1:'), r.value.stdout);
    assert.ok(!r.value.stdout.includes('src/a.ts'), r.value.stdout);
  }
});

test('grep 目录级截断：200 命中上限 + truncated 标记', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-greptrunc-'));
  const lines: string[] = [];
  for (let i = 0; i < 250; i++) lines.push(`hit-${i}`);
  fs.writeFileSync(path.join(root, 'big.txt'), lines.join('\n') + '\n');
  const { registry, safety } = setup(root);

  const r = await registry.execute('grep', { path: '.', pattern: 'hit-' }, safety);
  assert.equal(r.ok, true);
  if (r.ok) {
    const out = r.value.stdout.split('\n');
    assert.equal(out.length, 201);
    assert.equal(out[200], 'truncated: true');
  }
});

test('grep 单文件模式不回归：输出裸命中行', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-grepfile-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'alpha\nbeta\n');
  const { registry, safety } = setup(root);

  const r = await registry.execute('grep', { path: 'a.txt', pattern: 'alpha' }, safety);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.stdout, 'alpha');
});

test('grep 目录递归跳过 node_modules/dist/.git 等感知跳过集', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-grepskip-'));
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'i.js'), 'needle\n');
  fs.writeFileSync(path.join(root, 'app.js'), 'needle\n');
  const { registry, safety } = setup(root);

  const r = await registry.execute('grep', { path: '.', pattern: 'needle' }, safety);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.stdout, 'app.js:1:needle');
});

test('worktree 会话 glob 锚活动根：列树内文件、不列主区（D19-b，与 read/grep/exec 同树）', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-globwt-'));
  const root = path.join(parent, 'main');
  const tree = path.join(parent, 'tree');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(tree, { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'main-only.ts'), 'x\n');
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n');
  fs.writeFileSync(path.join(tree, 'tree-only.txt'), 'x\n');
  try {
    // 装配形态同 Harness：activeRoot 接缝直取 safety.activeRoot；缺省态（主区）先钉基线
    const safety = new SafetyChain(new SecurityGuard(undefined, 'dontAsk'), new ProcessSandbox(), root);
    const registry = new ToolRegistry();
    for (const t of builtinTools(safety, root, { activeRoot: () => safety.activeRoot })) registry.register(t);

    const base = await registry.execute('glob', { pattern: '**/*' }, safety);
    assert.ok(base.ok && base.value.stdout.includes('main-only.ts'), '缺省基线：主区文件在列');

    safety.enterWorktree(tree);
    const inTree = await registry.execute('glob', { pattern: '**/*' }, safety);
    assert.ok(inTree.ok, `worktree 会话 glob 应成功：${inTree.ok ? '' : inTree.error.message}`);
    if (inTree.ok) {
      assert.ok(inTree.value.stdout.includes('tree-only.txt'), `树内文件应列出：${inTree.value.stdout}`);
      assert.ok(!inTree.value.stdout.includes('main-only.ts'), `主区文件不得混入（锚点分裂病根）：${inTree.value.stdout}`);
    }

    safety.exitWorktree();
    const back = await registry.execute('glob', { pattern: '**/*' }, safety);
    assert.ok(back.ok && back.value.stdout.includes('main-only.ts'), '退出后恢复主区锚点');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
