import { textReplyToChatFace } from '../../model/chat-stub';
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
    capabilities: { chat: true }, // J2：真实模型夹具声明能力位（门禁判据）

    chat: async (req) => {
      const prompt = req.messages.map((m) => (m.role === 'user' ? m.content : '')).join('\n');
      if (!prompt.includes('memory-consolidation')) throw new Error('unexpected non-consolidation call');
      const items = Array.from({ length: keep }, (_, idx) => ({ type: 'project', description: `memo topic ${idx + 1} (consolidated)`, body: `merged content for memo-topic-${idx + 1}` }));
      return { finish: 'tool_calls', content: '', toolCalls: [{ id: 'call_0', name: 'submit_memory_items', argsJson: JSON.stringify({ items }) }] };
    },
  };
}

test('count < 阈值 → 直接返回零调用零副作用', async () => {
  await withMem(async (mem) => {
    let called = 0;
    const model: ModelAdapter = { provider: 'openai', capabilities: { chat: true }, chat: textReplyToChatFace(async () => { called += 1; return '{"memories":[]}'; }) };
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
    const model: ModelAdapter = { provider: 'openai', capabilities: { chat: true }, chat: async () => ({ finish: 'tool_calls', content: '', toolCalls: [] }) };
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
      capabilities: { chat: true },
      chat: async (req) => {
        const p = req.messages.map((m) => (m.role === 'user' ? m.content : '')).join('\n');
        if (!p.includes('memory-consolidation')) throw new Error('unexpected non-consolidation call');
        const items = [{ type: 'project', description: 'merged into one', body: 'single merged record' }];
        return { finish: 'tool_calls', content: '', toolCalls: [{ id: 'call_0', name: 'submit_memory_items', argsJson: JSON.stringify({ items }) }] };
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

/** 整理桩：前 keep 条逐字保留（同 description/body，模拟「未变条目」），其余并成一条——差分应用钉用 */
function keepVerbatimStub(keep: number): ModelAdapter {
  return {
    provider: 'openai',
    capabilities: { chat: true }, // J2：真实模型夹具声明能力位（门禁判据）
    chat: async (req) => {
      const prompt = req.messages.map((m) => (m.role === 'user' ? m.content : '')).join('\n');
      if (!prompt.includes('memory-consolidation')) throw new Error('unexpected non-consolidation call');
      const items = [
        ...Array.from({ length: keep }, (_, idx) => ({ type: 'project', description: `memo topic ${idx + 1}`, body: `repeated note body ${idx + 1}` })),
        { type: 'project', description: 'merged rest', body: 'merged bodies of the rest' },
      ];
      return { finish: 'tool_calls', content: '', toolCalls: [{ id: 'call_0', name: 'submit_memory_items', argsJson: JSON.stringify({ items }) }] };
    },
  };
}

test('差分应用：未变条目原位更新保 slug 与 created（时效信号不因整理抹平）', async () => {
  await withMem(async (mem) => {
    seed(mem, MEMORY_CONSOLIDATE_THRESHOLD);
    // 把 memo-topic-1 的 created 钉到旧日期（add 只写今天；手工改 frontmatter 模拟三天前的记录）
    const file = path.join(mem.dir(), 'memo-topic-1.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^created: .*$/m, 'created: 2026-01-01'));
    await consolidateMemory({ model: keepVerbatimStub(2), root: mem.dir() });
    const rec = mem.list().find((r) => r.slug === 'memo-topic-1');
    assert.ok(rec, 'slug 未变——上下文冻结快照里的引用继续有效');
    assert.equal(rec.created, '2026-01-01', '承接条目保 created（整理判 stale 的唯一时效依据不抹平）');
    assert.equal(rec.body, 'repeated note body 1', '原位更新正文不丢');
    assert.equal(mem.count(), 3, '2 条保留 + 1 条合并（只减不增）');
  });
});

test('模型幻觉 type 收编为合法四选一（frontmatter 恒合法枚举）', async () => {
  await withMem(async (mem) => {
    seed(mem, MEMORY_CONSOLIDATE_THRESHOLD);
    const model: ModelAdapter = {
      provider: 'openai',
      capabilities: { chat: true },
      chat: async (req) => {
        const p = req.messages.map((m) => (m.role === 'user' ? m.content : '')).join('\n');
        if (!p.includes('memory-consolidation')) throw new Error('unexpected non-consolidation call');
        const items = [{ type: 'session', description: 'merged into one', body: 'single merged record' }];
        return { finish: 'tool_calls', content: '', toolCalls: [{ id: 'call_0', name: 'submit_memory_items', argsJson: JSON.stringify({ items }) }] };
      },
    };
    await consolidateMemory({ model, root: mem.dir() });
    assert.equal(mem.count(), 1);
    assert.equal(mem.list()[0].type, 'project', '非法 type 收编为 project（与提取路径同口径）');
  });
});

test('合并集内跨例目重复 → 跳过该条不整批回滚（防静默重试循环）', async () => {
  await withMem(async (mem) => {
    seed(mem, MEMORY_CONSOLIDATE_THRESHOLD);
    const model: ModelAdapter = {
      provider: 'openai',
      capabilities: { chat: true },
      chat: async (req) => {
        const p = req.messages.map((m) => (m.role === 'user' ? m.content : '')).join('\n');
        if (!p.includes('memory-consolidation')) throw new Error('unexpected non-consolidation call');
        // 两条 body 归一相同（模型偶发）：旧实现 add 报 MEMORY_DUPLICATE → throw → 整批回滚 → 阈值以上每次收口重演
        const items = [
          { type: 'project', description: 'merged a', body: 'same body text' },
          { type: 'project', description: 'merged b', body: 'same body text' },
        ];
        return { finish: 'tool_calls', content: '', toolCalls: [{ id: 'call_0', name: 'submit_memory_items', argsJson: JSON.stringify({ items }) }] };
      },
    };
    await consolidateMemory({ model, root: mem.dir() });
    assert.equal(mem.count(), 1, '重复条目只丢该条，第一条生效');
    assert.equal(mem.list()[0].slug, 'merged-a');
  });
});

test('整理未应用（模型不出牌）→ notify 浮出一行说明（不再静默重试）', async () => {
  await withMem(async (mem) => {
    seed(mem, MEMORY_CONSOLIDATE_THRESHOLD);
    const lines: string[] = [];
    const model: ModelAdapter = { provider: 'openai', capabilities: { chat: true }, chat: async () => ({ finish: 'tool_calls', content: '', toolCalls: [] }) };
    await consolidateMemory({ model, root: mem.dir(), notify: (l) => lines.push(l) });
    assert.equal(lines.length, 1, '恰好一行说明');
    assert.match(lines[0], /^\[memory\] consolidation not applied \(model returned no consolidation payload\)/);
    assert.equal(mem.count(), MEMORY_CONSOLIDATE_THRESHOLD, '原状保留');
  });
});
