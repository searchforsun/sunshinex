import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runVectorStoreConformance } from './store.conformance';
import { createVectorBackend } from './store';
import { SqliteVecStore } from './store.sqlite-vec';
import { FileStore } from '../../storage/adapter';

/** P1-G3：sqlite-vec 过与 local-json 完全相同的契约套件——「可插拔」由此证明，断言零改动（spec §3.4） */
test('conformance：sqlite-vec 后端全契约（写入/召回/TopK/幂等/持久化/损坏恢复）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-sqlite-conf-'));
  try {
    // 持久化往返契约要求多次实例化共享同一存储介质：目录固定，工厂每次开新实例
    runVectorStoreConformance(
      () => new SqliteVecStore(dir),
      {
        // 损坏注入：直接覆写 vectors.db 为垃圾字节（非 SQLite 文件头）
        corruptStorage: () => fs.writeFileSync(path.join(dir, 'vectors.db'), Buffer.from('not a sqlite db at all')),
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** KB_BACKEND 装配：注册表按名切换，未注册名 fail-fast（禁静默回退） */
test('KB_BACKEND：createVectorBackend("sqlite-vec") 装配 SqliteVecStore 且可读写检索', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-backend-switch-'));
  try {
    const storage = new FileStore(root);
    const store = createVectorBackend('sqlite-vec', storage);
    assert.ok(store instanceof SqliteVecStore, '应装配为 SqliteVecStore');
    store.upsert('a', [1, 0], { text: 'alpha' });
    store.flush();
    assert.equal(store.search([1, 0], 1)[0].id, 'a');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('KB_BACKEND：未注册后端名 fail-fast 抛错（错误配置在装配期暴露）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-backend-fastfail-'));
  try {
    assert.throws(() => createVectorBackend('no-such-backend', new FileStore(root)), /未注册的向量后端/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
