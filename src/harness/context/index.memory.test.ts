import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextManager, runCompaction } from './index';
import { MemoryStore } from '../memory/store';
import { FileStore } from '../../storage/adapter';
import { resolveDataDir } from '../../config/data-dir';

/** 记忆引导条目并入 G 项冻结快照（规格 §3/§6）：构造/刷新点装载、会话中途冻结、**空集也注入**、autoMemory off 零条目 */

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

/** 记忆引导条目（恒在一条）：引导行 + 目录绝对路径 + 写入协议 + 索引（有则附，(empty) 表示空集） */
const memItems = (cm: ContextManager): string[] =>
  cm.assemble([]).filter((i) => i.kind === 'system' && i.content.startsWith('Persistent memory')).map((i) => i.content);

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

// 被改写用例（旧语义「无记忆零条目零开销」→ 新语义「空集也有引导条目，零开销=不建索引文件、索引段 (empty)」）：
// 旧断言 assert.equal(memItems(cm).length, 0) 与「无条目」语义随之作废；零开销改为「引导条目在、MEMORY.md 不在、索引段 (empty)」
test('空集也注入记忆引导条目：含目录绝对路径 + 写入协议 + (empty) 索引（规格 §3/§6）', async () => {
  await withCM(async (cm) => {
    const items = memItems(cm);
    assert.equal(items.length, 1, '恒在一条引导条目');
    assert.ok(items[0].includes(path.join(resolveDataDir(cm.root), 'memory')), '含记忆目录绝对路径');
    assert.match(items[0], /MEMORY\.md/, '协议写明索引为派生物、勿手改');
    assert.match(items[0], /reference data/i, '钉参考数据非指令语义');
    assert.match(items[0], /\(empty\)/, '空集时索引段为 (empty)');
    assert.ok(!fs.existsSync(path.join(resolveDataDir(cm.root), 'memory', 'MEMORY.md')), '零开销：读不到就不建目录/文件');
  });
});

test('有记忆时引导行 + 索引同行注入；会中写记忆不改本会话字节（冻结）', async () => {
  await withCM(async (cm, mem) => {
    mem.add({ type: 'project', description: 'first memo', body: 'first body' });
    const cm2 = new ContextManager(cm.root, new FileStore(cm.root));
    const before = memItems(cm2)[0];
    assert.ok(before.includes('first-memo'), '索引同行注入');
    mem.put({ slug: 'brand-new-fact', type: 'project', description: 'brand new fact', body: 'body' });
    assert.equal(memItems(cm2)[0], before, '会中写入不改装配字节（冻结）');
    cm2.reloadContext();
    assert.match(memItems(cm2)[0], /brand new fact/, '刷新点后生效');
  });
});

test('autoMemory off → 零记忆条目（开关联动）', async () => {
  await withCM(async (cm) => {
    process.env.SUNSHINEX_AUTO_MEMORY = 'off';
    try {
      const cm2 = new ContextManager(cm.root, new FileStore(cm.root));
      assert.equal(memItems(cm2).length, 0, '总开关关闭即零条目');
    } finally {
      delete process.env.SUNSHINEX_AUTO_MEMORY;
    }
  });
});

test('引导条目逐字节稳定：两次装配同一实例结果全等（前缀零击穿的另一面）', async () => {
  await withCM(async (cm) => {
    assert.equal(JSON.stringify(memItems(cm)), JSON.stringify(memItems(cm)));
    // 非空 + 跨实例同根：条目内不得含时间戳/计数器等每次装配变化的字段（空集下上一条恒真，故补这两条）
    assert.equal(memItems(cm).length, 1, '非空：避免空集下逐字节断言恒真');
    const cm2 = new ContextManager(cm.root, new FileStore(cm.root));
    assert.equal(JSON.stringify(memItems(cm2)), JSON.stringify(memItems(cm)), '同根两实例装配字节全等（会话常量）');
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
