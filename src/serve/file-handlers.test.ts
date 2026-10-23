import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { walkTreeBounded } from './file-handlers';

/** walkTreeBounded 截断分支直测（L 类「显式未覆盖」档清偿：双上限经参注入——生产恒传
 *  INDEX_MAX_DIRS/INDEX_MAX_ENTRIES 缺省常量，20k/50k 量级单测不可达，截断分支此前恒不可达）。
 *  fixture 纯 fs 零 git 依赖：非仓库 → gitIgnored 空集（优雅降级面同被覆盖）；忽略判定面
 *  （check-ignore/忽略目录不入下波）由 daemon.test ⑫c 经真 daemon 端到端覆盖，不在此重复。 */

function tmpTree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'walk-tree-'));
}

test('walkTreeBounded:条目上限触顶 truncated=true（换回「上限不可达」旧形态即红）', () => {
  const root = tmpTree();
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x', 'utf8');
  const built = walkTreeBounded(root, 100, 3);
  assert.equal(built.truncated, true);
  assert.equal(built.entries.length, 3);
  assert.equal(built.gitIgnored.size, 0); // 非仓库：忽略集优雅空集
});

test('walkTreeBounded:目录上限触顶 truncated=true;未触顶路径 truncated=false', () => {
  const root = tmpTree();
  for (let i = 0; i < 5; i += 1) fs.mkdirSync(path.join(root, `d${i}`));
  const capped = walkTreeBounded(root, 3, 100);
  assert.equal(capped.truncated, true);
  const roomy = walkTreeBounded(root, 100, 100);
  assert.equal(roomy.truncated, false);
  assert.equal(roomy.entries.length, 5); // 5 目录全索引,目录段先于文件段(纯目录树无文件段)
});
