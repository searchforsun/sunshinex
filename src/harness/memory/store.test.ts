import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MEMORY_CONSOLIDATE_THRESHOLD,
  MEMORY_INDEX_MAX_BYTES,
  MEMORY_INDEX_MAX_LINES,
  MemoryStore,
  isSafeSlug,
  normalizeText,
  slugifyMemory,
} from './store';

/** 每用例独立 tmpdir + SUNSHINEX_DATA_DIR 重定向，finally 还原 env 并清理，绝不触碰真实家目录 */
function withStoreRoot(fn: (root: string, store: MemoryStore) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mem-'));
  process.env.SUNSHINEX_DATA_DIR = tmp;
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    fn(root, new MemoryStore(root));
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 只需主目录 store 的用例走这层；需显式 root 的用例（子目录构造）直接用 withStoreRoot */
function withStore(fn: (store: MemoryStore) => void): void {
  withStoreRoot((_root, store) => fn(store));
}

const today = (): string => new Date().toISOString().slice(0, 10);

function mdFiles(store: MemoryStore): string[] {
  return fs.readdirSync(store.dir()).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort();
}

test('① add 落盘记录文件 + 索引行格式与记录一致', () => {
  withStore((store) => {
    assert.equal(MEMORY_INDEX_MAX_LINES, 200);
    assert.equal(MEMORY_INDEX_MAX_BYTES, 25_000);
    assert.equal(MEMORY_CONSOLIDATE_THRESHOLD, 10);

    const r = store.add({ type: 'user', description: '偏好 TypeScript strict', body: '用户偏好 strict 模式与显式类型' });
    assert.ok(r.ok);
    const rec = r.value;
    assert.equal(rec.type, 'user');
    assert.equal(rec.created, today());

    const file = path.join(store.dir(), `${rec.slug}.md`);
    assert.ok(fs.existsSync(file));
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.startsWith('---\n'));
    assert.ok(raw.includes('type: user'));
    assert.ok(raw.includes(`created: ${today()}`));
    assert.ok(raw.includes('description: 偏好 TypeScript strict'));
    assert.ok(raw.endsWith('用户偏好 strict 模式与显式类型\n'));

    assert.equal(store.indexText(), `- ${rec.slug} — 偏好 TypeScript strict [user]\n`);
    assert.deepEqual(store.list(), [rec]);
  });
});

test('② 撞名零覆盖：非记录文件占住路径 → 避让 -2（记录间 slug 相同属去重轴，见 ③）', () => {
  withStore((store) => {
    fs.writeFileSync(path.join(store.dir(), 'foo-bar.md'), 'hand placed notes, must survive');
    const r = store.add({ type: 'project', description: 'foo bar', body: 'first body' });
    assert.ok(r.ok, '裸文件不构成记录，去重不命中');
    assert.equal(r.value.slug, 'foo-bar-2');
    assert.equal(fs.readFileSync(path.join(store.dir(), 'foo-bar.md'), 'utf8'), 'hand placed notes, must survive');
    assert.equal(store.count(), 1, '裸文件不进记录视野');
    assert.ok(store.indexText().includes('- foo-bar-2 — foo bar [project]'));
  });
});

test('③ 归一化三级去重：slug 相同 / description 大小写空白差异 / body 相同', () => {
  withStore((store) => {
    const a = store.add({ type: 'user', description: 'Foo Bar', body: 'alpha body' });
    assert.ok(a.ok);

    const dupSlug = store.add({ type: 'user', description: 'Foo Bar!', body: 'other body' });
    assert.equal(dupSlug.ok, false);
    if (!dupSlug.ok) assert.equal(dupSlug.error.code, 'MEMORY_DUPLICATE');

    const dupDesc = store.add({ type: 'user', description: 'foo   BAR', body: 'totally different' });
    assert.equal(dupDesc.ok, false);
    if (!dupDesc.ok) assert.equal(dupDesc.error.code, 'MEMORY_DUPLICATE');
    assert.deepEqual(mdFiles(store), [`${a.value.slug}.md`]);

    const b = store.add({ type: 'user', description: 'gamma topic', body: 'shared body' });
    assert.ok(b.ok);
    const dupBody = store.add({ type: 'user', description: 'delta topic', body: 'shared   BODY ' });
    assert.equal(dupBody.ok, false);
    if (!dupBody.ok) {
      assert.equal(dupBody.error.code, 'MEMORY_DUPLICATE');
      assert.equal(dupBody.error.message, 'duplicate: delta-topic');
    }
    assert.equal(mdFiles(store).length, 2);
  });
});

test('④ remove 删除记录与索引行；不存在 slug → MEMORY_NOT_FOUND', () => {
  withStore((store) => {
    const a = store.add({ type: 'reference', description: 'react docs', body: 'react rendering model' });
    assert.ok(a.ok);
    const slug = a.value.slug;
    assert.ok(store.indexText().includes(`- ${slug} — react docs [reference]`));

    const r = store.remove(slug);
    assert.ok(r.ok);
    assert.ok(!fs.existsSync(path.join(store.dir(), `${slug}.md`)));
    assert.equal(store.indexText(), '');
    assert.equal(store.count(), 0);

    const miss = store.remove('ghost');
    assert.equal(miss.ok, false);
    if (!miss.ok) assert.equal(miss.error.code, 'MEMORY_NOT_FOUND');
  });
});

test('⑤ 循环 201 条：最后一条 MEMORY_INDEX_OVER_LIMIT 且记录文件已落盘', () => {
  withStore((store) => {
    let last: ReturnType<MemoryStore['add']> | undefined;
    for (let i = 1; i <= MEMORY_INDEX_MAX_LINES + 1; i += 1) {
      last = store.add({ type: 'project', description: `memo ${i}`, body: `body content ${i}` });
      if (i <= MEMORY_INDEX_MAX_LINES) assert.ok(last.ok, `第 ${i} 条应成功`);
    }
    assert.ok(last);
    assert.equal(last.ok, false);
    if (!last.ok) {
      assert.equal(last.error.code, 'MEMORY_INDEX_OVER_LIMIT');
      assert.ok(last.error.message.includes('201 行'), '报错文本含当前行数');
      assert.ok(last.error.message.includes(`${MEMORY_INDEX_MAX_LINES} 行`), '报错文本含上限行数');
      assert.ok(/\d+ 字节/.test(last.error.message), '报错文本含当前字节数');
    }
    assert.ok(fs.existsSync(path.join(store.dir(), `memo-${MEMORY_INDEX_MAX_LINES + 1}.md`)), '超限记录已写盘（CC 语义）');
    assert.equal(store.indexText().split('\n').filter((l: string) => l.length > 0).length, MEMORY_INDEX_MAX_LINES + 1);
    assert.ok(store.overLimit() !== null);
  });
});

test('⑥ list/count/has 基础语义 + 空目录语义', () => {
  withStore((store) => {
    assert.deepEqual(store.list(), []);
    assert.equal(store.count(), 0);
    assert.equal(store.has('anything'), false);
    assert.equal(store.indexText(), '');
    assert.equal(store.overLimit(), null);

    const a = store.add({ type: 'feedback', description: 'commit style', body: 'use conventional commits' });
    const b = store.add({ type: 'reference', description: 'ts config notes', body: 'strict true always' });
    assert.ok(a.ok);
    assert.ok(b.ok);
    assert.equal(store.count(), 2);
    assert.equal(store.has(a.value.slug), true);
    assert.equal(store.has(b.value.slug), true);
    assert.equal(store.has('nope'), false);
    assert.deepEqual(
      store.list().map((m) => m.slug).sort(),
      [a.value.slug, b.value.slug].sort(),
    );
  });
});

test('⑦ 记录文件为单一事实源：手改内容 → list() 反映新内容', () => {
  withStore((store) => {
    const a = store.add({ type: 'project', description: 'old desc', body: 'old body' });
    assert.ok(a.ok);
    const file = path.join(store.dir(), `${a.value.slug}.md`);
    fs.writeFileSync(
      file,
      ['---', 'type: reference', 'created: 2020-01-02', 'description: 手改后的描述', '---', '手改正文第一行', '第二行'].join('\n') + '\n',
    );
    const list = store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].slug, a.value.slug);
    assert.equal(list[0].type, 'reference');
    assert.equal(list[0].created, '2020-01-02');
    assert.equal(list[0].description, '手改后的描述');
    assert.equal(list[0].body, '手改正文第一行\n第二行');
  });
});

test('⑧ normalizeText / slugifyMemory 纯函数语义', () => {
  assert.equal(normalizeText('  Foo   BAR\n\tbaz '), 'foo bar baz');
  assert.equal(normalizeText(''), '');
  assert.equal(slugifyMemory('偏好 TypeScript strict'), '偏好-TypeScript-strict');
  assert.equal(slugifyMemory('!!!'), 'memo');
  assert.equal(slugifyMemory('--a--b--'), 'a-b');
  assert.equal(slugifyMemory('x'.repeat(50)).length, 40);
});

// ── Task 1（记忆底座扩展）追加：put 更新语义 / modified / capacityNotice / 子目录构造 ──

test('⑨ put 同 slug 为更新：不产生 -2 副本、刷新 modified、保留 created', () => {
  withStore((store) => {
    const first = store.put({ slug: 'prefers-chinese', type: 'user', description: 'prefers Chinese replies', body: 'always answer in Chinese' });
    assert.equal(first.ok, true);
    const before = store.list().find((r) => r.slug === 'prefers-chinese')!;
    const updated = store.put({
      slug: 'prefers-chinese',
      type: 'user',
      description: 'prefers Chinese replies',
      body: 'always answer in Chinese, including tables',
    });
    assert.equal(updated.ok, true);
    const after = store.list().find((r) => r.slug === 'prefers-chinese')!;
    assert.equal(after.created, before.created, 'created 不被覆盖');
    assert.notEqual(after.modified, '', 'modified 必填');
    assert.equal(store.count(), 1, '更新不新增记录文件');
    assert.equal(store.list().some((r) => r.slug === 'prefers-chinese-2'), false, '不产生 -2 副本');
    assert.equal(after.body, 'always answer in Chinese, including tables', '正文被更新');
    assert.deepEqual(mdFiles(store), ['prefers-chinese.md'], '只存在一个记录文件');
  });
});

test('⑩ put 撞他人 description 归一相同 → MEMORY_DUPLICATE（自排除不误伤自身更新）', () => {
  withStore((store) => {
    const seeded = store.put({ slug: 'a', type: 'project', description: 'Repo uses pnpm', body: 'pnpm only' });
    assert.equal(seeded.ok, true);
    const r = store.put({ slug: 'b', type: 'project', description: 'repo uses   PNPM', body: 'other body' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, 'MEMORY_DUPLICATE');
    assert.equal(store.count(), 1, '被拒写入不落盘');
  });
});

test('⑪ modified 为 ISO 8601 且写入后被解析回读', () => {
  withStore((store) => {
    const r = store.put({ slug: 'iso', type: 'project', description: 'd', body: 'b' });
    assert.equal(r.ok, true);
    const rec = store.list().find((x) => x.slug === 'iso')!;
    assert.match(rec.modified, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'ISO 8601 时间戳');
    assert.ok(
      fs.readFileSync(path.join(store.dir(), 'iso.md'), 'utf8').includes(`modified: ${rec.modified}`),
      '落盘 frontmatter 的 modified 与解析回读值一致',
    );
  });
});

test('⑫ 缺 modified 的旧记录回退 created（零迁移）', () => {
  withStore((store) => {
    fs.writeFileSync(
      path.join(store.dir(), 'legacy.md'),
      ['---', 'type: project', 'created: 2026-01-02', 'description: legacy record', '---', 'body', ''].join('\n'),
    );
    const rec = store.list().find((x) => x.slug === 'legacy')!;
    assert.equal(rec.modified, '2026-01-02');
    assert.equal(rec.created, '2026-01-02', 'created 原值不动');
    assert.equal(rec.body, 'body', '旧文件正文解析不受影响');
  });
});

test('⑬ capacityNotice：近满（≥80%）返回提醒、未近满返回 null', () => {
  withStore((store) => {
    assert.equal(store.capacityNotice(), null);
    for (let i = 0; i < 160; i += 1) {
      const w = store.put({ slug: `n${i}`, type: 'project', description: `fact ${i}`, body: `body ${i}` });
      assert.equal(w.ok, true, `第 ${i} 条写入应成功（未超限）`);
    }
    const notice = store.capacityNotice();
    assert.notEqual(notice, null);
    assert.match(String(notice), /160|200/);
    assert.equal(store.overLimit(), null, '近满尚未超限：仍可写');
  });
});

test('⑭ 显式子目录构造：dir() 落在 memory/agents/<id> 且与主目录互不干扰', () => {
  withStoreRoot((root, main) => {
    const child = new MemoryStore(root, { subdir: path.join('agents', 'reviewer') });
    const w = child.put({ slug: 'r1', type: 'project', description: 'child fact', body: 'child body' });
    assert.equal(w.ok, true);
    assert.equal(main.count(), 0, '主目录零干扰');
    assert.equal(child.count(), 1);
    assert.ok(child.dir().endsWith(path.join('memory', 'agents', 'reviewer')), '目录形态');
    assert.equal(child.indexText(), '- r1 — child fact [project]\n', '子目录自有索引');
    assert.equal(main.indexText(), '', '主索引不被子目录写入触碰');
  });
});

// ── Fix round 1（审查 Important）：slug 校验收口 isSafeSlug / put·remove 拒绝非法 slug / add 避让索引名 ──

test('⑮ isSafeSlug 纯函数语义：规范化形态 + 大小写不敏感排除索引名', () => {
  assert.equal(isSafeSlug('prefers-pnpm'), true);
  assert.equal(isSafeSlug('memo-2'), true);
  assert.equal(isSafeSlug('偏好-TypeScript-strict'), true);
  assert.equal(isSafeSlug(''), false, '空串非法');
  assert.equal(isSafeSlug('../x'), false, '目录穿越形态非法');
  assert.equal(isSafeSlug('..'), false);
  assert.equal(isSafeSlug('foo/bar'), false, '含路径分隔符非法');
  assert.equal(isSafeSlug('foo bar'), false, '含空白（非规范化）非法');
  assert.equal(isSafeSlug(' Foo'), false, '首尾空白非法');
  assert.equal(isSafeSlug('x'.repeat(41)), false, '超长截断形态非规范化');
  assert.equal(isSafeSlug('MEMORY'), false, '索引名（全大写）非法');
  assert.equal(isSafeSlug('memory'), false, '索引名（全小写）非法');
  assert.equal(isSafeSlug('Memory'), false, '大小写不敏感排除');
  assert.equal(isSafeSlug('MEMORY.md'), false);
});

test('⑯ put 非法 slug：拒绝写入、零越界文件、记忆目录与索引零污染', () => {
  withStoreRoot((_root, store) => {
    const seeded = store.put({ slug: 'prefers-pnpm', type: 'project', description: 'repo uses pnpm', body: 'pnpm only' });
    assert.equal(seeded.ok, true);
    const indexBefore = store.indexText();
    const filesBefore = mdFiles(store);

    const r = store.put({ slug: '../x', type: 'project', description: 'escape attempt', body: 'must not land' });
    assert.equal(r.ok, false, '非法 slug 必须被拒');
    if (!r.ok) {
      assert.equal(r.error.code, 'MEMORY_SLUG_INVALID');
      // 文案随 locale（pick(en, zh)）切换：断言两语种任一命中，避免环境语言导致误判
      assert.match(r.error.message, /normalized form|规范化形态/, '文案说明规范化形态约束');
      assert.match(r.error.message, /index name|索引名/, '文案说明不得为索引名');
    }

    const dataDir = path.resolve(store.dir(), '..');
    assert.equal(fs.existsSync(path.join(dataDir, 'x.md')), false, '`memory/../x.md` 未产生（越出记忆目录的写入被拦）');
    assert.equal(fs.existsSync(path.join(path.dirname(dataDir), 'x.md')), false, '`<dataDir>/../x.md` 不存在');
    assert.deepEqual(mdFiles(store), filesBefore, '记忆目录只有既有内容');
    assert.equal(store.indexText(), indexBefore, '索引未被触碰');
    assert.equal(store.count(), 1, '仍只有既有记录');
  });
});

test('⑰ put slug 撞索引名（大小写不敏感）：MEMORY_SLUG_INVALID 且 MEMORY.md 未被覆盖', () => {
  withStore((store) => {
    const seeded = store.put({ slug: 'prefers-pnpm', type: 'project', description: 'repo uses pnpm', body: 'pnpm only' });
    assert.equal(seeded.ok, true);
    const indexBefore = store.indexText();
    const linesBefore = indexBefore.split('\n').filter((l: string) => l.length > 0).length;

    for (const slug of ['MEMORY', 'memory']) {
      const r = store.put({ slug, type: 'project', description: `overwrite index via ${slug}`, body: `body ${slug}` });
      assert.equal(r.ok, false, `${slug} 应被拒`);
      if (!r.ok) assert.equal(r.error.code, 'MEMORY_SLUG_INVALID');
    }

    assert.equal(store.indexText(), indexBefore, 'MEMORY.md 内容未被该记录覆盖');
    assert.equal(store.indexText().split('\n').filter((l: string) => l.length > 0).length, linesBefore, '索引行数不变');
    assert.ok(store.list().some((rec) => rec.slug === 'prefers-pnpm'), '既有记录仍在索引与列表中（未被静默跳过）');
    assert.equal(store.count(), 1, '被拒记录未落盘');
    assert.equal(fs.existsSync(path.join(store.dir(), 'memory.md')), false, '小写索引名文件亦未产生');
  });
});

test('⑱ add 归一得索引名（空目录起）：落盘 memo.md，索引无双写痕迹、记录可见', () => {
  withStore((store) => {
    const r = store.add({ type: 'project', description: 'MEMORY', body: 'index-collision avoidance' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.slug, 'memo', '撞索引名时起始候选改 memo');
    assert.deepEqual(mdFiles(store), ['memo.md'], '落盘文件名为 memo.md（未覆盖 MEMORY.md）');
    assert.ok(store.list().some((rec) => rec.slug === 'memo'), 'memo 记录对 list() 可见');
    assert.equal(store.count(), 1);
    const lines = store.indexText().split('\n').filter((l: string) => l.length > 0);
    assert.deepEqual(lines, ['- memo — MEMORY [project]'], '索引只有 memo 一条记录行');
    assert.equal(
      lines.some((l: string) => l.startsWith('- MEMORY ') || l.startsWith('- memory ')),
      false,
      '索引不含「把索引名当记录名」的双写痕迹',
    );
  });
});

test('⑲ add 归一得索引名且 memo 已占：改走既有 -2 避让，不覆盖索引也不丢记录', () => {
  withStore((store) => {
    const seed = store.put({ slug: 'memo', type: 'project', description: 'existing memo', body: 'existing memo body' });
    assert.equal(seed.ok, true);

    const r = store.add({ type: 'project', description: 'MEMORY', body: 'index-collision avoidance, second' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.slug, 'memo-2', 'memo 被占则沿用既有避让循环得 memo-2');
    assert.deepEqual(mdFiles(store), ['memo-2.md', 'memo.md'], '两条记录各自落盘，索引文件未被当记录覆盖');
    assert.equal(store.count(), 2);
    assert.ok(store.list().some((rec) => rec.slug === 'memo-2'), 'memo-2 对 list() 可见');
    assert.ok(store.indexText().includes('- memo-2 — MEMORY [project]'), '索引含 memo-2 记录行');
  });
});

test('⑳ remove 非法 slug 拒绝（防删除逃逸）；合法但不存在的 slug 仍 MEMORY_NOT_FOUND', () => {
  withStoreRoot((_root, store) => {
    const seeded = store.put({ slug: 'prefers-pnpm', type: 'project', description: 'repo uses pnpm', body: 'pnpm only' });
    assert.equal(seeded.ok, true);
    const outside = path.join(path.resolve(store.dir(), '..'), 'x.md');
    fs.writeFileSync(outside, 'outside file must survive');

    for (const slug of ['../x', 'MEMORY', 'memory', 'a/b']) {
      const r = store.remove(slug);
      assert.equal(r.ok, false, `${slug} 应被拒`);
      if (!r.ok) assert.equal(r.error.code, 'MEMORY_SLUG_INVALID');
    }
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside file must survive', '越界目标文件未被删除');
    assert.equal(store.count(), 1, '既有记录未被误删');
    assert.ok(store.list().some((rec) => rec.slug === 'prefers-pnpm'));

    const miss = store.remove('不存在的合法slug');
    assert.equal(miss.ok, false);
    if (!miss.ok) assert.equal(miss.error.code, 'MEMORY_NOT_FOUND', '合法 slug 不存在仍保持 MEMORY_NOT_FOUND 语义');
    assert.equal(store.count(), 1);
  });
});

test('㉑ 正向回归：合法规范化 slug 的 put/更新/remove 全链路照常', () => {
  withStore((store) => {
    const r = store.put({ slug: 'prefers-pnpm', type: 'project', description: 'repo uses pnpm', body: 'pnpm only' });
    assert.equal(r.ok, true);
    assert.deepEqual(mdFiles(store), ['prefers-pnpm.md']);
    assert.equal(store.indexText(), '- prefers-pnpm — repo uses pnpm [project]\n');
    assert.ok(store.list().some((rec) => rec.slug === 'prefers-pnpm'));

    const up = store.put({ slug: 'prefers-pnpm', type: 'project', description: 'repo uses pnpm', body: 'pnpm only, plus corepack' });
    assert.equal(up.ok, true);
    assert.equal(store.count(), 1, '同 slug 更新不新增文件');
    if (up.ok) assert.equal(up.value.body, 'pnpm only, plus corepack');

    const del = store.remove('prefers-pnpm');
    assert.equal(del.ok, true);
    assert.equal(store.count(), 0);
    assert.equal(store.indexText(), '');
  });
});
