#!/usr/bin/env node
/**
 * 版本单源同步（用户 2026-10-08 裁定：GUI 与 TUI 一个版本管理、不同安装包）：
 * - 唯一版本源 = 根 package.json 的 version（TUI npm/tgz 发行与 GUI 安装包同 tag）。
 * - 本脚本把根版本写入 gui/package.json 与 shell/package.json——GUI 安装包名
 *   （`sunshinex Setup <ver>.exe` / `sunshinex <ver> portable.exe`，electron-builder 取
 *   shell 版本）随之与 TUI 对齐；gui 子包版本仅元数据一致性。
 * - `pnpm shell:dist` 链首已挂本脚本（同步态构建，漂移不可能进产物）。
 * - `--check`：只比对不改写，漂移 exit 1（CI/自查用）。
 * 用法：node scripts/sync-versions.mjs [--check]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const repoRoot = path.resolve(url.fileURLToPath(new URL('.', import.meta.url)), '..');
const readPkg = (p) => JSON.parse(fs.readFileSync(path.join(repoRoot, p), 'utf8'));
const writePkg = (p, pkg) => {
  // 仅动 version 一个键，重序列化保持 2 空格缩进 + 行尾换行（pnpm 写盘同形）
  fs.writeFileSync(path.join(repoRoot, p), JSON.stringify(pkg, null, 2) + '\n');
};

const check = process.argv.includes('--check');
const rootVersion = readPkg('package.json').version;
const children = ['gui/package.json', 'shell/package.json'];
const drifted = children.filter((p) => readPkg(p).version !== rootVersion);

if (check) {
  if (drifted.length > 0) {
    console.error(`version drift (root ${rootVersion}): ${drifted.map((p) => `${p}=${readPkg(p).version}`).join(', ')} — run: pnpm run version:sync`);
    process.exit(1);
  }
  console.log(`versions aligned at ${rootVersion} (gui, shell)`);
  process.exit(0);
}

for (const p of children) {
  const pkg = readPkg(p);
  const old = pkg.version;
  if (old !== rootVersion) {
    pkg.version = rootVersion;
    writePkg(p, pkg);
    console.log(`${p}: ${old} -> ${rootVersion}`);
  } else {
    console.log(`${p}: already ${rootVersion}`);
  }
}
