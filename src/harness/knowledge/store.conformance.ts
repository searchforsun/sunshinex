import assert from 'node:assert/strict';
import { VectorStore } from './store';

export interface ConformanceOptions {
  /** 损坏存储的注入点（各后端存储介质不同，由挂接方提供）；未提供时跳过损坏恢复契约 */
  corruptStorage?: () => void;
}

/**
 * 全后端必过的存储契约套件：写入/召回排序、TopK 语义、幂等覆盖、持久化往返、损坏恢复。
 * 「可插拔」由第二个真实后端通过本套件证明（spec §3.4）；P1 sqlite-vec 复用，不改断言。
 */
export function runVectorStoreConformance(create: () => VectorStore, opts: ConformanceOptions = {}): void {
  // 写入与召回：余弦排序、score 降序
  const s = create();
  s.upsert('a', [1, 0], { text: 'alpha' });
  s.upsert('b', [0, 1], { text: 'beta' });
  s.upsert('c', [0.9, 0.1], { text: 'gamma' });
  const hits = s.search([1, 0], 2);
  assert.equal(hits.length, 2, 'topK=2 应返回 2 条');
  assert.equal(hits[0].id, 'a', '最近邻应排首位');
  assert.ok(hits[0].score >= hits[1].score, 'score 应降序');

  // TopK 语义：0 = 空；超库容 = 全部
  assert.equal(s.search([1, 0], 0).length, 0, 'topK=0 应返回空');
  assert.equal(s.search([1, 0], 99).length, 3, 'topK 超库容应返回全部');
  assert.equal(s.size(), 3);

  // 幂等覆盖：同 id upsert 不增容、内容以最新为准（覆盖向量取严格唯一最近，平局序不可作为契约）
  s.upsert('a', [0.9, 0.9], { text: 'alpha-v2' });
  assert.equal(s.size(), 3, '同 id 覆盖不应增加容量');
  assert.equal(s.search([0.9, 0.9], 1)[0].text, 'alpha-v2');

  // 持久化往返：flush 后经独立实例 load 可完整检索
  s.flush();
  const s2 = create();
  assert.equal(s2.size(), 0, '新实例在 load 前应为空');
  s2.load();
  assert.equal(s2.size(), 3, 'load 后应恢复全部条目');
  assert.equal(s2.search([0.9, 0.9], 1)[0].text, 'alpha-v2', '持久化后检索语义一致');

  // 损坏恢复：存储损坏后 load 不抛、回退空库（索引可由 indexDir 重建，不阻塞装配）
  if (opts.corruptStorage) {
    opts.corruptStorage();
    const s3 = create();
    assert.doesNotThrow(() => s3.load(), '损坏存储的 load 必须降级不抛');
    assert.equal(s3.size(), 0, '损坏存储应回退空库');
  }
}
