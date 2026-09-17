import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextManager, runCompaction } from './index';
import { ContextItem } from '../../types';
import { FileStore } from '../../storage/adapter';
import { resolveDataDir } from '../../config/data-dir';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-cpt-arch-'));
  const cm = new ContextManager(root, new FileStore(root));
  return { root, cm };
}

function withDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-cpt-arch-data-'));
  process.env.SUNSHINEX_DATA_DIR = dir;
  return dir;
}

const ITEMS = (): ContextItem[] => [{ kind: 'history', content: '很长的旧上下文 '.repeat(50) }];

test('B 折链归档：被折链行落 archives/compaction-*.jsonl，压缩块含 Full trace 行', async () => {
  const dataDir = withDataDir();
  try {
    const { root, cm } = setup();
    cm.appendChain([
      { action: 'a', observation: '第一步观察' },
      { action: 'b', observation: '第二步观察' },
      { action: 'c', observation: '第三步观察' },
      { action: 'd', observation: '第四步观察' },
    ]);
    const res = await runCompaction(cm, ITEMS(), { summaryTokenBudget: 2000, rereadTokenBudget: 500, chainFoldedCount: 3 });
    assert.ok(res.via !== 'replay');
    const archDir = path.join(dataDir, 'archives');
    const files = fs.readdirSync(archDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^compaction-3-[0-9a-f]{8}\.jsonl$/);
    const lines = fs.readFileSync(path.join(archDir, files[0]), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    assert.ok(lines[0].includes('第一步观察'));
    assert.ok(lines[2].includes('第三步观察'));
    const compacted = cm.assemble().find((i) => i.content.startsWith('[Compacted summary'));
    const m = compacted!.content.match(/Full trace: (.+)/);
    assert.ok(m, '压缩块含 Full trace 行');
    assert.equal(m![1], path.join(archDir, files[0]));
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
  }
});

test('B replay 幂等：不重复写归档、不重复加行', async () => {
  const dataDir = withDataDir();
  try {
    const { cm } = setup();
    cm.appendChain([
      { action: 'a', observation: '一' },
      { action: 'b', observation: '二' },
    ]);
    const items = ITEMS();
    await runCompaction(cm, items, { summaryTokenBudget: 2000, rereadTokenBudget: 500, chainFoldedCount: 2 });
    const archDir = path.join(dataDir, 'archives');
    const file = path.join(archDir, fs.readdirSync(archDir)[0]);
    const beforeFile = fs.readFileSync(file, 'utf8');
    const beforeBlock = cm.assemble().find((i) => i.content.startsWith('[Compacted summary'))!.content;
    const res2 = await runCompaction(cm, items, { summaryTokenBudget: 2000, rereadTokenBudget: 500, chainFoldedCount: 2 });
    assert.equal(res2.via, 'replay');
    assert.equal(fs.readdirSync(archDir).length, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), beforeFile);
    assert.equal(cm.assemble().find((i) => i.content.startsWith('[Compacted summary'))!.content, beforeBlock);
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
  }
});

test('B 无折链：不建 archives、压缩块无 Full trace 行', async () => {
  const dataDir = withDataDir();
  try {
    const { cm } = setup();
    await runCompaction(cm, ITEMS(), { summaryTokenBudget: 2000, rereadTokenBudget: 500 });
    assert.ok(!fs.existsSync(path.join(dataDir, 'archives')));
    const compacted = cm.assemble().find((i) => i.content.startsWith('[Compacted summary'));
    assert.ok(!compacted!.content.includes('Full trace'));
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
  }
});

test('B 归档指针随会话状态持久化：restore 后压缩块仍含 Full trace', async () => {
  const dataDir = withDataDir();
  try {
    const { root, cm } = setup();
    cm.appendChain([
      { action: 'a', observation: '甲' },
      { action: 'b', observation: '乙' },
    ]);
    await runCompaction(cm, ITEMS(), { summaryTokenBudget: 2000, rereadTokenBudget: 500, chainFoldedCount: 2 });
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-cpt-arch-r-'));
    const cm2 = new ContextManager(root2, new FileStore(root2));
    cm2.restoreSession(cm.exportSessionState());
    const restored = cm2.assemble().find((i) => i.content.startsWith('[Compacted summary'));
    assert.match(restored!.content, /Full trace: /);
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
  }
});

test('B 归档写失败降级：压缩照常完成、无 Full trace 行', async () => {
  // 模拟写失败：数据目录内 archives 预置为普通文件，归档 mkdir 即抛（SUNSHINEX_DATA_DIR 指向文件会被 resolveDataDir 兜底回退，测不到写失败）
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-cpt-arch-x-'));
  fs.writeFileSync(path.join(dataDir, 'archives'), 'this is a file, not a directory');
  process.env.SUNSHINEX_DATA_DIR = dataDir;
  try {
    const { cm } = setup();
    cm.appendChain([
      { action: 'a', observation: '一' },
      { action: 'b', observation: '二' },
    ]);
    const res = await runCompaction(cm, ITEMS(), { summaryTokenBudget: 2000, rereadTokenBudget: 500, chainFoldedCount: 2 });
    assert.ok(res.via !== 'replay');
    const compacted = cm.assemble().find((i) => i.content.startsWith('[Compacted summary'));
    assert.ok(compacted, '压缩照常完成');
    assert.ok(!compacted!.content.includes('Full trace'));
  } finally {
    delete process.env.SUNSHINEX_DATA_DIR;
  }
});
