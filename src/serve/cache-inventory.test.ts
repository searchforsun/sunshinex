import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheStatus, CACHE_CATEGORIES, categoryDirs, clearCacheCategories, type CacheDirs } from './cache-inventory';

/** 每用例独立 tmp（tmpdir+try/finally 惯用形）：夹具互不依赖、用例序无关（原模块级共享 tmp
 *  + process.on('exit') 清理已退役——用例 4/5 的 freed 总账曾隐式依赖用例 2 的种子） */
function withTmp(fn: (tmp: string, dirs: CacheDirs) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-cache-'));
  try {
    fn(tmp, {
      globalRoot: path.join(tmp, 'global'),
      dataDirs: [path.join(tmp, 'ws', 'data'), path.join(tmp, 'sunx-dom', 'data')],
    });
  } finally {
    fs.rmSync(tmp, { force: true, recursive: true });
  }
}

const mk = (p: string, content: string): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

/** 状态/清理用例共用夹具:逐类体积种子 */
function seed(dirs: CacheDirs): void {
  mk(path.join(dirs.globalRoot, 'pty-replay', 'r.txt'), '12345'); // 5B
  mk(path.join(dirs.globalRoot, 'gui', 'editor-icons', 'i.png'), '12345678'); // 8B
  mk(path.join(dirs.dataDirs[0]!, 'archives', 'c.jsonl'), '1234567890'); // 10B
  mk(path.join(dirs.dataDirs[0]!, 'archives', 'sub', 'd.jsonl'), '12'); // 2B(递归)
  mk(path.join(dirs.dataDirs[1]!, 'archives', 'c2.jsonl'), '1'); // 1B
  mk(path.join(dirs.dataDirs[0]!, 'tool-outputs', 't.txt'), '123');
  mk(path.join(dirs.dataDirs[0]!, 'plugins', 'logs', 'mcp.log'), '1234567');
  mk(path.join(dirs.dataDirs[1]!, 'plugins', 'computer-use', 'screenshots', 's.png'), '123456');
  mk(path.join(dirs.dataDirs[0]!, 'images-cache', 'img.png'), '123456789'); // 9B
}

test('登记表:id 集齐且 images-cache 为唯一 unsafe 档', () => {
  const ids = CACHE_CATEGORIES.map((c) => c.id);
  assert.deepEqual(
    [...ids].sort(),
    ['compaction-archives', 'computer-use-screenshots', 'editor-icons', 'images-cache', 'plugin-logs', 'pty-replay', 'tool-outputs'].sort(),
  );
  assert.equal(CACHE_CATEGORIES.find((c) => c.id === 'images-cache')!.safe, false);
  assert.equal(CACHE_CATEGORIES.filter((c) => !c.safe).length, 1);
});

test('cacheStatus:逐类计体积、跨工作区归并、缺席目录按 0', () => {
  withTmp((_tmp, dirs) => {
    seed(dirs);
    const st = cacheStatus(dirs);
    const byId = new Map(st.categories.map((c) => [c.id, c]));
    assert.equal(byId.get('pty-replay')!.size, 5);
    assert.equal(byId.get('editor-icons')!.size, 8);
    assert.equal(byId.get('compaction-archives')!.size, 13); // 两 dataDir + 子目录归并
    assert.equal(byId.get('images-cache')!.safe, false);
    assert.equal(byId.get('images-cache')!.size, 9);
    assert.equal(st.total, [...byId.values()].reduce((a, c) => a + c.size, 0));
  });
});

test('categoryDirs:global 1 个根,per-data-dir 每工作区 1 个,未知 id 空表', () => {
  withTmp((_tmp, dirs) => {
    assert.equal(categoryDirs('pty-replay', dirs).length, 1);
    assert.deepEqual(categoryDirs('compaction-archives', dirs), [path.join(dirs.dataDirs[0]!, 'archives'), path.join(dirs.dataDirs[1]!, 'archives')]);
    assert.deepEqual(categoryDirs('nope', dirs), []);
  });
});

test('缺省清 safe 全档:images-cache 与用户数据族不动,总账 freed 归并', () => {
  withTmp((_tmp, dirs) => {
    seed(dirs);
    const before = cacheStatus(dirs);
    const safeTotal = before.categories.filter((c) => c.safe).reduce((a, c) => a + c.size, 0);
    const r = clearCacheCategories(undefined, dirs);
    assert.equal(r.failed.length, 0);
    assert.equal(r.cleared.some((c) => c.id === 'images-cache'), false);
    assert.equal(r.cleared.reduce((a, c) => a + c.freed, 0), safeTotal);
    assert.equal(fs.existsSync(path.join(dirs.dataDirs[0]!, 'archives')), false);
    assert.equal(fs.existsSync(path.join(dirs.globalRoot, 'pty-replay')), false);
    assert.equal(fs.existsSync(path.join(dirs.dataDirs[0]!, 'images-cache', 'img.png')), true);
    // 清理不波及 dataDir 根其他内容(用户数据族)
    const wsJson = path.join(dirs.dataDirs[0]!, 'workspace.json');
    fs.writeFileSync(wsJson, '{}');
    clearCacheCategories(['tool-outputs'], dirs);
    assert.equal(fs.existsSync(wsJson), true);
  });
});

test('显式 ids 清 unsafe 档带 freed 记账;未知 id 落 failed;幂等', () => {
  withTmp((_tmp, dirs) => {
    seed(dirs);
    const r = clearCacheCategories(['images-cache', 'nope'], dirs);
    assert.deepEqual(r.cleared, [{ id: 'images-cache', freed: 9 }]);
    assert.deepEqual(r.failed, [{ id: 'nope', error: 'unknown cache category' }]);
    const again = clearCacheCategories(['images-cache'], dirs);
    assert.deepEqual(again.cleared, [{ id: 'images-cache', freed: 0 }]); // 目录已消:0 计
  });
});

test('cacheStatus 读侧零副作用:目录缺席不建目录', () => {
  withTmp((tmp, _dirs) => {
    const fresh: CacheDirs = { globalRoot: path.join(tmp, 'g2'), dataDirs: [path.join(tmp, 'w2', 'data')] };
    const st = cacheStatus(fresh);
    assert.equal(st.total, 0);
    assert.equal(fs.existsSync(path.join(fresh.globalRoot, 'pty-replay')), false);
  });
});
