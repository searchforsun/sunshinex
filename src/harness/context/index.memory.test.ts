import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextManager, runCompaction } from './index';
import { MemoryStore } from '../memory/store';
import { FileStore } from '../../storage/adapter';

/** 记忆索引并入 G 项冻结快照（规格 §3）：构造/刷新点装载、会话中途冻结、零记忆零条目 */

async function withCM(fn: (cm: ContextManager, mem: MemoryStore, tmp: string) => Promise<void>): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-cm-mem-'));
  process.env.SUNSHINEX_DATA_DIR = tmp;
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root, { recursive: true });
    await fn(new ContextManager(root, new FileStore(root)), new MemoryStore(root), tmp);
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const memItems = (cm: ContextManager): string[] =>
  cm.assemble([]).filter((i) => i.kind === 'system' && i.content.startsWith('Memory index')).map((i) => i.content);

test('构造时快照含记忆索引条目（引导行 + slug 行）', async () => {
  await withCM(async (cm, mem) => {
    const r = mem.add({ type: 'user', description: 'prefers concise replies', body: 'keep replies short' });
    assert.ok(r.ok);
    const cm2 = new ContextManager(cm.root, new FileStore(cm.root));
    const items = memItems(cm2);
    assert.equal(items.length, 1);
    assert.ok(items[0].includes('- prefers-concise-replies — prefers concise replies [user]'), '索引 slug 行在条目内');
  });
});

test('会话中途新增记忆不进当前快照（冻结）；reloadContext 刷新后出现', async () => {
  await withCM(async (cm, mem) => {
    mem.add({ type: 'project', description: 'first memo', body: 'first body' });
    const cm2 = new ContextManager(cm.root, new FileStore(cm.root));
    assert.equal(memItems(cm2).length, 1);

    mem.add({ type: 'project', description: 'second memo', body: 'second body' });
    assert.ok(!memItems(cm2).some((c) => c.includes('second-memo')), '冻结：中途改盘不进当前快照');

    cm2.reloadContext();
    assert.ok(memItems(cm2).some((c) => c.includes('second-memo')), '刷新点四：reloadContext 重读生效');
  });
});

test('无记忆 → assemble 零记忆条目（零开销）', async () => {
  await withCM(async (cm) => {
    assert.equal(memItems(cm).length, 0);
    assert.ok(!fs.existsSync(path.join(process.env.SUNSHINEX_DATA_DIR ?? '', 'memory', 'MEMORY.md')));
  });
});

test('压缩成功后快照刷新（runCompaction → reloadContext 跟随）', async () => {
  await withCM(async (cm, mem) => {
    mem.add({ type: 'project', description: 'memo one', body: 'body one' });
    const cm2 = new ContextManager(cm.root, new FileStore(cm.root));
    cm2.appendChain([{ action: 'read', observation: 'Y' }]);

    mem.add({ type: 'project', description: 'memo two', body: 'body two' });
    await runCompaction(cm2, cm2.assemble([{ kind: 'history', content: '1: read -> Y' }]), {
      summaryTokenBudget: 2000,
      rereadTokenBudget: 500,
      chainFoldedCount: cm2.chainView().length,
    });
    assert.ok(memItems(cm2).some((c) => c.includes('memo-two')), '压缩刷新点带出记忆索引');
  });
});
