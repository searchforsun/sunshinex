import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileStore } from '../../storage/adapter';
import { LocalJsonVectorStore } from './store';
import { runVectorStoreConformance } from './store.conformance';

test('conformance：local-json 后端契约全绿（P1 sqlite-vec 复用同一套件）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-conf-'));
  runVectorStoreConformance(() => new LocalJsonVectorStore(new FileStore(dir)), {
    // FileStore 落盘路径 = baseDir/<key>.json；直写损坏 JSON 模拟存储介质损坏
    corruptStorage: () => fs.writeFileSync(path.join(dir, 'kb.vectors.json'), '{broken', 'utf-8'),
  });
});
