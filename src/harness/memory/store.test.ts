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
  normalizeText,
  slugifyMemory,
} from './store';

/** 每用例独立 tmpdir + SUNSHINEX_DATA_DIR 重定向，finally 还原 env 并清理，绝不触碰真实家目录 */
function withStore(fn: (store: MemoryStore) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mem-'));
  process.env.SUNSHINEX_DATA_DIR = tmp;
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    fn(new MemoryStore(root));
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
