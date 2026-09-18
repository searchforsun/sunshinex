import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { consolidateMemory } from './consolidate';
import { MemoryStore, MEMORY_CONSOLIDATE_THRESHOLD } from './store';
import type { ModelAdapter } from '../../model/adapter';

/** 整理管线（规格 §5）：≥10 阈值触发、模型清洗合并（supersede）、只减不增、.bak 快照回滚 */

function withMem(fn: (mem: MemoryStore, tmp: string) => Promise<void> | void): Promise<void> {
  return (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-mem-co-'));
    process.env.SUNSHINEX_DATA_DIR = tmp;
    try {
      const root = path.join(tmp, 'root');
      fs.mkdirSync(root, { recursive: true });
      await fn(new MemoryStore(root), tmp);
    } finally {
      delete process.env.SUNSHINEX_DATA_DIR;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })();
}

const seed = (mem: MemoryStore, n: number): void => {
  for (let i = 1; i <= n; i += 1) {
    const r = mem.add({ type: 'project', description: `memo topic ${i}`, body: `repeated note body ${i}` });
    assert.ok(r.ok, `seed ${i}`);
  }
};

/** openai 整理桩：prompt 含 memory-consolidation 标记时返回合并集（保留前 half 条） */
function consolidationStub(keep: number): ModelAdapter {
  return {
    provider: 'openai',
    complete: async (prompt: string) => {
      if (!prompt.includes('memory-consolidation')) throw new Error('unexpected non-consolidation call');
      const slugs: string[] = [];
      for (let i = 1; i <= keep; i += 1) slugs.push(`memo-topic-${i}`);
      return JSON.stringify({
        memories: slugs.map((s, idx) => ({ type: 'project', description: `memo topic ${idx + 1} (consolidated)`, body: `merged content for ${s}` })),
      });
    },
  };
}

test('count < 阈值 → 直接返回零调用零副作用', async () => {
  await withMem(async (mem) => {
    let called = 0;
    const model: ModelAdapter = { provider: 'openai', complete: async () => { called += 1; return '{"memories":[]}'; } };
    seed(mem, MEMORY_CONSOLIDATE_THRESHOLD - 1);
    await consolidateMemory({ model, root: mem.dir() });
    assert.equal(called, 0, '阈值未达零调用');
    assert.equal(mem.count(), MEMORY_CONSOLIDATE_THRESHOLD - 1);
  });
});

test('≥ 阈值：模型合并集替换旧记录 + 索引重建', async () => {
  await withMem(async (mem) => {
    seed(mem, MEMORY_CONSOLIDATE_THRESHOLD);
    await consolidateMemory({ model: consolidationStub(4), root: mem.dir() });
    assert.equal(mem.count(), 4, '只保留合并集');
    assert.ok(mem.indexText().includes('(consolidated)'), '索引带出新记录');
    assert.ok(!mem.indexText().includes(`memo-topic-${MEMORY_CONSOLIDATE_THRESHOLD}`), '旧记录行消失');
  });
});

test('输出条数 > 输入条数 → 拒绝采用保持原状（整理只减不增）', async () => {
  await withMem(async (mem) => {
    seed(mem, MEMORY_CONSOLIDATE_THRESHOLD);
    const before = mem.list().map((m) => m.slug);
    await consolidateMemory({ model: consolidationStub(MEMORY_CONSOLIDATE_THRESHOLD + 3), root: mem.dir() });
    assert.deepEqual(mem.list().map((m) => m.slug), before, '原状保留');
  });
});

test('输出非 JSON → 保持原状不抛', async () => {
  await withMem(async (mem) => {
    seed(mem, MEMORY_CONSOLIDATE_THRESHOLD);
    const before = mem.count();
    const model: ModelAdapter = { provider: 'openai', complete: async () => 'garbage not json' };
    await consolidateMemory({ model, root: mem.dir() });
    assert.equal(mem.count(), before);
  });
});

test('落盘失败 → .bak 快照回滚，记录与整理前一致', async () => {
  await withMem(async (mem) => {
    seed(mem, MEMORY_CONSOLIDATE_THRESHOLD);
    const before = mem.list().map((m) => m.slug);
    // 确定性失败注入：MEMORY.md 预置为目录 → apply 末尾 rebuildIndex writeFileSync EISDIR → 触发回滚
    fs.rmSync(path.join(mem.dir(), 'MEMORY.md'), { force: true });
    fs.mkdirSync(path.join(mem.dir(), 'MEMORY.md'));
    const model: ModelAdapter = {
      provider: 'openai',
      complete: async (p: string) => {
        if (!p.includes('memory-consolidation')) throw new Error('unexpected non-consolidation call');
        return JSON.stringify({ memories: [{ type: 'project', description: 'merged into one', body: 'single merged record' }] });
      },
    };
    await consolidateMemory({ model, root: mem.dir() });
    assert.deepEqual(mem.list().map((m) => m.slug), before, '回滚后记录与整理前一致');
    assert.equal(mem.count(), MEMORY_CONSOLIDATE_THRESHOLD);
  });
});

test('整理成功后 .bak 快照清理（不留备份残渣）', async () => {
  await withMem(async (mem) => {
    seed(mem, MEMORY_CONSOLIDATE_THRESHOLD);
    await consolidateMemory({ model: consolidationStub(4), root: mem.dir() });
    const leftovers = fs.readdirSync(mem.dir()).filter((f) => f.startsWith('.bak'));
    assert.equal(leftovers.length, 0, '成功整理不留备份目录');
  });
});
