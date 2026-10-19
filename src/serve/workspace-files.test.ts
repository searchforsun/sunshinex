import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { workspaceFiles } from './session-changes';

/** workspaceFiles 目录清单钉测(@面板滤出文件夹的数据源):dirs 带尾斜杠、跳噪/忽略口径与
 *  文件同、与 mtime 文件序分离(files 纯文件不含目录项);文件 cap 满额仅停记账——目录遍历
 *  走到自身 cap/深度为止(大仓后段目录不缺席);非目录根静默空表(面板降级可用) */
test('workspaceFiles:dirs 尾斜杠清单与文件序分离;文件 cap 满额目录仍完整;非目录根空表', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sunshinex-wsfiles-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src', 'pages'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export {};\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'README.md'), '# hi\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'node_modules', 'x', 'i.js'), 'x', 'utf8');

    const r = await workspaceFiles(tmp);
    assert.ok(r.dirs.includes('src/'), 'src/ 在档');
    assert.ok(r.dirs.includes('src/pages/'), 'src/pages/ 逐层在档');
    assert.ok(!r.dirs.some((d) => d.startsWith('node_modules')), '跳噪目录不入 dirs');
    assert.ok(r.dirs.every((d) => d.endsWith('/')), 'dirs 全带尾斜杠标记');
    assert.deepEqual(
      r.files.map((f) => f.path).sort(),
      ['README.md', 'src/a.ts'],
      'files 纯文件清单(目录项不混入)',
    );

    // 文件 cap(600)满额后:记账封顶 600,目录遍历继续——cap 前沿之后的目录仍在档
    fs.mkdirSync(path.join(tmp, 'bulk'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'late'), { recursive: true });
    for (let i = 0; i < 650; i += 1) fs.writeFileSync(path.join(tmp, 'bulk', `f${i}.ts`), 'x', 'utf8');
    fs.writeFileSync(path.join(tmp, 'late', 'late.ts'), 'x', 'utf8');
    const r2 = await workspaceFiles(tmp);
    assert.equal(r2.files.length, 600, 'files 记账封顶 600');
    assert.ok(r2.dirs.includes('late/'), 'cap 前沿之后的目录仍入 dirs');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const f2 = path.join(os.tmpdir(), `sunshinex-wsfiles-f-${Date.now()}`);
  fs.writeFileSync(f2, 'x', 'utf8');
  try {
    assert.deepEqual(await workspaceFiles(f2), { files: [], dirs: [] }, '非目录根空表');
  } finally {
    fs.rmSync(f2, { force: true });
  }
});

