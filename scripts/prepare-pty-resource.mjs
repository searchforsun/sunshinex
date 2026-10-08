#!/usr/bin/env node
/**
 * H3-T3 node-pty 打包资源装配：pnpm symlink 实目录 → shell/build/node-pty。
 *
 * 为什么需要本脚本：electron-builder.yml 无法求值 require.resolve——extraResources 的
 * node-pty 源目录只能静态列。pnpm 布局下 node_modules/node-pty 是指向
 * .pnpm/node-pty@x/node_modules/node-pty 的 junction，yml 直列符号链目录的跟随行为不可控。
 * 裁定：dist script 前置本脚本，dirname(fs.realpathSync(require.resolve('node-pty/package.json')))
 * 解符号链拿实目录，递归整包复制到 shell/build/node-pty（electron-builder extraResources
 * 静列 from: ./build/node-pty → resources/node_modules/node-pty）。
 * node-pty 1.1.0 实目录含 prebuilds/<plat>-<arch>/ 原生二进制（win32 另有 conpty/winpty 全家），
 * 整包复制保证 utils.loadNativeModule 的相对目录探测原样成立。
 * 幂等：先整删旧装配再全量拷（避免陈旧文件残留）；.bin 链接目录剔除（packaged 内无意义）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// mjs 无 require——createRequire 以本脚本位置为锚解析（node-pty 是主仓依赖，仓根可命中）
const nodeRequire = createRequire(import.meta.url);

// 实目录解析：require.resolve 命中 junction → realpathSync 落到 .pnpm 实体层
const ptyRealDir = path.dirname(fs.realpathSync(nodeRequire.resolve('node-pty/package.json')));
const destDir = path.join(repoRoot, 'shell', 'build', 'node-pty');

fs.rmSync(destDir, { recursive: true, force: true });
fs.cpSync(ptyRealDir, destDir, {
  recursive: true,
  filter: (src) => path.basename(src) !== '.bin',
});

// 装配完整性探针：当前平台 prebuild 的 pty.node 必须在场——缺即红（宁可打包期红不静默坏包）
const nativeProbe = path.join(destDir, 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node');
if (!fs.existsSync(nativeProbe)) {
  console.error(
    `[prepare-pty] ${path.relative(repoRoot, nativeProbe)} 不在场——node-pty 装配不完整（实目录 ${path.relative(repoRoot, ptyRealDir)}），exit 1`,
  );
  process.exit(1);
}
console.log(`[prepare-pty] ${path.relative(repoRoot, ptyRealDir)} -> ${path.relative(repoRoot, destDir)}`);
