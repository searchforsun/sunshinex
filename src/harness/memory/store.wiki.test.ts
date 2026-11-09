import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MemoryStore, TOPICS_DIR } from './store';

/** Wiki 层 store 钉（2026-11-09）：links/superseded_by 字段往返与「put 未传即保留」防抹语义；
 *  supersededBy 记录不进索引；主题页整目录重建 + 索引两段化（无主题页时与旧形态逐字节一致） */

function withStore(fn: (store: MemoryStore) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mem-wiki-'));
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

const raw = (store: MemoryStore, slug: string): string => fs.readFileSync(path.join(store.dir(), `${slug}.md`), 'utf8');

test('links/superseded_by 往返：写出 frontmatter 键，list 回读；非法 slug 逐项滤除', () => {
  withStore((store) => {
    store.add({ type: 'project', description: 'fact one', body: 'body one' });
    store.put({ slug: 'fact-two', type: 'project', description: 'fact two', body: 'body two', links: ['fact-one', '../escape', 'fact-one'], supersededBy: 'fact-one' });
    assert.match(raw(store, 'fact-two'), /\nlinks: fact-one\nsuperseded_by: fact-one\n---\n/, '键写出、去重、非法项滤除');
    const r = store.list().find((x) => x.slug === 'fact-two')!;
    assert.deepEqual(r.links, ['fact-one']);
    assert.equal(r.supersededBy, 'fact-one');
  });
});

test('存量四键记录零变化：无 Wiki 字段时 frontmatter 不出现新键', () => {
  withStore((store) => {
    store.add({ type: 'user', description: 'plain fact', body: 'plain body' });
    const text = raw(store, 'plain-fact');
    assert.ok(!text.includes('links:') && !text.includes('superseded_by:'));
    assert.equal(store.list()[0]!.links, undefined);
  });
});

test('put 未传 Wiki 字段即保留既有值（update/整理路径不抹链接）；显式空数组清除', () => {
  withStore((store) => {
    store.add({ type: 'project', description: 'anchor', body: 'anchor body' });
    store.put({ slug: 'linked', type: 'project', description: 'linked fact', body: 'v1', links: ['anchor'] });
    store.put({ slug: 'linked', type: 'project', description: 'linked fact', body: 'v2 rewritten' });
    const kept = store.list().find((x) => x.slug === 'linked')!;
    assert.equal(kept.body, 'v2 rewritten');
    assert.deepEqual(kept.links, ['anchor'], '未传 links → 保留');
    store.put({ slug: 'linked', type: 'project', description: 'linked fact', body: 'v3', links: [] });
    assert.equal(store.list().find((x) => x.slug === 'linked')!.links, undefined, '显式空数组 → 清除');
  });
});

test('supersededBy 记录不进索引（文件仍在供追溯）', () => {
  withStore((store) => {
    store.add({ type: 'project', description: 'new truth', body: 'new body' });
    store.put({ slug: 'old-truth', type: 'project', description: 'old truth', body: 'old body', supersededBy: 'new-truth' });
    const index = store.indexText();
    assert.ok(index.includes('new-truth.md'));
    assert.ok(!index.includes('old-truth.md'), '被取代记录不进索引');
    assert.ok(fs.existsSync(path.join(store.dir(), 'old-truth.md')), '记录文件保留');
    assert.equal(store.count(), 2, '计数口径不变');
  });
});

test('无主题页时索引与旧形态逐字节一致', () => {
  withStore((store) => {
    store.add({ type: 'project', description: 'fact one', body: 'body one' });
    assert.equal(store.indexText(), '# Memory Index\n\n- [fact one](fact-one.md)：body one\n');
  });
});

test('writeTopics：主题页写入 + 索引两段化（主题段一句话，散条段只列未归类记录）', () => {
  withStore((store) => {
    store.add({ type: 'reference', description: 'alarm config pages', body: 'config page url' });
    store.add({ type: 'project', description: 'alarm source shape', body: 'source and shape' });
    store.add({ type: 'user', description: 'prefers pnpm', body: 'use pnpm' });
    store.writeTopics([{ name: 'Aries baseline alarm', description: 'Cuckoo alarm config and payload shape', summary: 'Overview of the alarm.', slugs: ['alarm-config-pages', 'alarm-source-shape', 'ghost-slug'] }]);
    const page = fs.readFileSync(path.join(store.dir(), TOPICS_DIR, 'Aries-baseline-alarm.md'), 'utf8');
    assert.match(page, /^---\nname: Aries baseline alarm\ndescription: Cuckoo alarm config and payload shape\nslugs: alarm-config-pages, alarm-source-shape\n---\nOverview of the alarm\.\n/, '悬空 slug 滤除');
    assert.ok(page.includes('- [alarm config pages](../alarm-config-pages.md)'), '综述页含记录链接');
    assert.equal(
      store.indexText(),
      '# Memory Index\n\n## Topics\n- [Aries baseline alarm](topics/Aries-baseline-alarm.md)：Cuckoo alarm config and payload shape\n\n## Records\n- [prefers pnpm](prefers-pnpm.md)：use pnpm\n',
    );
    assert.equal(store.count(), 3, '主题页不计入记录');
  });
});

test('writeTopics 整目录重建：旧页清退；空归属主题不写；空清单回旧形态索引', () => {
  withStore((store) => {
    store.add({ type: 'project', description: 'fact one', body: 'body one' });
    store.writeTopics([{ name: 'Old topic', description: 'old', summary: 's', slugs: ['fact-one'] }]);
    store.writeTopics([
      { name: 'New topic', description: 'new', summary: 's', slugs: ['fact-one'] },
      { name: 'Empty topic', description: 'none', summary: 's', slugs: ['missing'] },
    ]);
    assert.deepEqual(fs.readdirSync(path.join(store.dir(), TOPICS_DIR)), ['New-topic.md'], '旧页清退、空归属不写');
    store.writeTopics([]);
    assert.equal(store.indexText(), '# Memory Index\n\n- [fact one](fact-one.md)：body one\n', '无主题回旧形态');
  });
});

test('restore 不清退 topics/（派生物不入快照，回滚后主题段仍可解析）', () => {
  withStore((store) => {
    store.add({ type: 'project', description: 'fact one', body: 'body one' });
    store.writeTopics([{ name: 'T', description: 'd', summary: 's', slugs: ['fact-one'] }]);
    const bak = store.backup();
    store.remove('fact-one');
    store.restore(bak);
    assert.ok(fs.existsSync(path.join(store.dir(), TOPICS_DIR, 'T.md')), 'topics 在场');
    assert.ok(store.indexText().includes('topics/T.md'));
  });
});
