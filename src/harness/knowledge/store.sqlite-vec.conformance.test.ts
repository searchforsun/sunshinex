import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runVectorStoreConformance } from './store.conformance';
import { SqliteVecStore } from './store.sqlite-vec';

/** P1-G3：sqlite-vec 过与 local-json 完全相同的契约套件（含 J8 meta 完整往返）——「可插拔」由此证明，断言零改动（spec §3.4）。
 *  后端注册路由与 fail-fast 纪律的钉子在 store.sqlite-vec.test.ts / assembly.test.ts（注册收敛装配点后归属装配层）。 */
test('conformance：sqlite-vec 后端全契约（写入/召回/TopK/幂等/meta 往返/持久化/损坏恢复）', () => {
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
